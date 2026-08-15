#!/usr/bin/env node
/**
 * Telegram bot menu checks.
 *
 * Runs the real worker against an in-memory SQLite database with a stubbed
 * Telegram API, so button flows are exercised end to end without touching the
 * network or a live bot.
 *
 * Run with:  node scripts/verify_bot.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PASS = [], FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
}

// ---------------------------------------------------------------- D1 shim
/** Minimal stand-in for Cloudflare's D1 binding, backed by node:sqlite. */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  const prepare = sql => {
    // Strip -- comments BEFORE collapsing whitespace: flattening first would
    // turn a trailing comment into one that swallows the rest of the query.
    const norm = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      async run() {
        const st = db.prepare(norm);
        const r = st.run(...bound);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
      },
      async first() {
        const st = db.prepare(norm);
        return st.get(...bound) ?? null;
      },
      async all() {
        const st = db.prepare(norm);
        return { results: st.all(...bound) };
      },
    };
    return api;
  };
  return { prepare, batch: async stmts => Promise.all(stmts.map(s => s.run())) };
}

// ---------------------------------------------------------------- Telegram shim
const sent = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts?.body || '{}');
  const method = String(url).split('/').pop();
  sent.push({ method, body });
  return {
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 1000 + sent.length } }),
  };
};

const lastOf = m => [...sent].reverse().find(s => s.method === m);
const buttons = msg => (msg?.body?.reply_markup?.inline_keyboard || []).flat();
const dataOf = msg => buttons(msg).map(b => b.callback_data);

// ---------------------------------------------------------------- load worker
/** Throwaway signing key: the bot must be able to mint a real v2 code. */
const TEST_PRIVATE_KEY = (await import('node:crypto'))
  .generateKeyPairSync('ed25519').privateKey
  .export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');

const src = readFileSync(join(ROOT, 'server/worker.js'), 'utf-8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const worker = mod.default;

const env = {
  DB: makeDB(),
  ADMIN_KEY: 'admin-key',
  CLIENT_KEY: 'client-key',
  // Ed25519 private key (base64 of 32 raw bytes). The worker now signs with
  // asymmetric crypto, so a plain string secret would fail at importKey.
  LICENSE_PRIVATE_KEY: TEST_PRIVATE_KEY,
  TG_BOT_TOKEN: 'token',
  TG_ADMIN_CHAT: '7232305465',
  // `/telegram` now demands Telegram's own `secret_token`, returned in the
  // X-Telegram-Bot-Api-Secret-Token header on every genuine delivery. Without
  // it the webhook refuses everything — which is the point: a measured exploit
  // posted `{"chat":{"id":<owner>},"text":"/new <device> 3650"}` with no
  // credential at all and got back a signed ten-year licence.
  TG_WEBHOOK_SECRET: 'webhook-secret-for-the-test',
};

const post = (path, body, headers = {}) =>
  worker.fetch(new Request(`https://x${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env);

/** A genuine Telegram delivery carries the registered secret. */
const TG_HEADERS = { 'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET };

const tap = data => post('/telegram', {
  callback_query: { id: 'q1', from: { id: 7232305465 }, data, message: { message_id: 500 } },
}, TG_HEADERS);
const type = text => post('/telegram', {
  message: { chat: { id: 7232305465 }, text },
}, TG_HEADERS);

console.log('='.repeat(70));
console.log('TELEGRAM BOT MENU CHECKS');
console.log('='.repeat(70));

// ---------------------------------------------------------------- 1
console.log('\n[1] Main menu appears and offers every action');
{
  sent.length = 0;
  await type('/start');
  const m = lastOf('sendMessage');
  const d = dataOf(m);
  check('menu is sent', !!m);
  check('has "new code"', d.includes('new'));
  check('has devices', d.some(x => x.startsWith('devs:')));
  check('has expiring', d.includes('exp'));
  check('has broadcast', d.includes('msgall'));
  check('has global settings', d.includes('setall'));
  check('has stats and help', d.includes('stats') && d.includes('help'));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Guided flow: tap → paste id → pick duration → code');
{
  sent.length = 0;
  await tap('new');
  check('asks for the device id', /معرّف الجهاز/.test(lastOf('editMessageText')?.body?.text || ''));

  await type('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  const dur = lastOf('sendMessage');
  const d = dataOf(dur);
  check('offers duration buttons', d.includes('dur:365') && d.includes('dur:0'));
  check('offers a custom duration', d.includes('dur:x'));

  sent.length = 0;
  await tap('dur:365');
  const forward = sent.find(s => s.method === 'sendMessage' && /كود التفعيل الخاص بك/.test(s.body.text || ''));
  check('sends a ready-to-forward message', !!forward);
  const code = (forward?.body?.text || '').match(/<code>([0-9A-Z-]{100,})<\/code>/)?.[1];
  check('code is a full Ed25519 code (an Ed25519 signature cannot be truncated)',
    !!code && code.replace(/-/g, '').length === 111, code ? `${code.length} chars` : 'not found');
  check('confirmation is shown in the panel', /تم إنشاء الكود/.test(lastOf('editMessageText')?.body?.text || ''));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Devices appear automatically from heartbeats');
{
  for (let i = 1; i <= 3; i++) {
    await post('/heartbeat', {
      deviceId: `abcdef${String(i).padStart(26, '0')}`,
      shopName: `محل ${i}`, appVersion: '1.0.0', platform: 'win32',
      licenseStatus: i === 3 ? 'expired' : 'active',
      licenseExpiry: '2027-01-01', readReceipts: [],
    }, { 'X-Client-Key': 'client-key' });
  }
  sent.length = 0;
  await tap('devs:0');
  const list = lastOf('editMessageText');
  const d = dataOf(list);
  check('lists the devices', d.filter(x => x.startsWith('d:')).length === 3, `${d.filter(x => x.startsWith('d:')).length}`);
  check('each row is a tappable device', d.some(x => x.startsWith('d:abcdef')));
  check('status icons are shown', /🟢|🔴/.test(list?.body?.text || '') || buttons(list).some(b => /🟢|🔴/.test(b.text)));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Tapping a device opens its full profile');
{
  sent.length = 0;
  await tap('d:abcdef00000000000000000000000001');
  const m = lastOf('editMessageText');
  const t = m?.body?.text || '';
  const d = dataOf(m);
  check('shows the shop name', t.includes('محل 1'));
  check('shows status and expiry', /الحالة/.test(t) && /ينتهي/.test(t));
  check('shows version and platform', /الإصدار/.test(t) && /النظام/.test(t));
  check('shows first/last seen', /أول ظهور/.test(t) && /آخر ظهور/.test(t));
  check('offers a new code', d.some(x => x.startsWith('nd:')));
  check('offers a private message', d.some(x => x.startsWith('md:')));
  check('offers a per-device setting', d.some(x => x.startsWith('sd:')));
  check('offers navigation back', d.includes('devs:0') && d.includes('main'));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Issuing a code straight from a device profile');
{
  sent.length = 0;
  await tap('nd:abcdef00000000000000000000000001');
  check('jumps to the duration picker', dataOf(lastOf('editMessageText')).includes('dur:90'));
  sent.length = 0;
  await tap('dur:90');
  check('code issued for that device',
    sent.some(s => s.method === 'sendMessage' && /كود التفعيل/.test(s.body.text || '')));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Messaging: broadcast and per-device');
{
  sent.length = 0;
  await tap('msgall');
  await type('صيانة مجدولة غداً');
  check('broadcast confirmed', /تم جدولة الرسالة/.test(lastOf('sendMessage')?.body?.text || ''));

  sent.length = 0;
  await tap('md:abcdef00000000000000000000000002');
  await type('تم تجديد اشتراكك');
  check('private message confirmed', /تم جدولة الرسالة/.test(lastOf('sendMessage')?.body?.text || ''));

  const res = await post('/heartbeat', {
    deviceId: 'abcdef00000000000000000000000002', readReceipts: [],
  }, { 'X-Client-Key': 'client-key' });
  const payload = await res.json();
  const bodies = payload.messages.map(m => m.body);
  check('device receives both messages', bodies.length === 2, JSON.stringify(bodies));
  check('other device gets only the broadcast', await (async () => {
    const r = await post('/heartbeat', { deviceId: 'abcdef00000000000000000000000003', readReceipts: [] },
      { 'X-Client-Key': 'client-key' });
    const p = await r.json();
    return p.messages.length === 1;
  })());
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Remote settings through the menu');
{
  sent.length = 0;
  await tap('setall');
  const keys = dataOf(lastOf('editMessageText'));
  check('offers common keys', keys.some(k => k.includes('dev_phone')) && keys.some(k => k.includes('payment_info')));

  await tap('k:all:dev_phone');
  await type('01099887766');
  check('setting confirmed', /تم ضبط/.test(lastOf('sendMessage')?.body?.text || ''));

  const r = await post('/heartbeat', { deviceId: 'abcdef00000000000000000000000001', readReceipts: [] },
    { 'X-Client-Key': 'client-key' });
  const p = await r.json();
  check('value reaches the device', p.config.all.dev_phone === '01099887766', JSON.stringify(p.config.all));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Pasting a bare device id is understood');
{
  // Step 7 left a prompt waiting for a config value; a real admin would either
  // answer it or press /start. Reset first so this case is tested in isolation.
  await type('/start');
  sent.length = 0;
  await type('abcdef00000000000000000000000001');
  check('known id opens its profile', /محل 1/.test(lastOf('editMessageText')?.body?.text || ''));

  sent.length = 0;
  await type('ffffffffffffffffffffffffffffffff');
  check('unknown id offers to issue a code',
    dataOf(lastOf('sendMessage')).some(d => d.startsWith('dur:')));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Telegram protocol constraints are respected');
{
  const allData = sent.flatMap(s => (s.body?.reply_markup?.inline_keyboard || []).flat())
    .map(b => b.callback_data).filter(Boolean);
  const tooLong = allData.filter(d => Buffer.byteLength(d, 'utf8') > 64);
  check('no callback_data exceeds 64 bytes', tooLong.length === 0, tooLong.join(', '));

  const rows = sent.flatMap(s => s.body?.reply_markup?.inline_keyboard || []);
  check('no row has more than 8 buttons', rows.every(r => r.length <= 8));

  sent.length = 0;
  await tap('stats');
  check('every callback is answered (no stuck spinner)',
    sent.some(s => s.method === 'answerCallbackQuery'));
}

// ---------------------------------------------------------------- 10
console.log('\n[10] Only the owner can drive the bot');
{
  sent.length = 0;
  await post('/telegram', { message: { chat: { id: 999999 }, text: '/start' } }, TG_HEADERS);
  check('a stranger gets no reply at all', sent.length === 0);

  sent.length = 0;
  await post('/telegram', {
    callback_query: { id: 'x', from: { id: 999999 }, data: 'new', message: { message_id: 1 } },
  }, TG_HEADERS);
  check('a stranger cannot tap buttons either', sent.length === 0);

  // The layer BELOW the chat id: a request that never came from Telegram at
  // all. The chat id lives in the body, so it proves nothing on its own —
  // MEASURED, an anonymous POST claiming the owner's id minted a signed
  // ten-year licence. Every delivery must carry the registered secret.
  sent.length = 0;
  await post('/telegram', {
    message: { chat: { id: 7232305465 }, text: '/new deadbeefdeadbeef 3650' },
  });   // no secret header
  check('a forged webhook with no secret mints nothing', sent.length === 0);

  sent.length = 0;
  await post('/telegram', {
    message: { chat: { id: 7232305465 }, text: '/new deadbeefdeadbeef 3650' },
  }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });
  check('a forged webhook with the wrong secret mints nothing', sent.length === 0);

  // ...and the genuine path still works, or the guard has simply killed the bot.
  sent.length = 0;
  await type('/start');
  check('the owner, over a genuine delivery, is still obeyed', sent.length > 0);
}

// ---------------------------------------------------------------- 11
console.log('\n[11] Stale prompts cannot swallow a later command');
{
  sent.length = 0;
  await tap('new');                       // now waiting for a device id
  await type('/start');                   // ...but a command arrives
  const m = lastOf('sendMessage');
  check('/start escapes the pending prompt', /لوحة التحكم/.test(m?.body?.text || ''));
}

// ---------------------------------------------------------------- 12
console.log('\n[12] Message management: list, delete, edit, readers');
{
  // Seed two devices and a broadcast message with one read receipt.
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO devices (device_id, shop_name, license_status) VALUES (?, ?, ?)`)
    .bind('msgtest0000000000000000', '#1: محل القاهرة', 'active').run();
  await env.DB.prepare(`INSERT INTO devices (device_id, shop_name, license_status) VALUES (?, ?, ?)`)
    .bind('msgtest0000000000000001', '#2: محل الأقصر', 'active').run();
  const ins = await env.DB.prepare(`INSERT INTO messages (target, title, body, severity, created_at, updated_at)
    VALUES ('all', 'رسالة تجريبية', 'محتوى تجريبي لا يزال ظاهراً', 'info', ?, ?)`)
    .bind(now, now).run();
  const mid = ins.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO message_reads (message_id, device_id, read_at) VALUES (?, ?, ?)`)
    .bind(mid, 'msgtest0000000000000000', now).run();
  // A second, still-live message — the edit flow needs one that was not
  // deleted, since editing a retracted message is deliberately refused.
  const ins2 = await env.DB.prepare(`INSERT INTO messages (target, title, body, severity, created_at, updated_at)
    VALUES ('all', 'إعلان', 'عروض الأسبوع', 'info', ?, ?)`)
    .bind(now, now).run();
  const mid2 = ins2.meta.last_row_id;

  sent.length = 0;
  await type('/start');
  const menu = dataOf(lastOf('sendMessage'));
  check('the main menu offers message management', menu.includes('msgs'));

  // -- list
  sent.length = 0;
  await tap('msgs');
  const list = lastOf('editMessageText');
  check('the list screen names the seeded message', 
    /#2/.test(list?.body?.text || '') && /رسالة تجريبية/.test(list?.body?.text || ''));
  check('the list shows the real read count (1 of 2 devices)',
    /قرأها 1/.test(list?.body?.text || ''));

  // -- delete
  sent.length = 0;
  await tap('msgdel');
  check('delete asks for the message number',
    /رقم الرسالة/.test(lastOf('editMessageText')?.body?.text || ''));
  await type(String(mid));
  const delMsg = lastOf('sendMessage');
  check('delete confirms', /تم حذف الرسالة/.test(delMsg?.body?.text || ''));
  const afterDel = await env.DB.prepare('SELECT deleted_at FROM messages WHERE id = ?').bind(mid).first();
  check('the message is marked deleted', afterDel?.deleted_at !== null && afterDel?.deleted_at !== undefined);

  // -- edit
  sent.length = 0;
  await tap('msgedit');
  check('edit asks for the message number',
    /رقم الرسالة/.test(lastOf('editMessageText')?.body?.text || ''));
  await type('not-a-number');
  check('a non-numeric id is refused', /رسالة الصحيح/.test(lastOf('sendMessage')?.body?.text || ''));
  await tap('msgedit');
  await type(String(mid2));
  check('edit asks for the new text', /النص الجديد/.test(lastOf('sendMessage')?.body?.text || ''));
  await type('النص المعدل — لا مزيد من التجارب');
  const editMsg = lastOf('sendMessage');
  check('edit confirms', /تم تعديل الرسالة/.test(editMsg?.body?.text || ''));
  const afterEdit = await env.DB.prepare('SELECT body, deleted_at FROM messages WHERE id = ?').bind(mid2).first();
  check('the body is updated', afterEdit?.body === 'النص المعدل — لا مزيد من التجارب');
  await tap('msgedit');
  await type(String(mid));
  const deletedEditPrompt = lastOf('sendMessage');
  check('edit of a deleted id still asks for the text', /النص الجديد/.test(deletedEditPrompt?.body?.text || ''));
  await type('لا يهم');
  check('editing a retracted message is refused', /لا توجد رسالة رقم/.test(lastOf('sendMessage')?.body?.text || ''));

  // -- readers
  sent.length = 0;
  await tap('msgreads');
  check('readers asks for the message number',
    /رقم الرسالة/.test(lastOf('editMessageText')?.body?.text || ''));
  await type('99999');
  check('an unknown message id is reported', /لا توجد رسالة رقم 99999/.test(lastOf('sendMessage')?.body?.text || ''));
  await tap('msgreads');
  await type(String(mid));
  const rd = lastOf('sendMessage');
  check('the report lists who read it', /محل القاهرة/.test(rd?.body?.text || ''));
  const allDevices = (await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first())?.n ?? 0;
  check('the report names the counts', /قرأها: 1/.test(rd?.body?.text || '')
    && (new RegExp(`لم يقرأها: ${allDevices - 1}`)).test(rd?.body?.text || ''));
  check('the report marks the message as deleted', /محذوفة/.test(rd?.body?.text || ''));
}

console.log('\n' + '='.repeat(70));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(70));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
