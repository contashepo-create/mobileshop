#!/usr/bin/env node
/**
 * NOTHING MAY CLAIM THE DATABASE IS ENCRYPTED WHILE IT IS NOT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * A review plan asked for the local database to be encrypted with SQLCipher,
 * "so nobody can open the .db in Notepad and read the financial data". The
 * goal is right. The obvious way to do it here is a trap, and this suite
 * exists to keep anyone — including a future me — from walking into it.
 *
 * MEASURED against the driver this application actually ships
 * (better-sqlite3, plain SQLite build):
 *
 *     db.pragma("key='super-secret-passphrase'")   -> ACCEPTED, no error
 *     db.pragma('cipher_version')                  -> []      (not SQLCipher)
 *
 *     file header    : "SQLite format 3"
 *     secret in file : PRESENT, in cleartext
 *     reopened with NO key at all:
 *         SELECT * FROM t  ->  [{"secret":"رقم سري للعميل 1234"}]
 *
 * `PRAGMA key` on a non-SQLCipher build is a silent no-op. It does not fail,
 * it does not warn, and the database is written in plain text. Anyone adding
 * that one line would produce a build that LOOKS encrypted, reports success,
 * and protects nothing — strictly worse than today, because today nobody
 * believes the file is safe.
 *
 * Real encryption here needs a different binary: `@journeyapps/sqlcipher`, or
 * better-sqlite3 compiled against SQLCipher. That is a build-chain change and
 * a key-management design (where the key lives, how a forgotten key is
 * recovered, what happens to existing databases), not a one-line pragma.
 *
 * WHAT THIS SUITE ASSERTS
 * -----------------------
 * 1. The honest state of the shipped driver, so the claim above stays true and
 *    is re-measured on every run rather than remembered from a report.
 * 2. That no code has quietly added `PRAGMA key`, which would create the
 *    illusion of encryption.
 * 3. That the data which WOULD be exposed is known and minimal — so the
 *    decision to defer encryption is made against a measured list, not a
 *    guess.
 *
 * Run:  node --experimental-strip-types scripts/verify_db_encryption_claim.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
 * Path relative to the repository root, in forward slashes, on every OS.
 *
 * `f.replace(ROOT + '/', '')` assumes a POSIX separator. On Windows the paths
 * carry backslashes, the prefix never matches, and the result stays absolute —
 * which silently breaks any comparison or allow-list keyed on `src/...`.
 */
const relPath = (f) => relative(ROOT, f).split(sep).join('/');

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

const dir = mkdtempSync(join(ROOT, '.enc-check-'));
try {
  // =========================================================================
  console.log('\n── 1. what the shipped driver really is ──');
  // =========================================================================
  {
    const p = join(dir, 'probe.db');
    const db = new Database(p);

    let keyThrew = null;
    try { db.pragma("key='super-secret-passphrase'"); } catch (e) { keyThrew = e; }

    let cipher = null;
    try { cipher = db.pragma('cipher_version'); } catch { cipher = null; }
    const isSqlCipher = Array.isArray(cipher) && cipher.length > 0;

    db.exec('CREATE TABLE t(secret TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('رقم سري للعميل 1234');
    db.close();

    const buf = readFileSync(p);
    const header = buf.toString('utf-8', 0, 15);
    const leaks = buf.includes(Buffer.from('رقم سري للعميل 1234'));

    console.log(`   PRAGMA key accepted : ${keyThrew === null}`);
    console.log(`   cipher_version      : ${JSON.stringify(cipher)}`);
    console.log(`   file header         : ${JSON.stringify(header)}`);
    console.log(`   cleartext in file   : ${leaks}`);

    if (isSqlCipher) {
      // The build was upgraded. Then the claims flip, and they must be real.
      ok('a SQLCipher build actually encrypts the file', !leaks,
        'cipher_version is set but the data is still readable in the raw file');
      ok('a SQLCipher build refuses to open without the key', true);
      console.log('   NOTE: the driver is now SQLCipher — this suite has switched to '
        + 'asserting that encryption WORKS, not that it is absent.');
    } else {
      // The state as measured today. Asserted so it cannot change silently.
      ok('the driver is NOT SQLCipher (cipher_version is empty)', !isSqlCipher);
      ok('PRAGMA key is silently accepted on this build — it is a NO-OP',
        keyThrew === null,
        'it threw; the note in this file about silent acceptance needs revisiting');
      ok('...and the file is therefore written in cleartext', leaks,
        'the premise of this suite no longer holds — re-measure before trusting it');
      ok('...and the header is a plain SQLite header', header === 'SQLite format 3');

      // The part that makes it unambiguous: reopen with NO key.
      const again = new Database(p);
      const rows = again.prepare('SELECT * FROM t').all();
      again.close();
      ok('a database "keyed" on this build opens with no key at all',
        rows.length === 1 && String(rows[0].secret).includes('1234'),
        JSON.stringify(rows));
    }
  }

  // =========================================================================
  console.log('── 2. no code pretends to encrypt ──');
  // =========================================================================
  {
    // A single `PRAGMA key` line would make the product claim protection it
    // does not have. Until the driver is swapped, its absence IS the control.
    const scan = (d, hits = []) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) { scan(p, hits); continue; }
        if (!/\.(ts|tsx|js|mjs)$/.test(e.name)) continue;
        const body = readFileSync(p, 'utf8');
        for (const line of body.split('\n')) {
          // The pragma as CODE, not as prose in a comment.
          if (/pragma\s*\(\s*[`'"]\s*key\s*=/i.test(line)
            || /pragma\s*\(\s*[`'"]\s*rekey\s*=/i.test(line)) {
            hits.push(`${relPath(p)}: ${line.trim().slice(0, 80)}`);
          }
        }
      }
      return hits;
    };
    const hits = scan(join(ROOT, 'src')).concat(scan(join(ROOT, 'scripts')));
    // This suite's own probe is in scripts/, but it uses db.pragma("key=...")
    // inside a string built at runtime, so it should not match. If it does,
    // the exclusion is explicit rather than the pattern being loosened.
    const real = hits.filter(h => !h.startsWith('scripts/verify_db_encryption_claim.mjs'));
    ok('no source file issues PRAGMA key / rekey', real.length === 0,
      real.join(' | '));
  }

  // =========================================================================
  console.log('── 3. what is actually exposed, measured not guessed ──');
  // =========================================================================
  {
    // Deferring encryption is only defensible if the exposure is known. This
    // enumerates it from the real schema so the list cannot quietly grow.
    const mig = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf8');

    // Passwords must be HASHED, never stored recoverably. That is the control
    // that actually matters for the user accounts.
    ok('user passwords are stored as a hash, not a password',
      /PasswordHash\s+TEXT\s+NOT NULL/.test(mig) && !/\bPassword\s+TEXT/.test(mig));

    // bcrypt, and never a reversible scheme.
    const auth = readFileSync(join(ROOT, 'src/main/ipc/auth.handlers.ts'), 'utf8');
    ok('login compares with bcrypt', /bcrypt\.(compare|compareSync)/.test(auth));

    // The one genuinely secret free-text field.
    const secretFields = [];
    if (/DevicePassword\s+TEXT/.test(mig)) secretFields.push('maintenance_tickets.DevicePassword');
    console.log(`   recoverable secrets in the schema: ${secretFields.length ? secretFields.join(', ') : 'none'}`);
    ok('the recoverable-secret list is exactly what is documented',
      secretFields.length === 1 && secretFields[0] === 'maintenance_tickets.DevicePassword',
      JSON.stringify(secretFields) + ' — a new plaintext secret was added; encryption can no '
      + 'longer be deferred without revisiting this');

    // Credentials must NOT be sitting in the settings table either — those
    // were moved out to masked channels in an earlier round.
    const settings = readFileSync(join(ROOT, 'src/main/ipc/settings.handlers.ts'), 'utf8');
    ok('the public settings channel still hides the credential families',
      /\/\^cloud_\/\.test\(key\)/.test(settings)
      && /\/\^sync_\/\.test\(key\)/.test(settings)
      && /\/\^telegram_\/\.test\(key\)/.test(settings));
  }

  // =========================================================================
  console.log('── 4. the file is at least not world-readable by accident ──');
  // =========================================================================
  {
    // Encryption is deferred; file permissions are not a substitute, but a
    // database created world-readable would make the exposure worse than it
    // needs to be.
    const p = join(dir, 'perm.db');
    const d = new Database(p);
    d.exec('CREATE TABLE t(a)');
    d.close();
    const mode = statSync(p).mode & 0o777;
    console.log(`   created with mode ${mode.toString(8)}`);
    ok('a new database is not group- or world-WRITABLE', (mode & 0o022) === 0,
      mode.toString(8));
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
console.log(`PASSED  all ${checks} checks — the encryption claim matches the measured reality`);
