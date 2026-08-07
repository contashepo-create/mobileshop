import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import {
  ensureRemoteTables, listRemoteMessages, listUnreadMessages, markMessageRead,
  getRemoteOverrides, getRemoteState, setRemoteState,
} from '../remote/remoteStore';
import { lastSyncInfo, runHeartbeat } from '../remote/heartbeat';
import { REMOTE_MANAGED_KEYS } from '../remote/remoteConfig';
import {
  evaluateOfflineNotice, evaluateExpiryNotice, OFFLINE_REMINDER_DAYS,
} from '../remote/notices';

/**
 * Renderer-facing surface for the remote-management feature.
 *
 * Everything here is read-only from the customer's point of view except
 * `remote:markRead` (a local acknowledgement). There is deliberately no
 * telemetry on/off: the check-in is mandatory whenever a server is configured
 * (see heartbeat.ts), so the developer can reach every install with updates,
 * messages and renewed branding. The server can never be asked to do anything
 * from this side.
 */
export function registerRemoteHandlers(
  getDeviceId: () => string,
  getLicense: () => { status?: string; expiry?: string | null },
) {
  ipcMain.handle('remote:messages', async () => {
    ensureRemoteTables();
    return listRemoteMessages();
  });

  ipcMain.handle('remote:markRead', async (_event, messageId: number) => {
    if (typeof messageId !== 'number') return { success: false };
    markMessageRead(messageId);
    return { success: true };
  });

  /**
   * Everything the app should pop up right now, in one call.
   *
   * Returned as data rather than pushed from the main process: the renderer
   * owns the dialog, so it can queue them, style them, and respect whatever
   * screen the user is on. The main process never forces a window open.
   *
   * Ordering is by urgency — an expiring subscription is shown before a
   * general notice, because it is the only one with a deadline.
   */
  ipcMain.handle('remote:pendingNotices', async () => {
    ensureRemoteTables();
    const now = new Date();
    const sync = lastSyncInfo();
    const license = getLicense();

    const expiry = evaluateExpiryNotice({
      now,
      status: license?.status,
      expiry: license?.expiry ?? null,
      lastShown: getRemoteState('expiry_notice_shown'),
    });

    const offline = evaluateOfflineNotice({
      now,
      lastSync: sync.lastSync,
      installedAt: getRemoteState('installed_at'),
      lastShown: getRemoteState('offline_notice_shown'),
      remoteEnabled: sync.enabled,
    });

    return {
      messages: listUnreadMessages(),
      expiry: expiry.show ? expiry : null,
      offline: offline.show ? { ...offline, reminderDays: OFFLINE_REMINDER_DAYS } : null,
    };
  });

  /**
   * Records that a non-message dialog was dismissed, so it stays quiet for its
   * snooze window instead of reappearing on the next screen change.
   */
  ipcMain.handle('remote:dismissNotice', async (_event, kind: string) => {
    const allowed: Record<string, string> = {
      offline: 'offline_notice_shown',
      expiry: 'expiry_notice_shown',
    };
    const stateKey = allowed[String(kind)];
    // Whitelisted, not interpolated: the renderer must never be able to choose
    // an arbitrary remote_state key to overwrite.
    if (!stateKey) return { success: false };
    ensureRemoteTables();
    setRemoteState(stateKey, new Date().toISOString());
    return { success: true };
  });

  /** Which About-page fields are currently supplied by the developer. */
  ipcMain.handle('remote:managedKeys', async () => {
    return {
      keys: [...REMOTE_MANAGED_KEYS],
      active: Object.keys(getRemoteOverrides()),
    };
  });

  ipcMain.handle('remote:syncInfo', async () => {
    return { ...lastSyncInfo() };
  });

  /** Manual "check now" button. */
  ipcMain.handle('remote:syncNow', async () => {
    const ok = await runHeartbeat(getDeviceId(), getLicense());
    return { success: ok, ...lastSyncInfo() };
  });

  /** Full disclosure of what a check-in transmits, rendered in the UI. */
  ipcMain.handle('remote:privacyReport', async () => {
    return {
      sends: [
        { key: 'deviceId', label: 'معرّف الجهاز (رقم مشفّر لا يكشف هويتك)' },
        { key: 'appVersion', label: 'رقم إصدار البرنامج' },
        { key: 'platform', label: 'نظام التشغيل (windows / mac / linux)' },
        { key: 'licenseStatus', label: 'حالة الاشتراك (مفعّل / منتهٍ / تجريبي)' },
        { key: 'licenseExpiry', label: 'تاريخ انتهاء الاشتراك' },
        { key: 'shopName', label: 'اسم المحل (اختياري — يمكن إيقافه)' },
        { key: 'readReceipts', label: 'أرقام الرسائل التي قرأتها' },
      ],
      neverSends: [
        'بيانات العملاء أو الموردين أو الموظفين',
        'الفواتير والمبيعات والمشتريات',
        'الأرصدة والمبالغ والأرباح',
        'المخزون والأصناف',
        'كلمات المرور',
        'أي محتوى من قاعدة البيانات',
      ],
    };
  });
}
