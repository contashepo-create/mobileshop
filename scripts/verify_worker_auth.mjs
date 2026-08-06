#!/usr/bin/env node
/**
 * WORKER AUTHENTICATION — proved by CALLING the worker, not by reading it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The licensing worker is the one component of this product that is exposed to
 * the open internet. Everything else is a desktop application behind the
 * operating system's own boundaries; `mobileshop-licensing.workers.dev` answers
 * anyone in the world.
 *
 * Its authorisation had only ever been checked by grepping for `ADMIN_KEY` and
 * `CLIENT_KEY` near each handler. That proves a string is present in the file.
 * It does not prove the check RUNS, that it runs BEFORE the work, that it is
 * the RIGHT key for that route, or that the refusal says nothing useful. A
 * handler could read the header, ignore the result, and still match.
 *
 * So this suite imports the worker's real exported `fetch` and calls it with a
 * stub `env` — a fake D1 that answers plausibly, and no network. Each route is
 * called three ways:
 *
 *     with no key            must be refused
 *     with the WRONG key     must be refused
 *     with the CLIENT key    admin routes must still refuse it
 *
 * The last one is the one a grep can never see: `/issue` mints licences and
 * `/devices` lists every customer, and the client key is shipped inside every
 * copy of the application, so it is known to anyone who has the product.
 *
 * Run:  node --experimental-strip-types scripts/verify_worker_auth.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

const worker = (await import(pathToFileURL(join(ROOT, 'server/worker.js')).href)).default;

/**
 * Every outbound call the worker makes, captured.
 *
 * The bot's ONLY observable effect is a POST to api.telegram.org, so a suite
 * that cannot see that cannot tell whether the webhook obeyed a stranger. It
 * was measured: a mutant that removed the chat-id check entirely SURVIVED,
 * because the handler still answered `{ok: true}` either way — the difference
 * was invisible without watching the network.
 */
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: init?.body ? String(init.body) : '' });
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const ADMIN = 'ADMIN-KEY-FOR-THE-TEST-0000000000000000000000';
const CLIENT = 'CLIENT-KEY-FOR-THE-TEST-000000000000000000000';
const WEBHOOK_SECRET = 'WEBHOOK-SECRET-FOR-THE-TEST-00000000000000';

/** A D1 stand-in: every statement answers empty but plausibly. */
const makeDb = () => {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({ success: true, meta: { changes: 0 } }),
  };
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({}) };
};

const makeEnv = () => ({
  DB: makeDb(),
  UPDATES: {
    get: async () => null,
    put: async () => ({}),
    list: async () => ({ objects: [] }),
  },
  ADMIN_KEY: ADMIN,
  CLIENT_KEY: CLIENT,
  LICENSE_PRIVATE_KEY: '',
  // A NON-EMPTY token on purpose. `tgCall` returns immediately when the token
  // is blank, so an env without one makes the bot silent for every caller —
  // and a suite that watches outbound messages would then see nothing whether
  // the chat-id check passed or failed. Measured: with a blank token the
  // "the real admin IS obeyed" check failed even on correct code, and a mutant
  // that deleted the check entirely still SURVIVED. The value is fake; nothing
  // leaves this process because `fetch` is stubbed above.
  TG_BOT_TOKEN: 'TEST-TOKEN-NOT-A-REAL-BOT',
  TG_ADMIN_CHAT: '7232305465',
  TG_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

const callWorker = async (method, path, { headers = {}, body } = {}) => {
  const req = new Request('https://example.workers.dev' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, makeEnv());
  let text = '';
  try { text = await res.text(); } catch { /* empty body */ }
  return { status: res.status, text };
};

/** A refusal is a 401/403, or a body that says it is not authorised. */
const refused = (r) =>
  r.status === 401 || r.status === 403
  || /unauthor|forbidden|غير مصرّح|غير مصرح/i.test(r.text);

// ---------------------------------------------------------------------------
console.log('\n── 1. admin routes refuse anyone without the ADMIN key ──');
// ---------------------------------------------------------------------------
{
  const ADMIN_ROUTES = [
    ['POST', '/issue', { deviceId: 'D1', days: 30 }],
    ['POST', '/config', { deviceId: 'D1', settings: {} }],
    ['POST', '/message', { deviceId: 'D1', text: 'hello' }],
    ['POST', '/release', { version: '1.0.0' }],
    ['GET', '/devices', undefined],
  ];
  for (const [method, path, body] of ADMIN_ROUTES) {
    const none = await callWorker(method, path, { body });
    ok(`${method} ${path} refuses a caller with no key`, refused(none),
      `status ${none.status} ${none.text.slice(0, 90)}`);

    const wrong = await callWorker(method, path, { headers: { 'X-Admin-Key': 'wrong' }, body });
    ok(`${method} ${path} refuses the wrong admin key`, refused(wrong),
      `status ${wrong.status} ${wrong.text.slice(0, 90)}`);

    // THE CHECK A GREP CANNOT MAKE. The client key ships inside every copy of
    // the application, so treating it as an admin credential would hand
    // licence minting and the whole customer list to every user.
    const client = await callWorker(method, path, { headers: { 'X-Client-Key': CLIENT }, body });
    ok(`${method} ${path} does not accept the shipped CLIENT key`, refused(client),
      `status ${client.status} ${client.text.slice(0, 90)}`);

    // ...and the correct key must NOT be refused, or the check is just "deny".
    const good = await callWorker(method, path, { headers: { 'X-Admin-Key': ADMIN }, body });
    ok(`${method} ${path} accepts the correct admin key`, !refused(good),
      `status ${good.status} ${good.text.slice(0, 90)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('── 2. client routes refuse anyone without the CLIENT key ──');
// ---------------------------------------------------------------------------
{
  const CLIENT_ROUTES = [
    ['POST', '/heartbeat', { deviceId: 'D1' }],
    ['POST', '/database-reset', { deviceId: 'D1' }],
    ['POST', '/registration', { deviceId: 'D1' }],
    ['GET', '/update/RELEASES', undefined],
    ['GET', '/update/app-1.0.0-full.nupkg', undefined],
  ];
  for (const [method, path, body] of CLIENT_ROUTES) {
    const none = await callWorker(method, path, { body });
    ok(`${method} ${path} refuses a caller with no key`, refused(none),
      `status ${none.status} ${none.text.slice(0, 90)}`);

    const wrong = await callWorker(method, path, { headers: { 'X-Client-Key': 'wrong' }, body });
    ok(`${method} ${path} refuses the wrong client key`, refused(wrong),
      `status ${wrong.status} ${wrong.text.slice(0, 90)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('── 3. a refusal describes nothing ──');
// ---------------------------------------------------------------------------
{
  // An unauthenticated caller must not learn the schema, the file layout or
  // whether a device exists. This was a real defect: the catch-all returned
  // `String(err.message)` and every endpoint answered
  // `D1_ERROR: no such table: devices at /worker/db.js:412`.
  const probes = [
    ['POST', '/issue', undefined],
    ['GET', '/devices', undefined],
    ['POST', '/heartbeat', undefined],
    ['GET', '/health', undefined],
    ['GET', '/nonexistent', undefined],
  ];
  const LEAKS = /D1_ERROR|no such table|SQLITE|\.js:\d+|\/worker\/|at Object\.|stack|SELECT |INSERT |sqlite_master/i;
  for (const [method, path, body] of probes) {
    const r = await callWorker(method, path, { body });
    ok(`${method} ${path} leaks no internal detail`, !LEAKS.test(r.text),
      r.text.slice(0, 120));
  }

  // A thrown fault must still not describe itself. Force one by handing the
  // worker a database that throws on every statement.
  const exploding = {
    ...makeEnv(),
    DB: { prepare: () => { throw new Error('D1_ERROR: no such table: devices at /worker/db.js:412'); } },
  };
  const req = new Request('https://example.workers.dev/health');
  const res = await worker.fetch(req, exploding);
  const text = await res.text();
  ok('a thrown fault does not reach the caller', !LEAKS.test(text), text.slice(0, 140));
  ok('a thrown fault still carries a support reference', /ref/i.test(text), text.slice(0, 140));
}

// ---------------------------------------------------------------------------
console.log('── 4. the key comparison is constant-time ──');
// ---------------------------------------------------------------------------
{
  // A `===` on a secret leaks its length and its prefix to a caller who can
  // time the reply. The source is read here ONLY to locate the function; the
  // property itself is then proved by running it.
  const src = readFileSync(join(ROOT, 'server/worker.js'), 'utf8');
  const at = src.indexOf('function safeEqual');
  ok('the worker has a dedicated key-comparison function', at >= 0);
  if (at >= 0) {
    const open = src.indexOf('{', at);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const body = src.slice(at, end);
    const mod = await import('data:text/javascript,'
      + encodeURIComponent(body + '\nexport default safeEqual;'));
    const eq = mod.default;

    ok('safeEqual matches an identical string', eq('abc', 'abc') === true);
    ok('safeEqual rejects a different string', eq('abc', 'abd') === false);
    ok('safeEqual rejects a prefix', eq('abc', 'ab') === false);
    ok('safeEqual rejects a longer string', eq('abc', 'abcd') === false);
    // Both sides matter, and both must be refused OUTRIGHT rather than
    // compared. `env.ADMIN_KEY` is `undefined` on a worker deployed without
    // its secret set — if `safeEqual(undefined, undefined)` were true, that
    // worker would accept a request with no key header at all, which is the
    // single worst failure this function can have.
    for (const [a, b, why] of [
      [undefined, 'abc', 'undefined header'],
      ['abc', undefined, 'undefined secret'],
      [undefined, undefined, 'BOTH undefined — an unconfigured worker'],
      [null, null, 'both null'],
      [null, 'abc', 'null header'],
      [123, 123, 'both numbers'],
      [{}, {}, 'both objects'],
      [['abc'], 'abc', 'an array that stringifies to the key'],
      [{ toString: () => 'abc' }, 'abc', 'an object that claims to be the key'],
    ]) {
      ok(`safeEqual refuses ${why}`, eq(a, b) === false,
        `it returned true for ${String(a)} vs ${String(b)}`);
    }
    // It must not short-circuit on the first differing byte: two strings of
    // equal length must cost the same whether they differ at the start or the
    // end. Proved structurally — the loop has no early return.
    ok('safeEqual has no early exit inside its loop',
      !/for\s*\([^)]*\)\s*\{[^}]*return/.test(body.replace(/\n/g, ' ')),
      'an early return re-introduces the timing signal');
  }
}

// ---------------------------------------------------------------------------
console.log('── 5. the telegram webhook only obeys the admin chats ──');
// ---------------------------------------------------------------------------
{
  // `/telegram` cannot use a header key — Telegram will not send one — so its
  // whole defence is the chat id in the payload. A stranger who finds the URL
  // must be answered with nothing.
  //
  // The reply body is NOT the property to test: the handler answers
  // `{ok: true}` to everyone on purpose, so that a prober cannot tell a valid
  // chat from an invalid one. The real question is whether the bot ACTED, and
  // the only way to see that is to watch what it sent. A mutant that deleted
  // the chat-id check survived a body-only assertion.
  const ADMIN_CHAT = '7232305465';

  sent.length = 0;
  const stranger = await callWorker('POST', '/telegram', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: { message: { chat: { id: 999999 }, text: '/devices' } },
  });
  const strangerSends = sent.filter(s => s.url.includes('api.telegram.org'));
  ok('an unknown chat id gets no data back', !/device|licen|shop|expiry/i.test(stranger.text),
    stranger.text.slice(0, 120));
  ok('an unknown chat id is not told it was rejected', stranger.status === 200,
    `status ${stranger.status} — a distinct status confirms the endpoint to a prober`);
  ok('the bot SENDS NOTHING in reply to an unknown chat id', strangerSends.length === 0,
    `${strangerSends.length} outbound message(s): ` + strangerSends.map(s => s.body.slice(0, 70)).join(' | '));

  // A stranger must not be able to make the bot answer the OWNER either — that
  // would turn the public URL into a way to spam or mislead the shop.
  ok('nothing was sent to the admin chat on behalf of a stranger',
    !strangerSends.some(s => s.body.includes(ADMIN_CHAT)),
    strangerSends.map(s => s.body.slice(0, 70)).join(' | '));

  // A chat id that is a prefix, a suffix, or a look-alike of the admin id must
  // not be accepted. `includes` on a joined string would let these through.
  for (const near of ['723230546', '72323054650', ' 7232305465', '7232305465x', '+7232305465']) {
    sent.length = 0;
    await callWorker('POST', '/telegram', {
      headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: { message: { chat: { id: near }, text: '/devices' } },
    });
    const n = sent.filter(s => s.url.includes('api.telegram.org')).length;
    ok(`chat id "${near}" is not mistaken for the admin`, n === 0, `${n} outbound message(s)`);
  }

  // ...and the real admin MUST be obeyed, or the check is just "deny everyone"
  // and the bot does not work at all.
  sent.length = 0;
  await callWorker('POST', '/telegram', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: { message: { chat: { id: Number(ADMIN_CHAT) }, text: '/start' } },
  });
  const adminSends = sent.filter(s => s.url.includes('api.telegram.org'));
  ok('the real admin chat IS obeyed', adminSends.length > 0,
    'the bot answered nobody — the webhook is dead, not secure');
}

// ---------------------------------------------------------------------------
console.log('── 5b. a forged webhook cannot drive the bot ──');
// ---------------------------------------------------------------------------
{
  // THE EXPLOIT THIS CLOSES, measured against the real exported `fetch`:
  //
  //   POST /telegram   (no credential of any kind)
  //   {"message":{"chat":{"id":7232305465},"text":"/new deadbeefdeadbeef 3650"}}
  //   -> 200 {"ok":true}
  //   -> outbound: "كود التفعيل الخاص بك: 2YN0-0001-CMKM-MVE8-..."
  //
  // A signed ten-year licence, minted by an anonymous caller. The chat id is
  // not a secret; the body is written by whoever sends the request.
  const ADMIN_CHAT = '7232305465';
  const MINT = { message: { chat: { id: Number(ADMIN_CHAT) }, text: '/new deadbeefdeadbeef 3650' } };

  const forgeries = [
    ['no secret header at all', {}],
    ['an empty secret header', { 'X-Telegram-Bot-Api-Secret-Token': '' }],
    ['a wrong secret', { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }],
    ['a prefix of the secret', { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET.slice(0, -1) }],
    ['the secret with an extra character', { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET + 'x' }],
    // NOT tested: the secret with trailing whitespace. It was, and it failed —
    // correctly. RFC 9110 makes optional whitespace around a field value part
    // of the framing, not the value, so `Headers` strips it before any code
    // here runs: `new Request(..., {headers: {'X-T': 'SECRET '}})` reads back
    // as exactly `"SECRET"`. The request is therefore genuine by the time it
    // arrives, and demanding a refusal would have been asserting a property of
    // HTTP that is not true.
    ['the ADMIN key in the wrong header', { 'X-Telegram-Bot-Api-Secret-Token': ADMIN }],
    ['the admin key in its own header', { 'X-Admin-Key': ADMIN }],
  ];
  for (const [why, headers] of forgeries) {
    sent.length = 0;
    const r = await callWorker('POST', '/telegram', { headers, body: MINT });
    const out = sent.filter(s => s.url.includes('api.telegram.org'));
    ok(`a forged webhook with ${why} mints nothing`, out.length === 0,
      `${out.length} outbound call(s): ` + out.map(s => s.body.slice(0, 80)).join(' | '));
    ok(`a forged webhook with ${why} is not distinguishable from a valid one`, r.status === 200,
      `status ${r.status} tells a prober the header is what is missing`);
  }

  // The refusal must FAIL CLOSED when the secret is not configured. An
  // unconfigured deployment refusing everything is a fault the owner reports;
  // an unconfigured deployment accepting everything is the original hole.
  {
    const envNoSecret = { ...makeEnv(), TG_WEBHOOK_SECRET: undefined };
    sent.length = 0;
    const req = new Request('https://example.workers.dev/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MINT),
    });
    await worker.fetch(req, envNoSecret);
    const out = sent.filter(s => s.url.includes('api.telegram.org'));
    ok('an UNCONFIGURED webhook secret refuses everything (fails closed)', out.length === 0,
      `${out.length} outbound call(s) — the worker accepts any payload when unconfigured`);
  }

  // ...and the genuine delivery still works, or the fix has simply broken the
  // bot. This is the pairing every guard in this project is held to.
  sent.length = 0;
  await callWorker('POST', '/telegram', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: { message: { chat: { id: Number(ADMIN_CHAT) }, text: '/start' } },
  });
  ok('a genuine Telegram delivery from the owner still works',
    sent.filter(s => s.url.includes('api.telegram.org')).length > 0,
    'the bot no longer answers its owner');
}

// ---------------------------------------------------------------------------
console.log('── 6. the admin chat list only accepts numeric ids ──');
// ---------------------------------------------------------------------------
{
  // TG_ADMIN_CHAT is a comma-separated list. A blank, a stray comma or a
  // pasted username must not become an entry — every id in that list has FULL
  // control of the bot, and `''` matching `''` would hand it to any payload
  // with no chat id at all.
  const src = readFileSync(join(ROOT, 'server/worker.js'), 'utf8');
  const at = src.indexOf('function adminChats');
  ok('the worker parses its admin list in one place', at >= 0);
  if (at >= 0) {
    const open = src.indexOf('{', at);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const mod = await import('data:text/javascript,'
      + encodeURIComponent(src.slice(at, end) + '\nexport default adminChats;'));
    const adminChats = mod.default;

    ok('a normal list parses', JSON.stringify(adminChats({ TG_ADMIN_CHAT: '7232305465,1593943219' }))
      === JSON.stringify(['7232305465', '1593943219']));
    ok('surrounding spaces are tolerated',
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: ' 7232305465 , 1593943219 ' }))
      === JSON.stringify(['7232305465', '1593943219']));
    ok('an empty setting yields no admins',
      adminChats({ TG_ADMIN_CHAT: '' }).length === 0);
    ok('a missing setting yields no admins',
      adminChats({}).length === 0);
    ok('stray commas do not become blank admins',
      adminChats({ TG_ADMIN_CHAT: ',,7232305465,,' }).length === 1,
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: ',,7232305465,,' })));
    ok('a username is not accepted as a chat id',
      adminChats({ TG_ADMIN_CHAT: '@Acc_Mohamedabdou' }).length === 0,
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: '@Acc_Mohamedabdou' })));
    ok('a short number is not accepted',
      adminChats({ TG_ADMIN_CHAT: '123' }).length === 0);
    ok('a non-numeric entry is dropped but a valid neighbour survives',
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: 'abc,7232305465' })) === JSON.stringify(['7232305465']),
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: 'abc,7232305465' })));
    // A negative id is a Telegram GROUP chat, which is legitimate.
    ok('a group chat id is accepted',
      JSON.stringify(adminChats({ TG_ADMIN_CHAT: '-1001234567' })) === JSON.stringify(['-1001234567']));
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — every worker route was CALLED, not read`);
