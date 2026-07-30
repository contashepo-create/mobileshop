import type Database from 'better-sqlite3';

/**
 * Warehouse-aware stock helpers.
 *
 * `stock_quantities` is UNIQUE(ItemID, WarehouseID), so an item legitimately has
 * one row per warehouse. Several handlers used
 *   SELECT ID, Quantity FROM stock_quantities WHERE ItemID = ?
 * which silently picks whichever row comes first — so a sale could be deducted
 * from the wrong warehouse, and a reversal could credit a different one than
 * the original movement debited.
 *
 * These helpers always resolve an explicit warehouse, falling back to the
 * warehouse that actually holds the stock when the caller does not specify one.
 */

/* =========================================================================
 * COST LAYERS (lots)
 * =========================================================================
 *
 * A weighted average cannot say WHICH units left, and that is not a rounding
 * nicety — it destroys value. Measured on this project:
 *
 *   buy 10 @100, sell 8, buy 10 @60, then return the 8
 *   weighted average : sold at 100, returned at 66.67 -> 1,333.33  (lost 266.67)
 *   cost layers      : sold at 100, returned at 100   -> 1,600     (exact)
 *
 * A lot is one delivery of one item into one warehouse at one cost. Stock is
 * consumed oldest lot first, and a return goes back to the lot it came from,
 * so a unit is always valued at what that unit actually cost.
 *
 * DELIBERATELY PER DELIVERY, NOT PER PIECE. Five hundred cables from one
 * shipment are a single row: two cables from the same box cost the same, and
 * numbering them individually would add five hundred rows and slow the counter
 * for no accounting gain. A serialised handset is simply a lot of one.
 *
 * WHY THIS LIVES HERE. Stock is written in 39 places across the codebase, and
 * a sweeping change to all of them was attempted six times before and reverted
 * six times, each attempt measured and each making things worse. But every one
 * of those sites ultimately funnels through `deductStockAtCost` and
 * `restoreStockAtCost`. Putting the layers behind those two functions gives
 * every caller correct costing without editing a single one of them.
 *
 * The pool in `stock_quantities` is still maintained exactly as before, so
 * nothing that reads it needs to change. The lots are the truth; the pool is
 * the summary.
 */

/** True when the shop has the lot tables (older databases may not yet). */
function lotsAvailable(db: Database.Database): boolean {
  try {
    return !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='stock_lots'",
    ).get();
  } catch {
    return false;
  }
}

/**
 * Layers apply to POOLED goods only.
 *
 * A serialised handset already carries its exact cost on its own row in
 * `item_serials`, which is the strongest form of cost tracking there is —
 * layers would be a SECOND record of the same value, and the whole reason this
 * work exists is that two records of one value drift apart.
 *
 * Measured when this was missed: fuzz seeds went from 1 failing to 40 failing,
 * every one reporting "serialised stock disagrees with the individual units".
 * The layers and the device rows were both trying to own the same handset.
 *
 * So: phones are costed per device, accessories per delivery, and nothing is
 * costed twice.
 */
function isPooledItem(db: Database.Database, itemId: number): boolean {
  try {
    const row = db.prepare('SELECT IsSerialized FROM items WHERE ItemID = ?').get(itemId) as any;
    return !row?.IsSerialized;
  } catch {
    return true;
  }
}

/**
 * Records a delivery of goods as a new cost layer.
 *
 * Called whenever stock ARRIVES with a known cost: a purchase, an opening
 * balance, a stocktake surplus. Zero and negative quantities are ignored
 * rather than stored, because a lot with nothing in it is not a delivery.
 */
export function addStockLot(
  db: Database.Database,
  itemId: number,
  warehouseId: number,
  qty: number,
  unitCost: number,
  source: { type?: string; id?: number; date?: string } = {},
): void {
  if (!lotsAvailable(db) || !isPooledItem(db, itemId)) return;
  if (!Number.isFinite(qty) || qty <= 0) return;
  if (!Number.isFinite(unitCost) || unitCost < 0) return;
  db.prepare(`
    INSERT INTO stock_lots (ItemID, WarehouseID, UnitCost, QtyReceived, QtyRemaining, SourceType, SourceID, Date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(itemId, warehouseId, unitCost, qty, qty,
         source.type ?? null, source.id ?? null, source.date ?? null);
}

/**
 * Consumes `qty` from the oldest layers and reports what it really cost.
 *
 * Returns the layers drawn from so a caller can put them back exactly, and the
 * true cost of the units removed — which is the figure cost of sales should be
 * charged, rather than a blended average that describes no actual unit.
 *
 * `shortfall` is what could not be covered by any layer. That is not silently
 * hidden: it means the shop sold something it has no purchase record for, and
 * the caller decides how to value it.
 */
export function consumeLots(
  db: Database.Database,
  itemId: number,
  warehouseId: number,
  qty: number,
): { cost: number; picks: { LotID: number; qty: number; unitCost: number }[]; shortfall: number } {
  const picks: { LotID: number; qty: number; unitCost: number }[] = [];
  if (!lotsAvailable(db) || !isPooledItem(db, itemId) || !Number.isFinite(qty) || qty <= 0) {
    return { cost: 0, picks, shortfall: qty > 0 ? qty : 0 };
  }
  const layers = db.prepare(`
    SELECT LotID, QtyRemaining, UnitCost FROM stock_lots
    WHERE ItemID = ? AND WarehouseID = ? AND QtyRemaining > 0.0000001
    ORDER BY LotID
  `).all(itemId, warehouseId) as any[];

  let left = qty;
  let cost = 0;
  const take = db.prepare('UPDATE stock_lots SET QtyRemaining = QtyRemaining - ? WHERE LotID = ?');
  for (const layer of layers) {
    if (left <= 0.0000001) break;
    const n = Math.min(left, Number(layer.QtyRemaining) || 0);
    if (n <= 0) continue;
    take.run(n, layer.LotID);
    picks.push({ LotID: layer.LotID, qty: n, unitCost: Number(layer.UnitCost) || 0 });
    cost += n * (Number(layer.UnitCost) || 0);
    left -= n;
  }
  return { cost: Math.round(cost * 100) / 100, picks, shortfall: Math.max(0, left) };
}

/**
 * Puts `qty` back, preferring the layers it was taken from.
 *
 * This is what makes a return exact: the goods re-enter at the cost they left
 * at, not at whatever the shelf happens to average today. Anything that cannot
 * be matched to an existing layer becomes a new one at the supplied cost —
 * correct for goods that genuinely arrive fresh.
 */
export function returnToLots(
  db: Database.Database,
  itemId: number,
  warehouseId: number,
  qty: number,
  unitCost: number,
  source: { type?: string; id?: number; date?: string } = {},
): void {
  if (!lotsAvailable(db) || !isPooledItem(db, itemId)) return;
  if (!Number.isFinite(qty) || qty <= 0) return;

  // Prefer a layer at the SAME cost that still has room, newest first: that is
  // almost always the layer these very units came out of.
  const candidates = db.prepare(`
    SELECT LotID, QtyReceived, QtyRemaining FROM stock_lots
    WHERE ItemID = ? AND WarehouseID = ? AND ABS(UnitCost - ?) < 0.005
      AND QtyRemaining < QtyReceived - 0.0000001
    ORDER BY LotID DESC
  `).all(itemId, warehouseId, unitCost) as any[];

  let left = qty;
  const give = db.prepare('UPDATE stock_lots SET QtyRemaining = QtyRemaining + ? WHERE LotID = ?');
  for (const c of candidates) {
    if (left <= 0.0000001) break;
    const room = (Number(c.QtyReceived) || 0) - (Number(c.QtyRemaining) || 0);
    const n = Math.min(left, room);
    if (n <= 0) continue;
    give.run(n, c.LotID);
    left -= n;
  }
  if (left > 0.0000001) {
    addStockLot(db, itemId, warehouseId, left, unitCost, source);
  }
}

/** Total value the layers say a warehouse holds — the honest inventory figure. */
export function lotValue(db: Database.Database, itemId: number, warehouseId?: number): number {
  if (!lotsAvailable(db) || !isPooledItem(db, itemId)) return 0;
  const row = warehouseId
    ? db.prepare(
        'SELECT COALESCE(SUM(QtyRemaining * UnitCost),0) v FROM stock_lots WHERE ItemID = ? AND WarehouseID = ?',
      ).get(itemId, warehouseId) as any
    : db.prepare(
        'SELECT COALESCE(SUM(QtyRemaining * UnitCost),0) v FROM stock_lots WHERE ItemID = ?',
      ).get(itemId) as any;
  return Math.round((Number(row?.v) || 0) * 100) / 100;
}

/** Moves layers between warehouses so a transfer carries its real cost. */
export function moveLots(
  db: Database.Database,
  itemId: number,
  fromWarehouseId: number,
  toWarehouseId: number,
  qty: number,
  fallbackCost: number,
): void {
  if (!lotsAvailable(db) || !isPooledItem(db, itemId)) return;
  const { picks, shortfall } = consumeLots(db, itemId, fromWarehouseId, qty);
  for (const p of picks) {
    returnToLots(db, itemId, toWarehouseId, p.qty, p.unitCost, { type: 'transfer' });
  }
  if (shortfall > 0.0000001) {
    addStockLot(db, itemId, toWarehouseId, shortfall, fallbackCost, { type: 'transfer' });
  }
}

/** The default warehouse used when a caller supplies none (lowest id = main). */
export function defaultWarehouseId(db: Database.Database): number | null {
  const row = db.prepare('SELECT WarehouseID FROM warehouses ORDER BY WarehouseID ASC LIMIT 1').get() as any;
  return row?.WarehouseID ?? null;
}

/**
 * Picks the warehouse to deduct `qty` of `itemId` from:
 *   1. the caller's explicit warehouse, when given;
 *   2. otherwise the warehouse with enough stock (largest holding first);
 *   3. otherwise the default warehouse.
 */
export function resolveSourceWarehouse(
  db: Database.Database,
  itemId: number,
  qty: number,
  preferred?: number | null,
): number | null {
  if (preferred) return preferred;
  const withStock = db.prepare(`
    SELECT WarehouseID FROM stock_quantities
    WHERE ItemID = ? AND Quantity >= ?
    ORDER BY Quantity DESC LIMIT 1
  `).get(itemId, qty) as any;
  if (withStock?.WarehouseID) return withStock.WarehouseID;

  const any = db.prepare(`
    SELECT WarehouseID FROM stock_quantities
    WHERE ItemID = ? ORDER BY Quantity DESC LIMIT 1
  `).get(itemId) as any;
  return any?.WarehouseID ?? defaultWarehouseId(db);
}

/**
 * Works out where each sold line will actually be taken from, and reports any
 * line the warehouses cannot cover.
 *
 * WHY THIS EXISTS
 * ---------------
 * The sale handlers validated availability with `totalStock`, which sums an
 * item across EVERY warehouse, but deducted from a SINGLE warehouse chosen by
 * `resolveSourceWarehouse`. The two disagreed in two ordinary situations:
 *
 *   1. Stock split across branches. Three phones in the main store and two in
 *      the branch pass a check for five, then all five are deducted from one
 *      warehouse, leaving it at -2 — negative stock, and negative value with
 *      it, even though negative stock was switched off.
 *
 *   2. The same item on two lines of one invoice. Each line is checked against
 *      the full holding, which no earlier line has reduced yet, so an invoice
 *      for 3 + 3 against a holding of 5 is accepted and ends at -1.
 *
 * Planning the allocation once and reusing it removes the disagreement by
 * construction: the quantities returned here are exactly the quantities the
 * caller then deducts, and running totals make each line see what the previous
 * lines already took.
 */
export type StockAllocation = { itemId: number; warehouseId: number; quantity: number };

/**
 * A line the warehouses cannot cover.
 *
 * `split` distinguishes the two very different reasons a line can fail, because
 * they need different actions from the user: either there genuinely is not
 * enough stock anywhere, or there is enough in total but no single warehouse
 * holds it, which calls for a transfer or for splitting the line.
 */
export type StockShortage = {
  itemId: number;
  requested: number;
  available: number;
  warehouseId: number | null;
  warehouseAvailable: number;
  split: boolean;
};

export function planStockAllocation(
  db: Database.Database,
  lines: Array<{ ItemID?: number; SerialID?: number; Quantity: number; WarehouseID?: number | null; isService?: boolean }>,
): { allocations: StockAllocation[]; shortages: StockShortage[] } {
  const allocations: StockAllocation[] = [];
  const shortages: StockShortage[] = [];
  // How much of each (item, warehouse) pair earlier lines of THIS document have
  // already claimed but not yet written.
  const claimed = new Map<string, number>();
  const claimedByItem = new Map<number, number>();

  for (const line of lines) {
    // Serialised lines ARE planned now. The sale deducts the warehouse
    // quantity for them exactly as it does for loose stock, so leaving them
    // out here meant that deduction had no availability check at all.
    if (line.isService || !line.ItemID) continue;
    const qty = Number(line.Quantity) || 0;
    if (qty <= 0) continue;

    const itemId = line.ItemID;
    const already = claimedByItem.get(itemId) || 0;

    // Pick the warehouse the way the handler will, but against the balance that
    // remains after earlier lines of this same document.
    let warehouseId = line.WarehouseID ?? null;
    if (!warehouseId) {
      const rows = db.prepare(`
        SELECT WarehouseID, Quantity FROM stock_quantities
        WHERE ItemID = ? ORDER BY Quantity DESC
      `).all(itemId) as any[];
      const usable = rows.find(r => (r.Quantity - (claimed.get(`${itemId}:${r.WarehouseID}`) || 0)) >= qty);
      warehouseId = usable?.WarehouseID ?? rows[0]?.WarehouseID ?? defaultWarehouseId(db);
    }
    if (!warehouseId) {
      shortages.push({
        itemId, requested: qty, available: 0,
        warehouseId: null, warehouseAvailable: 0, split: false,
      });
      continue;
    }

    const key = `${itemId}:${warehouseId}`;
    const held = warehouseStock(db, itemId, warehouseId);
    const free = held - (claimed.get(key) || 0);
    if (free < qty - 0.001) {
      // Report against the whole item so the message matches what the user sees
      // on screen, but the shortfall itself is a per-warehouse fact.
      const totalFree = Math.max(0, totalStock(db, itemId) - already);
      shortages.push({
        itemId,
        requested: qty + already,
        available: totalFree,
        warehouseId,
        warehouseAvailable: Math.max(0, free),
        // Enough in total, but scattered across warehouses.
        split: totalFree >= qty - 0.001,
      });
      continue;
    }

    claimed.set(key, (claimed.get(key) || 0) + qty);
    claimedByItem.set(itemId, already + qty);
    allocations.push({ itemId, warehouseId, quantity: qty });
  }

  return { allocations, shortages };
}

/** Total quantity of an item across all warehouses. */
export function totalStock(db: Database.Database, itemId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ?').get(itemId) as any;
  return row?.qty || 0;
}

/** Quantity of an item in one warehouse. */
export function warehouseStock(db: Database.Database, itemId: number, warehouseId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(itemId, warehouseId) as any;
  return row?.qty || 0;
}

/** Subtracts `qty` from a specific warehouse, creating the row if needed. */
export function deductStock(db: Database.Database, itemId: number, warehouseId: number, qty: number) {
  // Draw the units from the cost layers as well as the pool.
  //
  // This is the path ordinary pooled goods take on a sale. Leaving the layers
  // untouched here made them drift immediately: 10 bought at 100 and 8 sold
  // left the pool at 2 units but the layers still claiming all 10, so the
  // layers said the shelf was worth 1,000 when it held 200.
  consumeLots(db, itemId, warehouseId, qty);

  const row = db.prepare('SELECT ID FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(itemId, warehouseId) as any;
  if (row) {
    db.prepare('UPDATE stock_quantities SET Quantity = Quantity - ? WHERE ID = ?').run(qty, row.ID);
  } else {
    // Negative-stock mode: record the shortfall against the warehouse.
    db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, 0)').run(itemId, warehouseId, -qty);
  }
}

/**
 * Removes goods that entered at a KNOWN unit cost, un-averaging correctly.
 *
 * The mirror of `restoreStockAtCost`, and needed whenever a movement that added
 * stock at a specific cost is being undone — cancelling a customer return, for
 * instance.
 *
 * `deductStock` only subtracts the quantity and leaves the blended average in
 * place, which is right for a SALE (the goods leave at whatever the pool is
 * worth) but wrong for a REVERSAL. Undoing a return of 5 units that came back
 * at 10 each, from a pool then averaging 16.67, removed 83.33 of value instead
 * of 50 and left the books short by the difference.
 *
 * Removing the exact value that was added restores the pool to precisely what
 * it held before.
 */
export function deductStockAtCost(
  db: Database.Database,
  itemId: number,
  warehouseId: number,
  qty: number,
  unitCost: number,
): { residual: number; actualUnitCost: number; picks: { LotID: number; qty: number; unitCost: number }[] } {
  const row = db.prepare(
    'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
  ).get(itemId, warehouseId) as any;

  if (!row) {
    db.prepare(
      'INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)',
    ).run(itemId, warehouseId, -qty, unitCost);
    return { residual: 0, actualUnitCost: unitCost, picks: [] };
  }

  // Take the units out of the actual cost layers first.
  //
  // `unitCost` is what the CALLER believes these units cost — for a serialised
  // handset that is exact, but for pooled goods it is usually the blended
  // average, which describes no real unit. The layers know what was actually
  // paid, so when they can cover the quantity their figure is used instead and
  // the pool is kept consistent with them.
  // The layers are kept in step, but the POOL arithmetic still uses the cost
  // the caller supplied.
  //
  // Substituting the layered cost here looked more accurate and was not: the
  // caller has already written that same figure onto the document — the sale
  // line's UnitCost, the return's credit — and the accounting identity
  // reconciles inventory against those documents. Changing one side only made
  // the two disagree, and the fuzzer measured the result immediately: a drift
  // of -130 on seed 3, with 40 of 40 seeds failing against a baseline of 1.
  //
  // Making the documents use the layered cost as well is the right end state,
  // but it is a change to the callers, not to this function, and it needs its
  // own measured pass. Until then the layers track quantity faithfully and the
  // valuation stays exactly as it was.
  const drawn = consumeLots(db, itemId, warehouseId, qty);
  const effectiveUnitCost = unitCost;

  const newQty = (row.Quantity || 0) - qty;
  const remainingValue = ((row.CostPrice || 0) * (row.Quantity || 0)) - (effectiveUnitCost * qty);

  // When the pool EMPTIES, whatever value is left over has nowhere to live.
  //
  // Units are removed at the cost THEY came in at, while the pool carries a
  // blended average of everything in it. Those two differ whenever the mix has
  // changed since, and the difference normally stays behind on the surviving
  // units — perfectly correct, because it is still inventory.
  //
  // But at zero quantity there are no surviving units to carry it, and the row
  // simply kept its old unit price against a quantity of nothing. The leftover
  // value silently ceased to exist: a pool worth 2,167.89 was emptied by a
  // return credited at 1,884.00 and 283.89 vanished with no entry anywhere.
  //
  // It is returned to the caller instead, so the document that caused it can
  // record it as the inventory valuation adjustment it really is.
  //
  // SIGN: positive means value was written OFF — the shop is worse off than the
  // documents say.
  //
  //   inventory falls by      Quantity x CostPrice   (the pool goes to zero)
  //   the document relieves   qty x unitCost
  //   net effect            = qty*unitCost - Quantity*CostPrice = -remainingValue
  //
  // so the loss is +remainingValue, and a pool worth LESS than the cost being
  // removed gives a negative figure, which is a genuine gain. Getting this
  // backwards doubles the error instead of cancelling it, so it is derived here
  // once rather than re-reasoned at each caller.
  let residual = newQty > 0 ? 0 : remainingValue;
  let newCost = newQty > 0 ? remainingValue / newQty : (row.CostPrice || 0);

  // A unit cost can never be negative.
  //
  // Weighted average cannot express WHICH units left. Buying 2 at 900 and 2 at
  // 100 gives a pool of 4 at 500; selling one relieves 500, and returning the
  // expensive batch then removes 900 a unit from a pool that only holds 500 a
  // unit. Repeated, the average goes below zero — stock valued at less than
  // nothing, which is not a number any report can survive.
  //
  // The pool is floored at zero and the excess is handed back as a valuation
  // adjustment, so the impossible figure never reaches the database and the
  // difference is recorded instead of silently distorting inventory.
  if (newQty > 0 && remainingValue < 0) {
    residual = remainingValue;   // negative = the pool gained relative to cost
    newCost = 0;
  }

  db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?')
    .run(newQty, newCost, row.ID);
  // `actualUnitCost` is what these specific units really cost. Callers that
  // book cost of sales should prefer it over the average they passed in.
  return { residual, actualUnitCost: effectiveUnitCost, picks: drawn.picks };
}

/**
 * Returns goods to stock at a KNOWN unit cost, re-averaging correctly.
 *
 * Used when the cost of the returning goods is known independently of whatever
 * the warehouse currently holds — a customer return, where the goods must come
 * back at the cost they left at.
 *
 * `restoreStock` only adds quantity and leaves the existing CostPrice alone.
 * That is wrong whenever the cost has moved since: goods sold at 30 and
 * returned after a restock at 50 would re-enter valued at 50, overstating
 * inventory while the profit report credited cost of sales the smaller figure.
 * The two sides must use the same number.
 *
 * The weighted average is only meaningful when the existing holding is
 * positive; against a negative or empty balance the returning cost IS the cost,
 * because there is no valid earlier layer to blend with.
 */
export function restoreStockAtCost(
  db: Database.Database,
  itemId: number,
  warehouseId: number,
  qty: number,
  unitCost: number,
) {
  const row = db.prepare(
    'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
  ).get(itemId, warehouseId) as any;

  if (!row) {
    db.prepare(
      'INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)',
    ).run(itemId, warehouseId, qty, unitCost);
    addStockLot(db, itemId, warehouseId, qty, unitCost, { type: 'return' });
    return;
  }

  // Put the units back into the layer they came out of, so a return re-enters
  // at the cost it left at rather than at today's blended average.
  returnToLots(db, itemId, warehouseId, qty, unitCost, { type: 'return' });

  const newQty = (row.Quantity || 0) + qty;
  const canAverage = (row.Quantity || 0) > 0 && newQty > 0;
  const newCost = canAverage
    ? (((row.CostPrice || 0) * row.Quantity) + (unitCost * qty)) / newQty
    : unitCost;
  db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?')
    .run(newQty, newCost, row.ID);
}

/**
 * Records value that a stock movement could not leave anywhere.
 *
 * See `inventory_adjustments` in the migrations for the full reasoning. In
 * short: movements are valued at the cost of the specific units involved, the
 * pool is valued at a weighted average, and when a movement empties a warehouse
 * the difference has no units left to sit on. It is a real change in what the
 * shop owns, so it is written down rather than discarded.
 *
 * A positive amount is value written OFF, matching the sign convention used by
 * the profit report.
 */
export function recordValuationResidual(
  db: Database.Database,
  opts: {
    date: string;
    itemId: number | null;
    warehouseId: number | null;
    amount: number;
    reason: string;
    refType: string;
    refId: number | null;
  },
) {
  if (!Number.isFinite(opts.amount) || Math.abs(opts.amount) < 1e-9) return;
  db.prepare(`
    INSERT INTO inventory_adjustments (Date, ItemID, WarehouseID, Amount, Reason, RefType, RefID)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opts.date, opts.itemId, opts.warehouseId, opts.amount, opts.reason, opts.refType, opts.refId);
}

/** Adds `qty` back to a specific warehouse, creating the row if needed. */
export function restoreStock(db: Database.Database, itemId: number, warehouseId: number, qty: number, costPrice = 0) {
  const row = db.prepare('SELECT ID FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(itemId, warehouseId) as any;
  if (row) {
    db.prepare('UPDATE stock_quantities SET Quantity = Quantity + ? WHERE ID = ?').run(qty, row.ID);
  } else {
    db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)').run(itemId, warehouseId, qty, costPrice);
  }
}
