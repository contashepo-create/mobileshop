/**
 * Alerts raised when a shop clears its database.
 *
 * TWO AUDIENCES, TWO CHANNELS — and they must not be mixed
 * --------------------------------------------------------
 *   - the SHOP OWNER is told on the SHOP's own bot, so an employee who wipes
 *     the books while the owner is out cannot do it unnoticed;
 *   - the DEVELOPER is told through the Cloudflare Worker, which relays to the
 *     developer's bot, so a later "I lost all my data" support call can be
 *     answered with the date, the account and the backup filename.
 *
 * The developer alert carries NO business data: the shop name, the username
 * that performed it and the timestamp. Not a customer, not a balance, not an
 * invoice. Support needs to know THAT it happened, never what was in it.
 *
 * Both are best-effort by design. By the time either runs the database is
 * already cleared, so a network failure must never be reported to the user as a
 * failed reset — that would invite them to run it again. The durable record is
 * the `security_events` row the caller writes first.
 */
import {
  sendTelegramMessage, isTargetConfigured, type TelegramTarget,
} from './confirmCode';

/** Cloudflare Worker base, same configuration the heartbeat uses. */
const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

/** Tell the SHOP OWNER, on their own bot, that the books were cleared. */
export async function notifyDatabaseReset(
  target: TelegramTarget | null,
  username: string,
  shopName: string,
  backupPath: string,
): Promise<void> {
  if (!isTargetConfigured(target)) return;
  try {
    const file = backupPath ? backupPath.split(/[\\/]/).pop() : '';
    await sendTelegramMessage(target,
      `🗑 تم تصفير قاعدة البيانات\n\n`
      + `🏪 ${shopName || 'المحل'}\n`
      + `👤 بواسطة: ${username}\n`
      + `🕒 ${new Date().toLocaleString('en-GB')}\n`
      + (file ? `💾 النسخة الاحتياطية: ${file}\n` : '')
      + `\n⚠️ إن لم تكن أنت، راجع النسخة الاحتياطية فوراً.`);
  } catch { /* the security_events row is the durable record */ }
}

/**
 * Tell the DEVELOPER, through the worker, that a customer cleared their data.
 *
 * Deliberately fire-and-forget with a short timeout: this runs after the wipe
 * has already completed, and the shop must not sit waiting on the developer's
 * server to answer.
 */
export async function notifyDeveloperOfReset(
  shopName: string, username: string,
): Promise<void> {
  if (!API_BASE || !CLIENT_KEY) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let deviceId = '';
    try {
      // Imported lazily so this module stays usable in tests that have no
      // Electron `app` object available.
      const mod = await import('./deviceId');
      deviceId = mod.getDeviceId();
    } catch { /* device id is a nicety here, not a requirement */ }

    await fetch(`${API_BASE}/database-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Key': CLIENT_KEY },
      body: JSON.stringify({
        deviceId,
        shopName: shopName || '',
        username: username || '',
        at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
  } catch { /* offline, timeout, DNS — never affects the shop */ } finally {
    clearTimeout(timer);
  }
}
