#!/usr/bin/env node
/**
 * REPORTS, COLLECTION AND PAYMENT — does every pound land where it should?
 *
 * WHY THIS EXISTS
 * ---------------
 * The reports are the only part of this system the owner actually reads. Every
 * defect found elsewhere in this project — the double-credited voucher, the
 * quantity expensed as money, the supplier statement that overstated a debt —
 * ended up as a wrong number on one of these screens, and a wrong number that
 * looks plausible is worse than a crash, because nobody investigates it.
 *
 * This suite checks the arithmetic of the reports directly, and it concentrates
 * on the two places money physically enters and leaves the shop:
 *
 *   - HOW A CUSTOMER PAYS   — at the till, from a wallet, part now part later,
 *                             overpaying, or by a receipt voucher afterwards;
 *   - HOW A SUPPLIER IS PAID — on the invoice, later by payment voucher, or
 *                             partly offset by a debit note.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSUME
 * ------------------------------------
 * The right answer is derived from the documents, not from a figure I decided
 * in advance. Where a total can be reached two ways — the P&L, the balance
 * sheet, the party's statement and the raw ledger — they are compared against
 * EACH OTHER. Two independently written views disagreeing is proof one is
 * wrong, and needs no prior knowledge of which.
 *
 * A NOTE ON `retainedEarnings`
 * ----------------------------
 * Two drafts of this suite failed against correct code because they treated
 * `capital.retainedEarnings` as an error term. It is not: it is DEFINED as
 * `balanceCheck - explicitCapital`, i.e. the profit itself. The real self-check
 * the report publishes is `capital.difference` / `capital.isBalanced`. Getting
 * that wrong would have had me "fixing" a correct balance sheet.
 *
 * Run with:  node --experimental-strip-types scripts/verify_reports_money.mjs
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
const all = (sql, ...a) => currentDb().prepare(sql).all(...a);
const near = (a, b, tol = 0.011) => Math.abs(r2(a) - r2(b)) <= tol;

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(2,'Bank','bank',200000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'Wallet','wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Sup',0,'active')");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(1,'Tech',3000,0,0,1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Part','part',0,100,300,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,100)");
  return db;
}

const cash = (id = 1) => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=?', id).v;
const wallet = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v;
const cust = () => q('SELECT Balance v FROM customers WHERE CustomerID=1').v;
const supp = () => q('SELECT Balance v FROM suppliers WHERE SupplierID=1').v;

const sell = o => call('sales:create', {
  CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 300 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 3000,
  PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1, ...o,
});
const buy = o => call('purchases:create', {
  SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 100, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0,
  fiscalYearId: 1, userId: 1, ...o,
});
const voucher = o => call('vouchers:create', {
  VoucherType: 'receipt', Amount: 500, Date: '2026-07-30',
  PartyType: 'customer', PartyID: 1, PartyName: 'Ahmed', Description: 'd',
  CashAccountID: 1, fiscalYearId: 1, userId: 1, ...o,
});

console.log('REPORTS, COLLECTION AND PAYMENT — every pound accounted for\n');

// ---------------------------------------------------------------- 1
console.log('[1] The profit report is arithmetic, not an estimate');
{
  seed();
  await sell({});
  const pl = await call('reports:profitLoss', {});
  t('revenue is what was invoiced', near(pl.revenue.salesGross, 3000), `${pl.revenue.salesGross}`);
  t('cost of sales is what left the shelf', near(pl.costs.cogs, 1000), `${pl.costs.cogs}`);
  t('gross profit is the difference, exactly', near(pl.grossProfit, 2000), `${pl.grossProfit}`);
}
{
  seed();
  await sell({ Discount: 500, PaidAmount: 2500 });
  const pl = await call('reports:profitLoss', {});
  t('a discount reduces net sales, not cost', near(pl.revenue.netSales, 2500), `${pl.revenue.netSales}`);
  t('and reduces profit by exactly the discount', near(pl.grossProfit, 1500), `${pl.grossProfit}`);
}
{
  seed();
  await sell({});
  const sid = q('SELECT SaleID v FROM sales').v;
  const det = all('SELECT ItemID, UnitPrice FROM sale_details WHERE SaleID=?', sid);
  await call('saleReturns:create', {
    SaleID: sid, CustomerID: 1,
    items: det.map(d => ({ ItemID: d.ItemID, Quantity: 4, UnitPrice: d.UnitPrice })),
    Reason: 'faulty', AccountCredit: 0, CashRefund: 1200, CashAccountID: 1,
    fiscalYearId: 1, userId: 1,
  });
  const pl = await call('reports:profitLoss', {});
  t('a return reverses revenue', near(pl.revenue.salesReturns, 1200), `${pl.revenue.salesReturns}`);
  t('AND reverses its cost — not one without the other',
    near(pl.costs.cogsReturns, 400), `${pl.costs.cogsReturns}`);
  t('so profit falls to the six units still sold',
    near(pl.grossProfit, 1200), `${pl.grossProfit} (6 x 200)`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The balance sheet balances — using its OWN self-check');
// `capital.difference` is the report's published check. `retainedEarnings` is
// the profit by definition, not an error term; two earlier drafts of this
// suite got that wrong and failed against correct code.
for (const [label, setup] of [
  ['a credit sale', async () => { await sell({ PaidAmount: 0 }); }],
  ['a cash sale', async () => { await sell({}); }],
  ['a purchase on credit', async () => { await buy({}); }],
  ['a wallet sale', async () => { await sell({ PaidAmount: 3000, CashAccountID: undefined, PaymentMethodID: 1 }); }],
]) {
  seed();
  await call('capital:set', 350000);   // cash 100k + bank 200k + wallet 50k
  // Stock was seeded directly, so tell the books it was contributed too.
  await call('capital:set', 350000 + 10000);
  await setup();
  const fp = await call('reports:financialPosition');
  t(`balances after ${label}`, fp.capital?.isBalanced === true,
    `difference ${r2(fp.capital?.difference)} `
    + `(assets ${r2(fp.assets?.totalAssets)} - liabilities ${r2(fp.liabilities?.totalLiabilities)} `
    + `vs capital ${r2(fp.capital?.explicitCapital)} + profit ${r2(fp.capital?.netProfit)})`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] How a customer pays: every route lands in ONE place');
{
  seed();
  const c0 = cash();
  await sell({ PaidAmount: 3000 });
  t('paid at the till: the drawer rises by the full amount',
    near(cash() - c0, 3000), `+${r2(cash() - c0)}`);
  t('and the customer owes nothing', near(cust(), 0), `balance ${cust()}`);
}
{
  seed();
  const c0 = cash(), w0 = wallet();
  await sell({ PaidAmount: 3000, CashAccountID: undefined, PaymentMethodID: 1 });
  const moved = r2((cash() - c0) + (wallet() - w0));
  t('paid by wallet: the money lands once, in the wallet',
    near(wallet() - w0, 3000) && near(cash(), c0), `wallet +${r2(wallet() - w0)}, cash +${r2(cash() - c0)}`);
  t('the total credited equals the total paid', near(moved, 3000), `${moved}`);
}
{
  seed();
  const c0 = cash();
  await sell({ PaidAmount: 1200 });
  t('part paid: the drawer takes only what was handed over',
    near(cash() - c0, 1200), `+${r2(cash() - c0)}`);
  t('and the rest becomes a debt', near(cust(), 1800), `balance ${cust()}`);
}
{
  seed();
  await sell({ PaidAmount: 3500 });
  t('overpaying leaves the shop owing the customer',
    near(cust(), -500), `balance ${cust()} (a credit, which is correct)`);
}
{
  // Collected later by receipt voucher: the classic two-step.
  seed();
  await sell({ PaidAmount: 0 });
  const owed = cust();
  const c0 = cash();
  await voucher({ Amount: 1500 });
  t('a receipt voucher reduces the debt by exactly its amount',
    near(cust(), owed - 1500), `${owed} -> ${cust()}`);
  t('and puts that money in the drawer once',
    near(cash() - c0, 1500), `+${r2(cash() - c0)}`);
  const st = await call('customerStatement:get', 1, {});
  t('the statement still agrees with the ledger',
    near(st.totals?.netBalance, cust()), `statement ${st.totals?.netBalance} vs ledger ${cust()}`);
}
{
  seed();
  await sell({ PaidAmount: 0 });
  const c0 = cash(), w0 = wallet();
  await voucher({ Amount: 1000, PaymentMethodID: 1 });
  t('a receipt into a wallet credits the wallet only, never both',
    near(wallet() - w0, 1000) && near(cash(), c0),
    `wallet +${r2(wallet() - w0)}, cash +${r2(cash() - c0)}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] How a supplier is paid: the mirror image');
{
  seed();
  const c0 = cash();
  await buy({ PaidAmount: 400, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
  t('paying on the invoice takes the money out once',
    near(c0 - cash(), 400), `-${r2(c0 - cash())}`);
  t('and the supplier is owed only the balance', near(supp(), 600), `owed ${supp()}`);
  const st = await call('supplierStatement:get', 1, {});
  t('the supplier statement agrees with what is owed',
    near(st.totals?.netBalance, supp()), `statement ${st.totals?.netBalance} vs ledger ${supp()}`);
}
{
  seed();
  await buy({});
  const owed = supp(), c0 = cash();
  await voucher({ VoucherType: 'payment', PartyType: 'supplier', PartyID: 1, Amount: 700 });
  t('a payment voucher settles part of the debt',
    near(supp(), owed - 700), `${owed} -> ${supp()}`);
  t('and takes the cash out exactly once',
    near(c0 - cash(), 700), `-${r2(c0 - cash())}`);
  const st = await call('supplierStatement:get', 1, {});
  t('the statement follows', near(st.totals?.netBalance, supp()),
    `statement ${st.totals?.netBalance} vs ledger ${supp()}`);
}
{
  seed();
  await buy({});
  const owed = supp();
  const pid = q('SELECT PurchaseID v FROM purchases').v;
  const pd = all('SELECT DetailID, ItemID, UnitCost FROM purchase_details WHERE PurchaseID=?', pid);
  await call('purchaseReturns:create', {
    PurchaseID: pid, SupplierID: 1,
    items: pd.map(d => ({ DetailID: d.DetailID, ItemID: d.ItemID, Quantity: 3, UnitCost: d.UnitCost, WarehouseID: 1 })),
    Reason: 'faulty', AccountCredit: 300, CashRefund: 0, fiscalYearId: 1, userId: 1,
  });
  t('a debit note reduces what the shop owes',
    near(supp(), owed - 300), `${owed} -> ${supp()}`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Vouchers: direction is the type, never the sign');
{
  seed();
  const before = { c: cash(), w: wallet(), cu: cust(), s: supp() };
  for (const bad of [
    { Amount: -500 },
    { Amount: 0 },
    { Amount: 'abc' },
    { Amount: Number.POSITIVE_INFINITY },
  ]) {
    const res = await voucher(bad);
    t(`a voucher of ${JSON.stringify(bad.Amount)} is refused`, res?.success === false,
      JSON.stringify(res).slice(0, 70));
  }
  t('and not one balance moved during those attempts',
    near(cash(), before.c) && near(wallet(), before.w)
    && near(cust(), before.cu) && near(supp(), before.s));
}
{
  seed();
  currentDb().exec('UPDATE cash_accounts SET Balance = 100 WHERE CashAccountID = 1');
  const res = await voucher({ VoucherType: 'payment', PartyType: null, PartyID: null, Amount: 5000 });
  t('a payment larger than the drawer holds is refused',
    res?.success === false && near(cash(), 100), `cash ${cash()}`);
}
{
  // A general voucher is real income or expense; a party voucher is a
  // settlement. Confusing the two overstates profit.
  seed();
  await call('capital:set', 360000);
  await voucher({ VoucherType: 'receipt', PartyType: null, PartyID: null, Amount: 800, PartyName: '' });
  const pl1 = await call('reports:profitLoss', {});
  t('a general receipt IS other income', near(pl1.revenue.otherIncome, 800),
    `otherIncome ${pl1.revenue.otherIncome}`);

  seed();
  await call('capital:set', 360000);
  await sell({ PaidAmount: 0 });
  await voucher({ Amount: 800 });          // from a customer = settlement
  const pl2 = await call('reports:profitLoss', {});
  t('a customer receipt is NOT income, it is collection of a debt',
    near(pl2.revenue.otherIncome, 0), `otherIncome ${pl2.revenue.otherIncome}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Four views of the same trade must agree');
// The ledger, the P&L, the balance sheet and the statement are written
// separately. Comparing them needs no prior knowledge of the right answer.
{
  seed();
  await call('capital:set', 360000);
  await sell({ PaidAmount: 1000 });        // 3,000 invoiced, 1,000 paid
  await voucher({ Amount: 500 });          // 500 collected later

  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');
  const st = await call('customerStatement:get', 1, {});
  const rep = await call('reports:sales', {});

  t('ledger and statement agree on what the customer owes',
    near(st.totals?.netBalance, cust()), `${st.totals?.netBalance} vs ${cust()}`);
  t('the balance sheet counts the same receivable',
    near(fp.assets?.totalCustomers, cust()), `${fp.assets?.totalCustomers} vs ${cust()}`);
  t('the sales report totals the same invoice',
    near(rep.totals?.total, 3000), `${rep.totals?.total}`);
  t('the P&L recognises revenue when invoiced, not when collected',
    near(pl.revenue.salesGross, 3000),
    `${pl.revenue.salesGross} — accrual basis, only 1,500 has actually been received`);
  t('and the whole thing still balances', fp.capital?.isBalanced === true,
    `difference ${r2(fp.capital?.difference)}`);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Cash never appears in two places at once');
{
  seed();
  const opening = r2(cash(1) + cash(2) + wallet());
  await sell({ PaidAmount: 3000 });
  await buy({ PaidAmount: 500, PaymentSourceType: 'cash_account', PaymentSourceID: 2 });
  await voucher({ Amount: 200 });
  await voucher({ VoucherType: 'payment', PartyType: null, PartyID: null, Amount: 100 });
  const closing = r2(cash(1) + cash(2) + wallet());
  // in: 3,000 sale + 200 receipt   out: 500 purchase + 100 expense
  t('total liquid funds move by exactly the net of every movement',
    near(closing - opening, 3000 + 200 - 500 - 100),
    `${opening} -> ${closing} (expected +${3000 + 200 - 500 - 100})`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
