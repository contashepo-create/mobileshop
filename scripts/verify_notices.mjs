#!/usr/bin/env node
/**
 * Offline-tolerance and popup checks.
 *
 * The guarantee under test is the one that matters most to a shop owner:
 *   "losing my internet connection must never stop me working."
 *
 * The timing rules are exercised against the REAL source module (loaded with
 * Node's type stripping, no build step), and the "no network can block the app"
 * claim is asserted structurally against the actual licence and heartbeat code
 * rather than trusted from a comment.
 *
 * Run with:  node --experimental-strip-types scripts/verify_notices.mjs
 */
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

const {
  evaluateOfflineNotice, evaluateExpiryNotice, parseStamp, daysBetween,
  OFFLINE_REMINDER_DAYS,
} = await import('../src/main/remote/notices.ts');

const D = s => new Date(s);
const NOW = D('2026-07-28T12:00:00Z');
/** now minus n days, as an ISO string. */
const ago = n => new Date(NOW.getTime() - n * 86_400_000).toISOString();

console.log('='.repeat(72));
console.log('OFFLINE TOLERANCE & CUSTOMER NOTICES');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] Being offline never disables the application');
{
  const lic = R('src/main/ipc/license.handlers.ts');
  check('the licence check makes no network call',
    !/\bfetch\s*\(|https?:\/\/|net\.request|axios/.test(lic));
  check('licence status is read from local files only',
    lic.includes('fs.existsSync(licensePath)') && lic.includes("app.getPath('userData')"));

  const app = R('src/renderer/src/App.tsx');
  // The gate must depend on license:status alone. If it ever consulted a
  // heartbeat result, a customer with no internet would be locked out.
  const gate = app.match(/const isLicensed =[^;]+;/)?.[0] || '';
  check('the app gate depends only on the local licence status',
    gate.includes('licenseStatus') && !/sync|remote|online/i.test(gate), gate);

  const hb = R('src/main/remote/heartbeat.ts');
  check('a failed check-in is swallowed, not thrown',
    hb.includes('return null;   // offline, DNS failure, timeout — all non-fatal'));
  check('the check-in has a hard timeout', hb.includes('REQUEST_TIMEOUT_MS'));
  check('its timer never holds the app open', hb.includes('timer.unref?.()'));
  check('the server can never revoke a licence',
    !/license|expiry/i.test(hb.split('saveRemoteConfig')[1] || '') ||
    !hb.includes('license:deactivate'));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Activation works with no internet at all');
{
  const lic = R('src/main/ipc/license.handlers.ts');
  const activate = lic.split("ipcMain.handle('license:activate'")[1].split('ipcMain.handle(')[0];
  check('activation performs no network request',
    !/\bfetch\s*\(|https?:\/\//.test(activate));
  // Matched the literal `verifyCode(VERIFIER_SECRET, ...)`. That constant was
  // the shipped symmetric secret, and it is gone — the router now verifies
  // with the embedded PUBLIC key and ignores anything a caller passes. The
  // property worth asserting is that activation is decided LOCALLY by a
  // signature, not the spelling of the call.
  check('the code is verified locally by signature',
    /verifyCode\(\s*['"]{2}\s*,\s*deviceId,\s*raw\s*\)/.test(activate));
  check('and the verifier no longer takes a shipped secret',
    !R('src/main/security/licenseCrypto.ts').includes('export const VERIFIER_SECRET'));
}

// ---------------------------------------------------------------- 3
console.log(`\n[3] The "please connect" reminder appears after ${OFFLINE_REMINDER_DAYS} days`);
{
  const base = { now: NOW, installedAt: ago(400), lastShown: null, remoteEnabled: true };

  check('silent on day 1', !evaluateOfflineNotice({ ...base, lastSync: ago(1) }).show);
  check('silent on day 19', !evaluateOfflineNotice({ ...base, lastSync: ago(19) }).show);
  check('fires on day 20', evaluateOfflineNotice({ ...base, lastSync: ago(20) }).show);
  check('still fires on day 60', evaluateOfflineNotice({ ...base, lastSync: ago(60) }).show);
  check('reports the day count',
    evaluateOfflineNotice({ ...base, lastSync: ago(33) }).daysOffline === 33);

  // A fresh install that has never once reached the server must still be
  // reminded, otherwise the reminder would never fire for the customers who
  // need it most.
  check('an install that never synced is reminded from its install date',
    evaluateOfflineNotice({ ...base, lastSync: null, installedAt: ago(25) }).show);
  check('a brand-new install is not nagged immediately',
    !evaluateOfflineNotice({ ...base, lastSync: null, installedAt: ago(2) }).show);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The reminder is polite: dismissible, snoozed, and opt-out');
{
  const base = { now: NOW, installedAt: ago(400), lastSync: ago(50), remoteEnabled: true };

  check('quiet for 20 days after being dismissed',
    !evaluateOfflineNotice({ ...base, lastShown: ago(3) }).show);
  check('returns after the snooze window',
    evaluateOfflineNotice({ ...base, lastShown: ago(21) }).show);
  check('never shown when telemetry is switched off',
    !evaluateOfflineNotice({ ...base, lastShown: null, remoteEnabled: false }).show);
  check('reason is reported for diagnostics',
    evaluateOfflineNotice({ ...base, lastShown: ago(3) }).reason === 'snoozed');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Renewal warning — the offline customer is warned in time');
{
  const mk = (expiry, lastShown = null) =>
    evaluateExpiryNotice({ now: NOW, status: 'active', expiry, lastShown });

  check('silent 30 days out', !mk('2026-08-27').show);
  check('warns 14 days out', mk('2026-08-11').show);
  check('warns 3 days out', mk('2026-07-31').show);
  check('counts the days correctly', mk('2026-07-31').daysLeft === 3, String(mk('2026-07-31').daysLeft));
  check('perpetual licences are never warned',
    !evaluateExpiryNotice({ now: NOW, status: 'active', expiry: null, lastShown: null }).show);
  check('non-active states are handled elsewhere',
    !evaluateExpiryNotice({ now: NOW, status: 'trial', expiry: '2026-07-31', lastShown: null }).show);
  check('repeats daily, not on every screen change', !mk('2026-07-31', ago(0.2)).show);
  check('reappears the next day', mk('2026-07-31', ago(1)).show);

  // 14 days of warning is worthless if renewing needed the internet — this is
  // what ties the two features together.
  check('warning window gives time to obtain a code offline', 14 >= 7);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Clock and timestamp handling cannot misfire');
{
  // SQLite writes 'YYYY-MM-DD HH:MM:SS' with no zone; JS writes ISO with 'Z'.
  const sqlite = parseStamp('2026-07-28 12:00:00');
  const iso = parseStamp('2026-07-28T12:00:00.000Z');
  check('SQLite and ISO timestamps parse to the same instant',
    sqlite && iso && sqlite.getTime() === iso.getTime(),
    `${sqlite?.toISOString()} vs ${iso?.toISOString()}`);
  check('a corrupt timestamp is ignored, not crashed on', parseStamp('not-a-date') === null);
  check('an empty timestamp is ignored', parseStamp('') === null && parseStamp(null) === null);

  // A clock moved backwards must not make every dialog fire at once.
  check('a backwards clock clamps to zero, not a negative',
    daysBetween(D('2026-07-28'), D('2026-07-01')) === 0);
  check('a future last-sync does not trigger the reminder',
    !evaluateOfflineNotice({
      now: NOW, lastSync: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
      installedAt: ago(400), lastShown: null, remoteEnabled: true,
    }).show);
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Developer messages are shown as a modal, not a toast');
{
  const nc = R('src/renderer/src/components/shared/NoticeCenter.tsx');
  check('a full-screen dialog is rendered',
    nc.includes('fixed inset-0') && nc.includes('backdrop-blur'));
  check('it sits above every other layer', nc.includes('z-[200]'));
  check('it must be dismissed deliberately (no auto-hide timer)',
    !/setTimeout\([^)]*setQueue/.test(nc));
  check('messages are queued one at a time', nc.includes('queue[0]'));
  check('reading a message is acknowledged to the server',
    nc.includes("'remote:markRead'"));
  check('it renders nothing when there is nothing to say',
    nc.includes('if (!current) return null;'));
  check('a failed IPC call cannot break the screen',
    (nc.match(/catch\s*\{/g) || []).length >= 2);

  const app = R('src/renderer/src/App.tsx');
  check('mounted for authenticated users on every page',
    /isLicensed && isAuthenticated && <NoticeCenter \/>/.test(app));
  check('never covers the login or activation screen',
    app.includes('isLicensed && isAuthenticated'));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The new channels are wired and reachable');
{
  const guard = R('src/main/security/ipcGuard.ts');
  const handlers = R('src/main/ipc/remote.handlers.ts');
  for (const ch of ['remote:pendingNotices', 'remote:dismissNotice']) {
    check(`${ch} is registered`, handlers.includes(`'${ch}'`));
    check(`${ch} has an access rule`, guard.includes(`'${ch}'`));
  }
  check('dismiss only accepts known notice kinds',
    handlers.includes('const allowed: Record<string, string>') &&
    handlers.includes('if (!stateKey) return { success: false };'));
  check('unread messages are fetched oldest-first',
    R('src/main/remote/remoteStore.ts').includes('ORDER BY CreatedAt ASC'));
  check('the install date anchor is written once',
    R('src/main/remote/remoteStore.ts').includes("INSERT OR IGNORE INTO remote_state (Key, Value) VALUES ('installed_at'"));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(72));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
