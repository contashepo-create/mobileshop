/**
 * Brute-force protection for the shop login.
 *
 * WHY THIS EXISTS
 * ---------------
 * `auth:login` had no rate limit of any kind. Measured against the real
 * handler: 100 wrong passwords in 7.8 seconds — about 13 guesses a second,
 * indefinitely, with no delay and no lockout. The developer console has had a
 * lockout since it was written (`devAuth.ts`); the door the shop actually uses
 * had none.
 *
 * bcrypt at cost 10 is the only thing slowing an attacker down, and that is a
 * budget, not a defence: a six-character lowercase password is ~300 million
 * combinations, but the passwords a shop actually chooses are not random. At
 * 13/sec a common-password list of 100,000 entries is exhausted in just over
 * two hours, unattended, against a till left on a counter.
 *
 * WHAT IT DOES
 * ------------
 * Per-username, in memory, in the main process:
 *
 *   - after 5 consecutive failures the account is locked for 15 minutes;
 *   - a successful login clears the counter immediately;
 *   - the remaining time is reported, so an owner who genuinely forgot is not
 *     left staring at a generic refusal.
 *
 * WHY PER USERNAME, NOT PER WINDOW
 * --------------------------------
 * The attacker controls the renderer, so anything keyed on the window id is
 * defeated by opening another one. The username is the thing being attacked.
 *
 * WHY IN MEMORY
 * -------------
 * A restart clears it, which is a real limitation — but the alternative is a
 * database write on every failed attempt, which is itself a denial-of-service
 * lever and adds a write path to the one operation that must work when the
 * database is in trouble. Restarting an Electron app is not free or silent for
 * someone standing at the counter, and the developer-console lockout in
 * `devAuth.ts` makes the same trade for the same reason.
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

/** Consecutive failures before the account is locked. */
const MAX_ATTEMPTS = 5;

/** How long the lock lasts. Long enough to make guessing pointless, short
 *  enough that a shop that fat-fingered its own password can trade again. */
const LOCKOUT_MS = 15 * 60 * 1000;

/** Failures older than this are forgotten, so an honest typo weeks ago does
 *  not count towards today's lockout. */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const entries = new Map<string, Entry>();

/** Usernames are matched case-insensitively so `Admin` cannot dodge the lock. */
const key = (username: string) => String(username ?? '').trim().toLowerCase();

/**
 * Whether this username may attempt a login right now.
 *
 * @returns `null` when allowed, or the seconds remaining on the lock.
 */
export function checkLoginAllowed(username: string): { lockedForSec: number } | null {
  const k = key(username);
  const e = entries.get(k);
  if (!e) return null;

  const now = Date.now();
  if (e.lockedUntil > now) {
    return { lockedForSec: Math.ceil((e.lockedUntil - now) / 1000) };
  }
  // The lock has expired, or the counting window has. Either way, start clean —
  // otherwise a single old failure would make the next four fatal.
  if (e.lockedUntil !== 0 || now - e.firstFailureAt > ATTEMPT_WINDOW_MS) {
    entries.delete(k);
  }
  return null;
}

/** Records a failed attempt, locking the account once the limit is reached. */
export function recordLoginFailure(username: string): void {
  const k = key(username);
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

/** Clears the record. Called on a successful login. */
export function recordLoginSuccess(username: string): void {
  entries.delete(key(username));
}

/** Exposed so a suite can assert the limits rather than restate them. */
export const LOGIN_THROTTLE = { maxAttempts: MAX_ATTEMPTS, lockoutMs: LOCKOUT_MS } as const;

/** Test-only: forget every record. */
export function __resetLoginThrottle(): void {
  entries.clear();
}
