#!/usr/bin/env node
/**
 * STATEMENTS — does the page the owner reconciles from tell the truth?
 *
 * WHY THIS EXISTS
 * ---------------
 * `statement.handlers.ts` is the largest unaudited file in the project (549
 * lines) and none of its channels had ever been executed by a test. It is also
 * the page a shop owner actually acts on: they open a supplier's statement,
 * read the closing figure, and pay it.
 *
 * THE METHOD — CROSS-VIEW AGREEMENT
 * ---------------------------------
 * A statement is a SECOND, independently written view of data the ledger
 * already holds. Both are derived from the same documents by different SQL, so
 * they can be compared against each other without anyone deciding in advance
 * what the "right" answer is. Where they disagree, one of them is wrong — and
 * no imagination is required to notice it.
 *
 * That is what found the fault here: a purchase was posted to the supplier
 * statement at its FULL value with no credit for the amount handed over at the
 * counter, so an 800 invoice with 300 already paid showed the shop owing 800
 * while `suppliers.Balance` correctly said 500. A supplier reconciled from
 * that page gets paid the same 300 twice.
 *
 * The customer statement already did this correctly, which is the useful part:
 * two views of the same idea, written in the same file, disagreeing with each
 * other. Comparing them is cheaper than reasoning about either.
 *
 * Run with:  node --experimental-strip-types scripts/verify_statements.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const q = (sql, ...a) => currentDb().prepare(sql).get(...a);
const near = (a, b) => Math.abs(r2(a) - r2(b)) < 0.011;

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Sup',0,'active')");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(1,'Tech',3000,500,0,1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Part','part',0,100,200,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,200,100)");
  return db;
}

const custBal = () => q('SELECT Balance v FROM customers WHERE CustomerID=1').v;
const supBal = () => q('SELECT Balance v FROM suppliers WHERE SupplierID=1').v;

const sell = (paid, qty = 5) => call('sales:create', {
  CustomerID: 1, items: [{ ItemID: 1, Quantity: qty, UnitPrice: 100 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: paid,
  PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
});
const buy = (paid, qty = 10) => call('purchases:create', {
  SupplierID: 1, items: [{ ItemID: 1, Quantity: qty, UnitCost: 80, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: paid,
  PaymentSourceType: paid > 0 ? 'cash_account' : undefined,
  PaymentSourceID: paid > 0 ? 1 : undefined,
  fiscalYearId: 1, userId: 1,
});

console.log('STATEMENTS — a second view of the ledger must agree with the ledger\n');

// ---------------------------------------------------------------- 1
console.log('[1] A supplier statement must foot to what the shop actually owes');
// The fault: PaidAmount was never credited, so anything settled at the counter
// was still shown as outstanding.
for (const [label, paid, expected] of [
  ['nothing paid', 0, 800],
  ['part paid at the counter', 300, 500],
  ['paid in full on the spot', 800, 0],
]) {
  seed();
  await buy(paid);
  const st = await call('supplierStatement:get', 1, {});
  t(`supplier — ${label}`, near(st.totals?.netBalance, supBal()) && near(supBal(), expected),
    `statement ${st.totals?.netBalance} vs ledger ${supBal()} (expected ${expected})`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The customer statement must agree the same way');
for (const [label, paid, expected] of [
  ['nothing paid', 0, 500],
  ['part paid', 200, 300],
  ['paid in full', 500, 0],
]) {
  seed();
  await sell(paid);
  const st = await call('customerStatement:get', 1, {});
  t(`customer — ${label}`, near(st.totals?.netBalance, custBal()) && near(custBal(), expected),
    `statement ${st.totals?.netBalance} vs ledger ${custBal()} (expected ${expected})`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The running balance must land on the real closing figure');
// A statement can foot correctly in total and still show a nonsense running
// balance down the page, which is the column the owner reads line by line.
{
  seed();
  await sell(0);
  await call('vouchers:create', {
    VoucherType: 'receipt', Amount: 200, Date: '2026-07-30',
    PartyType: 'customer', PartyID: 1, PartyName: 'Ahmed', Description: 'part payment',
    CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const st = await call('customerStatement:get', 1, {});
  const ops = st.operations || [];
  const last = ops.length ? ops[ops.length - 1].Balance : null;
  t('every document appears on the statement', ops.length === 2,
    ops.map(o => o.OpType).join(', ') || 'none');
  t('the last running balance equals the ledger', last !== null && near(last, custBal()),
    `running ${last} vs ledger ${custBal()}`);
  t('debits and credits foot to the same figure',
    near((st.totals?.totalDebit ?? 0) - (st.totals?.totalCredit ?? 0), custBal()),
    `${st.totals?.totalDebit} - ${st.totals?.totalCredit} vs ${custBal()}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Agreement must survive a return');
{
  seed();
  await buy(300);
  const pid = q('SELECT PurchaseID v FROM purchases').v;
  const det = currentDb().prepare('SELECT DetailID, ItemID, Quantity, UnitCost FROM purchase_details').all();
  await call('purchaseReturns:create', {
    PurchaseID: pid, SupplierID: 1,
    items: det.map(d => ({ DetailID: d.DetailID, ItemID: d.ItemID, Quantity: 2, UnitCost: d.UnitCost, WarehouseID: 1 })),
    Reason: 'faulty', AccountCredit: 160, CashRefund: 0, fiscalYearId: 1, userId: 1,
  });
  const st = await call('supplierStatement:get', 1, {});
  t('supplier statement still agrees after a debit note',
    near(st.totals?.netBalance, supBal()),
    `statement ${st.totals?.netBalance} vs ledger ${supBal()}`);
}
{
  seed();
  await sell(0);
  const sid = q('SELECT SaleID v FROM sales').v;
  const det = currentDb().prepare('SELECT DetailID, ItemID, Quantity, UnitPrice FROM sale_details').all();
  await call('saleReturns:create', {
    SaleID: sid, CustomerID: 1,
    items: det.map(d => ({ DetailID: d.DetailID, ItemID: d.ItemID, Quantity: 2, UnitPrice: d.UnitPrice })),
    Reason: 'faulty', AccountCredit: 200, CashRefund: 0, fiscalYearId: 1, userId: 1,
  });
  const st = await call('customerStatement:get', 1, {});
  t('customer statement still agrees after a credit note',
    near(st.totals?.netBalance, custBal()),
    `statement ${st.totals?.netBalance} vs ledger ${custBal()}`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A cash statement must explain the movement in the drawer');
{
  seed();
  const opening = q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
  await call('vouchers:create', {
    VoucherType: 'receipt', Amount: 500, Date: '2026-07-30', PartyType: null, PartyID: null,
    PartyName: '', Description: 'in', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  await call('vouchers:create', {
    VoucherType: 'payment', Amount: 200, Date: '2026-07-30', PartyType: null, PartyID: null,
    PartyName: '', Description: 'out', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const closing = q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
  const st = await call('cashAccount:statement', 1, {});
  t('in minus out equals the change in the drawer',
    near((st.totalIn ?? 0) - (st.totalOut ?? 0), closing - opening),
    `net ${r2((st.totalIn ?? 0) - (st.totalOut ?? 0))} vs change ${r2(closing - opening)}`);
  t('the reported net change matches too', near(st.netChange, closing - opening),
    `netChange ${st.netChange}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Statements refuse to invent a party that does not exist');
{
  seed();
  const a = await call('customerStatement:get', 9999, {});
  const b = await call('supplierStatement:get', 9999, {});
  const c = await call('employeeStatement:get', 9999);
  const d = await call('cashAccount:statement', 9999, {});
  t('an unknown customer is refused, not shown as zero', a?.success === false, JSON.stringify(a).slice(0, 70));
  t('an unknown supplier is refused', b?.success === false, JSON.stringify(b).slice(0, 70));
  t('an unknown employee is refused', c?.success === false, JSON.stringify(c).slice(0, 70));
  t('an unknown cash account is refused', d?.success === false, JSON.stringify(d).slice(0, 70));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A date filter may hide rows but must never change the ledger');
{
  seed();
  await sell(0);
  const before = custBal();
  await call('customerStatement:get', 1, { fromDate: '2020-01-01', toDate: '2020-12-31' });
  await call('supplierStatement:get', 1, { fromDate: '2020-01-01', toDate: '2020-12-31' });
  await call('cashAccount:statement', 1, { fromDate: '2020-01-01', toDate: '2020-12-31' });
  t('reading a statement does not write to the books', custBal() === before,
    `balance ${before} -> ${custBal()}`);
  const empty = await call('customerStatement:get', 1, { fromDate: '2020-01-01', toDate: '2020-12-31' });
  t('a period with no activity returns no operations',
    (empty.operations || []).length === 0, `${(empty.operations || []).length} rows`);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The employee statement agrees with what the employee is owed');
{
  seed();
  await call('advances:create', {
    EmployeeID: 1, Amount: 500, Reason: 'r', Date: '2026-07-30',
    CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const st = await call('employeeStatement:get', 1);
  t('the advance appears in the statement totals',
    st?.success === true && near(st.totals?.totalAdvances, 500),
    JSON.stringify(st?.totals).slice(0, 120));
  t('an advance not yet deducted is still outstanding',
    near(st.totals?.pendingAdvances, 500), `pending ${st.totals?.pendingAdvances}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
