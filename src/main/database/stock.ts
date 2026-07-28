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
) {
  const row = db.prepare(
    'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
  ).get(itemId, warehouseId) as any;

  if (!row) {
    db.prepare(
      'INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)',
    ).run(itemId, warehouseId, -qty, unitCost);
    return;
  }

  const newQty = (row.Quantity || 0) - qty;
  const remainingValue = ((row.CostPrice || 0) * (row.Quantity || 0)) - (unitCost * qty);
  // Only meaningful while a positive holding remains; otherwise the pool is
  // empty and the last known unit cost is kept for reference.
  const newCost = newQty > 0 ? remainingValue / newQty : (row.CostPrice || 0);
  db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?')
    .run(newQty, newCost, row.ID);
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

/** Adds `qty` back to a specific warehouse, creating the row if needed. */
export function restoreStock(db: Database.Database, itemId: number, warehouseId: number, qty: number, costPrice = 0) {
  const row = db.prepare('SELECT ID FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(itemId, warehouseId) as any;
  if (row) {
    db.prepare('UPDATE stock_quantities SET Quantity = Quantity + ? WHERE ID = ?').run(qty, row.ID);
  } else {
    db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)').run(itemId, warehouseId, qty, costPrice);
  }
}
