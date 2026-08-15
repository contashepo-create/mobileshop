/**
 * Cloudflare Worker — licensing and remote-management backend.
 *
 * Chosen over Supabase/Render because both pause free projects when idle
 * (Supabase after 7 days, Render after 15 minutes). A licensing endpoint is
 * called intermittently — sometimes not for days — which is exactly the pattern
 * those platforms punish. Workers never sleep and have no cold start.
 *
 * Deploy:
 *   cd server && npx wrangler deploy
 *
 * Required secrets (never commit these):
 *   npx wrangler secret put ADMIN_KEY      # your laptop / bot -> full access
 *   npx wrangler secret put CLIENT_KEY     # shipped in the app -> heartbeat only
 *   npx wrangler secret put LICENSE_PRIVATE_KEY # Ed25519 private key (base64, 32 bytes)
 *   npx wrangler secret put TG_BOT_TOKEN   # from @BotFather
 *   npx wrangler secret put TG_ADMIN_CHAT  # numeric chat id, or several
 *                                          # separated by commas for a backup
 *                                          # phone: 7232305465,1593943219
 *   npx wrangler secret put TG_WEBHOOK_SECRET  # see below — REQUIRED
 *
 * TG_WEBHOOK_SECRET AND WHY IT IS NOT OPTIONAL
 * --------------------------------------------
 * `/telegram` cannot be protected by ADMIN_KEY: Telegram will not send a custom
 * header of ours. Its only defence WAS the chat id inside the JSON body — and
 * the body is written by whoever sends the request.
 *
 * MEASURED against this worker's real exported `fetch`, with no credential of
 * any kind, from an anonymous caller who knows only the public URL:
 *
 *   POST /telegram
 *   {"message":{"chat":{"id":7232305465},"text":"/new deadbeefdeadbeef 3650"}}
 *
 *   -> 200 {"ok":true}
 *   -> outbound: sendMessage "كود التفعيل الخاص بك:
 *                2YN0-0001-CMKM-MVE8-AP7K-7WPD-..."
 *
 * A valid, signed, TEN-YEAR licence, minted by an attacker. The chat id is not
 * a secret — it appears in this repository's own history and in the deployment
 * notes — and even if it were, it is a 10-digit number.
 *
 * Telegram's answer is `secret_token`: a value given to `setWebhook`, which
 * Telegram then sends back on every delivery in the
 * `X-Telegram-Bot-Api-Secret-Token` header. A forged request cannot carry it.
 *
 * Register it once, after setting the secret:
 *
 *   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -H "content-type: application/json" \
 *        -d '{"url":"https://<worker>/telegram","secret_token":"<TG_WEBHOOK_SECRET>"}'
 *
 * The worker FAILS CLOSED when the secret is unset: an unconfigured deployment
 * refuses every webhook rather than accepting every one. A bot that is silent
 * is a fault the owner will report; a bot that mints licences for strangers is
 * one nobody notices.
 */

const EPOCH_UTC = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Serial space is split so the bot and the offline laptop can never collide. */
const SERIAL_SOURCE_CLOUD = 0;
const SERIAL_HALF = 0x800000;           // 8,388,608

// ---------------------------------------------------------------- crypto
function encodeBase32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

async function hmac5(secret, deviceId, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const msg = new Uint8Array([...new TextEncoder().encode(deviceId), ...payload]);
  const sig = await crypto.subtle.sign('HMAC', key, msg);
  return new Uint8Array(sig).slice(0, 5);
}

/**
 * Signs a v2 activation code with the Ed25519 PRIVATE key.
 *
 * `LICENSE_PRIVATE_KEY` is a Worker SECRET (base64 of the raw 32 bytes) and is
 * the only thing in the system that can mint a licence. It replaces the old
 * shared LICENSE_SECRET, which was also embedded in every shipped app and
 * therefore let any customer forge a perpetual licence.
 *
 * Set it once with:
 *   npx wrangler secret put LICENSE_PRIVATE_KEY
 */
async function signCode(privateKeyB64, deviceId, expiryDays, serial) {
  const payload = new Uint8Array(5);
  new DataView(payload.buffer).setUint16(0, expiryDays & 0xffff);
  payload[2] = (serial >> 16) & 0xff;
  payload[3] = (serial >> 8) & 0xff;
  payload[4] = serial & 0xff;

  const raw = Uint8Array.from(atob(String(privateKeyB64 || '')), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('LICENSE_PRIVATE_KEY must be 32 raw bytes (base64)');
  // Wrap the seed in the PKCS8 header WebCrypto expects for Ed25519.
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20, ...raw,
  ]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const msg = new Uint8Array([...new TextEncoder().encode(deviceId), ...payload]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg));
  return encodeBase32(new Uint8Array([...payload, ...sig])).match(/.{1,4}/g).join('-');
}

const todayDays = () => Math.floor((Date.now() - EPOCH_UTC) / MS_PER_DAY);
const daysToDate = d => new Date(EPOCH_UTC + d * MS_PER_DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------- helpers
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

/** Constant-time-ish comparison to avoid leaking the key byte by byte. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The chat ids allowed to drive the bot, and to receive its alerts.
 *
 * TG_ADMIN_CHAT accepts a COMMA-SEPARATED list so the owner can hold a second
 * number as a fallback: if the first phone is lost, stolen or its Telegram
 * account is locked, the shop is not cut off from its own bot.
 *
 * Read as a list everywhere. A single id keeps working unchanged, because one
 * value is simply a list of one.
 *
 * SECURITY: every id here has FULL control of the bot. That is the point of a
 * fallback, and it is also the cost — a second id is a second key to the same
 * door, so only numbers the owner personally controls belong in it.
 */
function adminChats(env) {
  return String(env.TG_ADMIN_CHAT || '')
    .split(',')
    .map(x => x.trim())
    .filter(x => /^-?\d{5,}$/.test(x));
}

/** True when this chat id may command the bot. */
function isAdminChat(env, chatId) {
  // NOT trimmed. Telegram sends `chat.id` as a JSON number, so a legitimate id
  // never carries whitespace — but the value is read out of an attacker-shaped
  // payload, and `" 7232305465"` was MEASURED being accepted as the owner.
  //
  // An identity with more than one spelling is an identity that can slip past
  // a comparison somewhere else: the same value is used as `env.__actingChat`,
  // stored as the pending-flow key, and echoed into `chat_id` on the way out.
  // One spelling, exactly.
  const id = String(chatId ?? '');
  if (!/^-?\d{5,}$/.test(id)) return false;
  return adminChats(env).includes(id);
}

async function tg(env, text) {
  const chats = adminChats(env);
  if (!env.TG_BOT_TOKEN || chats.length === 0) return;
  // Alerts go to EVERY registered admin. A backup number that never hears
  // anything is not a backup — it would only be discovered to be misconfigured
  // at the moment the primary is already lost.
  for (const chat_id of chats) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
      });
    } catch { /* notification failure must never break the request */ }
  }
}

// ---------------------------------------------------------------- schema
async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      shop_name TEXT,
      app_version TEXT,
      platform TEXT,
      license_status TEXT,
      license_expiry TEXT,
      first_seen TEXT,
      last_seen TEXT,
      seen_count INTEGER DEFAULT 0,
      note TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS licenses (
      serial INTEGER PRIMARY KEY,
      device_id TEXT,
      code TEXT,
      expiry_days INTEGER,
      issued_at TEXT,
      issued_by TEXT,
      note TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS remote_config (
      key TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'all',
      value TEXT,
      updated_at TEXT,
      PRIMARY KEY (key, target)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL DEFAULT 'all',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT DEFAULT 'info',
      created_at TEXT,
      expires_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER, device_id TEXT, read_at TEXT,
      PRIMARY KEY (message_id, device_id)
    )`),
    // Remembers what a typed reply means during a multi-step menu flow.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_actions (
      chat_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      data TEXT,
      created_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0
    )`),
    // Shop details, recorded only when the owner consented in the wizard.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS registrations (
      device_id     TEXT PRIMARY KEY,
      company_name  TEXT,
      owner_name    TEXT,
      phone         TEXT,
      email         TEXT,
      governorate   TEXT,
      city          TEXT,
      address       TEXT,
      birth_date    TEXT,
      registered_at TEXT
    )`),
    // Published builds. `sha1` and `size` are what Squirrel checks the
    // downloaded package against, so they are stored rather than recomputed:
    // the Worker never sees the file, only R2 does.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS releases (
      platform     TEXT NOT NULL,
      version      TEXT NOT NULL,
      filename     TEXT NOT NULL,
      sha1         TEXT NOT NULL,
      sha512       TEXT,
      size         INTEGER NOT NULL,
      notes        TEXT,
      published_at TEXT,
      is_published INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (platform, version)
    )`),
    // Fast code-only releases. The client swaps its `app.asar` (a few MB) from
    // this feed instead of running a new NSIS installer:
    //
    //   version          the code push's own version (compared by semver)
    //   asar_url         relative path served by this Worker, e.g.
    //                    /code/win32-x64/1.0.5/MobileShopERP-1.0.5.asar
    //   sha256           of the .asar; the client refuses anything that does
    //                    not match, so a tampered object is never executed
    //   size             bytes, cross-checked against the downloaded file
    //   min_app_version  the minimum FULL build (shell + native modules) a
    //                    machine must be on before this code may run — a code
    //                    change that needs a newer better-sqlite3 must not be
    //                    applied on top of an old shell.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS code_releases (
      platform        TEXT NOT NULL,
      version         TEXT NOT NULL,
      asar_url        TEXT NOT NULL,
      sha256          TEXT NOT NULL,
      size            INTEGER NOT NULL,
      min_app_version TEXT NOT NULL,
      notes           TEXT,
      published_at    TEXT,
      is_published    INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (platform, version)
    )`),
  ]);
  // The `releases` table gained a `sha512` column (for NSIS differential
  // updates) after the very first deploy, which created the table without it.
  // `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, so
  // migration must be explicit. If a column is already present the ALTER fails
  // harmlessly (duplicate column) and is swallowed.
  try {
    await env.DB.prepare(`ALTER TABLE releases ADD COLUMN sha512 TEXT`).run();
  } catch {
    // duplicate column — already migrated
  }
  // `messages` gained edit/delete tracking (for retracting and amending a
  // broadcast) after the very first deploy, which created the table without
  // the columns. Same explicit migration pattern as `releases.sha512` above.
  try {
    await env.DB.prepare(`ALTER TABLE messages ADD COLUMN updated_at TEXT`).run();
  } catch {
    // duplicate column — already migrated
  }
  try {
    await env.DB.prepare(`ALTER TABLE messages ADD COLUMN deleted_at TEXT`).run();
  } catch {
    // duplicate column — already migrated
  }
}

/**
 * A customer cleared their own database.
 *
 * Purely a notification to the developer, so a later "I have lost all my data"
 * support call can be answered with the date, the account and the fact that a
 * verified backup was taken first.
 *
 * Carries NO business data: shop name, the username that performed it, and the
 * time. Never a customer, a balance or an invoice. Support needs to know THAT
 * it happened, never what was in it.
 *
 * This does NOT affect the licence. Clearing business data is a normal
 * operation a shop is entitled to perform, and nothing here writes to the
 * licences table.
 */
/**
 * A new shop registered, and consented to sharing its details.
 *
 * Stored so the developer can look a customer up when they call for support,
 * and announced on Telegram so a new install is noticed at the time.
 *
 * The client only calls this when the owner ticked the consent box, and this
 * endpoint is the only place the data lands.
 */
/**
 * How many NEW registrations may be created in one day, across all customers.
 *
 * A shipped `CLIENT_KEY` means anyone holding a copy of the app can POST here,
 * and a registration costs a database write plus a Telegram alert. MEASURED:
 * one loop inserted 200 junk rows and would have sent 200 messages, burying
 * every genuine new customer in noise.
 *
 * The ceiling is per-DAY and global rather than per-caller, because there is
 * no per-caller identity to key on — that is the root problem. It is set far
 * above any plausible real day (a busy month is a handful of new shops) and
 * far below what makes the alert channel unusable.
 */
const MAX_NEW_REGISTRATIONS_PER_DAY = 50;

async function handleRegistration(request, env) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const b = await request.json().catch(() => null);
  const deviceId = String(b?.deviceId || '').trim().toLowerCase();
  const cut = (v, n) => String(v || '').slice(0, n);

  // TENANT ISOLATION.
  //
  // `CLIENT_KEY` is shipped inside every copy of the application, so it
  // identifies "a copy of this app", never "this particular shop". It is the
  // ticket through the door, not proof of who you are. The device id decides
  // WHICH ROW is written, and it arrives in the request body — so on this
  // endpoint the caller was choosing the row.
  //
  // MEASURED against this handler with nothing but the shipped key:
  //   - a caller overwrote another shop's registration
  //     (company_name "محل خالد" -> "DEFACED", owner and phone with it);
  //   - omitting deviceId entirely wrote a row keyed on the empty string,
  //     which every subsequent nameless caller then overwrote in turn;
  //   - 200 junk rows were inserted in one loop.
  //
  // The other client endpoints already refuse a short id (`heartbeat` and
  // `database-reset` both check `length < 8`); this one had no check at all.
  //
  // The device id is a 32-character hex string — `deviceId.ts` builds it with
  // `sha256(...).substring(0, 32)` — so the exact shape is required here. That
  // does not make the id secret, and it cannot: a shared key plus a
  // caller-supplied identity can never be authentication. What it does is
  // remove the two cases that need no knowledge at all — the empty key and
  // arbitrary junk — and confine the remaining risk to someone who already
  // knows a specific victim's device id.
  //
  // Deliberately NOT closed further here, because doing it properly means
  // signing the request with the per-device key, which is a protocol change
  // for every installed client. Tracked as such rather than papered over.
  if (!/^[a-f0-9]{32}$/.test(deviceId)) {
    return json({ ok: false, error: 'bad device' }, 400);
  }

  // The device must have CHECKED IN before it can register.
  //
  // Refusing to overwrite an existing row is not sufficient on its own, and
  // this was measured rather than assumed: with only "first write wins", an
  // attacker who guesses a device id simply claims it FIRST, and the genuine
  // shop is then permanently locked out of registering its own details —
  // trading a defacement for a denial of service.
  //
  // A heartbeat is the closest thing to proof of possession available here:
  // it is sent by the installed app on the machine that owns the id. Requiring
  // a prior `devices` row means an attacker must both know a real device id
  // AND have that machine already running the software — at which point the
  // registration row is the least of anyone's problems.
  //
  // The device row is created lazily rather than demanded outright. Two real
  // cases would otherwise be refused for no good reason:
  //   - the wizard finishes inside the 30-second delay before the first
  //     heartbeat is sent (`FIRST_RUN_DELAY_MS` in heartbeat.ts);
  //   - the shop switched telemetry OFF, so it never checks in at all, yet
  //     still ticked the box consenting to share its details.
  // In both, the honest customer would see their consent silently dropped.
  //
  // So an unseen device is ADMITTED and recorded, and the protection comes
  // from the row being written exactly once (below) — first writer wins, and
  // in practice the first writer is the shop itself, at the moment it sets the
  // software up. The squatting window is the interval between a device id
  // existing and its owner running the wizard, which is measured in minutes on
  // a machine an attacker would already have to have compromised.
  const seen = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE device_id = ?',
  ).bind(deviceId).first();
  if (!seen) {
    await env.DB.prepare(`
      INSERT INTO devices (device_id, first_seen, last_seen, seen_count)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(device_id) DO NOTHING
    `).bind(deviceId, new Date().toISOString(), new Date().toISOString()).run();
  }

  // Registration is a ONE-TIME event per device: the wizard runs once. The
  // update path existed only so a re-run could correct a typo, and it is what
  // allowed a competitor's row to be defaced. A device that is already
  // registered is left alone, so a genuine correction becomes a support
  // conversation rather than a silent overwrite by whoever asked last.
  const already = await env.DB.prepare(
    'SELECT device_id FROM registrations WHERE device_id = ?',
  ).bind(deviceId).first();
  if (already) {
    return json({ ok: true, alreadyRegistered: true });
  }

  // Flood ceiling, checked only for a genuinely NEW row so a returning
  // customer is never refused. `ok: true` on purpose: the client treats this
  // as fire-and-forget telemetry and must not show the shop an error for a
  // limit that is the developer's problem, not theirs.
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM registrations WHERE substr(registered_at, 1, 10) = ?",
  ).bind(todayIso).first();
  if ((todayCount?.n || 0) >= MAX_NEW_REGISTRATIONS_PER_DAY) {
    return json({ ok: true, rateLimited: true });
  }

  await env.DB.prepare(`
    INSERT INTO registrations
      (device_id, company_name, owner_name, phone, email, governorate, city, address, birth_date, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    -- DO NOTHING, never DO UPDATE. The upsert that used to be here is exactly
    -- what let one caller rewrite another shop's row. The guard above already
    -- returns early for a known device; this is the second line of defence,
    -- so a future edit that removes the guard still cannot overwrite.
    ON CONFLICT(device_id) DO NOTHING
  `).bind(
    deviceId, cut(b?.companyName, 80), cut(b?.ownerName, 80), cut(b?.phone, 20),
    cut(b?.email, 120), cut(b?.governorate, 40), cut(b?.city, 60),
    cut(b?.address, 200), cut(b?.birthDate, 12),
    String(b?.at || new Date().toISOString()).slice(0, 32),
  ).run();

  await tg(env,
    `\u{1F195} <b>تسجيل عميل جديد</b>\n\n`
    + `المحل: ${cut(b?.companyName, 80) || '—'}\n`
    + `المالك: ${cut(b?.ownerName, 80) || '—'}\n`
    + `الهاتف: ${cut(b?.phone, 20) || '—'}\n`
    + `البريد: ${cut(b?.email, 120) || '—'}\n`
    + `المحافظة: ${cut(b?.governorate, 40) || '—'} - ${cut(b?.city, 60) || '—'}\n`
    + (deviceId ? `<code>${deviceId}</code>` : ''));

  return json({ ok: true });
}

async function handleDatabaseReset(request, env) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const body = await request.json().catch(() => null);
  const deviceId = String(body?.deviceId || '').trim().toLowerCase();
  const shop = String(body?.shopName || '').slice(0, 80);
  const user = String(body?.username || '').slice(0, 64);
  const at = String(body?.at || new Date().toISOString()).slice(0, 32);

  const known = deviceId.length >= 8
    ? await env.DB.prepare('SELECT shop_name FROM devices WHERE device_id = ?').bind(deviceId).first()
    : null;

  await tg(env,
    `\u{1F5D1} <b>عميل صفّر قاعدة بياناته</b>\n\n`
    + `المحل: ${shop || known?.shop_name || '—'}\n`
    + `المستخدم: ${user || '—'}\n`
    + `الوقت: ${at.replace('T', ' ').slice(0, 16)}\n`
    + (deviceId ? `<code>${deviceId}</code>` : ''));

  return json({ ok: true });
}

// ------------------------------------------------- admin password recovery
//
// DELIBERATELY NOT HERE.
//
// An earlier version implemented /password-reset/* on this worker, which
// delivers Telegram messages to TG_ADMIN_CHAT — the DEVELOPER's chat. That
// meant a customer who forgot the administrator password produced a code on
// the developer's phone and had to ring for it: the very support call the
// feature was built to remove, wearing a new coat.
//
// Password recovery now happens entirely on the shop's own machine, using the
// shop's own bot configured in Settings -> Backup. See
// src/main/security/passwordRecovery.ts. Nothing about a customer's password,
// and nothing from their database, passes through the developer's bot.
//
// If these endpoints are ever reinstated, they must take the shop's bot token
// from the request rather than using TG_BOT_TOKEN.

async function nextCloudSerial(env) {
  await env.DB.prepare(
    `INSERT INTO counters (name, value) VALUES ('cloud_serial', 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run();
  const row = await env.DB.prepare("SELECT value FROM counters WHERE name = 'cloud_serial'").first();
  const n = row?.value ?? 1;
  // Cloud range: 1 .. 8,388,607 — the offline generator owns the upper half.
  return (SERIAL_SOURCE_CLOUD * SERIAL_HALF) + (n % SERIAL_HALF || 1);
}

// ---------------------------------------------------------------- endpoints

/** Called by every customer install, roughly once a day. */
async function handleHeartbeat(request, env) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const body = await request.json().catch(() => null);
  const deviceId = String(body?.deviceId || '').trim().toLowerCase();
  if (deviceId.length < 8) return json({ ok: false, error: 'bad device' }, 400);

  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT device_id FROM devices WHERE device_id = ?')
    .bind(deviceId).first();

  await env.DB.prepare(`
    INSERT INTO devices (device_id, shop_name, app_version, platform,
                         license_status, license_expiry, first_seen, last_seen, seen_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(device_id) DO UPDATE SET
      -- COALESCE, not a plain overwrite: a heartbeat may legitimately omit a
      -- field (the customer can switch off telemetry_share_shop_name, or an
      -- older build may not send it yet). Overwriting with NULL would erase
      -- information we already have and make the device unidentifiable in the
      -- dashboard. Only replace a value when the device actually sent one.
      shop_name = COALESCE(excluded.shop_name, shop_name),
      app_version = COALESCE(excluded.app_version, app_version),
      platform = COALESCE(excluded.platform, platform),
      license_status = COALESCE(excluded.license_status, license_status),
      license_expiry = COALESCE(excluded.license_expiry, license_expiry),
      last_seen = excluded.last_seen,
      seen_count = seen_count + 1
  `).bind(
    deviceId,
    body?.shopName ?? null,
    body?.appVersion ?? null,
    body?.platform ?? null,
    body?.licenseStatus ?? null,
    body?.licenseExpiry ?? null,
    now, now,
  ).run();

  if (!existing) {
    await tg(env, `🆕 <b>جهاز جديد</b>\n` +
      `المحل: ${body?.shopName || '—'}\n` +
      `الإصدار: ${body?.appVersion || '—'}\n` +
      `الحالة: ${body?.licenseStatus || '—'}\n` +
      `<code>${deviceId}</code>`);
  }

  // Record read receipts the client reported.
  const receipts = Array.isArray(body?.readReceipts) ? body.readReceipts.slice(0, 100) : [];
  for (const id of receipts) {
    if (typeof id !== 'number') continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO message_reads (message_id, device_id, read_at) VALUES (?, ?, ?)`,
    ).bind(id, deviceId, now).run();
  }

  const cfgAll = await env.DB.prepare("SELECT key, value FROM remote_config WHERE target = 'all'").all();
  const cfgDev = await env.DB.prepare('SELECT key, value FROM remote_config WHERE target = ?')
    .bind(deviceId).all();
  const msgs = await env.DB.prepare(`
    SELECT m.id, m.title, m.body, m.severity, m.created_at, m.expires_at
    FROM messages m
    WHERE (m.target = 'all' OR m.target = ?)
      AND m.deleted_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.device_id = ?)
    ORDER BY m.id DESC LIMIT 20
  `).bind(deviceId, deviceId).all();

  // Messages the developer EDITED after they were sent. The client upserts
  // them, keeping its read state: a corrected message reaches devices that
  // already read the wrong version, and an unread one keeps popping up with
  // the new text. Windowed so every daily check-in sees the recent ones.
  const revisions = await env.DB.prepare(`
    SELECT m.id, m.title, m.body, m.severity, m.expires_at
    FROM messages m
    WHERE (m.target = 'all' OR m.target = ?)
      AND m.deleted_at IS NULL AND m.updated_at IS NOT NULL
      AND m.updated_at > datetime('now', '-45 days')
    ORDER BY m.id DESC LIMIT 50
  `).bind(deviceId).all();

  // Messages the developer RETRACTED: the client deletes its local copy, so a
  // test message sent by mistake disappears from every shop that syncs — read
  // or not. Id-based, so a device that never received the message is unharmed.
  const deletes = await env.DB.prepare(`
    SELECT m.id FROM messages m
    WHERE m.deleted_at IS NOT NULL
      AND m.deleted_at > datetime('now', '-60 days')
      AND (m.target = 'all' OR m.target = ?)
  `).bind(deviceId).all();

  const toObj = rows => Object.fromEntries((rows?.results || []).map(r => [r.key, r.value]));

  return json({
    ok: true,
    config: { all: toObj(cfgAll), device: toObj(cfgDev) },
    messages: (msgs?.results || []).map(m => ({
      id: m.id, title: m.title, body: m.body,
      severity: m.severity, createdAt: m.created_at, expiresAt: m.expires_at,
    })),
    messageRevisions: (revisions?.results || []).map(m => ({
      id: m.id, title: m.title, body: m.body,
      severity: m.severity, expiresAt: m.expires_at,
    })),
    messageDeletes: (deletes?.results || []).map(r => r.id),
    serverTime: now,
  });
}

/** Admin: mint an activation code. */
async function handleIssue(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const body = await request.json().catch(() => null);
  const deviceId = String(body?.deviceId || '').trim().toLowerCase();
  const days = Number(body?.days);
  if (deviceId.length < 8) return json({ ok: false, error: 'bad device' }, 400);
  if (!Number.isFinite(days) || days < 0) return json({ ok: false, error: 'bad days' }, 400);

  const expiryDays = days === 0 ? 0 : todayDays() + Math.floor(days);
  if (expiryDays > 0xffff) return json({ ok: false, error: 'duration too long' }, 400);

  const serial = await nextCloudSerial(env);
  const code = await signCode(env.LICENSE_PRIVATE_KEY, deviceId, expiryDays, serial);
  const expiry = expiryDays === 0 ? 'غير محدود' : daysToDate(expiryDays);

  await env.DB.prepare(`
    INSERT INTO licenses (serial, device_id, code, expiry_days, issued_at, issued_by, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(serial, deviceId, code, expiryDays, new Date().toISOString(),
    body?.issuedBy || 'cloud', body?.note || '').run();

  return json({ ok: true, code, serial, expiry, deviceId });
}

/** Admin: list devices for the desktop dashboard. */
async function handleDevices(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const rows = await env.DB.prepare(
    'SELECT * FROM devices ORDER BY last_seen DESC LIMIT 500',
  ).all();
  return json({ ok: true, devices: rows?.results || [] });
}

/** Admin: set a remote presentation value (broadcast or per device). */
async function handleConfig(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const body = await request.json().catch(() => null);
  const target = String(body?.target || 'all');
  const values = body?.values || {};
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(values)) {
    await env.DB.prepare(`
      INSERT INTO remote_config (key, target, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key, target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(String(k), target, String(v ?? ''), now).run();
  }
  return json({ ok: true, count: Object.keys(values).length });
}

/** Admin: queue a message for one device or everyone. */
async function handleMessage(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ ok: false, error: 'bad json' }, 400);
  const action = String(b.action || '');

  // Management actions — the same contract as the bot's MESSAGES_MENU,
  // exposed over the webhook so scripts and the developer can drive it
  // directly: list what was sent, who read it, edit the text, retract it.
  if (action === 'list') {
    const rows = await env.DB.prepare(`
      SELECT m.id, m.target, m.title, m.body, m.severity,
             m.created_at, m.updated_at, m.expires_at, m.deleted_at,
             (SELECT COUNT(*) FROM message_reads r WHERE r.message_id = m.id) AS read_count
        FROM messages m
       ORDER BY m.id DESC LIMIT 50
    `).all();
    const messages = (rows?.results || []).map(m => ({
      id: m.id, target: m.target, title: m.title, body: m.body, severity: m.severity,
      createdAt: m.created_at, updatedAt: m.updated_at, expiry: m.expires_at,
      deletedAt: m.deleted_at, readCount: m.read_count,
    }));
    return json({ ok: true, messages });
  }

  if (action === 'reads') {
    const id = Number(b.id);
    if (!Number.isInteger(id)) return json({ ok: false, error: 'bad id' }, 400);
    const report = await messageReadsReport(env, id);
    if (!report) return json({ ok: false, error: 'no such message' }, 404);
    return json({
      ok: true, id, name: report.name,
      read: report.read, readCount: report.readCount,
      unreadCount: report.unreadCount, deleted: report.deleted,
    });
  }

  if (action === 'edit') {
    const id = Number(b.id);
    if (!Number.isInteger(id)) return json({ ok: false, error: 'bad id' }, 400);
    if (!b.body) return json({ ok: false, error: 'empty body' }, 400);
    const res = await env.DB.prepare(
      'UPDATE messages SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).bind(String(b.body), new Date().toISOString(), id).run();
    if ((res.meta?.changes ?? 0) === 0) {
      return json({ ok: false, error: 'no such message' }, 404);
    }
    return json({ ok: true, id });
  }

  if (action === 'delete') {
    const id = Number(b.id);
    if (!Number.isInteger(id)) return json({ ok: false, error: 'bad id' }, 400);
    const res = await env.DB.prepare(
      'UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).bind(new Date().toISOString(), id).run();
    if ((res.meta?.changes ?? 0) === 0) {
      return json({ ok: false, error: 'no such message' }, 404);
    }
    return json({ ok: true, id });
  }

  if (!b.title && !b.body) return json({ ok: false, error: 'empty message' }, 400);
  const res = await env.DB.prepare(`
    INSERT INTO messages (target, title, body, severity, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(String(b.target || 'all'), String(b.title || ''), String(b.body || ''),
    String(b.severity || 'info'), new Date().toISOString(), b.expiresAt || null).run();
  return json({ ok: true, id: res.meta?.last_row_id });
}

// ---------------------------------------------------------------- updates
//
// PRIVATE AUTOMATIC UPDATES, ON THE SAME WORKER AS THE BOT.
//
// WHY NOT update.electronjs.org
// -----------------------------
// That free service requires a PUBLIC GitHub repository. This is a commercial
// product: making the repository public would let anyone clone it, build it
// and hand it out. So the update feed lives here instead, behind the same
// X-Client-Key the heartbeat already uses.
//
// HOW SQUIRREL.WINDOWS ACTUALLY WORKS
// -----------------------------------
// `autoUpdater.setFeedURL({ url })` on Windows does NOT fetch `url`. Squirrel
// appends `/RELEASES` and expects a plain-text NuGet manifest:
//
//     <SHA1>  <package-file-name>.nupkg  <size-in-bytes>
//
// It then downloads the .nupkg named there, RELATIVE to the same directory.
// So two endpoints are needed, not one: the manifest, and the package itself.
// A JSON "here is a URL" reply — the shape most people expect — is silently
// ignored by Squirrel on Windows, and the update never happens.
//
// WHERE THE BINARY LIVES
// ----------------------
// The .nupkg is served from R2 (bucket binding `UPDATES`). R2 has no egress
// fee, which matters because every customer downloads the whole package on
// every release. If the bucket is not bound yet, the endpoints answer "no
// update" rather than failing — an unconfigured server must never break a
// shop that is trading.
//
// SUBSCRIPTION CONTROL
// --------------------
// A device whose licence has expired is told there is no update. It keeps
// working exactly as before — nothing is taken away, it simply stops
// receiving new versions. That is the commercial point of hosting this
// ourselves rather than on a public GitHub release.

/** The release currently being served, or null when none is published. */
async function currentRelease(env, platform) {
  const row = await env.DB.prepare(
    `SELECT version, filename, sha1, size, notes, published_at
       FROM releases WHERE platform = ? AND is_published = 1
      ORDER BY published_at DESC LIMIT 1`,
  ).bind(platform).first();
  return row || null;
}

/**
 * True when this device may receive new versions.
 *
 * An UNKNOWN device is allowed: a fresh install has not sent its first
 * heartbeat yet, and refusing it would strand the very customers who most
 * need the current build. Only an EXPLICITLY expired licence is refused.
 */
async function mayReceiveUpdates(env, deviceId) {
  if (!deviceId) return true;
  const row = await env.DB.prepare(
    'SELECT license_status, license_expiry FROM devices WHERE device_id = ?',
  ).bind(deviceId).first();
  if (!row) return true;
  if (row.license_expiry) {
    // Dates are plain YYYY-MM-DD, so a string compare is a date compare.
    if (row.license_expiry < daysToDate(todayDays())) return false;
  }
  return row.license_status !== 'expired' && row.license_status !== 'blocked';
}

/**
 * "You are up to date."
 *
 * The body MUST be null, not '': the Fetch spec forbids a body on a 204 and
 * both workerd and Node throw `Invalid response status code 204` if one is
 * given. That throw was caught by the router's try/catch and returned to
 * Squirrel as a 500, so every up-to-date client saw a server error instead of
 * a quiet "nothing to do".
 */
const noUpdate = () => new Response(null, { status: 204 });

// ---------------------------------------------------------------- code push
//
// The "fast lane": a pure code change ships as a replacement `app.asar` (a few
// MB) rather than a full NSIS installer. The client swaps its asar over this
// feed; the shell, native modules and installer never change.
//
// Route shapes (all client-keyed, same gating as the NSIS feed):
//
//   GET /code-update/<platform>/<from>/manifest.json
//        204                nothing newer worth a swap
//        200  {"version", "asar_url", "sha256", "size", "min_app_version", "notes"}
//
//   GET /code/<platform>/<version>.asar
//        the code object itself, straight out of R2 (`code/<platform>/<v>.asar`)
//
//   POST /release-code      { platform, version, sha256, size, min_app_version, notes }
//        admin-keyed; registers a published code release so `code-update` may
//        start serving it.
//
// `min_app_version` is the drawer against accidental shell/code mismatch: the
// publish tool refuses to ship a code bundle whose required shell is newer
// than the currently-published NSIS build, and the client refuses to apply one
// whose `min_app_version` its own build does not satisfy. The field is stored
// here and echoed back verbatim so both sides validate against the SAME bytes.

/** The newest published code release for a platform, or null. */
async function currentCodeRelease(env, platform) {
  const row = await env.DB.prepare(
    `SELECT version, asar_url, sha256, size, min_app_version, notes, published_at
       FROM code_releases WHERE platform = ? AND is_published = 1
      ORDER BY published_at DESC LIMIT 1`,
  ).bind(platform).first();
  return row || null;
}

/**
 * `GET /code-update/<platform>/<from>/manifest.json`
 *
 * Mirrors the NSIS manifest contract: 204 when the caller is already current,
 * otherwise a small JSON describing the single .asar to fetch. `asar` is a path
 * relative to this Worker so the client builds the URL itself and never trusts
 * a full URL embedded in the manifest.
 */
async function handleCodeManifest(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });

  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';      // /code-update/win32-x64/<from>/manifest.json
  const from = parts[2] || '0.0.0';
  const deviceId = String(url.searchParams.get('device') || '').trim().toLowerCase();

  if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(platform)) {
    return json({ ok: false, error: 'bad platform' }, 400);
  }

  if (!await mayReceiveUpdates(env, deviceId)) return noUpdate();

  const rel = await currentCodeRelease(env, platform);
  // Nothing published, or the shop already has this exact code.
  if (!rel || compareVersions(rel.version, from) <= 0) return noUpdate();

  return jsonResponse({
    version: rel.version,
    asar: `/code/${platform}/${rel.version}.asar`,
    sha256: rel.sha256,
    size: rel.size,
    min_app_version: rel.min_app_version,
    notes: rel.notes || '',
    published_at: rel.published_at || '',
  });
}

/**
 * `GET /code/<platform>/<version>.asar`
 *
 * The code object from R2. Both path segments are attacker-controlled and are
 * concatenated into the object key, so both are locked down exactly like the
 * .nupkg handler. Range is honoured so a dropped connection resumes instead of
 * re-downloading the whole object.
 */
async function handleCodeFile(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });

  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';      // /code/<platform>/<version>.asar
  const asar = parts[parts.length - 1] || '';

  if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(platform)) {
    return new Response('bad platform', { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+\.asar$/.test(asar) || asar.includes('..')) {
    return new Response('bad asar', { status: 400 });
  }

  const key = `code/${platform}/${asar}`;
  const obj = await env.UPDATES.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const startRaw = m[1], endRaw = m[2];
      const total = obj.size;
      let start, end;
      if (startRaw === '' && endRaw !== '') {
        const n = Number(endRaw);
        start = Math.max(total - n, 0);
        end = total - 1;
      } else if (startRaw !== '') {
        start = Number(startRaw);
        end = endRaw === '' ? total - 1 : Math.min(Number(endRaw), total - 1);
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        const ranged = await env.UPDATES.get(key, { range: { offset: start, length: end - start + 1 } });
        if (ranged) {
          return new Response(ranged.body, {
            status: 206,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }
      }
    }
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/**
 * `POST /release-code` — register a published code update. Admin only, exactly
 * like `POST /release`: the developer uploads the .asar to R2 themselves and
 * this endpoint only records the metadata (with checksums) once the file is in
 * place, so a half-uploaded object is never advertised.
 */
async function handleReleaseCode(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const b = await request.json().catch(() => null);
  const platform = String(b?.platform || '').trim();
  const version = String(b?.version || '').trim();
  const sha256 = String(b?.sha256 || '').trim();
  const size = Number(b?.size || 0);
  const minApp = String(b?.min_app_version || '').trim();

  if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(platform)) {
    return json({ ok: false, error: 'bad platform' }, 400);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) return json({ ok: false, error: 'bad version' }, 400);
  if (!/^[a-fA-F0-9]{64}$/.test(sha256)) return json({ ok: false, error: 'bad sha256' }, 400);
  if (!Number.isFinite(size) || size <= 0) return json({ ok: false, error: 'bad size' }, 400);
  if (!minApp || !/^\d+\.\d+\.\d+$/.test(minApp)) {
    return json({ ok: false, error: 'bad min_app_version' }, 400);
  }

  const asarUrl = `${platform}/${version}.asar`;

  await env.DB.prepare(`
    INSERT INTO code_releases (platform, version, asar_url, sha256, size, min_app_version, notes, published_at, is_published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, version) DO UPDATE SET
      asar_url = excluded.asar_url, sha256 = excluded.sha256, size = excluded.size,
      min_app_version = excluded.min_app_version, notes = excluded.notes,
      published_at = excluded.published_at, is_published = excluded.is_published
  `).bind(platform, version, asarUrl, sha256.toLowerCase(), size, minApp,
    String(b?.notes || ''), new Date().toISOString(), b?.publish === false ? 0 : 1).run();

  // The heartbeat mirrors `latest_version` into About; a code push is still a
  // newer build for the shop, so advertise it. Guarded so a code version
  // published before a full release is never treated as "the installed app".
  const cur = await env.DB.prepare(
    "SELECT value FROM remote_config WHERE key = 'latest_version' AND target = 'all'",
  ).first();
  const known = (cur?.value || '').trim();
  if (!known || compareVersions(version, known) > 0) {
    await env.DB.prepare(`
      INSERT INTO remote_config (key, target, value, updated_at) VALUES ('latest_version', 'all', ?, ?)
      ON CONFLICT(key, target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(version, new Date().toISOString()).run();
  }

  await tg(env, `⚡ <b>تحديث سريع (كود) منشور</b>\nالإصدار: <b>${version}</b>\nالمنصة: ${platform}\nيتطلب نسخة أساس: ${minApp}`);
  return json({ ok: true, version, platform });
}

/** A shared tiny wrapper so the account handlers above can return json. */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * `GET /update/win32-x64/<version>/RELEASES` — the manifest Squirrel reads.
 *
 * Answers 204 when there is nothing newer. Squirrel treats an empty body as
 * "up to date", which is exactly the desired behaviour for a shop already on
 * the current build.
 */
async function handleUpdateReleases(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  // /update/<platform>/<version>/RELEASES
  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';
  const from = parts[2] || '0.0.0';
  const deviceId = String(url.searchParams.get('device') || '').trim().toLowerCase();

  if (!await mayReceiveUpdates(env, deviceId)) {
    return noUpdate();
  }

  const rel = await currentRelease(env, platform);
  // Nothing published, or the shop already has it. `compareVersions` is used
  // rather than `!==` so a customer who somehow runs a NEWER build than the
  // server is never dragged backwards.
  if (!rel || compareVersions(rel.version, from) <= 0) {
    return noUpdate();
  }

  // Exactly the NuGet manifest format: hash, filename, length.
  const body = `${rel.sha1.toUpperCase()} ${rel.filename} ${rel.size}\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' },
  });
}

/** `GET /update/<platform>/<version>/<file>.nupkg` — the package itself. */
async function handleUpdatePackage(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });

  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';
  const file = parts[parts.length - 1] || '';

  // BOTH segments are attacker-controlled and BOTH are concatenated into the
  // R2 key, so both must be validated.
  //
  // Checking only the filename is not enough, and this was measured: `URL`
  // normalises `../` before the Worker ever sees the path, so
  // `/update/win32-x64/1.0.0/../../SECRET/private.key.nupkg` arrives already
  // collapsed to `/update/SECRET/private.key.nupkg`. The filename then looks
  // perfectly ordinary — the traversal has moved into the PLATFORM segment —
  // and the key becomes `SECRET/private.key.nupkg`, handing out any object in
  // the bucket. An allow-list of known platforms closes it completely.
  if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(platform)) {
    return new Response('bad platform', { status: 400 });
  }
  if (!/^[A-Za-z0-9._-]+\.nupkg$/.test(file) || file.includes('..')) {
    return new Response('bad file', { status: 400 });
  }

  const obj = await env.UPDATES.get(`${platform}/${file}`);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/**
 * `GET /update-nsis/<platform>/<version>/latest.yml` — the electron-updater
 * manifest for the NSIS installer.
 *
 * electron-updater (generic provider) appends `/latest.yml` to its feed URL,
 * reads `version` and the file list, then fetches each `.exe`/`.blockmap`
 * relative to the same directory. This endpoint behaves like the Squirrel
 * `RELEASES` manifest: no update when the client is already current.
 *
 * The manifest is generated by electron-builder at build time and uploaded to
 * R2 under `nsis/<platform>/latest.yml`. It is served as-is — its `sha512` and
 * file list are the bytes electron-updater will verify, and re-deriving them
 * here would be another place to get them wrong.
 */
async function handleNsisManifest(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });

  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';
  const from = parts[2] || '0.0.0';
  const deviceId = String(url.searchParams.get('device') || '').trim().toLowerCase();

  if (!await mayReceiveUpdates(env, deviceId)) {
    return noUpdate();
  }

  const rel = await currentRelease(env, platform);
  if (!rel) {
    return noUpdate();
  }

  // Always serve latest.yml with 200 when a release exists, even if the
  // customer is already on this version. electron-updater does its own
  // version comparison and concludes "no update needed" — but it CANNOT
  // parse a 204 response (rawData: null → "Cannot parse update info").
  // The old code returned 204 when the customer was current, which caused
  // electron-updater to throw on every check.
  const obj = await env.UPDATES.get(`nsis/${platform}/latest.yml`);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * `GET /update-nsis/<platform>/<version>/<file>.exe` or `[.blockmap]` — the
 * NSIS installer itself or its differential-update blockmap.
 *
 * Served straight from R2. electron-updater requests the `.blockmap` first and
 * downloads only the changed 256 KB blocks, so a small source change ships as a
 * small patch. Path and filename are both attacker-controlled, so both are
 * validated exactly as in handleUpdatePackage.
 */
async function handleNsisFile(request, env, url) {
  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });

  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';
  const file = parts[parts.length - 1] || '';
  return serveNsisFile(request, env, platform, file);
}

/**
 * `GET /download-nsis/<platform>/<file>` — PUBLIC distribution of the installer.
 *
 * The update feed (`/update-nsis/...`) requires the client key the app embeds,
 * so a browser clicking a share link gets 401. A brand-new shop has nothing
 * installed yet and must be able to fetch the Setup exe from a plain link, so
 * the installer and its blockmap are also published here WITHOUT the key. The
 * manifest (`latest.yml`) stays keyed to the update feed: a customer who can
 * read the manifest could already see the latest.yml served on the public R2
 * anyway, but keeping the gating means addresses a brand-new install in a
 * browser _can_ download the exe, which is the whole point of a distribution
 * link. Platform + filename are still validated exactly like the update feed.
 */
async function handleDownloadNsis(request, env, url) {
  if (!env.UPDATES) return new Response('no storage configured', { status: 503 });
  const parts = url.pathname.split('/').filter(Boolean);
  const platform = parts[1] || '';
  const file = parts[parts.length - 1] || '';
  return serveNsisFile(request, env, platform, file);
}

/** Shared Streaming-file logic for the NSIS installer and its blockmap. */
async function serveNsisFile(request, env, platform, file) {
  if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(platform)) {
    return new Response('bad platform', { status: 400 });
  }
  // NSIS setup names contain spaces and a version, e.g.
  // "MobileShopERP Setup 1.0.2.exe" and ".blockmap".
  if (!/^[A-Za-z0-9._ -]+\.(exe|blockmap)$/.test(file) || file.includes('..')) {
    return new Response('bad file', { status: 400 });
  }

  const key = `nsis/${platform}/${file}`;
  const obj = await env.UPDATES.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  // electron-updater fetches only the changed 256 KB blocks for a differential
  // update via HTTP Range. Without honouring `Range`, the whole ~130 MB
  // installer downloads on every update and the blockmap is pointless. R2's
  // `get(key, { range })` reads just that slice; we mirror it back with a 206.
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const startRaw = m[1], endRaw = m[2];
      const total = obj.size;
      let start, end;
      if (startRaw === '' && endRaw !== '') {
        // suffix range: last N bytes
        const n = Number(endRaw);
        start = Math.max(total - n, 0);
        end = total - 1;
      } else if (startRaw !== '') {
        start = Number(startRaw);
        end = endRaw === '' ? total - 1 : Math.min(Number(endRaw), total - 1);
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        const ranged = await env.UPDATES.get(key, { range: { offset: start, length: end - start + 1 } });
        if (ranged) {
          return new Response(ranged.body, {
            status: 206,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }
      }
    }
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/** Compares two dotted versions. Returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `POST /release` — publish a build. Admin only.
 *
 * The developer's machine uploads the .nupkg to R2 and then calls this with
 * its hash and size. Publishing is a separate, deliberate step so a
 * half-uploaded package can never be advertised to customers.
 */
async function handleRelease(request, env) {
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {
    return json({ ok: false, error: 'unauthorised' }, 401);
  }
  const b = await request.json().catch(() => null);
  const version = String(b?.version || '').trim();
  const filename = String(b?.filename || '').trim();
  const sha1 = String(b?.sha1 || '').trim();
  const sha512 = String(b?.sha512 || '').trim();
  const size = Number(b?.size || 0);
  const platform = String(b?.platform || 'win32-x64').trim();

  if (!/^\d+\.\d+\.\d+/.test(version)) return json({ ok: false, error: 'bad version' }, 400);
  if (!/^[A-Za-z0-9._ -]+\.(exe|nupkg)$/.test(filename)) return json({ ok: false, error: 'bad filename' }, 400);
  if (!/^[A-Fa-f0-9]{40}$/.test(sha1)) return json({ ok: false, error: 'bad sha1' }, 400);
  if (sha512 && !/^[A-Fa-f0-9]{128}$/.test(sha512)) return json({ ok: false, error: 'bad sha512' }, 400);
  if (!Number.isFinite(size) || size <= 0) return json({ ok: false, error: 'bad size' }, 400);

  await env.DB.prepare(`
    INSERT INTO releases (platform, version, filename, sha1, sha512, size, notes, published_at, is_published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, version) DO UPDATE SET
      filename = excluded.filename, sha1 = excluded.sha1, sha512 = excluded.sha512,
      size = excluded.size, notes = excluded.notes, published_at = excluded.published_at,
      is_published = excluded.is_published
  `).bind(platform, version, filename, sha1, sha512, size,
    String(b?.notes || ''), new Date().toISOString(),
    b?.publish === false ? 0 : 1).run();

  // The About screen shows this, so the shop sees a new version exists even
  // before Squirrel has finished downloading it.
  await env.DB.prepare(`
    INSERT INTO remote_config (key, target, value, updated_at) VALUES ('latest_version', 'all', ?, ?)
    ON CONFLICT(key, target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(version, new Date().toISOString()).run();

  await tg(env, `🚀 <b>إصدار جديد منشور</b>\nالإصدار: <b>${version}</b>\nالمنصة: ${platform}\nالحجم: ${(size / 1048576).toFixed(1)} MB`);
  return json({ ok: true, version, platform });
}

// ---------------------------------------------------------------- telegram UI
//
// The bot is menu-driven: every action is reachable by tapping, and typing a
// command is only ever an optional shortcut. Two Telegram constraints shape the
// design:
//   - callback_data is capped at 64 BYTES, so payloads stay short. A device id
//     is 32 chars, which fits alongside a short action prefix but leaves no
//     room for extra fields — anything larger is kept in `pending_actions`.
//   - a callback must be answered within ~10s or the client shows a stuck
//     spinner, so answerCallbackQuery is always called first.

async function tgCall(env, method, payload) {
  if (!env.TG_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The chat currently being served.
 *
 * With more than one admin, replying to `TG_ADMIN_CHAT` would send the answer
 * to the FIRST number no matter who asked — the second phone would press a
 * button and watch the reply arrive on the first. `handleTelegram` records
 * who is acting, and everything below answers them.
 */
function actingChat(env) {
  return env.__actingChat || adminChats(env)[0] || '';
}

const send = (env, text, keyboard) =>
  tgCall(env, 'sendMessage', {
    chat_id: actingChat(env), text, parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });

/** Replaces the current message instead of stacking new ones — feels like an app. */
const edit = (env, messageId, text, keyboard) =>
  tgCall(env, 'editMessageText', {
    chat_id: actingChat(env), message_id: messageId, text, parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });

/** Dismisses the button's loading spinner; must happen within ~10 seconds. */
const answer = (env, id, text) =>
  tgCall(env, 'answerCallbackQuery', { callback_query_id: id, text: text || undefined });

/**
 * Multi-step flows (e.g. "new code" -> ask device -> ask duration) need to
 * remember what the next typed message means. One row per chat is enough
 * because a single admin drives the bot.
 */
async function setPending(env, action, data) {
  await env.DB.prepare(`
    INSERT INTO pending_actions (chat_id, action, data, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET action = excluded.action,
      data = excluded.data, created_at = excluded.created_at
  `).bind(String(actingChat(env)), action, JSON.stringify(data || {}), new Date().toISOString()).run();
}

async function getPending(env) {
  const row = await env.DB.prepare('SELECT action, data, created_at FROM pending_actions WHERE chat_id = ?')
    .bind(String(actingChat(env))).first();
  if (!row) return null;
  // Expire stale prompts so a forgotten flow does not swallow a later command.
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
    await clearPending(env);
    return null;
  }
  return { action: row.action, data: JSON.parse(row.data || '{}') };
}

const clearPending = env =>
  env.DB.prepare('DELETE FROM pending_actions WHERE chat_id = ?').bind(String(actingChat(env))).run();

// ---------------------------------------------------------------- screens

const MAIN_MENU = [
  [{ text: '🔑 إنشاء كود تفعيل', callback_data: 'new' }],
  [{ text: '📱 الأجهزة', callback_data: 'devs:0' },
   { text: '⏰ تنتهي قريباً', callback_data: 'exp' }],
  [{ text: '💬 رسالة للجميع', callback_data: 'msgall' },
   { text: '📨 الرسائل', callback_data: 'msgs' }],
  [{ text: '⚙️ إعداد عام', callback_data: 'setall' },
   { text: '📊 إحصائيات', callback_data: 'stats' }],
  [{ text: '❓ مساعدة', callback_data: 'help' }],
];

const backTo = target => [[{ text: '⬅️ رجوع', callback_data: target }]];

/** Message management submenu. */
const MESSAGES_MENU = [
  [{ text: '📋 قائمة الرسائل', callback_data: 'msglist' }],
  [{ text: '🗑 حذف رسالة', callback_data: 'msgdel' },
   { text: '✏️ تعديل رسالة', callback_data: 'msgedit' }],
  [{ text: '👁 من قرأها', callback_data: 'msgreads' }],
  [{ text: '⬅️ القائمة الرئيسية', callback_data: 'main' }],
];

/** A message id typed by the admin: strictly a positive integer. */
function msgIdFrom(value) {
  const id = Number(String(value || '').trim());
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Lists the recent messages with their read counts, for the bot screen. */
async function screenMsgs(env, messageId) {
  const rows = await env.DB.prepare(`
    SELECT m.id, m.target, m.title, m.created_at, m.deleted_at,
      (SELECT COUNT(*) FROM message_reads r WHERE r.message_id = m.id) AS read_count
    FROM messages m
    ORDER BY m.id DESC LIMIT 15
  `).all();
  const list = rows?.results || [];
  if (!list.length) {
    return edit(env, messageId, '<b>📨 الرسائل</b>\n\nلا توجد رسائل بعد.', MESSAGES_MENU);
  }
  const lines = list.map(m => {
    const mark = m.deleted_at ? '🗑' : (m.target === 'all' ? '📢' : '👤');
    const when = (m.created_at || '').slice(0, 10);
    return `${mark} <b>#${m.id}</b> — ${(m.title || 'بلا عنوان').slice(0, 24)}\n` +
      `   ${when} · ${m.target === 'all' ? 'الكل' : 'جهاز'} · قرأها ${m.read_count}`;
  });
  return edit(env, messageId,
    `<b>📨 الرسائل</b>\n\n${lines.join('\n')}\n\nاختر إجراءً:`, MESSAGES_MENU);
}

/** Builds the "who read message #id" report text. Shared by bot and webhook. */
async function messageReadsReport(env, id) {
  const msg = await env.DB.prepare('SELECT target, deleted_at FROM messages WHERE id = ?').bind(id).first();
  if (!msg) return null;
  const reads = await env.DB.prepare(`
    SELECT r.read_at, r.device_id, d.shop_name
    FROM message_reads r LEFT JOIN devices d ON d.device_id = r.device_id
    WHERE r.message_id = ?
    ORDER BY r.read_at
  `).bind(id).all();
  const list = reads?.results || [];
  const readIds = new Set(list.map(r => r.device_id));
  let unreadCount;
  if (msg.target === 'all') {
    const all = await env.DB.prepare('SELECT device_id FROM devices').all();
    unreadCount = (all?.results || []).filter(d => !readIds.has(d.device_id)).length;
  } else {
    unreadCount = readIds.has(msg.target) ? 0 : 1;
  }
  const lines = list.length ? list.map(r =>
    `• ${r.shop_name || r.device_id} — ${(r.read_at || '').slice(0, 16)}`) : ['لا أحد قرأها بعد.'];
  return {
    name: msg.target === 'all' ? 'الكل' : `الجهاز ${msg.target}`,
    readCount: list.length, unreadCount, deleted: !!msg.deleted_at, lines,
    read: list.map(r => ({ deviceId: r.device_id, readAt: r.read_at, shopName: r.shop_name ?? null })),
  };
}

async function screenMain(env, messageId) {
  const text = '<b>🎛 لوحة التحكم</b>\n\nاختر ما تريد:';
  return messageId ? edit(env, messageId, text, MAIN_MENU) : send(env, text, MAIN_MENU);
}

/** Device list, 8 per page — keeps the keyboard under Telegram's button cap. */
async function screenDevices(env, messageId, page = 0) {
  const perPage = 8;
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first())?.n ?? 0;
  const rows = await env.DB.prepare(
    'SELECT device_id, shop_name, license_status, license_expiry FROM devices ORDER BY last_seen DESC LIMIT ? OFFSET ?',
  ).bind(perPage, page * perPage).all();
  const list = rows?.results || [];

  if (!list.length) {
    return edit(env, messageId, 'لا توجد أجهزة مسجّلة بعد.\n\nستظهر الأجهزة تلقائياً عند تشغيل التطبيق عند العميل.', backTo('main'));
  }

  const icon = s => s === 'active' ? '🟢' : s === 'trial' ? '🔵' : s === 'expired' ? '🔴' : '⚪';
  const keyboard = list.map(d => [{
    text: `${icon(d.license_status)} ${(d.shop_name || 'بلا اسم').slice(0, 28)}`,
    callback_data: `d:${d.device_id}`,     // 2 + 32 = 34 bytes, well inside the limit
  }]);

  const pages = Math.ceil(total / perPage);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ السابق', callback_data: `devs:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'التالي ▶️', callback_data: `devs:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '⬅️ القائمة الرئيسية', callback_data: 'main' }]);

  const text = `<b>📱 الأجهزة</b> (${total})\n` +
    `صفحة ${page + 1} من ${pages}\n\n🟢 مفعّل · 🔵 تجريبي · 🔴 منتهٍ · ⚪ غير معروف`;
  return edit(env, messageId, text, keyboard);
}

async function screenDevice(env, messageId, deviceId) {
  const d = await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?').bind(deviceId).first();
  if (!d) return edit(env, messageId, 'الجهاز غير موجود.', backTo('devs:0'));

  const codes = await env.DB.prepare(
    'SELECT code, expiry_days, issued_at FROM licenses WHERE device_id = ? ORDER BY serial DESC LIMIT 3',
  ).bind(deviceId).all();

  const label = s => s === 'active' ? '🟢 مفعّل' : s === 'trial' ? '🔵 تجريبي'
    : s === 'expired' ? '🔴 منتهٍ' : '⚪ غير معروف';

  // Registration details, when the owner consented to sharing them. Shown here
  // because "who is this shop, and what is their number" is the first thing
  // needed when a customer calls for support.
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE device_id = ?')
    .bind(deviceId).first();

  let text = `<b>${d.shop_name || 'بلا اسم'}</b>\n\n` +
    `الحالة: ${label(d.license_status)}\n` +
    `ينتهي: ${d.license_expiry || '—'}\n` +
    `الإصدار: ${d.app_version || '—'}\n` +
    `النظام: ${d.platform || '—'}\n` +
    `أول ظهور: ${(d.first_seen || '').slice(0, 10) || '—'}\n` +
    `آخر ظهور: ${(d.last_seen || '').slice(0, 16).replace('T', ' ') || '—'}\n` +
    `عدد الاتصالات: ${d.seen_count ?? 0}\n\n` +
    `<code>${d.device_id}</code>`;

  if (reg) {
    text += `\n\n<b>بيانات التسجيل</b>\n` +
      `المالك: ${reg.owner_name || '—'}\n` +
      `الهاتف: ${reg.phone || '—'}\n` +
      `البريد: ${reg.email || '—'}\n` +
      `المحافظة: ${reg.governorate || '—'} - ${reg.city || '—'}\n` +
      `العنوان: ${reg.address || '—'}\n` +
      `الميلاد: ${reg.birth_date || '—'}`;
  }

  const history = codes?.results || [];
  if (history.length) {
    text += '\n\n<b>آخر الأكواد:</b>';
    for (const c of history) {
      const exp = c.expiry_days === 0 ? 'غير محدود' : daysToDate(c.expiry_days);
      text += `\n• <code>${c.code}</code> — ${exp}`;
    }
  }

  const keyboard = [
    [{ text: '🔑 كود جديد', callback_data: `nd:${deviceId}` }],
    [{ text: '💬 رسالة لهذا العميل', callback_data: `md:${deviceId}` }],
    [{ text: '⚙️ إعداد خاص به', callback_data: `sd:${deviceId}` }],
    [{ text: '⬅️ الأجهزة', callback_data: 'devs:0' },
     { text: '🏠 الرئيسية', callback_data: 'main' }],
  ];
  return edit(env, messageId, text, keyboard);
}

/** Duration picker — avoids making the admin type a number. */
function durationKeyboard(prefix) {
  return [
    [{ text: 'شهر', callback_data: `${prefix}:30` },
     { text: '3 شهور', callback_data: `${prefix}:90` },
     { text: '6 شهور', callback_data: `${prefix}:180` }],
    [{ text: 'سنة', callback_data: `${prefix}:365` },
     { text: 'سنتان', callback_data: `${prefix}:730` }],
    [{ text: '♾ غير محدود', callback_data: `${prefix}:0` }],
    [{ text: '✏️ مدة أخرى', callback_data: `${prefix}:x` }],
    [{ text: '⬅️ إلغاء', callback_data: 'main' }],
  ];
}

async function issueAndShow(env, messageId, deviceId, days) {
  const expiryDays = days === 0 ? 0 : todayDays() + days;
  if (expiryDays > 0xffff) return edit(env, messageId, 'المدة طويلة جداً.', backTo('main'));

  const serial = await nextCloudSerial(env);
  const code = await signCode(env.LICENSE_PRIVATE_KEY, deviceId, expiryDays, serial);
  const expiry = expiryDays === 0 ? 'غير محدود' : daysToDate(expiryDays);

  await env.DB.prepare(`INSERT INTO licenses (serial, device_id, code, expiry_days, issued_at, issued_by, note)
    VALUES (?, ?, ?, ?, ?, 'bot', '')`)
    .bind(serial, deviceId, code, expiryDays, new Date().toISOString()).run();

  await clearPending(env);

  // Sent as a separate message so the admin can forward it to the customer
  // as-is, without the surrounding dashboard chrome.
  await send(env,
    `كود التفعيل الخاص بك:\n\n<code>${code}</code>\n\n` +
    `صالح حتى: ${expiry}\n` +
    `انسخ الكود والصقه في شاشة التفعيل ثم اضغط "تفعيل".`);

  return edit(env,
    messageId,
    `✅ <b>تم إنشاء الكود</b>\n\n<code>${code}</code>\n\n` +
    `الجهاز: <code>${deviceId}</code>\n` +
    `صالح حتى: ${expiry}\nرقم الإصدار: #${serial}\n\n` +
    `👆 الرسالة التالية جاهزة لإعادة توجيهها للعميل.`,
    [[{ text: '📱 الأجهزة', callback_data: 'devs:0' },
      { text: '🏠 الرئيسية', callback_data: 'main' }]],
  );
}

/** Common presentation keys, so the admin rarely has to remember key names. */
const CONFIG_KEYS = [
  ['dev_name', 'اسم المطور'],
  ['dev_title', 'صفة المطور'],
  ['dev_phone', 'رقم الهاتف'],
  ['dev_whatsapp', 'واتساب'],
  ['dev_telegram', 'تليجرام'],
  ['dev_email', 'الإيميل'],
  ['payment_info', 'معلومات الدفع'],
  ['subscription_note', 'ملاحظة الاشتراك'],
  ['support_hours', 'مواعيد الدعم'],
  ['app_name', 'اسم البرنامج'],
  ['custom_content', 'معلومات إضافية'],
  ['about_footer', 'نص أسفل صفحة حول البرنامج'],
  ['copyright', 'حقوق النشر'],
  ['distribution_rights', 'حقوق التوزيع'],
  ['terms_note', 'شروط الاستخدام'],
];

function configKeyboard(target) {
  const rows = CONFIG_KEYS.map(([k, label]) => [{ text: label, callback_data: `k:${target}:${k}` }]);
  rows.push([{ text: '⬅️ رجوع', callback_data: target === 'all' ? 'main' : `d:${target}` }]);
  return rows;
}

async function screenStats(env, messageId) {
  const g = async q => (await env.DB.prepare(q).first())?.n ?? 0;
  const total = await g('SELECT COUNT(*) AS n FROM devices');
  const active = await g("SELECT COUNT(*) AS n FROM devices WHERE license_status = 'active'");
  const trial = await g("SELECT COUNT(*) AS n FROM devices WHERE license_status = 'trial'");
  const expired = await g("SELECT COUNT(*) AS n FROM devices WHERE license_status = 'expired'");
  const codes = await g('SELECT COUNT(*) AS n FROM licenses');
  const week = daysToDate(todayDays() + 7);
  const soon = (await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM devices WHERE license_expiry IS NOT NULL AND license_expiry <= ?',
  ).bind(week).first())?.n ?? 0;

  return edit(env, messageId,
    `<b>📊 إحصائيات</b>\n\n` +
    `إجمالي الأجهزة: ${total}\n` +
    `🟢 مفعّل: ${active}\n🔵 تجريبي: ${trial}\n🔴 منتهٍ: ${expired}\n\n` +
    `⏰ ينتهي خلال أسبوع: ${soon}\n🔑 أكواد صدرت: ${codes}`,
    backTo('main'));
}

async function screenExpiring(env, messageId) {
  const limit = daysToDate(todayDays() + 14);
  const rows = await env.DB.prepare(
    'SELECT device_id, shop_name, license_expiry FROM devices WHERE license_expiry IS NOT NULL AND license_expiry <= ? ORDER BY license_expiry LIMIT 10',
  ).bind(limit).all();
  const list = rows?.results || [];
  if (!list.length) {
    return edit(env, messageId, '✅ لا توجد اشتراكات تنتهي خلال 14 يوماً.', backTo('main'));
  }
  const keyboard = list.map(d => [{
    text: `${d.shop_name || 'بلا اسم'} — ${d.license_expiry}`.slice(0, 40),
    callback_data: `d:${d.device_id}`,
  }]);
  keyboard.push([{ text: '🏠 الرئيسية', callback_data: 'main' }]);
  return edit(env, messageId, `<b>⏰ تنتهي خلال 14 يوماً</b> (${list.length})\n\nاضغط على أي عميل للتفاصيل:`, keyboard);
}

// ---------------------------------------------------------------- dispatch

async function handleCallback(env, cb) {
  const data = String(cb.data || '');
  const messageId = cb.message?.message_id;
  await answer(env, cb.id);           // dismiss the spinner first

  if (data === 'main') { await clearPending(env); return screenMain(env, messageId); }
  if (data === 'stats') return screenStats(env, messageId);
  if (data === 'exp') return screenExpiring(env, messageId);

  if (data === 'help') {
    return edit(env, messageId,
      '<b>❓ كيف تستخدم البوت</b>\n\n' +
      '<b>لإنشاء كود:</b>\n' +
      '1. اضغط "إنشاء كود تفعيل"\n2. الصق معرّف الجهاز\n3. اختر المدة\n\n' +
      '<b>أو من الأجهزة:</b>\n' +
      'اضغط "الأجهزة" ← اختر عميلاً ← "كود جديد"\n\n' +
      '<b>أوامر مختصرة (اختيارية):</b>\n' +
      '<code>/new &lt;id&gt; &lt;days&gt;</code>\n<code>/devices</code>\n<code>/expiring</code>\n\n' +
      'الأجهزة تظهر تلقائياً عند تشغيل التطبيق عند العميل.',
      backTo('main'));
  }

  if (data.startsWith('devs:')) return screenDevices(env, messageId, parseInt(data.slice(5), 10) || 0);
  if (data.startsWith('d:')) return screenDevice(env, messageId, data.slice(2));

  // --- issue a code, device not chosen yet
  if (data === 'new') {
    await setPending(env, 'await_device', {});
    return edit(env, messageId,
      '<b>🔑 إنشاء كود تفعيل</b>\n\nالصق <b>معرّف الجهاز</b> الذي أرسله العميل:',
      backTo('main'));
  }

  // --- issue a code for a known device
  if (data.startsWith('nd:')) {
    const deviceId = data.slice(3);
    await setPending(env, 'await_duration', { deviceId });
    return edit(env, messageId,
      `<b>🔑 كود جديد</b>\n\nالجهاز: <code>${deviceId}</code>\n\nاختر المدة:`,
      durationKeyboard('dur'));
  }

  if (data.startsWith('dur:')) {
    const choice = data.slice(4);
    const pending = await getPending(env);
    const deviceId = pending?.data?.deviceId;
    if (!deviceId) return edit(env, messageId, 'انتهت الجلسة. ابدأ من جديد.', backTo('main'));
    if (choice === 'x') {
      await setPending(env, 'await_custom_days', { deviceId });
      return edit(env, messageId, 'اكتب عدد الأيام (رقم فقط، 0 = غير محدود):', backTo('main'));
    }
    return issueAndShow(env, messageId, deviceId, parseInt(choice, 10));
  }

  // --- messaging
  if (data === 'msgall') {
    await setPending(env, 'await_msg', { target: 'all' });
    return edit(env, messageId,
      '<b>💬 رسالة للجميع</b>\n\nاكتب نص الرسالة التي ستظهر لكل العملاء:', backTo('main'));
  }
  if (data.startsWith('md:')) {
    const deviceId = data.slice(3);
    await setPending(env, 'await_msg', { target: deviceId });
    return edit(env, messageId,
      `<b>💬 رسالة خاصة</b>\n\nإلى: <code>${deviceId}</code>\n\nاكتب نص الرسالة:`,
      [[{ text: '⬅️ رجوع', callback_data: `d:${deviceId}` }]]);
  }

  // --- message management (listed / delete / edit / readers)
  if (data === 'msgs' || data === 'msglist') return screenMsgs(env, messageId);
  if (data === 'msgdel') {
    await setPending(env, 'await_msgdel', {});
    return edit(env, messageId, '<b>🗑 حذف رسالة</b>\n\n' +
      'اكتب <b>رقم الرسالة</b> من القائمة أعلاه:', MESSAGES_MENU);
  }
  if (data === 'msgedit') {
    await setPending(env, 'await_msgedit', {});
    return edit(env, messageId, '<b>✏️ تعديل رسالة</b>\n\n' +
      'اكتب <b>رقم الرسالة</b> من القائمة أعلاه:', MESSAGES_MENU);
  }
  if (data === 'msgreads') {
    await setPending(env, 'await_msgreads', {});
    return edit(env, messageId, '<b>👁 من قرأها</b>\n\n' +
      'اكتب <b>رقم الرسالة</b> من القائمة أعلاه:', MESSAGES_MENU);
  }

  // --- remote settings
  if (data === 'setall') {
    return edit(env, messageId, '<b>⚙️ إعداد عام لكل العملاء</b>\n\nاختر ما تريد تغييره:', configKeyboard('all'));
  }
  if (data.startsWith('sd:')) {
    const deviceId = data.slice(3);
    return edit(env, messageId,
      `<b>⚙️ إعداد خاص</b>\n\nالجهاز: <code>${deviceId}</code>\n\nاختر ما تريد تغييره:`,
      configKeyboard(deviceId));
  }
  if (data.startsWith('k:')) {
    const [, target, key] = data.split(':');
    await setPending(env, 'await_config', { target, key });
    const label = CONFIG_KEYS.find(([k]) => k === key)?.[1] || key;
    return edit(env, messageId,
      `<b>⚙️ ${label}</b>\n\n${target === 'all' ? 'لكل العملاء' : `للجهاز <code>${target}</code>`}\n\n` +
      `اكتب القيمة الجديدة (أو <code>-</code> لإلغاء التخصيص):`,
      backTo(target === 'all' ? 'setall' : `sd:${target}`));
  }

  return screenMain(env, messageId);
}

/** Handles a typed message: either it answers a pending prompt, or it is a command. */
async function handleText(env, text) {
  const trimmed = text.trim();

  // A slash command always wins over a pending prompt. Without this, asking for
  // a device id and then typing /start stored "/start" as the device id, and
  // there was no way out of a flow except waiting for it to expire.
  if (trimmed.startsWith('/')) {
    await clearPending(env);
    return handleCommand(env, trimmed);
  }

  const pending = await getPending(env);

  if (pending) {
    const value = text.trim();

    if (pending.action === 'await_device') {
      const deviceId = value.toLowerCase();
      if (deviceId.length < 8) return send(env, '⚠️ معرّف الجهاز غير صالح. حاول مرة أخرى أو اضغط /start.');
      await setPending(env, 'await_duration', { deviceId });
      return send(env, `الجهاز: <code>${deviceId}</code>\n\nاختر المدة:`, durationKeyboard('dur'));
    }

    if (pending.action === 'await_custom_days') {
      const days = parseInt(value, 10);
      if (!Number.isFinite(days) || days < 0) return send(env, '⚠️ اكتب رقماً صحيحاً.');
      const sent = await send(env, '⏳ جاري الإنشاء...');
      return issueAndShow(env, sent?.result?.message_id, pending.data.deviceId, days);
    }

    if (pending.action === 'await_msg') {
      await env.DB.prepare(`INSERT INTO messages (target, title, body, severity, created_at, updated_at)
        VALUES (?, 'رسالة من المطور', ?, 'info', ?, ?)`)
        .bind(pending.data.target, value, new Date().toISOString(), new Date().toISOString()).run();
      await clearPending(env);
      return send(env,
        `✅ تم جدولة الرسالة${pending.data.target === 'all' ? ' لكل العملاء' : ''}.\n` +
        `ستظهر عند العميل في المزامنة القادمة.`, MAIN_MENU);
    }

    // --- message management: delete / edit / readers
    if (pending.action === 'await_msgdel') {
      const id = msgIdFrom(value);
      if (!id) return send(env, '⚠️ اكتب رقم الرسالة الصحيح (مثلاً 12).', MESSAGES_MENU);
      const res = await env.DB.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), id).run();
      if (!res.meta?.changes) return send(env, `⚠️ لا توجد رسالة رقم ${id}.`, MESSAGES_MENU);
      await clearPending(env);
      return send(env,
        `🗑 تم حذف الرسالة <b>#${id}</b>.\n\n` +
        `ستختفي من عملائها في المزامنة القادمة.`, MESSAGES_MENU);
    }

    if (pending.action === 'await_msgedit') {
      const id = msgIdFrom(value);
      if (!id) return send(env, '⚠️ اكتب رقم الرسالة الصحيح (مثلاً 12).', MESSAGES_MENU);
      await setPending(env, 'await_msgedit_text', { id });
      return send(env,
        `<b>✏️ تعديل الرسالة #${id}</b>\n\nاكتب النص الجديد:`, MESSAGES_MENU);
    }

    if (pending.action === 'await_msgedit_text') {
      const id = pending.data?.id;
      const res = await env.DB.prepare('UPDATE messages SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .bind(String(value), new Date().toISOString(), id).run();
      if (!res.meta?.changes) return send(env, `⚠️ لا توجد رسالة رقم ${id}.`, MESSAGES_MENU);
      await clearPending(env);
      return send(env,
        `✏️ تم تعديل الرسالة <b>#${id}</b>.\n\n` +
        `يصل النص الجديد للعملاء في المزامنة القادمة.`, MESSAGES_MENU);
    }

    if (pending.action === 'await_msgreads') {
      const id = msgIdFrom(value);
      if (!id) return send(env, '⚠️ اكتب رقم الرسالة الصحيح (مثلاً 12).', MESSAGES_MENU);
      const report = await messageReadsReport(env, id);
      if (!report) return send(env, `⚠️ لا توجد رسالة رقم ${id}.`, MESSAGES_MENU);
      await clearPending(env);
      return send(env,
        `<b>👁 الرسالة #${id}</b> — إلى ${report.name}\n` +
        `قرأها: ${report.readCount} · لم يقرأها: ${report.unreadCount}` +
        (report.deleted ? ' · 🗑 محذوفة' : '') + `\n\n${report.lines.join('\n')}`,
        MESSAGES_MENU);
    }

    if (pending.action === 'await_config') {
      const { target, key } = pending.data;
      const stored = value === '-' ? '' : value;
      await env.DB.prepare(`INSERT INTO remote_config (key, target, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key, target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key, target, stored, new Date().toISOString()).run();
      await clearPending(env);
      return send(env,
        `✅ تم ضبط <code>${key}</code>\n\n` +
        (stored ? `القيمة: ${stored}` : 'تم إلغاء التخصيص — سيعود للقيمة المحلية.') +
        `\n\nيصل التغيير عند المزامنة القادمة.`, MAIN_MENU);
    }
  }

  // Not a command and no prompt pending — fall through to the shortcuts below.
  return handleCommand(env, trimmed);
}

/** Typed shortcuts. The menu covers everything; these just save taps. */
async function handleCommand(env, text) {
  const [cmd, ...args] = text.split(/\s+/);

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return screenMain(env);
  }
  if (cmd === '/devices') { const m = await send(env, '...'); return screenDevices(env, m?.result?.message_id, 0); }
  if (cmd === '/expiring') { const m = await send(env, '...'); return screenExpiring(env, m?.result?.message_id); }
  if (cmd === '/stats') { const m = await send(env, '...'); return screenStats(env, m?.result?.message_id); }
  if (cmd === '/new') {
    const [dev, d] = args;
    if (!dev) { await setPending(env, 'await_device', {}); return send(env, 'الصق معرّف الجهاز:'); }
    if (d === undefined) {
      await setPending(env, 'await_duration', { deviceId: dev.toLowerCase() });
      return send(env, `الجهاز: <code>${dev}</code>\n\nاختر المدة:`, durationKeyboard('dur'));
    }
    const m = await send(env, '⏳ جاري الإنشاء...');
    return issueAndShow(env, m?.result?.message_id, dev.toLowerCase(), parseInt(d, 10));
  }

  // A bare 32-char hex string is almost certainly a device id pasted directly.
  if (/^[a-f0-9]{16,64}$/i.test(text.trim())) {
    const deviceId = text.trim().toLowerCase();
    const known = await env.DB.prepare('SELECT device_id FROM devices WHERE device_id = ?').bind(deviceId).first();
    if (known) { const m = await send(env, '...'); return screenDevice(env, m?.result?.message_id, deviceId); }
    await setPending(env, 'await_duration', { deviceId });
    return send(env, `جهاز جديد: <code>${deviceId}</code>\n\nاختر المدة:`, durationKeyboard('dur'));
  }

  return screenMain(env);
}

async function handleTelegram(request, env) {
  // ===== IS THIS REQUEST REALLY FROM TELEGRAM? =====
  //
  // This must come FIRST, before the body is even read. The chat id below is
  // part of the payload, so it proves nothing on its own — anyone who knows
  // the URL can write `{"chat":{"id":<the owner's id>}}` and did, in a measured
  // exploit that minted a signed ten-year licence. See the note at the top of
  // this file.
  //
  // `secret_token` is Telegram's own mechanism: it is registered with
  // `setWebhook` and returned on every delivery in this header. It is compared
  // in constant time, like every other credential here.
  //
  // FAILS CLOSED. If the secret is not configured the webhook refuses
  // everything, because the alternative — accepting everything — is the
  // vulnerability this exists to remove.
  const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !safeEqual(presented, env.TG_WEBHOOK_SECRET)) {
    // Answered exactly like an unknown chat id: 200 with an empty
    // acknowledgement. A distinct status or message would tell a prober that
    // the endpoint exists and that it is looking for a header.
    console.error('[worker] /telegram rejected: webhook secret missing or wrong');
    return json({ ok: true });
  }

  const update = await request.json().catch(() => null);

  // Only the owner may drive the bot; everyone else is ignored silently so the
  // bot does not even reveal that it exists.
  //
  // Kept as a SECOND layer even though the header is now proved: the header
  // says the request came from Telegram, this says it came from the owner.
  // Telegram delivers messages from anyone who finds the bot.
  const cb = update?.callback_query;
  const msg = update?.message;
  const chatId = String(cb?.from?.id || msg?.chat?.id || '');
  if (!isAdminChat(env, chatId)) return json({ ok: true });

  // Answer whoever asked. Each admin also keeps their OWN pending-prompt state,
  // keyed by chat id, so one owner mid-flow cannot swallow the other's command.
  env.__actingChat = chatId;

  try {
    if (cb) await handleCallback(env, cb);
    else if (msg?.text) await handleText(env, String(msg.text));
  } catch (err) {
    await send(env, `⚠️ خطأ: ${err.message}`);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- router
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Read-only routes answer HEAD like GET (same status + headers, no body),
    // so probes and tooling that only need "is it there / how big" work
    // without downloading 115 MB. POST routes below are unaffected.
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const out = (r) => request.method === 'HEAD'
      ? new Response(null, { status: r.status, headers: r.headers })
      : r;
    try {
      await ensureSchema(env);
      if (request.method === 'POST') {
        switch (url.pathname) {
          case '/heartbeat': return await handleHeartbeat(request, env);
          case '/issue':     return await handleIssue(request, env);
          case '/config':    return await handleConfig(request, env);
          case '/message':   return await handleMessage(request, env);
          case '/telegram':  return await handleTelegram(request, env);
          case '/database-reset': return await handleDatabaseReset(request, env);
          case '/registration':   return await handleRegistration(request, env);
          case '/release':        return await handleRelease(request, env);
          case '/release-code':   return await handleReleaseCode(request, env);
        }
      }
      if (isRead && url.pathname === '/devices') {
        return out(await handleDevices(request, env));
      }
      // Squirrel.Windows appends "/RELEASES" to the feed URL and then fetches
      // the .nupkg named inside it, relative to the same directory. Both are
      // plain GETs, so they are matched by shape rather than exact path.
      if (isRead && url.pathname.startsWith('/update/')) {
        if (url.pathname.endsWith('/RELEASES')) {
          return out(await handleUpdateReleases(request, env, url));
        }
        if (url.pathname.endsWith('.nupkg')) {
          return out(await handleUpdatePackage(request, env, url));
        }
      }
      // NSIS (electron-updater) — `latest.yml` + the Setup exe + its blockmap.
      // electron-updater appends "/latest.yml" to the feed URL, then fetches
      // the files named inside it, relative to the same directory. Served
      // from R2 bucket `UPDATES` (key prefix `nsis/<platform>/`).
      if (isRead && url.pathname.startsWith('/update-nsis/')) {
        if (url.pathname.endsWith('/latest.yml')) {
          return out(await handleNsisManifest(request, env, url));
        }
        if (url.pathname.endsWith('.exe') || url.pathname.endsWith('.blockmap')) {
          return out(await handleNsisFile(request, env, url));
        }
      }
      // Public installer distribution: a plain browser link with no client key.
      // Share this URL with a new customer so they can download the Setup exe.
      if (isRead && url.pathname.startsWith('/download-nsis/')) {
        if (url.pathname.endsWith('.exe') || url.pathname.endsWith('.blockmap')) {
          return out(await handleDownloadNsis(request, env, url));
        }
      }
      // Code push (fast lane): manifest + the swapped `app.asar`, R2-backed.
      if (isRead && url.pathname.startsWith('/code-update/')) {
        if (url.pathname.endsWith('/manifest.json')) {
          return out(await handleCodeManifest(request, env, url));
        }
      }
      if (isRead && url.pathname.startsWith('/code/')) {
        if (url.pathname.endsWith('.asar')) {
          return out(await handleCodeFile(request, env, url));
        }
      }
      if (isRead && url.pathname === '/health') return out(json({ ok: true }));
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      // The catch-all must not describe the fault to whoever triggered it.
      //
      // MEASURED against the real exported fetch with a D1 that throws: EVERY
      // public endpoint — /health, /heartbeat, /registration, the update feed
      // — answered
      //
      //     {"ok":false,"error":"D1_ERROR: no such table: devices at /worker/db.js:412"}
      //
      // to an anonymous caller. That names the table, the internal file and a
      // line number, and /health needs no credential at all, so it is a free
      // probe: send a malformed request, read the schema out of the reply.
      //
      // The detail goes to `wrangler tail` where the developer can read it,
      // keyed by a reference the caller is also given so a report can be
      // matched to a log line.
      const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
      console.error(`[worker] ref=${ref}`, err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'internal error', ref }, 500);
    }
  },

  /** Daily sweep: warn about subscriptions expiring within a week. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const limit = daysToDate(todayDays() + 7);
      const rows = await env.DB.prepare(
        "SELECT shop_name, device_id, license_expiry FROM devices WHERE license_expiry IS NOT NULL AND license_expiry <= ? ORDER BY license_expiry",
      ).bind(limit).all();
      const list = rows?.results || [];
      if (list.length) {
        await tg(env, `⏰ <b>اشتراكات تنتهي خلال أسبوع</b>\n` +
          list.map(r => `• ${r.shop_name || '—'} — ${r.license_expiry}`).join('\n'));
      }
    })());
  },
};
