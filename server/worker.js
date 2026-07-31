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
 *   npx wrangler secret put LICENSE_SECRET # same value as the app's VERIFIER_SECRET
 *   npx wrangler secret put TG_BOT_TOKEN   # from @BotFather
 *   npx wrangler secret put TG_ADMIN_CHAT  # your numeric Telegram chat id
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

async function signCode(secret, deviceId, expiryDays, serial) {
  const payload = new Uint8Array(5);
  new DataView(payload.buffer).setUint16(0, expiryDays & 0xffff);
  payload[2] = (serial >> 16) & 0xff;
  payload[3] = (serial >> 8) & 0xff;
  payload[4] = serial & 0xff;
  const tag = await hmac5(secret, deviceId, payload);
  return encodeBase32(new Uint8Array([...payload, ...tag])).match(/.{1,4}/g).join('-');
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

async function tg(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_ADMIN_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_ADMIN_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch { /* notification failure must never break the request */ }
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
      expires_at TEXT
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
  ]);
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
      AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.device_id = ?)
    ORDER BY m.id DESC LIMIT 20
  `).bind(deviceId, deviceId).all();

  const toObj = rows => Object.fromEntries((rows?.results || []).map(r => [r.key, r.value]));

  return json({
    ok: true,
    config: { all: toObj(cfgAll), device: toObj(cfgDev) },
    messages: (msgs?.results || []).map(m => ({
      id: m.id, title: m.title, body: m.body,
      severity: m.severity, createdAt: m.created_at, expiresAt: m.expires_at,
    })),
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
  const code = await signCode(env.LICENSE_SECRET, deviceId, expiryDays, serial);
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
  if (!b?.title && !b?.body) return json({ ok: false, error: 'empty message' }, 400);
  const res = await env.DB.prepare(`
    INSERT INTO messages (target, title, body, severity, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(String(b.target || 'all'), String(b.title || ''), String(b.body || ''),
    String(b.severity || 'info'), new Date().toISOString(), b.expiresAt || null).run();
  return json({ ok: true, id: res.meta?.last_row_id });
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

const send = (env, text, keyboard) =>
  tgCall(env, 'sendMessage', {
    chat_id: env.TG_ADMIN_CHAT, text, parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });

/** Replaces the current message instead of stacking new ones — feels like an app. */
const edit = (env, messageId, text, keyboard) =>
  tgCall(env, 'editMessageText', {
    chat_id: env.TG_ADMIN_CHAT, message_id: messageId, text, parse_mode: 'HTML',
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
  `).bind(String(env.TG_ADMIN_CHAT), action, JSON.stringify(data || {}), new Date().toISOString()).run();
}

async function getPending(env) {
  const row = await env.DB.prepare('SELECT action, data, created_at FROM pending_actions WHERE chat_id = ?')
    .bind(String(env.TG_ADMIN_CHAT)).first();
  if (!row) return null;
  // Expire stale prompts so a forgotten flow does not swallow a later command.
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
    await clearPending(env);
    return null;
  }
  return { action: row.action, data: JSON.parse(row.data || '{}') };
}

const clearPending = env =>
  env.DB.prepare('DELETE FROM pending_actions WHERE chat_id = ?').bind(String(env.TG_ADMIN_CHAT)).run();

// ---------------------------------------------------------------- screens

const MAIN_MENU = [
  [{ text: '🔑 إنشاء كود تفعيل', callback_data: 'new' }],
  [{ text: '📱 الأجهزة', callback_data: 'devs:0' },
   { text: '⏰ تنتهي قريباً', callback_data: 'exp' }],
  [{ text: '💬 رسالة للجميع', callback_data: 'msgall' },
   { text: '⚙️ إعداد عام', callback_data: 'setall' }],
  [{ text: '📊 إحصائيات', callback_data: 'stats' },
   { text: '❓ مساعدة', callback_data: 'help' }],
];

const backTo = target => [[{ text: '⬅️ رجوع', callback_data: target }]];

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

  let text = `<b>${d.shop_name || 'بلا اسم'}</b>\n\n` +
    `الحالة: ${label(d.license_status)}\n` +
    `ينتهي: ${d.license_expiry || '—'}\n` +
    `الإصدار: ${d.app_version || '—'}\n` +
    `النظام: ${d.platform || '—'}\n` +
    `أول ظهور: ${(d.first_seen || '').slice(0, 10) || '—'}\n` +
    `آخر ظهور: ${(d.last_seen || '').slice(0, 16).replace('T', ' ') || '—'}\n` +
    `عدد الاتصالات: ${d.seen_count ?? 0}\n\n` +
    `<code>${d.device_id}</code>`;

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
  const code = await signCode(env.LICENSE_SECRET, deviceId, expiryDays, serial);
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
  ['dev_phone', 'رقم الهاتف'],
  ['dev_whatsapp', 'واتساب'],
  ['dev_telegram', 'تليجرام'],
  ['dev_email', 'الإيميل'],
  ['payment_info', 'معلومات الدفع'],
  ['subscription_note', 'ملاحظة الاشتراك'],
  ['support_hours', 'مواعيد الدعم'],
  ['app_name', 'اسم البرنامج'],
  ['custom_content', 'معلومات إضافية'],
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
      await env.DB.prepare(`INSERT INTO messages (target, title, body, severity, created_at)
        VALUES (?, 'رسالة من المطور', ?, 'info', ?)`)
        .bind(pending.data.target, value, new Date().toISOString()).run();
      await clearPending(env);
      return send(env,
        `✅ تم جدولة الرسالة${pending.data.target === 'all' ? ' لكل العملاء' : ''}.\n` +
        `ستظهر عند العميل في المزامنة القادمة.`, MAIN_MENU);
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
  const update = await request.json().catch(() => null);

  // Only the owner may drive the bot; everyone else is ignored silently so the
  // bot does not even reveal that it exists.
  const cb = update?.callback_query;
  const msg = update?.message;
  const chatId = String(cb?.from?.id || msg?.chat?.id || '');
  if (!chatId || chatId !== String(env.TG_ADMIN_CHAT)) return json({ ok: true });

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
    try {
      await ensureSchema(env);
      if (request.method === 'POST') {
        switch (url.pathname) {
          case '/heartbeat': return await handleHeartbeat(request, env);
          case '/issue':     return await handleIssue(request, env);
          case '/config':    return await handleConfig(request, env);
          case '/message':   return await handleMessage(request, env);
          case '/telegram':  return await handleTelegram(request, env);
        }
      }
      if (request.method === 'GET' && url.pathname === '/devices') {
        return await handleDevices(request, env);
      }
      if (url.pathname === '/health') return json({ ok: true });
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
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
