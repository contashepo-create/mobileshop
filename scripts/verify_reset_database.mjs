#!/usr/bin/env node
/**
 * DATABASE RESET — behavioural suite.
 *
 * "Clear the database" is the most destructive button in the program. It has to
 * be right in two opposite directions at once: it must actually delete the
 * trading history, and it must NOT delete the users, roles and settings that
 * let the shop log back in afterwards.
 *
 * THE BUG THIS SUITE EXISTS FOR
 * -----------------------------
 * The reset failed outright with "فشل تصفير قاعدة البيانات" and left the
 * database untouched.
 *
 * `PRAGMA foreign_keys` is a NO-OP while a transaction is open. SQLite ignores
 * it and reports no error. The handler issued it as the first statement INSIDE
 * `db.transaction(...)`, so enforcement stayed ON. Tables are wiped in
 * alphabetical order, which deletes `customers` before `sales`; the orphaned
 * reference threw SQLITE_CONSTRAINT_FOREIGNKEY, the transaction rolled back,
 * and nothing was cleared.
 *
 * Every check below runs against the project's REAL schema, built from its own
 * migration file, with real parent/child rows seeded. A structural check that
 * merely grepped for "PRAGMA foreign_keys = OFF" would have passed on the
 * broken code, because the broken code contained exactly that line.
 *
 * Run with:  node --experimental-strip-types scripts/verify_reset_database.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

/** Source with comments stripped: a check must not pass by matching prose. */
function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('DATABASE RESET');
console.log('='.repeat(72));

// better-sqlite3 gives real FK enforcement; node:sqlite is not a substitute
// here because the whole bug is about constraint behaviour.
let Database = null;
for (const p of [join(ROOT, 'node_modules/better-sqlite3'), join(ROOT, 'scripts/node_modules/better-sqlite3')]) {
  if (existsSync(p)) { try { Database = require(p); break; } catch { /* try next */ } }
}
if (!Database) { try { Database = require('better-sqlite3'); } catch { /* unavailable */ } }

if (!Database) {
  // A suite that silently skips is a suite that cannot fail. Say so loudly.
  console.log('\n  FAIL  better-sqlite3 is unavailable — this suite cannot run.');
  console.log('        The bug under test is about foreign-key enforcement and');
  console.log('        cannot be checked without a real SQLite engine.');
  console.log('\nRESULT: 0 passed, 1 failed');
  process.exit(1);
}

/**
 * The preserve-list, READ FROM THE HANDLER rather than copied.
 *
 * An earlier version of this suite hardcoded the list. That made it blind to
 * the single worst failure this feature has: dropping `users` from the list
 * wipes every account and locks the shop out of its own program forever, and a
 * hardcoded copy went on testing a list the application no longer used. The
 * mutant survived. Parsing the real array means the test cannot drift from the
 * code it is guarding.
 */
function loadSystemTables() {
  const src = code('src/main/ipc/settings.handlers.ts');
  const m = /const systemTables = \[([^\]]+)\]/.exec(src);
  if (!m) throw new Error('could not find systemTables in settings.handlers.ts');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const SYSTEM_TABLES = loadSystemTables();

/** Accounts, roles and settings must never be wiped, whatever else changes. */
const MUST_PRESERVE = ['users', 'roles', 'role_permissions', 'permissions', 'settings', 'fiscal_years'];

/** Builds the REAL schema and seeds a realistic parent/child chain. */
function buildSeededDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const ts = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');
  for (const m of ts.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)) {
    const sql = m[1];
    if (sql.includes('${')) continue;
    for (const stmt of sql.split(/;\s*\n/)) {
      const s = stmt.trim();
      if (!s) continue;
      try { db.exec(s + ';'); } catch { /* ALTER on an existing column, etc. */ }
    }
  }

  db.exec(`INSERT INTO fiscal_years (YearName,StartDate,EndDate,Status)
           VALUES ('2026','2026-01-01','2026-12-31','open')`);
  db.exec(`INSERT OR IGNORE INTO roles (RoleID,RoleName,IsSystem) VALUES (1,'admin',1)`);
  // Permissions are seeded by `seedData()`, which is JavaScript rather than a
  // db.exec template, so the schema builder above does not run it. Insert one
  // directly: the point of the check is that the reset PRESERVES this table.
  db.exec(`INSERT OR IGNORE INTO permissions (PermissionKey,PermissionName,Module)
           VALUES ('settings.edit','تعديل الإعدادات','settings')`);
  db.exec(`INSERT OR IGNORE INTO role_permissions (RoleID,PermissionID) VALUES (1,1)`);
  db.exec(`INSERT INTO users (Username,PasswordHash,RoleID,IsActive) VALUES ('admin','hash',1,1)`);
  db.exec(`INSERT OR IGNORE INTO settings (Key,Value) VALUES ('company_name','محل محمد')`);
  db.exec(`INSERT INTO customers (Name) VALUES ('عميل')`);
  db.exec(`INSERT INTO sales (SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,TotalAmount,PaidAmount,PaymentMethod,UserID)
           VALUES ('S1',1,'2026-07-31',1,100,100,100,'cash',1)`);
  db.exec(`INSERT INTO sale_details (SaleID,UnitPrice,Total) VALUES (1,100,100)`);
  return db;
}

const tableNames = db =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);

const count = (db, table) => {
  try { return db.prepare(`SELECT COUNT(*) v FROM "${table}"`).get().v; } catch { return -1; }
};

/** The BROKEN implementation, kept so the suite proves it really fails. */
function resetBroken(db) {
  const tables = tableNames(db);
  try {
    db.transaction(() => {
      db.exec('PRAGMA foreign_keys = OFF');       // ignored inside a transaction
      for (const t of tables) if (!SYSTEM_TABLES.includes(t)) db.exec(`DELETE FROM "${t}"`);
      db.exec('PRAGMA foreign_keys = ON');
    })();
    return { success: true };
  } catch (err) {
    return { success: false, message: String(err.message || err) };
  }
}

/** The FIXED implementation, mirroring settings.handlers.ts. */
function resetFixed(db) {
  const tables = tableNames(db);
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const t of tables) if (!SYSTEM_TABLES.includes(t)) db.exec(`DELETE FROM "${t}"`);
    })();
    return { success: true };
  } catch (err) {
    return { success: false, message: String(err.message || err) };
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

// ---------------------------------------------------------------- 1
console.log('\n[1] The original failure is real, and the fix cures it');
{
  const broken = buildSeededDb();
  const r1 = resetBroken(broken);
  t('the OLD code fails exactly as the user reported',
    r1.success === false && /FOREIGN KEY/i.test(r1.message || ''), r1.message);
  t('and it deletes nothing — the shop keeps its data but sees an error',
    count(broken, 'sales') === 1, `sales=${count(broken, 'sales')}`);

  const fixed = buildSeededDb();
  const r2 = resetFixed(fixed);
  t('the NEW code succeeds', r2.success === true, r2.message);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A pragma inside a transaction is silently ignored (the root cause)');
{
  const db = buildSeededDb();
  let inside = null;
  db.transaction(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    inside = db.pragma('foreign_keys', { simple: true });
  })();
  t('PRAGMA foreign_keys = OFF has NO effect inside a transaction',
    inside === 1, `enforcement reported ${inside}`);

  db.pragma('foreign_keys = OFF');
  t('the same pragma DOES take effect outside one',
    db.pragma('foreign_keys', { simple: true }) === 0);
  db.pragma('foreign_keys = ON');
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Trading history is really gone');
{
  const db = buildSeededDb();
  t('there is history to delete before the reset',
    count(db, 'sales') === 1 && count(db, 'sale_details') === 1 && count(db, 'customers') === 1);

  resetFixed(db);

  for (const table of ['sales', 'sale_details', 'customers']) {
    t(`${table} is emptied`, count(db, table) === 0, `${count(db, table)} rows left`);
  }

  // Nothing outside the preserve list may survive anywhere.
  const leftovers = tableNames(db)
    .filter(n => !SYSTEM_TABLES.includes(n))
    .filter(n => count(db, n) > 0);
  t('no non-system table keeps any row', leftovers.length === 0, leftovers.join(', '));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The shop can still log in afterwards');
{
  // Asserted against the list the HANDLER actually uses. Dropping `users` from
  // it would wipe every account and lock the shop out of its own program with
  // no way back except editing the database by hand.
  for (const table of MUST_PRESERVE) {
    t(`${table} is on the handler's preserve-list`,
      SYSTEM_TABLES.includes(table),
      `handler preserves: ${SYSTEM_TABLES.join(', ')}`);
  }

  const db = buildSeededDb();
  resetFixed(db);

  t('users survive — otherwise the shop is locked out of its own program',
    count(db, 'users') === 1, `${count(db, 'users')} users`);
  t('roles survive', count(db, 'roles') >= 1);
  t('permissions survive', count(db, 'permissions') > 0);
  t('settings survive', count(db, 'settings') >= 1);
  t('the fiscal year survives', count(db, 'fiscal_years') === 1);

  const admin = db.prepare("SELECT Username, PasswordHash FROM users WHERE Username='admin'").get();
  t('the administrator password hash is intact',
    admin?.PasswordHash === 'hash', JSON.stringify(admin));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Foreign-key enforcement is restored, not left off');
{
  const db = buildSeededDb();
  resetFixed(db);
  t('enforcement is back ON after a successful reset',
    db.pragma('foreign_keys', { simple: true }) === 1);

  // Leaving it off would let every later screen write orphaned rows into a
  // database that still looks healthy, which is far worse than a failed reset.
  let refused = false;
  try {
    db.exec(`INSERT INTO sales (SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,TotalAmount,PaidAmount,PaymentMethod,UserID)
             VALUES ('S2',1,'2026-07-31',9999,1,1,1,'cash',1)`);
  } catch { refused = true; }
  t('an orphaned row is refused after the reset, proving FK is live', refused);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] The reset is all-or-nothing, and guarded');
{
  const s = code('src/main/ipc/settings.handlers.ts');

  t('the pragma is issued OUTSIDE the transaction',
    s.indexOf("db.pragma('foreign_keys = OFF')") < s.indexOf('db.transaction(() => {', s.indexOf('resetDatabase')));
  t('no pragma is issued inside the transaction any more',
    !/db\.transaction\(\(\) => \{[\s\S]{0,300}PRAGMA foreign_keys/.test(s));
  t('enforcement is restored in a finally block',
    /finally \{[\s\S]{0,200}foreign_keys = ON/.test(s));
  t('the deletes still run in ONE transaction, so a failure cannot half-wipe',
    /db\.transaction\(\(\) => \{[\s\S]{0,400}DELETE FROM/.test(s));
  t('a failure is reported instead of thrown at the renderer',
    /catch \(err: any\) \{[\s\S]{0,200}تعذّر تصفير/.test(s));

  t('the caller must prove their password', /bcrypt\.compareSync\(String\(data\?\.password/.test(s));
  t('a snapshot is taken before anything is deleted',
    s.indexOf('db.backup(') < s.indexOf('DELETE FROM'));
  t('a failed snapshot aborts the reset',
    /تعذّر إنشاء نسخة احتياطية قبل التصفير/.test(s));

  const guard = code('src/main/security/ipcGuard.ts');
  t('the channel is permission-gated', /'settings:resetDatabase':/.test(guard));
  t('and it is not reachable before login',
    !/PUBLIC_CHANNELS[\s\S]{0,1800}'settings:resetDatabase'/.test(guard));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Three independent proofs are demanded before anything is deleted');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const reset = s.slice(s.indexOf("'settings:resetDatabase'"));

  t('the password is re-verified in the destructive handler itself',
    /bcrypt\.compareSync\(String\(data\?\.password/.test(reset));
  t('a six-digit Telegram code is required',
    /\/\^\\d\{6\}\$\/\.test\(code\)/.test(reset));
  t('the code is verified for the database_reset purpose specifically',
    /verifyCode\('database_reset'/.test(reset));
  t('the code is bound to the user who requested it',
    /verifyCode\('database_reset', Number\(data\.userId\)/.test(reset));

  // Ordering is the whole safety argument: every proof, and the backup, must
  // come before the first DELETE.
  const iPassword = reset.indexOf('bcrypt.compareSync');
  const iCode     = reset.indexOf("verifyCode('database_reset'");
  const iBackup   = reset.indexOf('db.backup(');
  const iDelete   = reset.indexOf('DELETE FROM');
  t('password is checked before the code is spent', iPassword < iCode, `${iPassword} < ${iCode}`);
  t('the code is verified before the backup is taken', iCode < iBackup);
  t('the backup is taken before ANY delete', iBackup < iDelete, `${iBackup} < ${iDelete}`);

  t('the backup is verified readable, not merely written',
    /SQLite format 3/.test(reset) && /statSync\(backupPath\)/.test(reset));
  t('an unverifiable backup aborts the whole reset',
    /تعذّر إنشاء نسخة احتياطية قبل التصفير/.test(reset));
  t('a refused code is written to the audit log',
    /recordSecurityEvent\(db, 'database_reset_rejected'/.test(reset));
  t('the reset itself is written to the audit log',
    /recordSecurityEvent\(db, 'database_reset'/.test(reset));

  // Requesting the code must itself require the password, or the owner's phone
  // could be spammed by anyone who reaches the screen.
  const step1 = s.slice(s.indexOf("'settings:resetRequestCode'"), s.indexOf("'settings:resetDatabase'"));
  t('step 1 refuses to send a code without the correct password',
    /bcrypt\.compareSync/.test(step1));
  t('step 1 refuses when no shop bot is configured',
    /لا يمكن التصفير قبل ضبط بوت تليجرام/.test(step1));

  const guard = code('src/main/security/ipcGuard.ts');
  for (const ch of ['settings:resetDatabase', 'settings:resetRequestCode', 'settings:resetIsAvailable']) {
    t(`${ch} requires settings.edit`, new RegExp(`'${ch}': 'settings\\.edit'`).test(guard));
  }
  t('no reset channel is reachable before login',
    !/PUBLIC_CHANNELS[\s\S]{0,2000}'settings:reset/.test(guard));
}

// ------------------------------------------------------ 7b (behavioural)
console.log('\n[7b] A code minted for one purpose cannot authorise the other');
{
  // The dangerous confusion: an owner asks for a PASSWORD-reset code, and an
  // attacker who sees that six-digit message on the phone uses it to wipe the
  // entire business instead. The two flows share one implementation, so this
  // has to be proven, not assumed.
  const cc = await import('../src/main/security/confirmCode.ts');
  const BOT = { botToken: '8877684899:AAHTZfkM_MPlD2ZiR1CJ8qiKRXzFrHnRmdo', chatId: '7232305465' };

  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_u, o) => {
    sent.push(JSON.parse(o.body).text);
    return { json: async () => ({ ok: true }) };
  };
  try {
    cc.__resetCodeState();
    await cc.requestCode('password_reset', BOT, 1, 'password reset');
    const pwCode = /(\d{6})/.exec(sent.at(-1))[1];

    t('a password-reset code is REFUSED for a database wipe',
      cc.verifyCode('database_reset', 1, pwCode).success === false);
    t('and it still works for its own purpose',
      cc.verifyCode('password_reset', 1, pwCode).success === true);

    cc.__resetCodeState(); sent.length = 0;
    await cc.requestCode('database_reset', BOT, 7, 'database reset');
    const dbCode = /(\d{6})/.exec(sent.at(-1))[1];

    t('a database-reset code is REFUSED for a password reset',
      cc.verifyCode('password_reset', 7, dbCode).success === false);
    t('a database-reset code is bound to the user who asked',
      cc.verifyCode('database_reset', 8, dbCode).success === false);
    t('and it works for the right user and purpose',
      cc.verifyCode('database_reset', 7, dbCode).success === true);
    t('it cannot be used twice',
      cc.verifyCode('database_reset', 7, dbCode).success === false);

    // The wipe code must expire and be attempt-limited exactly like the other.
    cc.__resetCodeState(); sent.length = 0;
    await cc.requestCode('database_reset', BOT, 7, 'database reset');
    const c2 = /(\d{6})/.exec(sent.at(-1))[1];
    t('an expired wipe code is refused',
      cc.verifyCode('database_reset', 7, c2, Date.now() + cc.CODE_TTL_MS + 1000).success === false);

    cc.__resetCodeState(); sent.length = 0;
    await cc.requestCode('database_reset', BOT, 7, 'database reset');
    const c3 = /(\d{6})/.exec(sent.at(-1))[1];
    for (let i = 0; i < cc.MAX_ATTEMPTS; i++) cc.verifyCode('database_reset', 7, '000000');
    t('a wipe code dies after five wrong attempts',
      cc.verifyCode('database_reset', 7, c3).success === false);

    cc.__resetCodeState(); sent.length = 0;
    let allowed = 0;
    for (let i = 0; i < 6; i++) {
      if ((await cc.requestCode('database_reset', BOT, 7, 'x')).success) allowed++;
    }
    t('wipe-code requests are rate limited too',
      allowed <= cc.MAX_REQUESTS_PER_HOUR, `allowed ${allowed}`);

    t('no wipe code is minted when no bot is configured',
      (await cc.requestCode('database_reset', null, 7, 'x')).success === false);
  } finally {
    globalThis.fetch = realFetch;
    cc.__resetCodeState();
  }
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Both alerts are raised, and neither can break the reset');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const n = code('src/main/security/resetNotify.ts');

  t('the SHOP OWNER is told on the shop bot', /notifyDatabaseReset\(shopTelegram\(\)/.test(s));
  t('the DEVELOPER is told as well', /notifyDeveloperOfReset\(/.test(s));
  t('the audit row is written BEFORE either alert',
    s.indexOf("recordSecurityEvent(db, 'database_reset'") < s.indexOf('notifyDatabaseReset('));

  t('the owner alert cannot throw', /export async function notifyDatabaseReset[\s\S]{0,900}catch/.test(n));
  t('the developer alert cannot throw', /export async function notifyDeveloperOfReset[\s\S]{0,1400}catch/.test(n));
  t('the developer alert is time-limited so the shop never waits',
    /AbortController[\s\S]{0,200}setTimeout/.test(n));

  // Privacy: support must learn THAT it happened, never what was in the books.
  const payload = /body: JSON\.stringify\(\{([\s\S]{0,300}?)\}\)/.exec(n)?.[1] || '';
  t('the developer alert carries no business data',
    !/customer|balance|invoice|price|amount|sales/i.test(payload), payload.replace(/\s+/g, ' ').slice(0, 90));
  t('it carries only device, shop, user and time',
    /deviceId/.test(payload) && /shopName/.test(payload) && /username/.test(payload) && /at:/.test(payload));

  const w = code('server/worker.js');
  t('the worker exposes the alert endpoint', /case '\/database-reset'/.test(w));
  t('the endpoint is authenticated', /handleDatabaseReset[\s\S]{0,300}X-Client-Key/.test(w));
  t('the endpoint relays to the developer chat', /handleDatabaseReset[\s\S]{0,1200}await tg\(env,/.test(w));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Clearing data does NOT touch the subscription');
{
  // The question a shop owner actually asks: "will wiping my data be treated
  // as tampering and cost me my licence?" The answer must be provably no.
  const lic = code('src/main/ipc/license.handlers.ts');
  const w = code('server/worker.js');

  t('the licence lives in files, not in the database',
    /LICENSE_FILE = 'license.dat'/.test(lic) && /TRIAL_FILE = 'trial.dat'/.test(lic));
  t('the reset never touches those files',
    !/license\.dat|trial\.dat|lastaccess/.test(code('src/main/ipc/settings.handlers.ts')));

  // `settings` is preserved, and that is where the cached licence summary and
  // the device id related keys live.
  t('settings is preserved, so nothing licence-related is cleared',
    SYSTEM_TABLES.includes('settings'));

  // The one place the licence reads business data is the clock-rollback check,
  // and an EMPTY database makes that check pass trivially — it cannot accuse.
  t('the only licence read of business data is the clock check',
    /function newestBusinessDate/.test(lic));
  t('an empty database yields no activity date, so no tampering is inferred',
    /SELECT MAX\(d\) AS newest/.test(lic) && /latestActivity && isImplausiblyFuture/.test(lic));

  t('the developer alert endpoint writes nothing to the licences table',
    !/handleDatabaseReset[\s\S]{0,1200}(INSERT INTO licenses|UPDATE licenses|DELETE FROM licenses)/.test(w));
  t('the alert is a notification only, returning ok',
    /handleDatabaseReset[\s\S]{0,1400}return json\(\{ ok: true \}\)/.test(w));

  // Behavioural: after a reset the clock-rollback query returns nothing.
  const db = buildSeededDb();
  resetFixed(db);
  const newest = db.prepare(`
    SELECT MAX(d) AS newest FROM (
      SELECT MAX(Date) AS d FROM sales
      UNION ALL SELECT MAX(Date) FROM purchases
      UNION ALL SELECT MAX(Date) FROM vouchers
      UNION ALL SELECT MAX(Date) FROM maintenance_tickets
    )`).get();
  t('after a reset there is no business date to trigger a tamper flag',
    newest?.newest == null, JSON.stringify(newest));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
