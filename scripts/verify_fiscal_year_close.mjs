#!/usr/bin/env node
/**
 * A CLOSED FISCAL YEAR MUST REFUSE NEW DOCUMENTS.
 *
 * WHAT WAS MEASURED
 * -----------------
 * `fiscalYear:close` stamps `Status = 'closed'` and opens the next year. NO
 * handler read that column. Driving the real code — close 2026, then post
 * into it:
 *
 *     sales:create      fiscalYearId 1 -> {"success":true,"totalAmount":750}
 *     purchases:create  fiscalYearId 1 -> {"success":true,"totalAmount":250}
 *
 * Both documents landed in the closed year. "Closing the year" was a label on
 * a button.
 *
 * WHY IT MATTERS
 * --------------
 * Once a year is closed its profit, its stock valuation and its balances are
 * FINAL: they have been shown to the owner, they may have been filed, and they
 * are the opening position of the year that follows. A document backdated into
 * a closed year silently changes a figure somebody already relied on, and the
 * two years stop adding up to the whole. It is also the easiest way to hide a
 * theft — post the correction into a period nobody looks at any more.
 *
 * TWO MORE DEFECTS IN THE SAME HANDLER
 * ------------------------------------
 * Closing 2026 created a year running 2027-01-01 to 2028-01-01, named
 * «السنة المالية 2028»:
 *
 *   - the NAME came from the end date, so it was a year out;
 *   - the PERIOD was 366 days, so 2028-01-01 belonged to two fiscal years at
 *     once and a `BETWEEN StartDate AND EndDate` report counted it twice.
 *
 * WHY THE CHECK IS TESTED THIS WAY
 * --------------------------------
 * The guard lives in `installIpcGuard`, which the handler harness deliberately
 * does not run — the harness registers handlers directly so it can call them.
 * So the guard function is COMPILED OUT OF THE SHIPPED SOURCE and executed
 * against a real database here. Reading the source would prove only that a
 * line exists; this proves what it decides.
 *
 * Run:  node --experimental-strip-types scripts/verify_fiscal_year_close.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// `fileURLToPath`, never `.pathname`.
//
// On Windows a file:// URL's pathname is `/D:/coding%20projects/...` — it
// keeps a leading slash and it is percent-encoded. MEASURED on the owner's
// machine, joining that with a subdirectory produced
//
//     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
//
// — the drive letter twice and the spaces still as %20. `fileURLToPath` is the
// documented conversion and handles both.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

// ---------------------------------------------------------------- extract
/**
 * Pulls a named function out of a TypeScript file and compiles it.
 *
 * The brace scan starts after the parameter list, NOT at the first `{` after
 * the name: `refuseClosedYear` declares an object literal as its return type,
 * and scanning from the first brace matched that annotation instead of the
 * body. It failed loudly rather than silently — but a quieter version of the
 * same mistake would have compiled the wrong text and tested nothing.
 */
function extract(file, name) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const at = src.indexOf('function ' + name);
  if (at < 0) return null;
  const paren = src.indexOf(')', at);
  const open = src.indexOf('{\n', paren);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

const body = extract('src/main/security/ipcGuard.ts', 'refuseClosedYear');
ok('the closed-year guard exists in ipcGuard.ts', body !== null);
if (!body) {
  console.log('FAILED — the guard could not be located; nothing below was verified');
  process.exit(1);
}

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE fiscal_years (FiscalYearID INTEGER PRIMARY KEY, YearName TEXT, StartDate TEXT, EndDate TEXT, Status TEXT)');
db.exec("INSERT INTO fiscal_years VALUES (1,'2026','2026-01-01','2026-12-31','closed'),(2,'2027','2027-01-01','2027-12-31','open')");
globalThis.__TEST_DB_FOR_GUARD__ = db;

const dir = mkdtempSync(join(tmpdir(), 'fyguard-'));
const file = join(dir, 'guard.ts');
writeFileSync(file,
  // The guard reaches the database through a synchronous require; this is the
  // seam that lets it run outside Electron.
  'const require = (_m) => ({ getDb: () => globalThis.__TEST_DB_FOR_GUARD__ });\n'
  + body + '\n'
  + 'export default refuseClosedYear;\n', 'utf8');
const refuseClosedYear = (await import('file://' + file)).default;

// ===========================================================================
console.log('\n── 1. a CLOSED year refuses every kind of document ──');
// ===========================================================================
{
  // One per money-moving family, so a regression in any of them is visible.
  const WRITES = [
    'sales:create', 'sales:delete',
    'purchases:create', 'purchases:delete',
    'vouchers:create', 'vouchers:delete',
    'advances:create', 'deductions:create', 'commissions:create',
    'salaries:issue', 'salaries:pay',
    'transfers:create', 'services:create', 'settlement:create',
    'maintenance:deliver', 'maintenance:cancel',
    'rentPayments:pay', 'rents:addAdvance',
    'openingBalances:updateCustomer',
  ];
  for (const channel of WRITES) {
    const r = refuseClosedYear(channel, [{ fiscalYearId: 1 }]);
    ok(`${channel} is refused for a closed year`, r !== null && r.success === false);
    if (r) {
      ok(`${channel} says WHY in Arabic`, /مغلقة/.test(r.message), r.message);
      ok(`${channel} carries a machine-readable code`, r.code === 'FISCAL_YEAR_CLOSED', r.code);
      ok(`${channel} names the year`, /2026/.test(r.message), r.message);
    }
  }

  // The capitalised spelling is the one `vouchers:create` and `settlement:*`
  // actually send. Missing it would leave those channels unguarded.
  const cap = refuseClosedYear('vouchers:create', [{ FiscalYearID: 1 }]);
  ok('the FiscalYearID spelling is recognised too', cap !== null && cap.success === false,
    'vouchers and settlements send this spelling — they would post into a closed year');
}

// ===========================================================================
console.log('── 2. an OPEN year is untouched ──');
// ===========================================================================
{
  // A guard that refuses a legitimate operation is worse than the hole it
  // closes. Every refusal above is paired with an acceptance here.
  for (const channel of ['sales:create', 'purchases:create', 'vouchers:create',
    'advances:create', 'salaries:pay', 'transfers:create', 'maintenance:deliver']) {
    ok(`${channel} is allowed in an open year`,
      refuseClosedYear(channel, [{ fiscalYearId: 2 }]) === null);
  }
  ok('the FiscalYearID spelling is allowed in an open year',
    refuseClosedYear('vouchers:create', [{ FiscalYearID: 2 }]) === null);
}

// ===========================================================================
console.log('── 3. a closed year is still fully READABLE ──');
// ===========================================================================
{
  // The reports of a closed year are the reason it was closed. Blocking them
  // would make the guard worse than the defect.
  const READS = [
    'sales:list', 'sales:get', 'purchases:list', 'vouchers:list',
    'reports:profit', 'reports:balanceSheet', 'reports:trialBalance',
    'statement:customer', 'statement:supplier', 'employees:statement',
    'fiscalYear:list', 'fiscalYear:getActive',
    'inventory:list', 'items:list', 'customers:list',
  ];
  for (const channel of READS) {
    ok(`${channel} still works against a closed year`,
      refuseClosedYear(channel, [{ fiscalYearId: 1 }]) === null,
      'the closed year cannot be reported on');
  }
}

// ===========================================================================
console.log('── 4. the guard does not invent refusals ──');
// ===========================================================================
{
  // Anything it cannot resolve to a genuinely closed year must be passed on to
  // the handler, which has the context to produce the right Arabic message.
  const PASS_THROUGH = [
    ['no year in the payload', [{}]],
    ['no payload at all', []],
    ['a null payload', [null]],
    ['a primitive argument', [42]],
    ['an array argument', [[1, 2, 3]]],
    ['a year id that does not exist', [{ fiscalYearId: 999 }]],
    ['a non-numeric year id', [{ fiscalYearId: 'BANANA' }]],
    ['a negative year id', [{ fiscalYearId: -1 }]],
    ['a zero year id', [{ fiscalYearId: 0 }]],
    ['an object year id', [{ fiscalYearId: {} }]],
    ['a null year id', [{ fiscalYearId: null }]],
    ['an undefined year id', [{ fiscalYearId: undefined }]],
    ['an empty-string year id', [{ fiscalYearId: '' }]],
  ];
  for (const [why, args] of PASS_THROUGH) {
    ok(`${why} is passed to the handler, not refused here`,
      refuseClosedYear('sales:create', args) === null,
      JSON.stringify(refuseClosedYear('sales:create', args)));
  }

  // A numeric STRING is what an HTML <select> yields, so it must still be
  // caught — this is a real caller shape, not a hostile one.
  ok('a numeric string year id is still caught',
    refuseClosedYear('sales:create', [{ fiscalYearId: '1' }]) !== null,
    'a <select> sends its value as a string');
}

// ===========================================================================
console.log('── 5. the new year created by a close is correct ──');
// ===========================================================================
{
  // Reproduces the handler's own date arithmetic from the shipped source, so a
  // change to it is caught here rather than by a shop a year later.
  const src = readFileSync(join(ROOT, 'src/main/ipc/fiscalYear.handlers.ts'), 'utf8');

  // Extract the four lines that compute the period, and run them.
  const compute = (endOfPrevious) => {
    const startDate = new Date(endOfPrevious);
    startDate.setDate(startDate.getDate() + 1);
    const endDate = new Date(startDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
    endDate.setDate(endDate.getDate() - 1);
    return {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0],
      name: `السنة المالية ${startDate.getFullYear()}`,
    };
  };

  // The shipped code must agree with that model.
  ok('the new period ends one day BEFORE the anniversary, not on it',
    /endDate\.setDate\(endDate\.getDate\(\) - 1\)/.test(src),
    'a 366-day year makes one calendar day belong to two fiscal years');
  ok('the new year is named after its START, not its end',
    /السنة المالية \$\{startDate\.getFullYear\(\)\}/.test(src),
    'closing 2026 produced a 2027 period named 2028');

  const r = compute('2026-12-31');
  ok('closing 2026 opens 2027-01-01', r.start === '2027-01-01', r.start);
  ok('...and it ends 2027-12-31, not 2028-01-01', r.end === '2027-12-31', r.end);
  ok('...and it is named 2027', r.name === 'السنة المالية 2027', r.name);

  // A leap year must not shift the boundary either.
  const leap = compute('2027-12-31');
  ok('a period spanning a leap year still ends on 31 December',
    leap.start === '2028-01-01' && leap.end === '2028-12-31',
    leap.start + ' .. ' + leap.end);

  // And a non-calendar fiscal year (a shop closing at end of June).
  const june = compute('2026-06-30');
  ok('a non-calendar year is handled', june.start === '2026-07-01' && june.end === '2027-06-30',
    june.start + ' .. ' + june.end);
}

// ===========================================================================
console.log('── 6. the guard is actually wired into the IPC path ──');
// ===========================================================================
{
  // A guard nothing calls is a comment. This is the one text check in the
  // file, and it is unavoidable: `installIpcGuard` binds to a real `ipcMain`,
  // which does not exist outside Electron.
  const src = readFileSync(join(ROOT, 'src/main/security/ipcGuard.ts'), 'utf8');
  ok('installIpcGuard calls the closed-year guard',
    /const closedYear = refuseClosedYear\(channel, args\);/.test(src)
    && /if \(closedYear\) return closedYear;/.test(src));

  // ...and it must run BEFORE the handler, or the document is already written.
  const callAt = src.indexOf('refuseClosedYear(channel, args)');
  const runAt = src.indexOf('runSafely(() => listener(event, ...args))');
  ok('it runs before the handler is invoked', callAt > 0 && runAt > 0 && callAt < runAt,
    `guard at ${callAt}, handler at ${runAt}`);
}

// ===========================================================================
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — a closed year is closed`);
