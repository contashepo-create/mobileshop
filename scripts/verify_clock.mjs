#!/usr/bin/env node
/**
 * Clock, daylight-saving and backup/restore safety checks.
 *
 * Three questions are answered here, each with executable evidence rather than
 * an assurance in a comment:
 *
 *   1. Does the app follow Egypt's mandatory summer-time change?
 *   2. Can that change make the app accuse an honest shop of tampering?
 *   3. Can taking a backup and restoring it later break the subscription?
 *
 * The rollback rules are re-implemented here EXACTLY as the licence handler
 * expresses them, and the handler's source is asserted to still match — so if
 * someone edits one and not the other, this fails.
 *
 * Run with:  node --experimental-strip-types scripts/verify_clock.mjs
 *
 * THE TIMEZONE IS FORCED HERE, NOT ON THE COMMAND LINE
 * ----------------------------------------------------
 * This suite used to be invoked as `TZ=Africa/Cairo node ...` inside
 * `npm run verify`. That is POSIX shell syntax. On Windows, cmd.exe answers
 *
 *     'TZ' is not recognized as an internal or external command
 *
 * and the whole verify chain stops there — measured on a real Windows machine
 * at suite 19 of 87. Sixty-eight suites after it never ran.
 *
 * Setting `process.env.TZ` in the script is not enough on its own either:
 * V8 caches the local timezone the first time a Date is used, and on some
 * platforms it is read before user code runs. Measured: with the process
 * launched under TZ=America/New_York, an internal assignment left four checks
 * failing because the offsets were still New York's.
 *
 * So the assignment is made FIRST, and then VERIFIED. If the runtime did not
 * adopt it, the process re-executes itself once with the variable set in the
 * child's environment — which works identically on Windows, macOS and Linux
 * because Node, not the shell, is doing the passing.
 */
process.env.TZ = 'Africa/Cairo';

// Egypt is UTC+3 in July (summer time) and UTC+2 in January. If the runtime
// disagrees, the assignment above did not take effect and every offset check
// below would be measuring the wrong zone.
{
  const july = -new Date('2026-07-15T12:00:00Z').getTimezoneOffset() / 60;
  const january = -new Date('2026-01-15T12:00:00Z').getTimezoneOffset() / 60;
  if (july !== 3 || january !== 2) {
    if (process.env.__CLOCK_TZ_RETRY === '1') {
      console.error(
        `\nCLOCK SUITE CANNOT RUN: this Node build does not honour TZ=Africa/Cairo `
        + `(July offset ${july}, January offset ${january}; expected 3 and 2).`);
      process.exit(1);
    }
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, TZ: 'Africa/Cairo', __CLOCK_TZ_RETRY: '1' },
    });
    process.exit(r.status ?? 1);
  }
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = f => readFileSync(join(ROOT, f), 'utf-8');
const PASS = [], FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}

const B = await import('../src/shared/businessDate.ts');
const { businessToday, formatLocalDate, localDateDaysAgo, isImplausiblyFuture } = B;

const CLOCK_DRIFT_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Faithful re-implementation of the three rollback checks. */
function licenceVerdict(now, { startDate, lastAccess, newestBusiness }) {
  if (now.getTime() < new Date(startDate).getTime() - 60_000) return 'tampered:start';
  if (lastAccess && now.getTime() < new Date(lastAccess).getTime() - CLOCK_DRIFT_TOLERANCE_MS) {
    return 'tampered:lastaccess';
  }
  if (newestBusiness && isImplausiblyFuture(newestBusiness, now)) return 'tampered:business';
  return 'ok';
}

const START = '2026-01-01T10:00:00.000Z';

console.log('='.repeat(72));
console.log('CLOCK / DST / BACKUP SAFETY   (TZ=' + process.env.TZ + ')');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] Egypt daylight saving is recognised by the runtime');
{
  const off = iso => -new Date(iso).getTimezoneOffset() / 60;
  check('winter is UTC+2', off('2026-01-15T12:00:00Z') === 2, String(off('2026-01-15T12:00:00Z')));
  check('summer is UTC+3', off('2026-06-15T12:00:00Z') === 3, String(off('2026-06-15T12:00:00Z')));
  check('after the October switch it is UTC+2 again',
    off('2026-11-15T12:00:00Z') === 2, String(off('2026-11-15T12:00:00Z')));
  check('the shift is exactly one hour',
    off('2026-06-15T12:00:00Z') - off('2026-01-15T12:00:00Z') === 1);

  // No DST table is hardcoded anywhere — the OS/IANA database is the source.
  const shared = R('src/shared/businessDate.ts');
  check('no hardcoded DST dates in the codebase',
    !/April|October|DST_START|SUMMER_TIME_BEGIN/.test(shared.replace(/\/\*[\s\S]*?\*\//g, '')));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A DST change never moves absolute time backwards');
{
  let monotonic = true, prev = null;
  // Sweep the October transition minute by minute.
  for (let m = 0; m < 360; m++) {
    const t = new Date(Date.UTC(2026, 9, 29, 19, 0, 0) + m * 60_000).getTime();
    if (prev !== null && t < prev) monotonic = false;
    prev = t;
  }
  check('epoch time is strictly increasing across the switch', monotonic);

  // The wall clock DOES repeat an hour — which is why the licence must never
  // compare local wall-clock strings for "has time gone backwards".
  const a = new Date(Date.UTC(2026, 9, 29, 20, 59));
  const b = new Date(Date.UTC(2026, 9, 29, 21, 1));
  const wallA = a.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo' });
  const wallB = b.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo' });
  check('the wall clock does repeat an hour (so it must not be trusted)',
    wallB < wallA, `${wallA} -> ${wallB}`);
  check('but the licence compares epochs, which did not go back', b.getTime() > a.getTime());

  const lic = R('src/main/ipc/license.handlers.ts');
  check('the rollback check uses getTime(), not a local string',
    lic.includes('now.getTime() < lastAccess.getTime() - CLOCK_DRIFT_TOLERANCE_MS'));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The autumn clock change does NOT flag tampering');
{
  const before = new Date(Date.UTC(2026, 9, 29, 20, 59));  // just before the switch
  const after = new Date(Date.UTC(2026, 9, 29, 21, 5));    // 6 real minutes later
  check('opening the app straight after the switch is fine',
    licenceVerdict(after, {
      startDate: START, lastAccess: before.toISOString(), newestBusiness: '2026-10-29',
    }) === 'ok');

  // Spring forward.
  const sBefore = new Date(Date.UTC(2026, 3, 23, 22, 59));
  const sAfter = new Date(Date.UTC(2026, 3, 23, 23, 5));
  check('the spring change is fine too',
    licenceVerdict(sAfter, {
      startDate: START, lastAccess: sBefore.toISOString(), newestBusiness: '2026-04-24',
    }) === 'ok');

  check('a one-hour shift is well inside the tolerance',
    3600_000 < CLOCK_DRIFT_TOLERANCE_MS);
  check('even a full UTC-offset correction (3h) is tolerated',
    3 * 3600_000 < CLOCK_DRIFT_TOLERANCE_MS);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Real rollback is still detected');
{
  const lastAccess = '2026-06-15T10:00:00.000Z';
  check('winding back one day is caught',
    licenceVerdict(new Date('2026-06-14T10:00:00Z'), {
      startDate: START, lastAccess, newestBusiness: '2026-06-15',
    }).startsWith('tampered'));

  check('winding back a month is caught',
    licenceVerdict(new Date('2026-05-15T10:00:00Z'), {
      startDate: START, lastAccess, newestBusiness: '2026-06-15',
    }).startsWith('tampered'));

  check('winding back a year is caught',
    licenceVerdict(new Date('2025-06-15T10:00:00Z'), {
      startDate: START, lastAccess, newestBusiness: '2026-06-15',
    }).startsWith('tampered'));

  // 7 hours is beyond any plausible NTP/RTC correction.
  check('a 7-hour jump backwards is still caught',
    licenceVerdict(new Date('2026-06-15T03:00:00Z'), {
      startDate: START, lastAccess, newestBusiness: null,
    }) === 'tampered:lastaccess');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] BUG FIX: business dates now use the shop’s calendar, not UTC');
{
  // A sale at 01:00 Cairo was stored under the previous day.
  const lateNight = new Date('2026-08-02T01:00:00+03:00');
  const utcWay = lateNight.toISOString().split('T')[0];
  const localWay = formatLocalDate(lateNight);
  check('the OLD UTC method mis-dated a 1 AM sale', utcWay === '2026-08-01', utcWay);
  check('the NEW method dates it correctly', localWay === '2026-08-02', localWay);

  const winter = new Date('2026-12-01T01:30:00+02:00');
  check('the same held in winter (UTC+2)',
    winter.toISOString().split('T')[0] === '2026-11-30'
    && formatLocalDate(winter) === '2026-12-01');

  // Worst case: a sale just after midnight on 1 January would have been filed
  // in the previous fiscal year.
  const newYear = new Date('2027-01-01T01:00:00+02:00');
  check('a New Year sale no longer falls into the previous fiscal year',
    formatLocalDate(newYear) === '2027-01-01'
    && newYear.toISOString().split('T')[0] === '2026-12-31');

  // No handler may reintroduce the UTC form.
  const ipcDir = join(ROOT, 'src/main/ipc');
  const { readdirSync } = await import('node:fs');
  const offenders = readdirSync(ipcDir)
    .filter(f => f.endsWith('.ts'))
    .filter(f => R(`src/main/ipc/${f}`).includes("new Date().toISOString().split('T')[0]"));
  check('no handler still derives a business date from UTC',
    offenders.length === 0, offenders.join(', '));

  check('all handlers use the shared helper',
    readdirSync(ipcDir).filter(f => R(`src/main/ipc/${f}`).includes('businessToday(')).length >= 11);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] The two fixes are consistent (this is the dangerous part)');
{
  // Had business dates moved to local while the licence stayed on UTC, every
  // shop trading after midnight would have been locked out nightly.
  const now = new Date('2026-08-02T01:00:00+03:00');
  const todaysInvoice = formatLocalDate(now);          // '2026-08-02'
  const utcToday = now.toISOString().slice(0, 10);     // '2026-08-01'

  check('the mismatch that would have caused nightly lockout is real',
    utcToday < todaysInvoice);
  check('the licence no longer compares against the UTC date',
    !R('src/main/ipc/license.handlers.ts')
      .includes("now.toISOString().slice(0, 10) < latestActivity"));
  check('an invoice created tonight does NOT trip the check',
    licenceVerdict(now, {
      startDate: START, lastAccess: null, newestBusiness: todaysInvoice,
    }) === 'ok');
  check('the licence uses the shared tolerance helper',
    R('src/main/ipc/license.handlers.ts').includes('isImplausiblyFuture(latestActivity, now)'));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Backup and restore do not touch the subscription');
{
  const backup = R('src/main/ipc/backup.handlers.ts');
  const database = R('src/main/ipc/database.handlers.ts');

  for (const [name, src] of [['backup', backup], ['database', database]]) {
    check(`${name} handler never touches license.dat`, !src.includes('license.dat'));
    check(`${name} handler never touches device.id`, !src.includes('device.id'));
    check(`${name} handler never touches trial.dat`, !src.includes('trial.dat'));
    check(`${name} handler never touches lastaccess.dat`, !src.includes('lastaccess.dat'));
  }

  // The licence lives in userData as separate files; a .db restore cannot
  // reach them, which is why restoring never deactivates a subscription.
  const lic = R('src/main/ipc/license.handlers.ts');
  check('the licence is stored outside the database',
    lic.includes("path.join(app.getPath('userData'), LICENSE_FILE)"));
  check('the licence is not read from any SQL table',
    !/FROM\s+licenses?\b/i.test(lic));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Restoring an OLD backup is safe');
{
  // The common case: reinstalling, or rolling back after a mistake.
  check('a six-month-old backup is accepted',
    licenceVerdict(new Date('2027-01-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: '2026-07-28',
    }) === 'ok');

  check('a two-year-old backup is accepted',
    licenceVerdict(new Date('2028-07-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: '2026-07-28',
    }) === 'ok');

  check('an empty database is accepted',
    licenceVerdict(new Date('2026-07-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: null,
    }) === 'ok');

  // Only a FUTURE-dated database is suspicious, and only beyond the tolerance.
  check('a backup dated one day ahead is tolerated (timezone/clock slack)',
    licenceVerdict(new Date('2026-07-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: '2026-07-29',
    }) === 'ok');
  check('a backup dated years ahead is flagged',
    licenceVerdict(new Date('2026-07-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: '2031-01-01',
    }) === 'tampered:business');
}

// ---------------------------------------------------------------- 9
console.log('\n[9] A dead CMOS battery cannot lock the shop out forever');
{
  // This is reachable with no dishonesty at all, so a way back must exist.
  check('an accidental future date is still detected',
    licenceVerdict(new Date('2026-07-28T10:00:00Z'), {
      startDate: START, lastAccess: null, newestBusiness: '2030-03-04',
    }) === 'tampered:business');

  const lic = R('src/main/ipc/license.handlers.ts');
  check('the verdict is marked recoverable', lic.includes('recoverable: true'));
  check('a diagnostics channel exists', lic.includes("'license:clockDiagnostics'"));
  check('it reports which records look wrong', lic.includes('futureRecords'));
  check('a repair channel exists', lic.includes("'license:repairClockState'"));
  check('repair requires developer authentication',
    /repairClockState[\s\S]{0,400}verifyDevToken/.test(lic));
  check('repair does NOT delete the licence file',
    !/repairClockState[\s\S]{0,900}unlinkSync\(licensePath\)/.test(lic));
  check('repair does NOT touch business data',
    !/repairClockState[\s\S]{0,900}(DELETE FROM|UPDATE )/.test(lic));

  const guard = R('src/main/security/ipcGuard.ts');
  check('diagnostics work while the app is locked',
    guard.includes("'license:clockDiagnostics'"));
}

// ---------------------------------------------------------------- 10
console.log('\n[10] Date helpers behave across DST and month boundaries');
{
  // Subtracting 86_400_000 ms is an hour short on the day the clocks change;
  // using local calendar arithmetic is not.
  const afterSwitch = new Date('2026-10-30T12:00:00+02:00');
  check('30 days back crosses the DST boundary correctly',
    localDateDaysAgo(30, afterSwitch) === '2026-09-30',
    localDateDaysAgo(30, afterSwitch));

  check('1 day back across the switch is the previous calendar day',
    localDateDaysAgo(1, afterSwitch) === '2026-10-29');

  check('month rollover works', localDateDaysAgo(1, new Date('2026-03-01T12:00:00+02:00')) === '2026-02-28');
  check('leap year works', localDateDaysAgo(1, new Date('2028-03-01T12:00:00+02:00')) === '2028-02-29');
  check('year rollover works', localDateDaysAgo(1, new Date('2027-01-01T12:00:00+02:00')) === '2026-12-31');
  check('zero days is today', localDateDaysAgo(0, afterSwitch) === '2026-10-30');

  check('output is always ISO-ordered ASCII digits',
    /^\d{4}-\d{2}-\d{2}$/.test(businessToday()));
}

// ---------------------------------------------------------------- 11
console.log('\n[11] Future-date tolerance is bounded and predictable');
{
  const now = new Date('2026-07-28T12:00:00+03:00');
  check('today is never "future"', !isImplausiblyFuture('2026-07-28', now));
  check('tomorrow is tolerated', !isImplausiblyFuture('2026-07-29', now));
  check('two days ahead is tolerated', !isImplausiblyFuture('2026-07-30', now));
  check('three days ahead is flagged', isImplausiblyFuture('2026-07-31', now));
  check('the past is never flagged', !isImplausiblyFuture('2020-01-01', now));
  check('a malformed date is ignored rather than crashing',
    !isImplausiblyFuture('not-a-date', now) && !isImplausiblyFuture('', now));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(72));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
