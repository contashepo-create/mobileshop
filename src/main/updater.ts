/**
 * Automatic updates — NSIS (electron-updater).
 *
 * WHY electron-updater AND NOT autoUpdater
 * ----------------------------------------
 * `electron-autoUpdater` is Squirrel-only. This product builds a traditional
 * NSIS installer (electron-builder), which produces `latest.yml` + a
 * differential `.blockmap`. `electron-updater` reads `latest.yml`, downloads
 * the new installer and applies it — the mechanism behind VS Code, Slack and
 * most Windows desktop products.
 *
 * HOW IT BEHAVES
 * --------------
 * Deliberately quiet. The shop is mid-sale; an update must never interrupt.
 *
 *   1. some minutes after start-up, ask the update server whether a newer
 *      build exists;
 *   2. if so, download it in the background — the app keeps working;
 *   3. when it is ready, tell the owner ONCE and let them choose when;
 *   4. the new build is applied on the next restart, and the database upgrade
 *      then runs behind the safety net in `schemaVersion.ts`.
 *
 * FAILURE IS ALWAYS SILENT
 * ------------------------
 * No internet, a firewall, a proxy, the server being down — none of it may
 * produce an error dialog. A shop in a village must be able to trade all day
 * without seeing an update message.
 */
import { app, dialog, BrowserWindow, ipcMain, webContents } from 'electron';
import electronUpdater from 'electron-updater';
import { getDeviceId } from './security/deviceId';
import { checkForCodeUpdatesNow, applyStagedCode, isCodeUpdateStaged } from './codeUpdate';

/** Base URL of the developer's Cloudflare Worker (licensed updates). */
const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

/** Wait before the first check so start-up is never slowed by the network. */
const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;

/** How often to look afterwards. Hourly is pointless; a shop restarts daily. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let notified = false;
let downloaded = false;
let downloadPercent = 0;

/** Set by `startUpdater`; provides the instance drive by the UI helpers. */
let updaterInstance: typeof electronUpdater.autoUpdater | null = null;

/** Broadcasts an update-state change to every renderer window. */
function broadcast(state: Record<string, unknown>): void {
  for (const wc of webContents.getAllWebContents()) {
    wc.send('updater:status', state);
  }
}

/** Manually trigger a check from the About screen. */
export function checkForUpdatesNow(): Promise<{ ok: boolean; message?: string }> {
  // Fast lane first: a small code push is the normal case and is independent
  // of the NSIS channel. 204 / no manifest is a non-event.
  void checkForCodeUpdatesNow();
  if (!app.isPackaged || process.platform !== 'win32' || !updaterInstance) {
    return Promise.resolve({ ok: false, message: 'التحديث التلقائي غير متاح في هذا الإصدار' });
  }
  try {
    // A click is an explicit request: force a re-check even if one is running.
    updaterInstance.checkForUpdates().catch((err: unknown) => {
      broadcast({ state: 'error', message: (err as Error)?.message ?? 'فشل الاتصال بخادم التحديثات' });
    });
    broadcast({ state: 'checking' });
    return Promise.resolve({ ok: true });
  } catch (err) {
    return Promise.resolve({ ok: false, message: (err as Error).message });
  }
}

/**
 * The only place this app installs a downloaded update. It runs only when the
 * owner chose to: either the download dialog's "restart now" (response 0) or
 * the About screen's explicit restart button, which funnels here too. Keeping
 * the literal call in one guarded spot makes "never without asking" a fact.
 */
function applyOwnerChoice(choice: { response: number }): void {
  if (choice.response === 0) {
    // If a code push is staged, launch the external swap helper (Task Scheduler)
    // and quit. The helper waits for this process to exit, then swaps app.asar
    // and relaunches.
    if (applyStagedCode()) {
      setTimeout(() => app.quit(), 1500);
      return;
    }
    if (downloaded && updaterInstance) updaterInstance.quitAndInstall();
  }
}

/** Restart and install the already-downloaded update (About-screen button). */
export function quitAndInstallNow(): { ok: boolean } {
  // If a fast-lane code push is staged, launch the external swap helper
  // and quit. The helper handles everything: swap, relaunch, rollback.
  if (applyStagedCode()) {
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  }
  if (downloaded && updaterInstance) {
    // The owner clicked "restart now": the same explicit answer as the dialog.
    applyOwnerChoice({ response: 0 });
    return { ok: true };
  }
  return { ok: false };
}

/** Registers the IPC channels the About screen uses to drive the updater. */
export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:check', () => checkForUpdatesNow());
  ipcMain.handle('updater:updateNow', () => quitAndInstallNow());
  ipcMain.handle('updater:getStatus', () => ({
    state: downloaded ? 'downloaded' : (downloadPercent > 0 && downloadPercent < 100 ? 'downloading' : 'idle'),
    percent: downloadPercent,
  }));
}

/**
 * Starts the update checker over the same Cloudflare Worker + R2 the licence
 * system already uses. The Worker serves a `latest.yml` that mirrors the
 * client key + device id gating used by the Squirrel endpoints (kept so older
 * installs can still be told "you need the newer installer").
 *
 * The check runs silently in the background (the shop is mid-sale), and the
 * About screen can also trigger a manual check via `updater:check`.
 */
export function startUpdater(): void {
  if (!app.isPackaged) {
    console.log('[Updater] development build — automatic updates disabled');
    return;
  }
  if (process.platform !== 'win32') {
    console.log(`[Updater] ${process.platform} is not configured for auto-update`);
    return;
  }
  if (!API_BASE || !CLIENT_KEY) {
    console.log('[Updater] no update server configured — automatic updates disabled');
    return;
  }

  let device = '';
  try { device = getDeviceId(); } catch { /* server allows unknown devices */ }

  const autoUpdater = electronUpdater.autoUpdater;
  updaterInstance = autoUpdater;
  try {
    // feedURL needs to be a directory that electron-updater appends
    // "latest.yml" / "<file>.blockmap" to. Query string carries the device id.
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${API_BASE}/update-nsis/win32-x64/${app.getVersion()}`
        + (device ? `?device=${encodeURIComponent(device)}` : ''),
    });
    autoUpdater.requestHeaders = { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' };
  } catch (err) {
    console.log('[Updater] could not configure:', (err as Error).message);
    return;
  }

  autoUpdater.on('error', (err) => {
    // Never a dialog. No internet is the normal state for many shops.
    // The renderer gets a fixed sentence — a raw err.message carries paths
    // and server internals that belong in the developer's log, not the UI.
    console.log('[Updater] check failed (not an error for the user):', err?.message ?? err);
    // Do NOT override a successful code-update staging with an NSIS error.
    // The NSIS feed returns 204 when the app is newer than the last full
    // release (e.g. after a code push), which electron-updater may treat as
    // an error. If a code update is already staged, that is the real state.
    if (isCodeUpdateStaged()) {
      broadcast({ state: 'downloaded' });
    } else {
      broadcast({ state: 'error', message: 'تعذر الاتصال بخادم التحديثات' });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] NSIS: already up to date');
    // Do NOT override a staged code update. When the app version is higher
    // than the NSIS release (e.g. v1.0.25 code on v1.0.10 shell), the NSIS
    // feed correctly says "no NSIS update" — but the code updater may have
    // already staged a fast-lane push. Saying "up to date" here would
    // override the "downloaded" state and confuse the user.
    if (isCodeUpdateStaged()) {
      broadcast({ state: 'downloaded' });
    } else {
      broadcast({ state: 'uptodate' });
    }
  });

  autoUpdater.on('update-available', () => {
    console.log('[Updater] a newer version is downloading in the background');
    broadcast({ state: 'downloading', percent: 0 });
  });

  autoUpdater.on('download-progress', (progress) => {
    downloadPercent = Math.round(progress.percent);
    broadcast({ state: 'downloading', percent: downloadPercent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    console.log('[Updater] a newer version is ready and will install on restart');
    broadcast({ state: 'downloaded', version: info?.version });
    if (notified) return;         // tell them once, not every six hours
    notified = true;

    const win = BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'info' as const,
      buttons: ['إعادة التشغيل الآن', 'لاحقاً'],
      defaultId: 1,               // "later" is the safe default
      cancelId: 1,
      title: 'تحديث جديد جاهز',
      message: 'تم تنزيل تحديث جديد.',
      detail:
        'سيتم تطبيق التحديث عند إعادة تشغيل البرنامج.\n\n'
        + 'بياناتك آمنة: يأخذ البرنامج نسخة احتياطية كاملة قبل أي تحديث '
        + 'لقاعدة البيانات، ويستعيدها تلقائياً إذا حدث أي خطأ.\n\n'
        + 'يمكنك المتابعة الآن وإعادة التشغيل في أي وقت يناسبك.',
    };

    const handle = (result: { response: number }) => {
      applyOwnerChoice(result);
    };

    if (win) dialog.showMessageBox(win, options).then(handle);
    else dialog.showMessageBox(options).then(handle);
  });

  const check = () => {
    try { autoUpdater.checkForUpdates(); } catch { /* offline: ignore */ }
  };

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
  registerUpdaterIpc();
  console.log(`[Updater] scheduled (first check in ${FIRST_CHECK_DELAY_MS / 60000} minutes)`);
}