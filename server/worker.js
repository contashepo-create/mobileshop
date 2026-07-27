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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0
    )`),
  ]);
}

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
      shop_name = excluded.shop_name,
      app_version = excluded.app_version,
      platform = excluded.platform,
      license_status = excluded.license_status,
      license_expiry = excluded.license_expiry,
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

// ---------------------------------------------------------------- telegram
async function handleTelegram(request, env) {
  const update = await request.json().catch(() => null);
  const msg = update?.message;
  const chatId = String(msg?.chat?.id || '');
  // Only the owner may drive the bot; anyone else is ignored silently.
  if (!chatId || chatId !== String(env.TG_ADMIN_CHAT)) return json({ ok: true });

  const text = String(msg?.text || '').trim();
  const [cmd, ...args] = text.split(/\s+/);
  const reply = async t => tg(env, t);

  try {
    if (cmd === '/start' || cmd === '/help') {
      await reply(
        '<b>أوامر البوت</b>\n' +
        '/new &lt;device_id&gt; &lt;days&gt; — إنشاء كود (0 = غير محدود)\n' +
        '/devices — آخر الأجهزة\n' +
        '/device &lt;id&gt; — تفاصيل جهاز\n' +
        '/expiring — اشتراكات تنتهي خلال 14 يوم\n' +
        '/msg &lt;id|all&gt; &lt;نص&gt; — إرسال رسالة\n' +
        '/set &lt;id|all&gt; &lt;key&gt; &lt;value&gt; — تعديل إعداد',
      );
    } else if (cmd === '/new') {
      const [dev, d] = args;
      if (!dev || d === undefined) { await reply('الاستخدام: /new &lt;device_id&gt; &lt;days&gt;'); return json({ ok: true }); }
      const expiryDays = Number(d) === 0 ? 0 : todayDays() + Number(d);
      const serial = await nextCloudSerial(env);
      const code = await signCode(env.LICENSE_SECRET, dev.toLowerCase(), expiryDays, serial);
      const expiry = expiryDays === 0 ? 'غير محدود' : daysToDate(expiryDays);
      await env.DB.prepare(`INSERT INTO licenses (serial, device_id, code, expiry_days, issued_at, issued_by, note)
        VALUES (?, ?, ?, ?, ?, 'bot', '')`)
        .bind(serial, dev.toLowerCase(), code, expiryDays, new Date().toISOString()).run();
      await reply(`✅ <b>كود التفعيل</b>\n\n<code>${code}</code>\n\nصالح حتى: ${expiry}\nرقم الإصدار: #${serial}`);
    } else if (cmd === '/devices') {
      const rows = await env.DB.prepare(
        'SELECT device_id, shop_name, license_status, license_expiry, last_seen FROM devices ORDER BY last_seen DESC LIMIT 15',
      ).all();
      const list = (rows?.results || []).map(r =>
        `• ${r.shop_name || '—'} — ${r.license_status || '?'} — ${r.license_expiry || '—'}\n  <code>${r.device_id}</code>`,
      ).join('\n');
      await reply(list ? `<b>الأجهزة</b>\n${list}` : 'لا توجد أجهزة بعد.');
    } else if (cmd === '/expiring') {
      const limit = daysToDate(todayDays() + 14);
      const rows = await env.DB.prepare(
        "SELECT shop_name, device_id, license_expiry FROM devices WHERE license_expiry IS NOT NULL AND license_expiry <= ? ORDER BY license_expiry",
      ).bind(limit).all();
      const list = (rows?.results || []).map(r =>
        `• ${r.shop_name || '—'} — ينتهي ${r.license_expiry}\n  <code>${r.device_id}</code>`).join('\n');
      await reply(list ? `<b>اشتراكات تقترب من الانتهاء</b>\n${list}` : 'لا توجد اشتراكات تنتهي قريباً ✅');
    } else if (cmd === '/msg') {
      const target = args.shift();
      const bodyText = args.join(' ');
      if (!target || !bodyText) { await reply('الاستخدام: /msg &lt;id|all&gt; &lt;نص&gt;'); return json({ ok: true }); }
      await env.DB.prepare(`INSERT INTO messages (target, title, body, severity, created_at)
        VALUES (?, 'رسالة من المطور', ?, 'info', ?)`)
        .bind(target === 'all' ? 'all' : target.toLowerCase(), bodyText, new Date().toISOString()).run();
      await reply('✅ تم جدولة الرسالة — ستظهر عند العميل في المزامنة القادمة.');
    } else if (cmd === '/set') {
      const target = args.shift();
      const key = args.shift();
      const value = args.join(' ');
      if (!target || !key) { await reply('الاستخدام: /set &lt;id|all&gt; &lt;key&gt; &lt;value&gt;'); return json({ ok: true }); }
      await env.DB.prepare(`INSERT INTO remote_config (key, target, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key, target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key, target === 'all' ? 'all' : target.toLowerCase(), value, new Date().toISOString()).run();
      await reply(`✅ تم ضبط <code>${key}</code>\nملاحظة: التطبيق يقبل فقط المفاتيح المسموح بها في قائمته الداخلية.`);
    }
  } catch (err) {
    await reply(`⚠️ خطأ: ${err.message}`);
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
