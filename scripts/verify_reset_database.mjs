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

  t('the caller must prove their password', /bcrypt\.compareSync\(data\.password/.test(s));
  t('a snapshot is taken before anything is deleted',
    s.indexOf('db.backup(') < s.indexOf('DELETE FROM'));
  t('a failed snapshot aborts the reset',
    /تعذّر إنشاء نسخة احتياطية قبل التصفير/.test(s));

  const guard = code('src/main/security/ipcGuard.ts');
  t('the channel is permission-gated', /'settings:resetDatabase':/.test(guard));
  t('and it is not reachable before login',
    !/PUBLIC_CHANNELS[\s\S]{0,1800}'settings:resetDatabase'/.test(guard));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
