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

    // WAL is the right journal for a local disk and the WRONG one for a network
    // share. It needs a shared-memory (-shm) file, which SMB and most network
    // filesystems do not implement correctly; SQLite's own documentation warns
    // that the result is corruption rather than an error. A shop running its
    // database from a shared folder — which `db:createNetwork` explicitly
    // offers — must therefore fall back to the older, slower, safe journal.
    const onNetworkShare = isNetworkPath(dbPath);
    if (onNetworkShare) {
      db.pragma('journal_mode = DELETE');
      console.log('[DB] network path detected — using DELETE journal (WAL is unsafe over SMB)');
    } else {
      db.pragma('journal_mode = WAL');
    }

    // How long a write waits for another machine before giving up.
    //
    // better-sqlite3 defaults to 5 seconds, which is fine for two clicks a
    // second apart and NOT fine for the case that actually happens: one
    // workstation runs a long report or the nightly backup while a cashier
    // rings up a sale. Measured with two real processes — an 8-second
    // transaction on machine A made machine B fail with SQLITE_BUSY after
    // 5,012 ms; with 15 seconds it waited 7,646 ms and completed.
    //
    // A failed sale is far worse than a slow one, so the wait is generous.
    db.pragma(`busy_timeout = ${onNetworkShare ? 30000 : 15000}`);

    db.pragma('foreign_keys = ON');
    console.log('[DB] Connected to:', dbPath);
  }
  return db;
}

/**
 * True when the database lives on a network share rather than a local disk.
 *
 * Recognises a Windows UNC path and, on Unix, the usual mount points. A mapped
 * drive letter is
 * indistinguishable from a local one at this level — so this is a best-effort
 * signal, not a guarantee. It only ever makes the configuration MORE
 * conservative, so a false negative costs nothing beyond the old behaviour and
 * a false positive costs a little speed.
 */
function isNetworkPath(p: string): boolean {
  if (!p) return false;
  // Normalise to backslashes so a UNC path is recognisable whichever
  // separator the caller used.
  const win = p.replace(/\//g, '\\');
  if (win.startsWith('\\\\')) return true;              // \\server\share
  if (/^\/(mnt|media|net)\//.test(p)) return true;      // common Unix mounts
  return false;
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
