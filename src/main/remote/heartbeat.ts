import { app } from 'electron';
import { getDb } from '../database/connection';
import {
  ensureRemoteTables, saveRemoteConfig, saveRemoteMessages,
  getRemoteState, setRemoteState, pendingReadReceipts, markReceiptsSynced,
} from './remoteStore';

/**
 * Periodic check-in with the developer's server.
 *
 * PRIVACY — exactly what leaves the customer's machine
 * ----------------------------------------------------
 * Only the fields assembled in `buildPayload()` below are ever transmitted.
 * They are limited to what is needed to answer "which install is this, is its
 * subscription valid, and which build is it running". No business data of any
 * kind is included: no customers, no suppliers, no invoices, no amounts, no
 * balances, no product list, no passwords, and no database content.
 *
 * `shopName` is included so the developer can recognise an install when the
 * customer calls for support; it is the name the shop owner typed for their own
 * receipts, not personal data about a third party. It can be suppressed with the
 * `telemetry_share_shop_name` setting.
 *
 * The whole feature can be switched off with `telemetry_enabled = '0'`, and the
 * customer is told about it on the activation screen.
 *
 * RELIABILITY
 * -----------
 * This must never affect the application:
 *   - it runs after the window is already up;
 *   - every failure is swallowed and retried later;
 *   - a hard timeout stops a hanging server from leaking timers;
 *   - the licence decision stays entirely local — the server can never disable
 *     an install, it only supplies presentation values and messages.
 */

/** Base URL of the developer's Cloudflare Worker. Empty = feature disabled. */
const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');

/**
 * Public client key. Identifies "a copy of this app" so the endpoint can reject
 * random internet traffic. It is NOT an admin credential: it cannot issue
 * activation codes or read other devices. Extracting it from the bundle gains
 * an attacker nothing beyond the ability to post their own heartbeat.
 */
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;  // once a day
const FIRST_RUN_DELAY_MS = 30 * 1000;               // let the app settle first
const RETRY_DELAY_MS = 60 * 60 * 1000;              // hourly retry after failure
const REQUEST_TIMEOUT_MS = 10 * 1000;

let timer: NodeJS.Timeout | null = null;

function setting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT Value FROM settings WHERE Key = ?').get(key) as any;
    return row?.Value ?? null;
  } catch {
    return null;
  }
}

/** Telemetry is opt-out; a customer (or the developer) can disable it. */
export function telemetryEnabled(): boolean {
  return setting('telemetry_enabled') !== '0';
}

export interface HeartbeatPayload {
  deviceId: string;
  appVersion: string;
  platform: string;
  licenseStatus: string;
  licenseExpiry: string | null;
  shopName: string | null;
  readReceipts: number[];
}

/**
 * Assembles the payload. Kept as a pure function with an explicit shape so the
 * privacy test can assert that nothing else can ever be added by accident.
 */
export function buildPayload(
  deviceId: string,
  license: { status?: string; expiry?: string | null },
): HeartbeatPayload {
  const shareName = setting('telemetry_share_shop_name') !== '0';
  return {
    deviceId,
    appVersion: setting('app_version') || app.getVersion?.() || '0.0.0',
    platform: process.platform,
    licenseStatus: String(license?.status ?? 'unknown'),
    licenseExpiry: license?.expiry ?? null,
    shopName: shareName ? (setting('company_name') || null) : null,
    readReceipts: pendingReadReceipts(),
  };
}

async function postJson(path: string, body: unknown): Promise<any | null> {
  if (!API_BASE) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Key': CLIENT_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;   // offline, DNS failure, timeout — all non-fatal
  } finally {
    clearTimeout(t);
  }
}

/**
 * Runs one check-in. Returns true when the server answered.
 * `getLicense` is injected so this module does not import the licence handler
 * (which would create a cycle).
 */
export async function runHeartbeat(
  deviceId: string,
  license: { status?: string; expiry?: string | null },
): Promise<boolean> {
  if (!API_BASE || !CLIENT_KEY) return false;
  if (!telemetryEnabled()) return false;

  try {
    ensureRemoteTables();
    const payload = buildPayload(deviceId, license);
    const res = await postJson('/heartbeat', payload);
    if (!res || res.ok === false) return false;

    // Presentation values only — the store filters them again through the
    // client-side allow-list, so an unexpected key is dropped.
    if (res.config && typeof res.config === 'object') {
      saveRemoteConfig('all', res.config.all ?? {});
      saveRemoteConfig('device', res.config.device ?? {});
    }
    if (Array.isArray(res.messages)) {
      saveRemoteMessages(res.messages);
    }
    if (Array.isArray(payload.readReceipts) && payload.readReceipts.length) {
      markReceiptsSynced(payload.readReceipts);
    }

    setRemoteState('last_sync', new Date().toISOString());
    setRemoteState('last_sync_ok', '1');
    return true;
  } catch (err) {
    console.error('[Heartbeat] failed:', err);
    setRemoteState('last_sync_ok', '0');
    return false;
  }
}

/** Schedules the daily check-in. Safe to call once at startup. */
export function startHeartbeat(
  getDeviceId: () => string,
  getLicense: () => { status?: string; expiry?: string | null },
) {
  if (!API_BASE || !CLIENT_KEY) {
    console.log('[Heartbeat] disabled (no API base configured)');
    return;
  }

  const tick = async () => {
    const ok = await runHeartbeat(getDeviceId(), getLicense());
    // Back off to hourly retries until one succeeds, then resume daily.
    schedule(ok ? HEARTBEAT_INTERVAL_MS : RETRY_DELAY_MS);
  };

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, delay);
    // Do not hold the event loop open for this alone.
    timer.unref?.();
  };

  schedule(FIRST_RUN_DELAY_MS);
  console.log('[Heartbeat] scheduled');
}

export function stopHeartbeat() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Timestamp of the last successful sync, for display in the UI. */
export function lastSyncInfo() {
  return {
    lastSync: getRemoteState('last_sync'),
    lastSyncOk: getRemoteState('last_sync_ok') === '1',
    enabled: !!API_BASE && !!CLIENT_KEY && telemetryEnabled(),
  };
}
