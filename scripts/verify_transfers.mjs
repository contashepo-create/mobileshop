#!/usr/bin/env node
/**
 * WAREHOUSE TRANSFERS — moving goods must never create or destroy them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Transfers were never reachable by any test: the handler harness did not load
 * `inventory.handlers.ts`, so roughly four hundred lines including the transfer
 * logic had never been executed by a single check. They were only pulled in
 * while chasing a serialised-stock defect, and the very first adversarial probe
 * found that a NEGATIVE quantity was accepted — inventing fifty units in one
 * warehouse and fifty phantom ones in another.
 *
 * A transfer is the simplest operation in the whole system to state correctly:
 * total quantity and total value must both be unchanged, only their location
 * moves. That makes it easy to test properly and inexcusable to leave untested.
 *
 * Run with:  node --experimental-strip-types scripts/verify_transfers.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;
const q = (sql, ...a) => currentDb().prepare(sql).get(...a);

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','accessory',0,10,20,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)");
  return db;
}
const totals = db => ({
  qty: r4(db.prepare('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities').get().v),
  value: r4(db.prepare('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').get().v),
});
const transfer = (o) => call('warehouseTransfers:create', { Notes: 't', fiscalYearId: 1, ...o });

console.log('WAREHOUSE TRANSFERS — goods move, value does not\n');

// ---------------------------------------------------------------- 1
console.log('[1] A transfer moves goods without changing the totals');
{
  const db = seed();
  const before = totals(db);
  const r = await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: 30, UnitCost: 10 }] });
  t('the transfer is accepted', r?.success === true, r?.message);
  const after = totals(db);
  t('the total quantity is unchanged', before.qty === after.qty, `${before.qty} -> ${after.qty}`);
  t('the total value is unchanged', Math.abs(before.value - after.value) < 0.011,
    `${before.value} -> ${after.value}`);
  t('the goods really moved',
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=2')?.v === 30,
    'branch holds ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=2')?.v);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Value follows the goods even into a differently-priced warehouse');
{
  const db = seed();
  // The destination already holds the same item at a very different cost.
  currentDb().exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,10,60)");
  const before = totals(db);
  // `UnitCost` is deliberately WRONG here (and omitted in the second case).
  //
  // The caller's figure must not be trusted: the value that moves is the value
  // the source warehouse actually holds. Passing a matching cost made the test
  // pass even when the handler used the caller's number instead — verified by
  // mutation, which survived until this case was strengthened.
  await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: 40, UnitCost: 999 }] });
  const after = totals(db);
  t('moving into a dearer warehouse destroys no value',
    Math.abs(before.value - after.value) < 0.011, `${before.value} -> ${after.value}`);
  t('the caller cannot dictate the cost that moves',
    Math.abs(after.value - 1600) < 0.011,
    `stock value ${after.value}, expected 1600 (100 at 10 plus 10 at 60)`);

  // And with no cost supplied at all, the source cost must still be used.
  const db2 = seed();
  currentDb().exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,10,60)");
  const b2 = totals(db2);
  await transfer({ FromWarehouseID: 1, ToWarehouseID: 2, items: [{ ItemID: 1, Quantity: 40 }] });
  t('a transfer with no stated cost still moves the right value',
    Math.abs(totals(db2).value - b2.value) < 0.011, `${b2.value} -> ${totals(db2).value}`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A transfer cannot move more than the source holds');
{
  const db = seed();
  const r = await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: 999, UnitCost: 10 }] });
  t('moving more than exists is refused', r?.success === false, r?.message);
  t('nothing moved', totals(db).qty === 100, 'total ' + totals(db).qty);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A NEGATIVE quantity cannot be used to invent stock');
{
  const db = seed();
  const before = totals(db);
  // The availability check asked only whether Quantity > available, which any
  // negative passes. -50 added 50 to the source and -50 to the destination.
  const r = await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: -50, UnitCost: 10 }] });
  t('a negative quantity is refused', r?.success === false, r?.message);
  t('no stock was invented', totals(db).qty === before.qty,
    `${before.qty} -> ${totals(db).qty}`);
  t('no warehouse went negative',
    (q('SELECT MIN(Quantity) v FROM stock_quantities').v ?? 0) >= 0,
    'lowest holding ' + q('SELECT MIN(Quantity) v FROM stock_quantities').v);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Degenerate transfers are refused');
{
  seed();
  const same = await transfer({ FromWarehouseID: 1, ToWarehouseID: 1,
    items: [{ ItemID: 1, Quantity: 10, UnitCost: 10 }] });
  t('a transfer to the same warehouse is refused', same?.success === false, same?.message);

  const empty = await transfer({ FromWarehouseID: 1, ToWarehouseID: 2, items: [] });
  t('a transfer with no items is refused', empty?.success === false, empty?.message);

  const zero = await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: 0, UnitCost: 10 }] });
  t('a zero-quantity transfer is refused', zero?.success === false, zero?.message);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Splitting a transfer must not change the outcome');
{
  const runA = async () => {
    const db = seed();
    await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
      items: [{ ItemID: 1, Quantity: 40, UnitCost: 10 }] });
    return currentDb().prepare('SELECT WarehouseID, ROUND(Quantity,4) q, ROUND(Quantity*CostPrice,2) v FROM stock_quantities ORDER BY WarehouseID').all();
  };
  const runB = async () => {
    const db = seed();
    await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
      items: [{ ItemID: 1, Quantity: 25, UnitCost: 10 }] });
    await transfer({ FromWarehouseID: 1, ToWarehouseID: 2,
      items: [{ ItemID: 1, Quantity: 15, UnitCost: 10 }] });
    return currentDb().prepare('SELECT WarehouseID, ROUND(Quantity,4) q, ROUND(Quantity*CostPrice,2) v FROM stock_quantities ORDER BY WarehouseID').all();
  };
  const a = JSON.stringify(await runA()), b = JSON.stringify(await runB());
  t('one transfer of 40 == two transfers of 25 and 15', a === b, `A ${a}\n        B ${b}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
