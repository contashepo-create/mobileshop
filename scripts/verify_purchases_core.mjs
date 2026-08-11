#!/usr/bin/env node
// SECTION 4 — PURCHASES: the whole lifecycle through the REAL handlers on the
// REAL production stack (better-sqlite3 file DB, real connection.ts, real
// migrations). Runs against the exact channel names the renderer uses.
//
// Covers the channels no existing script touches: purchases:get, purchases:list,
// purchaseReturns:list, purchaseReturns:get, purchaseReturns:returnable,
// reports:purchases, reports:suppliers, supplierStatement:get — plus the
// lifecycle (cash/credit/partial/machine purchases, serialised receipts,
// re-receipts, returns in every settlement shape, delete guards on both
// directions) and the closing balance-sheet identity + report agreement.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  export { registerPurchasesHandlers } from './src/main/ipc/purchases.handlers.ts';
  export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
  export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
  export { registerStatementHandlers, registerCustomerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
  export { registerSalesHandlers } from './src/main/ipc/sales.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_purchases_entry.ts');
writeFileSync(entryFile, ENTRY);

const paths = {
  userData: mkdtempSync(join(tmpdir(), 'pur-user-')),
  temp: mkdtempSync(join(tmpdir(), 'pur-tmp-')),
  exe: join(mkdtempSync(join(tmpdir(), 'pur-exe-')), 'MobileShopERP', 'app.exe'),
  appPath: mkdtempSync(join(tmpdir(), 'pur-app-')),
};
globalThis.__FOUND_PATHS__ = paths;
globalThis.__FOUND_PACKAGED__ = false;

console.log('Building the real purchases bundle…');
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
const bundleFile = join(PROJECT_ROOT, '_purchases_bundle.cjs');
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
  mod.registerPurchasesHandlers();
  mod.registerDeleteHandlers();
  mod.registerReportsHandlers();
  mod.registerStatementHandlers();
  mod.registerCustomerStatementHandlers();
  mod.registerSalesHandlers();

  db.exec(`
    UPDATE cash_accounts SET Balance = 100000 WHERE CashAccountID = 1;
    INSERT INTO cash_accounts (CashAccountID, AccountName, AccountType, Balance, IsActive)
      VALUES (2, 'خزنة معطلة', 'safe', 0, 0);
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 5000, 1), (2, 'ماكينة معطلة', 'card', 0, 0);
    INSERT INTO suppliers (SupplierID, Name, Phone, Balance, Status, CreditLimit)
      VALUES (1, 'المورد الأول', '0111', 0, 'active', 0),
             (2, 'المورد الموقوف', '0112', 0, 'suspended', 0),
             (3, 'مورد التدقيق', '0113', 0, 'active', 0);
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'كابل', 'accessory', 0, 0, 25, 1),
             (2, 'موبايل', 'phone', 1, 0, 1500, 1),
             (3, 'شاحن', 'accessory', 0, 0, 30, 1);
    INSERT INTO warehouses (WarehouseID, WarehouseName, WarehouseType) VALUES (3, 'مخزن فرعي', 'main');
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status, CreditLimit)
      VALUES (1, 'عميل المجال', '0100', 0, 'active', 100000);
    -- The seeded books open with: cash 100000 + machine 5000 + no inventory.
    -- Mirrored as owner capital so the balance sheet's own identity check
    -- (assets = liabilities + equity) is meaningful for every op that follows.
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '105000');
  `);

  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  // purchases:create answers with the document NUMBER, not the id — the
  // renderer re-locates by number. The suite does the same, from the tables.
  const pim = (r) => q('SELECT PurchaseID v FROM purchases WHERE PurchaseNumber = ?', r?.purchaseNumber)?.v;
  const rim = (r) => q('SELECT ReturnID v FROM purchase_returns WHERE ReturnNumber = ?', r?.returnNumber)?.v;
  const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const mach = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const stock = (id, wh = 1) => q('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?', id, wh).v;
  const poolValue = (id, wh = 1) => q('SELECT COALESCE(SUM(Quantity * CostPrice),0) v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?', id, wh).v;
  const supBal = (id) => q('SELECT Balance v FROM suppliers WHERE SupplierID = ?', id).v;
  const serialStatus = (imei) => q('SELECT Status v FROM item_serials WHERE IMEI = ?', imei)?.v;
  const deviceValue = () => q("SELECT COALESCE(SUM(CostPrice),0) v FROM item_serials WHERE ItemID = 2 AND Status = 'available'").v;
  const fp = async () => await call('reports:financialPosition');
  const balanced = (r) => Math.abs(r?.capital?.difference ?? 1) < 0.01;

  const buy = (p) => call('purchases:create', {
    userId: 1, fiscalYearId: 1,
    Discount: 0, TaxAmount: 0, AdditionalCost: 0, PaymentCost: 0,
    ...p,
  });
  const sell = (p) => call('sales:create', {
    userId: 1, fiscalYearId: 1, PaymentMethod: 'cash',
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    ...p,
  });
  const ret = (p) => call('purchaseReturns:create', { userId: 1, ...p });

  // A running cash/machine ledger, asserted after every movement. The final
  // section cross-checks the reports against the live tables themselves.
  let cashL = 100000, machL = 5000;

  console.log('SECTION 4 — PURCHASES: full lifecycle on the real stack\n');

  // ---------------------------------------------------------------- 1
  console.log('[1] Cash purchase — ledger, layers, and the never-tested purchases:get/purchases:list');
  {
    const r = await buy({
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 20, WarehouseID: 1 }],
      PaidAmount: 200, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    t('a cash purchase succeeds', r?.success === true, JSON.stringify(r));
    t('the invoice number follows the PUR-yyyyMMdd-NNNN shape', /^PUR-\d{8}-\d{4}$/.test(r?.purchaseNumber || ''), String(r?.purchaseNumber));
    t('the invoice is completed with nothing remaining',
      r?.status === 'completed' && r?.remaining === 0, JSON.stringify(r));
    cashL -= 200;
    t('cash account paid 200', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('stock of the cable rose by 10', stock(1) === 10, String(stock(1)));
    t('a fully-paid purchase changes no supplier balance', supBal(1) === 0, String(supBal(1)));

    const g = await call('purchases:get', pim(r));
    t('purchases:get returns the header with the live supplier name', g?.purchase?.SupplierName === 'المورد الأول', JSON.stringify(g?.purchase));
    t('purchases:get returns the lines with item names', g?.details?.length === 1 && g?.details?.[0]?.ItemName === 'كابل', JSON.stringify(g?.details));
    t('the line carries its landed (effective) unit cost',
      g?.details?.[0]?.EffectiveUnitCost === 20, JSON.stringify(g?.details?.[0]));

    const list = await call('purchases:list', {});
    t('purchases:list returns the invoice with the supplier name joined',
      Array.isArray(list) && list.some(x => x.PurchaseNumber === r.purchaseNumber && x.SupplierName === 'المورد الأول'),
      JSON.stringify(list));

    const lot = q('SELECT UnitCost, QtyRemaining FROM stock_lots WHERE SourceType = ? AND SourceID = ?', 'purchase', pim(r));
    t('the delivery is its own cost layer at the landed cost', lot?.UnitCost === 20 && lot?.QtyRemaining === 10, JSON.stringify(lot));
    t('items.CostPrice follows the received price', q('SELECT CostPrice v FROM items WHERE ItemID = 1').v === 20, String(q('SELECT CostPrice v FROM items WHERE ItemID = 1').v));
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Credit, partial, and machine payment — supplier balance, statement, reports');
  {
    const r2 = await buy({
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 5, UnitCost: 20, WarehouseID: 1 }],
      PaidAmount: 30, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    t('a partial-payment purchase succeeds', r2?.success === true, JSON.stringify(r2));
    cashL -= 30;
    t('cash account paid 30', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('the supplier is owed the remaining 70', supBal(1) === 70, String(supBal(1)));
    t('the invoice is partial with 70 remaining',
      q('SELECT Status s, RemainingAmount r FROM purchases WHERE PurchaseNumber = ?', r2.purchaseNumber)?.s === 'partial'
      && q('SELECT RemainingAmount r FROM purchases WHERE PurchaseNumber = ?', r2.purchaseNumber)?.r === 70, JSON.stringify(q('SELECT Status s, RemainingAmount r FROM purchases WHERE PurchaseNumber = ?', r2.purchaseNumber)));

    const r3 = await buy({
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 3, UnitCost: 20, WarehouseID: 1 }],
      PaidAmount: 60, PaymentSourceType: 'payment_method', PaymentSourceID: 1,
    });
    machL -= 60;
    t('a machine-paid purchase succeeds', r3?.success === true, JSON.stringify(r3));
    t('the machine paid 60', near(mach(), machL), `${mach()} vs ${machL}`);
    t('machine money never touches the supplier balance', supBal(1) === 70, String(supBal(1)));

    const r4 = await buy({
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 2, UnitCost: 20, WarehouseID: 1 }],
      PaidAmount: 0,
    });
    t('a fully-credit purchase succeeds', r4?.success === true, JSON.stringify(r4));
    t('the supplier balance accumulates to 110', supBal(1) === 110, String(supBal(1)));
    t('an unpaid purchase is marked unpaid',
      q('SELECT Status s FROM purchases WHERE PurchaseNumber = ?', r4.purchaseNumber)?.s === 'unpaid', String(q('SELECT Status s FROM purchases WHERE PurchaseNumber = ?', r4.purchaseNumber)?.s));

    const st = await call('supplierStatement:get', 1, {});
    t('the supplier statement foots to the live balance', near(st?.totals?.netBalance, supBal(1)), `${st?.totals?.netBalance} vs ${supBal(1)}`);
    t('the statement books each invoice as Credit with its payment as Debit',
      st?.operations?.filter(o => o.OpType === 'purchase').length === 4
      && st?.operations?.find(o => o.RefNumber === r4.purchaseNumber)?.Credit === 40
      && st?.operations?.find(o => o.RefNumber === r4.purchaseNumber)?.Debit === 0,
      JSON.stringify(st?.operations?.map(o => ({ n: o.RefNumber, d: o.Debit, c: o.Credit }))));
    t('the last running balance equals what the supplier is owed',
      st?.operations?.at(-1)?.Balance === supBal(1), String(st?.operations?.at(-1)?.Balance));

    const rp = await call('reports:purchases', {});
    t('reports:purchases foots to the four invoices', rp?.rows?.length === 4
      && near(rp?.totals?.total, 400) && near(rp?.totals?.paid, 290) && near(rp?.totals?.remaining, 110),
      JSON.stringify(rp?.totals));

    const rs = await call('reports:suppliers');
    const row = rs?.rows?.find(x => x.SupplierID === 1);
    t('reports:suppliers carries the live balance, count and value',
      row && near(row.Balance, 110) && row.PurchaseCount === 4 && near(row.TotalPurchases, 400),
      JSON.stringify(row));
    t('reports:suppliers totals foot to the suppliers table',
      near(rs?.totals?.totalBalance, q('SELECT COALESCE(SUM(Balance),0) v FROM suppliers').v), JSON.stringify(rs?.totals));
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Discount + freight — landed cost lands, and returnable offers the effective price');
  {
    const r = await buy({
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 20, WarehouseID: 1 }],
      Discount: 20, AdditionalCost: 30, PaidAmount: 210, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    t('a discounted freighted purchase succeeds', r?.success === true && r?.totalAmount === 210, JSON.stringify(r));
    cashL -= 210;
    t('cash account paid 210', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('stock rose by 10 more', stock(1) === 30, String(stock(1)));
    t('the delivery lands as its OWN cost layer at the landed cost',
      q('SELECT UnitCost, QtyRemaining FROM stock_lots WHERE SourceType = ? AND SourceID = ?', 'purchase', pim(r))?.UnitCost === 21,
      JSON.stringify(q('SELECT UnitCost, QtyRemaining FROM stock_lots WHERE SourceType = ? AND SourceID = ?', 'purchase', pim(r))));
    t('items.CostPrice blends the weighted average across the pool',
      near(q('SELECT CostPrice v FROM items WHERE ItemID = 1').v, 20.3333), String(q('SELECT CostPrice v FROM items WHERE ItemID = 1').v));

    const pid = pim(r);
    const returnable = await call('purchaseReturns:returnable', pid);
    const line = returnable?.find(l => l.ItemID === 1);
    t('returnable offers the EFFECTIVE credit price, not the gross',
      near(line?.UnitCost, 18) && near(line?.GrossUnitCost, 20), JSON.stringify(line));
    t('returnable reports the full line as returnable',
      line?.NotYetReturned === 10 && line?.Returnable === 10 && line?.LimitedByStock === false, JSON.stringify(line));
    globalThis.__P3 = pid;
  }

  // ---------------------------------------------------------------- 4
  console.log('\n[4] purchases:create refusals — every guard, verbatim');
  {
    const base = () => ({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 2, UnitCost: 20, WarehouseID: 1 }], PaidAmount: 40, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    const refuse = async (name, payload, expect) => {
      const r = await buy(payload);
      t(name, r?.success === false && r?.message === expect, r?.message ?? JSON.stringify(r));
    };
    await refuse('a suspended supplier is refused', { ...base(), SupplierID: 2 }, 'المورد موقوف - لا يمكن إتمام عملية الشراء');
    await refuse('a non-existent supplier is refused', { ...base(), SupplierID: 999 }, 'المورد غير موجود');
    await refuse('an empty item list is refused', { ...base(), items: [] }, 'لا يمكن حفظ فاتورة شراء بدون أصناف');
    await refuse('a zero quantity is refused', { ...base(), items: [{ ItemID: 1, Quantity: 0, UnitCost: 20, WarehouseID: 1 }] }, 'الكمية يجب أن تكون رقماً أكبر من صفر');
    await refuse('a NaN quantity is refused', { ...base(), items: [{ ItemID: 1, Quantity: NaN, UnitCost: 20, WarehouseID: 1 }] }, 'الكمية يجب أن تكون رقماً أكبر من صفر');
    await refuse('a negative cost is refused', { ...base(), items: [{ ItemID: 1, Quantity: 2, UnitCost: -5, WarehouseID: 1 }] }, 'سعر الشراء يجب أن يكون رقماً غير سالب');
    await refuse('an Infinity cost is refused', { ...base(), items: [{ ItemID: 1, Quantity: 2, UnitCost: Infinity, WarehouseID: 1 }] }, 'سعر الشراء يجب أن يكون رقماً غير سالب');
    await refuse('a missing warehouse is refused', { ...base(), items: [{ ItemID: 1, Quantity: 2, UnitCost: 20 }] }, 'اختر المخزن لكل صنف');
    await refuse('a non-existent warehouse is refused', { ...base(), items: [{ ItemID: 1, Quantity: 2, UnitCost: 20, WarehouseID: 999 }] }, 'المخزن المختار غير موجود');
    await refuse('a negative discount is refused', { ...base(), Discount: -1 }, 'الخصم يجب أن يكون رقماً غير سالب');
    await refuse('a discount larger than the goods is refused', { ...base(), Discount: 500 }, 'الخصم (500.00) أكبر من إجمالي الأصناف (40.00)');
    await refuse('money with no source is refused', { ...base(), PaidAmount: 40, PaymentSourceID: undefined, PaymentSourceType: undefined }, 'اختر مصدر دفع المبلغ (خزنة أو ماكينة)');
    await refuse('a non-existent drawer is refused', { ...base(), PaymentSourceType: 'cash_account', PaymentSourceID: 999 }, 'الخزنة المختارة غير موجودة');
    await refuse('a DEACTIVATED drawer is refused', { ...base(), PaymentSourceType: 'cash_account', PaymentSourceID: 2 }, 'الخزنة المختارة غير مفعّلة');
    await refuse('a non-existent machine is refused', { ...base(), PaymentSourceType: 'payment_method', PaymentSourceID: 999 }, 'ماكينة الدفع المختارة غير موجودة');
    await refuse('a DEACTIVATED machine is refused', { ...base(), PaymentSourceType: 'payment_method', PaymentSourceID: 2 }, 'ماكينة الدفع المختارة غير مفعّلة');
    await refuse('paying more than the drawer holds is refused',
      { ...base(), PaidAmount: 999999 },
      `الرصيد غير كافٍ في الخزينة: المتاح ${cash().toFixed(2)}، المطلوب 999999.00`);
    await refuse('a serialised line must carry quantity 1',
      { ...base(), SupplierID: 1, items: [{ ItemID: 2, IMEI: '35609999', Quantity: 2, UnitCost: 100, WarehouseID: 1 }] },
      'الجهاز ذو الرقم التسلسلي يجب أن تكون كميته 1 — أضف سطراً لكل جهاز');
    await refuse('one IMEI twice on the same invoice is refused',
      { ...base(), SupplierID: 1, items: [{ ItemID: 2, IMEI: '35609999', Quantity: 1, UnitCost: 100, WarehouseID: 1 }, { ItemID: 2, IMEI: '35609999', Quantity: 1, UnitCost: 100, WarehouseID: 1 }] },
      'الرقم التسلسلي (IMEI) 35609999 مكرر في نفس الفاتورة');
    t('nothing moved under all those refusals', near(cash(), cashL) && stock(1) === 30, `cash ${cash()}, stock ${stock(1)}`);
  }

  // ---------------------------------------------------------------- 5
  console.log('\n[5] Serialised handsets — devices, re-receipt, and the deletion guards');
  {
    const r1 = await buy({
      SupplierID: 1, items: [{ ItemID: 2, IMEI: '35603001', Quantity: 1, UnitCost: 1000, WarehouseID: 1 }],
      PaidAmount: 1000, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    cashL -= 1000;
    t('an IMEI handset is received', r1?.success === true && serialStatus('35603001') === 'available', JSON.stringify(r1));
    const r2 = await buy({
      SupplierID: 1, items: [{ ItemID: 2, IMEI: '35603002', Quantity: 1, UnitCost: 1500, WarehouseID: 1 }],
      PaidAmount: 1500, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    cashL -= 1500;
    t('a second handset is received', r2?.success === true, JSON.stringify(r2));
    t('the pool blends the two at 1250', near(q('SELECT CostPrice v FROM stock_quantities WHERE ItemID = 2 AND WarehouseID = 1').v, 1250), String(q('SELECT CostPrice v FROM stock_quantities WHERE ItemID = 2 AND WarehouseID = 1').v));
    t('pool and device records describe the same shelf', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);
    t('a handset creates NO cost layer', q('SELECT COUNT(*) n FROM stock_lots WHERE ItemID = 2').n === 0, String(q('SELECT COUNT(*) n FROM stock_lots WHERE ItemID = 2').n));

    const s = q('SELECT SerialID v FROM item_serials WHERE IMEI = ?', '35603001').v;
    const rSale = await sell({ CustomerID: 1, items: [{ ItemID: 2, SerialID: s, Quantity: 1, UnitPrice: 2000 }], PaidAmount: 2000, CashAccountID: 1 });
    cashL += 2000;
    t('the handset can be sold', rSale?.success === true && serialStatus('35603001') === 'sold', JSON.stringify(rSale));
    t('the pool follows at the device cost', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    const r3 = await buy({
      SupplierID: 1, items: [{ ItemID: 2, IMEI: '35603001', Quantity: 1, UnitCost: 1200, WarehouseID: 1 }],
      PaidAmount: 1200, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    cashL -= 1200;
    t('a SOLD handset can legitimately be re-received (reactivated)',
      r3?.success === true && serialStatus('35603001') === 'available', JSON.stringify(r3));
    t('the re-received device carries the price just paid', near(q('SELECT CostPrice v FROM item_serials WHERE IMEI = ?', '35603001').v, 1200), String(q('SELECT CostPrice v FROM item_serials WHERE IMEI = ?', '35603001').v));
    t('pool and devices still agree', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    // The re-receipt guard: deleting the ORIGINAL receipt would remove the
    // unit the later invoice paid for, with no way to tell the later payment.
    const d1 = await call('delete:purchase', pim(r1));
    t('deleting the original receipt of a re-received handset is refused',
      d1?.success === false && d1?.message.includes('أُعيد استلامه في') && d1?.message.includes('35603001'),
      d1?.message ?? JSON.stringify(d1));

    // The re-receipt bought the device back after the SALE that still points
    // at it. Unwinding it would dangle that sale's serial link (foreign key),
    // so it is refused like any sold device — not crashed into the DB error.
    const d3 = await call('delete:purchase', pim(r3));
    t('a re-receipt whose device was already sold is refused',
      d3?.success === false && d3?.message.includes('(IMEI 35603001 — الحالة: sold)'), d3?.message ?? JSON.stringify(d3));
    t('pool and devices still agree after the refusal', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    // A re-receipt always follows a sale of that IMEI — that is the only
    // state in which the device can be bought back — so un-receiving it is
    // refused like any sold device: the sale's serial link must not dangle.

    // The missing-serial guard stays armed even though no API leads here
    // anymore: if a device row ever disappears (legacy data, recovery), the
    // deletion must refuse instead of un-receiving a ghost unit.
    const dn = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35603999', Quantity: 1, UnitCost: 900, WarehouseID: 1 }], PaidAmount: 900, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 900;
    run('DELETE FROM item_serials WHERE IMEI = ?', '35603999');
    const d1b = await call('delete:purchase', pim(dn));
    t('a deletion whose device record is MISSING is refused',
      d1b?.success === false && d1b?.message.includes('(IMEI 35603999 — الحالة: محذوف)'),
      d1b?.message ?? JSON.stringify(d1b));
    run('INSERT INTO item_serials (ItemID, IMEI, Status, CostPrice, WarehouseID) VALUES (2, ?, ?, ?, 1)',
      '35603999', 'available', 900);
    const dnc = await call('delete:purchase', pim(dn));
    t('with its row restored, the same receipt reverses cleanly', dnc?.success === true, dnc?.message ?? JSON.stringify(dnc));
    cashL += 900;
    t('its payment comes back', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('its device record is gone with it', serialStatus('35603999') === undefined, String(serialStatus('35603999')));
    t('pool and devices agree after the reversal', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    t('the balance sheet is still balanced after all the refusals', balanced(await fp()), JSON.stringify((await fp())?.capital));
  }

  // ---------------------------------------------------------------- 6
  console.log('\n[6] Purchase returns — debt relief, cash, ratio, transfer, serials, refusals');
  {
    // (a) an UNPAID purchase is returned — the value cancels the debt.
    const r = await buy({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 20, WarehouseID: 1 }], PaidAmount: 0 });
    t('credit purchase for the return case succeeds', r?.success === true, JSON.stringify(r));
    const pid = pim(r);
    t('the supplier now holds both debts', supBal(1) === 310, String(supBal(1)));
    const ra = await ret({ PurchaseID: pid, items: [{ ItemID: 1, Quantity: 4 }] });
    t('returning part of an unpaid invoice succeeds', ra?.success === true && /^PR-\d{8}-\d{4}$/.test(ra?.returnNumber || ''), JSON.stringify(ra));
    const rid = rim(ra);
    const h = q('SELECT * FROM purchase_returns WHERE ReturnID = ?', rid);
    t('the whole value was settled against the debt, nothing refunded',
      h.DebtRelief === 80 && h.CashRefund === 0 && h.TransferRefund === 0, JSON.stringify(h));
    t('only the outstanding part was offset onto the invoice',
      h.InvoiceOffset === 80 && q('SELECT RemainingAmount r FROM purchases WHERE PurchaseID = ?', pid).r === 120, JSON.stringify(h));
    t('the supplier balance fell by exactly the relief', supBal(1) === 230, String(supBal(1)));
    t('the goods left the warehouse', stock(1) === 36, String(stock(1)));

    const list = await call('purchaseReturns:list');
    t('purchaseReturns:list joins the purchase number and supplier',
      Array.isArray(list) && list.some(x => x.ReturnNumber === ra.returnNumber && x.PurchaseNumber === r.purchaseNumber && x.SupplierName === 'المورد الأول'),
      JSON.stringify(list));
    const g = await call('purchaseReturns:get', rid);
    t('purchaseReturns:get returns header and lines with names',
      g?.header?.PurchaseNumber === r.purchaseNumber && g?.details?.[0]?.ItemName === 'كابل', JSON.stringify(g));
    t('the returned line carries the supplier credit and the landed cost',
      g?.details?.[0]?.UnitCost === 20 && g?.details?.[0]?.LandedUnitCost === 20, JSON.stringify(g?.details?.[0]));

    // (b) a PAID purchase is returned — the value comes back as cash.
    const rb = await buy({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 5, UnitCost: 20, WarehouseID: 1 }], PaidAmount: 100, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 100;
    const rb2 = await ret({ PurchaseID: pim(rb), items: [{ ItemID: 1, Quantity: 2 }], CashAccountID: 1 });
    t('returning part of a fully-paid invoice succeeds', rb2?.success === true, JSON.stringify(rb2));
    cashL += 40;
    t('the supplier hands back exactly the credited value as cash', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('a fully-paid invoice keeps its completed status',
      q('SELECT Status s, RemainingAmount r FROM purchases WHERE PurchaseID = ?', pim(rb)).s === 'completed', JSON.stringify(q('SELECT Status s FROM purchases WHERE PurchaseID = ?', pim(rb))));

    // (c) the RATIO case: the discount is shared, the freight stays behind.
    const poolBefore = poolValue(1);
    const qtyBefore = stock(1);
    const rc = await ret({ PurchaseID: globalThis.__P3, items: [{ ItemID: 1, Quantity: 2 }], CashAccountID: 1 });
    t('a return from the discounted purchase is valued at the EFFECTIVE price',
      rc?.success === true, JSON.stringify(rc));
    cashL += 36;
    t('the cash refund is 2 x 18 (discount shared)', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('the goods left at their LANDED cost while the freight stayed behind',
      near(poolValue(1), poolBefore - 36) && stock(1) === qtyBefore - 2,
      `value ${poolValue(1)} vs ${poolBefore - 36}`);
    const rcRow = q('SELECT * FROM purchase_returns WHERE ReturnID = ?', rim(rc));
    t('the write-off of unrecoverable freight was absorbed onto the survivors',
      near(rcRow.FreightWrittenOff, 0), JSON.stringify(rcRow));
    const detail = qa('SELECT * FROM purchase_return_details WHERE ReturnID = ?', rim(rc))[0];
    t('the line records the freight it absorbed', near(detail.FreightAbsorbed, 6), JSON.stringify(detail));
    t('with survivors left, no valuation adjustment is booked',
      q("SELECT COUNT(*) n FROM inventory_adjustments WHERE RefType = 'purchase_return' AND RefID = ?", rim(rc)).n === 0,
      String(q("SELECT COUNT(*) n FROM inventory_adjustments WHERE RefType = 'purchase_return' AND RefID = ?", rim(rc)).n));
    const ret3 = await call('purchaseReturns:returnable', globalThis.__P3);
    t('returnable now caps the line at what was not yet returned',
      ret3?.find(l => l.ItemID === 1)?.Returnable === 8, JSON.stringify(ret3?.find(l => l.ItemID === 1)));

    // (d) a machine-paid purchase is returned by transfer.
    const rd = await buy({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 3, UnitCost: 20, WarehouseID: 1 }], PaidAmount: 60, PaymentSourceType: 'payment_method', PaymentSourceID: 1 });
    machL -= 60;
    const rd2 = await ret({ PurchaseID: pim(rd), items: [{ ItemID: 1, Quantity: 1 }], TransferRefund: 20, PaymentMethodID: 1, AccountCredit: 0, CashRefund: 0 });
    t('a transfer refund arrives in the machine', rd2?.success === true, JSON.stringify(rd2));
    machL += 20;
    t('the machine received the transfer', near(mach(), machL), `${mach()} vs ${machL}`);
    t('the return row records the transfer leg', q('SELECT TransferRefund t FROM purchase_returns WHERE ReturnID = ?', rim(rd2)).t === 20, String(q('SELECT TransferRefund t FROM purchase_returns WHERE ReturnID = ?', rim(rd2)).t));

    // (e) serialised return round trip + the re-sale guard on its deletion.
    const phBefore = stock(2);
    const re = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35604001', Quantity: 1, UnitCost: 800, WarehouseID: 1 }], PaidAmount: 800, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 800;
    const re2 = await ret({ PurchaseID: pim(re), items: [{ ItemID: 2, Quantity: 1 }], CashAccountID: 1 });
    t('a serialised handset can be returned to the supplier', re2?.success === true && serialStatus('35604001') === 'returned', JSON.stringify(re2));
    cashL += 800;
    t('its price comes back in cash', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('the shelf no longer holds it', stock(2) === phBefore, String(stock(2)));
    const de = await call('delete:purchaseReturn', rim(re2));
    t('cancelling that return puts the handset back on the shelf',
      de?.success === true && serialStatus('35604001') === 'available' && stock(2) === phBefore + 1, de?.message ?? JSON.stringify(de));
    cashL -= 800;
    t('cancelling it also returns the cash', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('pool and devices agree after the round trip', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    // The re-sale guard: a device re-received and SOLD again is no longer with
    // the supplier, so its return can never be cancelled back into the shelf.
    const rg = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35605001', Quantity: 1, UnitCost: 700, WarehouseID: 1 }], PaidAmount: 700, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 700;
    const rg2 = await ret({ PurchaseID: pim(rg), items: [{ ItemID: 2, Quantity: 1 }], CashAccountID: 1 });
    cashL += 700;
    const rg3 = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35605001', Quantity: 1, UnitCost: 700, WarehouseID: 1 }], PaidAmount: 700, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 700;
    const s2 = q('SELECT SerialID v FROM item_serials WHERE IMEI = ?', '35605001').v;
    const rg4 = await sell({ CustomerID: 1, items: [{ ItemID: 2, SerialID: s2, Quantity: 1, UnitPrice: 1500 }], PaidAmount: 1500, CashAccountID: 1 });
    cashL += 1500;
    t('the re-received handset was sold again', rg4?.success === true && serialStatus('35605001') === 'sold', JSON.stringify(rg4));
    const dg = await call('delete:purchaseReturn', rim(rg2));
    t('cancelling the return of a re-sold handset is refused',
      dg?.success === false && dg?.message.includes('لم تعد مرتجعة للمورد'), dg?.message ?? JSON.stringify(dg));
    t('nothing moved under the refusal', near(cash(), cashL), `${cash()} vs ${cashL}`);

    // (f) refusals — verbatim.
    const refuse = async (name, payload, expect) => {
      const r = await ret(payload);
      t(name, r?.success === false && r?.message === expect, r?.message ?? JSON.stringify(r));
    };
    await refuse('an empty item list is refused', { PurchaseID: pid, items: [] }, 'حدد الأصناف المرتجعة');
    await refuse('a zero return quantity is refused', { PurchaseID: pid, items: [{ ItemID: 1, Quantity: 0 }] }, 'الكمية المرتجعة يجب أن تكون رقماً أكبر من صفر');
    await refuse('a NaN return quantity is refused', { PurchaseID: pid, items: [{ ItemID: 1, Quantity: NaN }] }, 'الكمية المرتجعة يجب أن تكون رقماً أكبر من صفر');
    await refuse('a non-existent purchase is refused', { PurchaseID: 999999, items: [{ ItemID: 1, Quantity: 1 }] }, 'أحد الأصناف المرتجعة غير موجود في فاتورة الشراء الأصلية');
    await refuse('an item not on the purchase is refused', { PurchaseID: pid, items: [{ ItemID: 3, Quantity: 1 }] }, 'أحد الأصناف المرتجعة غير موجود في فاتورة الشراء الأصلية');
    await refuse('more than was bought is refused',
      { PurchaseID: pid, items: [{ ItemID: 1, Quantity: 7 }] },
      'الكمية المرتجعة من "كابل" أكبر من المشترى: المطلوب 7، المتاح 6');
    await refuse('a settlement that over-allocates is refused',
      { PurchaseID: pim(rb), items: [{ ItemID: 1, Quantity: 2 }], AccountCredit: 50, CashRefund: 0 },
      'التوزيع أكبر من قيمة المرتجع بمقدار 10.00');
    await refuse('a NEGATIVE refund leg is refused',
      { PurchaseID: pim(rb), items: [{ ItemID: 1, Quantity: 2 }], AccountCredit: 45, CashRefund: -5 },
      'قيمة النقدي لا يمكن أن تكون سالبة');
    await refuse('refunding into a non-existent drawer is refused',
      { PurchaseID: pim(rb), items: [{ ItemID: 1, Quantity: 2 }], CashRefund: 40, CashAccountID: 999 },
      'الخزنة المختارة غير موجودة');
    await refuse('a transfer into a non-existent machine is refused',
      { PurchaseID: pim(rb), items: [{ ItemID: 1, Quantity: 2 }], TransferRefund: 40, PaymentMethodID: 999, AccountCredit: 0 },
      'المحفظة/الماكينة المختارة غير موجودة');

    // A genuinely stocked-out item has nothing to hand the supplier back: the
    // return of a paid invoice is refused outright. (A pool with plenty of
    // cable on the shelf would fund the refund, so the test goes via the
    // charger, which nothing has ever bought before this line.)
    const rf = await buy({ SupplierID: 1, items: [{ ItemID: 3, Quantity: 1, UnitCost: 10, WarehouseID: 1 }], PaidAmount: 10, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 10;
    await sell({ CustomerID: 1, items: [{ ItemID: 3, Quantity: 1, UnitPrice: 30 }], PaidAmount: 30, CashAccountID: 1 });
    cashL += 30;
    t('the charger shelf is empty', stock(3) === 0, String(stock(3)));
    await refuse('goods no longer in stock cannot go back to the supplier',
      { PurchaseID: pim(rf), items: [{ ItemID: 3, Quantity: 1 }], CashAccountID: 1 },
      'الكمية غير متوفرة في المخزن للمرتجع للصنف "شاحن": المطلوب 1، المتاح 0');

    const rg5 = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35606001', Quantity: 1, UnitCost: 900, WarehouseID: 1 }], PaidAmount: 900, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 900;
    const s3 = q('SELECT SerialID v FROM item_serials WHERE IMEI = ?', '35606001').v;
    await sell({ CustomerID: 1, items: [{ ItemID: 2, SerialID: s3, Quantity: 1, UnitPrice: 1500 }], PaidAmount: 1500, CashAccountID: 1 });
    cashL += 1500;
    await refuse('a SOLD handset cannot be returned to the supplier',
      { PurchaseID: pim(rg5), items: [{ ItemID: 2, SerialID: s3, Quantity: 1 }], CashAccountID: 1 },
      'الجهاز (IMEI 35606001) لم يعد بالمخزن — لا يمكن رده للمورد');
  }

  // ---------------------------------------------------------------- 7
  console.log('\n[7] delete:purchase — every guard, and a clean reversal');
  {
    // A purchase with a registered return cannot vanish.
    const pa = q('SELECT PurchaseID v FROM purchases WHERE PurchaseID = (SELECT PurchaseID FROM purchase_returns ORDER BY ReturnID LIMIT 1)').v;
    const d = await call('delete:purchase', pa);
    t('a purchase with a linked return is refused',
      d?.success === false && d?.message.includes('مرتجعات مرتبطة (1)'), d?.message ?? JSON.stringify(d));

    // An IMEI that was SOLD is not on the shelf to un-receive.
    const pb = await buy({ SupplierID: 1, items: [{ ItemID: 2, IMEI: '35607001', Quantity: 1, UnitCost: 650, WarehouseID: 1 }], PaidAmount: 650, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    cashL -= 650;
    const sb = q('SELECT SerialID v FROM item_serials WHERE IMEI = ?', '35607001').v;
    await sell({ CustomerID: 1, items: [{ ItemID: 2, SerialID: sb, Quantity: 1, UnitPrice: 1200 }], PaidAmount: 1200, CashAccountID: 1 });
    cashL += 1200;
    const db = await call('delete:purchase', pim(pb));
    t('a purchase whose handset was sold is refused with the IMEI state',
      db?.success === false && db?.message.includes('(IMEI 35607001 — الحالة: sold)'), db?.message ?? JSON.stringify(db));

    // A return leaves its purchase behind a "linked returns" guard, so the
    // returned-handset state can never be the one the serial guard sees —
    // the linked-return refusal above always fires first.

    // Two lines of the SAME item on one invoice are checked as ONE holding:
    // each line used to see the full pool, both passed, and the deletion drove
    // it negative. A fresh item keeps the pool isolated from all the cables.
    const pd = await buy({
      SupplierID: 1, items: [
        { ItemID: 3, Quantity: 6, UnitCost: 10, WarehouseID: 1 },
        { ItemID: 3, Quantity: 6, UnitCost: 10, WarehouseID: 1 },
      ],
      PaidAmount: 120, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
    });
    cashL -= 120;
    await sell({ CustomerID: 1, items: [{ ItemID: 3, Quantity: 5, UnitPrice: 30 }], PaidAmount: 150, CashAccountID: 1 });
    cashL += 150;
    const dd = await call('delete:purchase', pim(pd));
    t('a deletion drawing more than the SUM of the (item, warehouse) holding is refused',
      dd?.success === false && dd?.message.includes('"شاحن" (المطلوب 12، المتاح 7)'), dd?.message ?? JSON.stringify(dd));
    t('the refused deletion left the warehouse non-negative', stock(3) === 7, String(stock(3)));

    // A clean reversal: stock, cash, supplier balance, and the rows all return.
    const supBefore = supBal(1);
    const pe = await buy({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 3, UnitCost: 20, WarehouseID: 1 }], PaidAmount: 30, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    const peId = pim(pe);
    cashL -= 30;
    t('the deletion candidate leaves 30 owed', supBal(1) === supBefore + 30, String(supBal(1)));
    const de2 = await call('delete:purchase', peId);
    t('a purchase whose goods are all still on the shelf can be deleted', de2?.success === true, de2?.message ?? JSON.stringify(de2));
    cashL += 30;
    t('the payment comes back', near(cash(), cashL), `${cash()} vs ${cashL}`);
    t('the supplier balance returns', supBal(1) === supBefore, String(supBal(1)));
    t('the stock is un-received', stock(1) === 39, String(stock(1)));
    t('the invoice is gone from the ledger',
      q('SELECT COUNT(*) n FROM purchases WHERE PurchaseID = ?', peId).n === 0
      && q('SELECT COUNT(*) n FROM purchase_details WHERE PurchaseID = ?', peId).n === 0, 'rows remain');
    t('the balance sheet is still balanced', balanced(await fp()), JSON.stringify((await fp())?.capital));
  }

  // ---------------------------------------------------------------- 8
  console.log('\n[8] The closing identity — reports agree with the live ledger');
  {
    const f = await fp();
    t('assets = liabilities + equity exactly', balanced(f) && f?.capital?.isBalanced === true, JSON.stringify(f?.capital));
    t('the balance sheet cash equals the tracked cash', near(f?.assets?.totalCash, cashL), `${f?.assets?.totalCash} vs ${cashL}`);
    t('the balance sheet machine equals the tracked machine', near(f?.assets?.totalPaymentMethods, machL), `${f?.assets?.totalPaymentMethods} vs ${machL}`);
    const invLive = poolValue(1) + poolValue(2) + poolValue(3);
    t('inventory equals the live pool valuation', near(f?.assets?.totalInventory, invLive), `${f?.assets?.totalInventory} vs ${invLive}`);
    t('pooled and serialised shelves agree', near(poolValue(2), deviceValue()), `${poolValue(2)} vs ${deviceValue()}`);

    const livePur = q('SELECT COUNT(*) n, COALESCE(SUM(TotalAmount),0) t, COALESCE(SUM(PaidAmount),0) p, COALESCE(SUM(RemainingAmount),0) r FROM purchases').n;
    const rp = await call('reports:purchases', {});
    t('reports:purchases counts the live invoices', rp?.rows?.length === livePur, `${rp?.rows?.length} vs ${livePur}`);
    const liveTotals = q('SELECT COALESCE(SUM(TotalAmount),0) t, COALESCE(SUM(PaidAmount),0) p, COALESCE(SUM(RemainingAmount),0) r FROM purchases');
    t('reports:purchases totals match the live purchases table',
      near(rp?.totals?.total, liveTotals.t) && near(rp?.totals?.paid, liveTotals.p) && near(rp?.totals?.remaining, liveTotals.r),
      JSON.stringify(rp?.totals));
    const rs = await call('reports:suppliers');
    t('reports:suppliers totals foot to the live suppliers table',
      near(rs?.totals?.totalBalance, q('SELECT COALESCE(SUM(Balance),0) v FROM suppliers').v), JSON.stringify(rs?.totals));
    t('the supplier liability on the balance sheet is the live balance',
      near(f?.liabilities?.totalSuppliers, q('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance > 0').v), JSON.stringify(f?.liabilities));

    const st = await call('supplierStatement:get', 1, {});
    t('the supplier statement still foots to the live balance', near(st?.totals?.netBalance, supBal(1)), `${st?.totals?.netBalance} vs ${supBal(1)}`);

    const pl = await call('reports:profitLoss', {});
    t('P&L and balance sheet compute the SAME profit', near(pl?.netProfit, f?.capital?.netProfit), `${pl?.netProfit} vs ${f?.capital?.netProfit}`);
  }

  console.log(`\nSECTION 4 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('\nSUITE CRASHED:', err);
  process.exitCode = 1;
}