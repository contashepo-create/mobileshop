#!/usr/bin/env node
/**
 * THE AUDIT TRAIL MUST BE APPEND-ONLY, AND IT MUST STILL WORK.
 *
 * WHAT WAS MEASURED
 * -----------------
 * `security_events` carried the comment "deliberately append-only in practice:
 * nothing in the application updates or deletes a row here." That described
 * the callers, not the table. Six attacks against the real schema, all six
 * succeeded:
 *
 *   UPDATE ... SET Detail    = 'لا شيء'         1 row
 *   UPDATE ... SET Username  = 'someone_else'   1 row
 *   UPDATE ... SET EventType = 'login'          1 row
 *   UPDATE ... SET CreatedAt = '2020-01-01'     1 row
 *   DELETE  ... WHERE EventID = 2               1 row
 *   DELETE  FROM security_events                1 row   <- the entire log
 *
 * The table ended empty.
 *
 * WHY IT MATTERS
 * --------------
 * The events recorded here are password resets, owner-level data exports and
 * database wipes. Whoever performs one of those is exactly who wants the row
 * gone, so a log they can erase is not evidence of anything. The .db file sits
 * in the shop's own AppData folder, so the permission layer — which only
 * governs IPC channels — cannot see a hand edit, a repair script, or a backup
 * doctored offline and restored.
 *
 * THE PAIRING THIS SUITE ENFORCES
 * -------------------------------
 * A guard that breaks a working feature is worse than the hole it closes, and
 * this one nearly did. `settings:resetDatabase` deletes every table not on a
 * preserve-list, and `security_events` was not on it — so the new trigger
 * aborted the wipe and the shop could no longer reset at all. Both halves are
 * asserted here:
 *
 *   - tampering is refused;
 *   - INSERT still works, the reset still works, and the log survives it.
 *
 * Run:  node --experimental-strip-types scripts/verify_audit_trail.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const { buildDatabase, loadHandlers, currentDb } =
  await import(pathToFileURL(join(ROOT, 'scripts/lib/handlerHarness.mjs')).href);

buildDatabase();
await loadHandlers();
const db = currentDb();

db.prepare("INSERT INTO roles (RoleID,RoleName,IsSystem) VALUES (1,'مدير',1)").run();
db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','$2a$10$x',1,1)").run();

const { recordSecurityEvent } = await import(pathToFileURL(join(ROOT, 'src/main/security/securityLog.ts')).href);

// ===========================================================================
console.log('\n── 1. events can still be recorded ──');
// ===========================================================================
{
  // First, because a guard that blocks writing has replaced a tamperable log
  // with no log.
  for (const [type, detail] of [
    ['password_reset', 'أعاد المدير كلمة سر المستخدم ٧'],
    ['data_export_owner', 'تصدير ٥٩ جدول'],
    ['database_reset', 'تصفير قاعدة البيانات'],
    ['login_failed', 'محاولة دخول فاشلة'],
  ]) {
    recordSecurityEvent(db, type, 1, 'admin', detail);
  }
  const n = db.prepare('SELECT COUNT(*) c FROM security_events').get().c;
  ok('four events were appended', n === 4, `${n} row(s)`);

  const row = db.prepare('SELECT * FROM security_events WHERE EventID = 1').get();
  ok('the event kept its type', row?.EventType === 'password_reset');
  ok('the event kept its actor', row?.Username === 'admin');
  ok('the event kept its detail', /كلمة سر/.test(String(row?.Detail)));
  ok('the event was stamped with a time', !!row?.CreatedAt);
}

// ===========================================================================
console.log('── 2. a recorded event cannot be ALTERED ──');
// ===========================================================================
{
  const before = db.prepare('SELECT * FROM security_events WHERE EventID = 1').get();

  const attacks = [
    ['rewrite the detail', "UPDATE security_events SET Detail='لا شيء' WHERE EventID=1"],
    ['blame another user', "UPDATE security_events SET Username='someone_else' WHERE EventID=1"],
    ['change the event type', "UPDATE security_events SET EventType='login' WHERE EventID=1"],
    ['backdate the event', "UPDATE security_events SET CreatedAt='2020-01-01' WHERE EventID=1"],
    ['detach it from its user', 'UPDATE security_events SET UserID=NULL WHERE EventID=1'],
    ['rewrite every row at once', "UPDATE security_events SET Detail='—'"],
  ];
  for (const [why, sql] of attacks) {
    let threw = null;
    try { db.prepare(sql).run(); } catch (e) { threw = e; }
    ok(`refused: ${why}`, threw !== null, 'the UPDATE was applied');
    if (threw) {
      ok(`...and says why: ${why}`, /append-only/i.test(String(threw.message)),
        String(threw.message).slice(0, 80));
    }
  }

  const after = db.prepare('SELECT * FROM security_events WHERE EventID = 1').get();
  ok('the row is byte-for-byte what was recorded',
    JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify(after));
}

// ===========================================================================
console.log('── 3. a recorded event cannot be DELETED ──');
// ===========================================================================
{
  const before = db.prepare('SELECT COUNT(*) c FROM security_events').get().c;

  const attacks = [
    ['delete one row', 'DELETE FROM security_events WHERE EventID=2'],
    ['delete by type', "DELETE FROM security_events WHERE EventType='password_reset'"],
    ['delete the whole log', 'DELETE FROM security_events'],
    ['delete everything older than today', "DELETE FROM security_events WHERE CreatedAt < '2099-01-01'"],
  ];
  for (const [why, sql] of attacks) {
    let threw = null;
    try { db.prepare(sql).run(); } catch (e) { threw = e; }
    ok(`refused: ${why}`, threw !== null, 'rows were removed');
    if (threw) {
      ok(`...and says why: ${why}`, /append-only/i.test(String(threw.message)),
        String(threw.message).slice(0, 80));
    }
  }

  const after = db.prepare('SELECT COUNT(*) c FROM security_events').get().c;
  ok('every event is still there', before === after, `${before} -> ${after}`);
}

// ===========================================================================
console.log('── 4. the database reset still works, and the log survives it ──');
// ===========================================================================
{
  // This is the pairing that nearly broke. `settings:resetDatabase` wipes every
  // table not on a preserve-list; with `security_events` missing from that
  // list the new trigger aborted the whole transaction and the shop could not
  // reset at all.
  db.prepare("INSERT INTO customers (Name,Phone,Balance) VALUES ('عميل','01',500)").run();
  const logBefore = db.prepare('SELECT COUNT(*) c FROM security_events').get().c;

  // The preserve-list is read from the shipped handler rather than restated,
  // so the two cannot drift apart.
  const src = readFileSync(join(ROOT, 'src/main/ipc/settings.handlers.ts'), 'utf8');
  const listMatch = src.match(/const systemTables = \[([\s\S]*?)\]/);
  ok('the reset handler declares a preserve-list', !!listMatch);
  const systemTables = listMatch
    ? [...listMatch[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    : [];
  ok('security_events is preserved by the reset', systemTables.includes('security_events'),
    JSON.stringify(systemTables));

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  db.pragma('foreign_keys = OFF');
  let resetErr = null;
  try {
    db.transaction(() => {
      for (const t of tables) {
        if (!systemTables.includes(t.name)) db.exec(`DELETE FROM "${t.name}"`);
      }
    })();
  } catch (e) { resetErr = e; }
  db.pragma('foreign_keys = ON');

  ok('the reset completes', resetErr === null,
    resetErr ? String(resetErr.message).slice(0, 90) : '');
  ok('trading data really was wiped',
    db.prepare('SELECT COUNT(*) c FROM customers').get().c === 0);
  ok('the audit trail survived the wipe',
    db.prepare('SELECT COUNT(*) c FROM security_events').get().c === logBefore,
    'the record of the wipe was wiped with it');

  // ...and the reset can record ITSELF afterwards.
  recordSecurityEvent(db, 'database_reset', 1, 'admin', 'تصفير قاعدة البيانات');
  ok('the reset can still be recorded after the wipe',
    db.prepare('SELECT COUNT(*) c FROM security_events').get().c === logBefore + 1);
}

// ===========================================================================
console.log('── 5. the guards are in the schema the tests can see ──');
// ===========================================================================
{
  // A guard generated in a loop would run in the app and be invisible to every
  // test, because the harness skips db.exec templates containing `${`. It has
  // happened in this project before, so the trigger is asserted to be present
  // in the database the tests actually built.
  const trig = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ck_security_events_%'"
  ).all().map(r => r.name).sort();
  ok('the UPDATE guard exists in the test database',
    trig.includes('ck_security_events_no_update'), JSON.stringify(trig));
  ok('the DELETE guard exists in the test database',
    trig.includes('ck_security_events_no_delete'), JSON.stringify(trig));

  // Re-running the migrations must not fail or lose events.
  const { runMigrations } = await import(pathToFileURL(join(ROOT, 'src/main/database/migrations/index.ts')).href);
  const n = db.prepare('SELECT COUNT(*) c FROM security_events').get().c;
  let again = null;
  try { runMigrations(db); } catch (e) { again = e; }
  ok('migrations are safe to re-run with the guards in place', again === null,
    again ? String(again.message).slice(0, 90) : '');
  ok('re-running them loses no events',
    db.prepare('SELECT COUNT(*) c FROM security_events').get().c === n);
}

// ===========================================================================
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — the audit trail cannot be rewritten or erased`);
