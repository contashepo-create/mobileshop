#!/usr/bin/env node
/**
 * CROSS-REPORT AGREEMENT for sales, purchases and returns.
 *
 * WHY THIS EXISTS
 * ---------------
 * One sale appears in at least five places: the sales list, the sales report,
 * the profit and loss account, the balance sheet, and the customer's statement.
 * Each is a separate query written at a different time. Nothing ever compared
 * them, so they could disagree indefinitely — and two of them already did: the
 * balance sheet was not crediting the cost of returned goods while the P&L was.
 *
 * A figure that is right in one report and wrong in another is still wrong,
 * because the owner cannot tell which to believe. These tests take ONE set of
 * documents and demand that every report tells the same story.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_reports_agree.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const near = (a, b, tol = 0.011) => Math.abs((a ?? 0) - (b ?? 0)) < tol;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function seed(capital) {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',20000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'SuppA',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','accessory',0,10,20,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,200,10)");
  db.exec(`INSERT INTO settings(Key,Value) VALUES('owner_capital','${capital}')`);
  return db;
}
const OPENING = 100000 + 20000 + 200 * 10;   // cash + wallet + stock

const sale = (o = {}) => call('sales:create', {
  CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 25 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
  PaidAmount: 250, CashAccountID: 1, fiscalYearId: 1, ...o,
});
const lastSale = () => currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;

console.log('CROSS-REPORT AGREEMENT — ONE SET OF DOCUMENTS, EVERY REPORT\n');

// ---------------------------------------------------------------- 1
console.log('[1] A plain cash sale reads the same everywhere');
{
  seed(OPENING);
  await sale();
  const list = await call('sales:list');
  const rep = await call('reports:sales', {});
  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');

  const listTotal = (list || []).reduce((s, r) => s + (r.TotalAmount || 0), 0);
  t('the sales list and the sales report agree on revenue',
    near(listTotal, rep?.totals?.total),
    `list ${r2(listTotal)} vs report ${r2(rep?.totals?.total)}`);
  t('the profit report shows the same revenue as the list',
    near(pl?.revenue?.salesGross, listTotal),
    `P&L ${r2(pl?.revenue?.salesGross)} vs list ${r2(listTotal)}`);
  t('the balance sheet and the P&L agree on profit',
    near(fp?.capital?.netProfit, pl?.grossProfit),
    `balance sheet ${r2(fp?.capital?.netProfit)} vs P&L ${r2(pl?.grossProfit)}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A credit sale reaches the customer statement intact');
{
  seed(OPENING);
  await sale({ PaymentMethod: 'credit', PaidAmount: 0, CashAccountID: undefined });
  const st = await call('customerStatement:get', 1);
  const cust = currentDb().prepare('SELECT Balance v FROM customers WHERE CustomerID=1').get().v;
  const fp = await call('reports:financialPosition');

  t('the statement closing balance equals the customer record',
    near(st?.totals?.currentBalance, cust),
    `statement ${r2(st?.totals?.currentBalance)} vs customers.Balance ${r2(cust)}`);
  t('the statement net movement equals the debt raised',
    near(st?.totals?.netBalance, cust),
    `net ${r2(st?.totals?.netBalance)} vs ${r2(cust)}`);
  t('the balance sheet counts the debt as an asset',
    near(fp?.assets?.totalCustomers, cust),
    `balance sheet ${r2(fp?.assets?.totalCustomers)} vs ${r2(cust)}`);
  t('the balance sheet still balances on a credit sale',
    near(fp?.capital?.difference, 0), `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A partial return is reflected consistently');
{
  seed(OPENING);
  await sale();                                   // 10 @ 25, cash 250
  await call('saleReturns:create', { SaleID: lastSale(),
    items: [{ ItemID: 1, Quantity: 4, UnitPrice: 25 }],
    AccountCredit: 0, CashRefund: 100, CashAccountID: 1 });

  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');
  const retTotal = currentDb().prepare('SELECT COALESCE(SUM(TotalAmount),0) v FROM sale_returns').get().v;

  t('the P&L deducts the returned revenue',
    near(pl?.revenue?.salesReturns, retTotal),
    `P&L returns ${r2(pl?.revenue?.salesReturns)} vs documents ${r2(retTotal)}`);
  t('the P&L credits the returned cost (4 units at 10)',
    near(pl?.costs?.cogsReturns, 40), `cogsReturns ${r2(pl?.costs?.cogsReturns)}`);
  t('profit is revenue less cost on the units KEPT (6 x 15)',
    near(pl?.grossProfit, 90), `gross profit ${r2(pl?.grossProfit)}`);
  t('the balance sheet agrees with the P&L',
    near(fp?.capital?.netProfit, pl?.grossProfit),
    `${r2(fp?.capital?.netProfit)} vs ${r2(pl?.grossProfit)}`);
  t('the balance sheet balances after a partial return',
    near(fp?.capital?.difference, 0), `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A purchase and its debit note reach the supplier statement');
{
  seed(OPENING);
  await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 50, UnitCost: 12, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
  const pid = currentDb().prepare('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').get().v;
  await call('purchaseReturns:create', { PurchaseID: pid,
    items: [{ ItemID: 1, Quantity: 20, UnitCost: 12 }],
    AccountCredit: 240, CashRefund: 0 });

  const supp = currentDb().prepare('SELECT Balance v FROM suppliers WHERE SupplierID=1').get().v;
  const st = await call('supplierStatement:get', 1);
  const fp = await call('reports:financialPosition');

  t('the supplier owes exactly the goods kept (30 x 12)',
    near(supp, 360), `supplier balance ${r2(supp)}`);
  t('the supplier statement matches the supplier record',
    near(st?.totals?.currentBalance, supp),
    `statement ${r2(st?.totals?.currentBalance)} vs ${r2(supp)}`);
  t('the balance sheet reports it as a liability',
    near(fp?.liabilities?.totalSuppliers, supp),
    `balance sheet ${r2(fp?.liabilities?.totalSuppliers)} vs ${r2(supp)}`);
  t('a purchase and its return leave profit untouched',
    near(fp?.capital?.netProfit, 0), `profit ${r2(fp?.capital?.netProfit)}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Inventory agrees between the warehouse and the reports');
{
  seed(OPENING);
  await sale();                                    // 10 out
  await call('purchases:create', { SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 30, UnitCost: 12, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });

  const raw = currentDb().prepare(
    'SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').get().v;
  const fp = await call('reports:financialPosition');
  const invRep = await call('reports:inventory', {});

  t('the balance sheet inventory equals the warehouse valuation',
    near(fp?.assets?.totalInventory, raw),
    `balance sheet ${r2(fp?.assets?.totalInventory)} vs warehouse ${r2(raw)}`);
  t('the inventory report agrees too',
    near(invRep?.totals?.stockValue, raw),
    `inventory report ${r2(invRep?.totals?.stockValue)} vs warehouse ${r2(raw)}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Deleting a sale removes it from every report');
{
  seed(OPENING);
  await sale();
  const before = await call('reports:profitLoss', {});
  await call('delete:sale', lastSale());
  const after = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');

  t('revenue returns to zero', near(after?.revenue?.salesGross, 0),
    `before ${r2(before?.revenue?.salesGross)}, after ${r2(after?.revenue?.salesGross)}`);
  t('profit returns to zero', near(after?.grossProfit, 0),
    `profit ${r2(after?.grossProfit)}`);
  t('the balance sheet returns to the opening position',
    near(fp?.assets?.totalAssets, OPENING),
    `assets ${r2(fp?.assets?.totalAssets)} vs opening ${OPENING}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A machine sale: the fee is charged once, not twice');
{
  seed(OPENING);
  await sale({ PaymentMethod: 'card', PaidAmount: 250, CashAccountID: undefined,
    PaymentMethodID: 1, TransferCost: 5, TransferCostBearer: 'shop' });
  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');
  const wallet = currentDb().prepare('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').get().v;

  t('the wallet received the amount net of the fee',
    near(wallet, 20000 + 245), `wallet ${r2(wallet)} (expected ${20000 + 245})`);
  t('the P&L charges the fee exactly once',
    near(pl?.costs?.saleTransferCosts, 5), `fee charged ${r2(pl?.costs?.saleTransferCosts)}`);
  t('profit is the margin less the fee (150 - 5)',
    near(pl?.grossProfit, 145), `profit ${r2(pl?.grossProfit)}`);
  t('the balance sheet agrees',
    near(fp?.capital?.netProfit, pl?.grossProfit),
    `${r2(fp?.capital?.netProfit)} vs ${r2(pl?.grossProfit)}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] A machine sale where the CUSTOMER pays the fee');
{
  seed(OPENING);
  // Items 250 + fee 5 the customer hands over = invoice 255. The provider
  // keeps the 5, so the wallet receives 250 and revenue books 250.
  await sale({ PaymentMethod: 'card', PaidAmount: 255, CashAccountID: undefined,
    PaymentMethodID: 1, TransferCost: 5, TransferCostBearer: 'customer' });
  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');
  const wallet = currentDb().prepare('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').get().v;

  t('the invoice total includes the fee the customer pays',
    near(currentDb().prepare('SELECT TotalAmount v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v, 255),
    'invoice 255 (items + customer fee)');
  t('the wallet received the amount net of the fee (255 - 5)',
    near(wallet, 20000 + 250), `wallet ${r2(wallet)} (expected ${20000 + 250})`);
  t('revenue books the items, not the fee',
    near(pl?.revenue?.salesGross, 250), `salesGross ${r2(pl?.revenue?.salesGross)}`);
  t('the customer-paid fee is NOT charged as an expense',
    near(pl?.costs?.saleTransferCosts, 0), `fee charged ${r2(pl?.costs?.saleTransferCosts)}`);
  t('profit is the full margin (150 - 0)',
    near(pl?.grossProfit, 150), `profit ${r2(pl?.grossProfit)}`);
  t('the balance sheet agrees',
    near(fp?.capital?.netProfit, pl?.grossProfit),
    `${r2(fp?.capital?.netProfit)} vs ${r2(pl?.grossProfit)}`);
  t('the balance sheet balances', near(fp?.capital?.difference, 0),
    `difference ${fp?.capital?.difference}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
