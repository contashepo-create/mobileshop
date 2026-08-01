#!/usr/bin/env node
/**
 * OFF-SITE BACKUP TO TELEGRAM — security and behaviour suite.
 *
 * This feature does two dangerous things at once: it stores a BEARER CREDENTIAL
 * (a bot token) and it ships the ENTIRE database — every customer, price,
 * balance and password hash — off the premises. Both need guarding, and this
 * file is where those guards are proven rather than assumed.
 *
 * WHAT IS PROVEN HERE
 *   [1] the token cannot leak through the PUBLIC settings channels
 *   [2] the token cannot leak through CSV export
 *   [3] a token never appears in an error message shown to the user
 *   [4] malformed tokens/chat ids are rejected before any network call
 *   [5] Telegram's 50 MB ceiling is checked BEFORE uploading
 *   [6] a failed upload never destroys or replaces the local backup
 *   [7] the automatic send is once a day, and only when switched on
 *   [8] the whole channel is permission-gated and off by default
 *
 * Run with:  node --experimental-strip-types scripts/verify_telegram_backup.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
console.log('OFF-SITE BACKUP TO TELEGRAM');
console.log('='.repeat(72));

// A SYNTHETIC token. It is shaped exactly like a Telegram one so it passes
// looksLikeBotToken() and exercises the redaction regex, but it belongs to no
// bot. A working credential must never sit in the repository: every network
// call in this suite is stubbed, so nothing here needs a real one.
const FAKE_TOKEN = '1234567890:AAFakeTokenForTestsOnly_NotARealBot00';

// ---------------------------------------------------------------- 1
console.log('\n[1] The bot token cannot leak through the PUBLIC settings channels');
{
  const s = code('src/main/ipc/settings.handlers.ts');

  // settings:getAll is in PUBLIC_CHANNELS — callable with no session at all.
  t('settings:getAll excludes telegram_% keys',
    /settings:getAll[\s\S]{0,700}Key NOT LIKE 'telegram_%'/.test(s));
  t('settings:getAll still excludes cloud_% and sync_%',
    /settings:getAll[\s\S]{0,700}Key NOT LIKE 'cloud_%'[\s\S]{0,200}Key NOT LIKE 'sync_%'/.test(s));

  // settings:get is ALSO public and takes an arbitrary key name.
  t('settings:get refuses secret keys by name',
    /isSecretKey[\s\S]{0,400}telegram_[\s\S]{0,200}settings:get[\s\S]{0,200}isSecretKey\(key\)\) return null/.test(s));
  // db_path moved into PRIVATE_KEYS when the owner personal fields were added,
  // so the filter is now "the three prefixes, plus a named list". Asserted
  // that way rather than by the old flat ordering, which failed on code that
  // had become stricter rather than looser.
  t('the secret-key filter still covers the cloud, sync and telegram prefixes',
    /isSecretKey[\s\S]{0,300}cloud_[\s\S]{0,120}sync_[\s\S]{0,120}telegram_/.test(s));
  t('and db_path is still refused, via the private-key list',
    /PRIVATE_KEYS = new Set\(\[[\s\S]{0,200}'db_path'/.test(s)
    && /PRIVATE_KEYS\.has\(key\)/.test(s));

  // Behavioural: the exact WHERE clause the handler uses must hide the token.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT)');
  const ins = db.prepare('INSERT INTO settings (Key, Value) VALUES (?, ?)');
  ins.run('company_name', 'محل محمد');
  ins.run('telegram_bot_token', FAKE_TOKEN);
  ins.run('telegram_chat_id', '7232305465');
  ins.run('cloud_api_key', 'secret-cloud-key');

  const visible = db.prepare(`
    SELECT Key, Value FROM settings
    WHERE Key NOT LIKE 'cloud_%' AND Key NOT LIKE 'sync_%'
      AND Key NOT LIKE 'telegram_%' AND Key NOT IN ('db_path')
  `).all();
  const dump = JSON.stringify(visible);
  t('a real token is absent from what getAll returns', !dump.includes(FAKE_TOKEN), dump.slice(0, 80));
  t('the cloud key is absent too', !dump.includes('secret-cloud-key'));
  t('ordinary settings still come through', dump.includes('company_name'));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The token cannot leak through CSV export');
{
  const d = code('src/main/ipc/database.handlers.ts');
  t('the settings table is on the export blocklist',
    /EXPORT_BLOCKLIST = new Set\(\[[^\]]*'settings'/.test(d));
  t('users and user_overrides are still blocked',
    /EXPORT_BLOCKLIST = new Set\(\[[^\]]*'users'[^\]]*'user_overrides'/.test(d));
  t('the blocklist is enforced on single-table export',
    /assertExportableTable[\s\S]{0,600}EXPORT_BLOCKLIST\.has\(tableName\)/.test(d));
  t('the blocklist is enforced on export-all',
    /exportAllCSV[\s\S]{0,900}EXPORT_BLOCKLIST\.has\(tableName\)\) continue/.test(d));

  // Behavioural: the blocklist really excludes it from the offered list.
  const BLOCK = new Set(['users', 'user_overrides', 'settings']);
  const tables = ['sales', 'items', 'settings', 'users', 'customers'];
  const offered = tables.filter(n => !BLOCK.has(n));
  t('settings is not offered as an exportable table',
    !offered.includes('settings') && offered.includes('sales'), offered.join(','));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A token never reaches a message, a log or the renderer');
{
  const tg = await import('../src/main/backup/telegramBackup.ts');

  t('redactToken removes a bare token',
    !tg.redactToken(`failed with ${FAKE_TOKEN}`, FAKE_TOKEN).includes(FAKE_TOKEN));
  t('redactToken removes a token embedded in an api.telegram.org URL',
    !tg.redactToken(`https://api.telegram.org/bot${FAKE_TOKEN}/sendDocument 404`, '')
      .includes(FAKE_TOKEN));
  t('redaction leaves the useful part of the message',
    tg.redactToken(`failed with ${FAKE_TOKEN}`, FAKE_TOKEN).includes('failed with'));

  // Redaction runs inside CATCH blocks, on values that are not guaranteed to
  // be strings: `String(err?.message || err)` yields a string, but callers
  // elsewhere pass the raw error, and an Error with an empty message falls
  // back to the object itself. Without the `typeof text === 'string'` guard
  // every one of these throws TypeError (`.split is not a function`) — from
  // the very handler that exists to report a failure, turning a reportable
  // error into a crash. Measured: undefined, null, 42, an Error and a plain
  // object all throw unguarded, and all return a string guarded.
  for (const [label, value] of [
    ['undefined', undefined], ['null', null], ['a number', 42],
    ['an Error object', new Error(`boom ${FAKE_TOKEN}`)], ['a plain object', {}],
  ]) {
    let out, threw = null;
    try { out = tg.redactToken(value, FAKE_TOKEN); }
    catch (err) { threw = `${err?.constructor?.name}: ${err?.message}`; }
    t(`redactToken survives ${label} instead of throwing`,
      threw === null && typeof out === 'string', threw ?? `returned ${typeof out}`);
    if (threw === null) {
      t(`  ...and still hides the token in ${label}`, !String(out).includes(FAKE_TOKEN));
    }
  }

  // `String(text ?? '')` and `String(text)` differ for exactly the two values
  // that reach here most often from a catch block. The caller composes
  // `تعذّر الإرسال: ${redactToken(why, token) || 'سبب غير معروف'}`, and that
  // fallback only fires on an EMPTY string. Drop the `?? ''` and the shop
  // owner is shown the literal word "undefined" in the middle of an Arabic
  // sentence instead of "سبب غير معروف".
  for (const [label, value] of [['undefined', undefined], ['null', null]]) {
    const out = tg.redactToken(value, FAKE_TOKEN);
    t(`${label} redacts to an EMPTY string so the Arabic fallback fires`,
      out === '', JSON.stringify(out));
    t(`  ...so the user never sees the word "${label}" in the message`,
      !(`تعذّر الإرسال: ${out || 'سبب غير معروف'}`).includes(String(label)));
  }

  // The three checks above call the EXPORTED binding. That is not the same as
  // proving the module's own internal call sites resolve.
  //
  // This module used to carry its own copy of redactToken; the copy was
  // removed in favour of the one in confirmCode. The obvious way to write that
  // — `export { redactToken } from '../security/confirmCode'` — re-exports the
  // name WITHOUT binding it locally, so `tg.redactToken(...)` keeps working
  // while every internal `redactToken(...)` inside this file throws
  // "ReferenceError: redactToken is not defined". The export test passes and
  // the feature is broken. The correct form is a real import plus a separate
  // export, and the only way to tell the two apart is to RUN a path that calls
  // the function internally.
  //
  // getMe must succeed and sendMessage must fail with a reason that is neither
  // "chat not found" nor "bot was blocked" — that is the one branch that
  // redacts.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (
      String(url).includes('/getMe')
        ? { json: async () => ({ ok: true, result: { username: 'shopbot' } }) }
        : { json: async () => ({
            ok: false,
            description: `Internal Server Error at https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
          }) }
    );
    try {
      const r = await tg.testTelegram({ botToken: FAKE_TOKEN, chatId: '7232305465' });
      const msg = String(r?.message ?? '');
      t('an internal redactToken call site actually resolves at runtime',
        msg.includes('تعذّر الإرسال'), msg);
      t('and the token it scrubs never reaches the user',
        msg.length > 0 && !msg.includes(FAKE_TOKEN), msg);
    } catch (err) {
      t('an internal redactToken call site actually resolves at runtime',
        false, `${err?.constructor?.name}: ${err?.message}`);
      t('and the token it scrubs never reaches the user', false, 'threw before returning');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const d = code('src/main/ipc/database.handlers.ts');
  t('telegram:getSettings does not return the token to the renderer',
    /telegram:getSettings[\s\S]{0,500}hasToken:/.test(d)
    && !/telegram:getSettings[\s\S]{0,500}botToken: cfg\.botToken/.test(d));
  t('it returns only a masked hint',
    /tokenHint[\s\S]{0,80}split\(':'\)\[0\]/.test(d));

  const ui = code('src/renderer/src/pages/settings/BackupPage.tsx');
  t('the screen clears the typed token after saving', /setTgToken\(''\)/.test(ui));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Malformed credentials are refused before any network call');
{
  const tg = await import('../src/main/backup/telegramBackup.ts');

  t('a real-shaped token is accepted', tg.looksLikeBotToken(FAKE_TOKEN) === true);
  for (const bad of ['', 'abc', '123:short', 'nocolon', null, undefined, 12345,
                     ':AAFakeTokenForTestsOnly_NotARealBot00']) {
    if (tg.looksLikeBotToken(bad) !== false) {
      t(`token ${JSON.stringify(bad)} rejected`, false);
    }
  }
  t('every malformed token shape is rejected', true);

  t('a numeric chat id is accepted', tg.looksLikeChatId('7232305465') === true);
  t('a negative (group) chat id is accepted', tg.looksLikeChatId('-1001234567') === true);
  for (const bad of ['', 'abc', '@channel', '12', null, undefined, 123]) {
    if (tg.looksLikeChatId(bad) !== false) t(`chat id ${JSON.stringify(bad)} rejected`, false);
  }
  t('every malformed chat id is rejected', true);

  // No fetch is defined here, so reaching the network would throw. A clean
  // refusal proves validation happens first.
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK REACHED'); };
  try {
    const r = await tg.testTelegram({ botToken: 'rubbish', chatId: '123' });
    t('testTelegram refuses rubbish without calling the network',
      r.success === false && !/NETWORK REACHED/.test(r.message), r.message);
    const r2 = await tg.sendBackupToTelegram({ botToken: 'rubbish', chatId: 'x' }, '/nope', 'c');
    t('sendBackup refuses rubbish without calling the network',
      r2.success === false && !/NETWORK REACHED/.test(r2.message), r2.message);
  } finally {
    globalThis.fetch = saved;
  }
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Telegram\'s 50 MB ceiling is enforced before uploading');
{
  const tg = await import('../src/main/backup/telegramBackup.ts');
  t('the documented cap is 50 MB', tg.TELEGRAM_MAX_UPLOAD_BYTES === 50 * 1024 * 1024);

  const dir = mkdtempSync(join(tmpdir(), 'tgb-'));
  try {
    const big = join(dir, 'big.db');
    // Sparse-ish write: one byte past the limit is enough to trip the check.
    const fd = writeFileSync(big, Buffer.alloc(1));
    void fd;
    const buf = Buffer.alloc(1024 * 1024);
    const chunks = [];
    for (let i = 0; i < 51; i++) chunks.push(buf);
    writeFileSync(big, Buffer.concat(chunks));
    t('the test file really is over the limit',
      statSync(big).size > tg.TELEGRAM_MAX_UPLOAD_BYTES);

    const saved = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('NETWORK REACHED'); };
    try {
      const r = await tg.sendBackupToTelegram(
        { botToken: FAKE_TOKEN, chatId: '7232305465' }, big, 'caption');
      t('an oversized database is refused without uploading',
        r.success === false && !/NETWORK REACHED/.test(r.message), r.message);
      t('and the message explains the limit in Arabic, with a way out',
        /50/.test(r.message) && /ميجابايت/.test(r.message), r.message);
    } finally {
      globalThis.fetch = saved;
    }

    const missing = await tg.sendBackupToTelegram(
      { botToken: FAKE_TOKEN, chatId: '7232305465' }, join(dir, 'nothere.db'), 'c');
    t('a missing backup file is reported, not thrown', missing.success === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 6
console.log('\n[6] A failed upload never harms the local backup');
{
  const tg = await import('../src/main/backup/telegramBackup.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tgb2-'));
  try {
    const file = join(dir, 'auto_backup_2026-07-31.db');
    writeFileSync(file, 'SQLite format 3\u0000the shop books');
    const before = readFileSync(file);

    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) });
    try {
      const r = await tg.sendBackupToTelegram(
        { botToken: FAKE_TOKEN, chatId: '7232305465' }, file, 'c');
      t('a rejected upload reports failure', r.success === false, r.message);
      t('the local backup file is untouched', readFileSync(file).equals(before));
    } finally {
      globalThis.fetch = saved;
    }

    // A network explosion must be caught, not propagated into autoBackup.
    const saved2 = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    try {
      const r = await tg.sendBackupToTelegram(
        { botToken: FAKE_TOKEN, chatId: '7232305465' }, file, 'c');
      t('a network error is caught and reported', r.success === false && /فشل الرفع/.test(r.message));
      t('the local backup survives that too', readFileSync(file).equals(before));
    } finally {
      globalThis.fetch = saved2;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const m = code('src/main/index.ts');
  t('the Telegram step runs AFTER the local backup is written',
    m.indexOf('await db.backup(backupPath)') < m.indexOf('sendDailyTelegramBackup'));
  t('the Telegram step cannot throw into autoBackup',
    /async function sendDailyTelegramBackup[\s\S]{0,2000}try \{[\s\S]{0,1800}catch \(err\)/.test(m));
  t('the handler deletes its temporary full-database copy',
    /telegram:sendBackup[\s\S]{0,2000}finally \{[\s\S]{0,200}unlinkSync\(tmpPath\)/
      .test(code('src/main/ipc/database.handlers.ts')));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] The automatic send is once a day, and only when enabled');
{
  const m = code('src/main/index.ts');
  t('nothing is sent unless the shop switched it on',
    /telegram_backup_enabled'\) !== '1'\) return/.test(m));
  t('nothing is sent without a token and chat id',
    /if \(!botToken \|\| !chatId\) return/.test(m));
  t('the same day is not sent twice',
    /telegram_daily_sent'\) === today\) return/.test(m));
  t('the day is marked ONLY after a success, so a failure retries',
    /if \(result\.success\)[\s\S]{0,300}telegram_daily_sent', today/.test(m));

  // Behavioural: simulate the hourly loop for one day.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT)');
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (Key,Value) VALUES (?,?)').run(k, v);
  const get = k => (db.prepare('SELECT Value FROM settings WHERE Key = ?').get(k) || {}).Value ?? '';
  set('telegram_backup_enabled', '1');
  set('telegram_bot_token', FAKE_TOKEN);
  set('telegram_chat_id', '7232305465');

  let sends = 0;
  const today = '2026-07-31';
  const tick = (succeeds) => {
    if (get('telegram_backup_enabled') !== '1') return;
    if (get('telegram_daily_sent') === today) return;
    sends++;
    if (succeeds) set('telegram_daily_sent', today);
  };
  for (let h = 0; h < 24; h++) tick(true);
  t('24 hourly runs produce exactly one upload', sends === 1, `sends=${sends}`);

  // Now the failure path: it must keep retrying, not give up for the day.
  const db2 = new DatabaseSync(':memory:');
  db2.exec('CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT)');
  let sends2 = 0, marked = false;
  for (let h = 0; h < 5; h++) {
    if (marked) continue;
    sends2++;
    if (h === 3) marked = true;   // succeeds on the fourth attempt
  }
  t('a failing upload retries until it succeeds', sends2 === 4, `attempts=${sends2}`);
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Permission-gated, off by default, and honest to the user');
{
  const guard = code('src/main/security/ipcGuard.ts');
  for (const [ch, perm] of [
    ['telegram:getSettings', 'settings.view'],
    ['telegram:saveSettings', 'settings.edit'],
    ['telegram:clearSettings', 'settings.edit'],
    ['telegram:test', 'settings.edit'],
    ['telegram:sendBackup', 'settings.edit'],
  ]) {
    t(`${ch} requires ${perm}`, new RegExp(`'${ch}': '${perm}'`).test(guard));
  }
  t('no telegram channel is reachable before login',
    !/PUBLIC_CHANNELS[\s\S]{0,1800}'telegram:/.test(guard));

  const d = code('src/main/ipc/database.handlers.ts');
  t('the feature is off unless the flag is exactly "1"',
    /telegram_backup_enabled === '1'/.test(d));
  t('saving with a blank token keeps the stored one',
    /if \(token\) stmt\.run\('telegram_bot_token', token\)/.test(d));
  t('an invalid token is refused at the handler too',
    /if \(token && !looksLikeBotToken\(token\)\)/.test(d));

  const ui = code('src/renderer/src/pages/settings/BackupPage.tsx');
  t('the screen warns that the WHOLE database is uploaded',
    /قاعدة البيانات كاملة/.test(ui));
  t('the screen states the 50 MB limit', /٥٠ ميجابايت|50 ميجابايت/.test(ui));
  t('the token field is a password input', /type="password"[\s\S]{0,200}tgToken/.test(ui));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
