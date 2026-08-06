#!/usr/bin/env node
/**
 * A RESTORE MUST NOT DESTROY GOOD BOOKS WITH A BAD BACKUP.
 *
 * WHAT WAS MEASURED
 * -----------------
 * `backup:restore` checked the first sixteen bytes of the chosen file for the
 * string "SQLite format 3" and then copied it over the live database.
 *
 * Those sixteen bytes say nothing about the rest of the file. Driving real
 * SQLite: a 143 KB database whose leaf pages were overwritten with 0xAA still
 * began with "SQLite format 3", passed that check, and then failed on first
 * use with `SQLITE_CORRUPT: database disk image is malformed`.
 *
 * By then the restore has already overwritten the live database. The shop has
 * traded the books it had for a file that cannot be opened, and the only copy
 * of the original is a `.before-restore` file that nothing in the interface
 * offers to put back.
 *
 * A restore is the operation a shop reaches for when something has ALREADY
 * gone wrong. It is the one place in the program where being conservative
 * costs a second and being optimistic costs the year.
 *
 * WHAT IS CHECKED
 * ---------------
 * Both directions, because a guard that refuses a legitimate restore is worse
 * than the hole it closes — the owner is standing there with a good backup and
 * an empty till. Measured against real files:
 *
 *   a good backup            accepted
 *   corrupt pages            refused, live database untouched
 *   a valid but ALIEN sqlite refused (it would restore to an empty program)
 *   not a database at all    refused
 *   a missing file           refused
 *   the candidate file       unchanged by having been checked
 *
 * Run:  node --experimental-strip-types scripts/verify_restore_safety.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

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

/**
 * Index of the `{` that opens a function BODY, from `from` onward.
 *
 * Written as `indexOf('{\n', from)`, which demanded a Unix line ending. On a
 * Windows checkout the source holds `{\r\n`, the search returned -1, and the
 * extraction that followed produced an EMPTY string — the generated module
 * then contained only its export line and threw
 * `ReferenceError: <fn> is not defined`. Measured on the owner's machine.
 *
 * A brace is a brace; the newline convention after it is not part of the
 * question being asked.
 */
function braceAfter(src, from) {
  const rel = src.slice(from).search(/\{\r?\n/);
  return rel < 0 ? -1 : from + rel;
}


let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

// ---------------------------------------------------------------- extract
/**
 * Compiles `verifyDatabaseFile` out of the shipped handler and returns it.
 *
 * Extracted rather than imported: backup.handlers.ts imports `electron`, which
 * does not exist in this process. The temp directory is created INSIDE the
 * repository so that `import('better-sqlite3')` inside the extracted function
 * resolves against the project's node_modules — from /tmp it does not, and the
 * whole suite would silently report "could not verify".
 */
const src = readFileSync(join(ROOT, 'src/main/ipc/backup.handlers.ts'), 'utf8');
const at = src.indexOf('async function verifyDatabaseFile');
ok('the restore guard exists in backup.handlers.ts', at >= 0);
if (at < 0) {
  console.log('FAILED — the guard could not be located; nothing below was verified');
  process.exit(1);
}
const paren = src.indexOf(')', at);
const open = braceAfter(src, paren);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}

const dir = mkdtempSync(join(ROOT, '.restore-check-'));
try {
  const modFile = join(dir, 'probe.ts');
  writeFileSync(modFile, src.slice(at, end) + '\nexport default verifyDatabaseFile;\n', 'utf8');
  const verify = (await import(pathToFileURL(modFile).href)).default;
  ok('the restore guard could be compiled and executed', typeof verify === 'function');

  /** Builds a file that looks like this application's database. */
  const makeShopDb = (p, rows = 3000) => {
    const db = new Database(p);
    db.exec('CREATE TABLE sales(a); CREATE TABLE purchases(a); CREATE TABLE customers(a); CREATE TABLE items(a)');
    const ins = db.prepare('INSERT INTO sales VALUES (?)');
    for (let i = 0; i < rows; i++) ins.run('x'.repeat(60));
    db.close();
  };

  // =========================================================================
  console.log('\n── 1. a GOOD backup is accepted ──');
  // =========================================================================
  {
    const good = join(dir, 'good.db');
    makeShopDb(good);
    const r = await verify(good);
    ok('a healthy backup of this application is accepted', r.ok === true,
      JSON.stringify(r) + '  — the owner would be refused their own restore');

    // A small one too: a brand-new shop has almost no rows.
    const tiny = join(dir, 'tiny.db');
    makeShopDb(tiny, 0);
    const rt = await verify(tiny);
    ok('an almost-empty but valid backup is accepted', rt.ok === true, JSON.stringify(rt));
  }

  // =========================================================================
  console.log('── 2. a CORRUPT backup is refused ──');
  // =========================================================================
  {
    // Header intact, pages destroyed. This is the case the old check missed.
    const bad = join(dir, 'corrupt.db');
    makeShopDb(bad);
    const buf = readFileSync(bad);
    ok('the corrupted file still carries a valid SQLite header',
      buf.toString('utf-8', 0, 15) === 'SQLite format 3');
    for (let i = Math.floor(buf.length * 0.6); i < buf.length; i++) buf[i] = 0xAA;
    writeFileSync(bad, buf);
    ok('...and still does after corruption, so a header check cannot see it',
      readFileSync(bad).toString('utf-8', 0, 15) === 'SQLite format 3');

    const r = await verify(bad);
    ok('a corrupt backup is refused', r.ok === false, JSON.stringify(r));
    ok('the refusal says what is wrong', /malformed|corrupt|تالف|فحص/i.test(r.reason), r.reason);

    // THE OTHER KIND OF CORRUPTION, and the one that matters more here.
    //
    // The damage above is so severe that `pragma('integrity_check')` THROWS,
    // so the surrounding try/catch refuses the file even if the verdict is
    // never inspected. A mutation test proved that: deleting the
    // `verdict !== 'ok'` branch entirely still passed, because nothing reached
    // it.
    //
    // But SQLite also reports damage WITHOUT throwing — a readable file whose
    // b-tree is inconsistent comes back as a multi-line report:
    //
    //     *** in database main ***
    //     Tree 2 page 10 cell 21: Rowid 0 out of order
    //     Fragmentation of 27 bytes reported as 0 on page 10
    //
    // That file opens, answers queries, and returns wrong rows. It is exactly
    // the backup a shop must not be allowed to restore, and only the verdict
    // check catches it.
    const subtle = join(dir, 'subtle.db');
    {
      const d = new Database(subtle);
      d.exec('CREATE TABLE sales(a); CREATE TABLE purchases(a); CREATE TABLE customers(a); CREATE TABLE items(a)');
      d.exec('CREATE INDEX i_sales ON sales(a)');
      const ins = d.prepare('INSERT INTO sales VALUES (?)');
      for (let i = 0; i < 500; i++) ins.run(i);
      d.close();
      const b = readFileSync(subtle);
      for (let i = b.length - 300; i < b.length - 260; i++) b[i] = 0x00;
      writeFileSync(subtle, b);
    }

    // Confirm the premise before asserting on it: this file must be one that
    // SQLite reports on rather than throws for, or the check below would be
    // testing the same path as the one above.
    let reported = null;
    {
      const d = new Database(subtle, { readonly: true, fileMustExist: true });
      try {
        const res = d.pragma('integrity_check');
        const rows = Array.isArray(res) ? res : [res];
        const f = rows[0];
        reported = typeof f === 'string' ? f : f?.integrity_check;
      } catch { reported = null; }
      d.close();
    }
    ok('the premise holds: this damage is REPORTED, not thrown',
      typeof reported === 'string' && reported !== 'ok',
      'the file no longer exercises the verdict branch; the check below proves nothing');

    const rs = await verify(subtle);
    ok('a backup whose integrity_check REPORTS damage is refused',
      rs.ok === false, JSON.stringify(rs));
    ok('...and the reason carries what SQLite said',
      /out of order|Tree|page|Fragmentation|فحص/i.test(rs.reason), rs.reason);
  }

  // =========================================================================
  console.log('── 3. a valid SQLite file that is NOT this program is refused ──');
  // =========================================================================
  {
    // Structurally perfect, and restoring it would leave the shop staring at
    // an empty program with its real books already overwritten.
    const alien = join(dir, 'alien.db');
    const a = new Database(alien);
    a.exec('CREATE TABLE notes(x); INSERT INTO notes VALUES (1)');
    a.close();
    const r = await verify(alien);
    ok('an unrelated SQLite database is refused', r.ok === false, JSON.stringify(r));
    ok('the refusal explains it in Arabic', /هذا البرنامج/.test(r.reason), r.reason);

    // A PARTIAL match must be refused too — three of the four tables is not
    // this application's database either.
    const partial = join(dir, 'partial.db');
    const p = new Database(partial);
    p.exec('CREATE TABLE sales(a); CREATE TABLE purchases(a); CREATE TABLE customers(a)');
    p.close();
    ok('a database with only some of the tables is refused',
      (await verify(partial)).ok === false);
  }

  // =========================================================================
  console.log('── 4. rubbish is refused rather than crashing ──');
  // =========================================================================
  {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    const r1 = await verify(junk);
    ok('a text file is refused', r1.ok === false, JSON.stringify(r1));

    const empty = join(dir, 'empty.db');
    writeFileSync(empty, '');
    const r2 = await verify(empty);
    ok('an empty file is refused', r2.ok === false, JSON.stringify(r2));

    const ghost = join(dir, 'does-not-exist.db');
    const r3 = await verify(ghost);
    ok('a missing file is refused', r3.ok === false, JSON.stringify(r3));

    // ...and CHECKING it must not bring it into existence.
    //
    // `fileMustExist: true` is doing real work here, and a mutation test
    // proved the suite was blind to it. With `fileMustExist: false` SQLite
    // CREATES the file: measured, an empty database appeared on disk. The
    // verify step would then be writing to the very folder the owner is
    // browsing for a backup, and — worse — a typo in the filename would
    // produce a brand-new empty database rather than "file not found",
    // which is one confirmation dialog away from restoring nothing over
    // everything.
    ok('checking a missing file does not CREATE it', !existsSync(ghost),
      'the guard opened it read-write, so a typo now yields an empty database');

    // Whatever happens, it must be a returned value and never a throw — the
    // caller is inside a try/catch that would otherwise report a technical
    // error instead of a plain refusal.
    for (const r of [r1, r2, r3]) {
      ok('the refusal is a value with a reason, not an exception',
        typeof r === 'object' && typeof r.reason === 'string');
    }
  }

  // =========================================================================
  console.log('── 5. checking a backup does not change it ──');
  // =========================================================================
  {
    // Opened read-only. A backup that the act of verifying modified would no
    // longer be the backup that was taken, and on a WAL database an ordinary
    // open is enough to write.
    const probe = join(dir, 'untouched.db');
    makeShopDb(probe);
    const before = readFileSync(probe);
    const sizeBefore = statSync(probe).size;
    await verify(probe);
    const after = readFileSync(probe);
    ok('the candidate file is byte-for-byte unchanged', Buffer.compare(before, after) === 0);
    ok('...and no side file changed its size', statSync(probe).size === sizeBefore);
  }

  // =========================================================================
  console.log('── 6. the guard is wired into backup:restore, before the copy ──');
  // =========================================================================
  {
    // A guard nothing calls is a comment. It must also run BEFORE
    // `copyFileSync`, or the live database is already gone.
    const callAt = src.indexOf('await verifyDatabaseFile(backupPath)');
    const copyAt = src.indexOf('fs.copyFileSync(backupPath, dbPath)');
    const closeAt = src.indexOf('closeDb();');
    ok('backup:restore calls the guard', callAt > 0);
    ok('the guard runs BEFORE the live database is overwritten',
      callAt > 0 && copyAt > 0 && callAt < copyAt, `guard ${callAt}, copy ${copyAt}`);
    ok('the guard runs BEFORE the live connection is closed',
      callAt > 0 && closeAt > 0 && callAt < closeAt,
      'a refused restore would still have shut the database down');
    ok('a refused restore returns instead of continuing',
      /if \(!probe\.ok\) \{[\s\S]{0,400}?return \{/.test(src));
  }
} finally {
  // Windows may still hold a lock on a just-closed SQLite file; a
  // leftover temp folder must not abort the suites that follow.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* disposable */ }
}

// ===========================================================================
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — a bad backup cannot overwrite good books`);
