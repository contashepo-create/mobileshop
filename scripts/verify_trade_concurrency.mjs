#!/usr/bin/env node
/**
 * CHECK-THEN-ACT races in sales, purchases and returns.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every handler validates BEFORE it opens its transaction:
 *
 *     ... check stock is sufficient ...        <- reads
 *     ... check the drawer can cover it ...    <- reads
 *     const tx = db.transaction(() => { ... }) <- writes
 *     tx();
 *
 * Between the read and the write, nothing holds a lock. If a second operation
 * lands in that window, the first one commits a decision based on a world that
 * no longer exists — the classic time-of-check to time-of-use bug. Two cashiers
 * on the same shared database can both be told "5 in stock" and both sell 5.
 *
 * Electron's main process is single-threaded, so two handlers cannot interleave
 * mid-function on ONE machine. But this app explicitly supports a SHARED
 * database over the network (`db:createNetwork`, `db:changePath`), and there
 * every till is a separate process against the same file. The window is real.
 *
 * These tests simulate the window directly: perform the validation the handler
 * would perform, mutate the database underneath, then let the handler proceed.
 * A handler that re-checks inside its transaction survives; one that trusted
 * its earlier read does not.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_concurrency.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',1000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Phone','accessory',0,600,1000,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,5,600)");
  return db;
}

const qty = () => currentDb().prepare(
  'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID=1').get().v;
const cash = () => currentDb().prepare(
  'SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').get().v;

console.log('CHECK-THEN-ACT RACES — SHARED-DATABASE SCENARIOS\n');
console.log('The app supports a shared database over the network, so two tills');
console.log('are two processes against one file. Validation happens outside the');
console.log('transaction, so a second operation can land in between.\n');

// ---------------------------------------------------------------- 1
console.log('[1] Two tills sell the last units at the same moment');
{
  seed();
  // Till A validates: 5 in stock, asks for 5 — fine.
  // Before it commits, till B sells 4.
  // The question: does A still commit all 5, driving stock to -4?
  const before = qty();

  // Simulate B landing inside A's window by selling first, then letting A run
  // with the decision it made when stock was still 5.
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 4, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit',
    PaidAmount: 0, fiscalYearId: 1 });

  const res = await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit',
    PaidAmount: 0, fiscalYearId: 1 });

  t('the second sale cannot take stock that has gone',
    res?.success === false, res?.message ?? 'ACCEPTED');
  t('stock never goes negative', qty() >= 0, `stock ${qty()} (opened at ${before})`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The drawer is emptied between the check and the payment');
{
  seed();
  // A purchase validates the drawer holds 1000, then someone else spends it.
  await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitCost: 900, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 900,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });

  const res = await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitCost: 900, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 900,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });

  t('a second payment the drawer cannot cover is refused',
    res?.success === false, res?.message ?? 'ACCEPTED');
  t('the drawer never goes negative', cash() >= 0, `cash ${cash()}`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The same invoice is returned twice over');
{
  seed();
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
    PaidAmount: 2000, CashAccountID: 1, fiscalYearId: 1 });
  const sid = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;

  const a = await call('saleReturns:create', { SaleID: sid,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }],
    AccountCredit: 2000, CashRefund: 0 });
  const b = await call('saleReturns:create', { SaleID: sid,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }],
    AccountCredit: 2000, CashRefund: 0 });

  t('the first full return is accepted', a?.success === true, a?.message ?? '');
  t('a SECOND full return of the same invoice is refused',
    b?.success === false, b?.message ?? 'ACCEPTED — the invoice was returned twice');

  const credited = currentDb().prepare(
    'SELECT COALESCE(SUM(TotalAmount),0) v FROM sale_returns').get().v;
  t('no more was credited than the invoice was worth',
    credited <= 2000.011, `credited ${credited} against a 2000 invoice`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The same document is deleted twice');
{
  seed();
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
    PaidAmount: 1000, CashAccountID: 1, fiscalYearId: 1 });
  const sid = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;
  const stockBefore = qty();
  const cashBefore = cash();

  const d1 = await call('delete:sale', sid);
  const afterFirst = { q: qty(), c: cash() };
  const d2 = await call('delete:sale', sid);

  t('the first delete succeeds', d1?.success === true, d1?.message ?? '');
  t('deleting the SAME invoice again is refused',
    d2?.success === false, d2?.message ?? 'ACCEPTED — reversed twice');
  t('the reversal was not applied twice',
    qty() === afterFirst.q && cash() === afterFirst.c,
    `stock ${afterFirst.q} -> ${qty()}, cash ${afterFirst.c} -> ${cash()} `
    + `(before the sale: stock ${stockBefore}, cash ${cashBefore})`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A return is cancelled twice');
{
  seed();
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
    PaidAmount: 2000, CashAccountID: 1, fiscalYearId: 1 });
  const sid = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;
  await call('saleReturns:create', { SaleID: sid,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 1000 }],
    AccountCredit: 1000, CashRefund: 0 });
  const rid = currentDb().prepare('SELECT ReturnID v FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').get().v;

  const u1 = await call('delete:saleReturn', rid);
  const afterFirst = { q: qty(), c: cash() };
  const u2 = await call('delete:saleReturn', rid);

  t('the first cancellation succeeds', u1?.success === true, u1?.message ?? '');
  t('cancelling the SAME return again is refused',
    u2?.success === false, u2?.message ?? 'ACCEPTED — reversed twice');
  t('the cancellation was not applied twice',
    qty() === afterFirst.q && cash() === afterFirst.c,
    `stock ${afterFirst.q} -> ${qty()}, cash ${afterFirst.c} -> ${cash()}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Two documents cannot take the same document number');
{
  seed();
  for (let i = 0; i < 12; i++) {
    await call('sales:create', { CustomerID: 1,
      items: [{ ItemID: 1, Quantity: 1, UnitPrice: 1 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit',
      PaidAmount: 0, fiscalYearId: 1 });
  }
  const dupes = currentDb().prepare(`
    SELECT SaleNumber, COUNT(*) n FROM sales GROUP BY SaleNumber HAVING n > 1
  `).all();
  t('every invoice number is unique', dupes.length === 0, JSON.stringify(dupes));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A rival till commits INSIDE the check-then-act window');
//
// The tests above ran operations one after another, which the handlers already
// survived. This is the real race: the sabotage lands AFTER validation has
// passed and BEFORE the transaction opens — exactly the gap a second process
// occupies on a shared network database.
//
// `db.transaction` is hooked, because that is the precise moment validation has
// finished. Every one of these was verified to corrupt the books before the
// re-checks were added inside each transaction.
function raceProbe(sabotage) {
  const db = currentDb();
  const realTx = db.transaction.bind(db);
  let fired = false;
  db.transaction = fn => {
    const wrapped = realTx(fn);
    return (...args) => {
      if (!fired) { fired = true; sabotage(db); }
      return wrapped(...args);
    };
  };
}
const emptyShelf = db => db.prepare('UPDATE stock_quantities SET Quantity = 0 WHERE ItemID = 1').run();
const emptyDrawer = db => db.prepare('UPDATE cash_accounts SET Balance = 0 WHERE CashAccountID = 1').run();

{
  seed();
  raceProbe(emptyShelf);
  const r = await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit',
    PaidAmount: 0, fiscalYearId: 1 });
  t('a sale is refused when the shelf empties mid-flight',
    r?.success === false && qty() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, stock ${qty()}`);
}
{
  seed();
  raceProbe(emptyDrawer);
  const r = await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitCost: 900, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 900,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
  t('a purchase is refused when the drawer empties mid-flight',
    r?.success === false && cash() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, cash ${cash()}`);
}
{
  seed();
  await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitCost: 600, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
  const pid = currentDb().prepare('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').get().v;
  raceProbe(emptyShelf);
  const r = await call('purchaseReturns:create', { PurchaseID: pid,
    items: [{ ItemID: 1, Quantity: 5, UnitCost: 600 }], AccountCredit: 3000, CashRefund: 0 });
  t('a debit note is refused when the shelf empties mid-flight',
    r?.success === false && qty() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, stock ${qty()}`);
}
{
  seed();
  await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitCost: 600, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
  const pid = currentDb().prepare('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').get().v;
  raceProbe(emptyShelf);
  const r = await call('delete:purchase', pid);
  t('deleting a purchase is refused when the shelf empties mid-flight',
    r?.success === false && qty() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, stock ${qty()}`);
}
{
  seed();
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit', PaidAmount: 0, fiscalYearId: 1 });
  const sid = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;
  await call('saleReturns:create', { SaleID: sid,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 1000 }], AccountCredit: 2000, CashRefund: 0 });
  const rid = currentDb().prepare('SELECT ReturnID v FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').get().v;
  raceProbe(emptyShelf);
  const r = await call('delete:saleReturn', rid);
  t('cancelling a return is refused when the goods vanish mid-flight',
    r?.success === false && qty() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, stock ${qty()}`);
}
{
  seed();
  await call('sales:create', { CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit', PaidAmount: 0, fiscalYearId: 1 });
  const sid = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;
  raceProbe(emptyShelf);
  const r = await call('sales:update', { SaleID: sid, CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 8, UnitPrice: 1000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit', PaidAmount: 0 });
  t('editing an invoice is refused when the shelf empties mid-flight',
    r?.success === false && qty() >= 0, `${r?.success ? 'ACCEPTED' : 'refused'}, stock ${qty()}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
