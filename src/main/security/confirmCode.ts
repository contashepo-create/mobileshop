/**
 * One-time confirmation codes delivered to the SHOP's own Telegram bot.
 *
 * WHY THIS IS SHARED
 * ------------------
 * Two operations now need the same protection: recovering the administrator
 * password, and clearing the database. Both are irreversible, both are reached
 * from a screen someone could be standing in front of, and both must prove that
 * the person driving actually controls the owner's Telegram.
 *
 * Writing that logic twice would guarantee the two copies drift — one gets an
 * attempts cap, the other does not; one hashes the code, the other compares it
 * in the clear. A single implementation with a `purpose` label keeps the rules
 * identical and keeps the flows apart: a code minted to reset a password can
 * never be replayed to wipe the books.
 *
 * SECURITY PROPERTIES (identical for every purpose)
 *   - six digits from crypto.randomInt, never Math.random
 *   - stored as SHA-256, never in the clear
 *   - compared with timingSafeEqual
 *   - one live code per purpose; a new request replaces the old
 *   - 15-minute expiry, single use, five attempts then destroyed
 *   - three requests per purpose per hour, so the owner cannot be flooded
 *   - held in memory only: a pending code must not be written into the very
 *     database file that the backup ships off-site
 *   - the code is delivered ONLY to the shop's chat and is never returned to
 *     the renderer, so pressing the button reveals nothing to a bystander
 */
import crypto from 'node:crypto';

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 3;

/** What a code authorises. A code for one purpose is useless for another. */
export type CodePurpose = 'password_reset' | 'database_reset';

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

export interface CodeResult {
  success: boolean;
  message: string;
}

interface Pending {
  subject: number;      // user id for a password reset, 0 when not applicable
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

/** One pending code per purpose, plus the request-rate ledger. */
const pendingByPurpose = new Map<CodePurpose, Pending>();
const requestsByPurpose = new Map<CodePurpose, number[]>();

/** Test seam: lets a suite prove expiry without waiting fifteen minutes. */
export function __resetCodeState() {
  pendingByPurpose.clear();
  requestsByPurpose.clear();
}

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

/**
 * Six digits from a cryptographic source.
 *
 * `crypto.randomInt`, never `Math.random`: Math.random is a predictable PRNG
 * whose future output can be reconstructed from a few samples, and it must
 * never mint anything that acts as a credential.
 */
const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Reject an obviously malformed configuration before touching the network. */
export function isTargetConfigured(target: TelegramTarget | null | undefined): target is TelegramTarget {
  return Boolean(
    target
    && typeof target.botToken === 'string' && /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(target.botToken.trim())
    && typeof target.chatId === 'string' && /^-?\d{5,}$/.test(target.chatId.trim()),
  );
}

/** Never let a bot token reach a message, a log or a crash dump. */
export function redactToken(text: string, token: string): string {
  let out = typeof text === 'string' ? text : String(text ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/bot\d{6,}:[A-Za-z0-9_-]{30,}/g, 'bot***');
}

export async function sendTelegramMessage(
  target: TelegramTarget, text: string,
): Promise<{ ok: boolean; why: string }> {
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
    return { ok: false, why: redactToken(String(data?.description || 'unknown'), target.botToken) };
  } catch (err: any) {
    const why = err?.name === 'AbortError'
      ? 'timeout'
      : redactToken(String(err?.message || err), target.botToken);
    return { ok: false, why };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mint a code for `purpose` and send it to the shop's chat.
 *
 * `body` is the human-readable explanation of what the code authorises. It is
 * deliberately caller-supplied: the owner must be able to tell a password reset
 * from a request to erase the entire business, because the two demand very
 * different reactions when the message arrives unexpectedly.
 */
export async function requestCode(
  purpose: CodePurpose,
  target: TelegramTarget | null | undefined,
  subject: number,
  body: string,
  now: number = Date.now(),
): Promise<CodeResult> {
  if (!isTargetConfigured(target)) {
    return {
      success: false,
      message: 'لم يتم ضبط بوت تليجرام - اضبطه من الإعدادات ← النسخ الاحتياطي',
    };
  }

  const times = (requestsByPurpose.get(purpose) ?? []).filter(t => now - t < 3_600_000);
  if (times.length >= MAX_REQUESTS_PER_HOUR) {
    requestsByPurpose.set(purpose, times);
    return { success: false, message: 'تم طلب الرمز عدة مرات - انتظر ساعة ثم أعد المحاولة' };
  }

  const code = generateCode();
  const sent = await sendTelegramMessage(target, `${body}\n\n🔑 الرمز: ${code}\n⏱ صالح ١٥ دقيقة`);

  if (!sent.ok) {
    // Nothing is stored on failure: a code the owner never received must not
    // occupy the single pending slot, nor count against the hourly budget.
    if (/chat not found/i.test(sent.why)) {
      return { success: false, message: 'المحادثة غير موجودة - افتح محادثة البوت واضغط Start' };
    }
    if (/timeout/i.test(sent.why)) {
      return { success: false, message: 'انتهت مهلة الاتصال - تأكد من الإنترنت وأعد المحاولة' };
    }
    return { success: false, message: 'تعذّر إرسال الرمز - تأكد من إعدادات البوت والإنترنت' };
  }

  pendingByPurpose.set(purpose, {
    subject, codeHash: hashCode(code), expiresAt: now + CODE_TTL_MS, attempts: 0,
  });
  times.push(now);
  requestsByPurpose.set(purpose, times);

  return { success: true, message: 'تم إرسال رمز التحقق إلى تليجرام الخاص بك' };
}

/**
 * Check a typed code. Consumes it on success so it can never be replayed.
 *
 * `subject` binds the code to what it was issued for — a specific user id for a
 * password reset — so it cannot be redirected to a different account.
 */
export function verifyCode(
  purpose: CodePurpose, subject: number, code: string, now: number = Date.now(),
): CodeResult {
  const pending = pendingByPurpose.get(purpose);
  if (!pending) {
    return { success: false, message: 'لا يوجد طلب تحقق - اطلب رمزاً جديداً' };
  }
  if (now > pending.expiresAt) {
    pendingByPurpose.delete(purpose);
    return { success: false, message: 'انتهت صلاحية الرمز - اطلب رمزاً جديداً' };
  }
  // Checked at the TOP, before the branches below return. Probing with a wrong
  // SUBJECT takes a different path from a wrong CODE, and without this guard an
  // attacker could sit on that path forever, incrementing the counter while
  // keeping the code alive. Measured on the previous implementation: the
  // correct code was still valid after ten wrong-subject attempts.
  if (pending.attempts >= MAX_ATTEMPTS) {
    pendingByPurpose.delete(purpose);
    return { success: false, message: 'تم تجاوز عدد المحاولات - اطلب رمزاً جديداً' };
  }
  if (pending.subject !== subject) {
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
      pendingByPurpose.delete(purpose);
      return { success: false, message: 'تم تجاوز عدد المحاولات - اطلب رمزاً جديداً' };
    }
    return { success: false, message: `الرمز غير صحيح - المحاولات المتبقية: ${left}` };
  }

  pendingByPurpose.delete(purpose);   // single use
  return { success: true, message: 'تم التحقق' };
}
