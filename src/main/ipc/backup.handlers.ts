import { ipcMain, dialog, app } from 'electron';
import { getDb, closeDb, getDbPath } from '../database/connection';
import { safeFailure } from '../security/errorResponse';
import path from 'node:path';
import fs from 'node:fs';
import { businessToday } from '../../shared/businessDate';

/**
 * Opens a database file read-only and asks SQLite whether it is intact.
 *
 * Read-only and in its own connection, so a damaged file can never touch the
 * live one and nothing is written to the candidate — a backup that the act of
 * checking modified would no longer be the backup that was taken.
 *
 * The driver is required lazily. This module is imported by the offline
 * verifiers, and a static import would pull the native binding into processes
 * that have no database at all.
 */
async function verifyDatabaseFile(file: string): Promise<{ ok: boolean; reason: string }> {
  interface Probe {
    pragma: (s: string) => unknown;
    prepare: (s: string) => { get: (...a: unknown[]) => unknown };
    close: () => void;
  }
  let probe: Probe | null = null;
  try {
    const { default: Database } = await import('better-sqlite3');
    probe = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Probe;

    const result = probe.pragma('integrity_check');
    const rows = Array.isArray(result) ? result : [result];
    const first = rows[0] as { integrity_check?: string } | string | undefined;
    const verdict = typeof first === 'string' ? first : first?.integrity_check;
    if (verdict !== 'ok') {
      return { ok: false, reason: String(verdict ?? 'فحص السلامة فشل').slice(0, 120) };
    }

    // A file can be structurally perfect and still not be THIS application's
    // database — an unrelated SQLite file would restore "successfully" and
    // leave the shop staring at an empty program.
    //
    // `prepare`, NOT `pragma`. The first version of this check used
    // `pragma("SELECT ...")`, which better-sqlite3 wraps as `PRAGMA SELECT ...`
    // — a syntax error. It failed CLOSED, so it looked harmless, but a valid
    // backup was reported as `near "SELECT": syntax error` and the shop would
    // have been refused its own restore. Measured before it shipped.
    const row = probe.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sales','purchases','customers','items')",
    ).get() as { n?: number } | undefined;
    if ((row?.n ?? 0) < 4) {
      return { ok: false, reason: 'الملف قاعدة بيانات سليمة لكنها ليست قاعدة بيانات هذا البرنامج' };
    }

    return { ok: true, reason: '' };
  } catch (err: unknown) {
    // `SQLITE_CORRUPT: database disk image is malformed` arrives here.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message.slice(0, 120) };
  } finally {
    try { probe?.close(); } catch { /* already closed */ }
  }
}

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
      // MEASURED before this: a failed backup returned
      // "EACCES: permission denied, open '/proc/1/mem'" — the errno and the
      // absolute path, straight into a toast.
      return safeFailure('backup:create', err, 'تعذّر حفظ النسخة الاحتياطية');
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

      // ...and that it is READABLE, not merely SQLite-shaped.
      //
      // The header is the first sixteen bytes. It says nothing about the
      // 143,000 that follow. MEASURED: a database whose leaf pages were
      // overwritten still began with "SQLite format 3", passed the check
      // above, and then failed on first use with
      // `SQLITE_CORRUPT: database disk image is malformed`.
      //
      // That is the worst possible moment to find out. By then the restore has
      // already overwritten the live database — the shop has traded the books
      // it had for a file that cannot be opened, and the only copy of the
      // original is the `.before-restore` file, which nothing in the interface
      // offers to put back.
      //
      // `integrity_check` walks every page and every index. It costs a second
      // on a shop-sized database and it is the difference between refusing a
      // bad backup and destroying a good one. `quick_check` was considered and
      // rejected: it skips index verification, and a corrupt index is exactly
      // the failure that shows up later as a wrong total rather than an error.
      const probe = await verifyDatabaseFile(backupPath);
      if (!probe.ok) {
        return {
          success: false,
          message: `النسخة الاحتياطية تالفة ولم يتم استخدامها - قاعدة البيانات الحالية سليمة (${probe.reason})`,
        };
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
      // MEASURED: restoring a missing file returned
      // "ENOENT: no such file or directory, open '/home/user/.../x.db'".
      return safeFailure('backup:restore', err, 'تعذّرت استعادة النسخة الاحتياطية');
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
