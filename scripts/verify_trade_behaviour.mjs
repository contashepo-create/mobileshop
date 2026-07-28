#!/usr/bin/env node
/**
 * Behavioural tests for sales, sale returns, purchases and purchase returns.
 *
 * These call the REAL handlers through `scripts/lib/handlerHarness.mjs` and
 * then read the resulting database. Nothing here reimplements the logic and
 * nothing matches strings against the source — the previous audits did both,
 * which is why each re-reading uncovered a defect the last one missed.
 *
 * Run with:
 *   node --experimental-strip-types scripts/verify_trade_behaviour.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

const PASS = [], FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail && !ok) console.log(`          ${String(detail).split('\n').join('\n          ')}`);
}

function checkVerbose(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${String(detail).split('\n').join('\n          ')}`);
}

const r2 = n => Math.round((n || 0) * 100) / 100;

/** Fresh database + seed data, so every scenario starts from a known state. */
async function reset() {
  const db = buildDatabase();
  const x = sql => db.exec(sql);
  x(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'admin',1)`);
  x(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)`);
  x(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status)
     VALUES(1,'2026','2026-01-01','2026-12-31','open')`);
  x(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')`);
  x(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive)
     VALUES(1,'Safe','safe',100000,1),(2,'Closed','safe',0,0)`);
  x(`INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive)
     VALUES(1,'Wallet','wallet',50000,1)`);
  x(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')`);
  x(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Supp',0,'active')`);
  x(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive)
     VALUES(1,'Cable','part',0,10,20,1),(2,'Phone','device',0,600,1000,1)`);
  x(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice)
     VALUES(1,1,100,10),(2,1,10,600)`);
  return db;
}

const q1 = (sql, ...a) => currentDb().prepare(sql).get(...a);
const qa = (sql, ...a) => currentDb().prepare(sql).all(...a);
const stock = (item, wh = 1) =>
  q1('SELECT Quantity, CostPrice FROM stock_quantities WHERE ItemID=? AND WarehouseID=?', item, wh);
const cash = id => q1('SELECT Balance FROM cash_accounts WHERE CashAccountID=?', id).Balance;
const wallet = id => q1('SELECT Balance FROM payment_methods WHERE PaymentMethodID=?', id).Balance;
const cust = id => q1('SELECT Balance FROM customers WHERE CustomerID=?', id).Balance;
const supp = id => q1('SELECT Balance FROM suppliers WHERE SupplierID=?', id).Balance;

await loadHandlers();

console.log('='.repeat(74));
console.log('BEHAVIOURAL TESTS — REAL HANDLERS, REAL DATABASE');
console.log('='.repeat(74));

// ---------------------------------------------------------------- 1
console.log('\n[1] A cash sale moves stock, cash and nothing else');
{
  await reset();
  const res = await call('sales:create', {
    CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1,
    fiscalYearId: 1,
  });
  check('the sale is accepted', res?.success === true, res?.message);
  checkVerbose('stock falls by exactly the quantity sold',
    stock(1).Quantity === 95, `expected 95, got ${stock(1).Quantity}`);
  checkVerbose('cash rises by exactly the amount paid',
    cash(1) === 100100, `expected 100100, got ${cash(1)}`);
  check('a fully paid invoice leaves no debt', cust(1) === 0, `balance ${cust(1)}`);

  const line = q1('SELECT UnitCost FROM sale_details LIMIT 1');
  checkVerbose('cost of sales is taken from the warehouse, not the caller',
    line.UnitCost === 10, `UnitCost ${line.UnitCost} (warehouse cost is 10)`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Server-side validation actually rejects bad invoices');
{
  await reset();
  const base = {
    CustomerID: 1, Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 0, fiscalYearId: 1,
  };
  const cases = [
    ['negative quantity', { ...base, items: [{ ItemID: 1, Quantity: -5, UnitPrice: 20 }] }],
    ['zero quantity', { ...base, items: [{ ItemID: 1, Quantity: 0, UnitPrice: 20 }] }],
    ['negative price', { ...base, items: [{ ItemID: 1, Quantity: 1, UnitPrice: -20 }] }],
    ['empty cart', { ...base, items: [] }],
    ['discount over subtotal',
      { ...base, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], Discount: 500 }],
    ['payment to a missing account',
      { ...base, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], PaidAmount: 20, CashAccountID: 999 }],
    ['payment to an inactive account',
      { ...base, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }], PaidAmount: 20, CashAccountID: 2 }],
  ];
  for (const [label, payload] of cases) {
    const res = await call('sales:create', payload);
    check(`${label} is rejected`, res?.success === false, JSON.stringify(res));
  }
  checkVerbose('no stock moved during any rejected attempt',
    stock(1).Quantity === 100, `stock ${stock(1).Quantity}`);
  checkVerbose('no cash moved during any rejected attempt',
    cash(1) === 100000, `cash ${cash(1)}`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A sale return cannot invent quantities or prices');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1,
    items: [
      { ItemID: 2, Quantity: 1, UnitPrice: 1000 },
      { ItemID: 1, Quantity: 1, UnitPrice: 20 },
    ],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 1020, CashAccountID: 1,
    fiscalYearId: 1,
  });
  const saleId = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  const stockBefore = stock(1).Quantity;
  const cashBefore = cash(1);

  // Attack A: return 51 cables. Total 1020 matches the invoice total.
  const a = await call('saleReturns:create', {
    SaleID: saleId,
    items: [{ ItemID: 1, Quantity: 51, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 1020, CashAccountID: 1,
  });
  checkVerbose('returning 51 of an item sold once is refused',
    a?.success === false, a?.message);
  check('no phantom stock was created', stock(1).Quantity === stockBefore);
  check('no cash left the drawer', cash(1) === cashBefore);

  // Attack B: return 1 cable but claim it was sold for 1000.
  const b = await call('saleReturns:create', {
    SaleID: saleId,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 1000 }],
    AccountCredit: 0, CashRefund: 1000, CashAccountID: 1,
  });
  const refunded = cashBefore - cash(1);
  checkVerbose('an inflated price is ignored — the invoice price is used',
    b?.success === false || refunded === 20,
    b?.success ? `refunded ${refunded} (invoice price is 20)` : b?.message);

  // Attack C: the same line twice, each within its own cap.
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 20, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid2 = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  const before2 = stock(1).Quantity;
  const c = await call('saleReturns:create', {
    SaleID: sid2,
    items: [
      { ItemID: 1, Quantity: 1, UnitPrice: 20 },
      { ItemID: 1, Quantity: 1, UnitPrice: 20 },
    ],
    AccountCredit: 0, CashRefund: 40, CashAccountID: 1,
  });
  checkVerbose('the same line sent twice cannot exceed the cap',
    c?.success === false, c?.message);
  check('stock unchanged after the duplicate attempt', stock(1).Quantity === before2);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Return settlement: every real-world combination');
{
  // (a) walk-in, paid cash, refunded cash
  await reset();
  await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  let sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  let res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 100, CashAccountID: 1,
  });
  checkVerbose('walk-in refunded fully in cash', res?.success === true, res?.message);
  checkVerbose('cash returns to its starting value',
    cash(1) === 100000, `cash ${cash(1)}`);
  check('stock is fully restored', stock(1).Quantity === 100);

  // (b) walk-in, split cash + wallet
  await reset();
  await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 60, TransferRefund: 40,
    CashAccountID: 1, PaymentMethodID: 1,
  });
  checkVerbose('walk-in refunded 60 cash + 40 wallet', res?.success === true, res?.message);
  checkVerbose('cash fell by 60 and the wallet by 40',
    cash(1) === 100040 && wallet(1) === 49960,
    `cash ${cash(1)} (want 100040), wallet ${wallet(1)} (want 49960)`);

  // (c) walk-in cannot be credited to an account
  await reset();
  await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 100, CashRefund: 0,
  });
  checkVerbose('a walk-in cannot be given account credit',
    res?.success === false, res?.message);

  // (d) registered, fully paid, value left on account
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 100, CashRefund: 0,
  });
  checkVerbose('a paid-up customer may keep the value on account',
    res?.success === true, res?.message);
  checkVerbose('the shop now owes them 100 and no cash moved',
    cust(1) === -100 && cash(1) === 100100,
    `balance ${cust(1)} (want -100), cash ${cash(1)} (want 100100)`);

  // (e) an unbalanced split is refused
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 30, CashRefund: 30, CashAccountID: 1,
  });
  checkVerbose('a split that does not add up is refused', res?.success === false, res?.message);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Returned goods re-enter at the cost they left at');
{
  await reset();
  // Sell all 100 cables at cost 10.
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 100, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 2000, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  // Restock 50 at a higher cost.
  await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 50, UnitCost: 30, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 1500,
    AdditionalCost: 0, PaymentCost: 0,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1,
  });
  check('stock is 50 at the new cost', stock(1).Quantity === 50 && stock(1).CostPrice === 30);

  // Customer returns 10 that left at cost 10.
  const res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 200, CashRefund: 0,
  });
  check('the return is accepted', res?.success === true, res?.message);
  const s = stock(1);
  const trueValue = 50 * 30 + 10 * 10;      // 1600
  checkVerbose('inventory value reflects the real mix of costs',
    Math.abs(r2(s.Quantity * s.CostPrice) - trueValue) < 0.01,
    `${s.Quantity} units @ ${r2(s.CostPrice)} = ${r2(s.Quantity * s.CostPrice)}, want ${trueValue}`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Purchases and purchase returns');
{
  await reset();
  let res = await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 100, UnitCost: 10, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 400,
    AdditionalCost: 0, PaymentCost: 0,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1,
  });
  check('the purchase is accepted', res?.success === true, res?.message);
  checkVerbose('stock rises and the supplier is owed the unpaid part',
    stock(1).Quantity === 200 && supp(1) === 600,
    `stock ${stock(1).Quantity} (want 200), supplier ${supp(1)} (want 600)`);
  checkVerbose('cash falls by what was paid', cash(1) === 99600, `cash ${cash(1)}`);

  const pid = q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;

  // Over-return is refused.
  res = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 500, UnitCost: 10 }],
    AccountCredit: 5000, CashRefund: 0,
  });
  checkVerbose('returning more than was bought is refused', res?.success === false, res?.message);

  // Inflated price is refused or ignored.
  res = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 10, UnitCost: 100 }],
    AccountCredit: 1000, CashRefund: 0,
  });
  const ret = q1('SELECT TotalAmount FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1');
  checkVerbose('an inflated cost is ignored — the purchase price is used',
    res?.success === false || (ret && ret.TotalAmount === 100),
    res?.success ? `return total ${ret?.TotalAmount} (want 100)` : res?.message);

  // A legitimate return.
  await reset();
  await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 100, UnitCost: 10, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 400,
    AdditionalCost: 0, PaymentCost: 0,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1,
  });
  const pid2 = q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
  res = await call('purchaseReturns:create', {
    PurchaseID: pid2, items: [{ ItemID: 1, Quantity: 60, UnitCost: 10 }],
    AccountCredit: 600, CashRefund: 0,
  });
  checkVerbose('a 600 return clears the whole outstanding balance',
    res?.success === true, res?.message);
  checkVerbose('stock falls by 60 and the supplier is owed nothing',
    stock(1).Quantity === 140 && supp(1) === 0,
    `stock ${stock(1).Quantity} (want 140), supplier ${supp(1)} (want 0)`);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Purchase returns leave the warehouse the goods arrived in');
{
  await reset();
  await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 20, UnitCost: 10, WarehouseID: 2 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1,
  });
  const pid = q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
  const mainBefore = stock(1, 1).Quantity;
  const res = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 20, UnitCost: 10 }],
    AccountCredit: 200, CashRefund: 0,
  });
  check('the branch return is accepted', res?.success === true, res?.message);
  checkVerbose('the branch is emptied and the main store untouched',
    stock(1, 2).Quantity === 0 && stock(1, 1).Quantity === mainBefore,
    `branch ${stock(1, 2).Quantity} (want 0), main ${stock(1, 1).Quantity} (want ${mainBefore})`);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Reversal round trips return every balance to its prior value');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  const afterSale = [stock(1).Quantity, cash(1), cust(1)];

  await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 100, CashRefund: 100, CashAccountID: 1,
  });
  const rid = q1('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
  const res = await call('delete:saleReturn', rid);
  check('the return is reversed', res?.success === true, res?.message);
  const afterUndo = [stock(1).Quantity, cash(1), cust(1)];
  checkVerbose('stock, cash and customer balance all return to their prior values',
    JSON.stringify(afterSale) === JSON.stringify(afterUndo),
    `after sale ${JSON.stringify(afterSale)}\nafter undo ${JSON.stringify(afterUndo)}`);

  const delRes = await call('delete:sale', sid);
  check('the sale can then be deleted', delRes?.success === true, delRes?.message);
  checkVerbose('everything is back to the opening position',
    stock(1).Quantity === 100 && cash(1) === 100000 && cust(1) === 0,
    `stock ${stock(1).Quantity}, cash ${cash(1)}, customer ${cust(1)}`);
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Editing an invoice re-states every balance');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  const numberBefore = q1('SELECT SaleNumber FROM sales WHERE SaleID=?', sid).SaleNumber;

  const res = await call('sales:update', {
    SaleID: sid, CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 80, CashAccountID: 1,
  });
  check('the edit is accepted', res?.success === true, res?.message);
  checkVerbose('stock reflects the NEW quantity only',
    stock(1).Quantity === 96, `expected 96, got ${stock(1).Quantity}`);
  checkVerbose('cash reflects the NEW payment only',
    cash(1) === 100080, `expected 100080, got ${cash(1)}`);
  const inv = q1('SELECT SaleNumber, TotalAmount, RemainingAmount FROM sales WHERE SaleID=?', sid);
  check('the invoice number is preserved', inv.SaleNumber === numberBefore);
  checkVerbose('the outstanding amount is recomputed',
    inv.TotalAmount === 80 && inv.RemainingAmount === 0,
    `total ${inv.TotalAmount}, remaining ${inv.RemainingAmount}`);
}

// ---------------------------------------------------------------- 10
console.log('\n[10] Returns are refused on documents that cannot have them');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;

  currentDb().exec(`UPDATE sales SET IsVoided = 1 WHERE SaleID = ${sid}`);
  let res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 20, CashRefund: 0,
  });
  checkVerbose('a voided invoice cannot be returned', res?.success === false, res?.message);

  currentDb().exec(`UPDATE sales SET IsVoided = 0, Source = 'maintenance' WHERE SaleID = ${sid}`);
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 20, CashRefund: 0,
  });
  checkVerbose('a maintenance invoice is redirected to its own screen',
    res?.success === false, res?.message);

  res = await call('saleReturns:create', {
    SaleID: 99999, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    AccountCredit: 20, CashRefund: 0,
  });
  checkVerbose('a missing invoice is rejected', res?.success === false, res?.message);
}

// ---------------------------------------------------------------- 11
console.log('\n[11] Deletion is blocked while dependent documents exist');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 40, CashAccountID: 1,
  });
  let res = await call('delete:sale', sid);
  checkVerbose('a sale with a return cannot be deleted', res?.success === false, res?.message);
  res = await call('sales:update', {
    SaleID: sid, CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 20, CashAccountID: 1,
  });
  checkVerbose('nor edited', res?.success === false, res?.message);
}

// ---------------------------------------------------------------- 12
console.log('\n[12] Partial returns accumulate correctly');
{
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 200, CashAccountID: 1, fiscalYearId: 1,
  });
  const sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;

  for (const n of [4, 4]) {
    const r = await call('saleReturns:create', {
      SaleID: sid, items: [{ ItemID: 1, Quantity: n, UnitPrice: 20 }],
      AccountCredit: 0, CashRefund: n * 20, CashAccountID: 1,
    });
    check(`returning ${n} of the remainder is accepted`, r?.success === true, r?.message);
  }
  const third = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 80, CashAccountID: 1,
  });
  checkVerbose('a third return exceeding the remaining 2 is refused',
    third?.success === false, third?.message);

  const remaining = await call('saleReturns:returnable', sid);
  const line = remaining.find(l => l.ItemID === 1);
  checkVerbose('the returnable figure reports exactly what is left',
    line?.Returnable === 2, `Returnable ${line?.Returnable} (want 2)`);
  checkVerbose('stock reflects both returns',
    stock(1).Quantity === 98, `stock ${stock(1).Quantity} (want 98)`);
}


// ---------------------------------------------------------------- 13
console.log('\n[13] Money can never be refunded that was never received');
{
  // A credit sale: the customer has paid nothing. Refunding cash here would
  // hand over the goods AND the money while the debt still stands.
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'credit', PaidAmount: 0, fiscalYearId: 1,
  });
  let sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  let res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 200, CashAccountID: 1,
  });
  checkVerbose('cash refund on an unpaid invoice is refused',
    res?.success === false, res?.message);
  checkVerbose('no cash left the drawer and the debt is untouched',
    cash(1) === 100000 && cust(1) === 200,
    `cash ${cash(1)} (want 100000), customer ${cust(1)} (want 200)`);

  // Settling it against the account instead is correct and must work.
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 200, CashRefund: 0,
  });
  checkVerbose('the same return settled on account is accepted',
    res?.success === true, res?.message);
  checkVerbose('the debt is cleared and no cash moved',
    cust(1) === 0 && cash(1) === 100000,
    `customer ${cust(1)}, cash ${cash(1)}`);

  // Partly paid: only the paid part may come back as cash.
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 50, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 200, CashAccountID: 1,
  });
  checkVerbose('refunding more cash than was paid is refused',
    res?.success === false, res?.message);
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    AccountCredit: 150, CashRefund: 50, CashAccountID: 1,
  });
  checkVerbose('150 on account + 50 cash (exactly what was paid) is accepted',
    res?.success === true, res?.message);
  checkVerbose('every balance returns to its opening value',
    cash(1) === 100000 && cust(1) === 0 && stock(1).Quantity === 100,
    `cash ${cash(1)}, customer ${cust(1)}, stock ${stock(1).Quantity}`);

  // The cap must also count refunds already given on earlier returns.
  await reset();
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, fiscalYearId: 1,
  });
  sid = q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
  await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 100, CashAccountID: 1,
  });
  res = await call('saleReturns:create', {
    SaleID: sid, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 100, CashAccountID: 1,
  });
  checkVerbose('a second return cannot refund the same cash twice',
    res?.success === false, res?.message);
  checkVerbose('only the 100 actually received was ever paid back',
    cash(1) === 100000, `cash ${cash(1)} (want 100000)`);

  // Same rule on the purchase side.
  await reset();
  await call('purchases:create', {
    SupplierID: 1, items: [{ ItemID: 1, Quantity: 100, UnitCost: 10, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0,
    AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1,
  });
  const pid = q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
  res = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 100, UnitCost: 10 }],
    AccountCredit: 0, CashRefund: 1000, CashAccountID: 1,
  });
  checkVerbose('taking cash from a supplier we never paid is refused',
    res?.success === false, res?.message);
}

// ---------------------------------------------------------------- 14
console.log('\n[14] A walk-in cannot leave owing money nobody holds');
{
  await reset();
  let res = await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 50, CashAccountID: 1, fiscalYearId: 1,
  });
  checkVerbose('an underpaid walk-in invoice is refused',
    res?.success === false, res?.message);
  checkVerbose('nothing was written',
    stock(1).Quantity === 100 && cash(1) === 100000,
    `stock ${stock(1).Quantity}, cash ${cash(1)}`);

  res = await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 250, CashAccountID: 1, fiscalYearId: 1,
  });
  checkVerbose('an overpaid walk-in invoice is refused too',
    res?.success === false, res?.message);

  res = await call('sales:create', {
    items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 200, CashAccountID: 1, fiscalYearId: 1,
  });
  checkVerbose('paying in full is accepted', res?.success === true, res?.message);
  const inv = q1('SELECT CustomerID, RemainingAmount FROM sales ORDER BY SaleID DESC LIMIT 1');
  checkVerbose('no invoice can hold a debt with no owner',
    inv.CustomerID === null && inv.RemainingAmount === 0,
    `CustomerID ${inv.CustomerID}, remaining ${inv.RemainingAmount}`);
}

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(74));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
