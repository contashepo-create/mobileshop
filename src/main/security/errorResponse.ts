/**
 * The single place that decides what a failure is allowed to tell the caller.
 *
 * WHY THIS EXISTS
 * ---------------
 * Roughly two dozen handlers ended their `try` with
 *
 *     catch (err: any) { return { success: false, message: err.message }; }
 *
 * which hands whatever the runtime produced straight to the renderer, and from
 * there to a toast the shopkeeper reads. What that actually says was measured,
 * not guessed — these are real messages from real failures:
 *
 *   ENOENT: no such file or directory, open '/home/user/.../mobile_shop.db'
 *   EACCES: permission denied, open '/proc/1/mem'
 *   UNIQUE constraint failed: customers.Phone
 *   NOT NULL constraint failed: customers.Name
 *   no such table: secret_table
 *   no such column: NoSuchCol
 *   near "SELEC": syntax error
 *   Unknown named parameter 'saleId'
 *   file is not a database
 *
 * Three separate problems live in that list:
 *
 *   1. ABSOLUTE PATHS. `ENOENT ... '/Users/mohamed/...'` names the operating
 *      account, the folder layout, and where the books are kept. On a shared
 *      till the person reading the toast is not necessarily the owner.
 *
 *   2. SCHEMA. `UNIQUE constraint failed: customers.Phone` names a table and a
 *      column. Repeated across a dozen operations that is a free map of the
 *      database — the reconnaissance step of any injection attempt, handed
 *      over without one being attempted.
 *
 *   3. IT IS USELESS TO THE READER. "Unknown named parameter 'saleId'" tells a
 *      shopkeeper nothing they can act on. The message that helps them and the
 *      message that helps an attacker are not the same message, and the honest
 *      answer is to send the first and log the second.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not silence anything. Every detail still reaches the terminal and
 * `security_events` where the developer can read it; only the trip across the
 * IPC boundary is trimmed. Swallowing errors would trade one bug for a worse
 * one.
 *
 * It also does not flatten the messages the handlers write ON PURPOSE. Half of
 * the `throw`s in this codebase carry an Arabic sentence the user is meant to
 * see — "لا يمكن حذف فاتورة الشراء - الصنف لم يعد بالمخزن" — and those are
 * marked `userRefusal`. Replacing them with a generic string would delete the
 * only explanation the shop gets for a refusal it needs to understand. That
 * distinction is the whole design: intentional messages pass, accidental ones
 * are replaced.
 */

/** Errors a handler raised deliberately, whose text is meant for the user. */
export interface UserRefusal extends Error {
  userRefusal: true;
}

/**
 * Marks an error as a message the user is meant to read.
 *
 * Used instead of setting `(err as any).userRefusal = true` at each site, so
 * the convention is greppable and cannot be misspelled into silence.
 */
export function userRefusal(message: string): UserRefusal {
  const err = new Error(message) as UserRefusal;
  err.userRefusal = true;
  return err;
}

/** True when the error carries a message written for the user. */
export function isUserRefusal(err: unknown): err is UserRefusal {
  return Boolean(err && typeof err === 'object' && (err as any).userRefusal === true);
}

/**
 * Patterns that prove a string came from the runtime rather than from us.
 *
 * Used as a LAST-LINE filter: even a message marked `userRefusal` is checked,
 * because a refusal built by interpolating a value — and several are — could
 * carry a path or a constraint name inside it without anyone noticing.
 */
const TECHNICAL_PATTERNS: RegExp[] = [
  // Node filesystem and network errno prefixes.
  /\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST|EBUSY|EMFILE|ENOSPC|EROFS|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|ENOTEMPTY)\b/,
  // SQLite result codes and its English diagnostics.
  /\bSQLITE_[A-Z_]+\b/,
  /\b(no such (table|column|function)|table [\w"]+ has no column|syntax error|constraint failed|database (is locked|disk image is malformed)|file is not a database|unable to open database)/i,
  // better-sqlite3 binding diagnostics.
  /\b(Unknown|Missing) named parameter\b/i,
  /\bProvided value cannot be bound\b/i,
  // Absolute paths: POSIX, Windows drive letters, and UNC shares.
  /(^|[\s'"(])\/(home|Users|var|tmp|etc|proc|opt|root|mnt|media)\//,
  /[A-Za-z]:[\\/]/,
  /\\\\[^\\]+\\/,
  // Anything that looks like a stack frame or a module path.
  /\bat\s+\w[\w.$]*\s*\(/,
  /\.(ts|js|mjs|cjs|tsx):\d+/,
  /\bnode_modules\b/,
  /\b(TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError|AssertionError)\b/,
  // Node's own internal module namespace.
  /\bnode:(internal|fs|path|crypto|http|net)\b/,
];

/** True when a string exposes something the renderer has no business seeing. */
export function looksTechnical(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  return TECHNICAL_PATTERNS.some((rx) => rx.test(text));
}

/** The message every unexplained failure returns. */
export const GENERIC_FAILURE =
  'تعذّر إتمام العملية. لم يتم حفظ أي تغيير. إذا تكرر الأمر أبلغ الدعم الفني بالرقم المرجعي.';

/** Monotonic counter feeding the reference code below. */
let sequence = 0;

/**
 * A short code printed in the toast AND written to the log alongside the full
 * error.
 *
 * Without it a generic message is a dead end for support: the shopkeeper says
 * "it failed", the developer looks at a log with forty entries and cannot tell
 * which one they mean. Six characters are enough to be read over the phone and
 * carry no information about the fault itself.
 */
export function newReference(): string {
  sequence = (sequence + 1) % 1_000_000;
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  return `${stamp}${sequence.toString(36).toUpperCase().padStart(2, '0')}`.slice(0, 6);
}

export interface SafeFailure {
  success: false;
  message: string;
  code: string;
  /** Present only on genuine faults, so support can find the log line. */
  ref?: string;
}

/**
 * Converts any thrown value into a reply that is safe to send to the renderer.
 *
 * The full error — message, code and stack — is written to the terminal with
 * the same reference the user is shown, so nothing is lost.
 *
 * @param channel  the IPC channel, for the log line
 * @param err      whatever was caught
 * @param fallback an Arabic sentence describing the failed operation, shown
 *                 instead of the generic one when it is more helpful
 */
export function safeFailure(channel: string, err: unknown, fallback?: string): SafeFailure {
  const raw = err instanceof Error ? err.message : String(err ?? '');

  // A message written for the user passes through — unless it has picked up
  // something technical along the way, which is checked rather than trusted.
  if (isUserRefusal(err) && !looksTechnical(raw)) {
    return { success: false, message: raw, code: 'REFUSED' };
  }

  const ref = newReference();
  // The FULL detail, on the server side only.
  console.error(
    `[IPC:${channel}] ref=${ref}`,
    err instanceof Error ? (err.stack || err.message) : err,
  );

  const message = fallback && !looksTechnical(fallback)
    ? `${fallback} (رمز: ${ref})`
    : `${GENERIC_FAILURE} (رمز: ${ref})`;
  return { success: false, message, code: 'HANDLER_ERROR', ref };
}

/**
 * Guards a message a handler is about to return.
 *
 * For the many sites that build their own Arabic sentence but splice a raw
 * error into it: if the result turns out to carry a path or a constraint name,
 * it is logged and replaced instead.
 */
export function safeMessage(channel: string, message: string, err?: unknown): SafeFailure {
  if (!looksTechnical(message)) {
    return { success: false, message, code: 'REFUSED' };
  }
  return safeFailure(channel, err ?? new Error(message));
}
