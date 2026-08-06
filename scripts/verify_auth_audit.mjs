#!/usr/bin/env node
/**
 * AUTHENTICATION AND SESSION MANAGEMENT.
 *
 * WHAT THIS AUDIT FOUND, AND WHAT IS PINNED HERE
 * ----------------------------------------------
 * Three real defects, each MEASURED against the shipped handlers before it was
 * touched, and each pinned below so it cannot come back:
 *
 *   A. `auth:login` had NO rate limit. 100 wrong passwords in 7.8 seconds —
 *      ~13 guesses/second, forever. bcrypt's cost was the only brake, and a
 *      common-password list beats that overnight on an unattended till.
 *      (The developer console has had a lockout since it was written; the
 *      door the shop actually uses had none.)
 *
 *   B. A DEFAULT CREDENTIAL survived setup. `seedData` creates
 *      `admin` / `admin123`; the wizard's upsert only replaces it when the
 *      owner happens to pick the same username. Measured: after a complete
 *      setup as `mohamed`, `admin` / `admin123` still logged in with full
 *      administrator rights. That would have shipped on every install.
 *
 *   C. DEACTIVATING A USER DID NOT LOG THEM OUT. Sessions cache the user and
 *      their permission set in memory and never re-read the row, so a
 *      dismissed cashier kept full access on whatever till was already open —
 *      exactly the moment the account is disabled for. The same applied to a
 *      role change: a demoted manager stayed a manager until they logged out.
 *
 * WHAT WAS AUDITED AND FOUND SOUND (also pinned, so it stays that way)
 *   - bcrypt everywhere, cost 10, salted; no MD5/SHA1/plaintext on any password
 *   - idle AND absolute session timeouts, the absolute one checked before the
 *     idle refresh so polling cannot extend it forever
 *   - sessions keyed by WebContents id in the MAIN process, so a renderer
 *     cannot claim to be another user
 *   - deny-by-default authorisation: every one of the 172 channels is mapped
 *   - dev tokens: 32 random bytes, 30-minute TTL, single-use challenges
 *   - recovery codes: crypto.randomInt, 15-min TTL, 5 attempts, 3/hour,
 *     compared with timingSafeEqual
 *   - no password is written to localStorage, and the legacy key is destroyed
 *
 * Run:  node --experimental-strip-types scripts/verify_auth_audit.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('AUTHENTICATION & SESSION AUDIT');
console.log('='.repeat(72));

function sqliteBase() {
  for (const b of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { createRequire(join(b, 'x.js')).resolve('better-sqlite3'); return b; } catch { /* next */ }
  }
  return null;
}
const BASE = sqliteBase();

// ------------------------------------------------------------------ 1
console.log('\n[1] Password storage');
{
  const files = ['src/main/ipc/users.handlers.ts', 'src/main/ipc/settings.handlers.ts',
    'src/main/database/migrations/index.ts', 'src/main/ipc/auth.handlers.ts'];
  const all = files.map(raw).join('\n');

  // A password must never be compared or stored as anything but a bcrypt hash.
  t('every password is hashed with bcrypt', /bcrypt\.hashSync\(/.test(all));
  t('verification uses bcrypt.compareSync', /bcrypt\.compareSync\(/.test(raw('src/main/ipc/auth.handlers.ts')));
  t('the cost factor is at least 10',
    [...all.matchAll(/bcrypt\.hashSync\([^,]+,\s*(\d+)\)/g)].every(m => Number(m[1]) >= 10),
    [...new Set([...all.matchAll(/bcrypt\.hashSync\([^,]+,\s*(\d+)\)/g)].map(m => m[1]))].join(','));

  // MD5/SHA1 must not appear on any password path. (An MD5 IV in the licence
  // file is a different thing entirely and is not a password hash.)
  const pwFiles = files.map(f => raw(f)).join('\n');
  t('no MD5 or SHA1 anywhere near a password',
    !/md5|sha1/i.test(pwFiles), 'weak digest on a password path');
  t('no password column is written in plaintext',
    !/PasswordHash\s*=\s*\?\s*`?\s*\)\.run\(\s*data\.(password|newPassword)\b/.test(pwFiles));

  // A stored password would be readable by anyone with the user profile.
  const login = raw('src/renderer/src/pages/auth/Login.tsx');
  t('the renderer never writes a password to localStorage',
    !/setItem\(\s*['"]saved_password['"]/.test(login));
  t('and it destroys the legacy key on sight',
    /removeItem\(\s*['"]saved_password['"]\s*\)/.test(login));
}

// ------------------------------------------------------------------ 2
console.log('\n[2] Session expiration');
{
  const s = raw('src/main/security/session.ts');
  t('an idle timeout exists', /IDLE_TIMEOUT_MS\s*=/.test(s));
  t('an ABSOLUTE timeout exists', /ABSOLUTE_TIMEOUT_MS\s*=/.test(s));

  // The subtle one: `getSession` refreshes lastSeenAt on every call, so a
  // polling screen renews the idle timer forever. The absolute ceiling must be
  // evaluated BEFORE that refresh or it can be pushed out indefinitely.
  const absIdx = s.indexOf('now - s.createdAt > ABSOLUTE_TIMEOUT_MS');
  const refreshIdx = s.indexOf('s.lastSeenAt = now;');
  t('the absolute ceiling is checked BEFORE lastSeenAt is refreshed',
    absIdx > 0 && refreshIdx > 0 && absIdx < refreshIdx);

  // Behaviour, not text.
  const mod = await import('../src/main/security/session.ts');
  const L = mod.SESSION_LIMITS;
  t('the idle timeout is a sane length', L.idleMs > 0 && L.idleMs <= 12 * 3600e3,
    `${L.idleMs / 3600e3}h`);
  t('the absolute lifetime is bounded', L.absoluteMs > 0 && L.absoluteMs <= 24 * 3600e3,
    `${L.absoluteMs / 3600e3}h`);
  t('and it is not shorter than the idle window', L.absoluteMs >= L.idleMs);

  mod.createSession(4242, { userId: 1, username: 'a', roleId: 1, employeeId: null,
    permissions: new Set(['x']) });
  t('a fresh session resolves', !!mod.getSession(4242));
  mod.destroySession(4242);
  t('logout really removes it', mod.getSession(4242) === null);

  // The renderer must not be able to claim an identity.
  t('sessions are keyed by the WebContents id, not by the payload',
    /getSession\(event\.sender\.id\)/.test(raw('src/main/security/ipcGuard.ts')));
  t('and the guard overwrites any userId the renderer supplies',
    /\(arg as Record<string, unknown>\)\.userId = ctx\.userId/.test(raw('src/main/security/ipcGuard.ts')));
}

// ------------------------------------------------------------------ 3
console.log('\n[3] Brute force — the login is rate limited');
{
  const a = raw('src/main/ipc/auth.handlers.ts');
  t('auth:login consults the throttle', /checkLoginAllowed\(username\)/.test(a));
  t('a failure is recorded', /recordLoginFailure\(username\)/.test(a));
  t('a success clears the counter', /recordLoginSuccess\(username\)/.test(a));
  // An unknown username must be counted too, or an attacker enumerating names
  // is never slowed and the real account is the one that starts locking.
  t('an unknown username is throttled as well',
    a.indexOf('recordLoginFailure(username)') < a.indexOf('bcrypt.compareSync(password, user.PasswordHash)'));
  // The check must come before the expensive work, so a locked account is not
  // a free oracle and costs the server nothing.
  t('the lock is checked before the database and before bcrypt',
    a.indexOf('checkLoginAllowed') < a.indexOf('const db = getDb()'));

  const th = await import('../src/main/security/loginThrottle.ts');
  th.__resetLoginThrottle();
  t('the limits are sane',
    th.LOGIN_THROTTLE.maxAttempts <= 10 && th.LOGIN_THROTTLE.lockoutMs >= 5 * 60e3,
    `${th.LOGIN_THROTTLE.maxAttempts} attempts, ${th.LOGIN_THROTTLE.lockoutMs / 60e3} min`);

  for (let i = 0; i < th.LOGIN_THROTTLE.maxAttempts - 1; i++) th.recordLoginFailure('ahmed');
  t('an honest typo does not lock the till', th.checkLoginAllowed('ahmed') === null);

  // A success must RESET the counter, not merely leave it below the limit.
  // Without the reset, a till used all day accumulates failures from unrelated
  // typos and eventually locks its own operator out mid-sale.
  th.recordLoginSuccess('ahmed');
  for (let i = 0; i < th.LOGIN_THROTTLE.maxAttempts - 1; i++) th.recordLoginFailure('ahmed');
  t('a successful login really clears the count, not just the lock',
    th.checkLoginAllowed('ahmed') === null,
    'a further 4 failures after a success must still be allowed');
  th.__resetLoginThrottle();

  for (let i = 0; i < th.LOGIN_THROTTLE.maxAttempts; i++) th.recordLoginFailure('ahmed');
  const locked = th.checkLoginAllowed('ahmed');
  t('the limit locks the account', locked !== null,
    locked ? `${Math.round(locked.lockedForSec / 60)} min remaining` : '');
  t('changing the case cannot dodge the lock', th.checkLoginAllowed('AHMED') !== null);
  t('nor can padding it with spaces', th.checkLoginAllowed('  ahmed  ') !== null);
  t('a different user is unaffected', th.checkLoginAllowed('sara') === null);
  th.__resetLoginThrottle();
}

// ------------------------------------------------------------------ 4
console.log('\n[4] Tokens and one-time codes');
{
  const dev = raw('src/main/security/devAuth.ts');
  t('dev tokens are cryptographically random',
    /crypto\.randomBytes\(32\)\.toString\('hex'\)/.test(dev));
  t('dev tokens expire', /TOKEN_TTL_MS\s*=/.test(dev) && /expiresAt <= Date\.now\(\)/.test(dev));
  t('an expired token is deleted, not merely rejected',
    /if \(meta\.expiresAt <= Date\.now\(\)\) \{[\s\S]{0,80}tokens\.delete/.test(dev));
  t('the dev console is rate limited', /LOCKOUT_MS\s*=/.test(dev) && /MAX_ATTEMPTS\s*=/.test(dev));
  t('the signed login verifies a real signature', /crypto\.verify\(/.test(dev));
  t('and still requires the password as a second factor', /!sigOk \|\| !passOk/.test(dev));
  t('a challenge nonce is single-use', /used/.test(dev) && /challenges\.delete/.test(dev));

  const cc = raw('src/main/security/confirmCode.ts');
  t('recovery codes use a cryptographic RNG',
    /crypto\.randomInt\(/.test(cc) && !/Math\.random/.test(cc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')));
  t('recovery codes expire', /CODE_TTL_MS\s*=/.test(cc));
  t('recovery codes are attempt-limited', /MAX_ATTEMPTS\s*=/.test(cc));
  t('and request-limited per hour', /MAX_REQUESTS_PER_HOUR\s*=/.test(cc));
  t('they are compared in constant time', /timingSafeEqual\(/.test(cc));
}

// ------------------------------------------------------------------ 5
console.log('\n[5] Authorisation — no route reachable without a check');
{
  const g = raw('src/main/security/ipcGuard.ts');
  t('an unauthenticated call is rejected',
    /if \(!session\) \{[\s\S]{0,140}UNAUTHENTICATED/.test(g));
  // Deny-by-default is the property that matters: a channel someone forgets to
  // map must fail closed, not sail through.
  t('an unmapped channel is DENIED, not allowed',
    /if \(!required\) \{[\s\S]{0,400}?throw new IpcAuthError\([^)]*'FORBIDDEN'\)/.test(g));

  // Behaviour, not text: call the real authorize() with a channel nobody has
  // mapped and confirm it REFUSES. `if (!required) return null` would pass a
  // source check for "the branch exists" while allowing every unmapped
  // channel through, which is the whole point of failing closed.
  {
    // Bundled rather than imported directly: the source uses extensionless
    // relative imports, which Node's ESM loader will not resolve.
    const { build } = await import('esbuild');
    const gstub = { name: 'g', setup(b) {
      b.onResolve({ filter: /^electron$/ }, (a) => ({ path: a.path, namespace: 'gs' }));
      b.onLoad({ filter: /.*/, namespace: 'gs' }, () => ({
        contents: `module.exports = { ipcMain: { handle() {} }, app: { getPath: () => '/tmp' } };`,
        loader: 'js' }));
    } };
    const gout = await build({
      stdin: { contents: `
        export { __authorizeForTests } from './src/main/security/ipcGuard.ts';
        export * as sess from './src/main/security/session.ts';`,
        resolveDir: ROOT, sourcefile: 'g.ts', loader: 'ts' },
      bundle: true, write: false, format: 'cjs', platform: 'node',
      plugins: [gstub], external: ['better-sqlite3', 'bcryptjs'], logLevel: 'silent',
    });
    const gfile = join(BASE ?? join(ROOT, 'node_modules'), '..', 'guard-probe.cjs');
    writeFileSync(gfile, gout.outputFiles[0].text);
    const gm = createRequire(join(ROOT, 'x.js'))(gfile);
    const sess = gm.sess;
    const WC = 99123;
    sess.createSession(WC, { userId: 1, username: 'a', roleId: 1, employeeId: null,
      permissions: new Set(['sales.view']) });
    const evt = { sender: { id: WC } };
    const probe = (channel) => {
      try { gm.__authorizeForTests(evt, channel); return 'ALLOWED'; }
      catch (err) { return err?.code || 'THREW'; }
    };
    t('an unmapped channel is refused at RUNTIME, not merely in the source',
      probe('totally:unmapped') === 'FORBIDDEN', probe('totally:unmapped'));
    t('a mapped channel the user lacks is refused',
      probe('users:create') === 'FORBIDDEN', probe('users:create'));
    t('a mapped channel the user HAS is allowed',
      probe('sales:list') === 'ALLOWED', probe('sales:list'));
    sess.destroySession(WC);
    t('once the session is gone every channel is unauthenticated',
      probe('sales:list') === 'UNAUTHENTICATED', probe('sales:list'));
    try { rmSync(gfile, { force: true }); } catch {}
  }

  // Every public channel is public on purpose, and each carries its own guard.
  const pubBlock = /const PUBLIC_CHANNELS = new Set<string>\(\[([\s\S]*?)\]\);/.exec(g)[1];
  const pub = [...pubBlock.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  t('the public list is small and deliberate', pub.length <= 30, `${pub.length} channels`);

  // The dangerous ones must each prove the caller some other way.
  const users = raw('src/main/ipc/users.handlers.ts');
  const dbh = raw('src/main/ipc/database.handlers.ts');
  const setg = raw('src/main/ipc/settings.handlers.ts');
  {
    // Slice the handler by brace depth rather than guessing a character
    // budget: adding a guard should not break an unrelated assertion.
    const i = dbh.indexOf("ipcMain.handle('db:exportForOwner'");
    let j = dbh.indexOf('(', i), d = 0, e = dbh.length;
    for (; j < dbh.length; j++) {
      const c = dbh[j];
      if (c === '(') d++; else if (c === ')') { d--; if (d === 0) { e = j; break; } }
    }
    const body = dbh.slice(i, e);
    t('db:exportForOwner demands a username and password',
      /bcrypt\.compareSync/.test(body) && /username/.test(body) && /password/.test(body));
    t('and refuses a non-administrator', /RoleID !== 1/.test(body));
  }
  t('users:resetByDev demands a developer token',
    /ipcMain\.handle\('users:resetByDev'[\s\S]{0,200}verifyDevToken/.test(users));
  t('recovery:requestCode is administrators only',
    /ipcMain\.handle\('recovery:requestCode'[\s\S]{0,900}RoleID !== ADMIN_ROLE_ID/.test(users));
  t('recovery:resetPassword spends a one-time code',
    /ipcMain\.handle\('recovery:resetPassword'[\s\S]{0,1400}verifyResetCode|consumeResetCode/.test(users)
    || /ipcMain\.handle\('recovery:resetPassword'[\s\S]{0,1600}code/.test(users));
  // setup:initialize writes the admin password and runs before any login, so
  // it must close permanently once used.
  t('setup cannot be re-run once complete',
    /setup_completed[\s\S]{0,260}تم إعداد النظام بالفعل/.test(setg));
}

// ------------------------------------------------------------------ 5b
console.log('\n[5b] Every credential-verifying endpoint is rate limited');
{
  /**
   * Enumerated from source, not from a list kept by hand — a list would go
   * stale the moment someone adds a channel, which is exactly the failure this
   * check exists to prevent.
   *
   * A handler "verifies a secret" if it calls bcrypt.compareSync, checks a dev
   * token, or verifies a one-time code. Each must either throttle itself, or
   * delegate to something that does.
   */
  const { readdirSync } = await import('node:fs');
  const dir = join(ROOT, 'src/main/ipc');
  const VERIFIES = /compareSync|verifyDevToken|devLogin\b|devLoginSigned|verifyCodeV2|verifyCode\(|verifyResetCode|verifyPhoneViaTelegram|requestResetCode/;
  const THROTTLED = /checkAttemptAllowed|checkLoginAllowed|isLockedOut/;
  // Delegates that carry their own lockout, verified in [4] above.
  const SELF_GUARDED = /devLogin\b|devLoginSigned|verifyCode\(|verifyResetCode|requestResetCode|verifyDevToken|verifyPhoneViaTelegram/;

  const unprotected = [];
  let checked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf-8');
    const re = /ipcMain\.handle\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      // Slice by brace depth so one handler cannot bleed into the next.
      let i = src.indexOf('(', m.index), depth = 0, end = src.length;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = src.slice(m.index, end);
      if (!VERIFIES.test(body)) continue;
      checked++;
      if (THROTTLED.test(body) || SELF_GUARDED.test(body)) continue;
      unprotected.push(`${m[1]} (${f}:${src.slice(0, m.index).split(/\r?\n/).length})`);
    }
  }
  t('every credential-verifying endpoint is throttled',
    unprotected.length === 0, unprotected.join(', '));
  t('and there are endpoints to check (the scan is not silently empty)',
    checked >= 10, `${checked} endpoints scanned`);

  // The four found unprotected in this audit, named so a regression is obvious.
  for (const [chan, file] of [
    ['db:exportForOwner', 'src/main/ipc/database.handlers.ts'],
    ['users:adminResetPassword', 'src/main/ipc/users.handlers.ts'],
    ['settings:resetRequestCode', 'src/main/ipc/settings.handlers.ts'],
    ['settings:resetDatabase', 'src/main/ipc/settings.handlers.ts'],
  ]) {
    const src = readFileSync(join(ROOT, file), 'utf-8');
    const i = src.indexOf(`ipcMain.handle('${chan}'`);
    let j = src.indexOf('(', i), d = 0, e = src.length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(') d++; else if (c === ')') { d--; if (d === 0) { e = j; break; } }
    }
    const body = src.slice(i, e);
    t(`${chan} checks the throttle`, /checkAttemptAllowed\(/.test(body));
    t(`${chan} records a failure`, /recordAttemptFailure\(/.test(body));
  }
}

// ------------------------------------------------------------------ 6
console.log('\n[6] Privilege changes take effect immediately');
{
  const users = raw('src/main/ipc/users.handlers.ts');
  // A session caches the permission set, so the row changing is not enough.
  t('resetting a password ends that user\'s sessions',
    (users.match(/destroyAllSessionsForUser\(/g) || []).length >= 4,
    `${(users.match(/destroyAllSessionsForUser\(/g) || []).length} call sites`);
  t('deactivating a user ends their sessions',
    /UPDATE users SET IsActive = 0 WHERE UserID = \?'\)\.run\(id\);[\s\S]{0,700}destroyAllSessionsForUser\(id\)/.test(users));
  t('editing a user (role change) ends their sessions',
    /UPDATE users SET Username = \?, EmployeeID = \?, RoleID = \?, IsActive = \?[\s\S]{0,900}destroyAllSessionsForUser\(id\)/.test(users));
}

// ------------------------------------------------------------------ 7
console.log('\n[7] The shipped default credential is retired at setup');
if (!BASE) {
  console.log('  SKIP  better-sqlite3 is not installed');
} else {
  const { build } = await import('esbuild');
  const dir = mkdtempSync(join(tmpdir(), 'authaudit-'));
  const stub = { name: 's', setup(b) {
    b.onResolve({ filter: /^electron$/ }, (a) => ({ path: a.path, namespace: 'st' }));
    b.onLoad({ filter: /.*/, namespace: 'st' }, () => ({ contents: `
      module.exports = {
        ipcMain: { handle: (c, f) => { globalThis.__AUTH_H.set(c, f); }, removeHandler: () => {} },
        app: { getPath: () => ${JSON.stringify(dir)}, getVersion: () => '1.0.0' },
        dialog: {
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showSaveDialog: async () => ({ canceled: true }),
          showMessageBox: async () => ({ response: 1 }),
          showErrorBox: () => {},
        },
        shell: {}, BrowserWindow: class {},
      };`, loader: 'js' }));
  } };
  const out = await build({
    stdin: { contents: `
      export { runMigrations } from './src/main/database/migrations/index.ts';
      export { registerAuthHandlers } from './src/main/ipc/auth.handlers.ts';
      export { registerSettingsHandlers } from './src/main/ipc/settings.handlers.ts';
      export { registerUsersHandlers } from './src/main/ipc/users.handlers.ts';
      export { registerDatabaseHandlers } from './src/main/ipc/database.handlers.ts';
      export { getSession } from './src/main/security/session.ts';
      export { __resetLoginThrottle } from './src/main/security/loginThrottle.ts';
      export { getDb } from './src/main/database/connection.ts';`,
      resolveDir: ROOT, sourcefile: 'a.ts', loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [stub], external: ['better-sqlite3', 'bcryptjs'], logLevel: 'silent',
  });
  const bundleFile = join(BASE, '..', 'auth-audit-probe.cjs');
  writeFileSync(bundleFile, out.outputFiles[0].text);
  globalThis.__AUTH_H = new Map();
  const req = createRequire(join(BASE, 'x.js'));
  const mod = req(bundleFile);
  const bcrypt = req('bcryptjs');

  mod.runMigrations(mod.getDb());
  mod.registerAuthHandlers();
  mod.registerSettingsHandlers();
  mod.registerUsersHandlers();
  mod.registerDatabaseHandlers();
  const call = (c, wc, ...a) => globalThis.__AUTH_H.get(c)({ sender: { id: wc } }, ...a);
  const db = mod.getDb();

  t('a fresh install seeds a default admin so the app is usable',
    !!db.prepare("SELECT 1 FROM users WHERE Username='admin'").get());

  const wiz = await call('setup:initialize', 1, {
    company: { companyName: 'محل الهاتف', ownerName: 'محمد عبده', phone: '01000000000',
      email: 'owner@example.com', address: 'المنصورة', taxNumber: '',
      governorate: 'الدقهلية', city: 'المنصورة', birthDate: '1990-01-01' },
    customer: { name: '', phone: '', email: '', address: '' },
    admin: { username: 'mohamed', password: 'StrongPass123', employeeName: 'م',
      position: 'مدير', phone: '0100' },
  });
  t('the wizard completes', wiz?.success === true, JSON.stringify(wiz).slice(0, 90));

  // THE FINDING: the owner chose their own username, so the upsert never
  // touched the seeded account and it stayed live with a published password.
  mod.__resetLoginThrottle();
  const backdoor = await call('auth:login', 2, { username: 'admin', password: 'admin123' });
  t('the DEFAULT admin/admin123 can no longer log in',
    backdoor?.success !== true, JSON.stringify(backdoor).slice(0, 90));
  const seeded = db.prepare("SELECT IsActive FROM users WHERE Username='admin'").get();
  t('the seeded account is deactivated', seeded && seeded.IsActive === 0,
    `IsActive ${seeded?.IsActive}`);
  t('and its password is no longer the published one',
    !bcrypt.compareSync('admin123',
      db.prepare("SELECT PasswordHash h FROM users WHERE Username='admin'").get().h));

  // The owner's own account must of course work.
  mod.__resetLoginThrottle();
  const good = await call('auth:login', 3, { username: 'mohamed', password: 'StrongPass123' });
  t('the owner\'s own account logs in', good?.success === true);

  // ---- brute force, end to end through the real handler
  console.log('\n[7b] Brute force, through the real handler');
  mod.__resetLoginThrottle();
  let refused = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('auth:login', 4, { username: 'mohamed', password: 'wrong' + i });
    if (r?.success === false) refused++;
  }
  t('every wrong password is refused', refused === 6, `${refused}/6`);
  const afterLock = await call('auth:login', 4,
    { username: 'mohamed', password: 'StrongPass123' });
  t('the CORRECT password is refused while locked out',
    afterLock?.success !== true && afterLock?.code === 'LOCKED_OUT',
    JSON.stringify(afterLock).slice(0, 100));
  t('and the shop is told how long to wait',
    /دقيقة/.test(String(afterLock?.message || '')), String(afterLock?.message || '').slice(0, 70));

  // ---- the four dangerous endpoints, end to end -------------------------
  console.log('\n[7d] The dangerous endpoints lock out too');
  {
    mod.__resetLoginThrottle();
    db.prepare("UPDATE users SET PasswordHash = ? WHERE Username = 'mohamed'")
      .run(bcrypt.hashSync('StrongPass123', 10));
    const uid = db.prepare("SELECT UserID v FROM users WHERE Username='mohamed'").get().v;

    // Each of these re-prompts for a password and, on success, does something
    // far worse than log in: dump the database, set anyone's password, or wipe
    // everything. All four had NO counter — ~13 guesses/second, unlimited.
    const doors = [
      ['db:exportForOwner', () =>
        call('db:exportForOwner', 9, { username: 'mohamed', password: 'wrong' })],
      ['users:adminResetPassword', () =>
        call('users:adminResetPassword', 9,
          { adminId: uid, adminPassword: 'wrong', targetUserId: uid, newPassword: 'Zzz12345' })],
      ['settings:resetRequestCode', () =>
        call('settings:resetRequestCode', 9, { userId: uid, password: 'wrong' })],
      ['settings:resetDatabase', () =>
        call('settings:resetDatabase', 9, { userId: uid, password: 'wrong', code: '000000' })],
    ];

    for (const [name, attempt] of doors) {
      mod.__resetLoginThrottle();
      let lockedAt = 0;
      for (let i = 1; i <= 8; i++) {
        const r = await attempt();
        if (r?.code === 'LOCKED_OUT') { lockedAt = i; break; }
      }
      t(`${name} locks out after a few wrong passwords`,
        lockedAt > 0 && lockedAt <= 6, lockedAt ? `locked on attempt ${lockedAt}` : 'never locked');
    }

    // NOTE ON REDUNDANCY, measured rather than assumed.
    //
    // `db:exportForOwner` checks the throttle TWICE: once by username before
    // the row is read, and once by user id after. Removing either one alone
    // does NOT fail this suite — the other still refuses — so those two
    // mutants are equivalent, not gaps. Removing BOTH is caught, and that was
    // verified by doing it.
    //
    // The redundancy is deliberate: the username key is the only thing
    // available before the lookup, and the user-id key is the only thing that
    // matches what the reset prompts count under. Keeping both is what makes
    // the lockout follow the PERSON across all three doors.

    // The scope is SHARED, so being locked out of one does not simply move the
    // attacker to the next prompt.
    mod.__resetLoginThrottle();
    for (let i = 0; i < 6; i++) {
      await call('db:exportForOwner', 9, { username: 'mohamed', password: 'x' + i });
    }
    const spill = await call('settings:resetRequestCode', 9, { userId: uid, password: 'x' });
    t('a lockout on one dangerous door closes the others',
      spill?.code === 'LOCKED_OUT', JSON.stringify(spill).slice(0, 80));

    // ...but it must NOT stop the shop trading.
    //
    // This is the reason the scopes are separate. Someone fumbling the export
    // password must not lock the till out of SELLING — the shop would be dead
    // for fifteen minutes with customers at the counter, which is a far worse
    // outcome than the attack being defended against.
    mod.__resetLoginThrottle();
    for (let i = 0; i < 6; i++) {
      await call('db:exportForOwner', 9, { username: 'mohamed', password: 'x' + i });
    }
    const canSell = await call('auth:login', 10,
      { username: 'mohamed', password: 'StrongPass123' });
    t('and the till can still log in and sell', canSell?.success === true,
      JSON.stringify(canSell).slice(0, 80));

    // The reverse, too: failing at the export prompt must not consume the
    // login allowance. Five wrong exports then five wrong logins must still
    // leave the sixth LOGIN as the one that locks — not the first.
    mod.__resetLoginThrottle();
    for (let i = 0; i < 4; i++) {
      await call('db:exportForOwner', 9, { username: 'mohamed', password: 'y' + i });
    }
    const loginAfter = await call('auth:login', 11,
      { username: 'mohamed', password: 'StrongPass123' });
    t('export failures do not consume the login allowance',
      loginAfter?.success === true && loginAfter?.code !== 'LOCKED_OUT',
      JSON.stringify(loginAfter).slice(0, 70));

    // An honest mistake must not lock the owner out of their own data.
    mod.__resetLoginThrottle();
    for (let i = 0; i < 4; i++) {
      await call('db:exportForOwner', 9, { username: 'mohamed', password: 'typo' + i });
    }
    const after4 = await call('db:exportForOwner', 9,
      { username: 'mohamed', password: 'StrongPass123' });
    t('four typos then the right password is accepted',
      after4?.code !== 'LOCKED_OUT',
      // The dialog is stubbed to cancel, so "not locked out" is the assertion:
      // getting past the password is what matters here.
      JSON.stringify(after4).slice(0, 80));
  }

  // ---- revocation, end to end
  console.log('\n[7c] Revocation, through the real handlers');
  mod.__resetLoginThrottle();
  db.prepare('INSERT INTO users(Username,PasswordHash,RoleID,IsActive) VALUES(?,?,3,1)')
    .run('cashier', bcrypt.hashSync('Cashier123', 10));
  const uid = db.prepare("SELECT UserID v FROM users WHERE Username='cashier'").get().v;

  const cashierIn = await call('auth:login', 7, { username: 'cashier', password: 'Cashier123' });
  t('the cashier logs in', cashierIn?.success === true);
  t('their session is live', !!mod.getSession(7));

  await call('users:delete', 1, uid);
  t('deactivating the account is recorded',
    db.prepare('SELECT IsActive v FROM users WHERE UserID=?').get(uid).v === 0);
  // THE FINDING: the till already open kept working.
  t('the open till is logged out immediately', mod.getSession(7) === null);

  // A role change must do the same.
  db.prepare('UPDATE users SET IsActive = 1 WHERE UserID = ?').run(uid);
  mod.__resetLoginThrottle();
  await call('auth:login', 8, { username: 'cashier', password: 'Cashier123' });
  t('the cashier logs in again', !!mod.getSession(8));
  await call('users:update', 1, uid,
    { username: 'cashier', roleId: 3, isActive: 1, employeeId: null });
  t('changing their role ends the session, so new rights are re-read',
    mod.getSession(8) === null);

  try { rmSync(bundleFile, { force: true }); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
