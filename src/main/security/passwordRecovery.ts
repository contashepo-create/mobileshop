/**
 * Owner-driven recovery of a forgotten ADMINISTRATOR password.
 *
 * TWO BOTS, TWO PURPOSES — do not confuse them
 * --------------------------------------------
 * There are two entirely separate Telegram bots in this product:
 *
 *   1. THE DEVELOPER'S BOT — token compiled into the Cloudflare Worker's
 *      secrets, never shown in any settings screen, never touched by the shop.
 *      It carries licensing traffic and new-device notices to the developer.
 *      It must never carry a customer's password reset or their database.
 *
 *   2. THE CUSTOMER'S BOT — created by the shop owner in BotFather, configured
 *      in Settings -> Backup, stored on the shop's own machine. It does exactly
 *      two things: it delivers the administrator's password-reset code, and it
 *      stores the off-site backups.
 *
 * THE BUG THIS FILE FIXES
 * -----------------------
 * The first version of this feature sent the reset code through the WORKER,
 * which delivers to TG_ADMIN_CHAT — the DEVELOPER's chat. So every customer who
 * forgot their password produced a code on the developer's phone, and had to
 * ring for it. That is precisely the phone call the feature existed to remove:
 * it was the old "contact support" flow wearing a new coat.
 *
 * The code is now generated and delivered ENTIRELY ON THE SHOP'S MACHINE using
 * the shop's own bot. Nothing about a customer's password touches the
 * developer's infrastructure.
 *
 * SECURITY MODEL
 * --------------
 * The proof of identity is control of the SHOP OWNER'S Telegram chat: the code
 * is sent to the chat id stored in the shop's settings and is never displayed
 * on screen. Someone standing at the keyboard can press "send code" all day and
 * learn nothing, because the code arrives on the owner's phone.
 *
 * Layers, and what each one stops:
 *   1. code delivered only to the owner's chat -> requesting is harmless
 *   2. six digits from crypto.randomInt        -> not guessable, not seeded
 *      (Math.random is predictable and must never mint a credential)
 *   3. max 5 attempts, then the code is burnt  -> cannot be ground down
 *   4. 15-minute expiry, single use            -> no replay, no stockpiling
 *   5. bound to ONE user id                    -> cannot be redirected
 *   6. max 3 requests per hour                 -> the owner cannot be flooded
 *   7. administrators only                     -> a cashier still goes to their
 *      administrator, who resets staff passwords from the users screen
 *   8. state held in memory, not on disk       -> a pending code does not
 *      survive a restart and cannot be read out of the database file
 *
 * HONEST LIMITATION
 * -----------------
 * Anyone who can already read the shop's database file can read the bot token
 * out of `settings` and receive the codes. That is not a new weakness: such an
 * attacker holds every invoice, balance and password hash in the business
 * already. The mitigation that matters is that the token is the OWNER's, can be
 * revoked in BotFather in seconds, and grants nothing beyond that one bot.
 *
 * The developer route (`users:resetByDev`) is deliberately KEPT as the fallback
 * for a shop with no internet or no bot configured.
 */
import crypto from 'node:crypto';

/** How long a code stays valid. */
export const CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong guesses allowed before the code is destroyed. */
export const MAX_ATTEMPTS = 5;
/** Requests allowed per hour, so the owner's phone cannot be flooded. */
export const MAX_REQUESTS_PER_HOUR = 3;

interface PendingReset {
  userId: number;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

/**
 * The single in-flight reset, and the recent request timestamps.
 *
 * Deliberately in memory. Writing a pending code to `settings` would put a
 * live credential in the same file the backup ships off-site, and would let it
 * outlive a restart for no benefit — the owner is standing at the machine.
 */
let pending: PendingReset | null = null;
let requestTimes: number[] = [];

/** Test seam: lets the suite prove expiry without waiting fifteen minutes. */
export function __resetRecoveryState() {
  pending = null;
  requestTimes = [];
}

/** SHA-256 hex. The plain code is never stored, exactly like a password. */
function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Six digits from a cryptographic source.
 *
 * `crypto.randomInt` rather than `Math.random`: Math.random is a predictable
 * PRNG whose output can be reconstructed from a few samples, and it must never
 * generate anything that acts as a credential.
 */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

export interface RecoveryResult {
  success: boolean;
  message: string;
}

/** Reject an obviously malformed configuration before calling the network. */
function configured(target: TelegramTarget | null): target is TelegramTarget {
  return Boolean(
    target
    && typeof target.botToken === 'string' && /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(target.botToken.trim())
    && typeof target.chatId === 'string' && /^-?\d{5,}$/.test(target.chatId.trim()),
  );
}

/** Never let a bot token reach a message, a log or a crash dump. */
function redact(text: string, token: string): string {
  let out = typeof text === 'string' ? text : String(text ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/bot\d{6,}:[A-Za-z0-9_-]{30,}/g, 'bot***');
}

async function sendTelegram(target: TelegramTarget, text: string): Promise<{ ok: boolean; why: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${target.botToken.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.chatId.trim(), text }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) return { ok: true, why: '' };
    return { ok: false, why: redact(String(data?.description || 'unknown'), target.botToken) };
  } catch (err: any) {
    const why = err?.name === 'AbortError' ? 'timeout' : redact(String(err?.message || err), target.botToken);
    return { ok: false, why };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step 1 — mint a code and send it to the OWNER's Telegram.
 *
 * The code is returned to nobody: not to the renderer, not in this function's
 * result. The only copy that leaves this process goes to the owner's chat.
 */
export async function requestResetCode(
  target: TelegramTarget | null,
  userId: number,
  username: string,
  shopName: string,
  now: number = Date.now(),
): Promise<RecoveryResult> {
  if (!configured(target)) {
    return {
      success: false,
      message: 'لم يتم ضبط بوت تليجرام - اضبطه من الإعدادات ← النسخ الاحتياطي، أو تواصل مع الدعم الفني',
    };
  }

  // Anti-flood, evaluated before anything else is spent.
  requestTimes = requestTimes.filter(t => now - t < 3_600_000);
  if (requestTimes.length >= MAX_REQUESTS_PER_HOUR) {
    return { success: false, message: 'تم طلب الرمز عدة مرات - انتظر ساعة ثم أعد المحاولة' };
  }

  const code = generateCode();
  const sent = await sendTelegram(target,
    `🔐 رمز استعادة كلمة مرور المدير\n\n`
    + `🏪 ${shopName || 'المحل'}\n`
    + `👤 المستخدم: ${username}\n\n`
    + `🔑 الرمز: ${code}\n`
    + `⏱ صالح لمدة ١٥ دقيقة\n\n`
    + `⚠️ إن لم تكن أنت من طلبه فلا تعطِ هذا الرمز لأحد.`);

  if (!sent.ok) {
    // Nothing is stored on failure: a code the owner never received must not
    // sit there consuming the single pending slot.
    if (/chat not found/i.test(sent.why)) {
      return { success: false, message: 'المحادثة غير موجودة - افتح محادثة البوت واضغط Start' };
    }
    if (/timeout/i.test(sent.why)) {
      return { success: false, message: 'انتهت مهلة الاتصال - تأكد من الإنترنت وأعد المحاولة' };
    }
    return { success: false, message: 'تعذّر إرسال الرمز - تأكد من إعدادات البوت والإنترنت' };
  }

  // Only a successful delivery creates the pending reset, and a new request
  // always replaces any earlier code.
  pending = { userId, codeHash: hashCode(code), expiresAt: now + CODE_TTL_MS, attempts: 0 };
  requestTimes.push(now);

  return { success: true, message: 'تم إرسال رمز التحقق إلى تليجرام الخاص بك' };
}

/**
 * Step 2 — check a typed code.
 *
 * Consumes the code on success so it can never be replayed.
 */
export function verifyResetCode(
  userId: number, code: string, now: number = Date.now(),
): RecoveryResult {
  if (!pending) {
    return { success: false, message: 'لا يوجد طلب استرداد - اطلب رمزاً جديداً' };
  }
  if (now > pending.expiresAt) {
    pending = null;
    return { success: false, message: 'انتهت صلاحية الرمز - اطلب رمزاً جديداً' };
  }
  if (pending.attempts >= MAX_ATTEMPTS) {
    pending = null;
    return { success: false, message: 'تم تجاوز عدد المحاولات - اطلب رمزاً جديداً' };
  }
  // Bound to the user it was issued for: it cannot be pointed at another
  // account after the fact.
  if (pending.userId !== userId) {
    pending.attempts++;
    return { success: false, message: 'الرمز غير صحيح' };
  }

  const supplied = Buffer.from(hashCode(String(code ?? '')), 'utf8');
  const expected = Buffer.from(pending.codeHash, 'utf8');
  const match = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!match) {
    pending.attempts++;
    const left = MAX_ATTEMPTS - pending.attempts;
    if (left <= 0) {
      pending = null;
      return { success: false, message: 'تم تجاوز عدد المحاولات - اطلب رمزاً جديداً' };
    }
    return { success: false, message: `الرمز غير صحيح - المحاولات المتبقية: ${left}` };
  }

  pending = null;   // single use
  return { success: true, message: 'تم التحقق' };
}

/** Tell the owner, on their own bot, that a reset actually completed. */
export async function notifyResetDone(
  target: TelegramTarget | null, username: string, shopName: string,
): Promise<void> {
  if (!configured(target)) return;
  // Best effort: the password has already changed, so a notification failure
  // must never turn a successful reset into an error. The `security_events`
  // row written by the caller is the durable record.
  try {
    await sendTelegram(target,
      `✅ تم تغيير كلمة مرور المدير\n\n`
      + `🏪 ${shopName || 'المحل'}\n`
      + `👤 المستخدم: ${username}\n`
      + `🕒 ${new Date().toLocaleString('en-GB')}\n\n`
      + `إن لم تكن أنت، غيّر كلمة المرور فوراً.`);
  } catch { /* ignored on purpose */ }
}
