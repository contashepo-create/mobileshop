/**
 * Brute-force protection for every endpoint that verifies a secret.
 *
 * WHY THIS EXISTS
 * ---------------
 * `auth:login` had no rate limit of any kind. Measured against the real
 * handler: 100 wrong passwords in 7.8 seconds — about 13 guesses a second,
 * indefinitely, with no delay and no lockout.
 *
 * A later sweep of every channel that verifies a credential found four more
 * on the same footing, and they are not minor doors:
 *
 *   db:exportForOwner         — dumps the whole database to a file
 *   users:adminResetPassword  — sets any user's password
 *   settings:resetRequestCode — step 1 of wiping the database
 *   settings:resetDatabase    — step 2 of wiping the database
 *
 * All four called `bcrypt.compareSync` directly with no counter. Measured:
 * ~13 attempts/second each, unlimited. bcrypt at cost 10 is the only thing
 * slowing an attacker down, and that is a budget, not a defence: a list of
 * 100,000 common passwords is exhausted in about two hours, unattended,
 * against a till left on a counter overnight.
 *
 * Notably `auth:login` locking out did NOT protect them — each has its own
 * password prompt, so an attacker simply guesses at one of the others.
 *
 * SCOPES
 * ------
 * Attempts are counted per (scope, identity). A wrong password on the export
 * screen must not lock the till out of selling, and locking the export screen
 * must not be avoidable by walking to the reset screen — so the destructive
 * operations share one scope while ordinary login keeps its own.
 *
 * WHY PER IDENTITY, NOT PER CONNECTION
 * ------------------------------------
 * There is no network and no IP here: this is IPC inside one desktop process.
 * The renderer is the caller and an attacker controls it, so anything keyed on
 * a window id is defeated by opening another window. The account being
 * attacked is the only stable key.
 *
 * WHY IN MEMORY
 * -------------
 * A restart clears it, which is a real limitation — but the alternative is a
 * database write on every failed attempt, which is itself a denial-of-service
 * lever and adds a write path to operations that must work when the database
 * is in trouble (one of them is the database RESET). Restarting an Electron
 * app is not free or silent for someone standing at the counter, and the
 * developer-console lockout in `devAuth.ts` makes the same trade.
 *
 * WHY NOT SILENT
 * --------------
 * A lockout that looks identical to a wrong password teaches the shop nothing
 * and generates support calls. The message says how long is left. That does
 * reveal "this account exists and is locked", which is a deliberate trade:
 * `users:listRecoverable` already lists administrator usernames, so there is
 * no enumeration secret left to protect, and the owner needs to understand
 * what is happening to their own till.
 */

/** Consecutive failures before the identity is locked. */
const MAX_ATTEMPTS = 5;

/** How long the lock lasts. Long enough to make guessing pointless, short
 *  enough that a shop that fat-fingered its own password can trade again. */
const LOCKOUT_MS = 15 * 60 * 1000;

/** Failures older than this are forgotten, so an honest typo last month does
 *  not count towards today's lockout. */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The buckets attempts are counted in.
 *
 * `login`     — the ordinary shop login.
 * `dangerous` — operations that export, reset a password, or wipe the
 *               database. Shared deliberately: they are all "prove you are the
 *               owner", so guessing at one must count against all of them.
 * `code`      — typed one-time codes, on top of the per-code attempt limit in
 *               `confirmCode.ts`, which only guards a single outstanding code.
 */
export type ThrottleScope = 'login' | 'dangerous' | 'code';

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const entries = new Map<string, Entry>();

/** Identities are matched case-insensitively so `Admin` cannot dodge a lock. */
const keyFor = (scope: ThrottleScope, identity: string | number) =>
  `${scope}:${String(identity ?? '').trim().toLowerCase()}`;

/**
 * Whether this identity may attempt again right now.
 *
 * @returns `null` when allowed, or the seconds remaining on the lock.
 */
export function checkAttemptAllowed(
  scope: ThrottleScope, identity: string | number,
): { lockedForSec: number } | null {
  const k = keyFor(scope, identity);
  const e = entries.get(k);
  if (!e) return null;

  const now = Date.now();
  if (e.lockedUntil > now) {
    return { lockedForSec: Math.ceil((e.lockedUntil - now) / 1000) };
  }
  // The lock has expired, or the counting window has. Either way start clean —
  // otherwise one stale failure would make the next four fatal.
  if (e.lockedUntil !== 0 || now - e.firstFailureAt > ATTEMPT_WINDOW_MS) {
    entries.delete(k);
  }
  return null;
}

/** Records a failed attempt, locking the identity once the limit is reached. */
export function recordAttemptFailure(scope: ThrottleScope, identity: string | number): void {
  const k = keyFor(scope, identity);
  const now = Date.now();
  const e = entries.get(k);

  if (!e || now - e.firstFailureAt > ATTEMPT_WINDOW_MS) {
    entries.set(k, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }

  e.failures += 1;
  if (e.failures >= MAX_ATTEMPTS) {
    e.lockedUntil = now + LOCKOUT_MS;
    e.failures = 0;            // the lock replaces the count
    e.firstFailureAt = now;
  }
}

/** Clears the record. Called after a successful verification. */
export function recordAttemptSuccess(scope: ThrottleScope, identity: string | number): void {
  entries.delete(keyFor(scope, identity));
}

/**
 * The Arabic refusal shown while an identity is locked.
 *
 * One wording for every endpoint, so the shop learns the behaviour once.
 */
export function lockoutMessage(lockedForSec: number): string {
  const mins = Math.max(1, Math.ceil(lockedForSec / 60));
  return `تم إيقاف المحاولات مؤقتاً بعد عدة محاولات خاطئة - أعد المحاولة بعد ${mins} دقيقة`;
}

// ---------------------------------------------------------------------------
// Login-specific wrappers.
//
// `auth:login` was throttled first and reads more clearly with named helpers.
// They are thin aliases so there is still exactly one implementation.
// ---------------------------------------------------------------------------
export const checkLoginAllowed = (username: string) => checkAttemptAllowed('login', username);
export const recordLoginFailure = (username: string) => recordAttemptFailure('login', username);
export const recordLoginSuccess = (username: string) => recordAttemptSuccess('login', username);

/** Exposed so a suite can assert the limits rather than restate them. */
export const LOGIN_THROTTLE = { maxAttempts: MAX_ATTEMPTS, lockoutMs: LOCKOUT_MS } as const;

/** Test-only: forget every record. */
export function __resetLoginThrottle(): void {
  entries.clear();
}
