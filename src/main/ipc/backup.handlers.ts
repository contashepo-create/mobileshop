import { ipcMain, dialog, app } from 'electron';
import { getDb, closeDb } from '../database/connection';
import path from 'node:path';
import fs from 'node:fs';

export function registerBackupHandlers() {
  // Manual backup
  ipcMain.handle('backup:create', async () => {
    const db = getDb();
    const dbPath = db.name;

    const result = await dialog.showSaveDialog({
      title: 'حفظ نسخة احتياطية',
      defaultPath: `mobile_shop_backup_${new Date().toISOString().split('T')[0]}.db`,
      filters: [{ name: 'Database', extensions: ['db'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, message: 'تم الإلغاء' };
    }

    try {
      // Copy the database file directly
      fs.copyFileSync(dbPath, result.filePath);
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
    const dbPath = path.join(app.getPath('userData'), 'mobile_shop.db');

    try {
      closeDb();

      // Copy backup file over current DB
      fs.copyFileSync(backupPath, dbPath);

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
