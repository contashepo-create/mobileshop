#!/usr/bin/env node
/**
 * PRIVATE AUTOMATIC UPDATES, ON THE DEVELOPER'S OWN CLOUDFLARE WORKER.
 *
 * WHY NOT update.electronjs.org
 * -----------------------------
 * The free Electron service requires a PUBLIC GitHub repository. This is a
 * commercial product; a public repository is one anyone can clone, build and
 * give away. So the update feed is served by the SAME Worker that already runs
 * the licensing API and the Telegram bot, behind the SAME client key.
 *
 * WHAT SQUIRREL.WINDOWS ACTUALLY DOES — and the trap in it
 * --------------------------------------------------------
 * `autoUpdater.setFeedURL({ url })` does NOT fetch `url` on Windows. Squirrel
 * appends `/RELEASES` and expects a plain-text NuGet manifest:
 *
 *     <SHA1-UPPERCASE>  <file>.nupkg  <bytes>
 *
 * then downloads that .nupkg RELATIVE to the same directory. A JSON reply —
 * the shape almost everyone writes first — is silently ignored, and the update
 * never happens with no error anywhere. That is why this suite asserts the
 * exact byte format rather than "an update was offered".
 *
 * THE 204 TRAP, FOUND BY THIS SUITE
 * ---------------------------------
 * `new Response('', { status: 204 })` THROWS: the Fetch spec forbids a body on
 * a 204 and both workerd and Node reject it. The router's try/catch turned
 * that throw into a 500, so EVERY up-to-date client — the overwhelming
 * majority, every day — received a server error instead of a quiet "nothing to
 * do". Caught here before it ever shipped, and pinned by [5] below.
 *
 * WHAT IS PROVEN — by running the REAL exported fetch() from server/worker.js
 *   [1] the key is required, on the manifest AND on the binary
 *   [2] an unpublished/current version answers 204, never an error
 *   [3] publishing validates its input
 *   [4] the manifest is byte-exact NuGet format
 *   [5] a current or newer install is never dragged backwards
 *   [6] the package downloads, and cannot be escaped from
 *   [7] an expired subscription stops receiving new versions
 *   [8] the licensing API and the bot still work
 *
 * Run:  node --experimental-strip-types scripts/verify_update_server.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('PRIVATE UPDATE SERVER (Cloudflare Worker)');
console.log('='.repeat(72));

// ------------------------------------------------------------------ 0
console.log('\n[0] The client points at the private feed, not the public service');
{
  const up = raw('src/main/updater.ts');
  // The public service must not be REACHED. It is still named in the comment
  // that explains why it is not used, and that explanation is worth keeping —
  // so this looks for a usable URL, not for the words.
  t('the public service is never contacted',
    !/https?:\/\/update\.electronjs\.org/.test(up));
  t('no hardcoded GitHub repo feed remains',
    !/github\.com\/[\w-]+\/[\w-]+\/releases/.test(up));
  t('the feed is built from the configured API base', /MOBILESHOP_API_BASE/.test(up));
  t('and it sends the client key', /'X-Client-Key': CLIENT_KEY/.test(up));
  // electron-updater (NSIS) appends /latest.yml itself, so the feed must still
  // be a DIRECTORY. A trailing filename would make it fetch
  // `.../${version}/latest.yml/latest.yml`.
  t('the feed is a directory, as electron-updater requires',
    /\/update-nsis\/win32-x64\/\$\{app\.getVersion\(\)\}/.test(up));
  t('an unconfigured build checks nowhere at all',
    /if \(!API_BASE \|\| !CLIENT_KEY\)/.test(up));
  t('the device id is sent so a lapsed licence can be held back',
    /device=\$\{encodeURIComponent\(device\)\}/.test(up));
  t('it is still disabled in development', /if \(!app\.isPackaged\)/.test(up));
  t('and it is actually started', /startUpdater\(\);/.test(raw('src/main/index.ts')));

  const wt = raw('server/wrangler.toml');
  t('an R2 bucket is bound for the packages', /binding = "UPDATES"/.test(wt));
}

// A Worker needs `Request`/`Response`; Node 18+ has them globally.
if (typeof Request !== 'function' || typeof Response !== 'function') {
  console.log('\n  SKIP  this Node build has no fetch API');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/** better-sqlite3, wherever it is installed in this checkout. */
function loadSqlite() {
  for (const base of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { return createRequire(join(base, 'x.js'))('better-sqlite3'); } catch { /* keep looking */ }
  }
  return null;
}
const Database = loadSqlite();
if (!Database) {
  console.log('\n  SKIP  better-sqlite3 is not installed — cannot run the Worker');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const worker = (await import(pathToFileURL(join(ROOT, 'server/worker.js')).href)).default;
const sqlite = new Database(':memory:');

/** A D1 stand-in. Same surface the Worker uses: bind/first/all/run/batch. */
const D1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a.map((v) => (v === undefined ? null : v)); return api; },
      async first() {
        try { return sqlite.prepare(sql).get(...bound) ?? null; }
        catch (e) {
          // CREATE/INSERT via .first() — D1 tolerates it, better-sqlite3 does not.
          if (/returns data|does not return data/.test(e.message)) {
            sqlite.prepare(sql).run(...bound); return null;
          }
          throw e;
        }
      },
      async all() { return { results: sqlite.prepare(sql).all(...bound) }; },
      async run() {
        const r = sqlite.prepare(sql).run(...bound);
        return { meta: { last_row_id: r.lastInsertRowid, changes: r.changes } };
      },
    };
    return api;
  },
  async batch(list) { for (const s of list) await s.run(); return []; },
};

const files = new Map();
const R2 = {
  async get(key) { const b = files.get(key); return b ? { body: b, size: b.length } : null; },
  async put(key, val) { files.set(key, val); },
};

const CLIENT_KEY = 'test-client-key-000000000000';
const ADMIN_KEY = 'test-admin-key-0000000000000';
const env = { DB: D1, UPDATES: R2, CLIENT_KEY, ADMIN_KEY, TG_BOT_TOKEN: '', TG_ADMIN_CHAT: '' };

const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request('https://w.example' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), env);

// ------------------------------------------------------------------ 1
console.log('\n[1] The key is required — on the manifest AND on the binary');
{
  t('no key -> 401', (await call('/update/win32-x64/1.0.0/RELEASES')).status === 401);
  t('wrong key -> 401',
    (await call('/update/win32-x64/1.0.0/RELEASES',
      { headers: { 'X-Client-Key': 'wrong-key-same-length-000000' } })).status === 401);
  t('publishing needs the ADMIN key, not the client key',
    (await call('/release', { method: 'POST', headers: { 'X-Client-Key': CLIENT_KEY },
      body: { version: '9.9.9' } })).status === 401);
}

// ------------------------------------------------------------------ 2
console.log('\n[2] Nothing published yet — a quiet 204, never an error');
{
  const r = await call('/update/win32-x64/1.0.0/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } });
  // The 500 this catches was the real defect: `new Response('', {status:204})`
  // throws, and the router turned it into a server error for every client.
  t('answers 204', r.status === 204, 'got ' + r.status);
}

// ------------------------------------------------------------------ 3
console.log('\n[3] Publishing validates what it is given');
const pkg = Buffer.from('PRETEND-NUPKG-CONTENT'.repeat(50));
const sha1 = createHash('sha1').update(pkg).digest('hex');
{
  await R2.put('win32-x64/MobileShopERP-1.0.1-full.nupkg', pkg);
  const r = await call('/release', {
    method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { version: '1.0.1', filename: 'MobileShopERP-1.0.1-full.nupkg',
      sha1, size: pkg.length, platform: 'win32-x64', notes: 'first' },
  });
  t('a well-formed release is accepted', r.status === 200 && (await r.json()).ok === true);

  const cases = [
    ['a malformed version', { version: 'abc', filename: 'x.nupkg', sha1: 'a'.repeat(40), size: 1 }],
    ['a traversing filename', { version: '1.0.2', filename: '../evil.nupkg', sha1: 'a'.repeat(40), size: 1 }],
    ['a non-package filename', { version: '1.0.2', filename: 'evil.bat', sha1: 'a'.repeat(40), size: 1 }],
    ['a bad hash', { version: '1.0.2', filename: 'x.nupkg', sha1: 'nothex', size: 1 }],
    ['a zero size', { version: '1.0.2', filename: 'x.nupkg', sha1: 'a'.repeat(40), size: 0 }],
  ];
  for (const [name, body] of cases) {
    const res = await call('/release', { method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY }, body });
    t(`${name} is rejected`, res.status === 400, 'got ' + res.status);
  }
}

// ------------------------------------------------------------------ 4
console.log('\n[4] The manifest is byte-exact NuGet format');
{
  const r = await call('/update/win32-x64/1.0.0/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } });
  const text = await r.text();
  t('200 with a body', r.status === 200 && text.length > 0, 'status ' + r.status);
  const m = /^([A-F0-9]{40}) (\S+\.nupkg) (\d+)$/m.exec(text.trim());
  t('exactly "<SHA1> <file>.nupkg <size>"', !!m, JSON.stringify(text));
  t('the hash is upper-case, as Squirrel writes it', !!m && m[1] === sha1.toUpperCase());
  t('the size is the real byte length', !!m && Number(m[3]) === pkg.length);
  t('served as text/plain', /text\/plain/.test(r.headers.get('content-type') || ''));
  // A cached manifest means a release nobody receives until the edge expires.
  t('and never cached', /no-cache/.test(r.headers.get('cache-control') || ''));
}

// ------------------------------------------------------------------ 5
console.log('\n[5] A current — or newer — install is left alone');
{
  t('the same version gets 204',
    (await call('/update/win32-x64/1.0.1/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 204);
  // A tester running a newer build must never be downgraded by the server.
  t('a NEWER local version is never dragged backwards',
    (await call('/update/win32-x64/2.0.0/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 204);
  t('an older version does get the update',
    (await call('/update/win32-x64/0.9.9/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 200);
  // 1.0.10 > 1.0.9 numerically but < as a string; the comparison must be numeric.
  await call('/release', { method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { version: '1.0.10', filename: 'MobileShopERP-1.0.10-full.nupkg', sha1, size: pkg.length, platform: 'win32-x64' } });
  t('versions compare numerically, not as text (1.0.10 > 1.0.9)',
    (await call('/update/win32-x64/1.0.9/RELEASES', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 200);
}

// ------------------------------------------------------------------ 6
console.log('\n[6] The package downloads, and cannot be escaped from');
{
  const r = await call('/update/win32-x64/1.0.0/MobileShopERP-1.0.1-full.nupkg',
    { headers: { 'X-Client-Key': CLIENT_KEY } });
  t('200 with the bytes', r.status === 200, 'got ' + r.status);
  t('the content is what was uploaded',
    Buffer.from(await r.arrayBuffer()).length === pkg.length);
  t('the binary needs the key too — not just the manifest',
    (await call('/update/win32-x64/1.0.0/MobileShopERP-1.0.1-full.nupkg')).status === 401);
  for (const evil of ['..%2F..%2Fsecret.nupkg', 'a%2F..%2Fb.nupkg']) {
    const res = await call(`/update/win32-x64/1.0.0/${evil}`, { headers: { 'X-Client-Key': CLIENT_KEY } });
    t(`traversal "${evil}" is refused`, res.status === 400 || res.status === 404, 'got ' + res.status);
  }

  // The PLATFORM segment is attacker-controlled too, and it is concatenated
  // into the same R2 key. Checking only the filename was measured to be
  // insufficient: `URL` collapses `../` before the Worker sees the path, so
  // `/update/win32-x64/1.0.0/../../SECRET/private.key.nupkg` arrives as
  // `/update/SECRET/private.key.nupkg` — an ordinary-looking filename with the
  // traversal now sitting in the platform. That handed out any object in the
  // bucket, including anything else ever stored there.
  await R2.put('SECRET/private.key.nupkg', Buffer.from('KEY-MATERIAL'));
  for (const p of [
    '/update/win32-x64/1.0.0/../../SECRET/private.key.nupkg',
    '/update/SECRET/1.0.0/private.key.nupkg',
    '/update/..%2FSECRET/1.0.0/x.nupkg',
  ]) {
    const res = await call(p, { headers: { 'X-Client-Key': CLIENT_KEY } });
    const leaked = res.status === 200 && (await res.text()).includes('KEY-MATERIAL');
    t(`"${p}" cannot read outside the platform prefix`, !leaked, 'status ' + res.status);
  }
  t('an unknown platform is refused',
    (await call('/update/solaris-sparc/1.0.0/x.nupkg',
      { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 400);
  // ...and the legitimate path must still work after all that tightening.
  t('a real package still downloads',
    (await call('/update/win32-x64/1.0.0/MobileShopERP-1.0.1-full.nupkg',
      { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 200);
  t('a missing package is a 404, not a crash',
    (await call('/update/win32-x64/1.0.0/NoSuchPackage-9.9.9-full.nupkg',
      { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 404);
}

// ------------------------------------------------------------------ 7
console.log('\n[7] Subscription control');
{
  sqlite.prepare(`INSERT INTO devices (device_id, license_status, license_expiry, first_seen, last_seen, seen_count)
    VALUES ('expireddevice1234567890abcdef', 'active', '2020-01-01', '', '', 1)`).run();
  sqlite.prepare(`INSERT INTO devices (device_id, license_status, license_expiry, first_seen, last_seen, seen_count)
    VALUES ('activedevice1234567890abcdef0', 'active', '2099-01-01', '', '', 1)`).run();
  sqlite.prepare(`INSERT INTO devices (device_id, license_status, license_expiry, first_seen, last_seen, seen_count)
    VALUES ('blockeddevice1234567890abcdef', 'blocked', '2099-01-01', '', '', 1)`).run();

  const q = (d) => call(`/update/win32-x64/1.0.0/RELEASES?device=${d}`,
    { headers: { 'X-Client-Key': CLIENT_KEY } });
  t('an EXPIRED licence receives no new version', (await q('expireddevice1234567890abcdef')).status === 204);
  t('a BLOCKED device receives no new version', (await q('blockeddevice1234567890abcdef')).status === 204);
  t('an ACTIVE licence does', (await q('activedevice1234567890abcdef0')).status === 200);
  // A fresh install has not sent its first heartbeat. Refusing it would strand
  // exactly the customers who most need the current build.
  t('a brand-new install is NOT locked out', (await q('neverseenthisdevice0000000000')).status === 200);
}

// ------------------------------------------------------------------ 8
console.log('\n[8] The licensing API and the bot are unaffected');
{
  t('/health still answers', (await call('/health')).status === 200);
  const hb = await call('/heartbeat', { method: 'POST',
    headers: { 'X-Client-Key': CLIENT_KEY },
    body: { deviceId: 'activedevice1234567890abcdef0', appVersion: '1.0.0' } });
  const hj = await hb.json();
  t('/heartbeat still works', hb.status === 200 && hj.ok === true);
  // Publishing also advertises the version, so the About screen can say a new
  // one exists before Squirrel has finished downloading it.
  t('and the newest version is advertised to the About screen',
    hj.config?.all?.latest_version === '1.0.10', JSON.stringify(hj.config?.all));
  t('an unknown path is still a 404', (await call('/nope')).status === 404);
  t('the telegram route is still registered', /case '\/telegram'/.test(raw('server/worker.js')));
}

// ------------------------------------------------------------------ 9
console.log('\n[9] Fast lane (code push): manifest, object, gating, admin guard');
{
  const code = Buffer.from('FAKE-ASAR-BYTES'.repeat(1000));
  const sha256 = createHash('sha256').update(code).digest('hex');

  // Publishing requires the ADMIN key — the caller uploads the .asar to R2,
  // then tells the Worker the metadata. Note the .asar exists BEFORE the
  // metadata, so a half-uploaded object can never be advertised.
  await R2.put('code/win32-x64/1.0.5.asar', code);
  const bad = await call('/release-code', {
    method: 'POST', headers: { 'X-Client-Key': CLIENT_KEY },
    body: { version: '1.0.5' }, // wrong credential path
  });
  t('a code release needs the ADMIN key', bad.status === 401, 'got ' + bad.status);

  const ok = await call('/release-code', {
    method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { platform: 'win32-x64', version: '1.0.5', sha256,
      size: code.length, min_app_version: '1.0.4', notes: 'badge fix' },
  });
  t('a well-formed code release is accepted', ok.status === 200 && (await ok.json()).ok === true);

  const relCases = [
    ['a bad sha256', { version: '1.0.6', sha256: 'zz', size: 1, min_app_version: '1.0.4' }],
    ['a zero size', { version: '1.0.6', sha256: 'a'.repeat(64), size: 0, min_app_version: '1.0.4' }],
    ['a bad min_app_version', { version: '1.0.6', sha256: 'a'.repeat(64), size: 1, min_app_version: 'x.y' }],
    ['a malformed version', { version: 'abc', sha256: 'a'.repeat(64), size: 1 }],
  ];
  for (const [name, body] of relCases) {
    const r = await call('/release-code', { method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY }, body: { platform: 'win32-x64', ...body } });
    t(`/${name} is rejected`, r.status === 400, 'got ' + r.status);
  }

  const manifest = async (from) =>
    call('/code-update/win32-x64/' + from + '/manifest.json',
      { headers: { 'X-Client-Key': CLIENT_KEY } });

  t('an up-to-date code client gets 204',
    (await manifest('1.0.5')).status === 204);
  t('a newer code client is never dragged backwards',
    (await manifest('2.0.0')).status === 204);
  const m = await manifest('1.0.4');
  const mj = await m.json().catch(() => null);
  t('an older client gets 200 with the manifest', m.status === 200 && !!mj,
    'status ' + m.status);
  t('the manifest names the exact asar, hash, size and min_app_version',
    mj && mj.version === '1.0.5' && mj.asar === '/code/win32-x64/1.0.5.asar'
      && mj.sha256 === sha256 && mj.size === code.length
      && mj.min_app_version === '1.0.4');
  t('the code manifest needs the key too',
    (await call('/code-update/win32-x64/1.0.4/manifest.json')).status === 401);

  const f = await call('/code/win32-x64/1.0.5.asar',
    { headers: { 'X-Client-Key': CLIENT_KEY } });
  t('the code object downloads', f.status === 200
      && Buffer.from(await f.arrayBuffer()).equals(code));
  t('a bad asar name is refused',
    (await call('/code/win32-x64/../1.0.5.asar', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 400);
  t('a missing version is a 404, not a crash',
    (await call('/code/win32-x64/9.9.9.asar', { headers: { 'X-Client-Key': CLIENT_KEY } })).status === 404);

  // Subscription gating: the code feed uses the SAME device rules as full.
  const expired = await call('/code-update/win32-x64/1.0.4/manifest.json?device=expireddevice1234567890abcdef',
    { headers: { 'X-Client-Key': CLIENT_KEY } });
  t('an EXPIRED licence gets no code push', expired.status === 204);
  await call('/release-code', { method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { platform: 'win32-x64', version: '1.0.6', sha256: 'b'.repeat(64),
      size: code.length, min_app_version: '1.0.5' } });
  // A code push older than the last full build must NOT overwrite the About
  // screen's advertised version (the full 1.0.10 dominates).
  const hb2 = await call('/heartbeat', { method: 'POST',
    headers: { 'X-Client-Key': CLIENT_KEY },
    body: { deviceId: 'activedevice1234567890abcdef0', appVersion: '1.0.10' } });
  const hj2 = await hb2.json();
  t('a code version older than the full build never hides the full build',
    hj2.config?.all?.latest_version === '1.0.10', JSON.stringify(hj2.config?.all));
}

// ------------------------------------------------------------------ 10
console.log('\n[10] Message lifecycle: edit, delete, read tracking');
{
  const admin = { 'X-Admin-Key': ADMIN_KEY };
  const client = { 'X-Client-Key': CLIENT_KEY };
  const DEV_A = 'msgdev00000000000000000000';
  const DEV_B = 'msgdev00000000000000000001';

  t('message admin actions need the ADMIN key',
    (await call('/message', { method: 'POST', headers: { 'X-Client-Key': CLIENT_KEY },
      body: { action: 'list' } })).status === 401);
  t('an unknown action is refused',
    (await call('/message', { method: 'POST', headers: admin,
      body: { action: 'spam' } })).status === 400);

  const created = await call('/message', { method: 'POST', headers: admin,
    body: { title: 'صيانة الليلة', body: 'صيانة السيرفر الساعة 2 صباحاً', severity: 'warning' } });
  const createdJson = await created.json();
  const id = createdJson.id;
  t('a message is created', created.status === 200 && Number.isInteger(id));
  t('a create with no content is refused',
    (await call('/message', { method: 'POST', headers: admin, body: {} })).status === 400);

  // Both devices check in and receive the message unread.
  const hbA1 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial' } });
  const hA1 = await hbA1.json();
  const hbB1 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_B, licenseStatus: 'trial' } });
  const hB1 = await hbB1.json();
  t('a fresh install receives the message unread',
    hA1.ok === true && hA1.messages?.some(m => m.id === id && m.body.includes('صيانة')));
  t('both devices receive a broadcast', hB1.messages?.some(m => m.id === id));

  // A reads it; B has not.
  const hbA2 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial', readReceipts: [id] } });
  const hA2 = await hbA2.json();
  t('after the receipt the message is no longer listed for its reader',
    hA2.ok === true && !hA2.messages?.some(m => m.id === id));

  const reads1 = await call('/message', { method: 'POST', headers: admin, body: { action: 'reads', id } });
  const r1 = await reads1.json();
  t('reads lists the device that read it',
    reads1.status === 200 && r1.read?.some(r => r.deviceId === DEV_A));
  t('reads counts the reader', r1.readCount === 1, JSON.stringify(r1));
  const devTotal = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first();
  t('reads counts the unread device', r1.unreadCount === (devTotal?.n ?? 0) - 1, JSON.stringify(r1));

  // Edit: the corrected text reaches BOTH the reader (revision) and the
  // unread device (message), and neither gets re-flagged as unread.
  const edit = await call('/message', { method: 'POST', headers: admin,
    body: { action: 'edit', id, body: 'الصيانة أُلغيت — شكراً لتفهمكم' } });
  t('an edit is accepted', edit.status === 200 && (await edit.json()).ok === true);
  t('editing nothing is refused',
    (await call('/message', { method: 'POST', headers: admin, body: { action: 'edit', id } })).status === 400);
  t('editing an unknown id is a 404',
    (await call('/message', { method: 'POST', headers: admin,
      body: { action: 'edit', id: 9999, body: 'x' } })).status === 404);

  const hbA3 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial' } });
  const hA3 = await hbA3.json();
  const rev = hA3.messageRevisions?.find(m => m.id === id);
  t('the revision carries the new body to the reader', !!rev && rev.body.includes('أُلغيت'));
  t('the edited message is not re-listed as unread', !hA3.messages?.some(m => m.id === id));

  const hbB2 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_B, licenseStatus: 'trial' } });
  const hB2 = await hbB2.json();
  t('an unread device sees the corrected text too',
    hB2.messages?.some(m => m.id === id && m.body.includes('أُلغيت')));

  // Delete: the tombstone reaches the reader AND the unread device.
  const del = await call('/message', { method: 'POST', headers: admin, body: { action: 'delete', id } });
  t('a delete is accepted', del.status === 200 && (await del.json()).ok === true);
  t('a bad id is refused',
    (await call('/message', { method: 'POST', headers: admin,
      body: { action: 'delete', id: 'abc' } })).status === 400);
  t('deleting an unknown id is a 404',
    (await call('/message', { method: 'POST', headers: admin,
      body: { action: 'delete', id: 9999 } })).status === 404);

  const hbA4 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial' } });
  const hA4 = await hbA4.json();
  t('the reader receives the tombstone', hA4.ok === true && hA4.messageDeletes?.includes(id));
  t('the deleted message is gone from the revisions', !hA4.messageRevisions?.some(m => m.id === id));
  const hbB3 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_B, licenseStatus: 'trial' } });
  const hB3 = await hbB3.json();
  t('an unread device that saw the message receives the tombstone too',
    hB3.messageDeletes?.includes(id));
  t('the deleted message is gone from the unread list', !hB3.messages?.some(m => m.id === id));

  // reads reflects the deletion, and the receipt history survives it.
  const reads2 = await call('/message', { method: 'POST', headers: admin, body: { action: 'reads', id } });
  const r2 = await reads2.json();
  t('reads still reports the readers after a delete',
    r2.ok === true && r2.deleted === true && r2.readCount === 1);

  // Targeted messages: only the addressed device sees it (list, revisions, tombstone).
  const T_A = await call('/message', { method: 'POST', headers: admin,
    body: { title: 'خاص', body: 'خاص بالجهاز أ', target: DEV_A } });
  const tAId = (await T_A.json()).id;
  await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial' } });
  await call('/message', { method: 'POST', headers: admin, body: { action: 'delete', id: tAId } });
  const hbB4 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_B, licenseStatus: 'trial' } });
  const hB4 = await hbB4.json();
  t('a targeted message never reaches another device',
    !hB4.messages?.some(m => m.id === tAId)
    && !hB4.messageRevisions?.some(m => m.id === tAId));
  t('a targeted tombstone never leaks to another device',
    !hB4.messageDeletes?.includes(tAId));
  const hbA5 = await call('/heartbeat', { method: 'POST', headers: client,
    body: { deviceId: DEV_A, licenseStatus: 'trial' } });
  const hA5 = await hbA5.json();
  t('the addressed device does get the targeted tombstone',
    hA5.messageDeletes?.includes(tAId));

  const list = await call('/message', { method: 'POST', headers: admin, body: { action: 'list' } });
  const listJson = await list.json();
  t('list returns the messages with their read counts',
    list.status === 200 && listJson.messages?.some(m => m.id === id && m.readCount === 1 && m.deletedAt));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
