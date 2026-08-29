#!/usr/bin/env node
/**
 * BACK OFFICE — vouchers, payroll, services, settlements, opening balances, rent.
 *
 * WHY THIS EXISTS
 * ---------------
 * A coverage scan comparing every registered IPC channel against the channels
 * the suites actually invoke found 172 of 224 never executed by any test, and
 * 18 of those write balances or stock. Trading and maintenance had been audited
 * to death; the back office had never been run once.
 *
 * It was not empty. Seven real faults were found in the first pass, including
 * one that made inventory settlement impossible on every installation.
 *
 * THE METHODS, AND WHY EACH IS HERE
 * ---------------------------------
 *   1. ROUND-TRIP CONSERVATION — create a document then delete it. The books
 *      must return to the exact figures they started from. This needs no model
 *      of what is "correct": it compares the shop against itself, so it cannot
 *      inherit a mistaken expectation. It found the service-fee leak.
 *
 *   2. SIGN ABUSE — feed a negative amount to anything that takes money. Every
 *      handler writes `Balance = Balance + ?` in its own hand, so a minus sign
 *      runs the whole operation backwards and INVENTS money rather than
 *      failing. Three handlers did exactly that.
 *
 *   3. AGGREGATE-VS-ROW — a stocktake states a total across warehouses while
 *      the data is stored per warehouse. Any handler that confuses the two
 *      corrupts every multi-warehouse item. This found the settlement bug.
 *
 *   4. DOUBLE-DESTINATION — when a payment names both a cash box and a wallet,
 *      exactly one must move. This is the third place in this project where
 *      that same fault has appeared.
 *
 *   5. IDEMPOTENCE — paying the same salary twice, deleting the same document
 *      twice. The second attempt must change nothing.
 *
 * Run with:  node --experimental-strip-types scripts/verify_back_office.mjs
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

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(2,'Second')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',1000,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Sup',2000,'active')");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(1,'Tech',3000,500,0,1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Part','accessory',0,100,200,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,100)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,4,100)");
  return db;
}

/** Every balance that carries value, as one comparable string. */
const books = () => JSON.stringify({
  cash: currentDb().prepare('SELECT CashAccountID i, ROUND(Balance,2) v FROM cash_accounts ORDER BY 1').all(),
  wallets: currentDb().prepare('SELECT PaymentMethodID i, ROUND(Balance,2) v FROM payment_methods ORDER BY 1').all(),
  customers: currentDb().prepare('SELECT CustomerID i, ROUND(Balance,2) v FROM customers ORDER BY 1').all(),
  suppliers: currentDb().prepare('SELECT SupplierID i, ROUND(Balance,2) v FROM suppliers ORDER BY 1').all(),
  employees: currentDb().prepare('SELECT EmployeeID i, ROUND(Balance,2) v FROM employees ORDER BY 1').all(),
  stock: currentDb().prepare('SELECT ItemID i, WarehouseID w, ROUND(Quantity,4) q FROM stock_quantities ORDER BY 1,2').all(),
});

const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
const wallet = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v;
const stockTotal = () => q('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID=1').v;

const voucher = o => call('vouchers:create', {
  VoucherType: 'receipt', Amount: 300, Date: '2026-07-30',
  PartyType: 'customer', PartyID: 1, PartyName: 'Ahmed', Description: 'd',
  CashAccountID: 1, fiscalYearId: 1, userId: 1, ...o,
});
const service = o => call('serviceSales:create', {
  ServiceType: 'balance_transfer', Provider: 'vodafone', TargetPhone: '0100',
  CustomerID: 1, CustomerName: 'Ahmed', CustomerPhone: '0100',
  PaymentMethod: 'cash', Notes: '', PaidToProvider: 1000,
  ChargeAmount: 1020, Date: '2026-07-30', PaidAmount: 1020,
  CashAccountID: 1, ReceiveAccountType: 'cash_account', ReceiveAccountID: 1,
  fiscalYearId: 1, userId: 1, ...o,
});

console.log('BACK OFFICE — round-trip, sign abuse, aggregate-vs-row, idempotence\n');

// ---------------------------------------------------------------- 1
console.log('[1] Creating a document then deleting it must be perfectly neutral');
for (const [label, opts] of [
  ['receipt from a customer', { VoucherType: 'receipt', PartyType: 'customer', PartyID: 1 }],
  ['payment to a supplier', { VoucherType: 'payment', PartyType: 'supplier', PartyID: 1 }],
  ['payment to an employee', { VoucherType: 'payment', PartyType: 'employee', PartyID: 1 }],
  ['general expense (no party)', { VoucherType: 'payment', PartyType: null, PartyID: null }],
  ['receipt into a wallet', { VoucherType: 'receipt', PartyType: 'customer', PartyID: 1, PaymentMethodID: 1 }],
]) {
  seed();
  const before = books();
  const res = await voucher(opts);
  const vid = q('SELECT VoucherID v FROM vouchers ORDER BY VoucherID DESC')?.v;
  await call('delete:voucher', vid);
  t(`voucher — ${label}`, books() === before,
    res?.success ? `${before}\n        -> ${books()}` : JSON.stringify(res));
}
{
  seed();
  const before = books();
  await service({});
  const sid = q('SELECT ServiceSaleID v FROM service_sales ORDER BY ServiceSaleID DESC')?.v;
  await call('delete:serviceSale', sid);
  // The provider/transfer fee is a real outflow on create. If the delete does
  // not hand it back, cancelling a service quietly keeps the fee.
  t('service sale — fee paid from cash is returned on delete', books() === before,
    `${before}\n        -> ${books()}`);
}
{
  seed();
  const before = books();
  await service({ PaymentMethodID: 1 });
  const sid = q('SELECT ServiceSaleID v FROM service_sales ORDER BY ServiceSaleID DESC')?.v;
  await call('delete:serviceSale', sid);
  t('service sale — fee paid from a wallet is returned to the SAME wallet',
    books() === before, `${before}\n        -> ${books()}`);
}
{
  seed();
  const before = books();
  await call('advances:create', { EmployeeID: 1, Amount: 500, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  const aid = q('SELECT AdvanceID v FROM employee_advances ORDER BY AdvanceID DESC')?.v;
  await call('delete:advance', aid);
  t('employee advance — issue then delete', books() === before,
    `${before}\n        -> ${books()}`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A negative amount must be refused, never run backwards');
// Each handler writes `Balance = Balance + ?` in its own hand, so a minus sign
// does not fail — it reverses the operation and invents money.
{
  seed(); const before = cash();
  const res = await voucher({ Amount: -9999 });
  t('a receipt of -9999 cannot take money OUT of the till',
    !res?.success && cash() === before, `cash ${before} -> ${cash()}`);
}
{
  seed(); const before = cash();
  const res = await voucher({ VoucherType: 'payment', PartyType: null, PartyID: null, Amount: -9999 });
  t('a payment of -9999 cannot put money IN', !res?.success && cash() === before,
    `cash ${before} -> ${cash()}`);
}
{
  seed(); const before = cash();
  const res = await call('advances:create', { EmployeeID: 1, Amount: -5000, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  t('an advance of -5000 cannot ADD 5000 to the cash box',
    !res?.success && cash() === before, `cash ${before} -> ${cash()}`);
}
{
  seed();
  const res = await call('deductions:create', { EmployeeID: 1, Amount: -500, Reason: 'absence', Date: '2026-07-30', fiscalYearId: 1, userId: 1 });
  t('a deduction of -500 is not a bonus', !res?.success, JSON.stringify(res));
}
{
  seed();
  const res = await service({ PaidToProvider: -5000, ChargeAmount: -4900, PaidAmount: -4900 });
  // This one balanced out in cash, so nothing looked wrong — but the row was
  // stored and reported a phantom profit in the income statement.
  t('a negative service is refused before it can be stored',
    !res?.success && (q('SELECT COUNT(*) v FROM service_sales').v === 0),
    JSON.stringify(res));
}
{
  seed();
  // A negative PAYMENT with a real customer is the case only `checkAmounts`
  // sees: the principal is positive, so no earlier gate trips. Dropping that
  // guard must not let the row through and report a phantom profit.
  const res = await service({ PaidToProvider: 100, ChargeAmount: 100, PaidAmount: -900 });
  t('a negative payment on a credit service is refused before it can be stored',
    !res?.success && (q('SELECT COUNT(*) v FROM service_sales').v === 0),
    JSON.stringify(res));
}
{
  seed();
  const res = await voucher({ Amount: 0 });
  t('a zero-value voucher is refused', !res?.success, JSON.stringify(res));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Money must land in exactly ONE account');
{
  // These two used to assert that naming BOTH a safe and a wallet moved the
  // amount once rather than twice — the old form offered both fields, so the
  // handler had to pick one and did, silently. The screen now asks the
  // question once and the handler REFUSES a voucher that names two assets, so
  // the ambiguity cannot be expressed at all. That is strictly safer: the
  // document can no longer name an asset that never moved.
  seed();
  const c0 = cash(), w0 = wallet();
  const both = await voucher({ Amount: 300, PaymentMethodID: 1 });
  t('a receipt naming BOTH a safe and a wallet is refused', both?.success === false,
    JSON.stringify(both));
  t('and no money moves for it', Math.abs(r2((cash() - c0) + (wallet() - w0))) < 0.011);
}
{
  seed();
  const c0 = cash(), w0 = wallet();
  const bothPay = await voucher({ VoucherType: 'payment', PartyType: null, PartyID: null, Amount: 300, PaymentMethodID: 1 });
  t('a payment naming BOTH is refused too', bothPay?.success === false, JSON.stringify(bothPay));
  t('and no money moves for that either', Math.abs(r2((cash() - c0) + (wallet() - w0))) < 0.011);
}
{
  // The rule the section is really about: whichever ONE asset is named, the
  // amount lands there exactly once.
  seed();
  const c0 = cash(), w0 = wallet();
  await voucher({ Amount: 300, CashAccountID: null, PaymentMethodID: 1 });
  t('a wallet-only receipt credits the wallet once',
    Math.abs(r2(wallet() - w0) - 300) < 0.011, `wallet moved ${r2(wallet() - w0)}`);
  t('and leaves the safe alone', Math.abs(r2(cash() - c0)) < 0.011);
}
{
  seed();
  const c0 = cash(), w0 = wallet();
  await voucher({ Amount: 300 });
  t('a safe-only receipt credits the safe once',
    Math.abs(r2(cash() - c0) - 300) < 0.011, `safe moved ${r2(cash() - c0)}`);
  t('and leaves the wallet alone', Math.abs(r2(wallet() - w0)) < 0.011);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A stocktake states a TOTAL, but stock is stored per warehouse');
{
  seed();
  // 10 in the main store + 4 in the second = 14. The user counts 12.
  const res = await call('settlements:apply', {
    section: 'inventory',
    items: [{ ItemID: 1, ItemName: 'Part', RecordedBalance: 14, ActualBalance: 12, Difference: -2, AdjustmentType: 'decrease' }],
    userId: 1, fiscalYearId: 1,
  });
  t('the settlement completes at all', res?.success === true, JSON.stringify(res));
  t('counting 12 leaves exactly 12 across all warehouses',
    stockTotal() === 12,
    `asked for 12, ended with ${stockTotal()} — writing the item total into one warehouse row leaves the others on top`);
}
{
  seed();
  const before = stockTotal();
  const res = await call('settlements:apply', {
    section: 'inventory',
    items: [{ ItemID: 1, ItemName: 'Part', RecordedBalance: 14, ActualBalance: -50, Difference: -64, AdjustmentType: 'decrease' }],
    userId: 1, fiscalYearId: 1,
  });
  t('you cannot count minus fifty handsets',
    !res?.success && stockTotal() === before, `stock ${before} -> ${stockTotal()}`);
}
{
  seed();
  const res = await call('settlements:apply', {
    section: 'cash',
    items: [{ ItemID: 1, ItemName: 'Safe', RecordedBalance: 100000, ActualBalance: -5, Difference: -100005, AdjustmentType: 'decrease' }],
    userId: 1, fiscalYearId: 1,
  });
  t('a cash drawer cannot be counted as negative', !res?.success, JSON.stringify(res));
}
{
  seed();
  await call('settlements:apply', {
    section: 'cash',
    items: [{ ItemID: 1, ItemName: 'Safe', RecordedBalance: 100000, ActualBalance: 99500, Difference: -500, AdjustmentType: 'decrease' }],
    userId: 1, fiscalYearId: 1,
  });
  const pl = await call('reports:profitLoss', {});
  t('a 500 shortage reaches the income statement as an expense',
    Math.abs((pl.expenses?.general ?? 0) - 500) < 0.011,
    `general expenses ${pl.expenses?.general}`);
  t('and the cash account really is set to the counted figure',
    cash() === 99500, `cash ${cash()}`);
}
{
  seed();
  const res = await call('settlements:apply', { section: 'inventory', items: [], userId: 1, fiscalYearId: 1 });
  t('an empty settlement is refused', !res?.success, JSON.stringify(res));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The same money cannot be paid twice');
{
  seed();
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const sid = q('SELECT SalaryID v FROM salaries ORDER BY SalaryID DESC')?.v;
  await call('salaries:pay', { SalaryID: sid, PaidAmount: 3500, CashAccountID: 1, userId: 1 });
  const after = cash();
  const res = await call('salaries:pay', { SalaryID: sid, PaidAmount: 3500, CashAccountID: 1, userId: 1 });
  t('a salary already paid cannot be paid again',
    !res?.success && cash() === after, `cash ${after} -> ${cash()}`);
}
{
  seed();
  const first = await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const second = await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  t('the same month cannot be issued twice for one employee',
    first?.success === true && second?.success === false, JSON.stringify(second));
}
{
  seed();
  await voucher({});
  const vid = q('SELECT VoucherID v FROM vouchers ORDER BY VoucherID DESC')?.v;
  await call('delete:voucher', vid);
  const after = books();
  const res = await call('delete:voucher', vid);
  t('deleting an already-deleted voucher changes nothing',
    !res?.success && books() === after, JSON.stringify(res));
}
{
  seed();
  const res = await call('salaries:pay', { SalaryID: 9999, PaidAmount: 100, CashAccountID: 1, userId: 1 });
  t('paying a salary that does not exist is refused', !res?.success, JSON.stringify(res));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Money cannot be taken from an account that does not hold it');
{
  seed();
  currentDb().exec('UPDATE cash_accounts SET Balance = 100 WHERE CashAccountID = 1');
  const res = await voucher({ VoucherType: 'payment', PartyType: null, PartyID: null, Amount: 50000 });
  t('a payment larger than the drawer is refused', !res?.success && cash() === 100,
    `cash ${cash()}`);
}
{
  seed();
  currentDb().exec('UPDATE cash_accounts SET Balance = 100 WHERE CashAccountID = 1');
  const res = await call('advances:create', { EmployeeID: 1, Amount: 50000, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  t('an advance larger than the drawer is refused', !res?.success && cash() === 100,
    `cash ${cash()}`);
}
{
  seed();
  currentDb().exec('UPDATE cash_accounts SET Balance = 100 WHERE CashAccountID = 1');
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const sid = q('SELECT SalaryID v FROM salaries ORDER BY SalaryID DESC')?.v;
  const res = await call('salaries:pay', { SalaryID: sid, PaidAmount: 3500, CashAccountID: 1, userId: 1 });
  t('a salary larger than the drawer is refused', !res?.success && cash() === 100,
    `cash ${cash()}`);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A deduction or commission is settled ONCE, not every month');
// These were read with IsDeducted = 0 / IsPaid = 0, folded into the salary, and
// never flagged — so the same penalty came off the employee's wage again the
// next month, for ever. The fuzzer found the drift; this pins the behaviour.
{
  seed();
  await call('deductions:create', {
    EmployeeID: 1, Amount: 300, Reason: 'absence', Date: '2026-07-30',
    fiscalYearId: 1, userId: 1,
  });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const july = q("SELECT NetSalary, DeductionsTotal FROM salaries WHERE Month='2026-07'");
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-08', fiscalYearId: 1, userId: 1 });
  const august = q("SELECT NetSalary, DeductionsTotal FROM salaries WHERE Month='2026-08'");

  t('the deduction reduces the month it belongs to',
    Math.abs(july.DeductionsTotal - 300) < 0.011, `July deductions ${july.DeductionsTotal}`);
  t('the SAME deduction is not taken again next month',
    Math.abs(august.DeductionsTotal) < 0.011,
    `August deductions ${august.DeductionsTotal} — the employee is being penalised for ever`);
  t('so the second month pays the full wage',
    Math.abs(august.NetSalary - 3500) < 0.011, `August net ${august.NetSalary}`);
  t('and the deduction is marked settled against a salary',
    q('SELECT COUNT(*) v FROM employee_deductions WHERE IsDeducted = 1').v === 1);
}
{
  seed();
  currentDb().exec(
    "INSERT INTO commissions(EmployeeID,CommissionType,Amount,Date,ReferenceType,ReferenceID,IsPaid,PaidAmount,FiscalYearID,UserID) "
    + "VALUES(1,'maintenance',400,'2026-07-30','maintenance_delivery',1,0,0,1,1)");
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-08', fiscalYearId: 1, userId: 1 });
  const august = q("SELECT CommissionsTotal FROM salaries WHERE Month='2026-08'");
  t('a commission is not paid a second time next month',
    Math.abs(august.CommissionsTotal) < 0.011,
    `August commissions ${august.CommissionsTotal}`);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Advances cannot drive a wage below zero');
{
  seed();
  currentDb().exec('UPDATE employees SET BaseSalary = 2000, Allowances = 0 WHERE EmployeeID = 1');
  await call('advances:create', { EmployeeID: 1, Amount: 1500, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  await call('advances:create', { EmployeeID: 1, Amount: 1500, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const sal = q('SELECT NetSalary, AdvancesTotal FROM salaries');
  t('3,000 of advances against a 2,000 wage does not produce a negative salary',
    sal.NetSalary >= -0.011, `net ${sal.NetSalary}`);
  t('only what the wage can absorb is recovered',
    Math.abs(sal.AdvancesTotal - 2000) < 0.011, `recovered ${sal.AdvancesTotal}`);
  t('the remaining 1,000 stays outstanding for next month',
    Math.abs(q('SELECT COALESCE(SUM(Amount),0) v FROM employee_advances WHERE IsDeducted = 0').v - 1000) < 0.011,
    `outstanding ${q('SELECT COALESCE(SUM(Amount),0) v FROM employee_advances WHERE IsDeducted = 0').v}`);
}
{
  seed();
  await call('advances:create', { EmployeeID: 1, Amount: 500, Reason: 'r', Date: '2026-07-30', CashAccountID: 1, fiscalYearId: 1, userId: 1 });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const aid = q('SELECT AdvanceID v FROM employee_advances').v;
  const before = books();
  const res = await call('delete:advance', aid);
  t('an advance already recovered from a salary cannot be deleted for cash',
    !res?.success && books() === before, JSON.stringify(res).slice(0, 90));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Opening balances are the foundation — they must be sane');
// These channels write a balance DIRECTLY, with no document behind them, and
// every later figure is built on top. A wrong opening balance is not an error
// that shows up once; it is permanently baked into the books.
{
  seed();
  const before = q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
  const res = await call('openingBalances:updateCash', 1, -5000);
  t('a cash box cannot open holding less than nothing',
    !res?.success && q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v === before,
    `balance ${q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v}`);
}
{
  seed();
  const before = q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v;
  const res = await call('openingBalances:updatePaymentMethod', 1, -3000);
  t('nor can a wallet',
    !res?.success && q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v === before);
}
{
  seed();
  const before = q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v;
  const res = await call('openingBalances:updateStock', 1, 1, -50, 100);
  t('you cannot open with minus fifty units on the shelf',
    !res?.success && q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v === before,
    `quantity ${q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v}`);
}
{
  seed();
  const before = q('SELECT CostPrice v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v;
  const res = await call('openingBalances:updateStock', 1, 1, 10, -100);
  t('nor at a negative unit cost',
    !res?.success && q('SELECT CostPrice v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v === before);
}
{
  seed();
  // A customer CAN legitimately open in credit: it means the shop owes them.
  // The guard must not over-reach and block a real accounting position.
  const res = await call('openingBalances:updateCustomer', 1, -500);
  t('but a customer may open in credit — the shop can owe them',
    res?.success === true && q('SELECT Balance v FROM customers WHERE CustomerID=1').v === -500,
    JSON.stringify(res));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
