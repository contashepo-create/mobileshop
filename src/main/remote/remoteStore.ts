import { getDb } from '../database/connection';
import {
  isRemoteManaged, sanitiseRemoteValue, assertNoForbiddenOverlap,
} from './remoteConfig';

/**
 * Local cache of everything the developer's server has told this install.
 *
 * The app must stay fully usable with no internet, so the last successful
 * heartbeat response is persisted and used as-is until the next one arrives.
 * Nothing here can block the application: if these tables are empty the app
 * simply falls back to its local settings.
 */

export function ensureRemoteTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_config (
      Key        TEXT NOT NULL,
      Scope      TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'device'
      Value      TEXT,
      UpdatedAt  TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (Key, Scope)
    );

    CREATE TABLE IF NOT EXISTS remote_messages (
      MessageID  INTEGER PRIMARY KEY,           -- server-assigned id
      Title      TEXT NOT NULL,
      Body       TEXT NOT NULL,
      Severity   TEXT DEFAULT 'info',           -- info | warning | urgent
      CreatedAt  TEXT,
      ExpiresAt  TEXT,
      ReadAt     TEXT,
      AckSynced  INTEGER DEFAULT 0              -- 1 once the read receipt uploaded
    );

    CREATE TABLE IF NOT EXISTS remote_state (
      Key   TEXT PRIMARY KEY,
      Value TEXT
    );
  `);

  // Anchor for the "please connect" reminder. Without it, an install that has
  // NEVER reached the server would have no reference point and could never be
  // reminded. `INSERT OR IGNORE` means it is written exactly once, on the first
  // run, and every later boot leaves the original value alone.
  db.prepare(`
    INSERT OR IGNORE INTO remote_state (Key, Value) VALUES ('installed_at', ?)
  `).run(new Date().toISOString());
}

// ---------------------------------------------------------------- config

/**
 * Stores a config payload from the server.
 * Values are filtered through the client-side allow-list, so a compromised
 * server cannot introduce keys the app never agreed to accept.
 */
export function saveRemoteConfig(scope: 'all' | 'device', values: Record<string, unknown>) {
  assertNoForbiddenOverlap();
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO remote_config (Key, Scope, Value, UpdatedAt)
    VALUES (?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(Key, Scope) DO UPDATE SET Value = excluded.Value, UpdatedAt = excluded.UpdatedAt
  `);
  const remove = db.prepare('DELETE FROM remote_config WHERE Key = ? AND Scope = ?');

  const tx = db.transaction(() => {
    for (const [key, raw] of Object.entries(values || {})) {
      if (!isRemoteManaged(key)) continue;          // silently ignore unknown keys
      const clean = sanitiseRemoteValue(key, raw);
      // An empty string means "stop overriding this key" — the app falls back
      // to the local value rather than displaying a blank field.
      if (clean === null || clean === '') remove.run(key, scope);
      else upsert.run(key, scope, clean);
    }
  });
  tx();
}

/** Effective remote overrides, device scope winning over broadcast scope. */
export function getRemoteOverrides(): Record<string, string> {
  const db = getDb();
  const out: Record<string, string> = {};
  try {
    // Order matters: 'all' first, then 'device' overwrites it.
    const rows = db.prepare(`
      SELECT Key, Value, Scope FROM remote_config
      ORDER BY CASE Scope WHEN 'all' THEN 0 ELSE 1 END
    `).all() as any[];
    for (const r of rows) {
      if (isRemoteManaged(r.Key) && r.Value != null) out[r.Key] = r.Value;
    }
  } catch {
    /* tables not created yet — no overrides */
  }
  return out;
}

// ---------------------------------------------------------------- messages

export interface IncomingMessage {
  id: number;
  title: string;
  body: string;
  severity?: string;
  createdAt?: string;
  expiresAt?: string | null;
}

/** Inserts new messages; existing ids are left untouched so read state survives. */
export function saveRemoteMessages(messages: IncomingMessage[]) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO remote_messages (MessageID, Title, Body, Severity, CreatedAt, ExpiresAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(MessageID) DO UPDATE SET
      Title = excluded.Title, Body = excluded.Body,
      Severity = excluded.Severity, ExpiresAt = excluded.ExpiresAt
  `);
  const tx = db.transaction(() => {
    for (const m of messages) {
      if (!m || typeof m.id !== 'number') continue;
      const title = String(m.title ?? '').slice(0, 200);
      const body = String(m.body ?? '').slice(0, 4000);
      if (!title && !body) continue;
      stmt.run(m.id, title, body, String(m.severity ?? 'info'),
        m.createdAt ?? new Date().toISOString(), m.expiresAt ?? null);
    }
  });
  tx();
}

/** Messages that are not expired, newest first. */
export function listRemoteMessages() {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT MessageID, Title, Body, Severity, CreatedAt, ReadAt
      FROM remote_messages
      WHERE ExpiresAt IS NULL OR ExpiresAt > datetime('now')
      ORDER BY (ReadAt IS NOT NULL), CreatedAt DESC
    `).all();
  } catch {
    return [];
  }
}

/**
 * Messages the customer has not acknowledged yet, oldest first.
 *
 * Oldest-first is deliberate: they are shown one after another, and reading
 * them in the order the developer sent them is the only order that makes sense
 * (e.g. "maintenance tonight" then "maintenance finished").
 */
export function listUnreadMessages() {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT MessageID, Title, Body, Severity, CreatedAt
      FROM remote_messages
      WHERE ReadAt IS NULL
        AND (ExpiresAt IS NULL OR ExpiresAt > datetime('now'))
      ORDER BY CreatedAt ASC, MessageID ASC
    `).all();
  } catch {
    return [];
  }
}

export function markMessageRead(messageId: number) {
  const db = getDb();
  db.prepare(`
    UPDATE remote_messages SET ReadAt = datetime('now','localtime')
    WHERE MessageID = ? AND ReadAt IS NULL
  `).run(messageId);
}

/** Read receipts still waiting to be reported back to the server. */
export function pendingReadReceipts(): number[] {
  const db = getDb();
  try {
    const rows = db.prepare(
      'SELECT MessageID FROM remote_messages WHERE ReadAt IS NOT NULL AND AckSynced = 0'
    ).all() as any[];
    return rows.map(r => r.MessageID);
  } catch {
    return [];
  }
}

export function markReceiptsSynced(ids: number[]) {
  if (!ids.length) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE remote_messages SET AckSynced = 1 WHERE MessageID = ?');
  db.transaction(() => { for (const id of ids) stmt.run(id); })();
}

/**
 * Removes local copies of messages the developer has RETRACTED.
 *
 * The server sends tombstone ids after a delete; a device that already
 * received the message must drop it — read or not — so a test message sent by
 * mistake disappears from every shop on the next check-in. Ids the device
 * never received are a harmless no-op.
 */
export function removeRemoteMessages(ids: number[]) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const db = getDb();
  const del = db.prepare('DELETE FROM remote_messages WHERE MessageID = ?');
  db.transaction(() => {
    for (const id of ids) {
      if (typeof id === 'number' && Number.isInteger(id)) del.run(id);
    }
  })();
}

// ---------------------------------------------------------------- state

export function getRemoteState(key: string): string | null {
  const db = getDb();
  try {
    const row = db.prepare('SELECT Value FROM remote_state WHERE Key = ?').get(key) as any;
    return row?.Value ?? null;
  } catch {
    return null;
  }
}

export function setRemoteState(key: string, value: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO remote_state (Key, Value) VALUES (?, ?)
    ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value
  `).run(key, value);
}
