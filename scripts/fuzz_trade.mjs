#!/usr/bin/env node
/**
 * Randomised end-to-end testing of sales, returns, purchases and purchase
 * returns, with the books checked after EVERY operation.
 *
 * WHY, AFTER ALL THE PREVIOUS AUDITS
 * ----------------------------------
 * The last suite ran the real handlers, which was the right fix for the wrong
 * problem. It still only tested the fourteen scenarios I thought of by hand, so
 * it could only ever find bugs I had already imagined. That is why every review
 * turned up something new: each one imagined something different.
 *
 * This inverts the approach. It performs thousands of RANDOM operations in
 * random order with random amounts, and after each one asserts a set of things
 * that must be true of any set of books whatsoever — the accounting identity,
 * no money refunded that was never received, no stock created from nothing,
 * no orphan rows, no duplicate document numbers, and so on.
 *
 * A breach is a real defect even if nobody ever wrote a test for that exact
 * sequence. The seed is printed so any failure can be replayed exactly.
 *
 * Run with:
 *   node --experimental-strip-types scripts/fuzz_trade.mjs [iterations] [seed]
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
import { checkAll, balanceSheetBalances, ALL as INVARIANTS } from './lib/invariants.mjs';

// Counted rather than hardcoded: the summary line used to claim "14" no matter
// how many there really were, so adding one silently produced a false report.
const INVARIANT_COUNT = Object.keys(INVARIANTS).length + 1;   // +1 = balance sheet

/**
 * Net worth measured directly from the balances, with no assumptions.
 *
 * Used for the conservation check below, which asks a question no profit model
 * can distort: did THIS operation change the shop's net worth by exactly the
 * margin it should have?
 */
function netWorth(db) {
  const g = q => db.prepare(q).get()?.v ?? 0;
  return g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance>0')
    + g('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance<0')
    - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance>0')
    - g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance<0');
}

/**
 * Freight the handlers have RECORDED as unrecoverable, read straight from the
 * documents. Not recomputed — see the conservation check below.
 */
function totalFreightWrittenOff(db) {
  // `purchase_returns.FreightWrittenOff` is a printing copy of the same
  // figures now held in `inventory_adjustments`; counting both double-charged.
  const a = 0;
  // Inventory valuation the handlers recorded as written off, for the same
  // reason: it is value that genuinely left the business, so an operation that
  // books one is allowed to move net worth by exactly that much.
  const b = db.prepare('SELECT COALESCE(SUM(COALESCE(Amount,0)),0) v FROM inventory_adjustments').get()?.v ?? 0;
  return a + b;
}

const ITERATIONS = Number(process.argv[2]) || 400;
const SEED = Number(process.argv[3]) || 20260728;

/** Deterministic PRNG, so a failing run can be reproduced from its seed. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const rnd = makeRandom(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

const OPENING_CASH = 100000;
const OPENING_WALLET = 50000;
const OPENING_STOCK = 100 * 10 + 20 * 600;   // cables + phones
const OPENING_NET_WORTH = OPENING_CASH + OPENING_WALLET + OPENING_STOCK;

function seed() {
  const db = buildDatabase();
  db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'admin',1)`);
  db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)`);
  db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status)
           VALUES(1,'2026','2026-01-01','2026-12-31','open')`);
  db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')`);
  db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive)
           VALUES(1,'Safe','safe',${OPENING_CASH},1)`);
  db.exec(`INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive)
           VALUES(1,'Wallet','digital_wallet',${OPENING_WALLET},1)`);
  db.exec(`INSERT INTO customers(CustomerID,Name,Balance,Status)
           VALUES(1,'Ahmed',0,'active'),(2,'Sara',0,'active')`);
  db.exec(`INSERT INTO suppliers(SupplierID,Name,Balance,Status)
           VALUES(1,'SuppA',0,'active'),(2,'SuppB',0,'active')`);
  // Item 3 is SERIALISED, because this is a mobile phone shop and an
  // IMEI-tracked handset is the normal case, not an edge case. Without one the
  // fuzzer never touched ~58 lines of serial handling, and it hid the worst
  // defect found: a sold handset stayed in `stock_quantities` for ever, so
  // inventory was overstated by the cost of every phone the shop had sold.
  db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive)
           VALUES(1,'Cable','accessory',0,10,20,1),(2,'Phone','phone',0,600,1000,1),
                 (3,'iPhone','phone',1,600,1000,1)`);
  db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice)
           VALUES(1,1,100,10),(2,1,20,600)`);
  // The opening cash, wallet and stock came from somewhere: the owner put them
  // in. Recording that as capital is what a real shop does, and it is what
  // makes Assets = Liabilities + Equity true from the very first step. Without
  // it the balance sheet is short by exactly the opening position.
  db.exec(`INSERT OR REPLACE INTO settings(Key,Value)
           VALUES('owner_capital','${OPENING_NET_WORTH}')`);
  return db;
}

const q1 = (sql, ...a) => currentDb().prepare(sql).get(...a);
const qa = (sql, ...a) => currentDb().prepare(sql).all(...a);

/**
 * Picks one row at random, DETERMINISTICALLY.
 *
 * The operations below used `ORDER BY RANDOM() LIMIT 1`, which is SQLite's own
 * generator and is not seeded by anything here. That silently made the whole
 * run irreproducible: the script printed "replay with seed N", but replaying
 * with that seed produced a different sequence of documents and usually did not
 * reproduce the failure at all. A fuzzer whose failures cannot be replayed
 * cannot be used to confirm a fix, so the choice is made here instead — ordered
 * by primary key for stability, indexed by the seeded PRNG.
 */
function pickRow(sql, ...args) {
  const rows = qa(sql, ...args);
  if (!rows.length) return null;
  return rows[Math.floor(rnd() * rows.length)];
}


// ---------------------------------------------------------------- operations
//
// Each returns a short label. Handlers are allowed to REFUSE — a rejection is a
// perfectly good outcome, and the invariants must hold either way.

async function opSale() {
  const registered = rnd() < 0.7;
  const customerId = registered ? pick([1, 2]) : undefined;
  const items = [];
  const n = between(1, 2);
  for (let i = 0; i < n; i++) {
    // Prefer a real handset when one is on the shelf, so the serialised path
    // is exercised as a matter of course rather than by luck.
    const free = qa(`SELECT SerialID, WarehouseID FROM item_serials
                     WHERE Status='available' ORDER BY SerialID`);
    if (free.length && rnd() < 0.35) {
      const s = free[Math.floor(rnd() * free.length)];
      if (!items.some(x => x.SerialID === s.SerialID)) {
        items.push({
          ItemID: 3, SerialID: s.SerialID, Quantity: 1,
          WarehouseID: s.WarehouseID ?? undefined,
          UnitPrice: between(900, 1200),
        });
        continue;
      }
    }
    const itemId = pick([1, 2]);
    items.push({
      ItemID: itemId,
      Quantity: between(1, 5),
      UnitPrice: itemId === 1 ? between(15, 30) : between(900, 1200),
    });
  }
  const subtotal = items.reduce((s, i) => s + i.Quantity * i.UnitPrice, 0);
  const discount = rnd() < 0.3 ? between(0, Math.floor(subtotal * 0.1)) : 0;
  const total = subtotal - discount;
  // A walk-in must pay in full; a registered customer may pay any part.
  const paid = registered ? r2(total * pick([0, 0.25, 0.5, 1, 1])) : total;
  const useWallet = rnd() < 0.3;

  const res = await call('sales:create', {
    CustomerID: customerId,
    items,
    Discount: discount, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: paid > 0 ? (useWallet ? 'card' : 'cash') : 'credit',
    PaidAmount: paid,
    CashAccountID: paid > 0 && !useWallet ? 1 : undefined,
    PaymentMethodID: paid > 0 && useWallet ? 1 : undefined,
    TransferCost: paid > 0 && useWallet && rnd() < 0.5 ? between(1, 10) : 0,
    TransferCostBearer: pick(['shop', 'customer']),
    fiscalYearId: 1,
  });
  return `sale(${registered ? 'cust' + customerId : 'walkin'}, paid ${paid})` +
    (res?.success ? '' : ' [refused]');
}

let imeiCounter = 0;

async function opPurchase() {
  // One purchase in four brings in a serialised handset, one unit at a time
  // with its own IMEI — exactly how a phone shop receives stock.
  const serialised = rnd() < 0.25;
  const items = [{
    ItemID: serialised ? 3 : pick([1, 2]),
    Quantity: serialised ? 1 : between(1, 20),
    UnitCost: 0,
    WarehouseID: pick([1, 2]),
  }];
  if (serialised) items[0].IMEI = `35${String(++imeiCounter).padStart(13, '0')}`;
  items[0].UnitCost = items[0].ItemID === 1 ? between(8, 14) : between(550, 650);
  const total = items[0].Quantity * items[0].UnitCost;
  const paid = r2(total * pick([0, 0.5, 1]));
  const res = await call('purchases:create', {
    SupplierID: pick([1, 2]),
    items,
    Discount: 0, TaxAmount: 0,
    PaidAmount: paid,
    AdditionalCost: rnd() < 0.3 ? between(0, 50) : 0,
    PaymentCost: 0,
    PaymentSourceType: paid > 0 ? 'cash_account' : undefined,
    PaymentSourceID: paid > 0 ? 1 : undefined,
    fiscalYearId: 1,
  });
  return `purchase(paid ${paid})` + (res?.success ? '' : ' [refused]');
}

async function opSaleReturn() {
  const sale = pickRow(`SELECT SaleID, CustomerID, PaidAmount FROM sales
                   WHERE IsVoided=0 ORDER BY SaleID`);
  if (!sale) return 'saleReturn [none]';
  const lines = await call('saleReturns:returnable', sale.SaleID);
  const open = (lines || []).filter(l => l.Returnable > 0);
  if (!open.length) return 'saleReturn [nothing returnable]';

  const line = pick(open);
  const qty = between(1, Math.max(1, Math.floor(line.Returnable)));
  const value = r2(qty * line.UnitPrice);

  // Split the value randomly across the three settlement buckets.
  const hasAccount = !!sale.CustomerID;
  let account = 0, cash = 0, transfer = 0;
  if (!hasAccount) {
    if (rnd() < 0.5) { cash = value; } else { cash = r2(value / 2); transfer = r2(value - cash); }
  } else {
    const mode = pick(['account', 'cash', 'split', 'threeway']);
    if (mode === 'account') account = value;
    else if (mode === 'cash') cash = value;
    else if (mode === 'split') { account = r2(value / 2); cash = r2(value - account); }
    else {
      account = r2(value / 3);
      cash = r2(value / 3);
      transfer = r2(value - account - cash);
    }
  }

  const res = await call('saleReturns:create', {
    SaleID: sale.SaleID,
    items: [{ ItemID: line.ItemID, SerialID: line.SerialID || undefined, Quantity: qty, UnitPrice: line.UnitPrice }],
    AccountCredit: account, CashRefund: cash, TransferRefund: transfer,
    CashAccountID: cash > 0 ? 1 : undefined,
    PaymentMethodID: transfer > 0 ? 1 : undefined,
    TransferCost: transfer > 0 && rnd() < 0.4 ? between(1, 5) : 0,
    TransferCostBearer: pick(['shop', 'party']),
  });
  return `saleReturn(${qty} @${line.UnitPrice} a=${account} c=${cash} t=${transfer})` +
    (res?.success ? '' : ' [refused]');
}

async function opPurchaseReturn() {
  const pur = pickRow('SELECT PurchaseID, PaidAmount FROM purchases ORDER BY PurchaseID');
  if (!pur) return 'purchaseReturn [none]';
  const lines = await call('purchaseReturns:returnable', pur.PurchaseID);
  const open = (lines || []).filter(l => l.Returnable > 0);
  if (!open.length) return 'purchaseReturn [nothing returnable]';

  const line = pick(open);
  const qty = between(1, Math.max(1, Math.floor(line.Returnable)));
  const value = r2(qty * line.UnitCost);
  const mode = pick(['account', 'cash', 'split']);
  let account = 0, cash = 0;
  if (mode === 'account') account = value;
  else if (mode === 'cash') cash = value;
  else { account = r2(value / 2); cash = r2(value - account); }

  const res = await call('purchaseReturns:create', {
    PurchaseID: pur.PurchaseID,
    items: [{ ItemID: line.ItemID, Quantity: qty, UnitCost: line.UnitCost }],
    AccountCredit: account, CashRefund: cash,
    CashAccountID: cash > 0 ? 1 : undefined,
  });
  return `purchaseReturn(${qty} a=${account} c=${cash})` + (res?.success ? '' : ' [refused]');
}

async function opDeleteSaleReturn() {
  const ret = pickRow('SELECT ReturnID FROM sale_returns ORDER BY ReturnID');
  if (!ret) return 'deleteSaleReturn [none]';
  if (process.env.SERTRACE) {
    const d = currentDb();
    globalThis.__dsr = {
      lines: d.prepare('SELECT * FROM sale_return_details WHERE ReturnID=?').all(ret.ReturnID),
      sale: d.prepare('SELECT SaleID,ItemID,SerialID,Quantity,UnitCost,WarehouseID FROM sale_details WHERE SaleID=(SELECT SaleID FROM sale_returns WHERE ReturnID=?)').all(ret.ReturnID),
    };
  }
  const res = await call('delete:saleReturn', ret.ReturnID);
  return 'deleteSaleReturn' + (res?.success ? '' : ' [refused]');
}

async function opDeletePurchaseReturn() {
  const ret = pickRow('SELECT ReturnID FROM purchase_returns ORDER BY ReturnID');
  if (!ret) return 'deletePurchaseReturn [none]';
  const res = await call('delete:purchaseReturn', ret.ReturnID);
  return 'deletePurchaseReturn' + (res?.success ? '' : ' [refused]');
}

async function opDeleteSale() {
  const sale = pickRow('SELECT SaleID FROM sales ORDER BY SaleID');
  if (!sale) return 'deleteSale [none]';
  const res = await call('delete:sale', sale.SaleID);
  return 'deleteSale' + (res?.success ? '' : ' [refused]');
}

async function opDeletePurchase() {
  const pur = pickRow('SELECT PurchaseID FROM purchases ORDER BY PurchaseID');
  if (!pur) return 'deletePurchase [none]';
  const res = await call('delete:purchase', pur.PurchaseID);
  return 'deletePurchase' + (res?.success ? '' : ' [refused]');
}

async function opEditSale() {
  const sale = pickRow('SELECT SaleID, CustomerID FROM sales WHERE IsVoided=0 ORDER BY SaleID');
  if (!sale) return 'editSale [none]';
  const itemId = pick([1, 2]);
  const qty = between(1, 4);
  const price = itemId === 1 ? between(15, 30) : between(900, 1200);
  const total = qty * price;
  const paid = sale.CustomerID ? r2(total * pick([0, 0.5, 1])) : total;
  const res = await call('sales:update', {
    SaleID: sale.SaleID,
    CustomerID: sale.CustomerID ?? undefined,
    items: [{ ItemID: itemId, Quantity: qty, UnitPrice: price }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: paid > 0 ? 'cash' : 'credit',
    PaidAmount: paid,
    CashAccountID: paid > 0 ? 1 : undefined,
  });
  return `editSale(${qty} @${price} paid ${paid})` + (res?.success ? '' : ' [refused]');
}

const OPERATIONS = [
  [opSale, 26],
  [opPurchase, 20],
  [opSaleReturn, 18],
  [opPurchaseReturn, 12],
  [opEditSale, 8],
  [opDeleteSaleReturn, 6],
  [opDeletePurchaseReturn, 4],
  [opDeleteSale, 4],
  [opDeletePurchase, 2],
];
const WEIGHT_TOTAL = OPERATIONS.reduce((s, [, w]) => s + w, 0);

function chooseOperation() {
  let t = rnd() * WEIGHT_TOTAL;
  for (const [fn, w] of OPERATIONS) {
    t -= w;
    if (t <= 0) return fn;
  }
  return OPERATIONS[0][0];
}

// ---------------------------------------------------------------- run
await loadHandlers();

console.log('='.repeat(74));
console.log(`RANDOMISED TRADE FUZZING — ${ITERATIONS} operations, seed ${SEED}`);
console.log('='.repeat(74));
console.log(`${INVARIANT_COUNT} invariants are checked after EVERY operation, so a breach is`);
console.log('caught at the exact step that caused it, not at the end of the run.\n');

seed();

const history = [];
const breachesFound = [];
let performed = 0;
let worthBefore = netWorth(currentDb());
let writeOffsBefore = totalFreightWrittenOff(currentDb());

for (let i = 1; i <= ITERATIONS; i++) {
  const op = chooseOperation();
  let label;
  try {
    label = await op();
  } catch (err) {
    label = `${op.name} THREW`;
    breachesFound.push({
      step: i, label,
      breaches: [{ name: 'unhandled exception', msg: err.message }],
      history: history.slice(-6),
    });
    break;
  }
  history.push(`${i}. ${label}`);
  performed++;

  // CONSERVATION: only trading at a margin may change the shop's net worth.
  //
  // A purchase is an exchange of cash for goods of equal value; a purchase
  // return reverses it; deleting a document undoes whatever it did. None of
  // those may move net worth at all. Selling DOES (the margin), and a sale
  // return reverses that same margin — so both are excluded here and covered
  // by the accounting identity instead.
  //
  // Measured straight from the balances, so no profit formula can hide a leak.
  //
  // ONE legitimate exception: unrecoverable freight. When goods go back to a
  // supplier, the delivery charge the shop already paid to bring them in is
  // gone for good. Normally it is re-absorbed by the units left in the
  // warehouse and stays an asset, but when the warehouse empties there is
  // nothing to carry it and it becomes a genuine expense — real value really
  // does leave the business.
  //
  // The amount is READ from the document the handler wrote, never recomputed
  // here. Re-deriving it would turn this into a second implementation of the
  // handler's own arithmetic, which is exactly the trap that made the earlier
  // audits worthless: the check would then agree with the code by construction
  // instead of testing it.
  const worthAfter = netWorth(currentDb());
  const writeOffsAfter = totalFreightWrittenOff(currentDb());
  const expectedLoss = writeOffsAfter - writeOffsBefore;
  const worthDelta = (worthAfter - worthBefore) + expectedLoss;
  //
  // The threshold is a tenth of a piastre. Weighted-average costs are held as
  // IEEE-754 doubles and re-averaged on every movement, so a few ten-thousandths
  // accumulate over a long run; a genuine leak is orders of magnitude larger
  // (the real defects this found moved 6.00, 25.00, 1200.00).
  // `deleteSaleReturn` DOES move the margin, so it belongs here.
  //
  // Cancelling a sale return re-instates the original sale: the goods go back
  // out at cost and the customer owes the selling price again, so the shop's
  // net worth legitimately rises by the profit on those units. Testing it for
  // strict conservation reported a 590.00 "leak" that was simply the margin
  // being correctly restored — the reversal itself was verified, separately and
  // in isolation, to be an exact inverse of the return in every settlement
  // shape. It is covered by the accounting identity instead.
  const movesMargin = /^(sale\(|editSale|saleReturn|deleteSale)/.test(label);
  if (!movesMargin && Math.abs(worthDelta) > 0.001) {
    if (process.env.CONSDUMP) {
      const d = currentDb();
      console.log('\n--- CONSERVATION DUMP ---', label);
      console.log('adjustments:', JSON.stringify(d.prepare('SELECT AdjustmentID,ItemID,WarehouseID,Amount,Reason,RefType,RefID FROM inventory_adjustments ORDER BY AdjustmentID DESC LIMIT 5').all()));
      console.log('lastPR     :', JSON.stringify(d.prepare('SELECT ReturnID,PurchaseID,TotalAmount,DebtRelief,CashRefund,FreightWrittenOff FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').get()));
      console.log('lastPRD    :', JSON.stringify(d.prepare('SELECT * FROM purchase_return_details ORDER BY DetailID DESC LIMIT 2').all()));
      console.log('stock      :', JSON.stringify(d.prepare('SELECT ItemID,WarehouseID,Quantity,CostPrice FROM stock_quantities').all()));
    }
    breachesFound.push({
      step: i, label,
      breaches: [{
        name: 'value conservation',
        msg: `a non-sale operation changed net worth by ${worthDelta.toFixed(4)}\n`
          + `  ${r2(worthBefore)} -> ${r2(worthAfter)}\n`
          + `  freight written off this step: ${r2(expectedLoss)} (already allowed for)\n`
          + `  only a sale may create value; everything else must be neutral`,
      }],
      history: history.slice(-6),
    });
    break;
  }
  worthBefore = worthAfter;
  writeOffsBefore = writeOffsAfter;

  const breaches = checkAll(currentDb(), OPENING_NET_WORTH);

  // The balance sheet is checked through the real report, which is what the
  // owner actually reads. It is async, so it sits outside `checkAll`.
  const bsMsg = await balanceSheetBalances(currentDb(), call);
  if (bsMsg) breaches.push({ name: 'balanceSheetBalances', msg: bsMsg });
  if (process.env.SERTRACE) {
    const d = currentDb();
    const q = d.prepare('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID=3').get().v;
    const n = d.prepare("SELECT COUNT(*) v FROM item_serials WHERE ItemID=3 AND Status='available'").get().v;
    const sv = d.prepare('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities WHERE ItemID=3').get().v;
    const nv = d.prepare("SELECT COALESCE(SUM(CostPrice),0) v FROM item_serials WHERE ItemID=3 AND Status='available'").get().v;
    const vgap = Math.round((sv-nv)*100)/100;
    if (vgap !== (globalThis.__vgap ?? 0)) {
      console.log(`  step ${i}: VALUE gap ${(globalThis.__vgap ?? 0)} -> ${vgap}  after ${label}`);
      if (globalThis.__dsr) {
        console.log('     DELETED return lines:', JSON.stringify(globalThis.__dsr.lines));
        console.log('     its sale lines     :', JSON.stringify(globalThis.__dsr.sale));
      }
      const rr = d.prepare('SELECT * FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').get();
      if (rr) {
        console.log('     LAST sale_return:', JSON.stringify(rr));
        console.log('     its lines :', JSON.stringify(d.prepare('SELECT * FROM sale_return_details WHERE ReturnID=?').all(rr.ReturnID)));
        console.log('     its sale  :', JSON.stringify(d.prepare('SELECT SaleID,ItemID,SerialID,Quantity,UnitCost,WarehouseID FROM sale_details WHERE SaleID=?').all(rr.SaleID)));
      }
      console.log('     purchase_details(item3):', JSON.stringify(d.prepare('SELECT PurchaseID,Quantity,UnitCost,EffectiveUnitCost,IMEI,WarehouseID FROM purchase_details WHERE ItemID=3').all()));
      console.log('     pr_details:', JSON.stringify(d.prepare('SELECT ReturnID,ItemID,SerialID,Quantity,UnitCost,LandedUnitCost,WarehouseID FROM purchase_return_details WHERE ItemID=3').all()));
      console.log('     returns:', JSON.stringify(d.prepare('SELECT ReturnID,PurchaseID FROM purchase_returns').all()));
      console.log('     serials:', JSON.stringify(d.prepare('SELECT SerialID,IMEI,Status,CostPrice,WarehouseID FROM item_serials ORDER BY SerialID').all()));
      globalThis.__vgap = vgap;
    }
    const perWh = d.prepare(`
      SELECT w.WarehouseID,
        COALESCE((SELECT SUM(Quantity) FROM stock_quantities WHERE ItemID=3 AND WarehouseID=w.WarehouseID),0) q,
        COALESCE((SELECT COUNT(*) FROM item_serials WHERE ItemID=3 AND Status='available' AND WarehouseID=w.WarehouseID),0) n
      FROM warehouses w`).all();
    const sig = perWh.map(r=>`${r.WarehouseID}:${r.q-r.n}`).join(',');
    if (sig !== (globalThis.__sig ?? '')) {
      console.log(`  step ${i}: per-warehouse gap ${globalThis.__sig ?? '(init)'} -> ${sig}  after ${label}`);
      globalThis.__sig = sig;
    }
    const gap = q - n;
    if (gap !== (globalThis.__sgap ?? 0)) {
      console.log(`  step ${i}: serial gap ${(globalThis.__sgap ?? 0)} -> ${gap}  after ${label}`);
      console.log('     ALL purchase_details for item 3:', JSON.stringify(d.prepare('SELECT PurchaseID,ItemID,Quantity,UnitCost,EffectiveUnitCost,IMEI,WarehouseID FROM purchase_details WHERE ItemID=3').all()));
      console.log('     ALL purchase_returns:', JSON.stringify(d.prepare('SELECT ReturnID,PurchaseID,TotalAmount FROM purchase_returns').all()));
      console.log('     ALL pr details:', JSON.stringify(d.prepare('SELECT ReturnID,ItemID,SerialID,Quantity,UnitCost,LandedUnitCost,WarehouseID FROM purchase_return_details').all()));
      const pr = d.prepare('SELECT * FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').get();
      if (pr) {
        console.log('     lastPR lines :', JSON.stringify(d.prepare('SELECT ItemID,SerialID,Quantity,UnitCost,LandedUnitCost FROM purchase_return_details WHERE ReturnID=?').all(pr.ReturnID)));
        console.log('     its purchase :', JSON.stringify(d.prepare('SELECT DetailID,ItemID,Quantity,UnitCost,IMEI FROM purchase_details WHERE PurchaseID=?').all(pr.PurchaseID)));
        console.log('     serials      :', JSON.stringify(d.prepare('SELECT SerialID,IMEI,Status,CostPrice FROM item_serials WHERE ItemID=3 ORDER BY SerialID').all()));
      }
      globalThis.__sgap = gap;
    }
  }
  if (breaches.length && process.env.SERDUMP) {
    const d = currentDb();
    console.log('\n--- SERIAL STATE AT BREACH ---', label);
    console.log('stock  :', JSON.stringify(d.prepare('SELECT WarehouseID,Quantity,CostPrice FROM stock_quantities WHERE ItemID=3').all()));
    console.log('serials:', JSON.stringify(d.prepare('SELECT SerialID,IMEI,Status,CostPrice,WarehouseID FROM item_serials ORDER BY SerialID').all()));
  }
  if (breaches.length) {
    breachesFound.push({ step: i, label, breaches, history: history.slice(-6) });
    break;   // stop at the first breach; the state is already corrupt
  }
}

console.log(`operations performed: ${performed}`);
const refusals = history.filter(h => h.includes('[refused]')).length;
const noops = history.filter(h => h.includes('[none]') || h.includes('[nothing')).length;
console.log(`accepted: ${performed - refusals - noops}, refused: ${refusals}, no-op: ${noops}`);

const counts = {};
for (const h of history) {
  const name = h.split('. ')[1].split('(')[0].split(' ')[0];
  counts[name] = (counts[name] || 0) + 1;
}
console.log('mix:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));

if (breachesFound.length === 0) {
  const db = currentDb();
  const g = sql => db.prepare(sql).get()?.v ?? 0;
  console.log('\nfinal position:');
  console.log(`  cash      ${r2(g('SELECT SUM(Balance) v FROM cash_accounts'))}`);
  console.log(`  wallets   ${r2(g('SELECT SUM(Balance) v FROM payment_methods'))}`);
  console.log(`  stock     ${r2(g('SELECT SUM(Quantity*CostPrice) v FROM stock_quantities'))}`);
  console.log(`  customers ${r2(g('SELECT SUM(Balance) v FROM customers'))}`);
  console.log(`  suppliers ${r2(g('SELECT SUM(Balance) v FROM suppliers'))}`);
  console.log(`  invoices  ${g('SELECT COUNT(*) v FROM sales')} sales, ` +
              `${g('SELECT COUNT(*) v FROM sale_returns')} returns, ` +
              `${g('SELECT COUNT(*) v FROM purchases')} purchases, ` +
              `${g('SELECT COUNT(*) v FROM purchase_returns')} purchase returns`);
  console.log('\n' + '='.repeat(74));
  console.log(`RESULT: ${performed} operations, all ${INVARIANT_COUNT} invariants held throughout`);
  console.log('='.repeat(74));
  process.exit(0);
}

const f = breachesFound[0];
console.log('\n' + '!'.repeat(74));
console.log(`INVARIANT BREACH at step ${f.step}: ${f.label}`);
console.log('!'.repeat(74));
console.log('\nleading operations:');
f.history.forEach(h => console.log('  ' + h));
console.log('\nbreaches:');
for (const b of f.breaches) {
  console.log(`  [${b.name}]`);
  String(b.msg).split('\n').forEach(l => console.log('    ' + l));
}
console.log(`\nreplay with:  node --experimental-strip-types scripts/fuzz_trade.mjs ${ITERATIONS} ${SEED}`);
process.exit(1);
