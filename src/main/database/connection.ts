import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Check if a custom DB path is set in settings
    let dbPath = path.join(app.getPath('userData'), 'mobile_shop.db');

    // Try to read custom path from a settings file (not from DB itself, since DB might not exist yet)
    const settingsPath = path.join(app.getPath('userData'), 'db_settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.dbPath && fs.existsSync(settings.dbPath)) {
          dbPath = settings.dbPath;
          console.log('[DB] Using custom database path:', dbPath);
        }
      } catch {}
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

export function getDbPath(): string {
  const settingsPath = path.join(app.getPath('userData'), 'db_settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.dbPath) return settings.dbPath;
    } catch {}
  }
  return path.join(app.getPath('userData'), 'mobile_shop.db');
}

export function setDbPath(newPath: string) {
  const settingsPath = path.join(app.getPath('userData'), 'db_settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ dbPath: newPath }), 'utf-8');
  console.log('[DB] Path set to:', newPath);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
