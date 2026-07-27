/**
 * Remote configuration — what the developer may change on a customer's install.
 *
 * SECURITY MODEL
 * --------------
 * This allow-list lives in the CLIENT, never on the server. Even if the cloud
 * account is compromised, an attacker can only alter presentation values that
 * appear in this file — they cannot flip an accounting switch, repoint the
 * database, or touch a balance, because those keys are simply not resolvable
 * through the remote path.
 *
 * That is a deliberate inversion of the usual "server decides" model: the
 * server proposes, the client decides what it is willing to accept.
 *
 * RESOLUTION ORDER for a remotely-managed key:
 *      remote value (per-device)  ->  remote value (broadcast 'all')
 *   -> local settings row         ->  built-in default
 *
 * Anything NOT listed here is always read from the local database only.
 */

/** Presentation/branding keys the developer controls remotely. */
export const REMOTE_MANAGED_KEYS = [
  // --- Application identity
  'app_name',
  'app_version',
  'app_edition',        // free-text label e.g. "نسخة كاملة"

  // --- Developer identity
  'dev_name',
  'dev_title',          // e.g. "محاسب / مطور برمجيات"

  // --- Contact channels
  'dev_phone',
  'dev_whatsapp',       // may differ from dev_phone
  'dev_telegram',       // @username
  'dev_email',
  'dev_website',
  'dev_facebook',
  'dev_address',

  // --- Payment / subscription info shown to the customer
  'payment_info',       // multi-line: wallet numbers, bank account, InstaPay…
  'subscription_note',  // e.g. "التجديد السنوي 1500 ج.م"

  // --- Legal
  'copyright',
  'distribution_rights',
  'terms_note',

  // --- Free-form blocks on the About page
  'custom_content',     // main additional-information block
  'custom_block_title', // heading for the block below
  'custom_block_body',
  'support_hours',
  'release_notes',
  'latest_version',     // newest published version, for the update banner
] as const;

export type RemoteManagedKey = typeof REMOTE_MANAGED_KEYS[number];

const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_MANAGED_KEYS);

/** True when a key may be overridden by the developer's server. */
export function isRemoteManaged(key: string): boolean {
  return REMOTE_KEY_SET.has(key);
}

/**
 * Keys that must NEVER be settable remotely, listed explicitly so the intent is
 * documented and testable rather than implied by absence.
 */
export const REMOTE_FORBIDDEN_KEYS = [
  'owner_capital',
  'allow_negative_stock',
  'allow_negative_cash',
  'allow_negative_customer',
  'allow_negative_supplier',
  'db_path',
  'setup_completed',
  'vat_enabled',
  'vat_rate',
  'customer_warn_threshold',
  'customer_danger_threshold',
  // The shop's own identity belongs to the shop owner, not the developer.
  'company_name',
  'owner_name',
  'phone',
  'email',
  'address',
  'tax_number',
  'bank_name',
  'bank_account',
  'logo_path',
  'currency',
] as const;

/** Defensive check used by tests and by the merge step. */
export function assertNoForbiddenOverlap(): void {
  const overlap = REMOTE_FORBIDDEN_KEYS.filter(k => REMOTE_KEY_SET.has(k));
  if (overlap.length > 0) {
    throw new Error(`Remote allow-list must not contain protected keys: ${overlap.join(', ')}`);
  }
}

/** Maximum accepted length for a remote value (guards against abuse/bloat). */
export const MAX_REMOTE_VALUE_LENGTH = 4000;

/**
 * Normalises and validates a single incoming remote value.
 * Returns null when the key is not managed remotely or the value is unusable.
 */
export function sanitiseRemoteValue(key: string, value: unknown): string | null {
  if (!isRemoteManaged(key)) return null;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (text.length > MAX_REMOTE_VALUE_LENGTH) return null;
  // Strip control characters that could corrupt the UI, keep newlines/tabs.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
