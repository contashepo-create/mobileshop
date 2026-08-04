/**
 * Automatic updates.
 *
 * WHY THIS EXISTS
 * ---------------
 * Once the .exe is on a shop's counter, there is no other way to reach it. A
 * security fix, a corrected calculation, a new feature — none of it helps
 * anyone unless it can travel to the machines that are actually running.
 *
 * Asking the owner to download and reinstall does not work in practice: some
 * will not, some will install the wrong file, and the ones who most need a fix
 * are the least likely to apply it. Every serious desktop product therefore
 * updates itself — VS Code, Slack, Discord and WhatsApp Desktop all use this
 * exact mechanism on Windows (Squirrel), and this project already builds with
 * `MakerSquirrel`, so the packaging half is done.
 *
 * HOW IT BEHAVES
 * --------------
 * Deliberately quiet. The shop is mid-sale; an update must never interrupt.
 *
 *   1. some minutes after start-up, ask GitHub whether a newer release exists;
 *   2. if so, download it in the background — the app keeps working normally;
 *   3. when it is ready, tell the owner ONCE and let them choose when;
 *   4. the new version is applied on the next restart, and the database
 *      upgrade then runs behind the safety net in `schemaVersion.ts`.
 *
 * WHY NOT INSTALL IMMEDIATELY
 * ---------------------------
 * `autoUpdater.quitAndInstall()` would close the application. Doing that on a
 * machine with a half-finished invoice on screen loses that invoice. The
 * customer decides; the software never decides for them.
 *
 * FAILURE IS ALWAYS SILENT
 * ------------------------
 * No internet, a firewall, a corporate proxy, GitHub being down — none of it
 * may produce an error dialog. A shop in a village with intermittent internet
 * must be able to trade all day without ever seeing an update message. The
 * licence system already follows this rule; so does this.
 */
import { app, dialog, BrowserWindow } from 'electron';
import { getDeviceId } from './security/deviceId';

/**
 * Where releases are published.
 *
 * NOT `update.electronjs.org`. That free service requires a PUBLIC GitHub
 * repository, and this is a commercial product — a public repository is a
 * repository anyone can clone, build and give away. The feed is therefore
 * served by the same Cloudflare Worker that already runs the licensing API
 * and the Telegram bot, behind the same client key.
 *
 * Both values come from the environment, exactly as the heartbeat's do, so a
 * build with no configuration simply does not check for updates instead of
 * pointing at somebody else's server.
 */
const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

/** Wait before the first check so start-up is never slowed by the network. */
const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;

/** How often to look afterwards. Hourly is pointless; a shop restarts daily. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let notified = false;

/**
 * Starts the update checker.
 *
 * Safe to call unconditionally: it disables itself in development and when the
 * application is not packaged, because an unpackaged build has no installer to
 * replace and Squirrel would throw.
 */
export function startUpdater(): void {
  // `app.isPackaged` is false under `electron-forge start`. Checking for
  // updates there would replace the developer's working copy.
  if (!app.isPackaged) {
    console.log('[Updater] development build — automatic updates disabled');
    return;
  }

  // Squirrel is Windows-only in this project's packaging. macOS would need a
  // signed build; Linux uses its own package managers.
  if (process.platform !== 'win32') {
    console.log(`[Updater] ${process.platform} is not configured for auto-update`);
    return;
  }

  let autoUpdater: Electron.AutoUpdater;
  try {
    // Imported lazily so a build without the module still starts.
    ({ autoUpdater } = require('electron') as typeof Electron);
  } catch {
    console.log('[Updater] autoUpdater unavailable');
    return;
  }

  // An unconfigured build must not check anywhere. Silent, because a shop
  // running a build without cloud settings is a normal state, not a fault.
  if (!API_BASE || !CLIENT_KEY) {
    console.log('[Updater] no update server configured — automatic updates disabled');
    return;
  }

  // The device id lets the server withhold new versions from a lapsed
  // subscription. It is the same identifier the heartbeat already sends, and
  // it is not a secret: it identifies the install, it does not authorise it.
  let device = '';
  try { device = getDeviceId(); } catch { /* not fatal — the server allows unknown devices */ }

  // Squirrel appends "/RELEASES" to this and then fetches the .nupkg named
  // there relative to the same directory, so the feed must be the DIRECTORY,
  // never a file.
  const feed = `${API_BASE}/update/win32-${process.arch}/${app.getVersion()}`
    + (device ? `?device=${encodeURIComponent(device)}` : '');

  try {
    autoUpdater.setFeedURL({
      url: feed,
      // Sent on the /RELEASES request AND on the .nupkg download, which is
      // why the package endpoint can require it too — otherwise the binary
      // would be downloadable by anyone who guessed the filename.
      headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    console.log('[Updater] could not set feed:', (err as Error).message);
    return;
  }

  autoUpdater.on('error', (err) => {
    // Never a dialog. No internet is the normal state for many shops.
    console.log('[Updater] check failed (this is not an error for the user):', err?.message);
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] checking…');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] already up to date');
  });

  autoUpdater.on('update-available', () => {
    console.log('[Updater] a newer version is downloading in the background');
  });

  autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
    console.log(`[Updater] ${releaseName} is ready and will install on restart`);
    if (notified) return;         // tell them once, not every six hours
    notified = true;

    const win = BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'info' as const,
      buttons: ['إعادة التشغيل الآن', 'لاحقاً'],
      defaultId: 1,               // "later" is the safe default
      cancelId: 1,
      title: 'تحديث جديد جاهز',
      message: `تم تنزيل تحديث جديد${releaseName ? ` (${releaseName})` : ''}.`,
      detail:
        'سيتم تطبيق التحديث عند إعادة تشغيل البرنامج.\n\n'
        + 'بياناتك آمنة: يأخذ البرنامج نسخة احتياطية كاملة قبل أي تحديث '
        + 'لقاعدة البيانات، ويستعيدها تلقائياً إذا حدث أي خطأ.\n\n'
        + 'يمكنك المتابعة الآن وإعادة التشغيل في أي وقت يناسبك.',
    };

    const handle = (result: { response: number }) => {
      if (result.response === 0) {
        // The renderer may be holding an unsaved form; the owner chose this.
        autoUpdater.quitAndInstall();
      }
    };

    if (win) dialog.showMessageBox(win, options).then(handle);
    else dialog.showMessageBox(options).then(handle);
  });

  const check = () => {
    try { autoUpdater.checkForUpdates(); } catch { /* offline: ignore */ }
  };

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
  console.log(`[Updater] scheduled (first check in ${FIRST_CHECK_DELAY_MS / 60000} minutes)`);
}
