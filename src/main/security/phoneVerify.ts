/**
 * Verifying a shop's phone number through its own Telegram bot.
 *
 * HOW IT WORKS
 * ------------
 * The bot sends a keyboard with `request_contact`. When the owner taps it,
 * TELEGRAM ITSELF supplies the phone number attached to their account — the
 * user never types it. Telegram verified that number by SMS when the account
 * was created, so this inherits a verification that already happened, for
 * nothing.
 *
 * THE TRAP THAT MAKES A NAIVE IMPLEMENTATION WORTHLESS
 * -----------------------------------------------------
 * A user can share ANY contact from their address book, not just their own.
 * The bot receives the same `contact` object either way. The only thing that
 * distinguishes them is `contact.user_id`: it is present and equal to
 * `from.id` when the contact IS the sender, and absent or different otherwise.
 *
 * Skip that comparison and the feature verifies nothing at all — a shop could
 * "verify" any number whose owner is in their contacts. `matchesSender()`
 * below is the whole security of this module, and it is asserted directly by
 * the test suite rather than left implied.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It proves the person driving the bot controls a Telegram account registered
 * to that number. It does NOT prove the SIM is in their hand today: a number
 * can be recycled while the Telegram account lives on. For a shop-registration
 * check that is proportionate; for anything that moves money it would not be.
 *
 * WHY POLLING RATHER THAN A WEBHOOK
 * ---------------------------------
 * The shop's bot has no public endpoint — the application runs on a counter PC
 * behind a router. `getUpdates` is the only option available, and it is used
 * ONLY while a verification is open: a short burst, then it stops. The
 * developer's own bot is untouched by any of this.
 */
import crypto from 'node:crypto';
import { isTargetConfigured, redactToken, type TelegramTarget } from './confirmCode';

/** How long the owner has to tap the button before the attempt lapses. */
export const VERIFY_WINDOW_MS = 5 * 60 * 1000;

/** Gap between polls. Telegram tolerates this comfortably. */
const POLL_INTERVAL_MS = 2000;

export interface PhoneVerifyResult {
  success: boolean;
  message: string;
  phone?: string;
}

/**
 * Normalises an Egyptian number to bare international digits.
 *
 * Telegram may return `+201012345678`, `201012345678` or `01012345678`
 * depending on how the account was registered, and the shop may have typed any
 * of them. Comparing the raw strings would reject a correct match.
 */
export function normalisePhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20')) return digits;
  if (digits.startsWith('0')) return `20${digits.slice(1)}`;
  return digits;
}

/**
 * THE security check: is this contact the sender's own?
 *
 * Telegram sets `contact.user_id` only when the shared contact is a Telegram
 * user, and it equals `from.id` only when it is the sender themselves. Anything
 * else is somebody else's number pulled from the address book.
 */
export function matchesSender(contact: unknown, from: unknown): boolean {
  const c = contact as { user_id?: unknown; phone_number?: unknown } | null;
  const f = from as { id?: unknown } | null;
  if (!c || !f) return false;
  if (typeof c.phone_number !== 'string' || !c.phone_number) return false;
  // Absent user_id means the contact is not a Telegram account at all — a
  // manually typed entry. It proves nothing and must be refused.
  if (c.user_id === undefined || c.user_id === null) return false;
  return Number(c.user_id) === Number(f.id);
}

async function tg(target: TelegramTarget, method: string, payload: unknown, timeoutMs = 20_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${target.botToken.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json().catch(() => null);
  } catch (err: any) {
    return { ok: false, description: redactToken(String(err?.message || err), target.botToken) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the owner to share their number, then waits for the tap.
 *
 * `expectedPhone` is what the shop typed in the wizard. The verification
 * succeeds only if the number Telegram supplies matches it, so this confirms
 * the number ON THE FORM rather than merely collecting some number.
 */
export async function verifyPhoneViaTelegram(
  target: TelegramTarget | null,
  expectedPhone: string,
  now: () => number = Date.now,
): Promise<PhoneVerifyResult> {
  if (!isTargetConfigured(target)) {
    return { success: false, message: 'لم يتم ضبط بوت تليجرام - اضبطه من الإعدادات ← النسخ الاحتياطي' };
  }
  const want = normalisePhone(expectedPhone);
  if (!want) return { success: false, message: 'أدخل رقم الهاتف أولاً' };

  // Start from the current update id so a contact shared BEFORE this request
  // cannot satisfy it. Without this, an old message sitting in the queue would
  // verify a number the owner never confirmed just now.
  let offset = 0;
  const seed = await tg(target, 'getUpdates', { timeout: 0, limit: 1, offset: -1 });
  if (Array.isArray(seed?.result) && seed.result.length > 0) {
    offset = Number(seed.result[seed.result.length - 1].update_id) + 1;
  }

  const nonce = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const asked = await tg(target, 'sendMessage', {
    chat_id: target.chatId.trim(),
    text: `📱 تأكيد رقم الهاتف (${nonce})\n\n`
      + 'اضغط الزر بالأسفل لمشاركة رقمك.\n'
      + 'تليجرام هو من يرسل الرقم — لن تكتبه بنفسك.',
    reply_markup: {
      keyboard: [[{ text: '📱 مشاركة رقمي', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
  if (!asked?.ok) {
    if (/chat not found/i.test(String(asked?.description || ''))) {
      return { success: false, message: 'المحادثة غير موجودة - افتح محادثة البوت واضغط Start' };
    }
    return { success: false, message: 'تعذّر إرسال طلب التأكيد - تأكد من إعدادات البوت' };
  }

  const deadline = now() + VERIFY_WINDOW_MS;
  while (now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const upd = await tg(target, 'getUpdates', { offset, timeout: 0, limit: 10 });
    if (!upd?.ok || !Array.isArray(upd.result)) continue;

    for (const u of upd.result) {
      offset = Number(u.update_id) + 1;
      const msg = u.message;
      if (!msg?.contact) continue;

      // Only the configured chat may answer. A different chat reaching this
      // bot has no business confirming the shop's number.
      if (String(msg.chat?.id ?? '') !== target.chatId.trim()) continue;

      if (!matchesSender(msg.contact, msg.from)) {
        await tg(target, 'sendMessage', {
          chat_id: target.chatId.trim(),
          text: '❌ هذا ليس رقمك أنت. استخدم زر «مشاركة رقمي» ولا ترسل جهة اتصال أخرى.',
          reply_markup: { remove_keyboard: true },
        });
        return {
          success: false,
          message: 'تمت مشاركة جهة اتصال شخص آخر - يجب مشاركة رقمك أنت',
        };
      }

      const got = normalisePhone(msg.contact.phone_number);
      if (got !== want) {
        await tg(target, 'sendMessage', {
          chat_id: target.chatId.trim(),
          text: `❌ الرقم المشارك (${got}) لا يطابق الرقم المسجّل.`,
          reply_markup: { remove_keyboard: true },
        });
        return { success: false, message: 'الرقم المشارك لا يطابق الرقم المُدخل في النموذج' };
      }

      await tg(target, 'sendMessage', {
        chat_id: target.chatId.trim(),
        text: '✅ تم تأكيد رقم الهاتف بنجاح.',
        reply_markup: { remove_keyboard: true },
      });
      return { success: true, message: 'تم تأكيد رقم الهاتف', phone: got };
    }
  }

  await tg(target, 'sendMessage', {
    chat_id: target.chatId.trim(),
    text: '⌛ انتهت مهلة تأكيد الرقم.',
    reply_markup: { remove_keyboard: true },
  });
  return { success: false, message: 'انتهت المهلة دون مشاركة الرقم - حاول مرة أخرى' };
}
