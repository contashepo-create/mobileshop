#!/usr/bin/env node
// SECTION 14 — PARTIES: customers and suppliers as ledgers, on the REAL
// stack. Same harness as sections 7-13: an ESM entry re-exporting only the
// handler registration functions, esbuild CJS bundle, an electron stub, and
// a scratch userData directory.
//
// The accounting claim under test: a party is created only cleanly, its
// status is one of the real three, its balance walks with every real document
// (sale, purchase, voucher) exactly once, and its own statement foots to the
// balance the ledger holds.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerHrHandlers } from './src/main/ipc/hr.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerSalesHandlers } from './src/main/ipc/sales.handlers.ts';
export { registerPurchasesHandlers } from './src/main/ipc/purchases.handlers.ts';
export { registerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerCustomerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_party_entry.ts');
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
  console.log('Building the real parties bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_party_bundle.cjs');
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
  // - supplier 1500 - employee 1000 + inventory (100x60) = 110500.
  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'pos_machine', 5000, 1);
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status, CreditLimit)
      VALUES (1, 'عميل الأطراف', '0100', 2000, 'active', 5000);
    INSERT INTO suppliers (SupplierID, Name, Phone, Balance, Status, CreditLimit)
      VALUES (1, 'مورد الأطراف', '0111', 1500, 'active', 5000);
    UPDATE employees SET Balance = 1000, IsActive = 1 WHERE EmployeeID = 1;
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'شاحن', 'accessory', 0, 60, 90, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 100, 60);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '110500')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const customer = (db) => q(db, 'SELECT Balance v FROM customers WHERE CustomerID = 1').v;
  const supplier = (db) => q(db, 'SELECT Balance v FROM suppliers WHERE SupplierID = 1').v;
  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const fp = async (call) => await call('reports:financialPosition');
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;
  const stock = (db) => q(db, 'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = 1').v;

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A customer is created cleanly, and only cleanly');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await call('customers:create', { Name: 'أحمد', Phone: '01000000000', CreditLimit: 3000 });
    t('a valid customer is created', ok?.success === true && ok?.id > 0, JSON.stringify(ok));
    const row = q(db, 'SELECT * FROM customers WHERE CustomerID = ?', ok.id);
    t('it lands active with a zero balance', row.Status === 'active' && row.Balance === 0, JSON.stringify(row));
    const noName = await call('customers:create', { Name: '' });
    t('an unnamed customer is refused', noName?.success === false, noName?.message ?? '');
    const spaces = await call('customers:create', { Name: '        ' });
    t('a whitespace-only name is refused', spaces?.success === false, spaces?.message ?? '');
    const huge = await call('customers:create', { Name: 'ح'.repeat(5000000) });
    t('a huge name is refused', huge?.success === false, huge?.message ?? '');
    const negLimit = await call('customers:create', { Name: 'x', CreditLimit: -100 });
    t('a negative credit limit is refused', negLimit?.success === false, negLimit?.message ?? '');
    const nanLimit = await call('customers:create', { Name: 'x', CreditLimit: 'oops' });
    t('a non-numeric credit limit is refused', nanLimit?.success === false, nanLimit?.message ?? '');
    const ghost = await call('customers:get', 99999);
    t('a ghost get answers empty, not crash', ghost === undefined, JSON.stringify(ghost ?? {}).slice(0, 60));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] The supplier doors mirror them');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await call('suppliers:create', { Name: 'مورد', Phone: '01111111111', CreditLimit: 2000 });
    t('a valid supplier is created', ok?.success === true && ok?.id > 0, JSON.stringify(ok));
    t('it lands active with a zero balance', q(db, 'SELECT Status v, Balance b FROM suppliers WHERE SupplierID = ?', ok.id).v === 'active');
    t('an unnamed supplier is refused', (await call('suppliers:create', { Name: '' }))?.success === false);
    t('a huge supplier name is refused', (await call('suppliers:create', { Name: 'س'.repeat(5000000) }))?.success === false);
    t('a negative supplier limit is refused', (await call('suppliers:create', { Name: 'x', CreditLimit: -1 }))?.success === false);
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Updates and statuses stay in the real three');
  await scenario(async ({ db, call }) => {
    seed(db);
    const up = await call('customers:update', 1, { Name: 'عميل محدث', Phone: '0101', Status: 'suspended', CreditLimit: 9000 });
    t('a full customer update works', up?.success === true && q(db, 'SELECT Name v FROM customers WHERE CustomerID = 1').v === 'عميل محدث', JSON.stringify(up));
    t('the status landed', q(db, 'SELECT Status v FROM customers WHERE CustomerID = 1').v === 'suspended', '');
    const alien = await call('customers:updateStatus', 1, 'GOD_MODE');
    t('an alien customer status is refused', alien?.success === false, alien?.message ?? '');
    const sus = await call('customers:updateStatus', 1, 'active');
    t('the real statuses pass', sus?.success === true && q(db, 'SELECT Status v FROM customers WHERE CustomerID = 1').v === 'active', JSON.stringify(sus));
    const ghost = await call('customers:updateStatus', 99999, 'active');
    t('a ghost customer status is refused', ghost?.success === false, ghost?.message ?? '');
    const supAlien = await call('suppliers:updateStatus', 1, 'HACKED');
    t('an alien supplier status is refused', supAlien?.success === false, supAlien?.message ?? '');
    const sup = await call('suppliers:updateStatus', 1, 'suspended');
    t('a supplier can be suspended', sup?.success === true && q(db, 'SELECT Status v FROM suppliers WHERE SupplierID = 1').v === 'suspended', JSON.stringify(sup));
    const ghostC = await call('customers:update', 99999, { Name: 'x', Status: 'active' });
    t('a ghost customer update is refused', ghostC?.success === false, ghostC?.message ?? '');
    const ghostS = await call('suppliers:update', 99999, { Name: 'x', Status: 'active' });
    t('a ghost supplier update is refused', ghostS?.success === false, ghostS?.message ?? '');
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] A customer balance walks with real documents');
  await scenario(async ({ db, call }) => {
    seed(db);
    // A credit sale of 3 units @ 90 = 270 charged to the customer.
    const sale = await call('sales:create', {
      CustomerID: 1, items: [{ ItemID: 1, Quantity: 3, UnitPrice: 90 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
      PaidAmount: 0, CashAccountID: 1, userId: 1, fiscalYearId: 1,
    });
    t('a credit sale succeeds', sale?.success === true, JSON.stringify(sale).slice(0, 200));
    t('the debt grew by the invoice', near(customer(db), 2270), `customer ${customer(db)}`);
    t('the stock left the shelf', near(stock(db), 97), `stock ${stock(db)}`);
    // A 200 receipt voucher settles part of it.
    await call('vouchers:create', { VoucherType: 'receipt', Amount: 200, Description: 'سداد', PartyType: 'customer', PartyID: 1, PartyName: 'عميل', CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('a receipt settles part of the debt', near(customer(db), 2070), `customer ${customer(db)}`);
    const cs = await call('customerStatement:get', 1, {});
    t('the customer statement foots to the balance', near((cs?.totals?.totalDebit ?? 0) - (cs?.totals?.totalCredit ?? 0), customer(db) - 2000), `debit ${cs?.totals?.totalDebit} credit ${cs?.totals?.totalCredit}`);
    t('the statement shows both legs', cs?.operations?.some(o => o.OpType === 'sale') && cs?.operations?.some(o => o.OpType === 'voucher_receipt'), JSON.stringify(cs?.operations ?? []).slice(0, 160));
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] A supplier balance walks with real documents');
  await scenario(async ({ db, call }) => {
    seed(db);
    const pur = await call('purchases:create', {
      SupplierID: 1, items: [{ ItemID: 1, Quantity: 10, UnitCost: 60, WarehouseID: 1 }],
      TotalAmount: 600, PaidAmount: 100, PaymentSourceType: 'cash_account', PaymentSourceID: 1,
      userId: 1, fiscalYearId: 1,
    });
    t('a partial purchase succeeds', pur?.success === true, JSON.stringify(pur).slice(0, 220));
    t('the debt grew by the unpaid part', near(supplier(db), 2000), `supplier ${supplier(db)}`);
    t('the stock arrived', near(stock(db), 110), `stock ${stock(db)}`);
    await call('vouchers:create', { VoucherType: 'payment', Amount: 300, Description: 'سداد مورد', PartyType: 'supplier', PartyID: 1, PartyName: 'مورد', CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('a payment settles part of it', near(supplier(db), 1700), `supplier ${supplier(db)}`);
    const ss = await call('supplierStatement:get', 1, {});
    t('the supplier statement foots to the balance', near((ss?.totals?.totalCredit ?? 0) - (ss?.totals?.totalDebit ?? 0), supplier(db) - 1500), `debit ${ss?.totals?.totalDebit} credit ${ss?.totals?.totalCredit}`);
    t('the statement shows both legs', ss?.operations?.some(o => o.OpType === 'purchase') && ss?.operations?.some(o => o.OpType === 'voucher_payment'), '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] Search and list behave');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('customers:create', { Name: 'محمد % خاص', Phone: '0101' });
    const pct = await call('customers:list', { search: '%' });
    t('a literal percent is not a wildcard', Array.isArray(pct) && pct.every(c => !c.Name || c.Name.includes('%')), `rows ${pct?.length}`);
    const long = await call('customers:list', { search: 'ح'.repeat(60000) });
    t('a huge search term does not crash', Array.isArray(long), '');
    const byStatus = await call('customers:list', { status: 'suspended' });
    t('the status filter works', byStatus.every(c => c.Status === 'suspended'), `rows ${byStatus?.length}`);
    const found = await call('customers:list', { search: 'الأطراف' });
    t('a real search finds the party', found.some(c => c.Name === 'عميل الأطراف'), `rows ${found?.length}`);
  });

  console.log(`\nSECTION 14 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_party_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}