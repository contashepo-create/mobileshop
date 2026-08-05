import { ipcMain, dialog, app } from 'electron';
import { getDb, getDbPath, setDbPath } from '../database/connection';
import path from 'node:path';
import fs from 'node:fs';
import { businessToday } from '../../shared/businessDate';
import bcrypt from 'bcryptjs';
import { recordSecurityEvent } from '../security/securityLog';
import { checkAttemptAllowed, recordAttemptFailure, recordAttemptSuccess, lockoutMessage } from '../security/loginThrottle';
import {
  testTelegram, sendBackupToTelegram, looksLikeBotToken, looksLikeChatId,
} from '../backup/telegramBackup';

/**
 * Tables that must never be exported: they contain password hashes or
 * device secrets that should not leave the application in plain CSV.
 *
 * `settings` is here because it holds bearer credentials — the cloud API key
 * and the Telegram bot token. Exporting it wrote those into a plain CSV that
 * then travels by email or USB stick. The business-relevant settings are all
 * visible on the settings screens anyway, so nothing useful is lost.
 */
const EXPORT_BLOCKLIST = new Set(['users', 'user_overrides', 'settings']);

/**
 * SECURITY: `tableName` arrives from the renderer and used to be interpolated
 * straight into `SELECT * FROM ${tableName}`. That allowed both SQL injection
 * and dumping the `users` table (bcrypt hashes) to a file. We now resolve the
 * name against the real schema and reject anything else.
 */
function assertExportableTable(db: ReturnType<typeof getDb>, tableName: unknown): string {
  if (typeof tableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error('اسم الجدول غير صالح');
  }
  const known = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ? AND name NOT LIKE 'sqlite_%'"
  ).get(tableName) as any;
  if (!known) throw new Error('الجدول غير موجود');
  if (EXPORT_BLOCKLIST.has(tableName)) throw new Error('لا يمكن تصدير هذا الجدول لأسباب أمنية');
  return known.name as string;
}

/** RFC4180-safe CSV cell; also neutralises spreadsheet formula injection. */
function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // A leading =, +, - or @ makes Excel/LibreOffice evaluate the cell as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function registerDatabaseHandlers() {
  // ===== EXPORT TO CSV =====
  ipcMain.handle('db:exportCSV', async (_event, tableName: string) => {
    const db = getDb();
    let safeTable: string;
    try {
      safeTable = assertExportableTable(db, tableName);
    } catch (err: any) {
      return { success: false, message: err.message };
    }
    const rows = db.prepare(`SELECT * FROM "${safeTable}"`).all() as any[];
    if (rows.length === 0) return { success: false, message: 'لا توجد بيانات' };

    const result = await dialog.showSaveDialog({
      title: `تصدير ${safeTable}`,
      defaultPath: `${safeTable}_export_${businessToday()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    if (result.canceled || !result.filePath) return { success: false, message: 'تم الإلغاء' };

    const headers = Object.keys(rows[0]);
    const csvLines: string[] = [];

    // BOM for Excel Arabic support
    csvLines.push('\uFEFF' + headers.join(','));

    for (const row of rows) {
      csvLines.push(headers.map(h => csvCell(row[h])).join(','));
    }

    fs.writeFileSync(result.filePath, csvLines.join('\n'), 'utf-8');
    return { success: true, path: result.filePath, count: rows.length };
  });

  // Export all tables to CSV in a folder
  ipcMain.handle('db:exportAllCSV', async () => {
    const db = getDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'
    `).all() as any[];

    const result = await dialog.showOpenDialog({
      title: 'اختر مجلد للحفظ',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return { success: false, message: 'تم الإلغاء' };

    const folder = result.filePaths[0];
    let exportedCount = 0;

    for (const table of tables) {
      const tableName = table.name as string;
      if (EXPORT_BLOCKLIST.has(tableName)) continue; // never dump credential tables
      const rows = db.prepare(`SELECT * FROM "${tableName}"`).all() as any[];
      if (rows.length === 0) continue;

      const headers = Object.keys(rows[0]);
      const csvLines: string[] = ['\uFEFF' + headers.join(',')];

      for (const row of rows) {
        csvLines.push(headers.map(h => csvCell(row[h])).join(','));
      }

      const filePath = path.join(folder, `${tableName}.csv`);
      fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
      exportedCount++;
    }

    return { success: true, folder, tables: exportedCount };
  });

  // ===== AUTO BACKUP =====
  ipcMain.handle('db:autoBackup', async () => {
    const db = getDb();
    const dbPath = db.name;
    const backupDir = path.join(app.getPath('userData'), 'backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const today = businessToday();
    const backupPath = path.join(backupDir, `auto_backup_${today}.db`);

    // Check if today's backup already exists
    if (fs.existsSync(backupPath)) {
      return { success: true, path: backupPath, message: 'النسخة اليومية موجودة بالفعل' };
    }

    try {
      // SQLite's own backup API, NOT fs.copyFileSync.
      //
      // The database runs in WAL mode (see connection.ts), so recent
      // transactions live in the `-wal` sidecar file until a checkpoint folds
      // them back into the main file. Copying only the main file was measured
      // against a database holding 500 sales: the copy did not merely lose the
      // newest rows, it was UNREADABLE — "no such table: sales" — because even
      // the schema was still in the -wal. A shop restoring that file would find
      // its entire history gone, with the backup having reported success.
      //
      // `db.backup()` checkpoints and produces a consistent standalone file.
      // `src/main/index.ts` was already fixed this way; this handler is the
      // copy that was left behind, and it is the one the Backup button calls.
      await db.backup(backupPath);

      // Clean old backups (keep last 7 days).
      //
      // Only files this function created are eligible. The previous version
      // deleted EVERY entry older than 7 days in the folder — including a
      // manual backup the owner had deliberately stored there — and threw on
      // sub-directories, which aborted the whole handler.
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      for (const file of fs.readdirSync(backupDir)) {
        if (!/^auto_backup_\d{4}-\d{2}-\d{2}\.db$/.test(file)) continue;
        const filePath = path.join(backupDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch { /* skip unreadable entries */ }
      }

      return { success: true, path: backupPath };
    } catch (err: any) {
      console.error('[DB] Auto-backup failed:', err);
      return { success: false, message: err.message };
    }
  });

  // Get auto-backup info
  ipcMain.handle('db:backupInfo', async () => {
    const backupDir = path.join(app.getPath('userData'), 'backups');
    const backups: any[] = [];

    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        backups.push({
          name: file,
          path: filePath,
          size: stats.size,
          sizeFormatted: stats.size > 1024 * 1024
            ? `${(stats.size / 1024 / 1024).toFixed(2)} MB`
            : `${(stats.size / 1024).toFixed(2)} KB`,
          date: stats.mtime.toISOString().split('T')[0],
        });
      }
      backups.sort((a, b) => b.date.localeCompare(a.date));
    }

    const db = getDb();
    const dbPath = db.name;
    let dbSize = 0;
    try { dbSize = fs.statSync(dbPath).size; } catch {}

    return {
      dbPath,
      dbSize,
      dbSizeFormatted: dbSize > 1024 * 1024
        ? `${(dbSize / 1024 / 1024).toFixed(2)} MB`
        : `${(dbSize / 1024).toFixed(2)} KB`,
      backups,
      autoBackupEnabled: true,
      backupDir,
    };
  });

  // ===== CHANGE DATABASE PATH (Local/Network) =====
  ipcMain.handle('db:changePath', async (_event, newPath: string) => {
    if (!fs.existsSync(newPath)) {
      return { success: false, message: 'الملف غير موجود في المسار المحدد' };
    }

    // Verify the file really is a SQLite database BEFORE pointing the app at
    // it. `setDbPath` writes to db_settings.json, which is read on the next
    // launch — so accepting a wrong file (a .txt renamed to .db, a Word
    // document, a truncated download) does not fail here, it fails at STARTUP,
    // leaving the shop with an application that will not open and no obvious
    // way back. Every SQLite file begins with the 16-byte magic string
    // "SQLite format 3\0"; `backup:restore` already checks this and this path
    // is the one that was missing it.
    try {
      const header = Buffer.alloc(16);
      const fd = fs.openSync(newPath, 'r');
      const read = fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (read < 16 || header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
        return { success: false, message: 'الملف المختار ليس قاعدة بيانات SQLite صالحة' };
      }
    } catch (err: any) {
      console.error('[DB] changePath validation failed:', err);
      return { success: false, message: 'تعذر قراءة الملف المختار' };
    }

    // Save the new path in settings file (not DB, since DB path is changing)
    setDbPath(newPath);

    return {
      success: true,
      message: 'تم تغيير مسار قاعدة البيانات. يرجى إعادة تشغيل التطبيق.',
      newPath
    };
  });

  // Get current DB path
  ipcMain.handle('db:getPath', async () => {
    return getDbPath();
  });

  // Browse for database file (network path)
  ipcMain.handle('db:browsePath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'اختر قاعدة البيانات',
      filters: [{ name: 'Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'تم الإلغاء' };
    }

    return { success: true, path: result.filePaths[0] };
  });

  // Create new database on network path
  ipcMain.handle('db:createNetwork', async (_event, folderPath: string) => {
    const dbPath = path.join(folderPath, 'mobile_shop_shared.db');
    if (fs.existsSync(dbPath)) {
      return { success: false, message: 'يوجد قاعدة بيانات بهذا الاسم بالفعل في هذا المسار' };
    }

    // Seed the shared database with SQLite's backup API, not a file copy.
    // In WAL mode a plain copy can produce an unreadable file (measured: a
    // 500-sale database copied this way reported "no such table"), and here
    // the damage is worse than a bad backup — it would become the LIVE
    // database every workstation then connects to.
    const currentDb = getDb();
    await currentDb.backup(dbPath);

    // Save path in settings
    currentDb.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('db_path', ?)").run(dbPath);

    return {
      success: true,
      path: dbPath,
      message: 'تم إنشاء قاعدة بيانات مشتركة. أعد تشغيل التطبيق لاستخدامها.'
    };
  });

  // Browse for folder (network share)
  ipcMain.handle('db:browseFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'اختر مجلد',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'تم الإلغاء' };
    }

    return { success: true, path: result.filePaths[0] };
  });

  // ===== CLOUD BACKUP SETTINGS =====
  ipcMain.handle('db:getCloudSettings', async () => {
    const db = getDb();
    const settings: any = {};
    const rows = db.prepare("SELECT Key, Value FROM settings WHERE Key LIKE 'cloud_%' OR Key LIKE 'sync_%'").all() as any[];
    for (const row of rows) {
      settings[row.Key] = row.Value;
    }
    return settings;
  });

  ipcMain.handle('db:saveCloudSettings', async (_event, settings: Record<string, string>) => {
    const db = getDb();
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)");
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        stmt.run(key, value);
      }
    });
    tx();
    return { success: true };
  });

  // Test cloud connection
  ipcMain.handle('db:testCloudConnection', async (_event, config: {
    type: string; url: string; apiKey: string; bucket?: string;
  }) => {
    try {
      if (config.type === 'supabase') {
        // Test Supabase connection
        const response = await fetch(`${config.url}/rest/v1/`, {
          headers: {
            'apikey': config.apiKey,
            'Authorization': `Bearer ${config.apiKey}`,
          },
        });
        if (response.ok) {
          return { success: true, message: 'تم الاتصال بقاعدة البيانات السحابية بنجاح' };
        }
        return { success: false, message: `فشل الاتصال: ${response.status} ${response.statusText}` };
      } else if (config.type === 'webdav' || config.type === 'custom') {
        // Test generic URL connection
        const response = await fetch(config.url, {
          method: 'HEAD',
          headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
        });
        if (response.ok || response.status === 405) {
          return { success: true, message: 'تم الاتصال بالخادم بنجاح' };
        }
        return { success: false, message: `فشل الاتصال: ${response.status}` };
      } else if (config.type === 'local_network') {
        // Test local network path
        if (!fs.existsSync(config.url)) {
          return { success: false, message: 'المسار غير موجود أو غير قابل للوصول' };
        }
        return { success: true, message: 'تم الوصول للمسار بنجاح' };
      }
      return { success: false, message: 'نوع الاتصال غير مدعوم' };
    } catch (err: any) {
      return { success: false, message: `خطأ: ${err.message}` };
    }
  });

  // Upload backup to cloud
  ipcMain.handle('db:uploadToCloud', async (_event, config: { type: string; url: string; apiKey: string }) => {
    const db = getDb();
    const dbPath = db.name;
    const today = businessToday();
    const backupPath = path.join(app.getPath('temp'), `mobile_shop_${today}.db`);

    // Refuse to send the shop's whole database over an unencrypted channel.
    // This payload contains every customer, balance, price and password hash
    // in the business; on plain http:// it is readable by anyone on the path.
    let target: URL;
    try {
      target = new URL(config.url);
    } catch {
      return { success: false, message: 'رابط السحابة غير صالح' };
    }
    if (target.protocol !== 'https:') {
      return { success: false, message: 'يجب أن يبدأ رابط السحابة بـ https — الرفع عبر http غير آمن' };
    }

    try {
      // WAL-safe: a plain copy of a live WAL database can be unreadable, and
      // an unreadable off-site backup is worse than none because the shop
      // believes it is protected.
      await db.backup(backupPath);
      const fileBuffer = fs.readFileSync(backupPath);

      if (config.type === 'supabase') {
        const response = await fetch(`${config.url}/storage/v1/object/backups/mobile_shop_${today}.db`, {
          method: 'POST',
          headers: {
            'apikey': config.apiKey,
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/octet-stream',
          },
          body: fileBuffer,
        });
        if (response.ok) {
          fs.unlinkSync(backupPath);
          return { success: true, message: 'تم رفع النسخة الاحتياطية للسحابة' };
        }
        return { success: false, message: `فشل الرفع: ${response.status}` };
      } else if (config.type === 'webdav' || config.type === 'custom') {
        const response = await fetch(`${config.url}/mobile_shop_${today}.db`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/octet-stream',
          },
          body: fileBuffer,
        });
        if (response.ok) {
          fs.unlinkSync(backupPath);
          return { success: true, message: 'تم رفع النسخة الاحتياطية للسحابة' };
        }
        return { success: false, message: `فشل الرفع: ${response.status}` };
      }

      return { success: false, message: 'نوع الرفع غير مدعوم' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // ===== TELEGRAM BACKUP =====
  /**
   * Off-site backup to the OWNER's own Telegram bot.
   *
   * The automatic daily backups sit on the same disk as the database, so a dead
   * drive or a stolen machine takes the books and every backup at once. This is
   * the copy that survives losing the computer.
   */
  const telegramConfig = () => {
    const db = getDb();
    const rows = db.prepare(
      "SELECT Key, Value FROM settings WHERE Key IN ('telegram_bot_token','telegram_chat_id','telegram_backup_enabled')",
    ).all() as any[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.Key] = r.Value;
    return {
      botToken: map.telegram_bot_token || '',
      chatId: map.telegram_chat_id || '',
      enabled: map.telegram_backup_enabled === '1',
    };
  };

  ipcMain.handle('telegram:getSettings', async () => {
    const cfg = telegramConfig();
    // The token itself never returns to the renderer. The screen only needs to
    // know whether one is stored; echoing it back would put a bearer credential
    // into the renderer's memory and into any crash dump for no benefit.
    return {
      hasToken: Boolean(cfg.botToken),
      tokenHint: cfg.botToken ? `${cfg.botToken.split(':')[0]}:***` : '',
      chatId: cfg.chatId,
      enabled: cfg.enabled,
    };
  });

  ipcMain.handle('telegram:saveSettings', async (_event, data: {
    botToken?: string; chatId?: string; enabled?: boolean;
  }) => {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)');

    const token = typeof data?.botToken === 'string' ? data.botToken.trim() : '';
    const chatId = typeof data?.chatId === 'string' ? data.chatId.trim() : '';

    if (token && !looksLikeBotToken(token)) {
      return { success: false, message: 'رمز البوت غير صالح - انسخه كاملاً من BotFather' };
    }
    if (chatId && !looksLikeChatId(chatId)) {
      return { success: false, message: 'معرّف المحادثة غير صالح - يجب أن يكون أرقاماً' };
    }

    const tx = db.transaction(() => {
      // An empty token means "leave the stored one alone": the screen never
      // receives the token back, so it cannot resend it, and treating blank as
      // a deletion would wipe the configuration every time the owner toggled
      // the switch.
      if (token) stmt.run('telegram_bot_token', token);
      if (chatId) stmt.run('telegram_chat_id', chatId);
      stmt.run('telegram_backup_enabled', data?.enabled ? '1' : '0');
    });
    tx();
    return { success: true, message: 'تم حفظ الإعدادات' };
  });

  /** Forget the credentials entirely. */
  ipcMain.handle('telegram:clearSettings', async () => {
    const db = getDb();
    db.prepare(
      "DELETE FROM settings WHERE Key IN ('telegram_bot_token','telegram_chat_id','telegram_backup_enabled')",
    ).run();
    return { success: true, message: 'تم حذف إعدادات تليجرام' };
  });

  ipcMain.handle('telegram:test', async (_event, data: { botToken?: string; chatId?: string }) => {
    const stored = telegramConfig();
    // Test what WILL be used: a token just typed on screen, or the stored one.
    const token = (typeof data?.botToken === 'string' && data.botToken.trim())
      ? data.botToken.trim() : stored.botToken;
    const chatId = (typeof data?.chatId === 'string' && data.chatId.trim())
      ? data.chatId.trim() : stored.chatId;
    return testTelegram({ botToken: token, chatId });
  });

  /**
   * Take a fresh backup and send it.
   *
   * The file is written with SQLite's own backup API, never `copyFileSync`: the
   * database runs in WAL mode, and a plain copy of a live WAL database can be
   * unreadable — an off-site backup that cannot be opened is worse than none,
   * because the shop believes it is protected.
   */
  ipcMain.handle('telegram:sendBackup', async () => {
    const cfg = telegramConfig();
    if (!cfg.botToken || !cfg.chatId) {
      return { success: false, message: 'أدخل إعدادات تليجرام أولاً' };
    }

    const db = getDb();
    const today = businessToday();
    const tmpPath = path.join(app.getPath('temp'), `mobile_shop_backup_${today}.db`);

    try {
      await db.backup(tmpPath);

      const shopRow = db.prepare("SELECT Value FROM settings WHERE Key = 'company_name'").get() as any;
      const shop = shopRow?.Value || 'المحل';
      const sizeMb = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(2);

      const result = await sendBackupToTelegram(
        { botToken: cfg.botToken, chatId: cfg.chatId },
        tmpPath,
        `💾 نسخة احتياطية\n🏪 ${shop}\n📅 ${today}\n📦 ${sizeMb} ميجابايت`,
      );

      if (result.success) {
        db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)')
          .run('telegram_last_backup', new Date().toISOString());
      }
      return result;
    } catch (err: any) {
      return { success: false, message: err?.message || 'فشل إنشاء النسخة' };
    } finally {
      // The temp copy is a full dump of the business; do not leave it lying in
      // the OS temp folder whether the upload worked or not.
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  });

  /**
   * Export every table, WITHOUT a licence.
   *
   * A shop's books belong to the shop, not to the software. Holding them
   * hostage behind an expired subscription is wrong commercially, corrosive to
   * trust, and in several jurisdictions unlawful — the owner still has tax
   * filings to make from data they entered themselves.
   *
   * The regular `db:exportAllCSV` sits behind `settings.edit`, which requires a
   * logged-in session, and the whole UI is replaced by the activation screen
   * once a licence lapses. So this channel exists to be reachable from that
   * screen. It is not an open door: the caller must still prove an
   * administrator password, the same blocklist hides password hashes and
   * credentials, and every export is written to the security log.
   */
  ipcMain.handle('db:exportForOwner', async (_event, data: { username?: unknown; password?: unknown }) => {
    const db = getDb();
    const username = String(data?.username ?? '').trim();
    const password = String(data?.password ?? '');
    if (!username || !password) {
      return { success: false, message: 'أدخل اسم المستخدم وكلمة المرور' };
    }

    // BRUTE FORCE.
    //
    // This channel is PUBLIC (it exists so the owner can get their data out
    // when they cannot log in) and it dumps the entire database. It compared
    // the password with no counter at all: measured at ~13 guesses/second,
    // unlimited. Throttling `auth:login` does not help here — this prompt is
    // a separate door with its own password field.
    //
    // Checked before the row is fetched and before bcrypt runs, so a locked
    // identity costs nothing to refuse and reveals nothing new.
    // Keyed by the username here because the row has not been read yet; once
    // it has, the USER ID is used, so this door shares an identity with the
    // password-reset and database-reset prompts. Both keys are registered on
    // failure, so a lockout follows the person rather than the field they
    // happened to type into.
    const locked = checkAttemptAllowed('dangerous', username);
    if (locked) {
      return { success: false, code: 'LOCKED_OUT', message: lockoutMessage(locked.lockedForSec) };
    }

    const user = db.prepare(
      'SELECT UserID, Username, PasswordHash, RoleID, IsActive FROM users WHERE Username = ?',
    ).get(username) as any;
    if (user) {
      const byId = checkAttemptAllowed('dangerous', `user:${user.UserID}`);
      if (byId) {
        return { success: false, code: 'LOCKED_OUT', message: lockoutMessage(byId.lockedForSec) };
      }
    }
    // One uniform message, and a dummy compare, so this cannot be used to
    // discover which usernames exist while the app is otherwise locked.
    if (!user || !user.IsActive) {
      bcrypt.compareSync(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO');
      // Counted even for an unknown username, or guessing names is never
      // slowed and the account that DOES exist is the one seen to lock.
      recordAttemptFailure('dangerous', username);
      return { success: false, message: 'بيانات الدخول غير صحيحة' };
    }
    if (!bcrypt.compareSync(password, user.PasswordHash)) {
      recordAttemptFailure('dangerous', username);
      recordAttemptFailure('dangerous', `user:${user.UserID}`);
      return { success: false, message: 'بيانات الدخول غير صحيحة' };
    }
    if (user.RoleID !== 1) {
      // A correct password on a non-admin account is still a failed attempt to
      // reach this operation; otherwise a cashier's own password is a free,
      // unlimited oracle for probing the rest.
      recordAttemptFailure('dangerous', username);
      recordAttemptFailure('dangerous', `user:${user.UserID}`);
      return { success: false, message: 'التصدير متاح لحساب المدير فقط' };
    }
    recordAttemptSuccess('dangerous', username);
    recordAttemptSuccess('dangerous', `user:${user.UserID}`);

    const result = await dialog.showOpenDialog({
      title: 'اختر مجلداً لحفظ بياناتك',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'تم الإلغاء' };
    }

    const folder = result.filePaths[0];
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as any[];

    let exported = 0;
    for (const table of tables) {
      const tableName = table.name as string;
      if (EXPORT_BLOCKLIST.has(tableName)) continue;   // never dump credentials
      const rows = db.prepare(`SELECT * FROM "${tableName}"`).all() as any[];
      if (rows.length === 0) continue;
      const headers = Object.keys(rows[0]);
      const lines: string[] = ['\uFEFF' + headers.join(',')];
      for (const row of rows) lines.push(headers.map(h => csvCell(row[h])).join(','));
      fs.writeFileSync(path.join(folder, `${tableName}.csv`), lines.join('\n'), 'utf-8');
      exported++;
    }

    recordSecurityEvent(db, 'data_export_owner', user.UserID, user.Username,
      `تصدير ${exported} جدول إلى ${folder}`);

    return { success: true, message: `تم تصدير ${exported} ملف إلى المجلد المختار`, exported };
  });

  // Get all table names for export
  ipcMain.handle('db:getTables', async () => {
    const db = getDb();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'
      ORDER BY name
    `).all() as any[];
    return tables.map(t => t.name).filter((n: string) => !EXPORT_BLOCKLIST.has(n));
  });
}
