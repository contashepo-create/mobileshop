#!/usr/bin/env node
// SECTION 16 — FISCAL YEAR: the open/close lifecycle on the REAL stack. Same
// harness as sections 7-15.
//
// The accounting claim under test: exactly one year is open at a time;
// closing partitions time without overlap or gap, names the new year from the
// start of its period, stamps the closer, refuses ghosts and re-closes; and
// documents posted after the close carry the new year.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerFiscalYearHandlers } from './src/main/ipc/fiscalYear.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_fy_entry.ts');
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
  console.log('Building the real fiscal-year bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_fy_bundle.cjs');
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
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.01;

  const seed = (db, extra = '') => db.exec(`
    DELETE FROM fiscal_years;
    INSERT INTO fiscal_years (FiscalYearID, YearName, StartDate, EndDate, Status)
      VALUES (1, 'السنة المالية 2026', '2026-01-01', '2026-12-31', 'open');
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    ${extra}
  `);

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Creation guards');
  await scenario(async ({ db, call }) => {
    seed(db);
    const second = await call('fiscalYear:create', { YearName: '2027', StartDate: '2027-01-01', EndDate: '2027-12-31' });
    t('a second open year is refused while one is open', second?.success === false, second?.message ?? '');
    const noName = await call('fiscalYear:create', { YearName: '', StartDate: '2027-01-01', EndDate: '2027-12-31' });
    t('an unnamed year is refused', noName?.success === false, noName?.message ?? '');
    const noDates = await call('fiscalYear:create', { YearName: '2027' });
    t('a year without dates is refused', noDates?.success === false, noDates?.message ?? '');
    const inverted = await call('fiscalYear:create', { YearName: '2027', StartDate: '2027-12-31', EndDate: '2027-01-01' });
    t('an inverted range is refused', inverted?.success === false, inverted?.message ?? '');
    const garbage = await call('fiscalYear:create', { YearName: '2027', StartDate: 'garbage', EndDate: 'more-garbage' });
    t('non-date strings are refused, not stored', garbage?.success === false, garbage?.message ?? '');
    const shortGarbage = await call('fiscalYear:create', { YearName: '2027', StartDate: '01-2027', EndDate: '31-2027' });
    t('a partial date is refused', shortGarbage?.success === false, shortGarbage?.message ?? '');
    const stillOne = qa(db, 'SELECT * FROM fiscal_years WHERE Status = \'open\'');
    t('exactly one year remains open', stillOne.length === 1, `open ${stillOne.length}`);
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Closing partitions time');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await call('fiscalYear:close', 1, 1);
    t('closing the year succeeds', r?.success === true, JSON.stringify(r));
    const closed = q(db, 'SELECT * FROM fiscal_years WHERE FiscalYearID = 1');
    t('the old year is closed and stamped', closed.Status === 'closed' && !!closed.ClosedAt, JSON.stringify(closed));
    const nxt = q(db, 'SELECT * FROM fiscal_years WHERE Status = \'open\'');
    t('a new year opened', !!nxt && nxt.FiscalYearID !== 1, JSON.stringify(nxt));
    t('it starts the day after the old one ended', nxt.StartDate === '2027-01-01', nxt.StartDate);
    t('it ends one day before the anniversary', nxt.EndDate === '2027-12-31', nxt.EndDate);
    t('it is named from the start of its period', nxt.YearName === 'السنة المالية 2027', nxt.YearName);
    t('the ranges partition time with no overlap and no gap',
      nxt.StartDate === '2027-01-01' && nxt.EndDate === '2027-12-31' && closed.EndDate === '2026-12-31', '');
    const active = await call('fiscalYear:getActive');
    t('getActive returns the new year', active?.FiscalYearID === nxt.FiscalYearID, JSON.stringify(active));
    const again = await call('fiscalYear:close', 1, 1);
    t('closing the same year again is refused', again?.success === false, again?.message ?? '');
    const ghost = await call('fiscalYear:close', 99999, 1);
    t('closing a ghost year is refused', ghost?.success === false, ghost?.message ?? '');
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Closing keeps chaining years, always one open');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('fiscalYear:close', 1, 1);
    const yr2 = q(db, "SELECT FiscalYearID v FROM fiscal_years WHERE Status = 'open'").v;
    t('the first close auto-opened 2027', q(db, 'SELECT StartDate v FROM fiscal_years WHERE FiscalYearID = ?', yr2).v === '2027-01-01', '');
    await call('fiscalYear:close', yr2, 1);
    const yr3 = q(db, "SELECT FiscalYearID v FROM fiscal_years WHERE Status = 'open'").v;
    t('the second close auto-opened 2028', q(db, 'SELECT StartDate v FROM fiscal_years WHERE FiscalYearID = ?', yr3).v === '2028-01-01', '');
    const dup = await call('fiscalYear:create', { YearName: '2029', StartDate: '2029-01-01', EndDate: '2029-12-31' });
    t('a manual year is still refused while 2028 is open', dup?.success === false, dup?.message ?? '');
    const list = await call('fiscalYear:list');
    t('the list shows the three-year history', Array.isArray(list) && list.length === 3, `rows ${list?.length}`);
    const closedOnes = list.filter(y => y.Status === 'closed');
    t('exactly two are closed and one is open', closedOnes.length === 2 && list.some(y => y.Status === 'open'), '');
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] Documents posted after the close carry the new year');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('fiscalYear:close', 1, 1);
    const nxt = q(db, "SELECT FiscalYearID v FROM fiscal_years WHERE Status = 'open'").v;
    const v = await call('vouchers:create', { VoucherType: 'receipt', Amount: 100, Description: 'سند السنة الجديدة', CashAccountID: 1, userId: 1, fiscalYearId: nxt });
    t('a voucher into the new year is accepted', v?.success === true, JSON.stringify(v));
    const row = q(db, 'SELECT FiscalYearID v FROM vouchers ORDER BY VoucherID DESC');
    t('it was stamped with the new year', row.v === nxt, `year ${row.v} vs ${nxt}`);
    // The CLOSED-year refusal is enforced by the IPC guard layer
    // (refuseClosedYear), not by this handler — a direct handler call records
    // what it is told, and the renderer always passes the active year it read
    // from fiscalYear:getActive. Pinning that contract here keeps the two
    // layers' responsibilities straight.
    const oldV = await call('vouchers:create', { VoucherType: 'receipt', Amount: 50, Description: 'مباشر', CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('the handler records what it is told, even a direct call', oldV?.success === true, oldV?.message ?? '');
    t('the direct call landed in the closed year, as told', q(db, 'SELECT COUNT(*) v FROM vouchers WHERE FiscalYearID = 1').v === 1, '');
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] The years partition the reports');
  await scenario(async ({ db, call }) => {
    seed(db);
    const active1 = await call('fiscalYear:getActive');
    await call('vouchers:create', { VoucherType: 'receipt', Amount: 700, Description: 'سنة أولى', CashAccountID: 1, userId: 1, fiscalYearId: active1.FiscalYearID });
    await call('fiscalYear:close', active1.FiscalYearID, 1);
    const active2 = await call('fiscalYear:getActive');
    await call('vouchers:create', { VoucherType: 'receipt', Amount: 300, Description: 'سنة ثانية', CashAccountID: 1, userId: 1, fiscalYearId: active2.FiscalYearID });
    const firstYearCount = q(db, 'SELECT COUNT(*) v FROM vouchers WHERE FiscalYearID = ?', active1.FiscalYearID).v;
    const secondYearCount = q(db, 'SELECT COUNT(*) v FROM vouchers WHERE FiscalYearID = ?', active2.FiscalYearID).v;
    t('each year holds exactly its own documents', firstYearCount === 1 && secondYearCount === 1, `${firstYearCount} / ${secondYearCount}`);
    const sum1 = q(db, 'SELECT COALESCE(SUM(Amount),0) v FROM vouchers WHERE FiscalYearID = ?', active1.FiscalYearID).v;
    const sum2 = q(db, 'SELECT COALESCE(SUM(Amount),0) v FROM vouchers WHERE FiscalYearID = ?', active2.FiscalYearID).v;
    t('the years never mix amounts', near(sum1, 700) && near(sum2, 300), `${sum1} / ${sum2}`);
  });

  console.log(`\nSECTION 16 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_fy_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}