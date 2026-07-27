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

/** Idle timeout: a session is dropped after this long without any IPC call. */
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h — desktop POS shift length

const sessions = new Map<number, Session>();

export function createSession(webContentsId: number, session: Omit<Session, 'createdAt' | 'lastSeenAt'>) {
  const now = Date.now();
  sessions.set(webContentsId, { ...session, createdAt: now, lastSeenAt: now });
}

export function getSession(webContentsId: number): Session | null {
  const s = sessions.get(webContentsId);
  if (!s) return null;
  if (Date.now() - s.lastSeenAt > IDLE_TIMEOUT_MS) {
    sessions.delete(webContentsId);
    return null;
  }
  s.lastSeenAt = Date.now();
  return s;
}

export function destroySession(webContentsId: number) {
  sessions.delete(webContentsId);
}

export function destroyAllSessionsForUser(userId: number) {
  for (const [id, s] of sessions) {
    if (s.userId === userId) sessions.delete(id);
  }
}
