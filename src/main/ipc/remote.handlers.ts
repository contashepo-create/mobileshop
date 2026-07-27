import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import {
  ensureRemoteTables, listRemoteMessages, markMessageRead, getRemoteOverrides,
} from '../remote/remoteStore';
import { lastSyncInfo, runHeartbeat, telemetryEnabled } from '../remote/heartbeat';
import { REMOTE_MANAGED_KEYS } from '../remote/remoteConfig';

/**
 * Renderer-facing surface for the remote-management feature.
 *
 * Everything here is read-only from the customer's point of view except
 * `remote:markRead` (a local acknowledgement) and `remote:setTelemetry`
 * (their own privacy switch). The server can never be asked to do anything
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

  /** Which About-page fields are currently supplied by the developer. */
  ipcMain.handle('remote:managedKeys', async () => {
    return {
      keys: [...REMOTE_MANAGED_KEYS],
      active: Object.keys(getRemoteOverrides()),
    };
  });

  ipcMain.handle('remote:syncInfo', async () => {
    return { ...lastSyncInfo(), telemetry: telemetryEnabled() };
  });

  /** Manual "check now" button. */
  ipcMain.handle('remote:syncNow', async () => {
    const ok = await runHeartbeat(getDeviceId(), getLicense());
    return { success: ok, ...lastSyncInfo() };
  });

  /** The customer's own privacy switch. */
  ipcMain.handle('remote:setTelemetry', async (_event, enabled: boolean) => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('telemetry_enabled', ?)")
      .run(enabled ? '1' : '0');
    return { success: true, enabled };
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
