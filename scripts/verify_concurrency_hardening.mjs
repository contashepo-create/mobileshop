#!/usr/bin/env node
/**
 * TWO TILLS, ONE DATABASE — AND THE WINDOW THAT CANNOT BE NAVIGATED AWAY.
 *
 * WHAT WAS WRONG (1): EVERY TRANSACTION WAS DEFERRED
 * ---------------------------------------------------
 * `better-sqlite3`'s `db.transaction()` opens a DEFERRED transaction: the
 * write lock is taken at the first WRITE, not at `BEGIN`. Every financial
 * handler in this program does read-modify-write — check the stock, resolve a
 * cost, then insert — so between the read and the write another till is free
 * to commit.
 *
 * `sales.handlers.ts` even carries the comment "RE-CHECK STOCK, NOW THAT THE
 * WRITE LOCK IS HELD". It was not held.
 *
 * Under WAL this does not corrupt the total — SQLite refuses the commit with
 * `SQLITE_BUSY_SNAPSHOT`. But that error is NOT waitable: `busy_timeout` does
 * nothing for it, because there is no lock to wait for, the reader's snapshot
 * is simply stale. So the carefully chosen 15-second timeout never applied.
 *
 * MEASURED before the fix, two OS processes on one database file, 40
 * read-modify-writes each with a 5 ms gap:
 *
 *     worker A: 4 succeeded, 36 failed SQLITE_BUSY_SNAPSHOT
 *     final counter 44 of an expected 80
 *
 * Nearly half of one till's sales refused, with the cashier shown only
 * "تعذّر تنفيذ العملية".
 *
 * WHAT WAS WRONG (2): THE WINDOW COULD BE NAVIGATED AWAY
 * -------------------------------------------------------
 * Nothing stopped the renderer from navigating to a remote page. Anything able
 * to set `location.href` would replace the app with an attacker's document
 * that is STILL inside Electron and still has `window.api` in front of it —
 * every IPC channel the logged-in user may call, callable by the page.
 *
 * WHAT IS PROVEN HERE
 *   [1] the wrapper is installed on the real connection
 *   [2] two real processes lose nothing and are refused nothing
 *   [3] a genuine error is NOT retried and NOT swallowed
 *   [4] rollback still works — a throw undoes the whole transaction
 *   [5] the window refuses foreign navigation but still prints
 *
 * Run:  node --experimental-strip-types scripts/verify_concurrency_hardening.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('CONCURRENCY & WINDOW HARDENING');
console.log('='.repeat(72));

/** Where better-sqlite3 actually lives, so a child process can require it. */
function sqliteHome() {
  for (const base of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { readFileSync(join(base, 'better-sqlite3', 'package.json')); return base; }
    catch { /* keep looking */ }
  }
  return null;
}
const SQLITE_BASE = sqliteHome();
const PROBE = join(ROOT, 'node_modules', '.conc-probe');

// ------------------------------------------------------------------ 1
console.log('\n[1] The hardening is installed on the real connection');
{
  const src = raw('src/main/database/connection.ts');
  t('hardenTransactions exists', /function hardenTransactions\(/.test(src));
  t('and getDb() actually calls it', /hardenTransactions\(db\);/.test(src));
  // Installed BEFORE anything can use the connection, or the first caller of
  // the session gets the unpatched version.
  const callIdx = src.indexOf('hardenTransactions(db);');
  const returnIdx = src.indexOf('return db;');
  t('it is installed before the connection is handed out',
    callIdx > 0 && callIdx < returnIdx);
  t('transactions run as IMMEDIATE', /wrapped\.immediate\(/.test(src));
  t('only the two waitable errors are retried',
    /SQLITE_BUSY_SNAPSHOT/.test(src) && /code !== 'SQLITE_BUSY'/.test(src));
  t('anything else is rethrown at once', /throw err;/.test(src));
}

// ------------------------------------------------------------------ 2
console.log('\n[2] Two real processes: nothing lost, nothing refused');
if (!SQLITE_BASE) {
  console.log('  SKIP  better-sqlite3 is not installed in this checkout');
} else {
  const { build } = await import('esbuild');
  // Compile the REAL connection.ts. Nothing about the wrapper is re-typed.
  const expose = { name: 'expose', setup(b) {
    b.onLoad({ filter: /connection\.ts$/ }, (a) => ({
      contents: readFileSync(a.path, 'utf-8') + '\nexport { hardenTransactions };\n',
      loader: 'ts',
    }));
  } };
  const stub = { name: 'stub', setup(b) {
    b.onResolve({ filter: /^electron$/ }, (a) => ({ path: a.path, namespace: 'st' }));
    b.onLoad({ filter: /.*/, namespace: 'st' }, () => ({
      contents: `module.exports = { app: { getPath: () => '/tmp' } };`, loader: 'js',
    }));
  } };
  const out = await build({
    stdin: {
      contents: `export { hardenTransactions } from './src/main/database/connection.ts';`,
      resolveDir: ROOT, sourcefile: 'c.ts', loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [expose, stub], external: ['better-sqlite3'], logLevel: 'silent',
  });

  // The bundle must sit where `require('better-sqlite3')` resolves.
  const probeDir = join(SQLITE_BASE, '..', '.conc-probe-tmp');
  mkdirSync(probeDir, { recursive: true });
  const hardenFile = join(probeDir, 'harden.cjs');
  writeFileSync(hardenFile, out.outputFiles[0].text);

  const DB = join(probeDir, 'race.db');
  for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
  const req = `const Database = require(${JSON.stringify(join(SQLITE_BASE, 'better-sqlite3'))});`;

  writeFileSync(join(probeDir, 'setup.cjs'), `${req}
    const db = new Database(${JSON.stringify(DB)});
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
    db.prepare('INSERT INTO t VALUES (1,0)').run();`);
  execFileSync(process.execPath, [join(probeDir, 'setup.cjs')]);

  const ROUNDS = 40;
  const worker = (harden) => `${req}
    const db = new Database(${JSON.stringify(DB)});
    db.pragma('busy_timeout = 15000');
    ${harden ? `require(${JSON.stringify(hardenFile)}).hardenTransactions(db);` : ''}
    const read = db.prepare('SELECT n FROM t WHERE id=1');
    const write = db.prepare('UPDATE t SET n=? WHERE id=1');
    const spin = (ms) => { const e = Date.now() + ms; while (Date.now() < e); };
    let ok = 0, err = 0; const codes = new Set();
    for (let i = 0; i < ${ROUNDS}; i++) {
      try {
        // Exactly the shape every financial handler uses: read, think, write.
        db.transaction(() => { const c = read.get().n; spin(5); write.run(c + 1); })();
        ok++;
      } catch (e) { err++; codes.add(e.code || String(e.message).slice(0, 40)); }
    }
    console.log(JSON.stringify({ ok, err, codes: [...codes] }));`;

  const runPair = (harden) => {
    const f = join(probeDir, harden ? 'wh.cjs' : 'wd.cjs');
    writeFileSync(f, worker(harden));
    return Promise.all([0, 1].map(() => new Promise((res) => {
      execFile(process.execPath, [f], (_e, so, se) => res(((so || '') + (se || '')).trim()));
    })));
  };
  const finalN = () => {
    const f = join(probeDir, 'check.cjs');
    writeFileSync(f, `${req}
      const db = new Database(${JSON.stringify(DB)});
      console.log(db.prepare('SELECT n FROM t WHERE id=1').get().n);`);
    return Number(execFileSync(process.execPath, [f]).toString().trim());
  };

  const hardened = await runPair(true);
  const n = finalN();
  const parsed = hardened.map((s) => { try { return JSON.parse(s); } catch { return { ok: 0, err: -1 }; } });
  const totalErr = parsed.reduce((a, b) => a + b.err, 0);

  t('no operation is refused', totalErr === 0,
    hardened.join(' | '));
  t('no update is lost — the counter is exact', n === ROUNDS * 2,
    `final ${n}, expected ${ROUNDS * 2}`);

  // And prove the defect was REAL: the same race without the wrapper.
  for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
  execFileSync(process.execPath, [join(probeDir, 'setup.cjs')]);
  const bare = await runPair(false);
  const bareN = finalN();
  const bareErr = bare.map((s) => { try { return JSON.parse(s).err; } catch { return 0; } })
    .reduce((a, b) => a + b, 0);
  t('the unpatched behaviour really does fail (the bug was not imagined)',
    bareErr > 0 || bareN < ROUNDS * 2,
    `errors ${bareErr}, final ${bareN} of ${ROUNDS * 2}`);

  // ---------------------------------------------------------------- 3 & 4
  console.log('\n[3] A genuine error is neither retried nor swallowed');
  {
    const f = join(probeDir, 'err.cjs');
    writeFileSync(f, `${req}
      const db = new Database(':memory:');
      require(${JSON.stringify(hardenFile)}).hardenTransactions(db);
      db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER UNIQUE)');
      db.prepare('INSERT INTO u VALUES (1,1)').run();
      let calls = 0, code = '', threw = false;
      try {
        db.transaction(() => { calls++; db.prepare('INSERT INTO u VALUES (2,1)').run(); })();
      } catch (e) { threw = true; code = e.code || ''; }
      // Rollback: a throw halfway must undo everything before it.
      let rolledBack = false;
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO u VALUES (9,9)').run();
          throw new Error('halfway');
        })();
      } catch {}
      rolledBack = !db.prepare('SELECT 1 FROM u WHERE id=9').get();
      console.log(JSON.stringify({ calls, threw, code, rolledBack }));`);
    const r = JSON.parse(execFileSync(process.execPath, [f]).toString().trim());
    t('a constraint violation is raised, not hidden', r.threw && /CONSTRAINT/.test(r.code), r.code);
    t('and it is attempted exactly once, never retried', r.calls === 1, `${r.calls} attempts`);

    console.log('\n[4] Rollback still works');
    t('a throw halfway undoes the whole transaction', r.rolledBack);

    // The exhaustion path: every attempt refused. Reached by holding the write
    // lock from a second connection with busy_timeout at 0, so BEGIN IMMEDIATE
    // fails instantly and the retry loop runs to the end.
    //
    // Without this, "retry five times" and "try once" are indistinguishable,
    // and so are "give up by throwing" and "give up by returning undefined" —
    // and the second of those is the dangerous one: the handler would carry on
    // as though the write had happened and report success for a sale that was
    // never recorded.
    console.log('\n[4b] When every attempt is refused');
    const bf = join(probeDir, 'busy.cjs');
    const BDB = join(probeDir, 'busy.db');
    for (const s of ['', '-wal', '-shm']) { try { rmSync(BDB + s); } catch {} }
    writeFileSync(bf, `${req}
      const setup = new Database(${JSON.stringify(BDB)});
      setup.pragma('journal_mode = WAL');
      setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
      setup.prepare('INSERT INTO t VALUES (1,0)').run();
      const blocker = new Database(${JSON.stringify(BDB)});
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('UPDATE t SET n=99 WHERE id=1').run();

      const db = new Database(${JSON.stringify(BDB)});
      db.pragma('busy_timeout = 0');
      require(${JSON.stringify(hardenFile)}).hardenTransactions(db);
      const t0 = Date.now();
      let threw = false, code = '', ret = 'NO-RETURN';
      try { ret = db.transaction(() => {})(); }
      catch (e) { threw = true; code = e.code || String(e.message); }
      console.log(JSON.stringify({ ms: Date.now() - t0, threw, code, ret: String(ret) }));
      blocker.exec('ROLLBACK');`);
    const b = JSON.parse(execFileSync(process.execPath, [bf]).toString().trim());
    // 5 attempts pause 20+40+60+80 = 200 ms between them. One attempt is
    // immediate. 150 ms separates the two beyond any timing noise.
    t('it really does retry rather than give up at once', b.ms >= 150,
      `gave up after ${b.ms} ms`);
    t('and when it finally gives up it THROWS, never returns quietly',
      b.threw === true && b.ret === 'NO-RETURN', JSON.stringify(b));
    t('the error it throws is the real one', /BUSY/.test(b.code), b.code);

    // Wrapping twice would nest a retry loop inside a retry loop: 5 attempts
    // become 25 and the pauses multiply, so a contended write freezes the main
    // process for seconds. Guarded, because a second caller is an easy mistake.
    console.log('\n[4c] Wrapping cannot stack');
    const df = join(probeDir, 'double.cjs');
    const DDB = join(probeDir, 'double.db');
    for (const s of ['', '-wal', '-shm']) { try { rmSync(DDB + s); } catch {} }
    writeFileSync(df, `${req}
      const { hardenTransactions } = require(${JSON.stringify(hardenFile)});
      const setup = new Database(${JSON.stringify(DDB)});
      setup.pragma('journal_mode = WAL');
      setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
      setup.prepare('INSERT INTO t VALUES (1,0)').run();
      const blocker = new Database(${JSON.stringify(DDB)});
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('UPDATE t SET n=99 WHERE id=1').run();

      const db = new Database(${JSON.stringify(DDB)});
      db.pragma('busy_timeout = 0');
      hardenTransactions(db);
      hardenTransactions(db);   // second call must be a no-op
      hardenTransactions(db);
      const t0 = Date.now();
      try { db.transaction(() => {})(); } catch {}
      console.log(JSON.stringify({ ms: Date.now() - t0 }));
      blocker.exec('ROLLBACK');`);
    const d = JSON.parse(execFileSync(process.execPath, [df]).toString().trim());
    // One loop tops out near 200 ms of pauses. Nested loops multiply well past
    // 1000 ms; 600 ms is a wide margin that timing noise cannot cross.
    t('three calls behave like one — the retry loop does not nest',
      d.ms < 600, `${d.ms} ms (a nested loop would be far longer)`);
  }

  try { rmSync(probeDir, { recursive: true, force: true }); } catch {}
}
try { rmSync(PROBE, { recursive: true, force: true }); } catch {}

// ------------------------------------------------------------------ 5
console.log('\n[5] The window cannot be navigated away — but printing still works');
{
  const idx = raw('src/main/index.ts');

  t('foreign navigation is refused', /will-navigate/.test(idx) && /event\.preventDefault\(\)/.test(idx));
  t('a window-open handler exists', /setWindowOpenHandler/.test(idx));

  // The print screens open a BLANK popup and write the receipt into it.
  // Denying every popup would silently stop every invoice from printing, so
  // this is the check that the fix did not break the shop.
  t('a blank popup is allowed, so receipts still print',
    /url === 'about:blank' \|\| url === ''/.test(idx) && /action: 'allow'/.test(idx));
  t('a remote URL is denied', /action: 'deny'/.test(idx));
  t('and a real link goes to the system browser, not into the app',
    /shell\.openExternal/.test(idx));
  t('device permissions are refused', /setPermissionRequestHandler/.test(idx)
    && /callback\(false\)/.test(idx));
  t('a webview cannot bring its own preload', /will-attach-webview/.test(idx)
    && /delete webPreferences\.preload/.test(idx));

  // The renderer really does rely on blank popups — if this stops being true
  // the allowance above should be revisited rather than left as dead code.
  const printers = ['src/renderer/src/pages/reports/CustomerStatementPage.tsx',
    'src/renderer/src/pages/assets/AssetsPage.tsx'];
  t('the print screens do open blank popups (the allowance is needed)',
    printers.every((p) => /window\.open\(''/.test(raw(p))));

  // The bridge must stay minimal: exposing ipcRenderer itself would make the
  // navigation guard pointless.
  const pre = raw('src/preload/preload.ts');
  t('the preload does not expose ipcRenderer wholesale',
    !/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(pre));
  t('context isolation is on and node integration is off',
    /contextIsolation: true/.test(idx) && /nodeIntegration: false/.test(idx));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
