#!/usr/bin/env node
/**
 * ADMIN PASSWORD SELF-RECOVERY — security suite.
 *
 * The shop owner recovers a forgotten ADMINISTRATOR password by proving control
 * of the SHOP's own Telegram bot. It is reachable BEFORE login, which makes it
 * the most exposed surface in the program.
 *
 * THE SEPARATION THIS SUITE DEFENDS
 * ---------------------------------
 * There are two bots and they must never be confused:
 *
 *   - the DEVELOPER's bot lives in the Cloudflare Worker's secrets, is not
 *     shown in any settings screen, and carries licensing traffic only;
 *   - the CUSTOMER's bot is configured in Settings -> Backup and carries the
 *     password-reset code and the off-site backups.
 *
 * The first implementation sent the reset code through the WORKER, i.e. to
 * TG_ADMIN_CHAT — the developer's phone. Every customer would have had to ring
 * for their own code: the support call the feature exists to remove. Section
 * [7] below asserts that regression can never come back.
 *
 * WHAT IS PROVEN HERE
 *   [1] a code is delivered to the SHOP's chat using the SHOP's bot
 *   [2] the code never leaves the main process except to Telegram
 *   [3] a wrong code cannot be ground down
 *   [4] a code cannot be replayed, redirected or outlived
 *   [5] the owner cannot be flooded with prompts
 *   [6] administrators only; staff are reset by their administrator
 *   [7] the developer's bot carries no customer password traffic
 *   [8] every reset leaves a permanent trace, and it degrades safely
 *
 * Run with:  node --experimental-strip-types scripts/verify_password_recovery.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      const base = context.parentURL || import.meta.url;
      const candidate = new URL(specifier + '.ts', base).href;
      if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
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
console.log('ADMIN PASSWORD SELF-RECOVERY (shop-owned Telegram bot)');
console.log('='.repeat(72));

const rec = await import('../src/main/security/passwordRecovery.ts');

const SHOP_BOT = { botToken: '8877684899:AAHTZfkM_MPlD2ZiR1CJ8qiKRXzFrHnRmdo', chatId: '7232305465' };
const DEV_CHAT = '999888777';   // stands in for the developer's TG_ADMIN_CHAT

/** Captures every Telegram call so the destination can be asserted. */
let sent = [];
function stubTelegram({ ok = true, description = '' } = {}) {
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts?.body || '{}');
    sent.push({ url: String(url), chatId: String(body.chat_id ?? ''), text: String(body.text ?? '') });
    return { json: async () => (ok ? { ok: true, result: {} } : { ok: false, description }) };
  };
}

/** Pull the six digits out of the message that was actually transmitted. */
const codeFromMessage = () => (/(\d{6})/.exec(sent.at(-1)?.text || '') || [])[1] || null;

// ---------------------------------------------------------------- 1
console.log('\n[1] The code goes to the SHOP\'s chat, through the SHOP\'s bot');
{
  rec.__resetRecoveryState(); sent = []; stubTelegram();
  const res = await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل محمد');

  t('the request succeeds', res.success === true, res.message);
  t('exactly one message is sent', sent.length === 1, `sent ${sent.length}`);
  t('it is addressed to the SHOP chat id', sent[0]?.chatId === SHOP_BOT.chatId, sent[0]?.chatId);
  t('it is NOT addressed to the developer chat', sent[0]?.chatId !== DEV_CHAT);
  t('it is sent through the SHOP bot token', sent[0]?.url.includes(SHOP_BOT.botToken));
  t('the message carries a six-digit code', /\d{6}/.test(sent[0]?.text || ''));
  t('the shop name is shown so the owner knows which install', /محل محمد/.test(sent[0]?.text || ''));

  // The code must never come back to the caller — the renderer would then have
  // it, and anyone at the keyboard could read it off the screen.
  t('the code is absent from the returned result', !/\d{6}/.test(JSON.stringify(res)), JSON.stringify(res));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Nothing is stored or promised when delivery fails');
{
  rec.__resetRecoveryState(); sent = [];
  stubTelegram({ ok: false, description: 'chat not found' });
  const res = await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  t('a failed send is reported as failure', res.success === false, res.message);
  t('and the message explains what to do', /Start|المحادثة/.test(res.message), res.message);

  // A code the owner never received must not occupy the pending slot.
  stubTelegram();
  const v = rec.verifyResetCode(1, '000000');
  t('no pending reset was created', v.success === false && /لا يوجد طلب/.test(v.message), v.message);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A wrong code cannot be ground down');
{
  rec.__resetRecoveryState(); sent = []; stubTelegram();
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const real = codeFromMessage();

  t('a wrong code is refused', rec.verifyResetCode(1, '000000').success === false);
  for (let i = 0; i < 3; i++) rec.verifyResetCode(1, '111111');
  const fifth = rec.verifyResetCode(1, '222222');
  t('the fifth wrong attempt burns the code', fifth.success === false, fifth.message);
  const after = rec.verifyResetCode(1, real);
  t('even the CORRECT code is dead afterwards',
    after.success === false && /لا يوجد طلب|تجاوز/.test(after.message), after.message);
  t('the cap is five attempts', rec.MAX_ATTEMPTS === 5);

  // Probing with the WRONG USER ID also increments the counter, but takes a
  // different branch: it returns before the mismatch path that burns the code.
  // Without the cap checked at the TOP of the function, an attacker could sit
  // on that branch forever, keeping the code alive while guessing. Measured:
  // removing that guard left the correct code usable after ten attempts.
  rec.__resetRecoveryState(); sent = [];
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const live = codeFromMessage();
  for (let i = 0; i < 6; i++) rec.verifyResetCode(999, '000000');
  const probed = rec.verifyResetCode(1, live);
  t('probing with a wrong USER ID is capped too, not just a wrong code',
    probed.success === false, probed.message);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A code cannot be replayed, redirected or outlived');
{
  rec.__resetRecoveryState(); sent = []; stubTelegram();
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const real = codeFromMessage();

  t('the correct code works once', rec.verifyResetCode(1, real).success === true);
  t('the same code cannot be used twice', rec.verifyResetCode(1, real).success === false);

  // Redirection to a different account.
  rec.__resetRecoveryState(); sent = [];
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const c2 = codeFromMessage();
  t('a code issued for user 1 cannot reset user 2', rec.verifyResetCode(2, c2).success === false);

  // Expiry, driven by the injected clock rather than by waiting.
  rec.__resetRecoveryState(); sent = [];
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const c3 = codeFromMessage();
  const late = rec.verifyResetCode(1, c3, Date.now() + rec.CODE_TTL_MS + 1000);
  t('an expired code is refused', late.success === false && /انتهت/.test(late.message), late.message);
  t('the window is fifteen minutes', rec.CODE_TTL_MS === 15 * 60 * 1000);

  // A new request replaces the old code.
  rec.__resetRecoveryState(); sent = [];
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const older = codeFromMessage();
  await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
  const newer = codeFromMessage();
  t('requesting again invalidates the previous code',
    older !== newer && rec.verifyResetCode(1, older).success === false);
  t('and the newest code still works', rec.verifyResetCode(1, newer).success === true);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The owner cannot be flooded with prompts');
{
  rec.__resetRecoveryState(); sent = []; stubTelegram();
  let allowed = 0;
  for (let i = 0; i < 6; i++) {
    const r = await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل');
    if (r.success) allowed++;
  }
  t('requests per hour are capped', allowed <= rec.MAX_REQUESTS_PER_HOUR, `allowed ${allowed}`);
  t('so the owner receives a bounded number of messages',
    sent.length <= rec.MAX_REQUESTS_PER_HOUR, `messages ${sent.length}`);

  // The window must roll: an hour later the owner is not locked out.
  rec.__resetRecoveryState(); sent = [];
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل', t0);
  const blocked = await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل', t0);
  const later = await rec.requestResetCode(SHOP_BOT, 1, 'admin', 'محل', t0 + 3_600_001);
  t('a fourth request within the hour is refused', blocked.success === false);
  t('but an hour later it is allowed again', later.success === true, later.message);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Administrators only, with an unconfigured shop handled gracefully');
{
  rec.__resetRecoveryState(); sent = []; stubTelegram();

  // No bot configured: refuse cleanly and point at the settings screen.
  const none = await rec.requestResetCode(null, 1, 'admin', 'محل');
  t('an unconfigured shop is told where to configure it',
    none.success === false && /الإعدادات/.test(none.message), none.message);
  t('and nothing was transmitted', sent.length === 0);

  for (const bad of [
    { botToken: 'rubbish', chatId: '7232305465' },
    { botToken: SHOP_BOT.botToken, chatId: 'abc' },
    { botToken: '', chatId: '' },
  ]) {
    const r = await rec.requestResetCode(bad, 1, 'admin', 'محل');
    if (r.success !== false) t(`malformed config ${JSON.stringify(bad)} refused`, false);
  }
  t('every malformed bot configuration is refused without a network call', sent.length === 0);

  const users = code('src/main/ipc/users.handlers.ts');
  t('requestCode refuses a non-administrator',
    /recovery:requestCode[\s\S]{0,1500}RoleID !== ADMIN_ROLE_ID/.test(users));
  t('resetPassword refuses a non-administrator',
    /recovery:resetPassword[\s\S]{0,2600}RoleID !== ADMIN_ROLE_ID/.test(users));
  t('resetPassword refuses an inactive account',
    /recovery:resetPassword[\s\S]{0,2600}!user\.IsActive/.test(users));
  t('the pre-login listing is administrators only',
    /users:listRecoverable[\s\S]{0,400}RoleID = \?[\s\S]{0,200}ADMIN_ROLE_ID/.test(users));
  t('the new password is validated BEFORE the one-time code is spent',
    users.indexOf('const pwError = checkPassword(newPassword)')
    < users.indexOf('const verified = verifyResetCode'));
  t('sessions are destroyed after a recovery reset',
    /recovery:resetPassword[\s\S]{0,3200}destroyAllSessionsForUser/.test(users));
  t('the developer fallback survives for a shop with no bot',
    users.includes("'users:resetByDev'"));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] The DEVELOPER\'s bot carries no customer password traffic');
{
  // This is the regression that shipped once: the reset code was delivered to
  // TG_ADMIN_CHAT, so the customer had to phone the developer for their own
  // code. It must never return.
  const worker = code('server/worker.js');
  t('the worker exposes no /password-reset route', !worker.includes('/password-reset'));
  t('the worker has no reset handler', !/handleReset(Request|Verify|Done)/.test(worker));
  t('the worker keeps no password-reset tables',
    !worker.includes('password_resets') && !worker.includes('reset_requests'));

  // The mechanics now live in the shared confirmCode module, used by BOTH the
  // password reset and the database reset so the two cannot drift apart in
  // their guarantees. The properties are asserted where they are implemented.
  const recSrc = code('src/main/security/passwordRecovery.ts');
  const mech = code('src/main/security/confirmCode.ts');
  t('recovery never calls the developer API base',
    !/MOBILESHOP_API_BASE/.test(recSrc) && !/MOBILESHOP_API_BASE/.test(mech));
  t('recovery never uses the shipped client key',
    !/MOBILESHOP_CLIENT_KEY/.test(recSrc) && !/MOBILESHOP_CLIENT_KEY/.test(mech));
  t('recovery talks to Telegram directly', /api\.telegram\.org/.test(mech));

  const users = code('src/main/ipc/users.handlers.ts');
  t('the handler reads the SHOP bot from settings',
    /telegram_bot_token'[\s\S]{0,120}telegram_chat_id/.test(users));
  t('the code is minted with a cryptographic source, not Math.random',
    /crypto\.randomInt/.test(mech) && !/Math\.random/.test(mech));
  t('the plain code is hashed, never held in the clear',
    /createHash\('sha256'\)/.test(mech));
  t('code comparison is timing-safe', /timingSafeEqual/.test(mech));
  t('a bot token can never reach a message', /function redactToken/.test(mech));
  t('a password-reset code cannot be replayed as a database wipe',
    /pendingByPurpose/.test(mech) && /verifyCode\(\s*purpose/.test(mech.replace(/\n/g, ' ')));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Every reset leaves a permanent trace');
{
  const users = code('src/main/ipc/users.handlers.ts');
  const mig = code('src/main/database/migrations/index.ts');

  t('the security_events table exists', /CREATE TABLE IF NOT EXISTS security_events/.test(mig));
  t('recovery by Telegram is recorded', /recordSecurityEvent\(db, 'password_reset_telegram'/.test(users));
  t('a failed attempt is recorded too', /recordSecurityEvent\(db, 'password_reset_rejected'/.test(users));
  t('a reset by an administrator is recorded', /recordSecurityEvent\(db, 'password_reset_by_admin'/.test(users));
  t('a reset by the developer is recorded', /recordSecurityEvent\(db, 'password_reset_by_developer'/.test(users));
  t('the audit write can never break a reset',
    /export function recordSecurityEvent[\s\S]{0,600}try \{[\s\S]{0,400}catch/
      .test(code('src/main/security/securityLog.ts')));

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE security_events (
    EventID INTEGER PRIMARY KEY AUTOINCREMENT, EventType TEXT NOT NULL,
    UserID INTEGER, Username TEXT, Detail TEXT,
    CreatedAt TEXT DEFAULT (datetime('now','localtime')))`);
  db.prepare('INSERT INTO security_events (EventType, UserID, Username, Detail) VALUES (?,?,?,?)')
    .run('password_reset_telegram', 1, 'admin', 'x');
  t('a row can be written and read back',
    db.prepare('SELECT COUNT(*) v FROM security_events').get().v === 1);

  // The owner is told out-of-band, on their own bot, that it happened.
  rec.__resetRecoveryState(); sent = []; stubTelegram();
  await rec.notifyResetDone(SHOP_BOT, 'admin', 'محل محمد');
  t('a completed reset is announced to the shop chat',
    sent.length === 1 && sent[0].chatId === SHOP_BOT.chatId, JSON.stringify(sent[0] || {}));
  t('the notice names the account that changed', /admin/.test(sent[0]?.text || ''));

  sent = [];
  await rec.notifyResetDone(null, 'admin', 'محل');
  t('an unconfigured shop is not a crash, just silence', sent.length === 0);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
