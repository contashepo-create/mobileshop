import { ipcMain, dialog, app } from 'electron';
import { getDb, closeDb, getDbPath } from '../database/connection';
import path from 'node:path';
import fs from 'node:fs';
import { businessToday } from '../../shared/businessDate';

export function registerBackupHandlers() {
  // Manual backup
  ipcMain.handle('backup:create', async () => {
    const db = getDb();
    const dbPath = db.name;

    const result = await dialog.showSaveDialog({
      title: 'حفظ نسخة احتياطية',
      defaultPath: `mobile_shop_backup_${businessToday()}.db`,
      filters: [{ name: 'Database', extensions: ['db'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, message: 'تم الإلغاء' };
    }

    try {
      // Use SQLite's own backup API. The database runs in WAL mode, so a plain
      // file copy can miss everything still sitting in the -wal file and
      // produce a silently truncated/corrupt backup.
      await db.backup(result.filePath);
      return { success: true, path: result.filePath };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Restore from backup
  ipcMain.handle('backup:restore', async () => {
    const result = await dialog.showOpenDialog({
      title: 'استعادة من نسخة احتياطية',
      filters: [{ name: 'Database', extensions: ['db'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'تم الإلغاء' };
    }

    const backupPath = result.filePaths[0];
    // Restore over the ACTIVE database, which may be a custom/network path.
    // Hardcoding userData/mobile_shop.db meant the restore appeared to succeed
    // while the app kept reading the old database.
    const dbPath = getDbPath();

    try {
      // Sanity-check the chosen file really is a SQLite database.
      const header = Buffer.alloc(16);
      const fd = fs.openSync(backupPath, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
        return { success: false, message: 'الملف المختار ليس قاعدة بيانات صالحة' };
      }

      closeDb();

      // Keep a rollback copy of the current database before overwriting it.
      if (fs.existsSync(dbPath)) {
        try { fs.copyFileSync(dbPath, `${dbPath}.before-restore`); } catch { /* best effort */ }
      }

      fs.copyFileSync(backupPath, dbPath);
      // Stale WAL/SHM belonging to the replaced database must go, otherwise
      // SQLite may replay them on top of the restored file.
      for (const suffix of ['-wal', '-shm']) {
        const p = `${dbPath}${suffix}`;
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      }

      return { success: true, message: 'تمت الاستعادة - يرجى إعادة تشغيل التطبيق' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Get DB info
  ipcMain.handle('backup:info', async () => {
    const db = getDb();
    const dbPath = db.name;
    let size = 0;
    try {
      const stats = fs.statSync(dbPath);
      size = stats.size;
    } catch {}
    return {
      path: dbPath,
      size: size,
      sizeFormatted: size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${(size / 1024).toFixed(2)} KB`,
    };
  });
}
