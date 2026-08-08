#!/usr/bin/env node
/**
 * MAINTENANCE — the same methods that worked on trading, applied to repairs.
 *
 * WHY THESE METHODS
 * -----------------
 * Maintenance is the hardest section in the app: a ticket takes parts out of
 * stock, adds services, then on delivery writes BOTH a delivery record and a
 * mirror invoice into `sales`, moves the customer balance and the cash, and
 * pays a technician commission. Cancelling or returning has to undo all of it.
 *
 * Four methods are used here, each catching what the others cannot:
 *
 *   1. CONSERVATION — a repair that is delivered and then fully returned must
 *      leave the shop exactly as it was. No model, no expected figures: the
 *      books are measured before and after and simply compared.
 *
 *   2. METAMORPHIC — two routes to the same position must agree. Issuing one
 *      part of 2 must equal issuing two parts of 1; adding a part then removing
 *      it must equal never having added it.
 *
 *   3. DOUBLE-COUNTING — the mirror invoice is the dangerous part. Its lines
 *      exist only to print, because the parts already left stock when they were
 *      issued. If any reversal treats them as a normal sale, the same parts are
 *      credited to stock twice.
 *
 *   4. WARRANTY — a warranty repair charges the customer nothing but still
 *      consumes real parts. The shop must be POORER by exactly the parts cost;
 *      it is the one case where value legitimately disappears.
 *
 * Run with:  node --experimental-strip-types scripts/verify_maintenance.mjs
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
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')");
  db.exec("INSERT INTO employees(EmployeeID,Name,IsActive) VALUES(1,'Tech',1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Screen','accessory',0,100,250,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,50,100)");
  return db;
}

/** Net worth measured straight from the balances — no model. */
function netWorth(db) {
  const g = s => db.prepare(s).get()?.v ?? 0;
  return r2(
    g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance>0')
    - g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance<0'),
  );
}

/** Everything that carries value, for comparing two routes. */
function snapshot(db) {
  const all = s => db.prepare(s).all();
  return {
    cash: all('SELECT CashAccountID, ROUND(Balance,2) v FROM cash_accounts ORDER BY CashAccountID'),
    wallets: all('SELECT PaymentMethodID, ROUND(Balance,2) v FROM payment_methods ORDER BY PaymentMethodID'),
    customers: all('SELECT CustomerID, ROUND(Balance,2) v FROM customers ORDER BY CustomerID'),
    stock: all('SELECT ItemID, WarehouseID, ROUND(Quantity,4) q, ROUND(Quantity*CostPrice,2) v FROM stock_quantities ORDER BY ItemID, WarehouseID'),
    ticket: all('SELECT ROUND(PartsCost,2) p, ROUND(TotalCost,2) t, Status FROM maintenance_tickets ORDER BY TicketID'),
  };
}
const diff = (a, b) => Object.keys(a)
  .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  .map(k => `${k}:\n          A ${JSON.stringify(a[k])}\n          B ${JSON.stringify(b[k])}`);

const receive = (o = {}) => call('maintenance:receive', {
  CustomerID: 1, CustomerName: 'Ahmed', CustomerPhone: '0100',
  DeviceModel: 'X', ProblemDesc: 'broken', TechnicianID: 1, fiscalYearId: 1, ...o,
});
const issue = (o) => call('maintenance:issuePart', { WarehouseID: 1, ...o });
const deliver = (o) => call('maintenance:deliver', {
  LaborCost: 0, Discount: 0, PaidAmount: 0,
  PaymentMethod: 'cash', fiscalYearId: 1, ...o,
});

console.log('MAINTENANCE — conservation, metamorphic, double-counting, warranty\n');

// ---------------------------------------------------------------- 1
console.log('[1] Adding a part then removing it must leave no trace');
{
  const db = seed();
  await receive();
  const before = snapshot(db);
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  await call('maintenance:removePart', q('SELECT PartID v FROM maintenance_parts').v, 1);
  const d = diff(before, snapshot(db));
  t('issue then remove == never issued', d.length === 0, d.join('\n        '));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Splitting how parts are issued must not change the books');
{
  const runA = async () => {
    const db = seed(); await receive();
    await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
    return snapshot(db);
  };
  const runB = async () => {
    const db = seed(); await receive();
    await issue({ TicketID: 1, ItemID: 1, Quantity: 1, SalePrice: 250 });
    await issue({ TicketID: 1, ItemID: 1, Quantity: 1, SalePrice: 250 });
    return snapshot(db);
  };
  const d = diff(await runA(), await runB());
  t('one part of 2 == two parts of 1', d.length === 0, d.join('\n        '));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A delivered repair that is fully returned must be neutral');
{
  const db = seed();
  await receive();
  const opening = netWorth(db);
  await issue({ TicketID: 1, ItemID: 1, Quantity: 1, SalePrice: 250 });
  const del = await deliver({ TicketID: 1, LaborCost: 100, PaidAmount: 350, CashAccountID: 1 });
  t('the repair is delivered', del?.success === true, del?.message);
  const afterDelivery = netWorth(db);
  t('delivering earns the margin', afterDelivery > opening,
    `${opening} -> ${afterDelivery} (parts cost 100, charged 350)`);

  const deliveryId = q('SELECT DeliveryID v FROM maintenance_deliveries').v;
  const ret = await call('maintenance:return', {
    DeliveryID: deliveryId, TicketID: 1, Reason: 'faulty', TotalRefund: 350,
    CashAccountID: 1, PartsRestored: 1, fiscalYearId: 1,
  });
  t('the repair can be returned', ret?.success === true, ret?.message);
  const afterReturn = netWorth(db);
  t('a full return puts the shop back exactly where it started',
    Math.abs(afterReturn - opening) < 0.011, `${opening} -> ${afterReturn}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The mirror invoice must not credit the same parts twice');
{
  const db = seed();
  await receive();
  await issue({ TicketID: 1, ItemID: 1, Quantity: 3, SalePrice: 250 });
  const stockAfterIssue = q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v;
  t('issuing 3 parts takes them out of stock', stockAfterIssue === 47, 'stock ' + stockAfterIssue);

  await deliver({ TicketID: 1, LaborCost: 0, PaidAmount: 750, CashAccountID: 1 });
  t('delivering does not move stock again',
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 47,
    'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);

  // The mirror invoice's lines carry no warehouse, so a generic sale reversal
  // must skip them.
  const orphan = q(`SELECT COUNT(*) v FROM sale_details sd
                    JOIN sales s ON sd.SaleID = s.SaleID
                    WHERE s.Source='maintenance' AND sd.WarehouseID IS NOT NULL`).v;
  t('mirror-invoice lines carry no warehouse, so no reversal can restock them',
    orphan === 0, `${orphan} line(s) would be restocked twice`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Cancelling a ticket returns the parts to the shelf');
{
  const db = seed();
  await receive();
  const opening = netWorth(db);
  await issue({ TicketID: 1, ItemID: 1, Quantity: 4, SalePrice: 250 });
  const c = await call('maintenance:cancel', { TicketID: 1, Reason: 'customer left', userId: 1 });
  t('the ticket can be cancelled', c?.success === true, c?.message);
  t('the parts are back in stock',
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 50,
    'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);
  t('cancelling costs the shop nothing',
    Math.abs(netWorth(db) - opening) < 0.011, `${opening} -> ${netWorth(db)}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] A warranty repair is free to the customer but real to the shop');
{
  const db = seed();
  await receive({ MaintenanceType: 'warranty' });
  const opening = netWorth(db);
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  const del = await deliver({ TicketID: 1, LaborCost: 50, PaidAmount: 0 });
  t('a warranty repair is delivered', del?.success === true, del?.message);

  const inv = q("SELECT TotalAmount v FROM sales WHERE Source='maintenance'");
  t('the customer is charged nothing', (inv?.v ?? -1) === 0, 'invoice total ' + inv?.v);
  t('the customer owes nothing',
    Math.abs(q('SELECT Balance v FROM customers WHERE CustomerID=1').v) < 0.011,
    'balance ' + q('SELECT Balance v FROM customers WHERE CustomerID=1').v);

  // Two parts at cost 100 left the shelf and nobody paid for them.
  const expected = r2(opening - 200);
  t('the shop is poorer by exactly the parts it gave away',
    Math.abs(netWorth(db) - expected) < 0.011,
    `${opening} -> ${netWorth(db)}, expected ${expected}`);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A repair cannot consume stock the shop does not have');
{
  seed();
  await receive();
  const r = await issue({ TicketID: 1, ItemID: 1, Quantity: 999, SalePrice: 250 });
  t('issuing more parts than exist is refused', r?.success === false, r?.message);
  t('no negative stock was created',
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 50,
    'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The cost charged to a repair is the cost that left inventory');
{
  const db = seed();
  await receive();
  // A caller claiming a different cost must not be believed: the ticket would
  // be charged one figure while stock lost another, and the two never reconcile.
  await issue({ TicketID: 1, ItemID: 1, Quantity: 1, UnitCost: 999999, SalePrice: 250 });
  const part = q('SELECT UnitCost v FROM maintenance_parts');
  t('a caller-supplied cost cannot override the real one',
    Math.abs(part.v - 100) < 0.011, 'booked ' + part.v + ', stock holds 100');
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Delivering twice must not be possible');
{
  const db = seed();
  await receive();
  await issue({ TicketID: 1, ItemID: 1, Quantity: 1, SalePrice: 250 });
  await deliver({ TicketID: 1, LaborCost: 0, PaidAmount: 250, CashAccountID: 1 });
  const cash1 = q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
  const again = await deliver({ TicketID: 1, LaborCost: 0, PaidAmount: 250, CashAccountID: 1 });
  const cash2 = q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
  t('a second delivery of the same ticket is refused',
    again?.success === false, again?.message || 'ACCEPTED — money taken twice');
  t('no second payment was banked', Math.abs(cash2 - cash1) < 0.011, `${cash1} -> ${cash2}`);
}

// ---------------------------------------------------------------- 10
console.log('\n[10] A returned repair settles correctly however it was paid');
for (const [label, paid, refund] of [
  ['paid in full', 350, 350],
  ['collected later (nothing paid)', 0, 0],
  ['paid half', 175, 175],
]) {
  const db = seed();
  await receive();
  const opening = netWorth(db);
  await issue({ TicketID: 1, ItemID: 1, Quantity: 1, SalePrice: 250 });
  await deliver({ TicketID: 1, LaborCost: 100, PaidAmount: paid, CashAccountID: 1 });
  await call('maintenance:return', {
    DeliveryID: q('SELECT DeliveryID v FROM maintenance_deliveries').v,
    TicketID: 1, Reason: 'faulty', TotalRefund: refund,
    CashAccountID: refund > 0 ? 1 : undefined, PartsRestored: 1, fiscalYearId: 1,
  });
  t(`${label}: the shop ends where it started`,
    Math.abs(netWorth(db) - opening) < 0.011, `${opening} -> ${netWorth(db)}`);
  t(`${label}: the customer owes nothing afterwards`,
    Math.abs(q('SELECT Balance v FROM customers WHERE CustomerID=1').v) < 0.011,
    'balance ' + q('SELECT Balance v FROM customers WHERE CustomerID=1').v);
  t(`${label}: the parts are back on the shelf`,
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 50,
    'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);
}

// ---------------------------------------------------------------- 11
console.log('\n[11] A service line can actually be stored');
{
  // Labour and services are written to `sale_details` with no ItemID. The
  // column was declared NOT NULL on a fresh database, so every delivery carrying
  // labour threw and rolled back — a new installation could not complete a paid
  // repair at all.
  const col = currentDb().prepare('PRAGMA table_info(sale_details)').all()
    .find(c => c.name === 'ItemID');
  t('sale_details.ItemID allows NULL on a fresh database',
    col && col.notnull === 0, 'notnull = ' + col?.notnull);

  const db = seed();
  await receive();
  const d = await deliver({ TicketID: 1, LaborCost: 120, PaidAmount: 120, CashAccountID: 1 });
  t('a labour-only repair can be delivered', d?.success === true, d?.message);
  t('the labour line reached the invoice',
    q("SELECT COUNT(*) v FROM sale_details WHERE ItemID IS NULL").v === 1,
    'service lines ' + q('SELECT COUNT(*) v FROM sale_details WHERE ItemID IS NULL').v);
}

// ---------------------------------------------------------------- 12
console.log('\n[12] A discounted repair produces a self-consistent invoice');
{
  const db = seed();
  await receive();
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  await deliver({ TicketID: 1, LaborCost: 100, Discount: 100, PaidAmount: 500, CashAccountID: 1 });
  const inv = q('SELECT Subtotal, Discount, TotalAmount FROM sales');
  t('Subtotal minus Discount equals the invoice total',
    Math.abs((inv.Subtotal - inv.Discount) - inv.TotalAmount) < 0.011,
    `${inv.Subtotal} - ${inv.Discount} != ${inv.TotalAmount}`);
  const lines = q('SELECT ROUND(COALESCE(SUM(Total),0),2) v FROM sale_details').v;
  t('the printed lines add up to the Subtotal',
    Math.abs(lines - inv.Subtotal) < 0.011, `lines ${lines} vs subtotal ${inv.Subtotal}`);
}

// ---------------------------------------------------------------- 13
console.log('\n[13] Negative money is refused on delivery');
{
  seed();
  await receive();
  const neg = await deliver({ TicketID: 1, LaborCost: -500, PaidAmount: 0 });
  t('negative labour is refused', neg?.success === false, neg?.message);
  const negPaid = await deliver({ TicketID: 1, LaborCost: 0, PaidAmount: -100 });
  t('a negative payment is refused', negPaid?.success === false, negPaid?.message);
  t('the ticket was not charged anything',
    Math.abs(q('SELECT TotalCost v FROM maintenance_tickets').v) < 0.011,
    'TotalCost ' + q('SELECT TotalCost v FROM maintenance_tickets').v);
}

// ---------------------------------------------------------------- 14
console.log('\n[14] The reports agree with each other about a repair');
for (const [label, warranty] of [['a paid repair', false], ['a warranty repair', true]]) {
  const db = seed();
  currentDb().exec("INSERT OR REPLACE INTO settings(Key,Value) VALUES('owner_capital','155000')");
  await receive(warranty ? { MaintenanceType: 'warranty' } : {});
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  await deliver({ TicketID: 1, LaborCost: 100, PaidAmount: warranty ? 0 : 600, CashAccountID: 1 });

  const pl = await call('reports:profitLoss', {});
  const fp = await call('reports:financialPosition');
  // Compared on NET profit, not gross.
  //
  // Warranty parts are an operating EXPENSE, not a cost of sales — a warranty
  // repair earns nothing, so charging its parts against gross margin would
  // understate the margin on the repairs that did earn something. The balance
  // sheet's `netProfit` is after expenses, so gross is the wrong figure to
  // compare and my first version of this check failed for that reason, not
  // because the reports disagreed.
  const plNet = pl.netProfit ?? pl.grossProfit;
  t(`${label}: the profit report and the balance sheet agree`,
    Math.abs(plNet - fp.capital.netProfit) < 0.011,
    `P&L net ${plNet} vs balance sheet ${fp.capital.netProfit}`);
  t(`${label}: the balance sheet balances`,
    Math.abs(fp.capital.difference) < 0.011, 'difference ' + fp.capital.difference);
  t(`${label}: the mirror invoice is not counted as a direct sale`,
    Math.abs(pl.revenue.salesGross) < 0.011,
    'salesGross ' + pl.revenue.salesGross + ' (repairs belong in revenue.maintenance)');
}

// ---------------------------------------------------------------- 15
console.log('\n[15] Warranty parts are an expense, not a cost of sales');
{
  const db = seed();
  await receive({ MaintenanceType: 'warranty' });
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  await deliver({ TicketID: 1, LaborCost: 0, PaidAmount: 0 });
  const pl = await call('reports:profitLoss', {});
  // A warranty repair earns nothing, so charging its parts to cost of sales
  // would understate gross margin on the sales that DID earn something.
  t('the parts given away are charged as a warranty expense',
    Math.abs((pl.expenses?.warrantyParts ?? pl.warrantyExpense ?? 0) - 200) < 0.011,
    'warranty expense ' + (pl.expenses?.warrantyParts ?? pl.warrantyExpense));
  t('they are NOT also charged to cost of sales',
    Math.abs(pl.costs.parts) < 0.011, 'costs.parts ' + pl.costs.parts);
}

// ---------------------------------------------------------------- 16
console.log('\n[16] Deleting a delivery must not reverse the same debt twice');
// `delete:maintenanceDelivery` had never been executed by any test. It moves
// money in seven places, and `maintenance:deliver` writes the customer's debt
// in TWO records: the delivery, and a MIRROR `sales` row that exists only to
// print an invoice. The delete reversed both, so cancelling a repair left the
// shop owing the customer the very amount they had owed the shop.
//
// Every payment shape is covered, because the first probe used a fully-paid
// repair and passed — the fault only shows when something is still owed.
for (const [label, paid, labour] of [
  ['unpaid on credit', 0, 500],
  ['partly paid', 500, 500],
  ['paid in full', 800, 500],
]) {
  const db = seed();
  await receive();
  await issue({ TicketID: 1, ItemID: 1, Quantity: 2, SalePrice: 250 });
  const opening = netWorth(db);
  const custBefore = q('SELECT Balance v FROM customers WHERE CustomerID=1').v;
  await deliver({ TicketID: 1, LaborCost: labour, PaidAmount: paid, CashAccountID: 1 });
  const res = await call('delete:maintenanceDelivery',
    q('SELECT DeliveryID v FROM maintenance_deliveries').v);

  t(`${label}: the delete succeeds`, res?.success === true, JSON.stringify(res));
  t(`${label}: net worth returns to where it was`,
    Math.abs(netWorth(db) - opening) < 0.011,
    `${opening} -> ${netWorth(db)} (moved ${r2(netWorth(db) - opening)})`);
  t(`${label}: the customer owes exactly what they did before`,
    Math.abs(q('SELECT Balance v FROM customers WHERE CustomerID=1').v - custBefore) < 0.011,
    `${custBefore} -> ${q('SELECT Balance v FROM customers WHERE CustomerID=1').v}`);
  t(`${label}: no customer is left with a phantom credit`,
    q('SELECT COUNT(*) v FROM customers WHERE Balance < -0.005').v === 0,
    'a cancelled repair must never make the shop a debtor');
  t(`${label}: the cash drawer is back to its opening figure`,
    Math.abs(q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v - 100000) < 0.011,
    'cash ' + q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v);
  t(`${label}: the mirror invoice is gone`,
    q('SELECT COUNT(*) v FROM sales').v === 0);
  t(`${label}: the parts are NOT credited back to stock a second time`,
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v === 48,
    'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1').v);
  t(`${label}: the ticket is reopened so it can be delivered again`,
    q('SELECT Status v FROM maintenance_tickets WHERE TicketID=1').v === 'ready');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
