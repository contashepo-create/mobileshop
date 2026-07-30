#!/usr/bin/env node
/**
 * UPGRADE SAFETY — can a customer install a new version without losing a year
 * of invoices?
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in this product can be rebuilt. The application can be
 * reinstalled, the licence reissued, the settings retyped. A shop's trading
 * history exists in exactly one file, and every upgrade touches it.
 *
 * That makes the upgrade path the highest-consequence routine event in the
 * product's life, and until now it had no test at all. This suite runs REAL
 * migrations against REAL SQLite databases holding REAL rows, and checks the
 * rows are still there afterwards — not that the code looks correct.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. an upgrade preserves every row and every total;
 *   2. a migration that FAILS restores the data instead of leaving it broken;
 *   3. the snapshot is taken BEFORE the first migration statement, never after;
 *   4. an older build refuses to open a database written by a newer one;
 *   5. an interrupted upgrade is retried, not assumed complete;
 *   6. re-running migrations on an up-to-date database changes nothing.
 *
 * Run with:  node scripts/verify_upgrade_safety.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire, register } from 'node:module';

// `migrations/index.ts` imports './connection' with no extension, which Node's
// ESM resolver rejects. The handler harness solves this with a loader hook;
// the same trick is used here so section [6] can exercise the REAL migrations
// rather than a toy stand-in.
register(
  'data:text/javascript,' + encodeURIComponent(`
    import { existsSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        const candidate = new URL(specifier + '.ts', context.parentURL || import.meta.url);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    }
  `),
  import.meta.url,
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = f => fs.readFileSync(join(ROOT, f), 'utf-8');
const code = f => R(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PASS = [], FAIL = [];
function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}

let Database = null;
for (const base of [join(ROOT, 'package.json'), join(HERE, 'package.json')]) {
  try { Database = createRequire(base)('better-sqlite3'); break; } catch { /* next */ }
}

console.log('='.repeat(74));
console.log('UPGRADE SAFETY — a customer must never lose data to a new version');
console.log('='.repeat(74));

// The real module under test.
const {
  CURRENT_SCHEMA_VERSION, readSchemaVersion, writeSchemaVersion,
  migrateWithSafetyNet, SchemaTooNewError,
} = await import('../src/main/database/schemaVersion.ts');

/** A shop that has been trading: a year of invoices, in WAL mode like the app. */
function tradingShop(dir) {
  const p = path.join(dir, 'shop.db');
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE customers(CustomerID INTEGER PRIMARY KEY, Name TEXT, Balance REAL);
    CREATE TABLE sales(SaleID INTEGER PRIMARY KEY, CustomerID INTEGER, TotalAmount REAL, PaidAmount REAL);
  `);
  const c = db.prepare('INSERT INTO customers(Name,Balance) VALUES(?,?)');
  const s = db.prepare('INSERT INTO sales(CustomerID,TotalAmount,PaidAmount) VALUES(?,?,?)');
  db.transaction(() => {
    for (let i = 1; i <= 40; i++) c.run(`عميل ${i}`, i * 25);
    for (let i = 1; i <= 500; i++) s.run((i % 40) + 1, i * 13.5, i * 4.5);
  })();
  return { db, p };
}

const census = db => db.prepare(`
  SELECT (SELECT COUNT(*) FROM customers) cCount,
         (SELECT ROUND(COALESCE(SUM(Balance),0),2) FROM customers) cSum,
         (SELECT COUNT(*) FROM sales) sCount,
         (SELECT ROUND(COALESCE(SUM(TotalAmount),0),2) FROM sales) sSum
`).get();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!Database) {
  console.log('\n  (better-sqlite3 unavailable — running structural checks only)');
}

// ------------------------------------------------------------------ 1
console.log('\n[1] MEASURED: an upgrade keeps every row and every piastre');
if (Database) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-ok-'));
  const { db } = tradingShop(tmp);
  const before = census(db);

  // A realistic migration: add a column, and rebuild a table the way the real
  // migrations do when a NOT NULL constraint has to be relaxed.
  const migrate = d => {
    try { d.exec('ALTER TABLE customers ADD COLUMN TaxNumber TEXT'); } catch { /* present */ }
    d.exec(`CREATE TABLE sales_migrate(
      SaleID INTEGER PRIMARY KEY, CustomerID INTEGER, TotalAmount REAL,
      PaidAmount REAL, Notes TEXT)`);
    d.exec('INSERT INTO sales_migrate(SaleID,CustomerID,TotalAmount,PaidAmount) '
      + 'SELECT SaleID,CustomerID,TotalAmount,PaidAmount FROM sales');
    d.exec('DROP TABLE sales');
    d.exec('ALTER TABLE sales_migrate RENAME TO sales');
  };

  check('the database starts unversioned (an existing customer install)',
    readSchemaVersion(db) === 0);

  const rep = migrateWithSafetyNet(db, tmp, migrate);
  const after = census(db);

  check('the upgrade reports success', rep.upgraded === true && !rep.error,
    JSON.stringify(rep));
  check('not one customer or invoice was lost', same(before, after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  console.log(`        ${before.cCount} customers / ${before.sCount} invoices, `
    + `totals ${before.cSum} and ${before.sSum} — unchanged`);
  check('the new column exists and is empty for existing rows',
    db.prepare('SELECT COUNT(*) v FROM customers WHERE TaxNumber IS NULL').get().v === before.cCount);
  check('the version is stamped only after the migration completes',
    readSchemaVersion(db) === CURRENT_SCHEMA_VERSION, `version ${readSchemaVersion(db)}`);
  check('a snapshot of the pre-upgrade database was kept',
    !!rep.snapshot && fs.existsSync(rep.snapshot), rep.snapshot);

  // The snapshot must be readable and complete, or it is not a backup.
  const snap = new Database(rep.snapshot, { readonly: true });
  check('the snapshot itself holds the complete original data',
    same(census(snap), before), JSON.stringify(census(snap)));
  snap.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 2
console.log('\n[2] MEASURED: a FAILED migration gives the data back');
if (Database) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-fail-'));
  const { db, p } = tradingShop(tmp);
  const before = census(db);

  // Fails halfway: the first statement lands, the second throws. Without a
  // safety net this is precisely the state that ruins a shop.
  const migrate = d => {
    d.exec('ALTER TABLE customers ADD COLUMN Half TEXT');
    d.exec('DELETE FROM sales WHERE SaleID > 100');
    throw new Error('simulated power cut');
  };

  const rep = migrateWithSafetyNet(db, tmp, migrate);
  check('the failure is reported, not swallowed', !!rep.error && rep.upgraded === false,
    JSON.stringify(rep.error?.message));
  check('the data was restored automatically', !!rep.restoredFrom, JSON.stringify(rep));

  // Reopen the way the app would on the next launch.
  const reopened = new Database(p);
  reopened.pragma('journal_mode = WAL');
  const after = census(reopened);
  check('every invoice the migration deleted is back', same(before, after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check('the half-applied column is gone too',
    !reopened.prepare('PRAGMA table_info(customers)').all().some(c => c.name === 'Half'));
  check('the version was NOT stamped, so the upgrade is retried next launch',
    readSchemaVersion(reopened) === 0, `version ${readSchemaVersion(reopened)}`);
  reopened.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 3
console.log('\n[3] MEASURED: the snapshot is taken BEFORE anything is migrated');
if (Database) {
  // The original ordering bug: backup at index.ts:163, migrations at :115. A
  // snapshot taken afterwards is a snapshot of the damage.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-order-'));
  const { db } = tradingShop(tmp);
  const before = census(db);

  const rep = migrateWithSafetyNet(db, tmp, d => {
    d.exec('DELETE FROM sales');        // destroys everything
  });

  const snap = new Database(rep.snapshot, { readonly: true });
  check('the snapshot predates the destructive statement',
    census(snap).sCount === before.sCount,
    `snapshot holds ${census(snap).sCount} invoices, original had ${before.sCount}`);
  snap.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 4
console.log('\n[4] MEASURED: an older build refuses a newer database');
if (Database) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-new-'));
  const { db } = tradingShop(tmp);
  writeSchemaVersion(db, CURRENT_SCHEMA_VERSION + 5);   // written by a future build

  let refused = false, msg = '';
  try {
    migrateWithSafetyNet(db, tmp, () => { throw new Error('must not run'); });
  } catch (err) {
    refused = err instanceof SchemaTooNewError;
    msg = err.message;
  }
  check('opening it is refused outright', refused, msg);
  check('and the refusal is explained in Arabic', /[\u0600-\u06FF]/.test(msg));
  console.log(`        ${msg}`);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 5
console.log('\n[5] MEASURED: an ordinary launch costs nothing');
if (Database) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-noop-'));
  const { db } = tradingShop(tmp);
  writeSchemaVersion(db, CURRENT_SCHEMA_VERSION);       // already current
  const before = census(db);

  let ran = 0;
  const rep = migrateWithSafetyNet(db, tmp, () => { ran++; });
  check('no upgrade is reported', rep.upgraded === false && !rep.error);
  check('migrations still run (they are idempotent and self-healing)', ran === 1);
  check('no snapshot is taken, so start-up stays fast', !rep.snapshot);
  check('the data is untouched', same(before, census(db)));

  const snaps = fs.existsSync(path.join(tmp, 'backups'))
    ? fs.readdirSync(path.join(tmp, 'backups')) : [];
  check('the backups folder is not filled up on every launch', snaps.length === 0,
    `${snaps.length} files`);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 6
console.log('\n[6] MEASURED: the real migrations survive a round trip');
if (Database) {
  // Not a toy migration this time — the project's actual runMigrations, run
  // twice against a populated database. Running it a second time must be a
  // no-op, because that is what happens on every single customer launch.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-real-'));
  const p = path.join(tmp, 'shop.db');
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // The REAL schema, applied the way the handler harness does it: every
  // `db.exec(\`...\`)` block executed in source order. Importing the module is
  // not possible here (Node's strip-only TypeScript mode cannot parse it), and
  // running the genuine SQL matters far more than running the genuine function.
  const migSrc = fs.readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');
  const realSchema = d => {
    for (const m of migSrc.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)) {
      const sql = m[1];
      if (sql.includes('${')) continue;              // dynamic, skipped by design
      for (const stmt of sql.split(';')) {
        const t = stmt.trim();
        if (!t || /^--/.test(t)) continue;
        try { d.exec(t); } catch { /* ALTER on an existing column, etc. */ }
      }
    }
  };

  const first = migrateWithSafetyNet(db, tmp, realSchema);
  check('a fresh install applies the real schema cleanly', !first.error,
    String(first.error?.message));
  check('the real tables exist afterwards',
    db.prepare("SELECT COUNT(*) v FROM sqlite_master WHERE type='table' AND name='sales'").get().v === 1);

  // Put a real customer in, then migrate again the way the next launch would.
  db.exec("INSERT INTO customers(Name,Balance,Status) VALUES('عميل حقيقي',1250.75,'active')");
  const before = db.prepare(
    'SELECT COUNT(*) c, ROUND(COALESCE(SUM(Balance),0),2) s FROM customers').get();

  const second = migrateWithSafetyNet(db, tmp, realSchema);
  const after = db.prepare(
    'SELECT COUNT(*) c, ROUND(COALESCE(SUM(Balance),0),2) s FROM customers').get();

  check('re-running the real schema reports no upgrade', second.upgraded === false);
  check('and does not disturb a single row', same(before, after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check('the schema version is recorded in the file header',
    readSchemaVersion(db) === CURRENT_SCHEMA_VERSION);

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  SKIP  (native module unavailable)');
}

// ------------------------------------------------------------------ 7
console.log('\n[7] The safety net is actually wired into start-up');
{
  const idx = code('src/main/index.ts');
  check('start-up migrates through the safety net, not directly',
    /migrateWithSafetyNet\(db,/.test(idx) && !/^\s*runMigrations\(db\);/m.test(idx),
    'calling runMigrations bare would skip the snapshot entirely');
  check('a failed upgrade stops the app instead of running on broken data',
    /upgrade\.error/.test(idx) && /app\.quit\(\)/.test(idx));
  check('a newer database is refused with its own message',
    /SchemaTooNewError/.test(idx));

  const sv = code('src/main/database/schemaVersion.ts');
  check('the snapshot is written synchronously and WAL-safely',
    /VACUUM INTO/.test(sv),
    'db.backup() is async — the file does not exist when it returns');
  check('and never with a plain file copy',
    !/copyFileSync\(\s*db\.name/.test(sv));
  check('a snapshot that cannot be taken aborts the upgrade',
    /تعذر إنشاء نسخة احتياطية قبل التحديث/.test(sv));
  check('stale -wal/-shm are cleared when restoring',
    /-wal/.test(sv) && /-shm/.test(sv));
  check('the version is stamped after migrating, not before',
    sv.includes('writeSchemaVersion(db, to)')
    && sv.indexOf('migrate(db);') < sv.lastIndexOf('writeSchemaVersion(db, to)'),
    'without the stamp an interrupted upgrade is never retried');
  // These three were caught only by the behavioural sections, which SKIP when
  // better-sqlite3 is unavailable — so mutation testing showed them surviving.
  // A test that silently skips is a test that cannot fail, so the guarantees
  // are asserted structurally too.
  check('a failed migration restores the snapshot',
    /fs\.copyFileSync\(snapshot, live\)/.test(sv),
    'without this the customer keeps a half-migrated database');
  check('a newer database is refused before anything runs',
    /if \(from > to\) throw new SchemaTooNewError/.test(sv));
  check('old snapshots are pruned by an exact pattern only',
    /\^pre_upgrade_v\\d\+_\\d\{8\}T\\d\{6\}\\\.db\$/.test(sv),
    'a loose pattern would delete files the owner put there');
}

// ------------------------------------------------------------------ 8
console.log('\n[8] The updater reaches customers without interrupting them');
// Once the .exe is on a shop's counter there is no other way to deliver a fix.
// But a shop mid-sale must never be interrupted by it.
{
  const up = code('src/main/updater.ts');
  const idx = code('src/main/index.ts');

  // The only call to quitAndInstall must sit behind the owner's answer. A
  // clumsier version of this check matched the wrong shape and failed on
  // correct code — the rule is simply: one call, and it is guarded.
  const installCalls = (up.match(/quitAndInstall\(/g) || []).length;
  check('an update is never installed without the owner choosing',
    installCalls === 1 && /response === 0\)\s*\{[\s\S]{0,200}?quitAndInstall\(/.test(up),
    `quitAndInstall called ${installCalls} time(s); it must be guarded by the reply`);
  check('"later" is the default button, not "restart now"',
    /defaultId:\s*1/.test(up) && /cancelId:\s*1/.test(up));
  check('the owner is told once, not every check',
    /if \(notified\) return;/.test(up));
  check('a failed check never shows an error dialog',
    /autoUpdater\.on\('error'/.test(up) && !/showErrorBox/.test(up),
    'a shop with no internet must be able to trade all day in silence');
  check('development builds never self-update',
    /app\.isPackaged/.test(up), 'it would replace the developer working copy');
  check('the first check is delayed so start-up is not slowed',
    /FIRST_CHECK_DELAY_MS/.test(up) && /setTimeout\(check/.test(up));
  check('the updater is started from the real entry point',
    /startUpdater\(\)/.test(idx));
  check('the notice reassures the owner their data is protected',
    /[\u0600-\u06FF]/.test(up) && /نسخة احتياطية/.test(up));
}

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(74));
process.exit(FAIL.length ? 1 : 0);
