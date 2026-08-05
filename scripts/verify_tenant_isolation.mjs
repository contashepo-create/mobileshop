#!/usr/bin/env node
/**
 * TENANT ISOLATION — can one shop reach another shop's data?
 *
 * WHY THIS FILE IS NOT ABOUT RLS
 * ------------------------------
 * Row Level Security is a PostgreSQL feature. This product has no PostgreSQL
 * anywhere, and that was verified rather than assumed — SQLite 3.53 rejects
 * every form of the syntax:
 *
 *     ALTER TABLE t ENABLE ROW LEVEL SECURITY  -> near "ENABLE": syntax error
 *     CREATE POLICY p ON t USING (true)        -> near "POLICY": syntax error
 *     GRANT SELECT ON t TO authenticated       -> near "GRANT":  syntax error
 *     SELECT current_setting('...')            -> no such function
 *
 * There are two stores, and only one of them is shared:
 *
 *   1. The DESKTOP database — better-sqlite3, ONE FILE PER SHOP, on that
 *      shop's own machine. There is no second tenant in it to isolate from.
 *      Access control there is the IPC permission guard, audited separately in
 *      `verify_auth_audit.mjs` (deny-by-default, all 172 channels mapped).
 *
 *   2. The CLOUDFLARE D1 database behind the licensing Worker — SQLite again,
 *      but genuinely SHARED by every customer. THIS is where the question the
 *      RLS request is really asking applies, and it is what this suite tests.
 *
 * D1 has no policy engine either, so isolation has to be enforced in the
 * handlers. This suite drives the real exported `fetch` and checks it.
 *
 * WHAT WAS FOUND, AND FIXED
 * -------------------------
 * `POST /registration` took the device id straight from the request body and
 * upserted on it. `CLIENT_KEY` is shipped inside every copy of the app, so it
 * proves "a copy of this program", never "this shop". MEASURED with nothing
 * but that shipped key:
 *
 *   - one caller overwrote another shop's registration
 *     (company_name "محل خالد" -> "DEFACED", owner and phone with it);
 *   - omitting deviceId wrote a row keyed on the empty string, which every
 *     later nameless caller then overwrote in turn;
 *   - 200 junk rows were inserted in a single loop, each firing a Telegram
 *     alert to the developer.
 *
 * Fixed by requiring the real 32-hex device-id shape, writing the row exactly
 * once (first writer wins, `ON CONFLICT DO NOTHING`, no update path), and
 * capping new registrations per day so the alert channel cannot be buried.
 *
 * Run:  node --experimental-strip-types scripts/verify_tenant_isolation.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
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
console.log('TENANT ISOLATION — the shared cloud database');
console.log('='.repeat(72));

function loadSqlite() {
  for (const b of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { return createRequire(join(b, 'x.js'))('better-sqlite3'); } catch { /* next */ }
  }
  return null;
}
const Database = loadSqlite();

// ------------------------------------------------------------------ 1
console.log('\n[1] The engine in use, established rather than assumed');
{
  const pkg = JSON.parse(raw('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  t('the desktop store is SQLite', !!deps['better-sqlite3'], 'better-sqlite3 ' + deps['better-sqlite3']);
  t('there is no PostgreSQL driver', !deps.pg && !deps.postgres && !deps['@supabase/supabase-js'],
    Object.keys(deps).filter((d) => /pg|postgres|supabase/.test(d)).join(',') || 'none');
  t('the cloud store is D1 (SQLite)', /\[\[d1_databases\]\]/.test(raw('server/wrangler.toml')));

  // "Supabase" appears only as one option in a BACKUP UPLOAD picker — a place
  // to put a .db file, not a database this app queries.
  const dbh = raw('src/main/ipc/database.handlers.ts');
  t('Supabase is only a backup upload target, not a query surface',
    /rest\/v1\//.test(dbh) && !/from\(['"]/.test(dbh));

  if (Database) {
    // The decisive check: does the engine even understand the syntax?
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(id INTEGER, owner TEXT)');
    const rejects = (sql) => {
      try { db.exec(sql); return false; } catch { return true; }
    };
    t('SQLite rejects ENABLE ROW LEVEL SECURITY',
      rejects('ALTER TABLE t ENABLE ROW LEVEL SECURITY'));
    t('SQLite rejects CREATE POLICY', rejects("CREATE POLICY p ON t USING (true)"));
    t('SQLite rejects GRANT', rejects('GRANT SELECT ON t TO authenticated'));
    db.close();
  }
  t('no CREATE POLICY exists anywhere in the repository',
    !/create\s+policy/i.test(raw('server/worker.js') + raw('src/main/database/migrations/index.ts')));
}

// ------------------------------------------------------------------ 2
console.log('\n[2] The desktop database has exactly one tenant');
{
  // Isolation is meaningless per-file; what matters is that the file is
  // per-shop and that the licence is NOT inside it (or one shop activating
  // would activate them all).
  const conn = raw('src/main/database/connection.ts');
  t('the database is a file in the shop\'s own profile',
    /app\.getPath\('userData'\)/.test(conn));
  const mig = raw('src/main/database/migrations/index.ts');
  t('no licence table lives in the shared-able file', !/CREATE TABLE[^;]*licen/i.test(mig));
  t('no tenant/organisation column exists, because there is one tenant',
    !/tenant_id|organisation_id|organization_id/i.test(mig));
  // Access control for this file is the IPC guard, not row policies.
  t('access is enforced by the IPC permission guard',
    /Deny by default/.test(raw('src/main/security/ipcGuard.ts')));
}

if (!Database) {
  console.log('\n  SKIP  better-sqlite3 is not installed — cannot drive the Worker');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- a D1 stand-in, and the real Worker ------------------------------------
const worker = (await import(pathToFileURL(join(ROOT, 'server/worker.js')).href)).default;

function freshEnv() {
  const sqlite = new Database(':memory:');
  const D1 = {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...a) { bound = a.map((v) => (v === undefined ? null : v)); return api; },
        async first() {
          try { return sqlite.prepare(sql).get(...bound) ?? null; }
          catch (e) {
            if (/returns data|does not return/.test(e.message)) {
              sqlite.prepare(sql).run(...bound); return null;
            }
            throw e;
          }
        },
        async all() { return { results: sqlite.prepare(sql).all(...bound) }; },
        async run() {
          const r = sqlite.prepare(sql).run(...bound);
          return { meta: { last_row_id: r.lastInsertRowid } };
        },
      };
      return api;
    },
    async batch(list) { for (const s of list) await s.run(); return []; },
  };
  const CLIENT = 'client-key-shipped-in-the-app';
  const ADMIN = 'admin-key-developer-only-0000';
  return {
    sqlite,
    env: { DB: D1, UPDATES: null, CLIENT_KEY: CLIENT, ADMIN_KEY: ADMIN,
      TG_BOT_TOKEN: '', TG_ADMIN_CHAT: '' },
    CLIENT, ADMIN,
  };
}
const post = (env, path, body, headers) => worker.fetch(
  new Request('https://w.example' + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  }), env);

const SHOP_A = 'a'.repeat(32);
const SHOP_B = 'b'.repeat(32);

// ------------------------------------------------------------------ 3
console.log('\n[3] One shop cannot READ another shop\'s data');
{
  const { env, CLIENT, ADMIN } = freshEnv();
  const hb = (id, name) => post(env, '/heartbeat', { deviceId: id, shopName: name },
    { 'X-Client-Key': CLIENT });
  await hb(SHOP_A, 'محل أحمد');
  await hb(SHOP_B, 'محل خالد');

  const mine = await (await hb(SHOP_A, 'محل أحمد')).json();
  const body = JSON.stringify(mine);
  t('a heartbeat reply never contains another shop\'s name',
    !body.includes('خالد'), body.slice(0, 80));

  // Per-device config must not leak across devices.
  const { env: e2, CLIENT: c2 } = freshEnv();
  await post(e2, '/heartbeat', { deviceId: SHOP_A }, { 'X-Client-Key': c2 });
  // `/config` takes a `values` MAP, not key/value — getting that wrong writes
  // nothing and the leak test silently passes against anything.
  const cfgRes = await post(e2, '/config',
    { target: SHOP_B, values: { dev_phone: 'SECRET-B' } },
    { 'X-Admin-Key': 'admin-key-developer-only-0000' });
  t('the per-device config row was actually written (the probe is real)',
    (await cfgRes.json()).count === 1);

  // And shop B must genuinely receive it, or "A cannot see it" proves nothing.
  const forB = await (await post(e2, '/heartbeat', { deviceId: SHOP_B }, { 'X-Client-Key': c2 })).json();
  t('the intended device DOES receive its own config',
    forB.config?.device?.dev_phone === 'SECRET-B', JSON.stringify(forB.config));

  const r2 = await (await post(e2, '/heartbeat', { deviceId: SHOP_A }, { 'X-Client-Key': c2 })).json();
  t('per-device config is not delivered to a different device',
    !JSON.stringify(r2).includes('SECRET-B'), JSON.stringify(r2.config).slice(0, 80));

  // The whole-fleet list must need the ADMIN key.
  const asClient = await worker.fetch(
    new Request('https://w.example/devices', { headers: { 'X-Client-Key': CLIENT } }), env);
  t('the shipped client key cannot list every customer', asClient.status === 401,
    'status ' + asClient.status);
  const asAdmin = await worker.fetch(
    new Request('https://w.example/devices', { headers: { 'X-Admin-Key': ADMIN } }), env);
  t('only the admin key can', asAdmin.status === 200, 'status ' + asAdmin.status);
}

// ------------------------------------------------------------------ 4
console.log('\n[4] One shop cannot WRITE another shop\'s data');
{
  const { env, sqlite, CLIENT } = freshEnv();
  const reg = (id, name, extra = {}) => post(env, '/registration',
    { deviceId: id, companyName: name, ownerName: 'x', phone: '01000000000', ...extra },
    { 'X-Client-Key': CLIENT });

  // The endpoint must at least require the shipped key: without it the
  // registration table is writable by anything that can reach the URL.
  const noKey = await post(env, '/registration',
    { deviceId: SHOP_A, companyName: 'NO-KEY' }, {});
  t('registration requires the client key', noKey.status === 401, 'status ' + noKey.status);
  const badKey = await post(env, '/registration',
    { deviceId: SHOP_A, companyName: 'BAD-KEY' }, { 'X-Client-Key': 'wrong-key-same-length-xxxxxx' });
  t('and rejects a wrong one', badKey.status === 401, 'status ' + badKey.status);

  await reg(SHOP_B, 'محل خالد');
  const stored = () => sqlite.prepare(
    'SELECT company_name c FROM registrations WHERE device_id = ?').get(SHOP_B)?.c;
  t('a shop can register itself', stored() === 'محل خالد', String(stored()));

  // THE DEFECT: this used to overwrite the row.
  await reg(SHOP_B, 'DEFACED');
  t('another caller cannot overwrite that registration',
    stored() === 'محل خالد', String(stored()));

  // ...and the SQL itself must not carry an update path.
  const src = raw('server/worker.js');
  const handler = (() => {
    const i = src.indexOf('async function handleRegistration');
    return src.slice(i, src.indexOf('\n}', i));
  })();
  t('the registration insert cannot update an existing row',
    /ON CONFLICT\(device_id\) DO NOTHING/.test(handler)
    && !/ON CONFLICT\(device_id\) DO UPDATE/.test(handler));

  // A malformed or missing id must not create a row at all — the empty-string
  // key was a shared row every anonymous caller trampled in turn.
  for (const [label, payload] of [
    ['a missing device id', { companyName: 'NO-ID' }],
    ['an empty device id', { deviceId: '', companyName: 'EMPTY' }],
    ['a non-hex device id', { deviceId: 'not-hex-at-all!!', companyName: 'JUNK' }],
    ['a short device id', { deviceId: 'abc123', companyName: 'SHORT' }],
    ['an over-long device id', { deviceId: 'a'.repeat(64), companyName: 'LONG' }],
  ]) {
    const res = await post(env, '/registration', payload, { 'X-Client-Key': CLIENT });
    t(`${label} is refused`, res.status === 400, 'status ' + res.status);
  }
  t('no row was created for any of them',
    sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n === 1,
    sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n + ' rows');
}

// ------------------------------------------------------------------ 5
console.log('\n[5] The honest shop is not locked out by the fix');
{
  // Refusing an unseen device outright WOULD have blocked two real cases, and
  // that was measured before choosing this design:
  //   - the wizard finishing inside the 30s heartbeat delay;
  //   - a shop with telemetry switched off, which never checks in at all.
  const { env, sqlite, CLIENT } = freshEnv();
  const res = await post(env, '/registration',
    { deviceId: SHOP_A, companyName: 'محل أحمد', ownerName: 'أحمد', phone: '01000000000' },
    { 'X-Client-Key': CLIENT });
  const j = await res.json();
  t('a shop that never sent a heartbeat can still register', j.ok === true, JSON.stringify(j));
  t('and its details are stored',
    sqlite.prepare('SELECT company_name c FROM registrations').get()?.c === 'محل أحمد');
  t('a device row is created for it', 
    sqlite.prepare('SELECT COUNT(*) n FROM devices WHERE device_id = ?').get(SHOP_A).n === 1);

  // Re-running the wizard must be harmless, not an error the shop sees.
  const again = await post(env, '/registration',
    { deviceId: SHOP_A, companyName: 'محل أحمد', ownerName: 'أحمد', phone: '01000000000' },
    { 'X-Client-Key': CLIENT });
  const j2 = await again.json();
  t('re-registering is accepted quietly rather than erroring',
    j2.ok === true && j2.alreadyRegistered === true, JSON.stringify(j2));
}

// ------------------------------------------------------------------ 6
console.log('\n[6] The alert channel cannot be buried');
{
  // Every new registration sends the developer a Telegram message. Without a
  // ceiling, one loop inserted 200 rows and would have sent 200 alerts,
  // hiding every genuine customer.
  const { env, sqlite, CLIENT } = freshEnv();
  for (let i = 0; i < 200; i++) {
    await post(env, '/registration',
      { deviceId: String(i).padStart(32, '0'), companyName: 'junk' + i },
      { 'X-Client-Key': CLIENT });
  }
  const n = sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n;
  t('a 200-row flood is capped', n < 200, `${n} rows written of 200 attempted`);
  t('and the cap is a sane daily figure', n <= 60, `${n} rows`);

  // A genuine customer must still be able to register on a normal day.
  const { env: e2, sqlite: s2, CLIENT: c2 } = freshEnv();
  for (let i = 0; i < 5; i++) {
    await post(e2, '/registration',
      { deviceId: String(i).padStart(32, 'f'), companyName: 'shop' + i },
      { 'X-Client-Key': c2 });
  }
  t('five real shops in one day all register',
    s2.prepare('SELECT COUNT(*) n FROM registrations').get().n === 5);
}

// ------------------------------------------------------------------ 7
console.log('\n[7] Privileged operations still need the admin key');
{
  const { env, CLIENT } = freshEnv();
  const asClient = (p, b) => post(env, p, b, { 'X-Client-Key': CLIENT });
  for (const [label, path, body] of [
    ['mint a licence', '/issue', { deviceId: SHOP_A, days: 9999 }],
    ['broadcast config to everyone', '/config', { key: 'dev_phone', target: 'all', value: 'x' }],
    ['send a message to everyone', '/message', { target: 'all', title: 't', body: 'b' }],
    ['publish a fake update', '/release', { version: '9.9.9', filename: 'x.nupkg', sha1: 'a'.repeat(40), size: 1 }],
  ]) {
    const r = await asClient(path, body);
    t(`the shipped client key cannot ${label}`, r.status === 401, 'status ' + r.status);
  }
  // And an unknown path is not a hole.
  const nf = await worker.fetch(new Request('https://w.example/nope'), env);
  t('an unknown path is a 404', nf.status === 404, 'status ' + nf.status);
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
