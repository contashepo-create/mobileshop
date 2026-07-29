#!/usr/bin/env node
/**
 * DIFFERENTIAL TEST — an independent double-entry model of trading.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE TRAP FROM BEFORE
 * -------------------------------------------------------
 * An earlier round of audits was worthless because it reimplemented each
 * handler's arithmetic in Python and then tested the copy. That tests the
 * author's understanding, never the code.
 *
 * This is the opposite construction, and the difference matters:
 *
 *   - it does NOT re-derive what a handler should have done;
 *   - it reads the DOCUMENTS the handlers actually wrote — invoices, returns,
 *     their lines — and posts each one as a double-entry journal, the way an
 *     accountant would from a pile of paperwork;
 *   - it then asks whether the live balances (cash, wallets, customers,
 *     suppliers, stock) equal what that journal says they must be.
 *
 * So the two sides are independent in the way that counts: one is the running
 * balances the app maintains incrementally on every operation, the other is a
 * fresh posting of the finished paperwork. If a handler updates a balance but
 * forgets a document line — or writes a document but misses a balance — the two
 * disagree. Incremental updates drifting away from the documents is exactly the
 * failure mode that produced most of the defects found in this project.
 *
 * Every journal entry below is justified from the DOCUMENT, not from reading
 * the handler.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_ledger_model.mjs [ops] [seed]
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

const OPS = Number(process.argv[2]) || 250;
const SEED = Number(process.argv[3]) || 4242;

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const rnd = makeRandom(SEED);
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const OPENING_CASH = 100000, OPENING_WALLET = 50000;

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',${OPENING_CASH},1)`);
  db.exec(`INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','wallet',${OPENING_WALLET},1)`);
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active'),(2,'Sara',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'SuppA',0,'active'),(2,'SuppB',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1),(2,'Phone','device',0,600,1000,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10),(2,1,20,600)");
  return db;
}

/**
 * Posts every surviving document as a journal and returns the balances that
 * paperwork implies. Nothing here consults the handlers.
 */
function postFromDocuments(db) {
  const all = (q, ...a) => db.prepare(q).all(...a);
  let cash = OPENING_CASH, wallet = OPENING_WALLET;
  const cust = new Map(), supp = new Map();
  const add = (m, k, v) => { if (k != null) m.set(k, (m.get(k) || 0) + v); };

  // --- SALES. The customer is charged the invoice total; whatever they paid
  //     arrives in the drawer or the machine, net of any fee the shop absorbed.
  for (const s of all(`SELECT * FROM sales WHERE IsVoided = 0`)) {
    const paid = s.PaidAmount || 0;
    const shopFee = (s.TransferCostBearer ?? 'shop') === 'shop' ? (s.TransferCost || 0) : 0;
    const received = paid - shopFee;
    if (s.PaymentMethodID) wallet += received;
    else if (s.CashAccountID) cash += received;
    add(cust, s.CustomerID, (s.TotalAmount || 0) - paid);
  }

  // --- SALE RETURNS. The three settlement legs are what the document says the
  //     shop gave back: credit on account, cash out of the drawer, transfer out
  //     of the machine (plus the fee when the shop absorbed it).
  for (const r of all(`SELECT r.* FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID WHERE s.IsVoided = 0`)) {
    const sale = db.prepare('SELECT CustomerID FROM sales WHERE SaleID = ?').get(r.SaleID);
    add(cust, sale?.CustomerID, -(r.DebtRelief || 0));
    cash -= (r.CashRefund || 0);
    const out = (r.TransferCostBearer ?? 'shop') === 'shop'
      ? (r.TransferRefund || 0) + (r.TransferCost || 0)
      : (r.TransferRefund || 0);
    wallet -= out;
  }

  // --- PURCHASES. The supplier is owed the invoice total; what was paid left
  //     the chosen source.
  for (const p of all(`SELECT * FROM purchases`)) {
    const paid = p.PaidAmount || 0;
    if (paid > 0) {
      if (p.PaymentSource === 'payment_method') wallet -= paid;
      else cash -= paid;
    }
    add(supp, p.SupplierID, (p.TotalAmount || 0) - paid);
  }

  // --- PURCHASE RETURNS. Mirror image: debt cancelled, money received back.
  for (const r of all(`SELECT r.*, p.SupplierID FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID`)) {
    add(supp, r.SupplierID, -(r.DebtRelief || 0));
    cash += (r.CashRefund || 0);
    const received = (r.TransferCostBearer ?? 'shop') === 'party'
      ? (r.TransferRefund || 0) - (r.TransferCost || 0)
      : (r.TransferRefund || 0);
    wallet += received;
  }

  return { cash: r2(cash), wallet: r2(wallet), cust, supp };
}

/** Stock movements implied by the documents, per item. */
function stockFromDocuments(db) {
  const qty = new Map();
  const add = (k, v) => qty.set(k, (qty.get(k) || 0) + v);
  add(1, 100); add(2, 20);                                   // opening
  for (const l of db.prepare(`SELECT sd.ItemID, sd.Quantity FROM sale_details sd
      JOIN sales s ON sd.SaleID = s.SaleID WHERE s.IsVoided = 0 AND sd.ItemID IS NOT NULL`).all())
    add(l.ItemID, -(l.Quantity || 0));
  for (const l of db.prepare(`SELECT rd.ItemID, rd.Quantity FROM sale_return_details rd
      JOIN sale_returns r ON rd.ReturnID = r.ReturnID
      JOIN sales s ON r.SaleID = s.SaleID WHERE s.IsVoided = 0 AND rd.ItemID IS NOT NULL`).all())
    add(l.ItemID, (l.Quantity || 0));
  for (const l of db.prepare('SELECT ItemID, Quantity FROM purchase_details WHERE ItemID IS NOT NULL').all())
    add(l.ItemID, (l.Quantity || 0));
  for (const l of db.prepare('SELECT ItemID, Quantity FROM purchase_return_details WHERE ItemID IS NOT NULL').all())
    add(l.ItemID, -(l.Quantity || 0));
  return qty;
}

// ---------------------------------------------------------------- operations
const q1 = (s, ...a) => currentDb().prepare(s).get(...a);
const qa = (s, ...a) => currentDb().prepare(s).all(...a);
const pickRow = (s, ...a) => { const r = qa(s, ...a); return r.length ? r[Math.floor(rnd() * r.length)] : null; };

async function opSale() {
  const reg = rnd() < 0.7;
  const itemId = pick([1, 2]);
  const useWallet = rnd() < 0.3;
  const qty = between(1, 4);
  const price = itemId === 1 ? between(15, 30) : between(900, 1200);
  const total = qty * price;
  const paid = reg ? Math.round(total * pick([0, 0.5, 1]) * 100) / 100 : total;
  await call('sales:create', {
    CustomerID: reg ? pick([1, 2]) : undefined,
    items: [{ ItemID: itemId, Quantity: qty, UnitPrice: price }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: paid > 0 ? (useWallet ? 'card' : 'cash') : 'credit',
    PaidAmount: paid,
    CashAccountID: paid > 0 && !useWallet ? 1 : undefined,
    PaymentMethodID: paid > 0 && useWallet ? 1 : undefined,
    TransferCost: paid > 0 && useWallet && rnd() < 0.5 ? between(1, 8) : 0,
    TransferCostBearer: pick(['shop', 'customer']),
    fiscalYearId: 1,
  });
}
async function opPurchase() {
  const itemId = pick([1, 2]);
  const qty = between(1, 10);
  const cost = itemId === 1 ? between(8, 14) : between(550, 650);
  const paid = Math.round(qty * cost * pick([0, 0.5, 1]) * 100) / 100;
  await call('purchases:create', {
    SupplierID: pick([1, 2]),
    items: [{ ItemID: itemId, Quantity: qty, UnitCost: cost, WarehouseID: pick([1, 2]) }],
    Discount: 0, TaxAmount: 0, PaidAmount: paid,
    AdditionalCost: rnd() < 0.3 ? between(0, 40) : 0, PaymentCost: 0,
    PaymentSourceType: paid > 0 ? 'cash_account' : undefined,
    PaymentSourceID: paid > 0 ? 1 : undefined,
    fiscalYearId: 1,
  });
}
async function opSaleReturn() {
  const sale = pickRow('SELECT SaleID, CustomerID FROM sales WHERE IsVoided=0 ORDER BY SaleID');
  if (!sale) return;
  const lines = await call('saleReturns:returnable', sale.SaleID);
  const open = (lines || []).filter(l => l.Returnable > 0);
  if (!open.length) return;
  const line = open[Math.floor(rnd() * open.length)];
  const qty = between(1, Math.max(1, Math.floor(line.Returnable)));
  const value = Math.round(qty * line.UnitPrice * 100) / 100;
  let acct = 0, cash = 0;
  if (sale.CustomerID && rnd() < 0.5) acct = value; else cash = value;
  await call('saleReturns:create', {
    SaleID: sale.SaleID,
    items: [{ ItemID: line.ItemID, Quantity: qty, UnitPrice: line.UnitPrice }],
    AccountCredit: acct, CashRefund: cash,
    CashAccountID: cash > 0 ? 1 : undefined,
  });
}
async function opPurchaseReturn() {
  const pur = pickRow('SELECT PurchaseID FROM purchases ORDER BY PurchaseID');
  if (!pur) return;
  const lines = await call('purchaseReturns:returnable', pur.PurchaseID);
  const open = (lines || []).filter(l => l.Returnable > 0);
  if (!open.length) return;
  const line = open[Math.floor(rnd() * open.length)];
  const qty = between(1, Math.max(1, Math.floor(line.Returnable)));
  const value = Math.round(qty * line.UnitCost * 100) / 100;
  const cashLeg = rnd() < 0.5;
  await call('purchaseReturns:create', {
    PurchaseID: pur.PurchaseID,
    items: [{ ItemID: line.ItemID, Quantity: qty, UnitCost: line.UnitCost }],
    AccountCredit: cashLeg ? 0 : value, CashRefund: cashLeg ? value : 0,
    CashAccountID: cashLeg ? 1 : undefined,
  });
}
async function opDeleteSale() {
  const s = pickRow('SELECT SaleID FROM sales ORDER BY SaleID');
  if (s) await call('delete:sale', s.SaleID);
}
async function opDeleteSaleReturn() {
  const r = pickRow('SELECT ReturnID FROM sale_returns ORDER BY ReturnID');
  if (r) await call('delete:saleReturn', r.ReturnID);
}
async function opDeletePurchaseReturn() {
  const r = pickRow('SELECT ReturnID FROM purchase_returns ORDER BY ReturnID');
  if (r) await call('delete:purchaseReturn', r.ReturnID);
}

const OPS_LIST = [[opSale, 30], [opPurchase, 22], [opSaleReturn, 18],
                  [opPurchaseReturn, 12], [opDeleteSaleReturn, 8],
                  [opDeletePurchaseReturn, 6], [opDeleteSale, 4]];
const WEIGHT = OPS_LIST.reduce((s, [, w]) => s + w, 0);

console.log('DIFFERENTIAL TEST — LIVE BALANCES vs A JOURNAL POSTED FROM THE DOCUMENTS\n');
console.log(`${OPS} random operations, seed ${SEED}\n`);

seed();
for (let i = 0; i < OPS; i++) {
  let x = rnd() * WEIGHT, fn = OPS_LIST[0][0];
  for (const [f, w] of OPS_LIST) { x -= w; if (x <= 0) { fn = f; break; } }
  try { await fn(); } catch { /* refusals are fine; the books must still agree */ }
}

const db = currentDb();
const model = postFromDocuments(db);
const live = {
  cash: r2(db.prepare('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').get().v),
  wallet: r2(db.prepare('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').get().v),
};

console.log(`documents posted: ${db.prepare('SELECT COUNT(*) v FROM sales').get().v} sales, `
  + `${db.prepare('SELECT COUNT(*) v FROM sale_returns').get().v} returns, `
  + `${db.prepare('SELECT COUNT(*) v FROM purchases').get().v} purchases, `
  + `${db.prepare('SELECT COUNT(*) v FROM purchase_returns').get().v} debit notes\n`);

t('the drawer matches the journal posted from the invoices',
  Math.abs(live.cash - model.cash) < 0.011,
  `live ${live.cash} vs documents ${model.cash}  (difference ${r2(live.cash - model.cash)})`);
t('the machine balance matches the journal',
  Math.abs(live.wallet - model.wallet) < 0.011,
  `live ${live.wallet} vs documents ${model.wallet}  (difference ${r2(live.wallet - model.wallet)})`);

for (const c of db.prepare('SELECT CustomerID, Name, Balance FROM customers').all()) {
  const want = r2(model.cust.get(c.CustomerID) || 0);
  t(`customer "${c.Name}" owes what the invoices say`,
    Math.abs(r2(c.Balance) - want) < 0.011,
    `live ${r2(c.Balance)} vs documents ${want}`);
}
for (const s of db.prepare('SELECT SupplierID, Name, Balance FROM suppliers').all()) {
  const want = r2(model.supp.get(s.SupplierID) || 0);
  t(`supplier "${s.Name}" is owed what the invoices say`,
    Math.abs(r2(s.Balance) - want) < 0.011,
    `live ${r2(s.Balance)} vs documents ${want}`);
}

const modelQty = stockFromDocuments(db);
for (const [itemId, want] of modelQty) {
  const live = db.prepare(
    'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ?').get(itemId).v;
  const name = db.prepare('SELECT ItemName v FROM items WHERE ItemID = ?').get(itemId).v;
  t(`stock of "${name}" matches the movements on the documents`,
    Math.abs(live - want) < 0.011, `live ${live} vs documents ${want}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
