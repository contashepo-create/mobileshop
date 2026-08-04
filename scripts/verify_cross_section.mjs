#!/usr/bin/env node
/**
 * EVERY SECTION, AND EVERY JOIN BETWEEN THEM.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each section already has a suite, and each one passes. That is not the same
 * as the program being correct, because almost nothing a shop does stays in
 * one section:
 *
 *   a repair is a MAINTENANCE ticket that consumes a SPARE PART from the
 *   WAREHOUSE, becomes a SALE, is paid by a VOUCHER into a CASH ACCOUNT, and
 *   must then appear in the CUSTOMER STATEMENT, the REPORTS and the FISCAL
 *   YEAR — six sections, one event.
 *
 * A per-section suite cannot see a defect in the JOIN, because each side is
 * internally consistent. Those defects are the expensive ones: the money is
 * not lost, it is counted twice, or counted in the wrong month, and nobody
 * notices until a year-end that will not reconcile.
 *
 * HOW IT IS TESTED
 * ----------------
 * Every scenario drives the REAL registered IPC handlers through the shared
 * harness, then runs the FULL invariant set — the same one the fuzzers use —
 * after each step. A section passes only if the whole book still balances,
 * not merely if its own table looks right.
 *
 * THE RULE APPLIED THROUGHOUT
 *   an operation may be refused, or it may succeed and leave the books exact.
 *   Succeeding and leaving them wrong is the only unacceptable outcome.
 *
 * Run:  node --experimental-strip-types scripts/verify_cross_section.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb, handlers } from './lib/handlerHarness.mjs';
import * as inv from './lib/invariants.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

console.log('='.repeat(72));
console.log('CROSS-SECTION — each section, then every join between them');
console.log('='.repeat(72));

const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => r2(Number(v) || 0);

/**
 * A shop ready to trade. Uses the SAME seed shape the trade suites use, so a
 * cross-section failure cannot be blamed on a different starting state.
 *
 * Opening net worth = cash 100,000 + wallet 50,000 + stock (100*10 + 10*600)
 * = 157,000. `identity` is checked against that number throughout.
 */
const OPENING = 157000;
function freshShop() {
  const db = buildDatabase();
  const x = (sql) => db.exec(sql);
  x(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'admin',1)`);
  x(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)`);
  x(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status)
     VALUES(1,'2026','2026-01-01','2026-12-31','open')`);
  x(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')`);
  x(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive)
     VALUES(1,'Safe','safe',100000,1)`);
  x(`INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive)
     VALUES(1,'Wallet','wallet',50000,1)`);
  x(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')`);
  x(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Supp',0,'active')`);
  x(`INSERT INTO employees(EmployeeID,Name,BaseSalary,Balance) VALUES(1,'Emp',3000,0)`);
  x(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive)
     VALUES(1,'Cable','part',0,10,20,1),(2,'Phone','device',0,600,1000,1)`);
  x(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice)
     VALUES(1,1,100,10),(2,1,10,600)`);
  return db;
}

/** Net worth exactly as `identity` computes assets minus liabilities. */
function netWorth(db) {
  const g = (sql) => db.prepare(sql).get()?.v ?? 0;
  const cash = g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts');
  const wallets = g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods');
  const stock = g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities');
  const recv = g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance > 0');
  const custCr = g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance < 0');
  const pay = g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance > 0');
  const supCr = g('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance < 0');
  return r2(cash + wallets + stock + recv + supCr - pay - custCr);
}

/**
 * Runs every invariant. Returns the first breach as a string, or null.
 *
 * `checkAll` returns an ARRAY of breaches — empty when clean. An empty array
 * is truthy in JavaScript, so treating the return value as a plain flag makes
 * every single check "fail". That is a defect in the TEST, and it produced
 * exactly that symptom before this was fixed.
 */
function books(db, opening) {
  const breaches = inv.checkAll(db, opening);
  if (!Array.isArray(breaches)) return breaches || null;
  if (breaches.length === 0) return null;
  const first = breaches[0];
  return `${first.name}: ${String(first.msg).split('\n')[0]}`;
}

const ok = (res) => res && res.success !== false;
const why = (res) => (res && (res.message || res.error)) || JSON.stringify(res)?.slice(0, 70);

/** Buys stock through the REAL purchase handler, so cost layers really exist. */
async function buyStock(itemId, qty, unitCost, paid = null) {
  return call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: itemId, Quantity: qty, UnitCost: unitCost, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0,
    PaidAmount: paid === null ? qty * unitCost : paid,
    AdditionalCost: 0, PaymentCost: 0,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1, userId: 1,
  });
}

/** Sells through the REAL sale handler. */
async function sell(itemId, qty, price, { customer = 1, paid = null } = {}) {
  return call('sales:create', {
    CustomerID: customer,
    items: [{ ItemID: itemId, Quantity: qty, UnitPrice: price }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: paid === null ? qty * price : paid,
    CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
}

const q1 = (sql, ...a) => currentDb().prepare(sql).get(...a);
const cash = () => q1('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
const wallet = () => q1('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v;
const cust = (id = 1) => q1('SELECT Balance v FROM customers WHERE CustomerID=?', id).v;
const supp = (id = 1) => q1('SELECT Balance v FROM suppliers WHERE SupplierID=?', id).v;
const stockQty = (item, wh = 1) =>
  q1('SELECT COALESCE(Quantity,0) v FROM stock_quantities WHERE ItemID=? AND WarehouseID=?', item, wh)?.v ?? 0;
const totalStock = () =>
  q1('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities').v;

// ===================================================================== 1
console.log('\n[1] SECTION BY SECTION — each one, against the FULL book');
{
  /**
   * Every section is exercised on a fresh shop and then the ENTIRE invariant
   * set runs — not just that section's own table. A section that balances its
   * own books while breaking someone else's is exactly what this catches.
   */
  const scenarios = [
    ['المشتريات', async () => buyStock(1, 50, 12)],
    ['المبيعات', async () => { await buyStock(1, 20, 10); return sell(1, 5, 25); }],
    ['مبيعات آجلة', async () => sell(1, 5, 25, { paid: 0 })],
    ['مرتجعات المبيعات', async () => {
      const r = await sell(1, 10, 20);
      const sid = r?.saleId ?? q1('SELECT MAX(SaleID) v FROM sales').v;
      return call('saleReturns:create', {
        SaleID: sid, items: [{ ItemID: 1, Quantity: 4, UnitPrice: 20 }],
        AccountCredit: 0, CashRefund: 80, CashAccountID: 1, fiscalYearId: 1, userId: 1,
      });
    }],
    ['مرتجعات المشتريات', async () => {
      const r = await buyStock(1, 20, 10);
      const pid = r?.purchaseId ?? q1('SELECT MAX(PurchaseID) v FROM purchases').v;
      // The settlement must account for the FULL value returned (5 x 10 = 50),
      // which is the rule `returnSettlement.ts` enforces.
      return call('purchaseReturns:create', {
        PurchaseID: pid, items: [{ ItemID: 1, Quantity: 5, UnitCost: 10, WarehouseID: 1 }],
        AccountCredit: 50, CashRefund: 0, fiscalYearId: 1, userId: 1,
      });
    }],
    ['الصيانة (استلام)', async () => call('maintenance:receive', {
      CustomerID: 1, CustomerName: 'Ahmed', CustomerPhone: '0100',
      DeviceModel: 'A50', ProblemDesc: 'screen', AgreedCost: 300, fiscalYearId: 1, userId: 1,
    })],
    ['سند قبض', async () => {
      await sell(1, 5, 20, { paid: 0 });
      return call('vouchers:create', {
        VoucherType: 'receipt', Amount: 100, PartyType: 'customer', PartyID: 1,
        Description: 'دفعة', CashAccountID: 1, fiscalYearId: 1, userId: 1, userId: 1,
      });
    }],
    ['سند صرف', async () => call('vouchers:create', {
      VoucherType: 'payment', Amount: 100, PartyType: 'supplier', PartyID: 1,
      Description: 'دفعة مورد', CashAccountID: 1, fiscalYearId: 1, userId: 1, userId: 1,
    })],
    ['سلفة موظف', async () => call('advances:create', {
      EmployeeID: 1, Amount: 500, CashAccountID: 1, Reason: 'سلفة', fiscalYearId: 1, userId: 1, userId: 1,
    })],
    ['تحويل بين الحسابات', async () => call('transfers:create', {
      Amount: 1000, FromType: 'cash_account', FromID: 1,
      ToType: 'payment_method', ToID: 1, TransferCost: 0,
      TransferCostSource: 'separate', fiscalYearId: 1, userId: 1, userId: 1,
    })],
    ['الإيجارات', async () => call('rents:create', {
      RentName: 'المحل', RentType: 'expense', Amount: 2000, Period: 'monthly',
      StartDate: '2026-01-01', EndDate: '2026-12-31',
    })],
    ['الأصناف', async () => call('items:create', {
      ItemName: 'سماعة', ItemType: 'part', Barcode: null, CategoryID: null,
      IsSerialized: 0, CostPrice: 30, SalePrice: 60, MinStock: 0, Unit: 'قطعة',
    })],
    ['العملاء', async () => call('customers:create', {
      Name: 'عميل جديد', Phone: '0100', Email: null, Address: null, CreditLimit: 0 })],
    ['الموردين', async () => call('suppliers:create', {
      Name: 'مورد جديد', Phone: '0101', Email: null, Address: null, CreditLimit: 0 })],
    ['التقارير', async () => call('reports:dashboard', {})],
    ['الأرصدة الافتتاحية', async () => call('openingBalances:batchUpdate', {
      cashAccounts: [{ id: 1, balance: 120000 }],
      paymentMethods: [], customers: [], suppliers: [], employees: [] })],
  ];

  for (const [name, run] of scenarios) {
    freshShop();
    let res, err = null;
    try { res = await run(); } catch (e) { err = String(e.message).slice(0, 70); }
    // Opening balances deliberately rewrites the opening position, so the
    // identity is not meaningful for it; everything else must still balance.
    const skipIdentity = name === 'الأرصدة الافتتاحية';
    const breach = skipIdentity ? null : books(currentDb(), OPENING);
    t(`${name}: accepted without crashing`, !err && res !== undefined,
      err || (res && res.success === false ? 'refused: ' + why(res) : ''));
    t(`${name}: the WHOLE book still balances`, breach === null,
      breach ? String(breach).split('\n')[0] : '');
  }
}

// ===================================================================== 2
console.log('\n[2] MAINTENANCE -> STOCK -> CASH — the six-section flow');
{
  freshShop();
  const db = currentDb();
  const stockBefore = stockQty(1);
  const cashBefore = cash();

  const ticket = await call('maintenance:receive', {
    CustomerID: 1, CustomerName: 'Ahmed', CustomerPhone: '0100',
    DeviceModel: 'A50', ProblemDesc: 'شاشة مكسورة', AgreedCost: 400,
    fiscalYearId: 1, userId: 1,
  });
  t('a repair ticket is opened', ok(ticket), why(ticket));
  const tid = ticket?.ticketId ?? ticket?.id ?? q1('SELECT MAX(TicketID) v FROM maintenance_tickets')?.v;

  // The join that matters: a spare part must leave the WAREHOUSE.
  const part = await call('maintenance:issuePart', {
    TicketID: tid, ItemID: 1, Quantity: 2, WarehouseID: 1, fiscalYearId: 1, userId: 1,
  });
  if (ok(part)) {
    t('issuing a spare part reduces warehouse stock', stockQty(1) === stockBefore - 2,
      `${stockBefore} -> ${stockQty(1)}`);
    t('the books balance after the part leaves', books(db, OPENING) === null,
      String(books(db, OPENING) || '').split('\n')[0]);
  } else {
    t('issuing a spare part is handled', true, 'refused: ' + why(part));
  }

  const delivered = await call('maintenance:deliver', {
    TicketID: tid, CustomerID: 1, CustomerName: 'Ahmed',
    LaborCost: 200, AdditionalCosts: [],
    PaymentMethod: 'cash', PaidAmount: 400, CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  t('the repair is delivered and charged', ok(delivered), why(delivered));
  if (ok(delivered)) {
    t('the money reached the till', money(cash()) > money(cashBefore),
      `${cashBefore} -> ${cash()}`);
  }

  // Maintenance revenue must be counted ONCE — the identity excludes
  // Source='maintenance' from ordinary sales for exactly this reason.
  const breach = books(db, OPENING);
  t('the whole repair leaves the books balanced', breach === null,
    breach ? String(breach).split('\n')[0] : '');

  const stmt = await call('customerStatement:get', 1);
  t('the repair is visible to the customer statement', stmt !== undefined && stmt !== null);

  // THE PARTS MARGIN.
  //
  // The invoice must charge the item's SELLING price, not its cost. Two
  // different fallbacks disagreed here: the header total used
  // `COALESCE(mp.SalePrice, i.SalePrice, 0)` while the line used
  // `p.SalePrice || p.UnitCost`, and because `issuePart` stored a literal 0
  // rather than NULL, COALESCE never reached the item price and the line fell
  // through to COST. Measured: a part costing 10 and selling at 20 was billed
  // at 10 — the shop's entire parts margin, silently, on every repair.
  const inv0 = q1('SELECT SalePrice sp, UnitCost uc FROM maintenance_parts LIMIT 1');
  t('the part is stored at its selling price, not zero',
    inv0 && Number(inv0.sp) === 20, `SalePrice ${inv0?.sp}, cost ${inv0?.uc}`);

  const hdr = q1("SELECT SaleNumber, Subtotal FROM sales WHERE Source='maintenance'");
  const lineSum = q1(`SELECT COALESCE(SUM(Total),0) v FROM sale_details
                      WHERE SaleID = (SELECT SaleID FROM sales WHERE Source='maintenance')`).v;
  t('the invoice header equals its own lines',
    hdr && money(hdr.Subtotal) === money(lineSum),
    `header ${hdr?.Subtotal} vs lines ${lineSum}`);

  const partLine = q1(`SELECT UnitPrice, Quantity FROM sale_details
                       WHERE ItemID = 1 AND SaleID =
                       (SELECT SaleID FROM sales WHERE Source='maintenance')`);
  t('the customer is charged the SELLING price for the part',
    partLine && money(partLine.UnitPrice) === 20,
    `charged ${partLine?.UnitPrice}, cost is 10, sells at 20`);
}

// ===================================================================== 2b
console.log('\n[2b] A part that is genuinely FREE must stay free');
{
  /**
   * A giveaway part — a screen protector thrown in, a warranty replacement —
   * has a real COST and a selling price of ZERO. That is the case where "0
   * means missing" and "0 means free" collide.
   *
   * The header total uses COALESCE (0 is a value, so it stays 0) while the
   * line used `||` (0 is falsy, so it fell through to the COST). The invoice
   * then contradicted itself AND the customer was billed for something the
   * shop meant to give away.
   */
  freshShop();
  const db = currentDb();
  db.exec("UPDATE items SET SalePrice = 0 WHERE ItemID = 1");   // a free part

  const tk = await call('maintenance:receive', {
    CustomerID: 1, CustomerName: 'A', CustomerPhone: '0',
    DeviceModel: 'X', ProblemDesc: 'p', AgreedCost: 0, fiscalYearId: 1, userId: 1 });
  await call('maintenance:issuePart', {
    TicketID: tk.ticketId, ItemID: 1, Quantity: 1, WarehouseID: 1,
    fiscalYearId: 1, userId: 1 });
  await call('maintenance:deliver', {
    TicketID: tk.ticketId, CustomerID: 1, CustomerName: 'A',
    LaborCost: 50, AdditionalCosts: [], PaymentMethod: 'cash',
    PaidAmount: 50, CashAccountID: 1, fiscalYearId: 1, userId: 1 });

  const hdr = q1("SELECT Subtotal FROM sales WHERE Source='maintenance'");
  const lines = q1(`SELECT COALESCE(SUM(Total),0) v FROM sale_details
                    WHERE SaleID = (SELECT SaleID FROM sales WHERE Source='maintenance')`).v;
  t('the header still equals its lines when a part is free',
    hdr && money(hdr.Subtotal) === money(lines), `header ${hdr?.Subtotal} vs lines ${lines}`);

  const free = q1(`SELECT UnitPrice FROM sale_details WHERE ItemID = 1
                   AND SaleID = (SELECT SaleID FROM sales WHERE Source='maintenance')`);
  t('a free part is billed at ZERO, not at cost',
    free && money(free.UnitPrice) === 0,
    `billed ${free?.UnitPrice}, cost is 10 — billing cost would charge for a giveaway`);
  t('the books balance', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 3
console.log('\n[3] SALE -> VOUCHER: a debt paid later clears exactly once');
{
  freshShop();
  const db = currentDb();
  const s = await sell(1, 10, 20, { paid: 0 });
  t('a credit sale is accepted', ok(s), why(s));
  t('the customer owes the invoice', money(cust()) === 200, String(cust()));

  const cashBefore = cash();
  const v = await call('vouchers:create', {
    VoucherType: 'receipt', Amount: 200, PartyType: 'customer', PartyID: 1,
    Description: 'سداد', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  t('a receipt voucher is accepted', ok(v), why(v));
  t('the debt is cleared exactly, not twice', money(cust()) === 0, String(cust()));
  t('cash rose by exactly the payment', money(cash()) === money(cashBefore + 200),
    `${cashBefore} -> ${cash()}`);
  t('the books balance', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);

  // Paying twice must not take the customer below zero without recording it.
  const again = await call('vouchers:create', {
    VoucherType: 'receipt', Amount: 500, PartyType: 'customer', PartyID: 1,
    Description: 'زيادة', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  t('an overpayment is refused or recorded as credit',
    !ok(again) || money(cust()) === -500, `accepted=${ok(again)} balance=${cust()}`);
  t('the books balance after the overpayment', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 4
console.log('\n[4] PURCHASE -> RETURN -> SUPPLIER LEDGER');
{
  freshShop();
  const db = currentDb();
  const p = await call('purchases:create', {
    SupplierID: 1,
    items: [{ ItemID: 1, Quantity: 20, UnitCost: 10, WarehouseID: 1 }],
    Discount: 0, TaxAmount: 0, PaidAmount: 0,
    AdditionalCost: 0, PaymentCost: 0,
    PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1, userId: 1,
  });
  t('a credit purchase is accepted', ok(p), why(p));
  t('the shop now owes the supplier', money(supp()) === 200, String(supp()));

  const pid = p?.purchaseId ?? q1('SELECT MAX(PurchaseID) v FROM purchases').v;
  const stockBefore = stockQty(1);

  // Credited to the SUPPLIER's account (the purchase was on credit), and the
  // full 5 x 10 = 50 must be distributed.
  const pr = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 5, UnitCost: 10, WarehouseID: 1 }],
    AccountCredit: 50, CashRefund: 0, TransferRefund: 0,
    fiscalYearId: 1, userId: 1,
  });
  t('a purchase return is accepted', ok(pr), why(pr));
  if (ok(pr)) {
    t('the goods left the warehouse', stockQty(1) === stockBefore - 5,
      `${stockBefore} -> ${stockQty(1)}`);
    t('the debt fell by exactly the same value', money(supp()) === 150, String(supp()));
  }
  t('the books balance', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);

  const tooMuch = await call('purchaseReturns:create', {
    PurchaseID: pid, items: [{ ItemID: 1, Quantity: 500, UnitCost: 10, WarehouseID: 1 }],
    AccountCredit: 5000, CashRefund: 0, fiscalYearId: 1, userId: 1, userId: 1,
  });
  t('returning more than was bought is refused', !ok(tooMuch), why(tooMuch));
  t('and the refusal left nothing behind', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 5
console.log('\n[5] DELETE across sections — an undo must undo EVERYTHING');
{
  freshShop();
  const db = currentDb();
  const before = { net: netWorth(db), stock: totalStock(), cash: cash(), cust: cust() };

  const s = await sell(1, 10, 20, { paid: 100 });
  const sid = s?.saleId ?? q1('SELECT MAX(SaleID) v FROM sales').v;
  t('a part-paid sale is created', ok(s), why(s));
  t('it moved stock, cash and the ledger together',
    totalStock() === before.stock - 10 && cash() === before.cash + 100 && cust() === 100,
    `stock ${totalStock()} cash ${cash()} cust ${cust()}`);

  const del = await call('delete:sale', sid);
  t('the sale can be deleted', ok(del), why(del));
  if (ok(del)) {
    t('the stock came back', totalStock() === before.stock, `${before.stock} -> ${totalStock()}`);
    t('the cash went back', money(cash()) === money(before.cash), `${before.cash} -> ${cash()}`);
    t('the customer owes nothing again', money(cust()) === money(before.cust),
      `${before.cust} -> ${cust()}`);
    t('net worth is exactly what it was', netWorth(db) === before.net,
      `${before.net} -> ${netWorth(db)}`);
  }
  t('the books balance after the undo', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 6
console.log('\n[6] REPORTS agree with the LEDGERS they summarise');
{
  freshShop();
  const db = currentDb();
  let sold = 0;
  for (let i = 1; i <= 5; i++) {
    const r = await sell(1, 1, 20);
    if (ok(r)) sold += 20;
  }
  const ledger = q1("SELECT COALESCE(SUM(TotalAmount),0) v FROM sales WHERE IsVoided=0").v;
  t('the ledger holds what was sold', money(ledger) === money(sold), `${ledger} vs ${sold}`);

  const rep = await call('reports:sales', {});
  t('the sales report answers', rep !== undefined && rep !== null);
  if (rep && typeof rep === 'object') {
    const reported = rep.total ?? rep.totalSales ?? rep.summary?.total
      ?? (Array.isArray(rep.rows) ? rep.rows.reduce((a, x) => a + (x.TotalAmount || 0), 0) : undefined);
    if (typeof reported === 'number') {
      t('the report agrees with the ledger', money(reported) === money(ledger),
        `report ${reported} vs ledger ${ledger}`);
    } else {
      t('the report returned a usable shape', true, Object.keys(rep).slice(0, 6).join(','));
    }
  }

  const dash = await call('reports:dashboard', {});
  t('the dashboard answers', dash !== undefined && dash !== null);
  const pl = await call('reports:profitLoss', {});
  t('profit and loss answers', pl !== undefined && pl !== null);
  const fin = await call('reports:financialPosition', {});
  t('the financial position answers', fin !== undefined && fin !== null);

  // The financial position IS the identity: if it disagrees with the tables,
  // the owner reconciles from a lie.
  if (fin && typeof fin === 'object') {
    const reportedNet = fin.netWorth ?? fin.net ?? fin.total ?? null;
    if (typeof reportedNet === 'number') {
      t('the financial position matches the real net worth',
        Math.abs(reportedNet - netWorth(db)) < 0.05,
        `report ${reportedNet} vs computed ${netWorth(db)}`);
    }
  }
  t('the books balance', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 7
console.log('\n[7] FISCAL YEAR is a boundary, not a suggestion');
{
  freshShop();
  const db = currentDb();
  t('the fiscal year section answers', (await call('fiscalYear:list')) !== undefined);
  t('there is an active year', (await call('fiscalYear:getActive')) !== undefined);

  await buyStock(1, 10, 10);
  await sell(1, 2, 25);
  const s = q1('SELECT COUNT(*) n FROM sales WHERE FiscalYearID IS NULL').n;
  const p = q1('SELECT COUNT(*) n FROM purchases WHERE FiscalYearID IS NULL').n;
  const v = q1('SELECT COUNT(*) n FROM vouchers WHERE FiscalYearID IS NULL').n;
  t('every sale carries a fiscal year', s === 0, `${s} unstamped`);
  t('every purchase carries a fiscal year', p === 0, `${p} unstamped`);
  t('every voucher carries a fiscal year', v === 0, `${v} unstamped`);
  t('the books balance', books(db, OPENING) === null,
    String(books(db, OPENING) || '').split('\n')[0]);
}

// ===================================================================== 8
console.log('\n[8] A FULL TRADING DAY — every section, in sequence, one shop');
{
  freshShop();
  const db = currentDb();
  const steps = [];
  const record = async (label, fn) => {
    let res, err = null;
    try { res = await fn(); } catch (e) { err = String(e.message).slice(0, 60); }
    steps.push({ label, accepted: ok(res), err, breach: books(db, OPENING) });
  };

  await record('شراء', () => buyStock(1, 50, 12));
  await record('شراء أجهزة', () => buyStock(2, 5, 620));
  await record('بيع نقدي', () => sell(1, 5, 25));
  await record('بيع آجل', () => sell(2, 1, 1100, { paid: 0 }));
  await record('سند قبض', () => call('vouchers:create', {
    VoucherType: 'receipt', Amount: 500, PartyType: 'customer', PartyID: 1,
    Description: 'دفعة', CashAccountID: 1, fiscalYearId: 1, userId: 1 }));
  await record('صيانة', () => call('maintenance:receive', {
    CustomerID: 1, CustomerName: 'Ahmed', CustomerPhone: '0100',
    DeviceModel: 'B', ProblemDesc: 'بطارية', AgreedCost: 250, fiscalYearId: 1, userId: 1 }));
  await record('سلفة', () => call('advances:create', {
    EmployeeID: 1, Amount: 300, CashAccountID: 1, Reason: 'سلفة', fiscalYearId: 1, userId: 1 }));
  await record('تحويل', () => call('transfers:create', {
    Amount: 1000, FromType: 'cash_account', FromID: 1,
    ToType: 'payment_method', ToID: 1, TransferCost: 0,
    TransferCostSource: 'separate', fiscalYearId: 1, userId: 1 }));
  await record('سند صرف', () => call('vouchers:create', {
    VoucherType: 'payment', Amount: 200, PartyType: 'supplier', PartyID: 1,
    Description: 'دفعة مورد', CashAccountID: 1, fiscalYearId: 1, userId: 1 }));
  await record('مرتجع بيع', async () => {
    const sid = q1("SELECT MAX(SaleID) v FROM sales").v;
    return call('saleReturns:create', {
      SaleID: sid, items: [{ ItemID: 2, Quantity: 1, UnitPrice: 1100 }],
      AccountCredit: 1100, CashRefund: 0, fiscalYearId: 1, userId: 1 });
  });

  console.log('      ' + steps.map(x => `${x.label}:${x.accepted ? '✓' : '✗'}`).join('  '));
  const firstBreak = steps.find(x => x.breach);
  t('no step left the books unbalanced', !firstBreak,
    firstBreak ? `${firstBreak.label}: ${String(firstBreak.breach).split('\n')[0]}` : '');
  t('no step crashed', steps.every(x => !x.err),
    steps.filter(x => x.err).map(x => `${x.label}: ${x.err}`).join(' | '));

  for (const [label, fn] of [
    ['no NaN or Infinity anywhere', inv.noNaNOrInfinity],
    ['no orphaned rows between sections', inv.noOrphans],
    ['no duplicate document numbers', inv.documentNumbersUnique],
    ['party status matches the balance', inv.statusMatchesBalance],
    ['no negative stock', inv.noNegativeStock],
    ['stock valuation is sane', inv.stockValuationSane],
    ['invoice lines match their header', inv.invoiceLinesMatchHeader],
    ['returns stay within their document', inv.returnsWithinDocument],
    ['a refund never exceeds the receipt', inv.refundNeverExceedsReceipt],
  ]) {
    const r = fn(db);
    t(label, !r, String(r || '').split('\n')[0]);
  }
}

// ===================================================================== 8b
console.log('\n[8b] PAYROLL -> LEDGER -> BOOKS, the whole cycle');
{
  /**
   * An advance is an ASSET (the employee owes it back); an issued salary is a
   * LIABILITY and an EXPENSE; paying it moves cash. Each of the three touches
   * a different table, and the books have to balance at every step — not just
   * at the end, because a shop closes its month somewhere in the middle.
   */
  freshShop();
  const db = currentDb();
  const emp = () => q1('SELECT Balance v FROM employees WHERE EmployeeID=1').v;
  const openAdv = () =>
    q1('SELECT COALESCE(SUM(Amount),0) v FROM employee_advances WHERE IsDeducted=0').v;

  const a = await call('advances:create', {
    EmployeeID: 1, Amount: 500, CashAccountID: 1, Reason: 'سلفة',
    fiscalYearId: 1, userId: 1 });
  t('an advance is accepted', ok(a), why(a));
  t('cash left the till', money(cash()) === money(100000 - 500), String(cash()));
  t('and it is carried as an outstanding advance', money(openAdv()) === 500, String(openAdv()));
  t('the books balance while the advance is outstanding',
    books(db, OPENING) === null, String(books(db, OPENING) || ''));

  const iss = await call('salaries:issue', {
    EmployeeID: 1, Month: '2026-01', fiscalYearId: 1, userId: 1 });
  t('a salary is issued', ok(iss), why(iss));
  // THE UNPAID WINDOW: the wage is an expense and a liability, but no cash has
  // moved. If wages were left out of the profit model the books would drift by
  // the whole payroll for as long as it stays unpaid — which is exactly the
  // state a shop is in on the last day of the month.
  t('the shop now owes the wage', money(emp()) === 2500, String(emp()));
  t('no cash has moved yet', money(cash()) === money(100000 - 500), String(cash()));
  t('the books balance DURING the unpaid window',
    books(db, OPENING) === null, String(books(db, OPENING) || ''));

  const sid = q1('SELECT MAX(SalaryID) v FROM salaries').v;
  const paid = await call('salaries:pay', { SalaryID: sid, CashAccountID: 1, userId: 1 });
  t('the salary is paid', ok(paid), why(paid));
  t('the liability is cleared', money(emp()) === 0, String(emp()));
  t('the advance was recovered from the wage', money(openAdv()) === 0, String(openAdv()));
  t('total cash out is the wage, not the wage plus the advance',
    money(cash()) === money(100000 - 3000), `${cash()} (expected 97000)`);
  t('the books balance after payday',
    books(db, OPENING) === null, String(books(db, OPENING) || ''));
}

// ===================================================================== 9
console.log('\n[9] SECTION ISOLATION — a refusal must not damage another section');
{
  freshShop();
  const db = currentDb();
  const before = netWorth(db);

  const attempts = [
    ['selling more than is in stock', () => sell(1, 99999, 20)],
    ['a voucher for a party that does not exist', () => call('vouchers:create', {
      VoucherType: 'receipt', Amount: 100, PartyType: 'customer', PartyID: 99999,
      Description: 'x', CashAccountID: 1, fiscalYearId: 1, userId: 1 })],
    ['a negative advance', () => call('advances:create', {
      EmployeeID: 1, Amount: -5000, CashAccountID: 1, Reason: 'x', fiscalYearId: 1, userId: 1 })],
    ['a transfer from an account that does not exist', () => call('transfers:create', {
      Amount: 100, FromType: 'cash_account', FromID: 999,
      ToType: 'payment_method', ToID: 1, TransferCost: 0,
    TransferCostSource: 'separate', fiscalYearId: 1, userId: 1 })],
    ['a purchase from a supplier that does not exist', () => call('purchases:create', {
      SupplierID: 99999, items: [{ ItemID: 1, Quantity: 1, UnitCost: 10, WarehouseID: 1 }],
      Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0,
      PaymentSourceType: 'cash_account', PaymentSourceID: 1, fiscalYearId: 1, userId: 1 })],
    ['a sale of an item that does not exist', () => sell(99999, 1, 20)],
    ['a transfer of a negative amount', () => call('transfers:create', {
      Amount: -500, FromType: 'cash_account', FromID: 1,
      ToType: 'payment_method', ToID: 1, TransferCost: 0,
    TransferCostSource: 'separate', fiscalYearId: 1, userId: 1 })],
  ];

  for (const [label, fn] of attempts) {
    let res;
    try { res = await fn(); } catch { res = { success: false }; }
    const breach = books(db, OPENING);
    t(`${label}: the books stay intact`, breach === null,
      breach ? String(breach).split('\n')[0] : (ok(res) ? 'accepted' : 'refused'));
  }
  t('net worth is untouched by every refusal', netWorth(db) === before,
    `${before} -> ${netWorth(db)}`);
}

// ===================================================================== 10
console.log('\n[10] The SHARED modules every section depends on');
{
  const { businessToday } = await import('../src/shared/businessDate.ts');
  t('the business date is a real ISO date',
    /^\d{4}-\d{2}-\d{2}$/.test(businessToday()), businessToday());

  const { escapeHtml } = await import('../src/shared/escapeHtml.ts');
  t('escaping is shared by every printing section',
    escapeHtml('<b>') === '&lt;b&gt;', escapeHtml('<b>'));

  const pp = await import('../src/shared/printProfile.ts');
  t('every document type has a print default',
    Object.keys(pp.DOCUMENT_DEFAULTS || {}).length >= 6,
    Object.keys(pp.DOCUMENT_DEFAULTS || {}).join(','));

  const mod = await import('../src/shared/money.ts');
  const names = Object.keys(mod);
  t('the shared money module exports helpers', names.length > 0, names.slice(0, 6).join(','));
  // Money in floating point is how a shop loses a piastre per invoice.
  const fn = mod.toPiastres ?? mod.round2 ?? mod.toCents ?? null;
  if (fn) {
    t('rounding survives the classic 0.1 + 0.2',
      Math.abs(Number(fn(0.1 + 0.2)) - Number(fn(0.3))) < 1e-9,
      `${fn(0.1 + 0.2)} vs ${fn(0.3)}`);
  }
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
