#!/usr/bin/env node
// SECTION 11 — ASSETS: the drawer and payment-machine registries on the REAL
// stack. Same harness as sections 7-10: an ESM entry re-exporting only the
// handler registration functions, esbuild CJS bundle, an electron stub, and a
// scratch userData directory. Every channel below runs the actual production
// code against the real schema.
//
// The accounting claim under test: an asset is created cleanly or refused, its
// opening balance is real money that walks the books (owner capital moves with
// it), a deactivated asset is invisible to the pickers and refuses fresh
// money, and the balance sheet only ever shows live assets.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerAssetsHandlers } from './src/main/ipc/assets.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerTransfersHandlers } from './src/main/ipc/transfers.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
export { registerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_asset_entry.ts');
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
  console.log('Building the real assets bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_asset_bundle.cjs');
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

  // Opening net worth: cash 100000 + machine 5000 (customer/supplier/employee
  // are not needed for the asset registry).
  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'pos_machine', 5000, 1);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '105000')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const capital = (db) => Number(q(db, "SELECT Value v FROM settings WHERE Key='owner_capital'")?.v ?? 0);
  const fp = async (call) => await call('reports:financialPosition');
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A drawer is created cleanly, and only cleanly');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await call('cashAccounts:create', { AccountName: 'بنك مصر', AccountType: 'bank', Balance: 0 });
    t('a valid bank is created', ok?.success === true && ok?.id > 0, JSON.stringify(ok));
    const row = q(db, 'SELECT * FROM cash_accounts WHERE CashAccountID = ?', ok.id);
    t('it lands with its fields', row.AccountName === 'بنك مصر' && row.AccountType === 'bank' && row.IsActive === 1, JSON.stringify(row));
    const bal = await call('cashAccounts:create', { AccountName: 'خزنة ثانية', AccountType: 'safe', Balance: 15000 });
    t('an opening balance is accepted', bal?.success === true, JSON.stringify(bal));
    t('the balance is real', near(q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = ?', bal.id).v, 15000));

    const neg = await call('cashAccounts:create', { AccountName: 'مستحيلة', AccountType: 'safe', Balance: -99 });
    t('a negative opening balance is refused', neg?.success === false, neg?.message ?? '');
    const noName = await call('cashAccounts:create', { AccountName: '', AccountType: 'safe' });
    t('an unnamed drawer is refused', noName?.success === false, noName?.message ?? '');
    const alien = await call('cashAccounts:create', { AccountName: 'x', AccountType: 'BITCOIN' });
    t('an alien type is refused', alien?.success === false, alien?.message ?? '');
    const nan = await call('cashAccounts:create', { AccountName: 'x', AccountType: 'safe', Balance: 'oops' });
    t('a non-numeric balance is refused', nan?.success === false, nan?.message ?? '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] The machine registry has the same doors');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await call('paymentMethods:create', { MethodName: 'فودافون كاش', MethodType: 'digital_wallet', OpeningBalance: 800 });
    t('a wallet with an opening balance is created', ok?.success === true, JSON.stringify(ok));
    t('the balance is real', near(q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = ?', ok.id).v, 800));
    t('its capital walked with it (the books stay balanced)', near(capital(db), 105000 + 800), `capital ${capital(db)}`);
    const f = await fp(call);
    t('the balance sheet holds the new wallet', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));

    const neg = await call('paymentMethods:create', { MethodName: 'x', MethodType: 'pos_machine', OpeningBalance: -50 });
    t('a negative machine balance is refused', neg?.success === false, neg?.message ?? '');
    const alien = await call('paymentMethods:create', { MethodName: 'x', MethodType: 'ANYTHING' });
    t('an alien machine type is refused', alien?.success === false, alien?.message ?? '');
    const noName = await call('paymentMethods:create', { MethodName: '', MethodType: 'pos_machine' });
    t('an unnamed machine is refused', noName?.success === false, noName?.message ?? '');
    t('nothing was invented', near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM payment_methods WHERE PaymentMethodID <> 1').v === 1, '');
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Update renames, retypes and deactivates — while it exists');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('cashAccounts:create', { AccountName: 'بنك', AccountType: 'bank', Balance: 0 });
    const id = q(db, 'SELECT Max(CashAccountID) m FROM cash_accounts').m;
    const up = await call('cashAccounts:update', id, { AccountName: 'بنك الأهلي', AccountType: 'bank', IsActive: 1 });
    t('a rename succeeds', up?.success === true && q(db, 'SELECT AccountName v FROM cash_accounts WHERE CashAccountID = ?', id).v === 'بنك الأهلي', JSON.stringify(up));
    const ghost = await call('cashAccounts:update', 99999, { AccountName: 'x', AccountType: 'safe', IsActive: 1 });
    t('a ghost drawer update is refused', ghost?.success === false, ghost?.message ?? '');
    const dead = await call('cashAccounts:update', id, { AccountName: 'مغلق', AccountType: 'bank', IsActive: 0 });
    t('deactivation is possible', dead?.success === true && q(db, 'SELECT IsActive v FROM cash_accounts WHERE CashAccountID = ?', id).v === 0, JSON.stringify(dead));

    const loyalty = await call('paymentMethods:create', { MethodName: 'م', MethodType: 'pos_machine', OpeningBalance: 0 });
    const pid = loyalty.id;
    const mup = await call('paymentMethods:update', pid, { MethodName: 'ماكينة 2', MethodType: 'pos_machine', IsActive: 0 });
    t('a machine can be deactivated', mup?.success === true && q(db, 'SELECT IsActive v FROM payment_methods WHERE PaymentMethodID = ?', pid).v === 0, JSON.stringify(mup));
    t('the list filter honours the flag', (await call('cashAccounts:list', { isActive: 0 })).some(a => a.CashAccountID === id));
    t('the active-only list excludes it', !(await call('cashAccounts:list', { isActive: 1 })).some(a => a.CashAccountID === id));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] A deactivated account refuses fresh money');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('cashAccounts:create', { AccountName: 'مغلق', AccountType: 'safe', Balance: 1000 });
    const id = q(db, 'SELECT Max(CashAccountID) m FROM cash_accounts').m;
    const del = await call('cashAccounts:delete', id);
    t('a drawer holding money cannot be closed', del?.success === false, del?.message ?? '');
    t('it stays live', q(db, 'SELECT IsActive v FROM cash_accounts WHERE CashAccountID = ?', id).v === 1, '');
    const dead2 = await call('cashAccounts:update', id, { AccountName: 'مغلق', AccountType: 'safe', IsActive: 0 });
    t('closing it through the form is refused too', dead2?.success === false, dead2?.message ?? '');
    await call('vouchers:create', { VoucherType: 'payment', Amount: 1000, Description: 'تفريغ', CashAccountID: id, userId: 1, fiscalYearId: 1 });
    const closed = await call('cashAccounts:delete', id);
    t('once empty it closes', closed?.success === true && q(db, 'SELECT IsActive v FROM cash_accounts WHERE CashAccountID = ?', id).v === 0, JSON.stringify(closed));
    const v = await call('vouchers:create', { VoucherType: 'receipt', Amount: 300, Description: 'وارد', CashAccountID: id, userId: 1, fiscalYearId: 1 });
    t('a receipt into a deactivated drawer is refused', v?.success === false, v?.message ?? '');
    t('nothing moved', near(q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = ?', id).v, 0));

    await call('paymentMethods:create', { MethodName: 'مغلق', MethodType: 'pos_machine', OpeningBalance: 400 });
    const pid = q(db, 'SELECT Max(PaymentMethodID) m FROM payment_methods').m;
    const mdel = await call('paymentMethods:delete', pid);
    t('a machine holding money cannot be closed either', mdel?.success === false, mdel?.message ?? '');
    await call('vouchers:create', { VoucherType: 'payment', Amount: 400, Description: 'تفريغ', PaymentMethodID: pid, userId: 1, fiscalYearId: 1 });
    await call('paymentMethods:delete', pid);
    const mv = await call('vouchers:create', { VoucherType: 'receipt', Amount: 200, Description: 'وارد', PaymentMethodID: pid, userId: 1, fiscalYearId: 1 });
    t('a receipt into a deactivated machine is refused', mv?.success === false, mv?.message ?? '');
    t('the machine balance is untouched', near(q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = ?', pid).v, 0), '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] The balance sheet shows only live assets');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('cashAccounts:create', { AccountName: 'خزنة حية', AccountType: 'safe', Balance: 3000 });
    const liveId = q(db, 'SELECT Max(CashAccountID) m FROM cash_accounts').m;
    await call('cashAccounts:create', { AccountName: 'خزنة ميتة', AccountType: 'safe', Balance: 0 });
    const deadId = q(db, 'SELECT Max(CashAccountID) m FROM cash_accounts').m;
    await call('cashAccounts:delete', deadId);
    const f = await fp(call);
    t('the live drawer is on the sheet', f?.assets?.cashAccounts?.some(a => a.AccountName === 'خزنة حية'), JSON.stringify(f?.assets?.cashAccounts ?? []).slice(0, 200));
    t('the dead drawer is not', !f?.assets?.cashAccounts?.some(a => a.AccountName === 'خزنة ميتة'), '');
    t('the machine is on the sheet', f?.assets?.paymentMethods?.some(a => a.MethodName === 'ماكينة'), '');
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
    const l = await call('cashAccounts:list', {});
    t('the plain list still shows the dead one (delete is deactivate)', l.some(a => a.CashAccountID === deadId && a.IsActive === 0), '');
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] Delete guards — ghost, malformed, repeated');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ghost = await call('cashAccounts:delete', 99999);
    t('deleting a ghost drawer is refused', ghost?.success === false, ghost?.message ?? '');
    const g2 = await call('paymentMethods:delete', 99999);
    t('deleting a ghost machine is refused', g2?.success === false, g2?.message ?? '');
    const mal = await call('cashAccounts:delete', undefined);
    t('a malformed id does not crash', mal?.success === false, JSON.stringify(mal ?? {}).slice(0, 100));
    const m2 = await call('paymentMethods:delete', 'abc');
    t('a malformed machine id does not crash', m2?.success === false, JSON.stringify(m2 ?? {}).slice(0, 100));
    const del = await call('cashAccounts:delete', 1);
    t('a drawer holding money refuses to close', del?.success === false, del?.message ?? '');
    await call('transfers:create', {
      FromType: 'cash_account', FromID: 1, ToType: 'payment_method', ToID: 1,
      Amount: 100000, TransferCost: 0, TransferCostSource: 'separate', Notes: 'تفريغ', userId: 1, fiscalYearId: 1,
    });
    const del2 = await call('cashAccounts:delete', 1);
    t('once empty the seeded drawer closes', del2?.success === true && q(db, 'SELECT IsActive v FROM cash_accounts WHERE CashAccountID = 1').v === 0, JSON.stringify(del2));
    const again = await call('cashAccounts:delete', 1);
    t('deleting it again stays soft', again?.success === true, again?.message ?? '');
    t('the money arrived in the machine', near(wallet(db), 105000), `wallet ${wallet(db)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 7
  console.log('\n[7] Money flows through the registries and the sheet follows');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('cashAccounts:create', { AccountName: 'بنك القاهرة', AccountType: 'bank', Balance: 20000 });
    const bankId = q(db, 'SELECT Max(CashAccountID) m FROM cash_accounts').m;
    const r1 = await call('vouchers:create', { VoucherType: 'receipt', Amount: 1000, Description: 'إيداع', CashAccountID: bankId, userId: 1, fiscalYearId: 1 });
    t('a receipt into the bank works', r1?.success === true, r1?.message ?? '');
    const r2 = await call('vouchers:create', { VoucherType: 'payment', Amount: 500, Description: 'سحب', CashAccountID: bankId, userId: 1, fiscalYearId: 1 });
    t('a payment from it works', r2?.success === true, r2?.message ?? '');
    t('the bank balance follows', near(q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = ?', bankId).v, 20500), '');
    const cs = await call('cashAccount:statement', bankId, {});
    t('the bank statement foots', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), 500), `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the bank appears under liquid funds', f?.assets?.cashAccounts?.some(a => a.AccountName === 'بنك القاهرة'), JSON.stringify(f?.assets?.cashAccounts ?? []).slice(0, 160));
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  console.log(`\nSECTION 11 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_asset_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}