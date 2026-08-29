#!/usr/bin/env node
// SECTION 16 — FISCAL YEAR: the open/close lifecycle on the REAL stack. Same
// harness as sections 7-15.
//
// The accounting claim under test: a year can only be closed once it has
// ACTUALLY ended; closing partitions time without overlap or gap, names the
// new year from the start of its period, stamps the closer, carries the
// balances into the new year as written opening balances, refuses ghosts and
// re-closes; a non-overlapping year (a past year opened beside the current
// one, for backdated documents) is allowed; and documents posted after the
// close carry the new year.
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
export { businessToday } from './src/shared/businessDate.ts';
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

  // Seed a year that has DEFINITELY ended (2020), so closing it is legal under
  // the EndDate guard whatever day the suite runs.
  const seed = (db, extra = '') => db.exec(`
    DELETE FROM fiscal_years;
    INSERT INTO fiscal_years (FiscalYearID, YearName, StartDate, EndDate, Status)
      VALUES (1, 'السنة المالية 2020', '2020-01-01', '2020-12-31', 'open');
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    ${extra}
  `);

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Creation guards');
  await scenario(async ({ db, call }) => {
    seed(db);
    const overlapping = await call('fiscalYear:create', { YearName: '2021', StartDate: '2020-06-01', EndDate: '2021-05-31' });
    t('an open year overlapping the current one is refused', overlapping?.success === false, overlapping?.message ?? '');
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
    t('exactly one year remains open after the refusals', stillOne.length === 1, `open ${stillOne.length}`);

    // NEW CONTRACT: a year whose period does NOT overlap the open one may be
    // opened beside it — the backdating case (a shop that started using the
    // system this year and needs a 2019 year for its old register). The
    // posting guard is date-driven, so a document dated 2019 lands in 2019
    // no matter which year id the screen sends.
    const past = await call('fiscalYear:create', { YearName: 'السنة المالية 2019', StartDate: '2019-01-01', EndDate: '2019-12-31' });
    t('a non-overlapping past year can be opened beside the current one', past?.success === true, JSON.stringify(past));
    const twoOpen = qa(db, "SELECT * FROM fiscal_years WHERE Status = 'open' ORDER BY StartDate");
    t('two open years now coexist, periods apart', twoOpen.length === 2, `open ${twoOpen.length}`);
    const active = await call('fiscalYear:getActive');
    t('getActive still resolves the LATEST open year (2020)', active?.FiscalYearID === 1 && active?.StartDate === '2020-01-01', JSON.stringify(active));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Closing partitions time and carries the balances');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await call('fiscalYear:close', 1, 1);
    t('closing the year succeeds', r?.success === true, JSON.stringify(r));
    const closed = q(db, 'SELECT * FROM fiscal_years WHERE FiscalYearID = 1');
    t('the old year is closed and stamped', closed.Status === 'closed' && !!closed.ClosedAt, JSON.stringify(closed));
    const nxt = q(db, 'SELECT * FROM fiscal_years WHERE Status = \'open\'');
    t('a new year opened', !!nxt && nxt.FiscalYearID !== 1, JSON.stringify(nxt));
    t('it starts the day after the old one ended', nxt.StartDate === '2021-01-01', nxt.StartDate);
    t('it ends one day before the anniversary', nxt.EndDate === '2021-12-31', nxt.EndDate);
    t('it is named from the start of its period', nxt.YearName === 'السنة المالية 2021', nxt.YearName);
    t('the ranges partition time with no overlap and no gap',
      nxt.StartDate === '2021-01-01' && nxt.EndDate === '2021-12-31' && closed.EndDate === '2020-12-31', '');
    const active = await call('fiscalYear:getActive');
    t('getActive returns the new year', active?.FiscalYearID === nxt.FiscalYearID, JSON.stringify(active));
    const again = await call('fiscalYear:close', 1, 1);
    t('closing the same year again is refused', again?.success === false, again?.message ?? '');
    const ghost = await call('fiscalYear:close', 99999, 1);
    t('closing a ghost year is refused', ghost?.success === false, ghost?.message ?? '');

    // The balance snapshot: the 100000 in the cash account at the moment of
    // the close becomes the new year's WRITTEN opening balance, for every
    // account family the owner asked to see on the fiscal-year screen.
    const cashOpen = q(db, 'SELECT Balance v FROM fiscal_year_openings WHERE FiscalYearID = ? AND AccountType = \'cash_account\' AND AccountID = 1', nxt.FiscalYearID);
    t('the cash balance was carried as the new year\'s opening', near(cashOpen?.v, 100000), JSON.stringify(cashOpen));
    const count = q(db, 'SELECT COUNT(*) v FROM fiscal_year_openings WHERE FiscalYearID = ?', nxt.FiscalYearID);
    t('the opening snapshot covers every family with a position (cash + the two equity rows here)',
      count.v === 3, `rows ${count.v}`);
    const retained = q(db, "SELECT Balance v FROM fiscal_year_openings WHERE FiscalYearID = ? AND AccountType = 'equity_retained'", nxt.FiscalYearID);
    t('retained earnings are derived from the books (100000 - 0 - 0 here)',
      near(retained?.v, 100000), JSON.stringify(retained));
    const assets = q(db, `
      SELECT COALESCE(SUM(Balance),0) v FROM fiscal_year_openings
      WHERE FiscalYearID = ? AND AccountType IN ('cash_account','payment_method','customer','inventory','advance','supplier_credit','rent_advance_held')`, nxt.FiscalYearID);
    const liabilities = q(db, `
      SELECT COALESCE(SUM(Balance),0) v FROM fiscal_year_openings
      WHERE FiscalYearID = ? AND AccountType IN ('supplier','employee','customer_credit','commission','rent_advance_collected')`, nxt.FiscalYearID);
    const equity = q(db, `
      SELECT COALESCE(SUM(Balance),0) v FROM fiscal_year_openings
      WHERE FiscalYearID = ? AND AccountType IN ('equity_capital','equity_retained')`, nxt.FiscalYearID);
    t('the closing document balances by construction (assets = liabilities + equity)',
      near(assets.v, (liabilities.v ?? 0) + (equity.v ?? 0)),
      `assets ${assets.v} / liab ${liabilities.v} / equity ${equity.v}`);
    const activeOpen = await call('fiscalYear:getActive');
    t('getActive exposes the opening balances', Array.isArray(activeOpen?.openingBalances) && activeOpen.openingBalances.length > 0,
      JSON.stringify(activeOpen?.openingBalances));

    // REOPEN: a closed year can be deliberately reopened to record old
    // operations; the opening snapshots of the years after it are dropped
    // (they are re-taken at the next close, since late entries moved them).
    const reopen = await call('fiscalYear:reopen', 1, 1);
    t('reopening the closed year succeeds', reopen?.success === true, JSON.stringify(reopen));
    t('the year is open again', q(db, 'SELECT Status v FROM fiscal_years WHERE FiscalYearID = 1').v === 'open', '');
    const left = q(db, 'SELECT COUNT(*) v FROM fiscal_year_openings WHERE FiscalYearID > 1');
    t('the later years\' opening snapshots were dropped', left.v === 0, `rows ${left.v}`);
    const reopenAgain = await call('fiscalYear:reopen', 1, 1);
    t('reopening an already-open year is refused', reopenAgain?.success === false, reopenAgain?.message ?? '');
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Closing keeps chaining years, always one open');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('fiscalYear:close', 1, 1);
    const yr2 = q(db, "SELECT FiscalYearID v FROM fiscal_years WHERE Status = 'open'").v;
    t('the first close auto-opened 2021', q(db, 'SELECT StartDate v FROM fiscal_years WHERE FiscalYearID = ?', yr2).v === '2021-01-01', '');
    await call('fiscalYear:close', yr2, 1);
    const yr3 = q(db, "SELECT FiscalYearID v FROM fiscal_years WHERE Status = 'open'").v;
    t('the second close auto-opened 2022', q(db, 'SELECT StartDate v FROM fiscal_years WHERE FiscalYearID = ?', yr3).v === '2022-01-01', '');
    const dup = await call('fiscalYear:create', { YearName: '2023', StartDate: '2022-06-01', EndDate: '2023-05-31' });
    t('a manual year OVERLAPPING the open 2022 is refused', dup?.success === false, dup?.message ?? '');
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

  // ---------------------------------------------------------------- 6
  console.log('\n[6] A year that has NOT ended cannot be closed');
  await scenario(async ({ db, call }) => {
    // The CURRENT calendar year: on any date the suite runs, it has not
    // ended yet — so closing it must be refused by the EndDate guard.
    const today = mod.businessToday();
    const y = today.slice(0, 4);
    db.exec(`
      DELETE FROM fiscal_years;
      INSERT INTO fiscal_years (FiscalYearID, YearName, StartDate, EndDate, Status)
        VALUES (1, 'السنة المالية ${y}', '${y}-01-01', '${y}-12-31', 'open');
    `);
    const r = await call('fiscalYear:close', 1, 1);
    t('closing the current (not-yet-ended) year is refused',
      r?.success === false && /انتهائها/.test(r?.message ?? ''), JSON.stringify(r));
    const stillOpen = q(db, "SELECT COUNT(*) v FROM fiscal_years WHERE Status = 'open'").v;
    t('the year stays open and untouched after the refusal', stillOpen === 1, '');
    const noNewYear = q(db, 'SELECT COUNT(*) v FROM fiscal_years');
    t('no new year was created by the refused close', noNewYear.v === 1, `rows ${noNewYear.v}`);
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
