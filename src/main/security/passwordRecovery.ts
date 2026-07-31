/**
 * Owner-driven recovery of a forgotten ADMINISTRATOR password.
 *
 * TWO BOTS, TWO PURPOSES — do not confuse them
 * --------------------------------------------
 *   1. THE DEVELOPER'S BOT — token lives only in the Cloudflare Worker's
 *      secrets, appears in no settings screen, carries licensing traffic and
 *      operational notices to the developer. It must never carry a customer's
 *      password code.
 *
 *   2. THE CUSTOMER'S BOT — created by the shop owner in BotFather, configured
 *      in Settings -> Backup, stored on the shop's own machine. It delivers the
 *      administrator's reset code and stores the off-site backups.
 *
 * An earlier version routed the reset code through the WORKER, which delivers
 * to TG_ADMIN_CHAT — the DEVELOPER's chat. Every customer who forgot their
 * password produced a code on the developer's phone and had to ring for it:
 * exactly the support call this feature exists to remove. Recovery now happens
 * entirely on the shop's machine with the shop's own bot.
 *
 * The mechanics — minting, hashing, expiry, attempt limits, rate limiting — all
 * live in `confirmCode.ts`, shared with the database-reset confirmation so the
 * two can never drift apart in their guarantees. This module only supplies the
 * wording and the binding to a user id.
 *
 * HONEST LIMITATION
 * -----------------
 * Anyone who can already read the shop's database file can read the bot token
 * out of `settings` and receive the codes. That is not a new weakness: such an
 * attacker holds every invoice, balance and password hash already. The
 * mitigation that matters is that the token is the OWNER's, revocable in
 * BotFather in seconds, and grants nothing beyond that one bot.
 *
 * The developer route (`users:resetByDev`) is deliberately KEPT as the fallback
 * for a shop with no internet or no bot configured.
 */
import {
  requestCode, verifyCode, sendTelegramMessage, isTargetConfigured,
  CODE_TTL_MS, MAX_ATTEMPTS, MAX_REQUESTS_PER_HOUR, __resetCodeState,
  type TelegramTarget, type CodeResult,
} from './confirmCode';

export type { TelegramTarget };
export { CODE_TTL_MS, MAX_ATTEMPTS, MAX_REQUESTS_PER_HOUR };

/** Test seam, re-exported so existing suites keep their entry point. */
export const __resetRecoveryState = __resetCodeState;

/** Ask for a code that authorises resetting ONE administrator's password. */
export async function requestResetCode(
  target: TelegramTarget | null,
  userId: number,
  username: string,
  shopName: string,
  now: number = Date.now(),
): Promise<CodeResult> {
  return requestCode(
    'password_reset',
    target,
    userId,
    `🔐 رمز استعادة كلمة مرور المدير\n\n`
    + `🏪 ${shopName || 'المحل'}\n`
    + `👤 المستخدم: ${username}\n\n`
    + `⚠️ إن لم تكن أنت من طلبه فلا تعطِ هذا الرمز لأحد.`,
    now,
  );
}

/** Check a typed code. Bound to the user id it was issued for. */
export function verifyResetCode(
  userId: number, code: string, now: number = Date.now(),
): CodeResult {
  return verifyCode('password_reset', userId, code, now);
}

/** Tell the owner, on their own bot, that a reset actually completed. */
export async function notifyResetDone(
  target: TelegramTarget | null, username: string, shopName: string,
): Promise<void> {
  if (!isTargetConfigured(target)) return;
  // Best effort: the password has already changed, so a notification failure
  // must never turn a successful reset into an error. The `security_events`
  // row written by the caller is the durable record.
  try {
    await sendTelegramMessage(target,
      `✅ تم تغيير كلمة مرور المدير\n\n`
      + `🏪 ${shopName || 'المحل'}\n`
      + `👤 المستخدم: ${username}\n`
      + `🕒 ${new Date().toLocaleString('en-GB')}\n\n`
      + `إن لم تكن أنت، غيّر كلمة المرور فوراً.`);
  } catch { /* ignored on purpose */ }
}
