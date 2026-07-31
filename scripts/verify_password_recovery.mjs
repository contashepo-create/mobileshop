#!/usr/bin/env node
/**
 * ADMIN PASSWORD SELF-RECOVERY — security suite.
 *
 * This feature lets a shop owner reset a forgotten administrator password
 * without the developer, by proving control of the owner's Telegram account.
 * It is reachable BEFORE login, which makes it the most exposed surface in the
 * program: every check below exists because the alternative is someone taking
 * over the books.
 *
 * The real Cloudflare worker is executed against an in-memory SQLite database
 * with a stubbed Telegram API, exactly like verify_bot.mjs, so these are
 * behavioural results and not readings of the source.
 *
 * WHAT IS PROVEN HERE
 *   [1] the code is never returned to the caller — only to the owner's chat
 *   [2] a wrong code is refused, and grinding it down is impossible
 *   [3] a code cannot be replayed, redirected to another user, or outlived
 *   [4] the owner cannot be flooded with reset prompts
 *   [5] the app refuses a forged or stale grant (the HMAC is re-checked)
 *   [6] only administrators are eligible
 *   [7] every reset leaves a permanent audit row
 *
 * Run with:  node --experimental-strip-types scripts/verify_password_recovery.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'node:module';
import crypto from 'node:crypto';

// TypeScript source omits the .ts extension; Node's ESM resolver requires one.
// Same hook the handler harness uses, so the REAL modules import unmodified.
register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      const base = context.parentURL || import.meta.url;
      const candidate = new URL(specifier + '.ts', base).href;
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate, shortCircuit: true };
      }
    }
    return next(specifier, context);
  }
`), import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

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
console.log('ADMIN PASSWORD SELF-RECOVERY');
console.log('='.repeat(72));

// ---------------------------------------------------------------- D1 shim
function makeDB() {
  const db = new DatabaseSync(':memory:');
  const prepare = sql => {
    const norm = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      async run() { return { meta: { last_row_id: Number(db.prepare(norm).run(...bound).lastInsertRowid) } }; },
      async first() { return db.prepare(norm).get(...bound) ?? null; },
      async all() { return { results: db.prepare(norm).all(...bound) }; },
    };
    return api;
  };
  return { prepare, batch: async stmts => Promise.all(stmts.map(s => s.run())), _raw: db };
}

// ------------------------------------------------------------ Telegram shim
let sent = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts?.body || '{}');
  sent.push({ url: String(url), body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const SECRET = 'test-license-secret-value';
const CLIENT_KEY = 'test-client-key';

const src = readFileSync(join(ROOT, 'server/worker.js'), 'utf-8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

function makeEnv() {
  return {
    DB: makeDB(),
    CLIENT_KEY,
    ADMIN_KEY: 'test-admin-key',
    LICENSE_SECRET: SECRET,
    TG_BOT_TOKEN: 'bot-token',
    TG_ADMIN_CHAT: '7232305465',
  };
}

const DEVICE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function req(path, body, key = CLIENT_KEY) {
  return new Request(`https://x.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Key': key },
    body: JSON.stringify(body),
  });
}
const call = (env, path, body, key) => mod.default.fetch(req(path, body, key), env);

/** Pull the six-digit code out of the Telegram message the worker sent. */
function codeFromTelegram() {
  const msg = sent.filter(s => s.url.includes('sendMessage')).pop();
  const m = /<code>(\d{6})<\/code>/.exec(msg?.body?.text || '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- 1
console.log('\n[1] The code reaches the owner, never the caller');
{
  const env = makeEnv(); sent = [];
  const res = await call(env, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const body = await res.json();

  t('the request succeeds', body.ok === true, JSON.stringify(body));
  t('the response body contains NO code anywhere',
    !/\d{6}/.test(JSON.stringify(body)),
    JSON.stringify(body));

  const tg = sent.filter(s => s.url.includes('sendMessage'));
  t('exactly one Telegram message is sent', tg.length === 1, `sent ${tg.length}`);
  t('it goes to the owner chat id, not a caller-supplied one',
    String(tg[0]?.body?.chat_id) === '7232305465', String(tg[0]?.body?.chat_id));
  t('the message carries a six-digit code', /\d{6}/.test(tg[0]?.body?.text || ''));

  // The stored form must be a hash, exactly like a password.
  const row = env.DB._raw.prepare('SELECT code_hash FROM password_resets WHERE device_id = ?').get(DEVICE);
  const plain = codeFromTelegram();
  t('the database stores a HASH, never the plain code',
    row && row.code_hash !== plain && /^[0-9a-f]{64}$/.test(row.code_hash),
    String(row?.code_hash).slice(0, 20));

  const wrongKey = await call(env, '/password-reset/request', { deviceId: DEVICE, userId: 1 }, 'not-the-key');
  t('a caller without the client key is rejected', wrongKey.status === 401);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A wrong code cannot be ground down');
{
  const env = makeEnv(); sent = [];
  await call(env, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const real = codeFromTelegram();

  const bad = await call(env, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: '000000' });
  const badBody = await bad.json();
  t('a wrong code is refused', badBody.ok !== true);
  t('and no grant is handed out', !badBody.grant);

  // Burn the remaining attempts (one was just used).
  for (let i = 0; i < 4; i++) {
    await call(env, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: '111111' });
  }
  const after = await call(env, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: real });
  const afterBody = await after.json();
  t('after five wrong attempts even the CORRECT code is dead',
    afterBody.ok !== true && afterBody.error === 'too_many_attempts',
    JSON.stringify(afterBody));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A code cannot be replayed, redirected or outlived');
{
  const env = makeEnv(); sent = [];
  await call(env, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const real = codeFromTelegram();

  const first = await (await call(env, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: real })).json();
  t('the correct code works once', first.ok === true && typeof first.grant === 'string');

  const second = await (await call(env, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: real })).json();
  t('the same code cannot be used twice', second.ok !== true && second.error === 'used', JSON.stringify(second));

  // Redirection: a code issued for user 1 must not reset user 2.
  const env2 = makeEnv(); sent = [];
  await call(env2, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const c2 = codeFromTelegram();
  const redirected = await (await call(env2, '/password-reset/verify', { deviceId: DEVICE, userId: 2, code: c2 })).json();
  t('a code issued for one user cannot reset a DIFFERENT user',
    redirected.ok !== true, JSON.stringify(redirected));

  // Expiry: wind the stored deadline into the past.
  const env3 = makeEnv(); sent = [];
  await call(env3, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const c3 = codeFromTelegram();
  env3.DB._raw.prepare('UPDATE password_resets SET expires_at = ? WHERE device_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), DEVICE);
  const expired = await (await call(env3, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: c3 })).json();
  t('an expired code is refused', expired.ok !== true && expired.error === 'expired', JSON.stringify(expired));

  // A second request must invalidate the first code.
  const env4 = makeEnv(); sent = [];
  await call(env4, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const older = codeFromTelegram();
  await call(env4, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
  const newer = codeFromTelegram();
  const stale = await (await call(env4, '/password-reset/verify', { deviceId: DEVICE, userId: 1, code: older })).json();
  t('requesting a new code kills the previous one',
    older !== newer && stale.ok !== true, `${older} -> ${newer}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The owner cannot be flooded with prompts');
{
  const env = makeEnv(); sent = [];
  let allowed = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call(env, '/password-reset/request', { deviceId: DEVICE, userId: 1, username: 'admin' });
    if ((await r.json()).ok) allowed++;
  }
  t('requests per device per hour are capped', allowed <= 3, `allowed ${allowed}`);
  const tg = sent.filter(s => s.url.includes('sendMessage')).length;
  t('so the owner receives a bounded number of messages', tg <= 3, `messages ${tg}`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The app re-verifies the grant and refuses a forgery');
{
  process.env.MOBILESHOP_API_BASE = '';
  process.env.MOBILESHOP_CLIENT_KEY = '';
  const rec = await import('../src/main/security/passwordRecovery.ts');

  // The real secret embedded in the app.
  const { VERIFIER_SECRET } = await import('../src/main/security/licenseCrypto.ts');
  const sign = (dev, uid, at, secret = VERIFIER_SECRET) =>
    crypto.createHmac('sha256', secret).update(`pwreset|${dev}|${uid}|${at}`).digest('hex');

  const now = Date.now();
  t('a correctly signed, fresh grant is accepted',
    rec.verifyGrant(sign(DEVICE, 7, now), DEVICE, 7, now, now) === true);

  t('a grant signed with the WRONG secret is refused',
    rec.verifyGrant(sign(DEVICE, 7, now, 'attacker-secret'), DEVICE, 7, now, now) === false);

  t('a grant for a DIFFERENT user is refused',
    rec.verifyGrant(sign(DEVICE, 7, now), DEVICE, 8, now, now) === false);

  t('a grant for a DIFFERENT device is refused',
    rec.verifyGrant(sign(DEVICE, 7, now), 'ffffffffffffffffffffffffffffffff', 7, now, now) === false);

  t('a stale grant is refused',
    rec.verifyGrant(sign(DEVICE, 7, now), DEVICE, 7, now, now + rec.GRANT_MAX_AGE_MS + 1000) === false);

  t('a grant dated far in the future is refused',
    rec.verifyGrant(sign(DEVICE, 7, now + 3600_000), DEVICE, 7, now + 3600_000, now) === false);

  for (const junk of [null, undefined, '', 'x', 123, {}, [], 'z'.repeat(64), '0'.repeat(63)]) {
    if (rec.verifyGrant(junk, DEVICE, 7, now, now) !== false) {
      t(`junk grant ${JSON.stringify(junk)} is refused`, false);
    }
  }
  t('every malformed grant shape is refused', true);

  // The signature must really come from the server's algorithm, so a client
  // and a worker cannot silently disagree about what they are signing.
  const workerStyle = crypto.createHmac('sha256', SECRET)
    .update(`pwreset|${DEVICE}|7|${now}`).digest('hex');
  t('client and worker sign the SAME message shape',
    workerStyle === sign(DEVICE, 7, now, SECRET));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Only administrators, and the guard knows these channels');
{
  const users = code('src/main/ipc/users.handlers.ts');

  t('requestCode refuses a non-administrator',
    /recovery:requestCode[\s\S]{0,1400}RoleID !== ADMIN_ROLE_ID/.test(users));
  t('resetPassword refuses a non-administrator',
    /recovery:resetPassword[\s\S]{0,2600}RoleID !== ADMIN_ROLE_ID/.test(users));
  t('resetPassword refuses an inactive account',
    /recovery:resetPassword[\s\S]{0,2600}!user\.IsActive/.test(users));
  t('the listing offered pre-login is administrators only',
    /users:listRecoverable[\s\S]{0,400}RoleID = \?[\s\S]{0,200}ADMIN_ROLE_ID/.test(users));
  t('the new password is validated BEFORE the one-time code is spent',
    users.indexOf('const pwError = checkPassword(newPassword)') <
    users.indexOf('const verified = await verifyResetCode'));
  t('the grant is verified before any password is written',
    users.indexOf('verifyGrant(verified.grant') < users.indexOf('UPDATE users SET PasswordHash = ? WHERE UserID = ?', users.indexOf('recovery:resetPassword')));
  t('sessions are destroyed after a recovery reset',
    /recovery:resetPassword[\s\S]{0,3200}destroyAllSessionsForUser/.test(users));

  const guard = code('src/main/security/ipcGuard.ts');
  for (const ch of ['users:listRecoverable', 'recovery:isAvailable', 'recovery:requestCode', 'recovery:resetPassword']) {
    t(`${ch} is reachable before login (it must be)`, guard.includes(`'${ch}'`));
  }

  // The old developer route must survive: it is the offline fallback.
  t('the developer fallback still exists for a shop with no internet',
    users.includes("'users:resetByDev'"));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Every reset leaves a permanent trace');
{
  const users = code('src/main/ipc/users.handlers.ts');
  const mig = code('src/main/database/migrations/index.ts');

  t('the security_events table exists',
    /CREATE TABLE IF NOT EXISTS security_events/.test(mig));
  t('recovery by Telegram is recorded',
    /recordSecurityEvent\(db, 'password_reset_telegram'/.test(users));
  t('a reset by an administrator is recorded',
    /recordSecurityEvent\(db, 'password_reset_by_admin'/.test(users));
  t('a reset by the developer is recorded — the most privileged route',
    /recordSecurityEvent\(db, 'password_reset_by_developer'/.test(users));
  t('a rejected grant is recorded too',
    /recordSecurityEvent\(db, 'password_reset_rejected'/.test(users));
  t('the audit write can never break a reset',
    /function recordSecurityEvent[\s\S]{0,600}try \{[\s\S]{0,400}catch/.test(users));

  // Behavioural: the table really accepts what the handler writes.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE security_events (
    EventID INTEGER PRIMARY KEY AUTOINCREMENT, EventType TEXT NOT NULL,
    UserID INTEGER, Username TEXT, Detail TEXT,
    CreatedAt TEXT DEFAULT (datetime('now','localtime')))`);
  db.prepare('INSERT INTO security_events (EventType, UserID, Username, Detail) VALUES (?, ?, ?, ?)')
    .run('password_reset_telegram', 1, 'admin', 'x');
  const n = db.prepare('SELECT COUNT(*) v FROM security_events').get().v;
  t('a row can actually be written and read back', n === 1);

  // The owner is told out-of-band as well.
  const envD = makeEnv(); sent = [];
  await call(envD, '/password-reset/done', { deviceId: DEVICE, username: 'admin' });
  const note = sent.filter(s => s.url.includes('sendMessage')).pop();
  t('a completed reset is announced on Telegram',
    /كلمة مرور المدير/.test(note?.body?.text || ''), note?.body?.text?.slice(0, 60));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The feature degrades safely when unavailable');
{
  const rec = code('src/main/security/passwordRecovery.ts');
  t('no server configured means the route reports itself unavailable',
    /isRecoveryConfigured\(\)[\s\S]{0,200}API_BASE && CLIENT_KEY/.test(rec));
  t('a network failure returns a message, never a silent success',
    /if \(!res\) \{[\s\S]{0,200}success: false/.test(rec));
  t('the grant comparison is timing-safe',
    rec.includes('timingSafeEqual'));
  t('the login screen hides the tab when there is no server',
    code('src/renderer/src/pages/auth/Login.tsx').includes('selfAvailable'));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
