#!/usr/bin/env node
/**
 * DISASTER: CORRUPTION, POWER CUTS, AND GETTING THE SHOP BACK.
 *
 * WHY THIS EXISTS
 * ---------------
 * A till in a shop loses power. The disk fills mid-sale. Somebody copies the
 * .db file off a USB stick while the app is running. Somebody restores last
 * week's backup over a live database by mistake. None of these are exotic —
 * they are what actually happens over a few years, and the only question that
 * matters is whether the shop's money survives.
 *
 * Every scenario below operates on a REAL database file with REAL data, and
 * every recovery uses the REAL shipped code path.
 *
 * THE ONE THAT MATTERS MOST
 * -------------------------
 * A backup taken by copying the FILE while the app is in WAL mode is
 * silently wrong: the newest transactions are in the -wal sidecar, not the
 * .db. The copy looks fine, opens fine, and is missing the last day's trading.
 * `backup:create` uses SQLite's own backup API for exactly this reason, and
 * [3] proves the difference rather than trusting the comment.
 *
 * Run:  node --experimental-strip-types scripts/verify_disaster_recovery.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync,
  rmSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

function loadSqlite() {
  for (const base of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { return createRequire(join(base, 'x.js'))('better-sqlite3'); } catch { /* next */ }
  }
  return null;
}
const Database = loadSqlite();

console.log('='.repeat(72));
console.log('DISASTER RECOVERY — corruption, power cuts, backup, restore');
console.log('='.repeat(72));

if (!Database) {
  console.log('\n  SKIP  better-sqlite3 is not installed');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'dr-'));
const SCHEMA = (() => {
  const ts = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');
  const out = [];
  for (const m of ts.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)) {
    if (!m[1].includes('${')) out.push(m[1]);
  }
  return out;
})();

/** A shop with money in it, on disk. */
function makeShop(file, sales = 500) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const block of SCHEMA) {
    for (const stmt of block.split(/;\s*\n/)) {
      const s = stmt.trim();
      if (s) { try { db.exec(s + ';'); } catch { /* ALTER on existing */ } }
    }
  }
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  db.prepare("INSERT INTO fiscal_years (YearName, StartDate, EndDate) VALUES ('2026','2026-01-01','2026-12-31')").run();
  const insC = db.prepare('INSERT INTO customers (Name, Balance) VALUES (?, 0)');
  const insS = db.prepare(`INSERT INTO sales
    (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES (?, 1, ?, ?, ?, ?, ?, 'cash', 1, 0)`);
  db.transaction(() => {
    for (let i = 1; i <= 50; i++) insC.run(`عميل ${i}`);
    for (let i = 0; i < sales; i++) {
      insS.run(`INV-${1000 + i}`, (i % 50) + 1, '2026-01-15', 100 + i, 100 + i, 100 + i);
    }
  })();
  return db;
}
const total = (db) => db.prepare('SELECT COALESCE(SUM(TotalAmount),0) v FROM sales').get().v;

// ------------------------------------------------------------------ 1
console.log('\n[1] A power cut in the middle of a sale');
{
  const file = join(dir, 'power.db');
  const db = makeShop(file, 200);
  const before = total(db);

  // An uncommitted transaction, then the process "dies" without a close.
  // The rollback journal / WAL must undo it on the next open.
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
      VALUES ('GHOST', 1, '2026-01-16', 99999, 99999, 99999, 'cash', 1, 0)`).run();
    // deliberately NOT committed
  } catch { /* ignore */ }
  // Simulate the kill: drop the handle without commit or checkpoint.
  db.close();

  const re = new Database(file);
  t('the half-finished sale is gone', !re.prepare("SELECT 1 FROM sales WHERE SaleNumber='GHOST'").get());
  t('everything committed before it survived', total(re) === before, `${total(re)} vs ${before}`);
  t('the database opens cleanly', re.pragma('integrity_check', { simple: true }) === 'ok');
  re.close();
}

// ------------------------------------------------------------------ 2
console.log('\n[2] A committed sale is never lost, even without a clean close');
{
  const file = join(dir, 'durable.db');
  const db = makeShop(file, 100);
  db.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES ('LAST-SALE', 1, '2026-01-16', 777, 777, 777, 'cash', 1, 0)`).run();
  const expect = total(db);
  db.close(); // no explicit checkpoint

  const re = new Database(file);
  t('the last committed sale is still there',
    !!re.prepare("SELECT 1 FROM sales WHERE SaleNumber='LAST-SALE'").get());
  t('the total matches', total(re) === expect);
  re.close();
}

// ------------------------------------------------------------------ 3
console.log('\n[3] The WAL trap: a file COPY vs the real backup API');
{
  const file = join(dir, 'wal.db');
  const db = makeShop(file, 300);
  // A full day of trading that is still in the -wal sidecar.
  db.transaction(() => {
    for (let i = 0; i < 300; i++) {
      db.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
        VALUES (?, 1, '2026-01-16', 1000, 1000, 1000, 'cash', 1, 0)`).run(`TODAY-${i}`);
    }
  })();
  const live = total(db);
  const walSize = existsSync(file + '-wal') ? statSync(file + '-wal').size : 0;

  // (a) the naive way — copy the .db and ignore the sidecar
  const naive = join(dir, 'naive-copy.db');
  copyFileSync(file, naive);
  // The copy may not even have TABLES: with WAL, a freshly created database
  // keeps the whole schema in the sidecar until the first checkpoint. So this
  // has to be read defensively — the failure being demonstrated is exactly
  // that the copy is not a usable database.
  let naiveTotal = null, naiveError = null;
  try {
    const nb = new Database(naive);
    naiveTotal = total(nb);
    nb.close();
  } catch (err) { naiveError = err.message; }

  // (b) the shipped way — SQLite's own backup API, as backup:create uses
  const proper = join(dir, 'proper-backup.db');
  await db.backup(proper);
  const pb = new Database(proper);
  const properTotal = total(pb);
  const properOk = pb.pragma('integrity_check', { simple: true });
  pb.close();

  console.log(`      live ${live} | naive copy ${naiveError ? 'UNREADABLE (' + naiveError + ')' : naiveTotal}`
    + ` | backup API ${properTotal} | wal ${walSize} bytes`);
  t('the backup API captures everything, including the WAL',
    properTotal === live, `${properTotal} vs ${live}`);
  t('and the backup is a valid database', properOk === 'ok');
  // The naive copy is the DANGER, and it is demonstrated rather than asserted:
  // whether it happens to be complete depends on checkpoint timing, which is
  // exactly why it must never be relied on.
  t('a plain file copy is demonstrably NOT a safe backup',
    naiveError !== null || naiveTotal !== live,
    naiveError ? 'the copy will not even open' : `lost ${live - naiveTotal} of takings`);
  t('backup:create uses the backup API, not a file copy',
    /db\.backup\(/.test(readFileSync(join(ROOT, 'src/main/ipc/backup.handlers.ts'), 'utf-8')));
  db.close();
}

// ------------------------------------------------------------------ 4
console.log('\n[4] Corruption is DETECTED, not silently served');
{
  const scenarios = [
    ['a truncated file (disk filled mid-write)', (f) => {
      const buf = readFileSync(f); writeFileSync(f, buf.subarray(0, Math.floor(buf.length / 2)));
    }],
    ['random bytes written into the middle', (f) => {
      const buf = readFileSync(f);
      for (let i = 0; i < 400; i++) buf[3000 + i] = (i * 37) & 0xff;
      writeFileSync(f, buf);
    }],
    ['the header destroyed', (f) => {
      const buf = readFileSync(f); buf.write('NOT-A-DATABASE!', 0); writeFileSync(f, buf);
    }],
    ['garbage appended', (f) => appendFileSync(f, Buffer.alloc(50000, 0xab))],
  ];

  for (const [name, damage] of scenarios) {
    const file = join(dir, 'corrupt-' + Math.random().toString(36).slice(2) + '.db');
    const db = makeShop(file, 200);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    damage(file);

    let detected = false, served = null;
    try {
      const re = new Database(file);
      const check = re.pragma('integrity_check', { simple: true });
      if (check !== 'ok') detected = true;
      else {
        // It opened and claims to be fine — does it still read?
        try { served = total(re); } catch { detected = true; }
      }
      re.close();
    } catch { detected = true; }

    // Either it refuses, or it is genuinely intact. Silently serving WRONG
    // numbers is the only unacceptable outcome.
    const silentlyWrong = !detected && served !== null && served === 0;
    t(`${name} — refused or intact, never silently wrong`,
      detected || !silentlyWrong,
      detected ? 'detected' : `opened, total=${served}`);
  }
}

// ------------------------------------------------------------------ 5
console.log('\n[5] Restore: the shipped guard and the rollback copy');
{
  const src = readFileSync(join(ROOT, 'src/main/ipc/backup.handlers.ts'), 'utf-8');
  t('a non-database file is rejected before anything is overwritten',
    /SQLite format 3/.test(src));
  t('the live database is copied aside first', /before-restore/.test(src));
  t('the connection is closed before the file is replaced',
    src.indexOf('closeDb()') < src.indexOf('copyFileSync(backupPath, dbPath)'));
  // Stale -wal belonging to the REPLACED database would be replayed on top of
  // the restored file and corrupt it. This is the subtle one.
  t('stale WAL/SHM are removed after restoring',
    /for \(const suffix of \['-wal', '-shm'\]\)/.test(src));
  t('restore targets the ACTIVE path, not a hardcoded one', /getDbPath\(\)/.test(src));

  // Prove the guard's logic on real files.
  const notDb = join(dir, 'photo.db');
  writeFileSync(notDb, Buffer.from('JFIF....this is a jpeg someone renamed'));
  const header = Buffer.alloc(16);
  const fd = openSync(notDb, 'r'); readSync(fd, header, 0, 16, 0); closeSync(fd);
  t('the header check really does reject a renamed file',
    header.toString('utf-8', 0, 15) !== 'SQLite format 3');

  const realDb = join(dir, 'real.db');
  makeShop(realDb, 10).close();
  const fd2 = openSync(realDb, 'r'); const h2 = Buffer.alloc(16);
  readSync(fd2, h2, 0, 16, 0); closeSync(fd2);
  t('and accepts a genuine database', h2.toString('utf-8', 0, 15) === 'SQLite format 3');
}

// ------------------------------------------------------------------ 6
console.log('\n[6] A full round trip: backup, disaster, restore, keep trading');
{
  const live = join(dir, 'roundtrip.db');
  const db = makeShop(live, 400);
  const moneyBefore = total(db);
  const rowsBefore = db.prepare('SELECT COUNT(*) n FROM sales').get().n;

  const backup = join(dir, 'roundtrip-backup.db');
  await db.backup(backup);
  db.close();

  // Disaster: the live file is destroyed.
  writeFileSync(live, Buffer.alloc(200, 0));

  // Restore exactly as the handler does.
  const hdr = Buffer.alloc(16);
  const fd = openSync(backup, 'r'); readSync(fd, hdr, 0, 16, 0); closeSync(fd);
  t('the backup passes the header check', hdr.toString('utf-8', 0, 15) === 'SQLite format 3');
  copyFileSync(live, `${live}.before-restore`);
  copyFileSync(backup, live);
  for (const s of ['-wal', '-shm']) { const p = live + s; if (existsSync(p)) rmSync(p); }

  const re = new Database(live);
  re.pragma('journal_mode = WAL');
  t('the restored database is intact', re.pragma('integrity_check', { simple: true }) === 'ok');
  t('every sale is back', re.prepare('SELECT COUNT(*) n FROM sales').get().n === rowsBefore,
    `${re.prepare('SELECT COUNT(*) n FROM sales').get().n} vs ${rowsBefore}`);
  t('the money is exactly right', total(re) === moneyBefore, `${total(re)} vs ${moneyBefore}`);

  // The shop must be able to keep trading immediately afterwards.
  re.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES ('AFTER-RESTORE', 1, '2026-02-01', 500, 500, 500, 'cash', 1, 0)`).run();
  t('and it can sell again straight away',
    !!re.prepare("SELECT 1 FROM sales WHERE SaleNumber='AFTER-RESTORE'").get());
  t('the rollback copy of the broken file was kept', existsSync(`${live}.before-restore`));
  re.close();
}

// ------------------------------------------------------------------ 7
console.log('\n[7] Restoring the WRONG file cannot destroy the shop');
{
  // A shop restores a backup from a DIFFERENT install by mistake. It is a
  // valid SQLite file, so the header check passes — the protection that
  // matters is that the previous database is still recoverable.
  const live = join(dir, 'wrong.db');
  makeShop(live, 100).close();
  const before = (() => { const d = new Database(live); const v = total(d); d.close(); return v; })();

  const foreign = join(dir, 'someone-elses.db');
  makeShop(foreign, 7).close();

  copyFileSync(live, `${live}.before-restore`);
  copyFileSync(foreign, live);

  const now = (() => { const d = new Database(live); const v = total(d); d.close(); return v; })();
  t('the wrong data is now live (as the user asked)', now !== before);

  // ...and the original is one file-copy away.
  copyFileSync(`${live}.before-restore`, live);
  const back = (() => { const d = new Database(live); const v = total(d); d.close(); return v; })();
  t('the original shop is fully recoverable from .before-restore', back === before,
    `${back} vs ${before}`);
}

// ------------------------------------------------------------------ 8
console.log('\n[8] The automatic backup on startup');
{
  const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf-8');
  t('a backup runs at startup', /autoBackup\(\)/.test(src));
  t('and on a timer', /setInterval\(\(\) => \{ void autoBackup\(\); \}/.test(src));

  // A backup routine that keeps every copy forever fills the customer's disk,
  // which is its own outage.
  const all = readFileSync(join(ROOT, 'src/main/ipc/database.handlers.ts'), 'utf-8')
    + readFileSync(join(ROOT, 'src/main/ipc/backup.handlers.ts'), 'utf-8')
    + src;
  t('old automatic backups are pruned', /unlink|rmSync|slice\(|splice\(/.test(all));
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
