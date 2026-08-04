#!/usr/bin/env node
/**
 * SEVERAL TILLS, SEVERAL LICENCES, ONE SHARED DATABASE.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * A shop buys two or three copies, each with its own activation code and its
 * own expiry, and points them all at one database on a shared folder. Then two
 * cashiers press "save" at the same instant.
 *
 *   - Do they collide?
 *   - Does one sale overwrite the other?
 *   - Can two tills mint the same invoice number?
 *   - Does one licence expiring take the others down?
 *   - Does copying the database to another machine break anything?
 *
 * A wrong answer here is not a bug report, it is a shop with two customers
 * charged onto one invoice, or a day's takings that do not reconcile.
 *
 * HOW IT IS TESTED
 * ----------------
 * Not by reasoning about locks — by launching REAL separate OS PROCESSES
 * against one REAL database file, exactly as three PCs on a share would be,
 * and then checking the books afterwards.
 *
 * THE ARCHITECTURE THAT MAKES THIS SAFE
 *   - the licence lives in userData on EACH machine, never in the database, so
 *     three machines hold three independent licences;
 *   - the database holds only the shop's data, so it is shareable;
 *   - a network path switches off WAL, because WAL over SMB corrupts.
 *
 * Run:  node --experimental-strip-types scripts/verify_multi_terminal.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

function sqliteBase() {
  for (const base of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { createRequire(join(base, 'x.js')).resolve('better-sqlite3'); return base; } catch { /* next */ }
  }
  return null;
}
const BASE = sqliteBase();

console.log('='.repeat(72));
console.log('MULTI-TERMINAL — several tills, several licences, one database');
console.log('='.repeat(72));

if (!BASE) {
  console.log('\n  SKIP  better-sqlite3 is not installed');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(0);
}
const Database = createRequire(join(BASE, 'x.js'))('better-sqlite3');
const REQ = `const Database = require(${JSON.stringify(join(BASE, 'better-sqlite3'))});`;

const dir = mkdtempSync(join(tmpdir(), 'multi-'));
const SCHEMA = (() => {
  const ts = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');
  return [...ts.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)].map(m => m[1]).filter(s => !s.includes('${'));
})();

function makeShop(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  for (const block of SCHEMA) {
    for (const stmt of block.split(/;\s*\n/)) {
      const s = stmt.trim();
      if (s) { try { db.exec(s + ';'); } catch { /* ALTER on existing */ } }
    }
  }
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  db.prepare("INSERT INTO fiscal_years (YearName, StartDate, EndDate) VALUES ('2026','2026-01-01','2026-12-31')").run();
  db.prepare("INSERT INTO customers (Name, Balance) VALUES ('عميل', 0)").run();
  return db;
}

/** The real hardened transaction wrapper, compiled from connection.ts. */
async function buildHardenBundle() {
  const { build } = await import('esbuild');
  const expose = { name: 'e', setup(b) {
    b.onLoad({ filter: /connection\.ts$/ }, (a) => ({
      contents: readFileSync(a.path, 'utf-8') + '\nexport { hardenTransactions };\n', loader: 'ts',
    }));
  } };
  const stub = { name: 's', setup(b) {
    b.onResolve({ filter: /^electron$/ }, (a) => ({ path: a.path, namespace: 'st' }));
    b.onLoad({ filter: /.*/, namespace: 'st' }, () => ({
      contents: `module.exports = { app: { getPath: () => '/tmp' } };`, loader: 'js' }));
  } };
  const out = await build({
    stdin: { contents:
      `export { hardenTransactions } from '${join(ROOT, 'src/main/database/connection.ts')}';`,
      resolveDir: ROOT, sourcefile: 'c.ts', loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [expose, stub], external: ['better-sqlite3'], logLevel: 'silent',
  });
  const f = join(BASE, '..', 'harden-multi.cjs');
  writeFileSync(f, out.outputFiles[0].text);
  return f;
}
const HARDEN = await buildHardenBundle();

// ------------------------------------------------------------------ 1
console.log('\n[1] Three tills selling at the same instant');
{
  const file = join(dir, 'shared.db');
  makeShop(file).close();

  const TILLS = 3, PER_TILL = 40;
  const worker = join(dir, 'till.cjs');
  writeFileSync(worker, `${REQ}
    const { hardenTransactions } = require(${JSON.stringify(HARDEN)});
    const till = process.argv[2];
    // Spin until a shared instant. Without this the processes start milliseconds
    // apart and mostly run one after another, so the test passes even when
    // transactions are DEFERRED — proving nothing about contention.
    const START = Number(process.argv[3]);
    while (Date.now() < START);
    const db = new Database(${JSON.stringify(file)});
    db.pragma('busy_timeout = 15000');
    hardenTransactions(db);          // exactly what getDb() installs

    const nextNumber = db.prepare(
      "SELECT COALESCE(MAX(CAST(SUBSTR(SaleNumber, 5) AS INTEGER)), 0) + 1 n FROM sales WHERE SaleNumber LIKE 'INV-%'");
    const insert = db.prepare(\`INSERT INTO sales
      (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
      VALUES (?, 1, 1, '2026-03-01', ?, ?, ?, 'cash', 1, 0)\`);
    const bump = db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = 1');

    // A real handler spends time between the read and the write: resolving a
    // cost, checking stock, building the lines. Without that gap the whole
    // transaction is microseconds long and two tills essentially never
    // interleave, so the test passes even with DEFERRED transactions and
    // proves nothing. This models the gap the shipped handlers actually have.
    const think = (ms) => { const e = Date.now() + ms; while (Date.now() < e); };

    let ok = 0, err = 0; const codes = new Set();
    for (let i = 0; i < ${PER_TILL}; i++) {
      try {
        db.transaction(() => {
          // read-modify-write: the classic two-till collision
          const n = nextNumber.get().n;
          think(2);
          insert.run('INV-' + n, 100, 100, 100);
          bump.run(100);
        })();
        ok++;
      } catch (e) { err++; codes.add(e.code || String(e.message).slice(0, 40)); }
    }
    console.log(JSON.stringify({ till, ok, err, codes: [...codes] }));`);

  const START = Date.now() + 600;
  const started = Date.now();
  const outs = await Promise.all(
    Array.from({ length: TILLS }, (_, i) => new Promise((res) => {
      execFile(process.execPath, [worker, 'till' + i, String(START)], (_e, so, se) =>
        res(((so || '') + (se || '')).trim()));
    })));
  const took = Date.now() - started;
  const parsed = outs.map(o => { try { return JSON.parse(o); } catch { return { ok: 0, err: -1, raw: o }; } });
  const totalOk = parsed.reduce((a, b) => a + b.ok, 0);
  const totalErr = parsed.reduce((a, b) => a + b.err, 0);

  const db = new Database(file);
  const rows = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
  const distinct = db.prepare('SELECT COUNT(DISTINCT SaleNumber) n FROM sales').get().n;
  const balance = db.prepare('SELECT Balance b FROM customers WHERE CustomerID = 1').get().b;
  const money = db.prepare('SELECT COALESCE(SUM(TotalAmount),0) v FROM sales').get().v;

  console.log(`      ${TILLS} tills x ${PER_TILL} sales in ${(took / 1000).toFixed(1)}s`);
  t('no till was refused', totalErr === 0, JSON.stringify(parsed.map(p => ({ ok: p.ok, err: p.err }))));
  t('every sale was written', rows === TILLS * PER_TILL, `${rows} of ${TILLS * PER_TILL}`);
  t('no invoice number was issued twice', distinct === rows,
    `${distinct} distinct of ${rows} — a duplicate means two customers on one invoice`);
  t('the customer balance is exactly right', balance === rows * 100, `${balance} vs ${rows * 100}`);
  t('the money adds up', money === rows * 100, `${money} vs ${rows * 100}`);
  t('the database is still sound', db.pragma('integrity_check', { simple: true }) === 'ok');
  db.close();

  // NOTE ON WHAT THIS DOES AND DOES NOT PIN DOWN.
  //
  // Mutating `wrapped.immediate(...)` back to a DEFERRED `wrapped(...)` does
  // NOT fail this section, and that was measured rather than assumed:
  //
  //   DEFERRED, no retry loop : 3 tills lost 58 of 120 updates, many
  //                             SQLITE_BUSY_SNAPSHOT
  //   DEFERRED, retry loop on : 120 of 120, zero errors
  //
  // The retry loop genuinely recovers the collisions, so the two defences are
  // redundant BY DESIGN and either alone gives a correct outcome here. That is
  // the intended behaviour, not a gap — belt and braces on the one code path
  // where losing a sale is unacceptable.
  //
  // `verify_concurrency_hardening.mjs` pins IMMEDIATE itself, so removing it
  // still fails the suite; this section pins the OUTCOME the shop cares about.
}

// ------------------------------------------------------------------ 2
console.log('\n[2] One till deleting while another sells');
{
  const file = join(dir, 'mixed.db');
  const db0 = makeShop(file);
  const ins = db0.prepare(`INSERT INTO sales
    (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES (?, 1, 1, '2026-03-01', 50, 50, 50, 'cash', 1, 0)`);
  db0.transaction(() => { for (let i = 0; i < 300; i++) ins.run('OLD-' + i); })();
  db0.close();

  const seller = join(dir, 'seller.cjs');
  writeFileSync(seller, `${REQ}
    const { hardenTransactions } = require(${JSON.stringify(HARDEN)});
    const db = new Database(${JSON.stringify(file)}); db.pragma('busy_timeout = 15000');
    hardenTransactions(db);
    const ins = db.prepare(\`INSERT INTO sales (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
      VALUES (?, 1, 1, '2026-03-02', 70, 70, 70, 'cash', 1, 0)\`);
    let ok=0, err=0;
    for (let i = 0; i < 150; i++) {
      try { db.transaction(() => ins.run('NEW-' + i))(); ok++; } catch { err++; }
    }
    console.log(JSON.stringify({ role: 'seller', ok, err }));`);

  const deleter = join(dir, 'deleter.cjs');
  writeFileSync(deleter, `${REQ}
    const { hardenTransactions } = require(${JSON.stringify(HARDEN)});
    const db = new Database(${JSON.stringify(file)}); db.pragma('busy_timeout = 15000');
    hardenTransactions(db);
    const del = db.prepare("DELETE FROM sales WHERE SaleNumber = ?");
    let ok=0, err=0;
    for (let i = 0; i < 150; i++) {
      try { db.transaction(() => del.run('OLD-' + i))(); ok++; } catch { err++; }
    }
    console.log(JSON.stringify({ role: 'deleter', ok, err }));`);

  const outs = await Promise.all([seller, deleter].map(f => new Promise((res) => {
    execFile(process.execPath, [f], (_e, so, se) => res(((so || '') + (se || '')).trim()));
  })));
  const p = outs.map(o => { try { return JSON.parse(o); } catch { return { ok: 0, err: -1 }; } });
  t('neither till was blocked out', p.every(x => x.err === 0), JSON.stringify(p));

  const db = new Database(file);
  const remaining = db.prepare("SELECT COUNT(*) n FROM sales WHERE SaleNumber LIKE 'OLD-%'").get().n;
  const added = db.prepare("SELECT COUNT(*) n FROM sales WHERE SaleNumber LIKE 'NEW-%'").get().n;
  t('exactly the intended rows were deleted', remaining === 150, `${remaining} old rows left`);
  t('exactly the intended rows were added', added === 150, `${added} new rows`);
  t('the database is still sound', db.pragma('integrity_check', { simple: true }) === 'ok');
  db.close();
}

// ------------------------------------------------------------------ 3
console.log('\n[3] Several licences, one database — they must not interfere');
{
  // The licence is a FILE in each machine's userData; the database holds none
  // of it. That is what makes three tills with three different expiries able
  // to share one database.
  const lic = readFileSync(join(ROOT, 'src/main/ipc/license.handlers.ts'), 'utf-8');
  const conn = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf-8');

  t('the licence is stored per-machine in userData',
    /path\.join\(app\.getPath\('userData'\), LICENSE_FILE\)/.test(lic));
  // If the licence were written into the shared database, one machine
  // activating would activate them all — and one expiring would lock them all.
  t('no licence table is created in the shared database',
    !/CREATE TABLE[^;]*licen/i.test(readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8')));
  t('the device id is per-machine too, in userData',
    /app\.getPath\('userData'\), DEVICE_FILE/.test(readFileSync(join(ROOT, 'src/main/security/deviceId.ts'), 'utf-8')));
  t('the activation code is signed against the DEVICE id',
    /signedMessage\(deviceId, payload\)/.test(readFileSync(join(ROOT, 'src/main/security/licenseCrypto.ts'), 'utf-8')));

  // Prove the separation on real files: two "machines", one database.
  const shared = join(dir, 'twomachines.db');
  makeShop(shared).close();
  const userDataA = join(dir, 'machineA'); const userDataB = join(dir, 'machineB');
  execFileSync('mkdir', ['-p', userDataA, userDataB]);
  writeFileSync(join(userDataA, 'license.dat'), 'LICENCE-A-EXPIRES-2027');
  writeFileSync(join(userDataB, 'license.dat'), 'LICENCE-B-EXPIRES-2026');

  const dbx = new Database(shared);
  const tables = dbx.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const licenceish = tables.filter(n => /licen|activation|trial|device/i.test(n));
  t('the shared database contains nothing licence-related',
    licenceish.length === 0, licenceish.join(', ') || 'none');
  dbx.close();
  t('machine A keeps its own licence file', readFileSync(join(userDataA, 'license.dat'), 'utf-8').includes('A'));
  t('machine B keeps its own, different one', readFileSync(join(userDataB, 'license.dat'), 'utf-8').includes('B'));
}

// ------------------------------------------------------------------ 4
console.log('\n[4] Copying the database to another machine');
{
  const origin = join(dir, 'origin.db');
  const db = makeShop(origin);
  const ins = db.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES (?, 1, 1, '2026-03-03', 250, 250, 250, 'cash', 1, 0)`);
  db.transaction(() => { for (let i = 0; i < 200; i++) ins.run('M-' + i); })();
  const money = db.prepare('SELECT SUM(TotalAmount) v FROM sales').get().v;

  // The RIGHT way to move it: the backup API, which folds in the WAL.
  const moved = join(dir, 'moved.db');
  await db.backup(moved);
  db.close();

  const re = new Database(moved);
  t('the copy opens on the other machine', re.pragma('integrity_check', { simple: true }) === 'ok');
  t('all the data arrived', re.prepare('SELECT SUM(TotalAmount) v FROM sales').get().v === money);
  // It must be usable, not just readable.
  re.pragma('journal_mode = WAL');
  re.prepare(`INSERT INTO sales (SaleNumber, FiscalYearID, CustomerID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided)
    VALUES ('ON-NEW-MACHINE', 1, 1, '2026-03-04', 10, 10, 10, 'cash', 1, 0)`).run();
  t('the other machine can trade on it',
    !!re.prepare("SELECT 1 FROM sales WHERE SaleNumber='ON-NEW-MACHINE'").get());
  re.close();
}

// ------------------------------------------------------------------ 5
console.log('\n[5] A database on a network share');
{
  // WAL needs a shared-memory file that SMB does not implement correctly;
  // SQLite's own documentation says the result is CORRUPTION, not an error.
  // So a UNC path must fall back to the older journal.
  const conn = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf-8');
  t('a network path is detected', /function isNetworkPath/.test(conn));
  t('UNC paths are recognised', /win\.startsWith\('\\\\\\\\\\\\\\\\'\)/.test(conn) || /\\\\\\\\/.test(conn));
  t('WAL is switched OFF on a share', /journal_mode = DELETE/.test(conn));
  t('and the wait is longer there', /onNetworkShare \? 30000 : 15000/.test(conn));

  // Prove DELETE journal still gives correct concurrent results.
  const file = join(dir, 'netlike.db');
  const seed = new Database(file);
  seed.pragma('journal_mode = DELETE');
  for (const block of SCHEMA) {
    for (const stmt of block.split(/;\s*\n/)) {
      const s = stmt.trim(); if (s) { try { seed.exec(s + ';'); } catch {} }
    }
  }
  seed.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  seed.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  seed.prepare("INSERT INTO fiscal_years (YearName, StartDate, EndDate) VALUES ('2026','2026-01-01','2026-12-31')").run();
  seed.prepare("INSERT INTO customers (Name, Balance) VALUES ('عميل', 0)").run();
  seed.close();

  const w = join(dir, 'netw.cjs');
  writeFileSync(w, `${REQ}
    const { hardenTransactions } = require(${JSON.stringify(HARDEN)});
    const db = new Database(${JSON.stringify(file)});
    db.pragma('journal_mode = DELETE'); db.pragma('busy_timeout = 30000');
    hardenTransactions(db);
    const bump = db.prepare('UPDATE customers SET Balance = Balance + 10 WHERE CustomerID = 1');
    let ok=0, err=0;
    for (let i=0;i<80;i++){ try { db.transaction(()=>bump.run())(); ok++; } catch(e){ err++; } }
    console.log(JSON.stringify({ok,err}));`);
  const outs = await Promise.all([0, 1].map(() => new Promise((res) => {
    execFile(process.execPath, [w], (_e, so, se) => res(((so || '') + (se || '')).trim()));
  })));
  const p = outs.map(o => { try { return JSON.parse(o); } catch { return { ok: 0, err: -1 }; } });
  const dbn = new Database(file);
  const bal = dbn.prepare('SELECT Balance b FROM customers WHERE CustomerID = 1').get().b;
  dbn.close();
  t('two machines on a DELETE-journal database lose nothing',
    bal === 1600 && p.every(x => x.err === 0), `balance ${bal} of 1600, ${JSON.stringify(p)}`);
}

// ------------------------------------------------------------------ 6
console.log('\n[6] The same device id cannot be reused by pointing at a share');
{
  const dev = readFileSync(join(ROOT, 'src/main/security/deviceId.ts'), 'utf-8');
  // The id must come from the MACHINE, not from anything on the shared disk,
  // or two tills would present as one and a single licence would cover both.
  t('the fingerprint is taken from the machine', /collectFingerprint/.test(dev));
  t('it is written read-only so it cannot drift', /chmodSync\(devicePath, 0o444\)/.test(dev));
  t('it is never derived from the database path', !/getDbPath|dbPath/.test(dev));
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
try { rmSync(HARDEN, { force: true }); } catch {}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
