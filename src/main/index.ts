import { app, BrowserWindow, dialog, shell } from 'electron';
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
import { registerRentPartyHandlers } from './ipc/rentParty.handlers';
import { registerFiscalYearHandlers } from './ipc/fiscalYear.handlers';
import { registerReportsHandlers } from './ipc/reports.handlers';
import { registerBackupHandlers } from './ipc/backup.handlers';
import { sendBackupToTelegram } from './backup/telegramBackup';
import { isDevelopmentLicenseKey } from './security/licenseCrypto';
import { isDevelopmentDevPassword } from './security/devAuth';
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
import { migrateWithSafetyNet, SchemaTooNewError } from './database/schemaVersion';
import { startUpdater } from './updater';
import { startCodeUpdater, applyStagedCode, markCodeBootOk } from './codeUpdate';
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

  /**
   * Nothing may navigate this window away from the application.
   *
   * Without this, anything that can set `location.href` — a cross-site
   * scripting bug, a pasted value that reaches an anchor, a compromised
   * dependency — replaces the whole app with a remote page that is still
   * inside Electron and still has `window.api` in front of it. The attacker
   * then calls every IPC channel the logged-in user is allowed to call.
   *
   * The renderer only ever loads its own bundle, so ANY navigation to a
   * different document is illegitimate and is refused.
   */
  const isInternal = (target: string): boolean => {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      // Dev server: same origin only. Vite's HMR reloads must keep working.
      try {
        return new URL(target).origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
      } catch { return false; }
    }
    // Packaged: the app is loaded from disk.
    return target.startsWith('file://');
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      console.error('[Security] blocked navigation to', url);
      event.preventDefault();
    }
  });

  /**
   * Popups.
   *
   * The print screens legitimately call `window.open('', '_blank')` and write
   * the receipt into the blank document, so popups cannot simply be denied —
   * that would silently stop every invoice from printing. A blank popup owns
   * no remote content and is allowed; anything with a real URL is not.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') return { action: 'allow' };
    // A genuine external link belongs in the user's browser, never in a
    // window that has the preload bridge attached.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    } else {
      console.error('[Security] blocked window.open for', url);
    }
    return { action: 'deny' };
  });

  /**
   * A renderer must never be granted a device permission.
   *
   * This is an offline till: it has no use for the camera, the microphone or
   * the user's location, so every request is refused rather than left to the
   * default, which prompts and can be accepted by an unattended machine.
   */
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(false);
  });

  /**
   * Refuse to attach a preload script the application did not ask for.
   *
   * Defence in depth: if anything ever manages to create a webview, this stops
   * it arriving with Node integration and its own preload.
   */
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    event.preventDefault();
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

/**
 * Refuse to run a PACKAGED build on the development credentials.
 *
 * The Ed25519 private key that matches the fallback public key is in this
 * repository's history, and the fallback developer password is publicly known.
 * Shipping on either means every customer can mint a perpetual licence or open
 * the developer console.
 *
 * Checked at start-up because "remember to change it before building" is not a
 * control — it is a hope. Development runs are unaffected, so nothing about
 * the daily workflow changes.
 */
function assertProductionKeys(): void {
  // In development the fallbacks are allowed, but SILENCE about them is not.
  //
  // Nothing in the startup log distinguished "my .env loaded" from "no .env,
  // quietly using the test key", so the only way to find out was to package a
  // build and watch it refuse to start. One line removes that whole class of
  // surprise, and names the variable to set.
  if (!app.isPackaged) {
    const usingDevLicence = isDevelopmentLicenseKey();
    const usingDevPassword = isDevelopmentDevPassword();
    if (usingDevLicence || usingDevPassword) {
      const which = [
        usingDevLicence ? 'licence key' : null,
        usingDevPassword ? 'developer password' : null,
      ].filter(Boolean).join(' and ');
      console.log(`[Config] development ${which} in use — set it in .env before packaging`);
    } else {
      console.log('[Config] production keys loaded from .env');
    }
    return;
  }

  const problems: string[] = [];
  if (isDevelopmentLicenseKey()) {
    problems.push('• مفتاح الترخيص ما زال مفتاح التطوير (MOBILESHOP_LICENSE_PUBLIC_KEY)');
  }
  if (isDevelopmentDevPassword()) {
    problems.push('• كلمة مرور المطور ما زالت الافتراضية (MOBILESHOP_DEV_PASSWORD_HASH)');
  }
  if (problems.length === 0) return;

  dialog.showErrorBox(
    'إعداد ناقص - لا يمكن تشغيل هذه النسخة',
    `هذه النسخة بُنيت بمفاتيح التطوير:\n\n${problems.join('\n')}\n\n`
    + 'ضع القيم الحقيقية في ملف .env ثم أعد البناء.\n'
    + 'انظر .env.example',
  );
  app.exit(1);
}

app.whenReady().then(() => {
  try {
    assertProductionKeys();
    console.log('[Main] Initializing database...');
    const db = getDb();

    // The upgrade is the most dangerous routine event in this product's life:
    // the shop's invoices exist in exactly one file. A snapshot is taken with
    // SQLite's backup API BEFORE the first migration statement and restored
    // automatically if anything throws — previously the only backup of the day
    // was taken AFTER migrating, so a bad migration left nothing to go back to.
    const upgrade = migrateWithSafetyNet(db, app.getPath('userData'), runMigrations, {
      onUpgradeStart: (from, to) =>
        console.log(`[Main] Upgrading database schema v${from} -> v${to} (snapshot first)`),
    });

    if (upgrade.error) {
      // The data has been put back. Tell the owner plainly and stop, rather
      // than running the app against a half-migrated database.
      const recovered = upgrade.restoredFrom
        ? 'تمت استعادة بياناتك كما كانت قبل التحديث.'
        : 'تعذرت الاستعادة التلقائية — لا تشغّل البرنامج وتواصل مع الدعم فوراً.';
      dialog.showErrorBox(
        'فشل تحديث قاعدة البيانات',
        `${recovered}\n\nنسخة ما قبل التحديث:\n${upgrade.snapshot ?? '—'}\n\nالتفاصيل: ${upgrade.error.message}`,
      );
      app.quit();
      return;
    }

    if (upgrade.upgraded) {
      console.log(`[Main] Schema upgraded to v${upgrade.to}; snapshot at ${upgrade.snapshot}`);
    }
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
    registerRentPartyHandlers();
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

    // Automatic updates. Started last and entirely fail-safe: a shop with no
    // internet must be able to trade all day without ever seeing a message
    // about it. The first check is minutes away so start-up is not slowed.
    startUpdater();

    // Fast-lane code updates (app.asar swap). Started AFTER the full updater:
    // both feeds run, but a staged code push is preferred on the next restart
    // for the same reason the line above exists — a quiet, small swap.
    startCodeUpdater();

    // A staged swap helper waits for this flag before keeping the new build.
    // Written only now: the database migration and every fatal startup step
    // above already succeeded, so a fresh boot has PROVEN itself.
    markCodeBootOk();

    // Daily check-in with the developer's server. Deliberately started AFTER
    // the window exists and is fully fail-safe: no network, no effect.
    startHeartbeat(currentDeviceId, currentLicenseSummary);
  } catch (err) {
    // A database written by a NEWER build must not be opened read-write by an
    // older one: this build would happily write rows missing whatever the
    // newer schema added, and nobody would notice until a report disagreed.
    // Measured before this guard existed — the old build wrote successfully.
    if (err instanceof SchemaTooNewError) {
      console.error('[Main] Refusing to open a newer database:', err.message);
      dialog.showErrorBox('البرنامج أقدم من قاعدة البيانات', err.message);
      app.quit();
      return;
    }
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

  // A staged fast-lane code push is swapped by a DETACHED helper that outlives
  // this process, so it must be armed here, at the very end, where nothing can
  // cancel it. The helper renames app.asar -> app.asar.bak, moves the staged
  // copy in, relaunches, and restores the backup if the new build fails to
  // boot — see codeUpdate.ts.
  applyStagedCode();
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

    // Off-site copy, once a day, only if the shop switched it on.
    //
    // Runs AFTER the local backup is safely on disk and is wrapped separately:
    // Telegram being unreachable, rate-limiting us or rejecting an oversized
    // file must never stop the local backup that already succeeded.
    void sendDailyTelegramBackup(backupPath, today);
  } catch (err) {
    console.error('[Main] Auto-backup failed:', err);
  }
}

/**
 * Sends the day's backup to the owner's Telegram bot, at most once per day.
 *
 * The "already sent today" marker is stored in settings rather than inferred
 * from the file, because `autoBackup()` runs hourly: without it the shop would
 * receive the same database twenty-four times a day and start ignoring it.
 */
async function sendDailyTelegramBackup(backupPath: string, today: string) {
  try {
    const db = getDb();
    const get = (key: string): string => {
      const row = db.prepare('SELECT Value FROM settings WHERE Key = ?').get(key) as any;
      return row?.Value ?? '';
    };

    if (get('telegram_backup_enabled') !== '1') return;
    if (get('telegram_daily_sent') === today) return;

    const botToken = get('telegram_bot_token');
    const chatId = get('telegram_chat_id');
    if (!botToken || !chatId) return;
    if (!fs.existsSync(backupPath)) return;

    const shop = get('company_name') || 'المحل';
    const sizeMb = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(2);
    const result = await sendBackupToTelegram(
      { botToken, chatId },
      backupPath,
      `💾 نسخة احتياطية تلقائية\n🏪 ${shop}\n📅 ${today}\n📦 ${sizeMb} ميجابايت`,
    );

    // Mark the day as done only on success, so a failure retries next hour
    // instead of silently skipping until tomorrow.
    if (result.success) {
      db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)')
        .run('telegram_daily_sent', today);
      db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)')
        .run('telegram_last_backup', new Date().toISOString());
      console.log('[Main] Telegram backup sent');
    } else {
      console.error('[Main] Telegram backup failed:', result.message);
    }
  } catch (err) {
    console.error('[Main] Telegram backup error:', err);
  }
}
