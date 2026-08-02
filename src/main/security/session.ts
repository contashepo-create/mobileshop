/**
 * Server-side session store (main process).
 *
 * SECURITY: The renderer must never be trusted to tell us who the user is.
 * Sessions are keyed by the WebContents id of the window that authenticated,
 * so a compromised renderer cannot impersonate another user by sending a
 * different `userId` in the IPC payload.
 */

export interface Session {
  userId: number;
  username: string;
  roleId: number | null;
  employeeId: number | null;
  /** Effective permission keys (role permissions +grants -denies). */
  permissions: Set<string>;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Idle timeout: a session is dropped after this long without any IPC call.
 *
 * Twelve hours matched a shift, but `getSession` refreshes `lastSeenAt` on
 * EVERY call — so a screen that polls, or a window simply left open on the
 * dashboard, renews the session indefinitely and it never expires at all.
 */
const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/**
 * Absolute lifetime, which idle activity CANNOT extend.
 *
 * This is the part that was missing. Without it a till left logged in over a
 * weekend is still logged in on Monday, under whoever walks up to it — the
 * idle timer having been reset by background polling the whole time. A hard
 * ceiling means every session ends, and the shop signs in again.
 */
const ABSOLUTE_TIMEOUT_MS = 16 * 60 * 60 * 1000;

const sessions = new Map<number, Session>();

export function createSession(webContentsId: number, session: Omit<Session, 'createdAt' | 'lastSeenAt'>) {
  const now = Date.now();
  sessions.set(webContentsId, { ...session, createdAt: now, lastSeenAt: now });
}

export function getSession(webContentsId: number): Session | null {
  const s = sessions.get(webContentsId);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > IDLE_TIMEOUT_MS) {
    sessions.delete(webContentsId);
    return null;
  }
  // Checked BEFORE the refresh below, so activity cannot push the ceiling out.
  if (now - s.createdAt > ABSOLUTE_TIMEOUT_MS) {
    sessions.delete(webContentsId);
    return null;
  }
  s.lastSeenAt = now;
  return s;
}

/** Exposed so a suite can assert the two limits rather than restate them. */
export const SESSION_LIMITS = {
  idleMs: IDLE_TIMEOUT_MS,
  absoluteMs: ABSOLUTE_TIMEOUT_MS,
} as const;

export function destroySession(webContentsId: number) {
  sessions.delete(webContentsId);
}

export function destroyAllSessionsForUser(userId: number) {
  for (const [id, s] of sessions) {
    if (s.userId === userId) sessions.delete(id);
  }
}
