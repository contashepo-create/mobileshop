/**
 * Sending the shop's backup to the owner's own Telegram bot.
 *
 * WHY THIS EXISTS
 * ---------------
 * The automatic daily backups live in `userData/backups` — on the SAME disk as
 * the database they protect. A failed drive, a stolen computer or ransomware
 * takes the shop's books and all seven days of backups together. An off-site
 * copy is the only backup that survives losing the machine, and Telegram is a
 * channel the owner already has on their phone, with no account to create, no
 * card to register and no monthly fee.
 *
 * WHOSE BOT
 * ---------
 * The owner's, never the developer's. The token and chat id are entered by the
 * shop and stored on the shop's machine, so the database is delivered to the
 * owner's private chat and nobody else's. The developer's bot (used for
 * licensing and password recovery) is a separate thing entirely and never
 * receives business data.
 *
 * SECURITY — what the token is and how it is protected
 * ----------------------------------------------------
 * A bot token is a bearer credential: whoever holds it controls that bot. Two
 * leaks were possible and both are closed by using the `telegram_` prefix:
 *
 *   1. `settings:getAll` is a PUBLIC channel — it must be callable before login
 *      to render the login screen's branding. Any key it returns is readable by
 *      an unauthenticated renderer. `telegram_%` is now excluded there.
 *   2. `db:exportCSV` can dump any table that is not blocklisted, and `settings`
 *      was not blocklisted. Exporting it would have written the token into a
 *      plain CSV. The settings table is now filtered on export.
 *
 * What is NOT claimed: the token is stored in the local SQLite file in plain
 * text, exactly like the cloud API keys already are. Encrypting it with a key
 * that also sits on the same disk would be theatre. Anyone with the database
 * file has the shop's entire books anyway — the honest mitigation is that the
 * token is the owner's own, can be revoked from @BotFather in seconds, and
 * grants access to nothing except that one bot.
 *
 * PRIVACY — this is the whole business
 * ------------------------------------
 * Unlike the heartbeat, which sends only "which install is this", this feature
 * uploads the ENTIRE database: every customer, price, balance and password
 * hash. That is the point of a backup, but it means it must never happen by
 * accident. It is therefore off by default, requires explicit configuration,
 * and the settings screen states plainly what is being sent.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Telegram's Bot API refuses uploads above 50 MB.
 *
 * Checked BEFORE the request rather than discovering it from a rejected POST,
 * so a shop whose database has outgrown the channel is told why in Arabic and
 * pointed at a working alternative, instead of seeing a raw HTTP error every
 * night.
 */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Uploading a whole database is slow on a shop's connection; be patient. */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Shape of every result this module returns. */
export interface TelegramResult {
  success: boolean;
  message: string;
}

/**
 * A bot token looks like `123456789:AA...`. Validated before use so an obvious
 * typo is reported as a typo rather than as a network failure.
 */
export function looksLikeBotToken(token: unknown): boolean {
  return typeof token === 'string' && /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** A chat id is a signed integer; groups and channels are negative. */
export function looksLikeChatId(chatId: unknown): boolean {
  return typeof chatId === 'string' && /^-?\d{5,}$/.test(chatId.trim());
}

/**
 * Never let a token reach a log file or an error shown on screen.
 *
 * Telegram echoes the request URL in some failures, and the URL contains the
 * token. Any message this module surfaces is passed through here first.
 */
export function redactToken(text: string, token: string): string {
  // The URL pattern is scrubbed UNCONDITIONALLY. An earlier version returned
  // `text` untouched when `token` was empty, which is exactly the case that
  // matters: a caller that has not resolved the token yet, or reports an error
  // from a different code path, would then print the full
  // `https://api.telegram.org/bot<TOKEN>/...` that Telegram echoes back.
  let out = typeof text === 'string' ? text : String(text ?? '');
  if (token) out = out.split(token).join('***');
  out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{30,}/g, 'bot***');
  return out;
}

async function callTelegram(
  token: string, method: string, body: FormData | string, isJson: boolean, timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: isJson ? { 'Content-Type': 'application/json' } : undefined,
      body: body as any,
      signal: controller.signal,
    });
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirms the token works and the bot can actually write to that chat.
 *
 * Two calls on purpose. `getMe` proves the token is real; only a message proves
 * the chat id is right and that the owner has pressed Start. A shop that only
 * checked the token would believe it was protected and discover at restore time
 * that every upload had bounced.
 */
export async function testTelegram(config: TelegramConfig): Promise<TelegramResult> {
  const token = String(config?.botToken ?? '').trim();
  const chatId = String(config?.chatId ?? '').trim();

  if (!looksLikeBotToken(token)) {
    return { success: false, message: 'رمز البوت غير صالح - انسخه كاملاً من BotFather' };
  }
  if (!looksLikeChatId(chatId)) {
    return { success: false, message: 'معرّف المحادثة غير صالح - يجب أن يكون أرقاماً' };
  }

  try {
    const me = await callTelegram(token, 'getMe', '{}', true, 20_000);
    if (!me?.ok) {
      return { success: false, message: 'رمز البوت مرفوض من تليجرام - تأكد من نسخه صحيحاً' };
    }
    const sent = await callTelegram(token, 'sendMessage', JSON.stringify({
      chat_id: chatId,
      text: '✅ تم ربط النسخ الاحتياطي بنجاح.\nستصلك نسخة قاعدة البيانات هنا.',
    }), true, 20_000);

    if (!sent?.ok) {
      const why = String(sent?.description || '');
      if (/chat not found/i.test(why)) {
        return { success: false, message: 'المحادثة غير موجودة - افتح محادثة البوت واضغط Start أولاً' };
      }
      if (/bot was blocked/i.test(why)) {
        return { success: false, message: 'البوت محظور من هذه المحادثة - ألغِ الحظر ثم أعد المحاولة' };
      }
      return { success: false, message: `تعذّر الإرسال: ${redactToken(why, token) || 'سبب غير معروف'}` };
    }
    return { success: true, message: `تم الربط بنجاح مع البوت @${me.result?.username || ''}` };
  } catch (err: any) {
    const msg = err?.name === 'AbortError'
      ? 'انتهت مهلة الاتصال - تأكد من الإنترنت'
      : redactToken(String(err?.message || err), token);
    return { success: false, message: `تعذّر الاتصال بتليجرام: ${msg}` };
  }
}

/**
 * Uploads one already-written backup file.
 *
 * The caller produces the file with SQLite's own backup API; this function only
 * transmits it. Keeping the two apart means a transmission failure can never
 * corrupt or delete the local backup — the shop keeps its on-disk copy whatever
 * the network does.
 */
export async function sendBackupToTelegram(
  config: TelegramConfig, filePath: string, caption: string,
): Promise<TelegramResult> {
  const token = String(config?.botToken ?? '').trim();
  const chatId = String(config?.chatId ?? '').trim();

  if (!looksLikeBotToken(token) || !looksLikeChatId(chatId)) {
    return { success: false, message: 'إعدادات تليجرام غير مكتملة' };
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, message: 'ملف النسخة غير موجود' };
  }

  const size = fs.statSync(filePath).size;
  if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return {
      success: false,
      message: `حجم قاعدة البيانات ${mb} ميجابايت ويتجاوز حد تليجرام (50 ميجابايت). `
        + 'استخدم الرفع السحابي أو نسخة يدوية على وحدة تخزين خارجية.',
    };
  }

  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, 1000));
    // Read into memory deliberately: the file is capped at 50 MB above, and a
    // Blob lets fetch set the multipart boundary and length correctly without
    // pulling in a streaming upload dependency.
    const bytes = fs.readFileSync(filePath);
    form.append('document', new Blob([bytes]), path.basename(filePath));

    const res = await callTelegram(token, 'sendDocument', form, false, UPLOAD_TIMEOUT_MS);
    if (res?.ok) {
      return { success: true, message: 'تم رفع النسخة الاحتياطية إلى تليجرام' };
    }
    const why = redactToken(String(res?.description || 'سبب غير معروف'), token);
    return { success: false, message: `فشل الرفع: ${why}` };
  } catch (err: any) {
    const msg = err?.name === 'AbortError'
      ? 'انتهت مهلة الرفع - تأكد من الإنترنت'
      : redactToken(String(err?.message || err), token);
    return { success: false, message: `فشل الرفع: ${msg}` };
  }
}
