import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

let db: Database.Database | null = null;

/** Where the custom-path setting lives. Read before the database is open. */
function settingsFile(): string {
  return path.join(app.getPath('userData'), 'db_settings.json');
}

/** The default location, used whenever no valid custom path is configured. */
function defaultDbPath(): string {
  return path.join(app.getPath('userData'), 'mobile_shop.db');
}

/**
 * The configured custom path, or null.
 *
 * SINGLE SOURCE OF TRUTH. `getDb()` and `getDbPath()` previously each parsed
 * db_settings.json with their OWN rules and could disagree:
 *
 *   - `getDb()` required `fs.existsSync(settings.dbPath)` and silently fell
 *     back to the default when the file was not reachable;
 *   - `getDbPath()` returned the configured path unconditionally.
 *
 * On a shop whose database sits on a network share, that divergence is a
 * data-loss trap. If the share is offline at launch, the app quietly opens a
 * DIFFERENT (usually empty) database and carries on as if nothing happened —
 * while `backup:restore`, which targets `getDbPath()`, writes the restored
 * data to the unreachable network file. The owner sees an empty shop, restores
 * a backup, is told it succeeded, and still sees an empty shop.
 *
 * Both callers now go through here, so they cannot drift apart again.
 */
function configuredDbPath(): string | null {
  const file = settingsFile();
  if (!fs.existsSync(file)) return null;
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const p = settings?.dbPath;
    return typeof p === 'string' && p.trim() ? p : null;
  } catch (err) {
    // A corrupt settings file is not a normal condition: it means the shop is
    // about to be pointed at the wrong database. Silence here made that
    // indistinguishable from "no custom path configured".
    console.error('[DB] db_settings.json is unreadable, using the default path:', err);
    return null;
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const configured = configuredDbPath();
    let dbPath = configured ?? defaultDbPath();

    if (configured && !fs.existsSync(configured)) {
      // Loud, because the shop is about to work in the WRONG database. This
      // used to happen silently whenever a network share was unavailable.
      console.error(
        `[DB] Configured database not found: ${configured}\n` +
        '[DB] Falling back to the default location. If this database lives on a ' +
        'network share, check the connection BEFORE entering any data — work ' +
        'saved now will not be in the shared database.',
      );
      dbPath = defaultDbPath();
    } else if (configured) {
      console.log('[DB] Using custom database path:', dbPath);
    }

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('[DB] Connected to:', dbPath);
  }
  return db;
}

/**
 * The path of the database the application is ACTUALLY using.
 *
 * When the connection is open this is taken from the live handle, so a restore
 * or a backup can never target a different file from the one being read.
 */
export function getDbPath(): string {
  if (db) return db.name;
  const configured = configuredDbPath();
  if (configured && fs.existsSync(configured)) return configured;
  return defaultDbPath();
}

export function setDbPath(newPath: string) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ dbPath: newPath }), 'utf-8');
  console.log('[DB] Path set to:', newPath);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
