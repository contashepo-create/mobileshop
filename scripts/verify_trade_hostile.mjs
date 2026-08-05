#!/usr/bin/env node
/**
 * ADVERSARIAL input testing for sales, purchases and their returns.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every earlier suite sent WELL-FORMED payloads: sensible quantities, real
 * item ids, numbers where numbers belong. That tests the happy path and the
 * arithmetic, but the IPC channel is reachable by anything the renderer sends,
 * and the renderer is not a trust boundary. A tampered or simply buggy caller
 * can send a negative quantity, a string where a number belongs, an item that
 * does not exist, a customer belonging to nobody, or the same line twice.
 *
 * The rule being tested is simple and absolute:
 *
 *   a malformed request must be REFUSED, and must leave the books EXACTLY as
 *   they were — no half-written invoice, no stock moved, no balance touched.
 *
 * A handler that throws is acceptable only if the transaction rolled back. A
 * handler that "succeeds" on nonsense, or that writes something before
 * failing, is a defect.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_hostile.mjs
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
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1),(2,'Closed','safe',500,0)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active'),(2,'Stopped',0,'suspended')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','accessory',0,10,20,1),(2,'Phone','phone',0,600,1000,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10),(2,1,20,600)");
  return db;
}

/** Everything that must not move when a request is refused. */
function snapshot() {
  const d = currentDb();
  const g = q => d.prepare(q).get()?.v ?? 0;
  return JSON.stringify({
    cash: g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts'),
    wallet: g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods'),
    cust: g('SELECT COALESCE(SUM(Balance),0) v FROM customers'),
    supp: g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers'),
    stockQty: g('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities'),
    stockVal: g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities'),
    sales: g('SELECT COUNT(*) v FROM sales'),
    saleLines: g('SELECT COUNT(*) v FROM sale_details'),
    purchases: g('SELECT COUNT(*) v FROM purchases'),
    purchaseLines: g('SELECT COUNT(*) v FROM purchase_details'),
    saleReturns: g('SELECT COUNT(*) v FROM sale_returns'),
    purchaseReturns: g('SELECT COUNT(*) v FROM purchase_returns'),
  });
}

/**
 * Sends a hostile payload and asserts BOTH that it was refused and that the
 * books are byte-for-byte unchanged. Rejecting but leaving a half-written
 * invoice behind is still a defect, and only the second half of the assertion
 * can catch it.
 */
async function refuses(label, channel, payload) {
  const before = snapshot();
  let res, threw = null;
  try {
    res = await call(channel, payload);
  } catch (err) {
    threw = err;
  }
  const after = snapshot();
  const refused = threw !== null || res?.success === false;
  const untouched = before === after;

  t(label, refused && untouched,
    !refused ? `ACCEPTED: ${JSON.stringify(res)}`
      : !untouched ? `refused but the books MOVED:\n        before ${before}\n        after  ${after}`
      : (threw ? 'threw (rolled back)' : String(res?.message ?? '').slice(0, 110)));
}

const BASE_SALE = {
  CustomerID: 1, Discount: 0, TaxRate: 0, TaxAmount: 0,
  PaymentMethod: 'cash', PaidAmount: 0, fiscalYearId: 1,
};
const BASE_PURCHASE = {
  SupplierID: 1, Discount: 0, TaxAmount: 0, PaidAmount: 0,
  AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1,
};

console.log('HOSTILE INPUT — SALES, PURCHASES AND RETURNS\n');

// ---------------------------------------------------------------- 1
console.log('[1] sales:create — malformed quantities and prices');
seed();
await refuses('a negative quantity is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: -5, UnitPrice: 20 }] });
await refuses('a zero quantity is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 0, UnitPrice: 20 }] });
await refuses('a NaN quantity is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: NaN, UnitPrice: 20 }] });
await refuses('an Infinity quantity is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: Infinity, UnitPrice: 20 }] });
await refuses('a non-numeric quantity is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 'many', UnitPrice: 20 }] });
await refuses('a negative price is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: -20 }] });
await refuses('an Infinity price is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: Infinity }] });
await refuses('a null item list is refused', 'sales:create',
  { ...BASE_SALE, items: null });
await refuses('an empty item list is refused', 'sales:create',
  { ...BASE_SALE, items: [] });

// ---------------------------------------------------------------- 2
console.log('\n[2] sales:create — malformed money');
seed();
await refuses('a negative discount is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], Discount: -50 });
await refuses('a discount larger than the goods is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], Discount: 500 });
await refuses('a negative payment is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], PaidAmount: -100 });
await refuses('a NaN payment is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], PaidAmount: NaN });
await refuses('a negative tax is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], TaxAmount: -5 });

// ---------------------------------------------------------------- 3
console.log('\n[3] sales:create — money with no valid destination');
seed();
await refuses('paying into a non-existent cash account is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    PaidAmount: 20, CashAccountID: 9999 });
await refuses('paying into a DEACTIVATED cash account is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    PaidAmount: 20, CashAccountID: 2 });
await refuses('paying into a non-existent machine is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    PaidAmount: 20, PaymentMethodID: 9999 });
await refuses('taking money with no destination at all is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], PaidAmount: 20 });

// ---------------------------------------------------------------- 4
console.log('\n[4] sales:create — parties and items that do not exist');
seed();
await refuses('selling to a SUSPENDED customer is refused', 'sales:create',
  { ...BASE_SALE, CustomerID: 2, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }] });
await refuses('selling an item that does not exist is refused', 'sales:create',
  { ...BASE_SALE, items: [{ ItemID: 9999, Quantity: 1, UnitPrice: 20 }] });

// ---------------------------------------------------------------- 5
console.log('\n[5] purchases:create — malformed input');
seed();
await refuses('a negative quantity is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: -5, UnitCost: 10, WarehouseID: 1 }] });
await refuses('a zero quantity is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 0, UnitCost: 10, WarehouseID: 1 }] });
await refuses('a NaN cost is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: NaN, WarehouseID: 1 }] });
await refuses('a negative cost is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: -10, WarehouseID: 1 }] });
await refuses('a missing warehouse is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10 }] });
await refuses('a non-existent warehouse is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10, WarehouseID: 9999 }] });
await refuses('a negative extra cost is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10, WarehouseID: 1 }],
    AdditionalCost: -100 });
await refuses('paying from a non-existent account is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10, WarehouseID: 1 }],
    PaidAmount: 10, PaymentSourceType: 'cash_account', PaymentSourceID: 9999 });
await refuses('paying more than the drawer holds is refused', 'purchases:create',
  { ...BASE_PURCHASE, items: [{ ItemID: 1, Quantity: 1, UnitCost: 999999, WarehouseID: 1 }],
    PaidAmount: 999999, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });

// ---------------------------------------------------------------- 6
console.log('\n[6] saleReturns:create — against a real invoice');
seed();
await call('sales:create', { ...BASE_SALE,
  items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
  PaidAmount: 100, CashAccountID: 1 });
const SID = currentDb().prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get().v;

await refuses('returning more than was sold is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 1, Quantity: 99, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 1980, CashAccountID: 1 });
await refuses('a negative return quantity is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 1, Quantity: -1, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 0 });
await refuses('returning an item that is not on the invoice is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 2, Quantity: 1, UnitPrice: 1000 }],
    AccountCredit: 0, CashRefund: 1000, CashAccountID: 1 });
await refuses('a return against a non-existent invoice is refused', 'saleReturns:create',
  { SaleID: 9999, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 20, CashAccountID: 1 });
await refuses('a settlement that does not add up is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 500, CashRefund: 500, CashAccountID: 1 });
await refuses('a NEGATIVE refund leg is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 40, CashRefund: -20, CashAccountID: 1 });
await refuses('refunding cash into a non-existent drawer is refused', 'saleReturns:create',
  { SaleID: SID, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 20, CashAccountID: 9999 });

// The caller must not be able to dictate the price it is refunded at.
const priceProbe = await call('saleReturns:create', {
  SaleID: SID, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 999999 }],
  AccountCredit: 20, CashRefund: 0,
});
const wrote = currentDb().prepare(
  'SELECT TotalAmount v FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').get()?.v;
t('the refund price comes from the INVOICE, not the caller',
  !priceProbe?.success || Math.abs((wrote ?? 0) - 20) < 0.011,
  `caller asked 999999, recorded ${wrote}`);

// ---------------------------------------------------------------- 7
console.log('\n[7] purchaseReturns:create — against a real purchase');
seed();
await call('purchases:create', { ...BASE_PURCHASE,
  items: [{ ItemID: 1, Quantity: 10, UnitCost: 10, WarehouseID: 1 }] });
const PID = currentDb().prepare('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').get().v;

await refuses('returning more than was bought is refused', 'purchaseReturns:create',
  { PurchaseID: PID, items: [{ ItemID: 1, Quantity: 99, UnitCost: 10 }],
    AccountCredit: 990, CashRefund: 0 });
await refuses('a negative return quantity is refused', 'purchaseReturns:create',
  { PurchaseID: PID, items: [{ ItemID: 1, Quantity: -3, UnitCost: 10 }],
    AccountCredit: 0, CashRefund: 0 });
await refuses('returning an item not on the purchase is refused', 'purchaseReturns:create',
  { PurchaseID: PID, items: [{ ItemID: 2, Quantity: 1, UnitCost: 600 }],
    AccountCredit: 600, CashRefund: 0 });
await refuses('a return against a non-existent purchase is refused', 'purchaseReturns:create',
  { PurchaseID: 9999, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10 }],
    AccountCredit: 10, CashRefund: 0 });
await refuses('a settlement that does not add up is refused', 'purchaseReturns:create',
  { PurchaseID: PID, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10 }],
    AccountCredit: 900, CashRefund: 900 });

// The supplier's credit must come from the purchase, not the payload.
const costProbe = await call('purchaseReturns:create', {
  PurchaseID: PID, items: [{ ItemID: 1, Quantity: 1, UnitCost: 999999 }],
  AccountCredit: 10, CashRefund: 0,
});
const wrote2 = currentDb().prepare(
  'SELECT TotalAmount v FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').get()?.v;
t('the credit comes from the PURCHASE, not the caller',
  !costProbe?.success || Math.abs((wrote2 ?? 0) - 10) < 0.011,
  `caller asked 999999, recorded ${wrote2}`);

// ---------------------------------------------------------------- 8
console.log('\n[8] Deleting documents that do not exist');
seed();
for (const ch of ['delete:sale', 'delete:purchase', 'delete:saleReturn', 'delete:purchaseReturn']) {
  const before = snapshot();
  let res, threw = null;
  try { res = await call(ch, 999999); } catch (e) { threw = e; }
  t(`${ch} on a missing id is refused cleanly`,
    (threw !== null || res?.success === false) && before === snapshot(),
    threw ? 'threw' : String(res?.message ?? '').slice(0, 80));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
