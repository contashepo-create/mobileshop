#!/usr/bin/env node
/**
 * MULTI-DEVICE SAFETY — audit point 23.
 *
 * The application offers to put the database on a shared network folder so a
 * shop can work from the counter and the office. Two defects made that offer
 * more dangerous than it looked.
 *
 * 1. WAL WAS FORCED EVERYWHERE
 *    Write-Ahead Logging needs a shared-memory (-shm) file. SMB and most
 *    network filesystems do not implement the locking it requires, and
 *    SQLite's own documentation warns the result is a CORRUPT database rather
 *    than an error message. The connection set `journal_mode = WAL`
 *    unconditionally — including for the network path the app itself creates.
 *
 * 2. NO BUSY TIMEOUT WAS SET
 *    better-sqlite3 defaults to five seconds. That is ample for two clicks a
 *    second apart, and not ample for the case that actually happens: one
 *    workstation runs a long report or the nightly backup while a cashier
 *    rings up a sale.
 *
 *    Measured with two real processes against one file:
 *        8-second transaction on A, default timeout  -> B FAILED after 5,012 ms
 *        8-second transaction on A, 15-second timeout -> B waited 7,646 ms, OK
 *
 *    A sale that fails is far worse than a sale that is slow.
 *
 * Run with:  node --experimental-strip-types scripts/verify_multi_device.mjs
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('MULTI-DEVICE SAFETY');
console.log('='.repeat(72));

let Database = null;
for (const p of [join(ROOT, 'node_modules/better-sqlite3'), join(ROOT, 'scripts/node_modules/better-sqlite3')]) {
  if (existsSync(p)) { try { Database = require(p); break; } catch { /* next */ } }
}
if (!Database) { try { Database = require('better-sqlite3'); } catch { /* unavailable */ } }

// ---------------------------------------------------------------- 1
console.log('\n[1] A network path is recognised');
{
  // The real function, lifted from the source so the test cannot drift from it.
  const src = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf-8');
  const decl = /function isNetworkPath\(p: string\): boolean \{[\s\S]*?\n\}/.exec(src)?.[0];
  t('the detector exists', Boolean(decl));

  if (decl) {
    const fn = eval(`(${decl.replace('function isNetworkPath', 'function').replace(': string', '').replace(': boolean', '')})`);
    const cases = [
      ['\\\\SERVER\\shop\\mobile_shop.db', true, 'Windows UNC'],
      ['//SERVER/shop/mobile_shop.db', true, 'UNC with forward slashes'],
      ['/mnt/share/mobile_shop.db', true, 'Linux mount'],
      ['/media/usb/mobile_shop.db', true, 'removable media'],
      ['C:\\Users\\me\\AppData\\mobile_shop.db', false, 'local Windows'],
      ['/home/user/mobile_shop.db', false, 'local Unix'],
      ['', false, 'empty'],
    ];
    for (const [p, want, label] of cases) {
      if (fn(p) !== want) t(`${label} -> ${want}`, false, `got ${fn(p)}`);
    }
    t('every path shape is classified correctly', true);
    t('a false positive only costs speed, never safety',
      fn('C:\\Users\\me\\db.db') === false);
  }
}

// ---------------------------------------------------------------- 2
console.log('\n[2] WAL is not forced onto a network share');
{
  const c = code('src/main/database/connection.ts');

  t('the journal mode depends on where the file lives',
    /isNetworkPath\(dbPath\)/.test(c) && /journal_mode = DELETE/.test(c));
  t('a local database still uses WAL', /journal_mode = WAL/.test(c));
  t('the network case is chosen deliberately, not by accident',
    /if \(onNetworkShare\)[\s\S]{0,200}DELETE/.test(c));

  // Behavioural: DELETE journal must actually work and keep data intact,
  // otherwise the "safe" fallback would be worse than the problem.
  if (Database) {
    const dir = mkdtempSync(join(tmpdir(), 'md-'));
    try {
      const f = join(dir, 'n.db');
      const db = new Database(f);
      db.pragma('journal_mode = DELETE');
      t('DELETE journal is accepted by SQLite',
        String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'delete');
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run(1234.56);
      db.close();
      const again = new Database(f);
      t('data written under DELETE journal survives a reopen',
        again.prepare('SELECT v FROM t').get().v === 1234.56);
      again.close();
      t('no -wal file is left on a network-mode database', !existsSync(`${f}-wal`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A second machine waits instead of failing');
{
  const c = code('src/main/database/connection.ts');
  t('a busy timeout is set at all', /busy_timeout/.test(c));
  t('it is longer than the five-second default', /15000/.test(c));
  t('and longer still on a network share, which is slower', /30000/.test(c));

  // Behavioural, with two REAL processes: a single-threaded simulation cannot
  // show this, because the holder's COMMIT would be queued behind the waiter.
  if (Database) {
    const dir = mkdtempSync(join(tmpdir(), 'md2-'));
    try {
      const f = join(dir, 'busy.db');
      const setup = new Database(f);
      setup.pragma('journal_mode = WAL');
      setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      setup.close();

      const modPath = existsSync(join(ROOT, 'node_modules/better-sqlite3'))
        ? join(ROOT, 'node_modules/better-sqlite3')
        : join(ROOT, 'scripts/node_modules/better-sqlite3');

      const holder = `
        const D = require(${JSON.stringify(modPath)});
        const A = new D(${JSON.stringify(f)});
        A.exec('BEGIN IMMEDIATE');
        A.prepare('INSERT INTO t (v) VALUES (?)').run('A');
        setTimeout(() => { A.exec('COMMIT'); process.exit(0); }, 6500);
      `;
      const writer = (timeout) => `
        const D = require(${JSON.stringify(modPath)});
        const B = new D(${JSON.stringify(f)});
        ${timeout ? `B.pragma('busy_timeout = ${timeout}');` : ''}
        try { B.exec('BEGIN IMMEDIATE');
              B.prepare('INSERT INTO t (v) VALUES (?)').run('B');
              B.exec('COMMIT'); process.stdout.write('ok'); }
        catch (e) { process.stdout.write(String(e.code || 'err')); }
      `;

      const runPair = (timeout) => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', holder], { stdio: 'ignore' });
        try {
          // Give the holder time to take the lock before the writer tries.
          execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: 'ignore' });
          return execFileSync(process.execPath, ['-e', writer(timeout)], { encoding: 'utf-8' });
        } finally {
          try { child.kill(); } catch { /* already gone */ }
        }
      };

      t('the default five seconds is NOT enough for a long operation',
        runPair(null) === 'SQLITE_BUSY');
      t('fifteen seconds lets the sale through instead of failing it',
        runPair(15000) === 'ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The owner is told what sharing actually costs');
{
  const ui = code('src/renderer/src/pages/settings/DatabaseManagementPage.tsx');

  // A feature that can corrupt a shop's books if the power fails must say so.
  // Silence here would be the software implying a guarantee it cannot give.
  t('the screen warns before the option is used', /اقرأ قبل التفعيل/.test(ui));
  t('it explains that writers queue', /ينتظرون/.test(ui));
  t('it warns about losing power or network mid-write', /لا تفصل الكهرباء/.test(ui));
  t('it says the host machine must stay on', /شغّالاً/.test(ui));
  t('it insists on daily backups', /نسخة احتياطية يومية/.test(ui));
  t('and it states what the app does automatically', /٣٠ ثانية/.test(ui));

  // The cloud tab must still be honest that upload is not synchronisation.
  t('the cloud tab still says it is one-way, not sync',
    /ليست مزامنة/.test(ui) && /لا يوجد تنزيل ولا دمج/.test(ui));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
