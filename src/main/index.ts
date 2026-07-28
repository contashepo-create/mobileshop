import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb } from './database/connection';
import { registerAuthHandlers } from './ipc/auth.handlers';
import { registerNotesHandlers } from './ipc/notes.handlers';
import { registerSettingsHandlers } from './ipc/settings.handlers';
import { registerHrHandlers } from './ipc/hr.handlers';
import { registerAssetsHandlers } from './ipc/assets.handlers';
import { registerUsersHandlers } from './ipc/users.handlers';
import { registerInventoryHandlers } from './ipc/inventory.handlers';
import { registerSalesHandlers } from './ipc/sales.handlers';
import { registerPurchasesHandlers } from './ipc/purchases.handlers';
import { registerMaintenanceHandlers } from './ipc/maintenance.handlers';
import { registerVouchersHandlers } from './ipc/vouchers.handlers';
import { registerPayrollHandlers } from './ipc/payroll.handlers';
import { registerRentHandlers } from './ipc/rent.handlers';
import { registerFiscalYearHandlers } from './ipc/fiscalYear.handlers';
import { registerReportsHandlers } from './ipc/reports.handlers';
import { registerBackupHandlers } from './ipc/backup.handlers';
import { registerOpeningBalanceHandlers } from './ipc/openingBalance.handlers';
import { registerStatementHandlers, registerCustomerStatementHandlers } from './ipc/statement.handlers';
import { registerDatabaseHandlers } from './ipc/database.handlers';
import { registerSettlementHandlers } from './ipc/settlement.handlers';
import { registerPrintHandlers } from './ipc/print.handlers';
import { registerServicesHandlers } from './ipc/services.handlers';
import { registerLicenseHandlers } from './ipc/license.handlers';
import { registerSmartNotificationsHandlers } from './ipc/notifications.handlers';
import { registerTransfersHandlers } from './ipc/transfers.handlers';
import { registerDeleteHandlers } from './ipc/delete.handlers';
import { runMigrations } from './database/migrations';
import { installIpcGuard } from './security/ipcGuard';
import { registerRemoteHandlers } from './ipc/remote.handlers';
import { startHeartbeat } from './remote/heartbeat';
import { ensureRemoteTables } from './remote/remoteStore';
import { businessToday } from '../shared/businessDate';

/**
 * Device id and licence summary for the heartbeat, resolved lazily so this
 * module does not import the licence handler at load time.
 */
function currentDeviceId(): string {
  try {
    const p = path.join(app.getPath('userData'), 'device.id');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function currentLicenseSummary(): { status?: string; expiry?: string | null } {
  try {
    const db = getDb();
    const row = db.prepare("SELECT Value FROM remote_state WHERE Key = 'license_summary'").get() as any;
    if (row?.Value) return JSON.parse(row.Value);
  } catch { /* fall through */ }
  return { status: 'unknown', expiry: null };
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'نظام إدارة محلات الموبايلات والصيانة',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  // Log renderer console errors
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[Renderer Error] ${message} (line ${line}, source: ${sourceId})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(`[Load Failed] ${errorCode} ${errorDescription} URL: ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Renderer Crashed]', details.reason);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(() => {
  try {
    console.log('[Main] Initializing database...');
    const db = getDb();
    runMigrations(db);
    console.log('[Main] Database ready');

    // Must run BEFORE any handler is registered: it patches ipcMain.handle so
    // every channel is authentication/permission checked and the caller's real
    // user id is stamped onto payloads.
    installIpcGuard();
    console.log('[Main] IPC guard installed');

    console.log('[Main] Registering IPC handlers...');
    registerAuthHandlers();
    registerNotesHandlers();
    registerSettingsHandlers();
    registerHrHandlers();
    registerAssetsHandlers();
    registerUsersHandlers();
    registerInventoryHandlers();
    registerSalesHandlers();
    registerPurchasesHandlers();
    registerMaintenanceHandlers();
    registerVouchersHandlers();
    registerPayrollHandlers();
    registerRentHandlers();
    registerFiscalYearHandlers();
    registerReportsHandlers();
    registerBackupHandlers();
    registerOpeningBalanceHandlers();
    registerStatementHandlers();
    registerCustomerStatementHandlers();
    registerDatabaseHandlers();
  registerSettlementHandlers();
  registerPrintHandlers();
  registerServicesHandlers();
  registerLicenseHandlers();
  registerSmartNotificationsHandlers();
  registerTransfersHandlers();
  registerDeleteHandlers();

    // Remote management: presentation values, developer messages, sync status.
    ensureRemoteTables();
    registerRemoteHandlers(currentDeviceId, currentLicenseSummary);
    console.log('[Main] All handlers registered');

    createWindow();
    console.log('[Main] Window created');

    // === AUTO BACKUP SYSTEM ===
    // 1. Daily backup on startup
    void autoBackup();
    // 2. Periodic backup every hour
    setInterval(() => { void autoBackup(); }, 60 * 60 * 1000);
    console.log('[Main] Auto-backup scheduled (every 1 hour)');

    // Daily check-in with the developer's server. Deliberately started AFTER
    // the window exists and is fully fail-safe: no network, no effect.
    startHeartbeat(currentDeviceId, currentLicenseSummary);
  } catch (err) {
    console.error('[Main] STARTUP ERROR:', err);
    dialog.showErrorBox('خطأ في التشغيل', `${err}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // Do NOT start an async backup here — the process may exit before it
  // finishes and leave a half-written file. Checkpoint the WAL into the main
  // database instead, so the on-disk file is complete for the next startup
  // backup (and for any external copy of the .db).
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('[Main] WAL checkpoint failed:', err);
  }
  closeDb();
});

// Auto backup function - saves to userData/backups
async function autoBackup() {
  try {
    const db = getDb();
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    // Local day: the daily backup should be named for the day the shop just
    // worked, not for a UTC day that ends at 02:00 Cairo time.
    const today = businessToday();
    const backupPath = path.join(backupDir, `auto_backup_${today}.db`);
    // Only create if today's backup doesn't exist
    if (!fs.existsSync(backupPath)) {
      // SQLite backup API — the DB is in WAL mode, so copyFileSync can capture
      // a partial state that is missing everything still in the -wal file.
      await db.backup(backupPath);
      console.log(`[Main] Auto-backup created: ${backupPath}`);
    }

    // Clean old backups (keep last 7 days).
    // Only files this function created are eligible — the previous version
    // deleted EVERY entry older than 7 days in the folder, including unrelated
    // files a user may have stored there, and threw on sub-directories.
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    for (const file of fs.readdirSync(backupDir)) {
      if (!/^auto_backup_\d{4}-\d{2}-\d{2}\.db$/.test(file)) continue;
      const filePath = path.join(backupDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`[Main] Old backup removed: ${file}`);
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch (err) {
    console.error('[Main] Auto-backup failed:', err);
  }
}
