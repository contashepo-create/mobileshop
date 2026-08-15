#!/usr/bin/env node
// SECTION 12 — SETTLEMENTS: the stocktake / cash-count reconciliation on the
// REAL stack. Same harness as sections 7-11: an ESM entry re-exporting only
// the handler registration functions, esbuild CJS bundle, an electron stub,
// and a scratch userData directory.
//
// The accounting claim under test: a settlement writes the counted balance,
// recognises the variance in P&L exactly once, never moves an asset twice,
// refuses to count minus-fifty handsets, and the balance sheet identity holds
// after every count.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerSettlementHandlers } from './src/main/ipc/settlement.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_settle_entry.ts');
writeFileSync(entryFile, ENTRY);

const electronStub = `
const path = require('path');
const { EventEmitter } = require('events');
const emitter = new EventEmitter();
emitter.getPath = (k) => process.env.PAYROOT + '/data';
emitter.dirname = path.dirname;
module.exports = {
  app: emitter,
  ipcMain: {
    emitter,
    handle(channel, fn) {
      if (!globalThis.__FOUND_HANDLERS__) globalThis.__FOUND_HANDLERS__ = new Map();
      globalThis.__FOUND_HANDLERS__.set(channel, fn);
    },
  },
  BrowserWindow: class { constructor() {} loadURL() {} on() { return this; } },
};\n`;

let userData;
try {
  userData = mkdtempSync(join(tmpdir(), 'rn-user-'));
  process.env.PAYROOT = userData;
  console.log('Building the real settlement bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_settle_bundle.cjs');
  writeFileSync(bundleFile, out.outputFiles[0].text);
  const require = createRequire(import.meta.url);
  const mod = require(bundleFile);

  const PASS = [];
  const FAIL = [];
  const t = (name, ok, diag) => {
    if (ok) PASS.push(name); else FAIL.push(name);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        ${diag}`);
  };
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.01;

  const DB_FILES = ['mobile_shop.db', 'mobile_shop.db-wal', 'mobile_shop.db-shm'];
  const wipeDb = () => {
    for (const f of DB_FILES) {
      try { rmSync(join(userData, 'data', f), { force: true }); } catch { /* not open */ }
    }
  };
  const scenario = async (fn) => {
    mod.closeDb();
    wipeDb();
    globalThis.__FOUND_HANDLERS__ = new Map();
    for (const [name, exp] of Object.entries(mod)) {
      if (typeof exp === 'function' && name.startsWith('register')) exp();
    }
    const db = mod.getDb();
    mod.runMigrations(db);
    const call = (channel, ...args) => {
      const handler = globalThis.__FOUND_HANDLERS__.get(channel);
      if (!handler) throw new Error(`channel not registered: ${channel}`);
      return handler({ sender: { id: 1 } }, ...args);
    };
    await fn({ db, call });
  };

  const q = (db, sql, ...p) => db.prepare(sql).get(...p);
  const qa = (db, sql, ...p) => db.prepare(sql).all(...p);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'pos_machine', 5000, 1);
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status)
      VALUES (1, 'عميل التسوية', '0100', 2000, 'active');
    INSERT INTO suppliers (SupplierID, Name, Phone, Balance, Status)
      VALUES (1, 'مورد التسوية', '0111', 1500, 'active');
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'سماعة', 'accessory', 0, 100, 150, 1),
             (2, 'شاحن', 'accessory', 0, 50, 80, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 10, 100), (2, 1, 4, 50);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '106700')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const customer = (db) => q(db, 'SELECT Balance v FROM customers WHERE CustomerID = 1').v;
  const supplier = (db) => q(db, 'SELECT Balance v FROM suppliers WHERE SupplierID = 1').v;
  const stock = (db, id) => q(db, 'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ?', id).v;
  const fp = async (call) => await call('reports:financialPosition');
  const pl = async (call) => await call('reports:profitLoss', { fromDate: daysAgo(30), toDate: fmt(new Date()) });
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;
  const apply = (call, o) => call('settlements:apply', {
    section: 'inventory', items: [{ ItemID: 1, ItemName: 'سماعة', RecordedBalance: 10, ActualBalance: 8, Difference: -2, AdjustmentType: 'shortage' }],
    userId: 1, fiscalYearId: 1, ...o,
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A cash count shortage hits the drawer and the P&L once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: 95000, Difference: -5000, AdjustmentType: 'shortage' }] });
    t('the count is applied', r?.success === true, JSON.stringify(r));
    t('the drawer lands at the counted figure', near(cash(db), 95000), `cash ${cash(db)}`);
    const p = await pl(call);
    t('the shortage reaches the P&L exactly once', near(p?.expenses?.general ?? 0, 5000), `general ${p?.expenses?.general}`);
    t('the voucher is stamped as a settlement', q(db, "SELECT COUNT(*) v FROM vouchers WHERE ReferenceType='settlement' AND VoucherType='payment'").v === 1, '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] A cash surplus is other income, once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: 102000, Difference: 2000, AdjustmentType: 'surplus' }] });
    t('the count is applied', r?.success === true, JSON.stringify(r));
    t('the drawer lands at the counted figure', near(cash(db), 102000), `cash ${cash(db)}`);
    const p = await pl(call);
    t('the surplus is other income once', near(p?.revenue?.otherIncome ?? 0, 2000), `income ${p?.revenue?.otherIncome}`);
    t('the settlement voucher is a receipt', q(db, "SELECT COUNT(*) v FROM vouchers WHERE ReferenceType='settlement' AND VoucherType='receipt'").v === 1, '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] The machine is counted the same way');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await apply(call, { section: 'paymentMethods', items: [{ ItemID: 1, ItemName: 'ماكينة', RecordedBalance: 5000, ActualBalance: 4800, Difference: -200, AdjustmentType: 'shortage' }] });
    t('the machine count is applied', r?.success === true, JSON.stringify(r));
    t('the machine lands at the counted figure', near(wallet(db), 4800), `wallet ${wallet(db)}`);
    t('the drawer did not move', near(cash(db), 100000), `cash ${cash(db)}`);
    const p = await pl(call);
    t('the shortage is expensed once', near(p?.expenses?.general ?? 0, 200), `general ${p?.expenses?.general}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] Customers and suppliers accept negative balances');
  await scenario(async ({ db, call }) => {
    seed(db);
    const rc = await apply(call, { section: 'customers', items: [{ ItemID: 1, ItemName: 'عميل', RecordedBalance: 2000, ActualBalance: -500, Difference: -2500, AdjustmentType: 'shortage' }] });
    t('a customer count into credit is accepted', rc?.success === true, JSON.stringify(rc));
    t('the customer ledger moved', near(customer(db), -500), `customer ${customer(db)}`);
    const rs = await apply(call, { section: 'suppliers', items: [{ ItemID: 1, ItemName: 'مورد', RecordedBalance: 1500, ActualBalance: -200, Difference: -1700, AdjustmentType: 'shortage' }] });
    t('a supplier count into credit is accepted', rs?.success === true, JSON.stringify(rs));
    t('the supplier ledger moved', near(supplier(db), -200), `supplier ${supplier(db)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] You cannot count minus fifty handsets');
  await scenario(async ({ db, call }) => {
    seed(db);
    const neg = await apply(call, { section: 'inventory', items: [{ ItemID: 1, ItemName: 'سماعة', RecordedBalance: 10, ActualBalance: -50, Difference: -60, AdjustmentType: 'shortage' }] });
    t('a negative inventory count is refused', neg?.success === false, neg?.message ?? '');
    const negCash = await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: -5, Difference: -100005, AdjustmentType: 'shortage' }] });
    t('a negative cash count is refused', negCash?.success === false, negCash?.message ?? '');
    const nan = await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: 'oops', Difference: -99999, AdjustmentType: 'shortage' }] });
    t('a non-numeric count is refused', nan?.success === false, nan?.message ?? '');
    const empty = await call('settlements:apply', { section: 'cash', items: [], userId: 1, fiscalYearId: 1 });
    t('an empty count is refused', empty?.success === false, empty?.message ?? '');
    t('nothing was touched', near(cash(db), 100000) && stock(db, 1) === 10 && q(db, 'SELECT COUNT(*) v FROM settlements').v === 0, `cash ${cash(db)}, settlements ${q(db, 'SELECT COUNT(*) v FROM settlements').v}`);
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] An inventory shortage expensed at the absorbed unit cost');
  await scenario(async ({ db, call }) => {
    seed(db);
    // Item 1: 10 @ 100 in the main warehouse. Shortage of 2 → 2 × 100 = 200.
    const r = await apply(call, { section: 'inventory', items: [{ ItemID: 1, ItemName: 'سماعة', RecordedBalance: 10, ActualBalance: 8, Difference: -2, AdjustmentType: 'shortage' }] });
    t('the count is applied', r?.success === true, JSON.stringify(r));
    t('the shelf holds the counted total', stock(db, 1) === 8, `stock ${stock(db, 1)}`);
    const p = await pl(call);
    t('the expense is the value, not the quantity', near(p?.expenses?.general ?? 0, 200), `general ${p?.expenses?.general}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 7
  console.log('\n[7] A surplus restores value, a mixed day balances');
  await scenario(async ({ db, call }) => {
    seed(db);
    await apply(call, { section: 'inventory', items: [{ ItemID: 1, ItemName: 'سماعة', RecordedBalance: 10, ActualBalance: 12, Difference: 2, AdjustmentType: 'surplus' }] });
    t('a surplus count is applied', stock(db, 1) === 12, `stock ${stock(db, 1)}`);
    await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: 99000, Difference: -1000, AdjustmentType: 'shortage' }] });
    await apply(call, { section: 'paymentMethods', items: [{ ItemID: 1, ItemName: 'ماكينة', RecordedBalance: 5000, ActualBalance: 5200, Difference: 200, AdjustmentType: 'surplus' }] });
    const p = await pl(call);
    t('the P&L nets the day', near(p?.netProfit ?? 0, 200 + 200 - 1000), `profit ${p?.netProfit}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 8
  console.log('\n[8] The settlement list and detail round-trip');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await apply(call, { section: 'cash', items: [{ ItemID: 1, ItemName: 'الخزنة', RecordedBalance: 100000, ActualBalance: 97000, Difference: -3000, AdjustmentType: 'shortage' }] });
    const list = await call('settlements:list', {});
    t('the list shows the settlement', Array.isArray(list) && list.length === 1 && list[0].SettlementNumber?.startsWith('SET'), JSON.stringify(list ?? []).slice(0, 160));
    const bySection = await call('settlements:list', { section: 'inventory' });
    t('the section filter works', bySection.length === 0, `rows ${bySection?.length}`);
    const det = await call('settlements:getDetails', list[0].SettlementID);
    t('the details round-trip', det?.settlement?.SettlementID === list[0].SettlementID && det?.details?.length === 1 && det.details[0].ActualBalance === 97000, JSON.stringify(det ?? {}).slice(0, 200));
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  console.log(`\nSECTION 12 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_settle_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}