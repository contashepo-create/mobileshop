#!/usr/bin/env node
/**
 * METAMORPHIC testing for sales, purchases and returns.
 *
 * WHY THIS METHOD, AFTER ALL THE OTHERS
 * -------------------------------------
 * Every previous suite needed to know the RIGHT ANSWER in advance: the fuzzer
 * checks invariants, the ledger model recomputes the expected figures, the
 * report suite compares reports against each other. All of them can only catch
 * a fault the author was able to describe.
 *
 * A metamorphic test needs no expected answer. It states that two DIFFERENT
 * routes to the same economic position must leave the books in the same state:
 *
 *     selling 5 on one line   ==  selling 3 and then 2
 *     returning 4 at once     ==  returning 2 twice
 *     buying then deleting    ==  never having bought
 *
 * Nobody has to know what the closing stock value should be. If the two routes
 * disagree, one of them is wrong — and the difference points straight at it.
 * This finds faults in paths the author never thought to model, which is
 * exactly the class of bug that survived every earlier round.
 *
 * The comparison is a FULL snapshot of every table that carries value, so a
 * discrepancy anywhere is caught, not only in the figures a test happened to
 * name.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_metamorphic.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};

/** Rounds to the piastre so IEEE-754 dust does not masquerade as a difference. */
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Everything that carries value, in a stable order.
 *
 * Deliberately NOT a list of totals: comparing totals would hide two errors
 * that cancel. Document numbers and ids are excluded because the two routes
 * legitimately create different numbers of documents — what must match is the
 * MONEY and the GOODS.
 */
function snapshot(db) {
  const all = sql => db.prepare(sql).all();
  return {
    cash: all('SELECT CashAccountID, ROUND(Balance,2) v FROM cash_accounts ORDER BY CashAccountID'),
    wallets: all('SELECT PaymentMethodID, ROUND(Balance,2) v FROM payment_methods ORDER BY PaymentMethodID'),
    customers: all('SELECT CustomerID, ROUND(Balance,2) v FROM customers ORDER BY CustomerID'),
    suppliers: all('SELECT SupplierID, ROUND(Balance,2) v FROM suppliers ORDER BY SupplierID'),
    stockQty: all('SELECT ItemID, WarehouseID, ROUND(Quantity,4) v FROM stock_quantities ORDER BY ItemID, WarehouseID'),
    stockValue: all('SELECT ItemID, WarehouseID, ROUND(Quantity*CostPrice,2) v FROM stock_quantities ORDER BY ItemID, WarehouseID'),
    serials: all("SELECT IMEI, Status, ROUND(CostPrice,2) v FROM item_serials ORDER BY IMEI"),
    adjustments: [{ v: r2(db.prepare('SELECT COALESCE(SUM(Amount),0) v FROM inventory_adjustments').get().v) }],
  };
}

/** Net worth measured straight from the balances — no model, no assumptions. */
function netWorth(db) {
  const g = q => db.prepare(q).get()?.v ?? 0;
  return r2(
    g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance>0')
    + g('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance<0')
    - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance>0')
    - g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance<0'),
  );
}

function diff(a, b) {
  const out = [];
  for (const key of Object.keys(a)) {
    const x = JSON.stringify(a[key]), y = JSON.stringify(b[key]);
    if (x !== y) out.push(`${key}:\n          A ${x}\n          B ${y}`);
  }
  return out;
}

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',50000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active'),(2,'B',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','accessory',0,10,20,1),(2,'Phone','phone',0,600,1000,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10),(2,1,20,600)");
  return db;
}

/** Runs `steps` against a fresh database and returns the closing snapshot. */
async function run(steps) {
  const db = seed();
  await steps(db);
  return { snap: snapshot(db), worth: netWorth(db), db };
}

/** Asserts two routes leave identical books. */
async function metamorphic(name, routeA, routeB) {
  const A = await run(routeA);
  const B = await run(routeB);
  const d = diff(A.snap, B.snap);
  t(name, d.length === 0 && A.worth === B.worth,
    d.length ? d.join('\n        ')
             : (A.worth !== B.worth ? `net worth A ${A.worth} vs B ${B.worth}` : ''));
}

const sale = (o) => call('sales:create', {
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', fiscalYearId: 1, ...o,
});
const purchase = (o) => call('purchases:create', {
  Discount: 0, TaxAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1, ...o,
});
const lastSale = db => db.prepare('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').get()?.v;
const lastPurchase = db => db.prepare('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').get()?.v;
const lastSaleReturn = db => db.prepare('SELECT ReturnID v FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').get()?.v;
const lastPurchaseReturn = db => db.prepare('SELECT ReturnID v FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').get()?.v;

console.log('METAMORPHIC RELATIONS — two routes, one position\n');

// ---------------------------------------------------------------- 1
console.log('[1] Splitting a sale across lines must not change the books');
await metamorphic(
  'selling 5 on one line == selling 3 then 2 on two lines of one invoice',
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
      PaidAmount: 100, CashAccountID: 1 });
  },
  async () => {
    await sale({ CustomerID: 1, items: [
      { ItemID: 1, Quantity: 3, UnitPrice: 20 },
      { ItemID: 1, Quantity: 2, UnitPrice: 20 },
    ], PaidAmount: 100, CashAccountID: 1 });
  },
);

// ---------------------------------------------------------------- 2
console.log('\n[2] Splitting a return must not change the books');
await metamorphic(
  'returning 4 at once == returning 2 twice',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
      PaidAmount: 80, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
      AccountCredit: 0, CashRefund: 80, CashAccountID: 1 });
  },
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
      PaidAmount: 80, CashAccountID: 1 });
    const sid = lastSale(db);
    await call('saleReturns:create', { SaleID: sid,
      items: [{ ItemID: 1, Quantity: 2, UnitPrice: 20 }],
      AccountCredit: 0, CashRefund: 40, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: sid,
      items: [{ ItemID: 1, Quantity: 2, UnitPrice: 20 }],
      AccountCredit: 0, CashRefund: 40, CashAccountID: 1 });
  },
);

// ---------------------------------------------------------------- 3
console.log('\n[3] A full return must undo the sale exactly');
await metamorphic(
  'sell then return everything == never having sold',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 2, Quantity: 3, UnitPrice: 1000 }],
      PaidAmount: 3000, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 2, Quantity: 3, UnitPrice: 1000 }],
      AccountCredit: 0, CashRefund: 3000, CashAccountID: 1 });
  },
  async () => { /* do nothing at all */ },
);

// ---------------------------------------------------------------- 4
console.log('\n[4] Deleting a purchase must undo it exactly');
await metamorphic(
  'buy then delete == never having bought',
  async (db) => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 30, UnitCost: 12, WarehouseID: 1 }],
      PaidAmount: 360, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    await call('delete:purchase', lastPurchase(db));
  },
  async () => { /* nothing */ },
);

// ---------------------------------------------------------------- 5
console.log('\n[5] Cancelling a debit note must undo it exactly');
await metamorphic(
  'buy, return to supplier, cancel that return == just buying',
  async (db) => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 20, UnitCost: 11, WarehouseID: 1 }],
      PaidAmount: 220, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    await call('purchaseReturns:create', { PurchaseID: lastPurchase(db),
      items: [{ ItemID: 1, Quantity: 8, UnitCost: 11 }],
      AccountCredit: 0, CashRefund: 88, CashAccountID: 1 });
    await call('delete:purchaseReturn', lastPurchaseReturn(db));
  },
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 20, UnitCost: 11, WarehouseID: 1 }],
      PaidAmount: 220, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
  },
);

// ---------------------------------------------------------------- 6
console.log('\n[6] Cancelling a credit note must undo it exactly');
await metamorphic(
  'sell, return, cancel the return == just selling',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 2, Quantity: 2, UnitPrice: 950 }],
      PaidAmount: 1900, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 2, Quantity: 2, UnitPrice: 950 }],
      AccountCredit: 0, CashRefund: 1900, CashAccountID: 1 });
    await call('delete:saleReturn', lastSaleReturn(db));
  },
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 2, Quantity: 2, UnitPrice: 950 }],
      PaidAmount: 1900, CashAccountID: 1 });
  },
);

// ---------------------------------------------------------------- 7
console.log('\n[7] Order of independent operations must not matter');
await metamorphic(
  'sell to A then buy == buy then sell to A',
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 25 }],
      PaidAmount: 125, CashAccountID: 1 });
    await purchase({ SupplierID: 1, items: [{ ItemID: 2, Quantity: 4, UnitCost: 620, WarehouseID: 2 }],
      PaidAmount: 0 });
  },
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 2, Quantity: 4, UnitCost: 620, WarehouseID: 2 }],
      PaidAmount: 0 });
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 25 }],
      PaidAmount: 125, CashAccountID: 1 });
  },
);

// ---------------------------------------------------------------- 8
console.log('\n[8] An edit must equal a delete followed by a re-issue');
await metamorphic(
  'edit an invoice == the invoice issued that way from the start',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 20 }],
      PaidAmount: 40, CashAccountID: 1 });
    await call('sales:update', { SaleID: lastSale(db), CustomerID: 1,
      items: [{ ItemID: 1, Quantity: 7, UnitPrice: 22 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0,
      PaymentMethod: 'cash', PaidAmount: 154, CashAccountID: 1 });
  },
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 7, UnitPrice: 22 }],
      PaidAmount: 154, CashAccountID: 1 });
  },
);

// ---------------------------------------------------------------- 9
console.log('\n[9] A discount must reach the books the same way however it is expressed');
await metamorphic(
  '10 units at 100 less 200 discount == 10 units priced at 80',
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 100 }],
      Discount: 200, PaidAmount: 800, CashAccountID: 1 });
  },
  async () => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 80 }],
      PaidAmount: 800, CashAccountID: 1 });
  },
);

// The pair above compares two SALES, and a sale writes the discount into the
// header either way — so it passes even if the discount is dropped when the
// goods come BACK. Verified by injecting exactly that fault: the pair above
// stayed green. A discount only proves itself on the return leg, so the same
// relation is repeated with the goods returned.
await metamorphic(
  'returning discounted goods refunds the same as returning cheaper goods',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 100 }],
      Discount: 200, PaidAmount: 800, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 1, Quantity: 8, UnitPrice: 100 }],
      AccountCredit: 0, CashRefund: 640, CashAccountID: 1 });
  },
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 80 }],
      PaidAmount: 800, CashAccountID: 1 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 1, Quantity: 8, UnitPrice: 80 }],
      AccountCredit: 0, CashRefund: 640, CashAccountID: 1 });
  },
);

// The same on the buying side: a supplier discount must follow the goods back.
await metamorphic(
  'returning discounted purchases credits the same as returning cheaper ones',
  async (db) => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 100, WarehouseID: 1 }],
      Discount: 200, PaidAmount: 0 });
    await call('purchaseReturns:create', { PurchaseID: lastPurchase(db),
      items: [{ ItemID: 1, Quantity: 6, UnitCost: 100 }], AccountCredit: 480, CashRefund: 0 });
  },
  async (db) => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 80, WarehouseID: 1 }],
      PaidAmount: 0 });
    await call('purchaseReturns:create', { PurchaseID: lastPurchase(db),
      items: [{ ItemID: 1, Quantity: 6, UnitCost: 80 }], AccountCredit: 480, CashRefund: 0 });
  },
);

// ---------------------------------------------------------------- 10
console.log('\n[10] Paying in parts must equal paying at once');
await metamorphic(
  'a credit sale settled by two returns == one return of the same total',
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 6, UnitPrice: 30 }],
      PaymentMethod: 'credit', PaidAmount: 0 });
    const sid = lastSale(db);
    await call('saleReturns:create', { SaleID: sid,
      items: [{ ItemID: 1, Quantity: 3, UnitPrice: 30 }], AccountCredit: 90, CashRefund: 0 });
    await call('saleReturns:create', { SaleID: sid,
      items: [{ ItemID: 1, Quantity: 3, UnitPrice: 30 }], AccountCredit: 90, CashRefund: 0 });
  },
  async (db) => {
    await sale({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 6, UnitPrice: 30 }],
      PaymentMethod: 'credit', PaidAmount: 0 });
    await call('saleReturns:create', { SaleID: lastSale(db),
      items: [{ ItemID: 1, Quantity: 6, UnitPrice: 30 }], AccountCredit: 180, CashRefund: 0 });
  },
);

// ---------------------------------------------------------------- 11
console.log('\n[11] Buying in one delivery must equal buying in two');
await metamorphic(
  'one purchase of 20 at 10 == two purchases of 10 at 10',
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 20, UnitCost: 10, WarehouseID: 1 }],
      PaidAmount: 0 });
  },
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
      PaidAmount: 0 });
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
      PaidAmount: 0 });
  },
);

// ---------------------------------------------------------------- 12
console.log('\n[12] Freight must land on the goods however the delivery is split');
await metamorphic(
  'one purchase of 20 with 100 freight == two of 10 with 50 freight each',
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 20, UnitCost: 10, WarehouseID: 1 }],
      AdditionalCost: 100, PaidAmount: 0 });
  },
  async () => {
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
      AdditionalCost: 50, PaidAmount: 0 });
    await purchase({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
      AdditionalCost: 50, PaidAmount: 0 });
  },
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
