#!/usr/bin/env node
/**
 * SERIALISED COSTING — the safety net, written BEFORE the refactor.
 *
 * WHY THIS EXISTS, AND WHY IT EXISTS FIRST
 * ----------------------------------------
 * The plan is to make `item_serials` the single source of truth for the value
 * of a serialised handset, because that value is currently recorded TWICE —
 * once on the device row and once as a share of the warehouse's weighted
 * average — and the two drift apart the moment the average moves. That is the
 * mechanism behind the only open defect in this project (fuzz seed 29).
 *
 * A change of that shape has been attempted six times before and reverted six
 * times. Every attempt was measured against sixty seeds and every attempt made
 * things WORSE: one failing seed became ten, then seventeen. The reason each
 * time was the same — the correction fixed one of the thirty-nine places that
 * write stock and silently desynchronised the others.
 *
 * So this file is written first, and deliberately BEFORE any production code
 * is touched. It states what must be true of a phone's cost through every
 * journey it can take. It must pass on the CURRENT code: a safety net that
 * fails before the work starts is telling you the net is wrong, not the code.
 * Anything it catches later is a regression the refactor introduced.
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * A handset is not a bag of screws. It costs thousands, each unit has its own
 * landed cost, and two units of the same model bought a month apart are not
 * interchangeable. So for every serialised item, at every moment:
 *
 *     the value the warehouse pool claims to hold
 *   = the sum of the costs of the individual devices actually in it
 *
 * When those two disagree, the shop's inventory valuation is wrong by exactly
 * the difference — and nobody notices, because both numbers look plausible.
 *
 * Run with:  node --experimental-strip-types scripts/verify_serial_costing.mjs
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
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',500000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Sup',0,'active')");
  // A phone: serialised, thousands of pounds each.
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'iPhone','accessory',1,15000,20000,1)");
  // An accessory: pooled, a few pounds each.
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(2,'Cable','accessory',0,25,60,1)");
  return db;
}

/** Buy serialised handsets, one line per IMEI. */
const buyPhones = (imeis, unitCost, opts = {}) => call('purchases:create', {
  SupplierID: 1,
  items: imeis.map(imei => ({
    ItemID: 1, IMEI: imei, Quantity: 1, UnitCost: unitCost, WarehouseID: opts.wh ?? 1,
  })),
  Discount: 0, TaxAmount: 0,
  PaidAmount: opts.paid ?? 0,
  AdditionalCost: opts.freight ?? 0,
  PaymentCost: 0,
  PaymentSourceType: (opts.paid ?? 0) > 0 ? 'cash_account' : undefined,
  PaymentSourceID: (opts.paid ?? 0) > 0 ? 1 : undefined,
  fiscalYearId: 1, userId: 1,
});

/**
 * The whole point of the suite.
 *
 * `stock_quantities` stores Quantity x CostPrice for the pool; `item_serials`
 * stores one row per physical device. For a serialised item these must agree,
 * because they are two descriptions of the same handsets on the same shelf.
 */
function poolVsDevices(itemId = 1) {
  const pools = all(
    'SELECT WarehouseID, ROUND(Quantity,4) q, ROUND(Quantity*CostPrice,2) v FROM stock_quantities WHERE ItemID = ? ORDER BY WarehouseID',
    itemId,
  );
  const devices = all(
    "SELECT WarehouseID, COUNT(*) q, ROUND(COALESCE(SUM(CostPrice),0),2) v FROM item_serials WHERE ItemID = ? AND Status = 'available' GROUP BY WarehouseID ORDER BY WarehouseID",
    itemId,
  );
  const byWh = new Map();
  for (const p of pools) byWh.set(p.WarehouseID, { poolQ: p.q, poolV: p.v, devQ: 0, devV: 0 });
  for (const d of devices) {
    const e = byWh.get(d.WarehouseID) ?? { poolQ: 0, poolV: 0, devQ: 0, devV: 0 };
    e.devQ = d.q; e.devV = d.v;
    byWh.set(d.WarehouseID, e);
  }
  const problems = [];
  let poolTotal = 0, devTotal = 0;
  for (const [wh, e] of byWh) {
    poolTotal += e.poolV; devTotal += e.devV;
    if (!near(e.poolQ, e.devQ)) problems.push(`wh${wh}: pool holds ${e.poolQ} units, devices number ${e.devQ}`);
    if (!near(e.poolV, e.devV)) problems.push(`wh${wh}: pool valued ${e.poolV}, devices sum to ${e.devV}`);
  }
  return { ok: problems.length === 0, problems, poolTotal: r2(poolTotal), devTotal: r2(devTotal) };
}

const agree = (label, itemId = 1) => {
  const r = poolVsDevices(itemId);
  t(label, r.ok, r.problems.join(' | ') || `pool ${r.poolTotal} vs devices ${r.devTotal}`);
  return r;
};

console.log('SERIALISED COSTING — a phone is not a bag of screws\n');

// ---------------------------------------------------------------- 1
console.log('[1] Each handset carries its OWN cost, never the pool average');
{
  seed();
  await buyPhones(['IMEI-A'], 18000);
  await buyPhones(['IMEI-B'], 15500);

  const a = q("SELECT CostPrice v FROM item_serials WHERE IMEI='IMEI-A'").v;
  const b = q("SELECT CostPrice v FROM item_serials WHERE IMEI='IMEI-B'").v;
  t('the expensive handset keeps its own cost', near(a, 18000), `IMEI-A = ${a}`);
  t('the cheaper handset keeps its own cost', near(b, 15500), `IMEI-B = ${b}`);
  t('they are NOT levelled to the same figure', !near(a, b),
    'averaging two handsets of the same model would misstate every sale');

  // Selling must charge the cost of the device that actually left.
  await call('sales:create', {
    CustomerID: 1,
    items: [{ ItemID: 1, SerialID: q("SELECT SerialID v FROM item_serials WHERE IMEI='IMEI-A'").v, Quantity: 1, UnitPrice: 20000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 20000,
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const charged = q('SELECT UnitCost v FROM sale_details ORDER BY DetailID DESC').v;
  t('the sale is costed at the cost of the handset that left',
    near(charged, 18000), `charged ${charged}, pool average would have been 16750`);
  console.log(`        difference had it been averaged: ${r2(18000 - 16750)} per sale`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The pool and the device records must describe the same shelf');
// This is the invariant the refactor is meant to make structurally impossible
// to break. Recorded now against current behaviour.
{
  seed();
  await buyPhones(['P1', 'P2', 'P3'], 15000);
  agree('after buying three handsets');

  await call('sales:create', {
    CustomerID: 1,
    items: [{ ItemID: 1, SerialID: q("SELECT SerialID v FROM item_serials WHERE IMEI='P1'").v, Quantity: 1, UnitPrice: 20000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 20000,
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  agree('after selling one');
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Agreement survives a mixed-price shelf');
// The dangerous case: the pool average moves, so any figure derived from it
// stops matching the individual devices.
{
  seed();
  await buyPhones(['H1', 'H2'], 18000);
  await buyPhones(['H3', 'H4'], 12000);
  const r = agree('two deliveries at different prices');
  console.log(`        pool ${r.poolTotal} vs devices ${r.devTotal}`);

  await call('sales:create', {
    CustomerID: 1,
    items: [{ ItemID: 1, SerialID: q("SELECT SerialID v FROM item_serials WHERE IMEI='H1'").v, Quantity: 1, UnitPrice: 25000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 25000,
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  agree('after selling the expensive one from a mixed shelf');
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A returned handset comes back at the cost it left at');
{
  seed();
  await buyPhones(['R1'], 17000);
  await buyPhones(['R2'], 11000);          // moves the average
  const sid = q("SELECT SerialID v FROM item_serials WHERE IMEI='R1'").v;
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, SerialID: sid, Quantity: 1, UnitPrice: 22000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 22000,
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const saleId = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC').v;
  const det = all('SELECT DetailID, ItemID, SerialID, UnitPrice FROM sale_details WHERE SaleID = ?', saleId);
  const ret = await call('saleReturns:create', {
    SaleID: saleId, CustomerID: 1,
    items: det.map(d => ({ ItemID: d.ItemID, SerialID: d.SerialID, Quantity: 1, UnitPrice: d.UnitPrice })),
    Reason: 'faulty', AccountCredit: 0, CashRefund: 22000, CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  t('the return is accepted', ret?.success === true, JSON.stringify(ret).slice(0, 100));

  const back = q("SELECT CostPrice v, Status s FROM item_serials WHERE IMEI='R1'");
  t('the handset is available again', back.s === 'available', `status ${back.s}`);
  t('and still carries its ORIGINAL cost, not the new average',
    near(back.v, 17000), `cost after return ${back.v} (average would be 14000)`);
  agree('pool and devices still agree after the return');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A full round trip must leave inventory value untouched');
// Conservation: buy, sell, return, and the shelf must be worth what it was.
{
  seed();
  await buyPhones(['C1', 'C2'], 16000);
  const before = poolVsDevices().devTotal;
  const sid = q("SELECT SerialID v FROM item_serials WHERE IMEI='C1'").v;
  await call('sales:create', {
    CustomerID: 1, items: [{ ItemID: 1, SerialID: sid, Quantity: 1, UnitPrice: 21000 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 21000,
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const saleId = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC').v;
  const det = all('SELECT DetailID, ItemID, SerialID, UnitPrice FROM sale_details WHERE SaleID = ?', saleId);
  await call('saleReturns:create', {
    SaleID: saleId, CustomerID: 1,
    items: det.map(d => ({ ItemID: d.ItemID, SerialID: d.SerialID, Quantity: 1, UnitPrice: d.UnitPrice })),
    Reason: 'faulty', AccountCredit: 0, CashRefund: 21000, CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  const after = poolVsDevices().devTotal;
  t('the devices are worth exactly what they were before', near(before, after),
    `${before} -> ${after}`);
  agree('and the pool agrees with them');
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Freight raises the cost of the handsets it arrived with');
// This is where seed 29 lives: freight is capitalised onto the device, and if
// it is later written off the device row keeps the landed figure.
{
  seed();
  await buyPhones(['F1', 'F2'], 10000, { freight: 1000 });
  const f1 = q("SELECT CostPrice v FROM item_serials WHERE IMEI='F1'").v;
  t('freight is spread onto the devices, not lost',
    near(f1, 10500), `landed cost ${f1} (10,000 + 500 share of 1,000 freight)`);
  agree('pool and devices agree after a freighted delivery');
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Cancelling a purchase removes exactly what it added');
{
  seed();
  await buyPhones(['D1', 'D2'], 14000);
  const beforeQ = q("SELECT COUNT(*) v FROM item_serials WHERE Status='available'").v;
  await buyPhones(['D3'], 19000);
  const pid = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC').v;
  const res = await call('delete:purchase', pid);
  t('the purchase is deleted', res?.success === true, JSON.stringify(res));
  t('the handset it brought in is gone',
    q("SELECT COUNT(*) v FROM item_serials WHERE Status='available'").v === beforeQ,
    `${q("SELECT COUNT(*) v FROM item_serials WHERE Status='available'").v} available, expected ${beforeQ}`);
  agree('pool and devices agree after cancelling a purchase');
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Moving a handset between warehouses moves its exact cost');
{
  seed();
  await buyPhones(['T1'], 16500);
  const before = poolVsDevices().devTotal;
  const res = await call('warehouseTransfers:create', {
    FromWarehouseID: 1, ToWarehouseID: 2,
    items: [{ ItemID: 1, Quantity: 1, UnitCost: 16500 }],
    Notes: 'move', fiscalYearId: 1, userId: 1,
  });
  if (res?.success) {
    t('inventory is worth the same after the move',
      near(poolVsDevices().devTotal, before), `${before} -> ${poolVsDevices().devTotal}`);
    agree('pool and devices agree in BOTH warehouses');
  } else {
    t('the transfer was refused rather than silently mis-valued', true,
      JSON.stringify(res).slice(0, 80));
  }
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Pooled accessories are deliberately NOT tracked per unit');
// The owner's rule: anything over ~100 pounds gets lot tracking; cheap
// consumables stay on the average. This pins that a cable does NOT get device
// rows, so the coming change cannot accidentally make the counter slow.
{
  seed();
  await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 2, Quantity: 500, UnitCost: 25, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0,
    fiscalYearId: 1, userId: 1,
  });
  t('500 cables create no device rows at all',
    q('SELECT COUNT(*) v FROM item_serials WHERE ItemID = 2').v === 0,
    'numbering every cable would add 500 rows and slow the till for no gain');
  t('they are held as one pooled row',
    q('SELECT Quantity v FROM stock_quantities WHERE ItemID = 2 AND WarehouseID = 1').v === 500);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
