#!/usr/bin/env node
// SECTION 3 — SALES: the whole lifecycle through the REAL handlers on the
// REAL production stack (better-sqlite3 file DB, real connection.ts with its
// balance-rounding, bind-hardening and IMMEDIATE transactions, real
// migrations). Runs against the exact channel names the renderer uses.
//
// Covers the channels no existing script touches: sales:get, saleReturns:list,
// saleReturns:get, reports:customers — plus the lifecycle (cash/credit/walk-in
// sales, returns, edit, delete, delete-return), refusals, serialised units,
// cost restoration, and the report/statement agreement at the end.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');

const SELF = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SELF, '..');

const PASS = [];
const FAIL = [];
const t = (name, cond, detail = '') => {
  (cond ? PASS : FAIL).push(name);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n          ${detail}`}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const money = (n) => Math.round(n * 100) / 100;

globalThis.__FOUND_DIALOGS__ = { save: [], open: [] };

const electronStub = `
  const registry = (globalThis.__FOUND_HANDLERS__ ||= new Map());
  module.exports = {
    ipcMain: { handle: (c, f) => registry.set(c, f), removeHandler: (c) => registry.delete(c) },
    app: {
      getPath: (k) => { const p = globalThis.__FOUND_PATHS__;
        if (k === 'userData') return p.userData; if (k === 'temp') return p.temp;
        if (k === 'exe') return p.exe; return p.userData; },
      getVersion: () => '1.0.51', getName: () => 'mobile-shop-erp',
      getAppPath: () => globalThis.__FOUND_PATHS__.appPath,
      get isPackaged() { return !!globalThis.__FOUND_PACKAGED__; },
      quit: () => {}, whenReady: async () => {}, on: () => {},
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 1 }), showErrorBox: () => {},
    },
    shell: {}, contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => undefined, on() {} },
    webContents: { getAllWebContents: () => [] },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    Notification: class {},
  };
`;

const ENTRY = `
  export { runMigrations } from './src/main/database/migrations/index.ts';
  export { getDb, getDbPath } from './src/main/database/connection.ts';
  export { registerSalesHandlers } from './src/main/ipc/sales.handlers.ts';
  export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
  export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
  export { registerStatementHandlers, registerCustomerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_sales_entry.ts');
writeFileSync(entryFile, ENTRY);

const paths = {
  userData: mkdtempSync(join(tmpdir(), 'sales-user-')),
  temp: mkdtempSync(join(tmpdir(), 'sales-tmp-')),
  exe: join(mkdtempSync(join(tmpdir(), 'sales-exe-')), 'MobileShopERP', 'app.exe'),
  appPath: mkdtempSync(join(tmpdir(), 'sales-app-')),
};
globalThis.__FOUND_PATHS__ = paths;
globalThis.__FOUND_PACKAGED__ = false;

console.log('Building the real sales bundle…');
const out = await build({
  entryPoints: [entryFile],
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
  external: ['better-sqlite3', 'bcryptjs'],
  plugins: [{
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: electronStub, loader: 'js' }));
    },
  }],
});
const bundleFile = join(PROJECT_ROOT, '_sales_bundle.cjs');
writeFileSync(bundleFile, out.outputFiles[0].text);
const mod = require(bundleFile);
rmSync(bundleFile, { force: true });
rmSync(entryFile, { force: true });

const call = (channel, ...args) => {
  const fn = globalThis.__FOUND_HANDLERS__.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return fn({ sender: { id: 1 } }, ...args);
};

try {
  // ------------------------------------------------------------ setup
  const db = mod.getDb();
  mod.runMigrations(db);
  mod.registerSalesHandlers();
  mod.registerDeleteHandlers();
  mod.registerReportsHandlers();
  mod.registerStatementHandlers();
  mod.registerCustomerStatementHandlers();

  db.exec(`
    UPDATE cash_accounts SET Balance = 100000 WHERE CashAccountID = 1;
    INSERT INTO cash_accounts (CashAccountID, AccountName, AccountType, Balance, IsActive)
      VALUES (2, 'خزنة معطلة', 'safe', 0, 0);
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 0, 1), (2, 'ماكينة معطلة', 'card', 0, 0);
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status, CreditLimit)
      VALUES (1, 'عميل آجل', '0100', 0, 'active', 10000),
             (2, 'عميل محظور', '0101', 0, 'suspended', 0),
             (3, 'عميل الدقة', '0102', 0, 'active', 100000);
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'شاحن', 'accessory', 0, 10, 15, 1),
             (2, 'كابل', 'accessory', 0, 20, 30, 1),
             (3, 'موبايل', 'phone', 1, 100, 200, 1),
             (4, 'طرفية', 'accessory', 0, 5, 10, 1),
             (5, 'راوتر', 'accessory', 0, 10, 40, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 100, 10), (2, 1, 200, 20), (3, 1, 3, 100), (4, 1, 50, 5), (5, 1, 300, 10);
    INSERT INTO stock_lots (LotID, ItemID, WarehouseID, UnitCost, QtyReceived, QtyRemaining, SourceType, SourceID, Date)
      VALUES (1, 1, 1, 10, 100, 100, 'purchase', 1, '2026-01-01'),
             (2, 2, 1, 20, 200, 200, 'purchase', 1, '2026-01-01'),
             (3, 4, 1, 5, 50, 50, 'purchase', 1, '2026-01-01'),
             (4, 5, 1, 10, 300, 300, 'purchase', 1, '2026-01-01');
    INSERT INTO item_serials (SerialID, ItemID, IMEI, Status, CostPrice, WarehouseID)
      VALUES (1, 3, '35600001', 'available', 100, 1),
             (2, 3, '35600002', 'available', 100, 1),
             (3, 3, '35600003', 'available', 100, 1);
    -- The seeded books open with: cash 100000 + inventory at cost 8550.
    -- Mirrored as owner capital so the balance sheet's own identity check
    -- (assets = liabilities + equity) is meaningful for every op that follows.
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '108550');
  `);

  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  // sales:create answers with the document NUMBER, not the id — the renderer
  // re-locates by number. The suite does the same, from the real tables.
  const sid = (r) => q('SELECT SaleID v FROM sales WHERE SaleNumber = ?', r?.saleNumber)?.v;
  const rid = (r) => q('SELECT ReturnID v FROM sale_returns WHERE ReturnNumber = ?', r?.returnNumber)?.v;
  const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const stock = (id) => q('SELECT Quantity v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = 1', id).v;
  const bal = (id) => q('SELECT Balance v FROM customers WHERE CustomerID = ?', id).v;
  const serialStatus = (id) => q('SELECT Status v FROM item_serials WHERE SerialID = ?', id).v;
  const saleRow = (id) => q('SELECT * FROM sales WHERE SaleID = ?', id);
  const returnRow = (id) => q('SELECT * FROM sale_returns WHERE ReturnID = ?', id);

  const sell = (p) => call('sales:create', {
    userId: 1, fiscalYearId: 1, PaymentMethod: 'cash',
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    ...p,
  });

  console.log('SECTION 3 — SALES: full lifecycle on the real stack\n');

  // ---------------------------------------------------------------- 1
  console.log('[1] Cash sale — ledger, costs, and the never-tested sales:get/sales:list');
  {
    const r = await sell({
      CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 15 }, { ItemID: 2, Quantity: 3, UnitPrice: 30 }],
      PaidAmount: 165, CashAccountID: 1,
    });
    t('a cash sale succeeds', r?.success === true, JSON.stringify(r));
    t('the invoice number follows the SAL-yyyyMMdd-NNNN shape', /^SAL-\d{8}-\d{4}$/.test(r?.saleNumber || ''), String(r?.saleNumber));
    t('cash account received 165', near(cash(), 100165), String(cash()));
    t('stock of item 1 fell by 5', stock(1) === 95, String(stock(1)));
    t('stock of item 2 fell by 3', stock(2) === 197, String(stock(2)));
    t('a fully-paid customer sale changes no balance', bal(1) === 0, String(bal(1)));

    const g = await call('sales:get', sid(r));
    t('sales:get returns the header with the live customer name', g?.sale?.CustomerName === 'عميل آجل', JSON.stringify(g?.sale));
    t('sales:get returns the lines with item names', g?.details?.length === 2 && g?.details?.[0]?.ItemName === 'شاحن', JSON.stringify(g?.details));
    t('unit cost is the weighted average at the time of sale (10/20)',
      g?.details?.[0]?.UnitCost === 10 && g?.details?.[1]?.UnitCost === 20, JSON.stringify(g?.details));
    t('the invoice is completed with nothing remaining',
      g?.sale?.Status === 'completed' && g?.sale?.RemainingAmount === 0, JSON.stringify(g?.sale));

    const list = await call('sales:list', {});
    t('sales:list returns the invoice with the customer name joined',
      Array.isArray(list) && list.some(x => x.SaleNumber === r.saleNumber && x.CustomerName === 'عميل آجل'),
      JSON.stringify(list));
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Credit sale — balance, partial payment, return, delete-return');
  {
    const r2 = await sell({
      CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 15 }],
      PaidAmount: 100, CashAccountID: 1,
    });
    t('a partial-payment credit sale succeeds', r2?.success === true, JSON.stringify(r2));
    t('the customer owes the remaining 50', bal(1) === 50, String(bal(1)));
    t('the invoice is partial with 50 remaining',
      saleRow(2)?.Status === 'partial' && saleRow(2)?.RemainingAmount === 50, JSON.stringify(saleRow(2)));

    const r3 = await sell({
      CustomerID: 1, items: [{ ItemID: 1, Quantity: 3, UnitPrice: 15 }],
      PaidAmount: 0,
    });
    t('a fully-credit sale succeeds', r3?.success === true, JSON.stringify(r3));
    t('the balance accumulates to 95', bal(1) === 95, String(bal(1)));
    t('an unpaid sale is marked unpaid', saleRow(3)?.Status === 'unpaid', JSON.stringify(saleRow(3)));

    const st = await call('customerStatement:get', 1, {});
    t('the customer statement foots to the live balance', near(st?.totals?.netBalance, 95), JSON.stringify(st?.totals));

    const rt = await call('saleReturns:create', {
      SaleID: 2, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 15 }],
      userId: 1, AccountCredit: 30,
    });
    t('a credit return succeeds', rt?.success === true, JSON.stringify(rt));
    t('returning 2 units of the partial invoice leaves balance 65', bal(1) === 65, String(bal(1)));
    t('the invoice remaining is reduced to 20', saleRow(2)?.RemainingAmount === 20, String(saleRow(2)?.RemainingAmount));
    t('returned goods are back in stock at cost', stock(1) === 84, String(stock(1)));

    const ret = await call('saleReturns:returnable', 2);
    t('returnable reports what is still returnable (8 of 10)',
      Array.isArray(ret) && ret.some(x => x.ItemID === 1 && x.Returnable === 8), JSON.stringify(ret));

    const del =     await call('delete:saleReturn', rid(rt));
    t('deleting the return succeeds', del?.success === true, JSON.stringify(del));
    t('the balance goes back to 95', bal(1) === 95, String(bal(1)));
    t('the invoice remaining goes back to 50', saleRow(2)?.RemainingAmount === 50, String(saleRow(2)?.RemainingAmount));
    t('the goods leave stock again', stock(1) === 82, String(stock(1)));
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Walk-in rules and refusals — nothing moves on a refusal');
  {
    const w1 = await sell({ items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 0, CashAccountID: 1 });
    t('a walk-in unpaid is refused', w1?.success === false && /العميل النقدي يجب أن يدفع المبلغ كاملاً/.test(w1?.message), JSON.stringify(w1));
    const w2 = await sell({ items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 20, CashAccountID: 1 });
    t('a walk-in overpaid is refused', w2?.success === false && /لا يمكن استلام مبلغ أكبر من الفاتورة/.test(w2?.message), JSON.stringify(w2));
    const w3 = await sell({ items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 1 });
    t('a walk-in paid exactly succeeds', w3?.success === true, JSON.stringify(w3));

    const s1 = await sell({ CustomerID: 2, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 1 });
    t('a suspended customer is refused', s1?.success === false && /العميل محظور/.test(s1?.message), JSON.stringify(s1));
    const d1 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], Discount: 20, PaidAmount: 0 });
    t('a discount above the goods is refused', d1?.success === false && /أكبر من إجمالي الأصناف/.test(d1?.message), JSON.stringify(d1));
    const p1 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15 });
    t('money with no destination account is refused', p1?.success === false && /اختر مصدر استلام المبلغ/.test(p1?.message), JSON.stringify(p1));
    const p2 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 999 });
    t('a missing cash account is refused', p2?.success === false && /الخزنة المختارة غير موجودة/.test(p2?.message), JSON.stringify(p2));
    const p3 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 2 });
    t('an inactive cash account is refused', p3?.success === false && /غير مفعّلة/.test(p3?.message), JSON.stringify(p3));
    const p4 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, PaymentMethodID: 999 });
    t('a missing payment machine is refused', p4?.success === false && /ماكينة الدفع المختارة غير موجودة/.test(p4?.message), JSON.stringify(p4));

    const badQtys = [0, -1, NaN, Infinity];
    for (const qt of badQtys) {
      const r = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: qt, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 1 });
      t(`a quantity of ${qt} is refused`, r?.success === false && /الكمية يجب أن تكون رقماً أكبر من صفر/.test(r?.message), JSON.stringify(r));
    }
    const np = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: -5 }], PaidAmount: 0 });
    t('a negative price is refused', np?.success === false && /السعر يجب أن يكون رقماً غير سالب/.test(np?.message), JSON.stringify(np));

    const short = await sell({ CustomerID: 1, items: [{ ItemID: 4, Quantity: 60, UnitPrice: 10 }], PaidAmount: 600, CashAccountID: 1 });
    t('selling beyond stock is refused when negative stock is off',
      short?.success === false && /الرصيد غير كافي/.test(short?.message), JSON.stringify(short));

    db.prepare("UPDATE settings SET Value = '1' WHERE Key = 'allow_negative_stock'").run();
    const neg = await sell({ CustomerID: 1, items: [{ ItemID: 4, Quantity: 60, UnitPrice: 10 }], PaidAmount: 600, CashAccountID: 1 });
    t('with negative stock allowed, the sale goes through', neg?.success === true, JSON.stringify(neg));
    t('stock goes negative as configured', stock(4) === -10, String(stock(4)));
    db.prepare("UPDATE settings SET Value = '0' WHERE Key = 'allow_negative_stock'").run();
    const del = await call('delete:sale', sid(neg));
    t('deleting that sale restores the full count', del?.success === true && stock(4) === 50, JSON.stringify(del));

    const before = cash();
    t('every refusal left the cash untouched', near(cash(), before), '');
  }
  // The walk-in cash sale (id 4) is deleted at [7] — tracked there.

  // ---------------------------------------------------------------- 4
  console.log('\n[4] Serialised units — cost, status, re-sale refusal');
  {
    const r1 = await sell({
      CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, SerialID: 1, UnitPrice: 200 }],
      PaidAmount: 200, CashAccountID: 1,
    });
    t('selling a serialised unit succeeds', r1?.success === true, JSON.stringify(r1));
    t('the serial is marked sold', serialStatus(1) === 'sold', serialStatus(1));
    t('the warehouse count drops', stock(3) === 2, String(stock(3)));
    const g = await call('sales:get', sid(r1));
    t('the line records the serial cost, not the pool average', g?.details?.[0]?.UnitCost === 100, JSON.stringify(g?.details));

    const r2 = await sell({
      CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, SerialID: 1, UnitPrice: 200 }],
      PaidAmount: 200, CashAccountID: 1,
    });
    t('selling the same serial twice is refused', r2?.success === false && /غير متاح للبيع/.test(r2?.message), JSON.stringify(r2));

    const r3 = await sell({
      CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, SerialID: 2, UnitPrice: 200 }],
      PaidAmount: 200, CashAccountID: 1,
    });
    t('a second serial sells fine', r3?.success === true, JSON.stringify(r3));

    const rt = await call('saleReturns:create', {
      SaleID: sid(r3), items: [{ ItemID: 3, Quantity: 1, SerialID: 2, UnitPrice: 200 }],
      userId: 1, CashRefund: 200, CashAccountID: 1,
    });
    t('returning a serial succeeds', rt?.success === true, JSON.stringify(rt));
    t('the serial is available again', serialStatus(2) === 'available', serialStatus(2));
    t('the unit is back in the count', stock(3) === 2, String(stock(3)));

    const del = await call('delete:sale', sid(r1));
    t('deleting a serial sale succeeds', del?.success === true, JSON.stringify(del));
    t('the serial is available again after the delete', serialStatus(1) === 'available', serialStatus(1));
    t('the count is fully restored', stock(3) === 3, String(stock(3)));

    // r3's sale was returned: the sale cannot be deleted while the return
    // lives, so the return goes first, then the sale.
    const delR = await call('delete:saleReturn', rid(rt));
    t('the serial return deletes cleanly', delR?.success === true, JSON.stringify(delR));
    const delS = await call('delete:sale', sid(r3));
    t('the second serial sale deletes cleanly', delS?.success === true, JSON.stringify(delS));
    t('its serial is available once more', serialStatus(2) === 'available', serialStatus(2));
  }

  // ---------------------------------------------------------------- 5
  console.log('\n[5] Returns — effective price, caps, list/get, delete-return, re-sale protection');
  {
    const sale = await sell({
      CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 15 }],
      Discount: 20, PaidAmount: 130, CashAccountID: 1,
    });
    t('a discounted cash sale succeeds (130 total)', sale?.success === true, JSON.stringify(sale));

    const r1 = await call('saleReturns:create', {
      SaleID: sid(sale), items: [{ ItemID: 1, Quantity: 10, UnitPrice: 999 }],
      userId: 1, CashRefund: 130, CashAccountID: 1,
    });
    const r1row = q('SELECT ReturnID, TotalAmount FROM sale_returns WHERE ReturnNumber = ?', r1?.returnNumber);
    t('a full return succeeds', r1?.success === true, JSON.stringify(r1));
    t('the refund is the EFFECTIVE price (130), not the requested 999', r1row?.TotalAmount === 130, String(r1row?.TotalAmount));
    t('cash received the refund back', near(cash(), 100150 + 130), String(cash()));
    t('all 10 units are back in stock', stock(1) === 81, String(stock(1)));

    const list = await call('saleReturns:list', {});
    t('saleReturns:list returns the return with the invoice number joined',
      Array.isArray(list) && list.some(x => x.ReturnNumber === r1?.returnNumber && x.SaleNumber === sale.saleNumber),
      JSON.stringify(list));
    const g = await call('saleReturns:get', rid(r1));
    t('saleReturns:get returns the header with the totals', g?.header?.TotalAmount === 130, JSON.stringify(g?.header));
    t('saleReturns:get returns the line with item name and cost',
      g?.details?.length === 1 && g?.details?.[0]?.ItemName === 'شاحن' && g?.details?.[0]?.UnitCost === 10,
      JSON.stringify(g?.details));

    const over = await call('saleReturns:create', {
      SaleID: sid(sale), items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }],
      userId: 1, CashRefund: 13, CashAccountID: 1,
    });
    t('returning more than was sold is refused', over?.success === false && /أكبر من المتاح/.test(over?.message), JSON.stringify(over));
    const wrong = await call('saleReturns:create', {
      SaleID: sid(sale), items: [{ ItemID: 2, Quantity: 1, UnitPrice: 30 }],
      userId: 1, CashRefund: 30, CashAccountID: 1,
    });
    t('returning an item not on the invoice is refused', wrong?.success === false && /غير موجود في الفاتورة الأصلية/.test(wrong?.message), JSON.stringify(wrong));
    const bad = await call('saleReturns:create', {
      SaleID: sid(sale), items: [{ ItemID: 1, Quantity: NaN, UnitPrice: 15 }],
      userId: 1,
    });
    t('a NaN return quantity is refused', bad?.success === false && /الكمية المرتجعة/.test(bad?.message), JSON.stringify(bad));

    // Double-claim: one payload must not pass the cap twice.
    const s2 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 15 }], PaidAmount: 30, CashAccountID: 1 });
    const dup = await call('saleReturns:create', {
      SaleID: sid(s2), items: [{ ItemID: 1, Quantity: 2, UnitPrice: 15 }],
      userId: 1, CashRefund: 30, CashAccountID: 1,
    });
    t('a same-payload double claim of a 2-unit invoice returns 2', dup?.success === true, JSON.stringify(dup));
    const dup2 = await call('saleReturns:create', {
      SaleID: sid(s2), items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }],
      userId: 1, CashRefund: 15, CashAccountID: 1,
    });
    t('nothing is left to return after the claim', dup2?.success === false && /أكبر من المتاح/.test(dup2?.message), JSON.stringify(dup2));
    const delDup = await call('delete:saleReturn', rid(dup));
    t('the duplicate return deletes cleanly', delDup?.success === true, JSON.stringify(delDup));

    // Re-sale protection: a returned DEVICE that was sold again cannot have
    // the return cancelled — the named unit is gone, so undoing the return
    // would hand it back to the first customer and leave the count short.
    const s3 = await sell({ CustomerID: 1, items: [{ ItemID: 2, Quantity: 2, UnitPrice: 30 }], PaidAmount: 60, CashAccountID: 1 });
    const rt3 = await call('saleReturns:create', {
      SaleID: sid(s3), items: [{ ItemID: 2, Quantity: 1, UnitPrice: 30 }],
      userId: 1, CashRefund: 30, CashAccountID: 1,
    });
    t('returning 1 of 2 cables succeeds', rt3?.success === true, JSON.stringify(rt3));
    const resell = await sell({ CustomerID: 1, items: [{ ItemID: 2, Quantity: 1, UnitPrice: 30 }], PaidAmount: 30, CashAccountID: 1 });
    t('re-selling the returned unit succeeds', resell?.success === true, JSON.stringify(resell));
    const delResell = await call('delete:saleReturn', rid(rt3));
    t('a pooled return whose unit was re-sold still cancels (quantity is covered)',
      delResell?.success === true, JSON.stringify(delResell));

    // A serialised device IS guarded: the unit itself must still be here.
    const ser = await sell({ CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, SerialID: 1, UnitPrice: 200 }], PaidAmount: 200, CashAccountID: 1 });
    const rtSer = await call('saleReturns:create', {
      SaleID: sid(ser), items: [{ ItemID: 3, Quantity: 1, SerialID: 1, UnitPrice: 200 }],
      userId: 1, CashRefund: 200, CashAccountID: 1,
    });
    t('returning a serialised device succeeds', rtSer?.success === true, JSON.stringify(rtSer));
    const re = await sell({ CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, SerialID: 1, UnitPrice: 200 }], PaidAmount: 200, CashAccountID: 1 });
    t('re-selling the returned device succeeds', re?.success === true, JSON.stringify(re));
    const delSer = await call('delete:saleReturn', rid(rtSer));
    t('deleting the return of a re-sold device is refused',
      delSer?.success === false && /لم تعد بالمخزن/.test(delSer?.message), JSON.stringify(delSer));
    t('nothing moved while it was refused', serialStatus(1) === 'sold', serialStatus(1));
    const delRe = await call('delete:sale', sid(re));
    t('the re-sale deletes cleanly', delRe?.success === true, JSON.stringify(delRe));
    const delSer2 = await call('delete:saleReturn', rid(rtSer));
    t('with the re-sale gone the return cancels cleanly', delSer2?.success === true, JSON.stringify(delSer2));
    const delSer3 = await call('delete:sale', sid(ser));
    t('and the original sale deletes cleanly', delSer3?.success === true, JSON.stringify(delSer3));
    t('the device is available again', serialStatus(1) === 'available', serialStatus(1));
  }

  // ---------------------------------------------------------------- 6
  console.log('\n[6] sales:update — reverse-and-reissue, refusals');
  {
    const s = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 15 }], PaidAmount: 0 });
    const st0 = stock(1);
    t('a credit sale to edit succeeds (balance 95+75=170)', s?.success === true && bal(1) === 170, String(bal(1)));
    const up = await call('sales:update', {
      SaleID: sid(s), CustomerID: 1, items: [{ ItemID: 1, Quantity: 7, UnitPrice: 15 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 0, PaymentMethod: 'cash',
      userId: 1,
    });
    t('editing to a larger quantity succeeds', up?.success === true, JSON.stringify(up));
    t('the invoice number is preserved', up?.saleNumber === s.saleNumber, `${up?.saleNumber} vs ${s.saleNumber}`);
    t('the balance reflects the NEW total only (170-75+105=200)', bal(1) === 200, String(bal(1)));
    t('the extra 2 units left stock (5 sold, then 2 more)', stock(1) === st0 - 2, String(stock(1)));
    const g = await call('sales:get', sid(s));
    t('the edited invoice shows 7 units at the new price',
      g?.details?.[0]?.Quantity === 7 && g?.details?.[0]?.UnitPrice === 15, JSON.stringify(g?.details));

    // A return attached to sale 3 blocks the edit.
    const rt = await call('saleReturns:create', {
      SaleID: 3, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }],
      userId: 1, AccountCredit: 15,
    });
    t('attaching a return to sale 3 succeeds', rt?.success === true, JSON.stringify(rt));
    const up2 = await call('sales:update', {
      SaleID: 3, CustomerID: 1, items: [{ ItemID: 1, Quantity: 3, UnitPrice: 15 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 0, PaymentMethod: 'cash',
      userId: 1,
    });
    t('editing an invoice with a return is refused', up2?.success === false && /مرتبطة بـمرتجعات/.test(up2?.message), JSON.stringify(up2));
    await call('delete:saleReturn', rid(rt));

    db.prepare('UPDATE sales SET IsVoided = 1 WHERE SaleID = 3').run();
    const up3 = await call('sales:update', {
      SaleID: 3, CustomerID: 1, items: [{ ItemID: 1, Quantity: 3, UnitPrice: 15 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 0, PaymentMethod: 'cash',
      userId: 1,
    });
    t('editing a voided invoice is refused', up3?.success === false && /الفاتورة ملغاة/.test(up3?.message), JSON.stringify(up3));
    // The app never leaves IsVoided=1 behind — delete is the only path out.
    db.prepare('UPDATE sales SET IsVoided = 0 WHERE SaleID = 3').run();

    const beforeDel = stock(1);
    const del = await call('delete:sale', 3);
    t('the voided sale deletes cleanly', del?.success === true, JSON.stringify(del));
    t('its balance and stock are reversed', bal(1) === 155 && stock(1) === beforeDel + 3, `bal ${bal(1)} stock ${stock(1)}`);
  }

  // ---------------------------------------------------------------- 7
  console.log('\n[7] delete:sale — full reversal and reference blocks');
  {
    const before = cash();
    const stBefore = stock(1);
    const del = await call('delete:sale', 2);
    t('deleting the partial credit sale succeeds', del?.success === true, JSON.stringify(del));
    t('the customer balance is back to 105 (155-50)', bal(1) === 105, String(bal(1)));
    t('the cash is back to before the sale', near(cash(), before - 100), String(cash()));
    t('the 10 units are back in stock', stock(1) === stBefore + 10, String(stock(1)));

    const s = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }], PaidAmount: 15, CashAccountID: 1 });
    const rt = await call('saleReturns:create', {
      SaleID: sid(s), items: [{ ItemID: 1, Quantity: 1, UnitPrice: 15 }],
      userId: 1, CashRefund: 15, CashAccountID: 1,
    });
    const blocked = await call('delete:sale', sid(s));
    t('deleting a sale with a return is refused', blocked?.success === false && /مرتجعات مرتبطة/.test(blocked?.message), JSON.stringify(blocked));
    await call('delete:saleReturn', rid(rt));
    const nowOk = await call('delete:sale', sid(s));
    t('after the return is gone the delete works', nowOk?.success === true, JSON.stringify(nowOk));

    const miss = await call('delete:sale', 9999);
    t('deleting a missing sale is refused', miss?.success === false && /غير موجودة/.test(miss?.message), JSON.stringify(miss));
    const bad = await call('delete:sale', undefined);
    t('deleting with a malformed id is refused, no crash', bad?.success === false, JSON.stringify(bad));
  }

  // ---------------------------------------------------------------- 8
  console.log('\n[8] Reports and statements agree with the ledger');
  {
    const customers = await call('reports:customers');
    const row = customers?.rows?.find(r => r.CustomerID === 1);
    t('reports:customers returns the live balance for the customer',
      near(row?.Balance, bal(1)), JSON.stringify(row));
    const liveSales = qa('SELECT COALESCE(SUM(TotalAmount),0) s, COUNT(*) n FROM sales WHERE CustomerID = 1 AND IsVoided = 0')[0];
    t('reports:customers totals match the live non-voided sales',
      near(row?.TotalPurchases, liveSales.s) && row?.SalesCount === liveSales.n,
      JSON.stringify({ row, liveSales }));

    // Everything below compares the report against what the tables actually
    // hold at this moment — no hand-tracked running totals.
    const liveSalesAll = q('SELECT COALESCE(SUM(TotalAmount),0) v FROM sales WHERE IsVoided = 0').v;
    const liveReturns = q(`
      SELECT COALESCE(SUM(r.TotalAmount),0) v FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID WHERE s.IsVoided = 0
    `).v;
    const liveCogs = q(`
      SELECT COALESCE(SUM(sd.UnitCost * sd.Quantity),0) v FROM sale_details sd
      JOIN sales s ON sd.SaleID = s.SaleID WHERE s.IsVoided = 0
    `).v;
    const liveCogsRet = q(`
      SELECT COALESCE(SUM(srd.UnitCost * srd.Quantity),0) v FROM sale_return_details srd
      JOIN sale_returns r ON srd.ReturnID = r.ReturnID
      JOIN sales s ON r.SaleID = s.SaleID WHERE s.IsVoided = 0
    `).v;

    const rep = await call('reports:sales', {});
    const net = Array.isArray(rep?.rows) ? rep.rows.reduce((s, x) => s + Number(x.TotalAmount), 0) : 0;
    t('reports:sales totals match the live sales table', near(net, liveSalesAll), `${net} vs ${liveSalesAll}`);

    const pl = await call('reports:profitLoss', {});
    t('P&L net sales match the live ledger (sales - returns)',
      near(pl?.revenue?.netSales, liveSalesAll - liveReturns), `${pl?.revenue?.netSales} vs ${liveSalesAll - liveReturns}`);
    t('P&L net COGS matches the live ledger (cost - returned cost)',
      near(pl?.costs?.cogs - (pl?.costs?.cogsReturns || 0), liveCogs - liveCogsRet),
      `${pl?.costs?.cogs} - ${pl?.costs?.cogsReturns} vs ${liveCogs - liveCogsRet}`);
    t('P&L gross profit is revenue minus costs',
      near(pl?.grossProfit, money((liveSalesAll - liveReturns) - (liveCogs - liveCogsRet))),
      `${pl?.grossProfit} vs ${money((liveSalesAll - liveReturns) - (liveCogs - liveCogsRet))}`);

    const fp = await call('reports:financialPosition');
    const liveCash = q('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts WHERE IsActive = 1').v;
    t('the balance sheet cash equals the live cash accounts', near(fp?.assets?.totalCash, liveCash), `${fp?.assets?.totalCash} vs ${liveCash}`);
    t('the balance sheet carries the seeded capital', near(fp?.capital?.explicitCapital, 108550), String(fp?.capital?.explicitCapital));
    t('the balance sheet is balanced (assets = liabilities + equity)',
      Math.abs(fp?.capital?.difference ?? 1) < 0.01, String(fp?.capital?.difference));

    const st = await call('customerStatement:get', 1, {});
    t('the customer statement still foots to the live balance', near(st?.totals?.netBalance, bal(1)), JSON.stringify(st?.totals));
  }

  // ---------------------------------------------------------------- 9
  console.log('\n[9] Money precision through the REAL connection (rounding hardened)');
  {
    // 150 credit sales of 33.33 accumulate in `Balance = Balance + 33.33`.
    // Without the ROUND rewrite in connection.ts the float residue grows;
    // with it the running total lands on the exact piastre.
    const startStock = stock(5);
    let lastNum = '';
    for (let i = 0; i < 150; i++) {
      const r = await sell({
        CustomerID: 3, items: [{ ItemID: 5, Quantity: 1, UnitPrice: 33.33 }],
        PaidAmount: 0,
      });
      if (!r?.success) { t(`sale ${i} of the precision run succeeded`, false, JSON.stringify(r)); break; }
      lastNum = r.saleNumber;
    }
    t('150 credit sales of 33.33 leave the balance at exactly 4999.5', bal(3) === 4999.5, String(bal(3)));
    t('the stock matched the sales one-for-one', stock(5) === startStock - 150, String(stock(5)));

    const del = await call('delete:sale', sid({ saleNumber: lastNum }));
    t('deleting the last one leaves exactly 4966.17', del?.success === true && bal(3) === 4966.17, `bal ${bal(3)}`);
    t('deleting it also restores the exact unit', stock(5) === startStock - 149, String(stock(5)));
  }

  console.log(`\nSECTION 3 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('\nSUITE CRASHED:', err);
  process.exitCode = 1;
}
