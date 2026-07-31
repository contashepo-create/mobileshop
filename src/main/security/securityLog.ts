/**
 * The permanent record of security-relevant events.
 *
 * Extracted so every module writes through ONE function. Password resets live
 * in `users.handlers.ts` and database resets in `settings.handlers.ts`; a
 * private copy in each would eventually disagree about the column names or,
 * worse, about whether a failure may propagate.
 *
 * `security_events` is deliberately kept apart from the accounting tables: it
 * must survive a fiscal-year close, a deletion, and — above all — a database
 * reset, which is itself one of the events it records.
 */
import type { Database } from 'better-sqlite3';

/**
 * Append one row. Never throws.
 *
 * An audit failure must not roll back an operation the user has already been
 * told about, and must not block them from signing in afterwards. A lost log
 * line is bad; a password change that half-happened is worse.
 */
export function recordSecurityEvent(
  db: Database,
  eventType: string,
  userId: number | null,
  username: string | null,
  detail: string,
): void {
  try {
    db.prepare(
      'INSERT INTO security_events (EventType, UserID, Username, Detail) VALUES (?, ?, ?, ?)',
    ).run(eventType, userId, username, detail);
  } catch (err) {
    console.error('[security] could not record event:', err);
  }
}
