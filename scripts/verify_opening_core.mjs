#!/usr/bin/env node
// SECTION 13 — OPENING BALANCES: the setup screen that seeds the books, on the
// REAL stack. Same harness as sections 7-12: an ESM entry re-exporting only
// the handler registration functions, esbuild CJS bundle, an electron stub,
// and a scratch userData directory.
//
// The accounting claim under test: every opening-balance change walks the
// books — cash and wallets raise owner capital with the balance, customers
// with the receivable delta, suppliers/employees with the NEGATED liability
// delta, stock with the inventory value delta — a ghost id is refused instead
// of silently succeeding, the batch writes all-or-nothing, and the balance
// sheet identity holds after every edit.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerOpeningBalanceHandlers } from './src/main/ipc/openingBalance.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_ob_entry.ts');
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
  console.log('Building the real opening-balance bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_ob_bundle.cjs');
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

  // Opening net worth: cash 100000 + machine 5000 + customer 2000
  // - supplier 1500 - employee 1000 + inventory (5x60) = 104800.
  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'pos_machine', 5000, 1);
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status)
      VALUES (1, 'عميل الافتتاحيات', '0100', 2000, 'active');
    INSERT INTO suppliers (SupplierID, Name, Phone, Balance, Status)
      VALUES (1, 'مورد الافتتاحيات', '0111', 1500, 'active');
    UPDATE employees SET Balance = 1000, IsActive = 1 WHERE EmployeeID = 1;
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'شاحن', 'accessory', 0, 60, 90, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 5, 60);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '104800')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const customer = (db) => q(db, 'SELECT Balance v FROM customers WHERE CustomerID = 1').v;
  const supplier = (db) => q(db, 'SELECT Balance v FROM suppliers WHERE SupplierID = 1').v;
  const employee = (db) => q(db, 'SELECT Balance v FROM employees WHERE EmployeeID = 1').v;
  const stock = (db) => q(db, 'SELECT Quantity v, CostPrice c FROM stock_quantities WHERE ItemID = 1 AND WarehouseID = 1');
  const capital = (db) => Number(q(db, "SELECT Value v FROM settings WHERE Key='owner_capital'")?.v ?? 0);
  const fp = async (call) => await call('reports:financialPosition');
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Cash and wallet opening balances walk the capital');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await call('openingBalances:updateCash', 1, 120000);
    t('a new drawer balance is accepted', c?.success === true, JSON.stringify(c));
    t('the drawer moved', near(cash(db), 120000), `cash ${cash(db)}`);
    t('capital walked with it', near(capital(db), 124800), `capital ${capital(db)}`);
    const w = await call('openingBalances:updatePaymentMethod', 1, 6000);
    t('a new machine balance is accepted', w?.success === true, JSON.stringify(w));
    t('capital walked with the machine too', near(capital(db), 125800), `capital ${capital(db)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] A ghost drawer or machine is refused, not silently accepted');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await call('openingBalances:updateCash', 99999, 5000);
    t('a ghost drawer id is refused', c?.success === false, c?.message ?? '');
    const w = await call('openingBalances:updatePaymentMethod', 99999, 5000);
    t('a ghost machine id is refused', w?.success === false, w?.message ?? '');
    t('nothing moved', near(cash(db), 100000) && near(wallet(db), 5000), `cash ${cash(db)}, wallet ${wallet(db)}`);
    const neg = await call('openingBalances:updateCash', 1, -50);
    t('a negative drawer opening is refused', neg?.success === false, neg?.message ?? '');
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Parties and stock walk the capital too');
  await scenario(async ({ db, call }) => {
    seed(db);
    const cu = await call('openingBalances:updateCustomer', 1, 5000);
    t('a customer opening is accepted', cu?.success === true, JSON.stringify(cu));
    t('the receivable grew', near(customer(db), 5000), `customer ${customer(db)}`);
    t('capital grew with the receivable', near(capital(db), 107800), `capital ${capital(db)}`);
    const su = await call('openingBalances:updateSupplier', 1, 2500);
    t('a supplier opening is accepted', su?.success === true, JSON.stringify(su));
    t('capital shrank as the liability grew', near(capital(db), 106800), `capital ${capital(db)}`);
    const em = await call('openingBalances:updateEmployee', 1, 800);
    t('an employee opening is accepted', em?.success === true, JSON.stringify(em));
    t('capital rose as the wage liability shrank', near(capital(db), 107000), `capital ${capital(db)}`);
    const st = await call('openingBalances:updateStock', 1, 1, 10, 80);
    t('a stock opening is accepted', st?.success === true, JSON.stringify(st));
    t('the shelf holds it', near(stock(db).v, 10) && near(stock(db).c, 80), JSON.stringify(stock(db)));
    t('capital moved with the inventory value', near(capital(db), 107500), `capital ${capital(db)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] Ghosts and negatives on the party doors');
  await scenario(async ({ db, call }) => {
    seed(db);
    const gc = await call('openingBalances:updateCustomer', 99999, 100);
    t('a ghost customer is refused', gc?.success === false, gc?.message ?? '');
    const gs = await call('openingBalances:updateSupplier', 99999, 100);
    t('a ghost supplier is refused', gs?.success === false, gs?.message ?? '');
    const ge = await call('openingBalances:updateEmployee', 99999, 100);
    t('a ghost employee is refused', ge?.success === false, ge?.message ?? '');
    const neg = await call('openingBalances:updateCustomer', 1, -300);
    t('a customer may open in credit', neg?.success === true && near(customer(db), -300), JSON.stringify(neg));
    const nan = await call('openingBalances:updateSupplier', 1, 'oops');
    t('a non-numeric supplier balance is refused', nan?.success === false, nan?.message ?? '');
    const ns = await call('openingBalances:updateStock', 1, 1, -5, 60);
    t('a negative stock quantity is refused', ns?.success === false, ns?.message ?? '');
    const nc = await call('openingBalances:updateStock', 1, 1, 5, -60);
    t('a negative unit cost is refused', nc?.success === false, nc?.message ?? '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] The batch writes all-or-nothing and walks the capital');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await call('openingBalances:batchUpdate', {
      cashAccounts: [{ id: 1, balance: 110000 }],
      paymentMethods: [{ id: 1, balance: 6000 }],
      customers: [{ id: 1, balance: 3000 }],
      suppliers: [{ id: 1, balance: 1200 }],
      employees: [{ id: 1, balance: 900 }],
    });
    t('the batch is accepted', r?.success === true, JSON.stringify(r));
    t('every balance landed', near(cash(db), 110000) && near(wallet(db), 6000) && near(customer(db), 3000)
      && near(supplier(db), 1200) && near(employee(db), 900), `cash ${cash(db)} supplier ${supplier(db)}`);
    t('capital walked with the whole batch', near(capital(db), 117200), `capital ${capital(db)}`);
    const f = await fp(call);
    t('the books balance after the batch', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));

    const neg = await call('openingBalances:batchUpdate', { cashAccounts: [{ id: 1, balance: -10 }] });
    t('a negative cash in the batch is refused', neg?.success === false, neg?.message ?? '');
    const nan = await call('openingBalances:batchUpdate', { suppliers: [{ id: 1, balance: 'x' }] });
    t('a non-numeric party in the batch is refused', nan?.success === false, nan?.message ?? '');
    const ghost = await call('openingBalances:batchUpdate', { customers: [{ id: 99999, balance: 100 }] });
    t('a ghost id in the batch is refused', ghost?.success === false, ghost?.message ?? '');
    const shape = await call('openingBalances:batchUpdate', null);
    t('a malformed payload is refused', shape?.success === false, shape?.message ?? '');
    const g2 = await fp(call);
    t('the books still balance after the refusals', balanced(g2), JSON.stringify(g2?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] The overview tells the truth');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ov = await call('openingBalances:overview');
    t('the overview lists the drawer', ov?.cashAccounts?.some(a => a.AccountName === 'الخزنة الرئيسية'), JSON.stringify(ov?.cashAccounts ?? []).slice(0, 160));
    t('the overview totals cash', near(ov?.totals?.totalCash ?? 0, 100000), `totalCash ${ov?.totals?.totalCash}`);
    t('the overview totals customers', near(ov?.totals?.totalCustomers ?? 0, 2000), `totalCustomers ${ov?.totals?.totalCustomers}`);
    t('the overview totals suppliers', near(ov?.totals?.totalSuppliers ?? 0, 1500), `totalSuppliers ${ov?.totals?.totalSuppliers}`);
    t('the overview totals inventory', near(ov?.totals?.totalInventory ?? 0, 300), `totalInventory ${ov?.totals?.totalInventory}`);
    t('assets minus liabilities equals the seeded net worth',
      near((ov?.totals?.totalAssets ?? 0) - (ov?.totals?.totalLiabilities ?? 0), 104800),
      `${ov?.totals?.totalAssets} - ${ov?.totals?.totalLiabilities}`);
  });

  console.log(`\nSECTION 13 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_ob_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}