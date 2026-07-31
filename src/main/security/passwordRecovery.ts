/**
 * Owner-driven recovery of a forgotten ADMINISTRATOR password.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Until now the only way back into a shop whose administrator password was
 * forgotten went through the developer: the "نسيت كلمة المرور؟" dialog asks for
 * DEVELOPER credentials, so the owner had to phone support and wait. For a shop
 * that cannot invoice until someone signs in, that is an outage.
 *
 * SECURITY MODEL — read before changing anything here
 * ---------------------------------------------------
 * The proof of identity is control of the OWNER'S TELEGRAM ACCOUNT. The server
 * sends a six-digit code to the chat id held in the worker's secrets and never
 * returns it in the HTTP response.
 *
 * That single decision is what makes the feature safe:
 *
 *   CLIENT_KEY ships inside the application bundle. Anyone who unpacks the
 *   .asar has it. So the endpoint cannot treat "the caller knows CLIENT_KEY" as
 *   proof of anything — it is a spam filter, never the security boundary. An
 *   attacker who extracts it and calls /password-reset/request achieves
 *   nothing, because the code is delivered to the owner's phone, not to them.
 *
 * Layers, and what each one actually stops:
 *
 *   1. Code goes only to the owner's Telegram   -> requesting is harmless.
 *   2. Six digits, but max 5 attempts then burnt -> cannot be ground down;
 *      5 in 1,000,000 per window, and the window dies after 15 minutes.
 *   3. One live code per device, single use      -> no replay, no stockpiling.
 *   4. Max 3 requests per device per hour        -> nobody can flood the owner
 *      with prompts until real alerts get ignored.
 *   5. Server returns an HMAC grant over
 *      (deviceId, userId, issuedAt), verified HERE with the embedded secret
 *      -> a patched renderer or a forged network reply cannot fake a reset,
 *      because the decision is re-checked in the main process against a
 *      signature it cannot produce.
 *   6. Administrators only                        -> a cashier still goes to
 *      their admin, which already works and needs no new trust.
 *   7. Every reset is written to `security_events` and announced on Telegram
 *      -> if it was not the owner, they find out immediately and it is on the
 *      record permanently.
 *
 * HONEST LIMITATION
 * -----------------
 * LICENSE_SECRET is also embedded in the app (as VERIFIER_SECRET), so the grant
 * is a shared-secret HMAC, not asymmetric crypto. It defends against a tampered
 * network reply and casual UI patching — not against someone who reverse
 * engineers the binary to extract the secret. That is the same documented
 * trade-off the licence system already makes, and anyone with that capability
 * is holding the SQLite file anyway and can do far worse than reset a password.
 * The real fix for both is signing with a private key that never ships; see
 * SECURITY_AUDIT_AR.md.
 *
 * The developer path (`users:resetByDev`) is deliberately KEPT as the offline
 * fallback: this feature needs the internet, and a shop with no connection must
 * still have a way back in.
 */
import crypto from 'node:crypto';
import { VERIFIER_SECRET } from './licenseCrypto';

/** Base URL of the developer's Cloudflare Worker. Empty = feature unavailable. */
const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

const REQUEST_TIMEOUT_MS = 15 * 1000;

/** A grant is only accepted for ten minutes after the server issued it. */
export const GRANT_MAX_AGE_MS = 10 * 60 * 1000;

/** True when the shop can use this route at all (server configured). */
export function isRecoveryConfigured(): boolean {
  return Boolean(API_BASE && CLIENT_KEY);
}

async function postJson(path: string, body: unknown): Promise<any | null> {
  if (!isRecoveryConfigured()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Key': CLIENT_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Read the body even on 4xx: the server explains WHY (expired, rate
    // limited, wrong code) and the owner needs to be told which it was.
    const data = await res.json().catch(() => null);
    return data ?? { ok: false, error: `http_${res.status}` };
  } catch {
    return null;   // offline, DNS failure, timeout
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recomputes the server's signature locally. Any mismatch, any missing field
 * and any stale timestamp means no reset.
 *
 * `timingSafeEqual` on equal-length hex strings: a plain `===` on an HMAC leaks
 * how many leading bytes matched, which is enough to forge one byte at a time.
 */
export function verifyGrant(
  grant: unknown,
  deviceId: string,
  userId: number,
  issuedAt: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof grant !== 'string' || !/^[0-9a-f]{64}$/.test(grant)) return false;
  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  // Reject a stale grant, and one dated in the future beyond small clock skew.
  if (now - issued > GRANT_MAX_AGE_MS) return false;
  if (issued - now > 5 * 60 * 1000) return false;
  if (!deviceId || !Number.isInteger(userId) || userId <= 0) return false;

  const expected = crypto
    .createHmac('sha256', VERIFIER_SECRET)
    .update(`pwreset|${deviceId}|${userId}|${issued}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(grant, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Ask the server to send a code to the owner's Telegram. */
export async function requestResetCode(
  deviceId: string, userId: number, username: string,
): Promise<{ success: boolean; message: string }> {
  if (!isRecoveryConfigured()) {
    return { success: false, message: 'خدمة الاسترداد غير مفعّلة في هذه النسخة - تواصل مع الدعم الفني' };
  }
  const res = await postJson('/password-reset/request', { deviceId, userId, username });
  if (!res) {
    return { success: false, message: 'تعذّر الاتصال بالإنترنت - تأكد من الاتصال ثم أعد المحاولة' };
  }
  if (res.ok) {
    return { success: true, message: 'تم إرسال رمز التحقق إلى حساب تليجرام الخاص بالمالك' };
  }
  if (res.error === 'rate_limited') {
    return { success: false, message: 'تم طلب الرمز عدة مرات - انتظر ساعة ثم أعد المحاولة' };
  }
  return { success: false, message: 'تعذّر إرسال الرمز - حاول مرة أخرى' };
}

/** Exchange the typed code for a signed grant. */
export async function verifyResetCode(
  deviceId: string, userId: number, code: string,
): Promise<{ success: boolean; message: string; grant?: string; issuedAt?: number }> {
  if (!isRecoveryConfigured()) {
    return { success: false, message: 'خدمة الاسترداد غير مفعّلة في هذه النسخة' };
  }
  const res = await postJson('/password-reset/verify', { deviceId, userId, code });
  if (!res) {
    return { success: false, message: 'تعذّر الاتصال بالإنترنت - تأكد من الاتصال ثم أعد المحاولة' };
  }
  if (res.ok && typeof res.grant === 'string') {
    return { success: true, message: 'تم التحقق', grant: res.grant, issuedAt: Number(res.issuedAt) };
  }
  const messages: Record<string, string> = {
    no_request: 'لا يوجد طلب استرداد - اطلب رمزاً جديداً',
    expired: 'انتهت صلاحية الرمز - اطلب رمزاً جديداً',
    used: 'تم استخدام هذا الرمز من قبل - اطلب رمزاً جديداً',
    too_many_attempts: 'تم تجاوز عدد المحاولات - اطلب رمزاً جديداً',
  };
  if (res.error === 'bad_code' && typeof res.attemptsLeft === 'number') {
    return {
      success: false,
      message: `الرمز غير صحيح - المحاولات المتبقية: ${res.attemptsLeft}`,
    };
  }
  return { success: false, message: messages[res.error as string] || 'الرمز غير صحيح' };
}

/** Tell the owner, on Telegram, that a reset actually completed. */
export async function notifyResetDone(deviceId: string, username: string): Promise<void> {
  // Best-effort: the password has already been changed by the time this runs,
  // so a failure here must never turn a successful reset into an error.
  try {
    await postJson('/password-reset/done', { deviceId, username });
  } catch { /* the audit row in security_events is the durable record */ }
}
