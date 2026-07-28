#!/usr/bin/env node
/**
 * Smart-notification preference checks.
 *
 * The preference logic is exercised against the REAL module, and the two
 * SQL-level bugs that were found during this pass are pinned with tests that
 * fail if the old behaviour ever returns.
 *
 * The guarantee that matters most is the last section: the shop's switches
 * must never be able to silence a message from the developer.
 *
 * Run with:  node --experimental-strip-types scripts/verify_notifications.mjs
 */
import { DatabaseSync } from 'node:sqlite';
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

const P = await import('../src/main/notifications/prefs.ts');
const {
  NOTIFICATION_RULES, normalisePrefs, defaultPrefs, evaluateSuppression,
  isQuietHour, param, ruleState, PRIORITY_ORDER,
} = P;

console.log('='.repeat(72));
console.log('SMART NOTIFICATION PREFERENCES');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] Every rule in the engine is controllable from the UI');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  // Each rule id the engine gates on must exist in the catalogue...
  const gated = [...engine.matchAll(/\bon\('([a-z_]+)'\)/g)].map(m => m[1]);
  const known = new Set(NOTIFICATION_RULES.map(r => r.id));
  const unknown = gated.filter(id => !known.has(id));
  check('every gated rule exists in the catalogue', unknown.length === 0, unknown.join(', '));

  // ...and every catalogue rule must actually be used by the engine, or it
  // would be a dead switch that appears to do something and does not.
  const unused = [...known].filter(id => !gated.includes(id));
  check('no catalogue rule is a dead switch', unused.length === 0, unused.join(', '));
  check('all 12 rules are wired', known.size === 12, String(known.size));

  // Every numeric parameter must be read by the engine.
  const deadParams = [];
  for (const rule of NOTIFICATION_RULES) {
    for (const p of rule.params) {
      if (!engine.includes(`'${rule.id}', '${p.key}'`)) deadParams.push(`${rule.id}.${p.key}`);
    }
  }
  check('every threshold is actually read by the engine',
    deadParams.length === 0, deadParams.join(', '));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Stored preferences are validated, never trusted');
{
  const bad = normalisePrefs({
    global: { maxItems: 99999, refreshMinutes: -5, minPriority: 'ultra', quietFrom: 47 },
    rules: {
      cash_low: { enabled: 'yes', priority: 'nonsense', params: { threshold: -900 } },
      evil_injected_rule: { enabled: true },
    },
  });
  check('out-of-range maxItems is clamped', bad.global.maxItems === 500, String(bad.global.maxItems));
  check('negative refresh falls back to the default', bad.global.refreshMinutes === 1);
  check('an invalid priority is rejected', bad.global.minPriority === 'low');
  check('an impossible hour is clamped', bad.global.quietFrom === 23, String(bad.global.quietFrom));
  check('a non-boolean enabled is ignored', bad.rules.cash_low.enabled === true);
  check('an invalid rule priority is rejected', bad.rules.cash_low.priority === 'medium');
  check('a negative threshold is clamped to its minimum',
    bad.rules.cash_low.params.threshold === 0, String(bad.rules.cash_low.params.threshold));
  check('an unknown rule id is dropped entirely',
    !('evil_injected_rule' in bad.rules));

  check('garbage input yields safe defaults',
    JSON.stringify(normalisePrefs('not an object')) === JSON.stringify(defaultPrefs()));
  check('null yields safe defaults',
    JSON.stringify(normalisePrefs(null)) === JSON.stringify(defaultPrefs()));

  // NaN is the dangerous one: `x > NaN` is false, so a blanked input would
  // silently disable a rule instead of reporting an error.
  const nan = normalisePrefs({ rules: { cash_low: { params: { threshold: NaN } } } });
  check('NaN falls back to the default instead of disabling the rule',
    nan.rules.cash_low.params.threshold === 1000, String(nan.rules.cash_low.params.threshold));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Defaults reproduce the original behaviour');
{
  const d = defaultPrefs();
  check('all rules start enabled', NOTIFICATION_RULES.every(r => d.rules[r.id].enabled));
  check('customer overdue still 30 days', param(d, 'customer_overdue', 'days') === 30);
  check('high balance still 3000', param(d, 'customer_high_balance', 'threshold') === 3000);
  check('low cash still 1000', param(d, 'cash_low', 'threshold') === 1000);
  check('out-of-stock cap still 20', param(d, 'inventory_out_of_stock', 'limit') === 20);
  check('quiet hours off by default', d.global.quietEnabled === false);
  check('every day active by default', d.global.days.every(Boolean));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Quiet hours, including the overnight case');
{
  const p = defaultPrefs();
  p.global.quietEnabled = true;
  p.global.quietFrom = 22;
  p.global.quietTo = 8;
  const at = h => new Date(2026, 6, 28, h, 0, 0);

  check('23:00 is quiet', isQuietHour(p, at(23)));
  check('02:00 is quiet (after midnight)', isQuietHour(p, at(2)));
  check('07:00 is quiet', isQuietHour(p, at(7)));
  check('08:00 is not quiet', !isQuietHour(p, at(8)));
  check('14:00 is not quiet', !isQuietHour(p, at(14)));

  // Daytime window, the non-wrapping case.
  p.global.quietFrom = 9; p.global.quietTo = 17;
  check('daytime window: 12:00 quiet', isQuietHour(p, at(12)));
  check('daytime window: 20:00 not quiet', !isQuietHour(p, at(20)));

  // from === to would otherwise silence everything forever.
  p.global.quietFrom = 10; p.global.quietTo = 10;
  check('equal from/to means no quiet period, not all-day silence',
    !isQuietHour(p, at(10)));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Suppression: master switch, days, quiet hours, priority floor');
{
  const mk = fn => { const p = defaultPrefs(); fn(p); return p; };
  const noon = new Date(2026, 6, 28, 12, 0, 0);   // a Tuesday
  const night = new Date(2026, 6, 28, 23, 0, 0);

  const off = evaluateSuppression(mk(p => { p.global.enabled = false; }), noon);
  check('master switch hides everything', !off.allowed('critical') && off.reason === 'off');

  const dayOff = evaluateSuppression(mk(p => { p.global.days[2] = false; }), noon);
  check('an inactive weekday hides everything', !dayOff.allowed('critical'));
  check('the reason is reported', dayOff.reason === 'day');

  const quiet = mk(p => {
    p.global.quietEnabled = true; p.global.quietFrom = 22; p.global.quietTo = 8;
  });
  const q = evaluateSuppression(quiet, night);
  check('quiet hours hide routine alerts', !q.allowed('medium'));
  check('critical alerts pierce quiet hours by default', q.allowed('critical'));

  const strict = mk(p => {
    p.global.quietEnabled = true; p.global.quietFrom = 22; p.global.quietTo = 8;
    p.global.quietAllowCritical = false;
  });
  check('critical can be silenced too when asked',
    !evaluateSuppression(strict, night).allowed('critical'));

  const floor = evaluateSuppression(mk(p => { p.global.minPriority = 'high'; }), noon);
  check('priority floor keeps critical', floor.allowed('critical'));
  check('priority floor keeps high', floor.allowed('high'));
  check('priority floor drops medium', !floor.allowed('medium'));
  check('priority floor drops low', !floor.allowed('low'));

  const open = evaluateSuppression(defaultPrefs(), noon);
  check('by default nothing is suppressed',
    open.allowed('low') && open.allowed('critical') && !open.suppressed);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] BUG FIX: an expired snooze must actually expire');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE dn (ID INTEGER PRIMARY KEY, NotifKey TEXT UNIQUE, SnoozedUntil TEXT)`);
  const expired = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  db.prepare('INSERT INTO dn (NotifKey, SnoozedUntil) VALUES (?,?)').run('expired', expired);
  db.prepare('INSERT INTO dn (NotifKey, SnoozedUntil) VALUES (?,?)').run('active', future);

  // The old comparison: ISO ('...T...Z') vs datetime('now') ('... ...').
  // 'T' (0x54) > ' ' (0x20), so every snooze looked like it was in the future.
  const oldWay = db.prepare(
    `SELECT NotifKey FROM dn WHERE SnoozedUntil IS NULL OR SnoozedUntil > datetime('now')`,
  ).all().map(r => r.NotifKey);
  check('the OLD comparison wrongly kept an expired snooze hidden',
    oldWay.includes('expired'), 'bug no longer reproducible');

  const newWay = db.prepare(
    `SELECT NotifKey FROM dn WHERE SnoozedUntil IS NULL
       OR SnoozedUntil > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).all().map(r => r.NotifKey);
  check('the fixed comparison releases the expired snooze', !newWay.includes('expired'));
  check('the fixed comparison still honours an active snooze', newWay.includes('active'));

  const engine = R('src/main/ipc/notifications.handlers.ts');
  const smart = engine.split("ipcMain.handle('notifications:smart'")[1];
  check('notifications:smart no longer compares against datetime(now)',
    !/SnoozedUntil > datetime\('now'\)/.test(smart));
  check('notifications:smart uses the ISO-compatible comparison',
    smart.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now')"));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] BUG FIX: dismiss-after-snooze must be permanent');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE dn (ID INTEGER PRIMARY KEY AUTOINCREMENT, NotifKey TEXT UNIQUE, SnoozedUntil TEXT)`);
  const future = new Date(Date.now() + 3600_000).toISOString();

  // Old behaviour: INSERT OR IGNORE left the snoozed row untouched.
  db.prepare('INSERT OR IGNORE INTO dn (NotifKey, SnoozedUntil) VALUES (?,?)').run('k', future);
  db.prepare('INSERT OR IGNORE INTO dn (NotifKey) VALUES (?)').run('k');
  check('the OLD dismiss silently did nothing after a snooze',
    db.prepare('SELECT SnoozedUntil FROM dn WHERE NotifKey = ?').get('k').SnoozedUntil !== null,
    'bug no longer reproducible');

  // New behaviour: the upsert clears the snooze.
  db.prepare(`INSERT INTO dn (NotifKey, SnoozedUntil) VALUES (?, NULL)
              ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = NULL`).run('k');
  check('the fixed dismiss clears the snooze',
    db.prepare('SELECT SnoozedUntil FROM dn WHERE NotifKey = ?').get('k').SnoozedUntil === null);

  const engine = R('src/main/ipc/notifications.handlers.ts');
  check('dismiss uses an upsert, not INSERT OR IGNORE',
    engine.includes('ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = NULL'));
  check('re-snoozing extends the window',
    engine.includes('ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = excluded.SnoozedUntil'));
  check('snooze hours are bounded', engine.includes('Math.min(8760, Math.max(1, hours))'));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] BUG FIX: slow-moving query no longer relies on a WHERE alias');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  const slow = engine.split("if (on('inventory_slow_moving'))")[1].split('// ====== EMPLOYEES')[0];
  check('the TotalStock alias is not used as a filter',
    !/AND TotalStock > 0/.test(slow));
  check('the stock condition is spelled out as a subquery',
    /AND \(SELECT COALESCE\(SUM\(Quantity\),0\) FROM stock_quantities WHERE ItemID = i\.ItemID\) >= \?/.test(slow));
  check('the slow-moving window is configurable',
    slow.includes("num('inventory_slow_moving', 'days')"));

  // The shipped default said "not sold in 2 months" but compared against a
  // 14-day cutoff, so it fired on items sold a fortnight ago.
  check('the default window matches its description (60 days, not 14)',
    param(defaultPrefs(), 'inventory_slow_moving', 'days') === 60);
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Thresholds reach the SQL as bound parameters');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  const smart = engine.split("ipcMain.handle('notifications:smart'")[1];
  // A threshold interpolated into SQL would be an injection point AND would
  // defeat statement caching.
  const interpolated = [...smart.matchAll(/\$\{[^}]*(num|param)\(/g)];
  check('no threshold is interpolated into a query string',
    interpolated.length === 0, String(interpolated.length));
  check('limits are bound with LIMIT ?', (smart.match(/LIMIT \?/g) || []).length >= 3);
  check('cash threshold is bound', /Balance < \?/.test(smart));
  check('customer balance floor is bound', /c\.Balance >= \?/.test(smart));
}

// ---------------------------------------------------------------- 10
console.log('\n[10] Disabled rules cost nothing');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  // Gating must wrap the QUERY, not just filter the results — otherwise a shop
  // that switched everything off would still pay for twelve table scans.
  for (const id of ['customer_overdue', 'inventory_slow_moving', 'cash_low']) {
    const idx = engine.indexOf(`if (on('${id}'))`);
    const nextPrepare = engine.indexOf('db.prepare', idx);
    const nextGate = engine.indexOf("if (on('", idx + 5);
    check(`${id}: the query sits inside the gate`,
      idx > 0 && nextPrepare > idx && (nextGate === -1 || nextPrepare < nextGate));
  }
}

// ---------------------------------------------------------------- 11
console.log('\n[11] The customer can NEVER silence the developer');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  const remote = R('src/main/ipc/remote.handlers.ts');
  const notice = R('src/renderer/src/components/shared/NoticeCenter.tsx');

  check('the smart engine knows nothing about developer messages',
    !engine.includes('remote_messages') && !engine.includes('pendingNotices'));
  check('developer notices do not consult notification preferences',
    !remote.includes('notif_prefs') && !remote.includes('evaluateSuppression'));
  check('the popup does not read the preference store',
    !notice.includes('notif_prefs') && !notice.includes('getPrefs'));

  // The two paths must remain physically separate: different IPC channels,
  // different tables, different renderers.
  check('developer messages use their own channel',
    notice.includes("'remote:pendingNotices'") && !notice.includes("'notifications:smart'"));

  const prefs = R('src/main/notifications/prefs.ts');
  const ids = NOTIFICATION_RULES.map(r => r.id);
  check('no rule exists for developer messages',
    !ids.some(id => /developer|remote|license|subscription/i.test(id)), ids.join(','));
  check('the separation is documented for future maintainers',
    prefs.includes('Messages from the developer are deliberately NOT here'));

  const ui = R('src/renderer/src/pages/settings/NotificationSettings.tsx');
  check('the settings screen tells the owner about the separation',
    ui.includes('رسائل المطور'));
}

// ---------------------------------------------------------------- 12
console.log('\n[12] Wiring: channels, permissions, and the settings tab');
{
  const guard = R('src/main/security/ipcGuard.ts');
  const engine = R('src/main/ipc/notifications.handlers.ts');
  for (const ch of ['notifications:getPrefs', 'notifications:setPrefs', 'notifications:resetPrefs']) {
    check(`${ch} is registered`, engine.includes(`'${ch}'`));
    check(`${ch} has an access rule`, guard.includes(`'${ch}'`));
  }
  check('changing preferences requires settings.edit',
    /'notifications:setPrefs':\s*'settings\.edit'/.test(guard));
  check('resetting preferences requires settings.edit',
    /'notifications:resetPrefs':\s*'settings\.edit'/.test(guard));
  check('reading preferences does not require a permission',
    guard.includes("'notifications:getPrefs',"));

  const settings = R('src/renderer/src/pages/settings/SettingsPage.tsx');
  check('a tab exists in the settings page', settings.includes('التنبيهات الذكية'));
  check('the tab renders the panel', settings.includes('<NotificationSettings />'));

  const header = R('src/renderer/src/components/layout/Header.tsx');
  check('the bell honours the chosen refresh interval', header.includes('refreshMs'));
  check('an empty bell explains why', header.includes('ساعات الهدوء مفعّلة الآن'));
  check('the bell does not claim "all good" when alerts are off',
    header.includes('نظام التنبيهات موقوف من الإعدادات'));
}

// ---------------------------------------------------------------- 13
console.log('\n[13] Priority escalation never downgrades the owner’s choice');
{
  const engine = R('src/main/ipc/notifications.handlers.ts');
  check('escalation compares ranks rather than overwriting',
    engine.includes('if (cond && PRIORITY_ORDER[level] < PRIORITY_ORDER[best]) best = level;'));
  check('critical outranks high', PRIORITY_ORDER.critical < PRIORITY_ORDER.high);
  check('high outranks medium', PRIORITY_ORDER.high < PRIORITY_ORDER.medium);
  check('medium outranks low', PRIORITY_ORDER.medium < PRIORITY_ORDER.low);
}

// ---------------------------------------------------------------- 14
console.log('\n[14] Alert cutoffs use the shop’s calendar, not UTC');
{
  // Date arithmetic deliberately lives in shared/businessDate.ts so alert
  // cutoffs and invoice dates can never drift apart. prefs.ts stays pure.
  const prefsSrc = R('src/main/notifications/prefs.ts');
  check('prefs.ts holds no date arithmetic of its own',
    !prefsSrc.includes('86_400_000') && !prefsSrc.includes('toISOString'));
  check('prefs.ts has no imports at all (pure policy module)',
    !/^import /m.test(prefsSrc));

  const engine = R('src/main/ipc/notifications.handlers.ts');
  check('the engine uses the shared local-date helper',
    engine.includes("localDateDaysAgo") &&
    engine.includes("from '../../shared/businessDate'"));
  check('the engine no longer builds "today" from UTC',
    !engine.includes("now.toISOString().split('T')[0]"));
  check('every cutoff goes through the shared helper',
    (engine.match(/localDateDaysAgo\(/g) || []).length === 4);
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(72));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
