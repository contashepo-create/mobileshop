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
): { residual: number } {
  const row = db.prepare(
    'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
  ).get(itemId, warehouseId) as any;

  if (!row) {
    db.prepare(
      'INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)',
    ).run(itemId, warehouseId, -qty, unitCost);
    return { residual: 0 };
  }

  const newQty = (row.Quantity || 0) - qty;
  const remainingValue = ((row.CostPrice || 0) * (row.Quantity || 0)) - (unitCost * qty);

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
  return { residual };
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
    return;
  }

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
