import { ipcMain, app } from 'electron';
import { getDb } from '../database/connection';
import { safeFailure } from '../security/errorResponse';
import { setRemoteState, ensureRemoteTables } from '../remote/remoteStore';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyDevToken } from '../security/devAuth';
import {
  verifyCode, daysRemaining, expiryToDate, dateToExpiry,
} from '../security/licenseCrypto';
import { isImplausiblyFuture, businessToday } from '../../shared/businessDate';
import { readTrialAnchor, writeTrialAnchor, healTrialAnchor } from '../security/trialAnchor';
// One derivation of the device identity, shared with password recovery.
import { getDeviceId } from '../security/deviceId';
export { getDeviceId };

// ===== LICENSE SYSTEM =====
// Encrypted license management - cannot be tampered with

const SECRET_KEY = 'm0b1l3_sh0p_3rp_s3cr3t_k3y_2026_z3r0c0ld';
const LICENSE_FILE = 'license.dat';
const DEVICE_FILE = 'device.id';
const TRIAL_FILE = 'trial.dat';
const TRIAL_DAYS = 7;

/**
 * How far the clock may appear to move backwards before it is called tampering.
 *
 * `lastaccess.dat` stores an absolute UTC instant, so switching timezone or
 * crossing a daylight-saving boundary does NOT move it — only the wall-clock
 * label changes, never the epoch. Egypt's DST shift is one hour, and it cannot
 * reach this check at all.
 *
 * The window still needs to be generous, because several harmless things do
 * move the epoch a little:
 *   - Windows re-syncing with an NTP server after the CMOS battery weakens;
 *   - a laptop resuming from hibernation with a stale RTC;
 *   - a virtual machine or dual-boot system correcting UTC-vs-local confusion,
 *     which shifts the clock by exactly the UTC offset (2-3 hours in Egypt).
 *
 * Six hours absorbs all of those while still catching the only case that
 * matters commercially — winding the date back days or months to extend a
 * subscription, which also has to defeat the business-date check below.
 */
const CLOCK_DRIFT_TOLERANCE_MS = 6 * 60 * 60 * 1000;


// Encrypt/Decrypt functions
function encrypt(data: any): string {
  const json = JSON.stringify(data);
  const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(json, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): any {
  try {
    const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
    let iv: Buffer;
    let ciphertext: string;
    if (text.includes(':')) {
      const parts = text.split(':');
      iv = Buffer.from(parts[0], 'hex');
      ciphertext = parts[1];
    } else {
      // Backward compat: old format used static MD5 IV
      iv = crypto.createHash('md5').update(SECRET_KEY).digest();
      ciphertext = text;
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// Generate activation code
function generateActivationCode(days: number): string {
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  // Format: XXXX-XXXX-XXXX-XXXX
  const formatted = code.match(/.{1,4}/g)?.join('-') || code;
  return formatted;
}

/**
 * Newest date recorded in the business data (ISO yyyy-mm-dd), or null.
 *
 * Used as a clock-rollback signal: if the system clock reads earlier than the
 * newest invoice, the date was moved back. Unlike `lastaccess.dat`, the user
 * cannot simply delete this evidence — it lives inside their own accounting
 * data, which they need.
 */
function newestBusinessDate(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT MAX(d) AS newest FROM (
        SELECT MAX(Date) AS d FROM sales
        UNION ALL SELECT MAX(Date) FROM purchases
        UNION ALL SELECT MAX(Date) FROM vouchers
        UNION ALL SELECT MAX(Date) FROM maintenance_tickets
      )
    `).get() as any;
    return row?.newest ?? null;
  } catch {
    return null;
  }
}

/**
 * Caches a minimal licence summary so the heartbeat can report status without
 * re-running the whole status check (and without importing this module).
 * Presentation data only — never any business figures.
 */
function cacheLicenseSummary(status: string, expiry: string | null) {
  try {
    ensureRemoteTables();
    setRemoteState('license_summary', JSON.stringify({ status, expiry }));
  } catch { /* non-fatal */ }
}

export function registerLicenseHandlers() {
  // Get license status
  ipcMain.handle('license:status', async () => {
    const licensePath = path.join(app.getPath('userData'), LICENSE_FILE);
    const deviceId = getDeviceId();

    if (!fs.existsSync(licensePath)) {
      // No license — check trial system
      const trialPath = path.join(app.getPath('userData'), TRIAL_FILE);
      const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');

      if (!fs.existsSync(trialPath)) {
        // trial.dat missing — was it deleted after being used?
        //
        // Two independent witnesses, because they live in different places.
        // `lastaccess.dat` sits beside trial.dat in userData, so deleting that
        // ONE folder used to erase the evidence and the thing it testified
        // about together, handing out an unlimited supply of fresh trials.
        // The anchor is written outside the application's folder entirely.
        const anchorStart = readTrialAnchor(deviceId);
        if (fs.existsSync(lastAccessPath) || anchorStart) {
          // If the anchor survived, restore the ORIGINAL start date rather than
          // simply refusing: a shop whose folder was cleared by an over-eager
          // "cleanup" tool keeps whatever days it had genuinely left.
          if (anchorStart) {
            const trialHash = crypto.createHash('sha256')
              .update(deviceId + anchorStart + SECRET_KEY + 'TRIAL')
              .digest('hex');
            try {
              fs.writeFileSync(trialPath, encrypt({ deviceId, startDate: anchorStart, hash: trialHash }), 'utf-8');
              fs.writeFileSync(lastAccessPath, new Date().toISOString(), 'utf-8');
            } catch { /* read-only fs — fall through to the refusal below */ }
            const usedDays = Math.floor((Date.now() - new Date(anchorStart).getTime()) / 86_400_000);
            const left = TRIAL_DAYS - usedDays;
            if (left > 0) {
              healTrialAnchor(deviceId, anchorStart);
              return {
                status: 'trial', deviceId, remainingDays: left,
                message: `فترة تجريبية - متبقي ${left} يوم`,
              };
            }
          }
          return {
            status: 'trial_expired',
            deviceId,
            message: 'انتهت الفترة التجريبية - أدخل كود التفعيل',
          };
        }
        // First launch ever → start trial
        const now = new Date().toISOString();
        const trialHash = crypto.createHash('sha256')
          .update(deviceId + now + SECRET_KEY + 'TRIAL')
          .digest('hex');
        const trial = { deviceId, startDate: now, hash: trialHash };
        fs.writeFileSync(trialPath, encrypt(trial), 'utf-8');
        fs.writeFileSync(lastAccessPath, now, 'utf-8');
        // Plant the evidence outside userData so this cannot be replayed by
        // deleting the application folder.
        writeTrialAnchor(deviceId, now);
        return {
          status: 'trial',
          deviceId,
          remainingDays: TRIAL_DAYS,
          message: `فترة تجريبية - متبقي ${TRIAL_DAYS} يوم`,
        };
      }

      // trial.dat exists — verify it
      const trial = decrypt(fs.readFileSync(trialPath, 'utf-8'));
      if (!trial) {
        return { status: 'error', deviceId, message: 'ملف الفترة التجريبية تالف' };
      }
      if (trial.deviceId !== deviceId) {
        return { status: 'error', deviceId, message: 'الفترة التجريبية مرتبطة بجهاز آخر' };
      }
      const expectedTrialHash = crypto.createHash('sha256')
        .update(trial.deviceId + trial.startDate + SECRET_KEY + 'TRIAL')
        .digest('hex');
      if (trial.hash !== expectedTrialHash) {
        return { status: 'tampered', deviceId, message: 'تم التلاعب ببيانات الفترة التجريبية' };
      }

      const trialStart = new Date(trial.startDate);
      const now = new Date();

      // Date rollback — start date in the future
      if (now.getTime() < trialStart.getTime()) {
        return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام' };
      }

      // Date rollback — last access. Same tolerance as the licensed path so a
      // trial user is not locked out by an NTP correction either.
      if (fs.existsSync(lastAccessPath)) {
        const lastAccess = new Date(fs.readFileSync(lastAccessPath, 'utf-8'));
        if (now.getTime() < lastAccess.getTime() - CLOCK_DRIFT_TOLERANCE_MS) {
          return {
            status: 'tampered', deviceId,
            message: 'تم تغيير تاريخ النظام للوراء',
            recoverable: true,
          };
        }
      }
      fs.writeFileSync(lastAccessPath, now.toISOString(), 'utf-8');
      // Re-plant any anchor copy that has gone missing, so removing two of
      // three achieves nothing beyond the next start-up.
      healTrialAnchor(deviceId, trial.startDate);

      // Calculate remaining trial days
      const elapsedTrialDays = Math.floor((now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24));
      const remainingTrialDays = TRIAL_DAYS - elapsedTrialDays;

      if (remainingTrialDays <= 0) {
        return {
          status: 'trial_expired',
          deviceId,
          message: 'انتهت الفترة التجريبية - أدخل كود التفعيل',
        };
      }

      return {
        status: 'trial',
        deviceId,
        remainingDays: remainingTrialDays,
        message: `فترة تجريبية - متبقي ${remainingTrialDays} يوم`,
      };
    }

    const encrypted = fs.readFileSync(licensePath, 'utf-8');
    const license = decrypt(encrypted);

    if (!license) {
      return { status: 'error', deviceId, message: 'ملف الترخيص تالف' };
    }

    if (license.deviceId !== deviceId) {
      return { status: 'error', deviceId, message: 'هذا الترخيص مرتبط بجهاز آخر' };
    }

    // Integrity hash over the stored fields.
    const expectedHash = crypto.createHash('sha256')
      .update(license.deviceId + license.serial + license.expiryDays + license.startDate + SECRET_KEY)
      .digest('hex');
    if (license.hash !== expectedHash) {
      return { status: 'tampered', deviceId, message: 'تم التلاعب ببيانات الترخيص' };
    }

    const now = new Date();
    const startDate = new Date(license.startDate);

    // === CLOCK ROLLBACK DETECTION ===
    // Three independent signals; any one of them means the clock moved back:
    //   1. now is before the licence was activated;
    //   2. now is before the last recorded launch;
    //   3. now is before the newest business document in the database — the
    //      strongest signal, because deleting it means losing the shop's data.
    if (now.getTime() < startDate.getTime() - 60_000) {
      return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام' };
    }

    const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');
    if (fs.existsSync(lastAccessPath)) {
      const lastAccess = new Date(fs.readFileSync(lastAccessPath, 'utf-8'));
      if (!Number.isNaN(lastAccess.getTime()) &&
          now.getTime() < lastAccess.getTime() - CLOCK_DRIFT_TOLERANCE_MS) {
        return {
          status: 'tampered', deviceId,
          message: 'تم تغيير تاريخ النظام للوراء',
          recoverable: true,
        };
      }
    }

    // Business documents are dated with the shop's LOCAL calendar day, so the
    // comparison must use the local day too. Comparing against
    // `now.toISOString()` (UTC) declared tampering every night between midnight
    // and 02:00 — exactly when a phone shop is still trading — because the
    // day's own invoices were "in the future" relative to the UTC date.
    //
    // A tolerance is applied on top: a clock a few minutes fast, or a backup
    // carried from a machine one timezone ahead, is a support call, not fraud.
    // Real rollback (days or years) is still caught.
    const latestActivity = newestBusinessDate();
    if (latestActivity && isImplausiblyFuture(latestActivity, now)) {
      return {
        status: 'tampered', deviceId,
        message: `تم تغيير تاريخ النظام - يوجد نشاط مسجّل بتاريخ ${latestActivity}`,
        // Told to the UI so it can offer the recovery path instead of a dead
        // end: this state is reachable by accident (a dead CMOS battery dates
        // a sale years ahead), and the owner must not be locked out of their
        // own accounts because of failing hardware.
        recoverable: true,
        latestActivity,
      };
    }

    try { fs.writeFileSync(lastAccessPath, now.toISOString(), 'utf-8'); } catch { /* read-only fs */ }

    // === DURATION ONLY — no feature gating anywhere ===
    // A valid licence unlocks the whole application. What a given USER may do
    // is decided by the permissions system in the database, never by the
    // licence, so renewing never changes anyone's access rights.
    if (license.expiryDays === 0) {
      cacheLicenseSummary('active', null);
      return {
        status: 'active', deviceId,
        serial: license.serial,
        startDate: license.startDate,
        expiry: 'غير محدود',
        remainingDays: null,
        unlimited: true,
        message: 'الترخيص مفعّل - غير محدود',
      };
    }

    const remaining = daysRemaining(license.expiryDays, now);
    const expiryLabel = expiryToDate(license.expiryDays).toISOString().slice(0, 10);

    if (remaining <= 0) {
      cacheLicenseSummary('expired', expiryLabel);
      return {
        status: 'expired', deviceId,
        serial: license.serial,
        startDate: license.startDate,
        expiry: expiryLabel,
        remainingDays: 0,
        message: `انتهت صلاحية الترخيص بتاريخ ${expiryLabel}`,
      };
    }

    cacheLicenseSummary('active', expiryLabel);
    return {
      status: 'active', deviceId,
      serial: license.serial,
      startDate: license.startDate,
      expiry: expiryLabel,
      remainingDays: remaining,
      unlimited: false,
      // Surfaced so the UI can nudge the customer before the shop stops.
      expiringSoon: remaining <= 14,
      message: `الترخيص مفعّل - متبقي ${remaining} يوم (حتى ${expiryLabel})`,
    };
  });

  // Activate license with a self-contained code
  //
  // The previous implementation looked the code up in
  // `userData/activation_codes.dat`. That file lives on whichever machine ran
  // `generateCode`, i.e. the DEVELOPER's — so a code sent to a customer was
  // never found and activation was impossible across machines. The code now
  // carries its own signed payload (expiry + serial) bound to this device, so
  // no local lookup is needed at all.
  ipcMain.handle('license:activate', async (_event, data: { code: string }) => {
    const deviceId = getDeviceId();
    const raw = String(data?.code ?? '').trim();
    if (!raw) return { success: false, message: 'أدخل كود التفعيل' };

    // Throttle guessing: the tag is 5 bytes, so brute force is impractical, but
    // a slow path removes any doubt and costs a legitimate user nothing.
    const attemptsPath = path.join(app.getPath('userData'), 'activation_attempts.dat');
    let attempts = 0;
    try { attempts = parseInt(fs.readFileSync(attemptsPath, 'utf-8'), 10) || 0; } catch { attempts = 0; }
    if (attempts >= 10) {
      const stat = fs.existsSync(attemptsPath) ? fs.statSync(attemptsPath) : null;
      const since = stat ? Date.now() - stat.mtimeMs : Infinity;
      if (since < 15 * 60 * 1000) {
        return { success: false, message: 'تجاوزت عدد المحاولات - انتظر 15 دقيقة' };
      }
      attempts = 0;
    }

    // The secret argument is vestigial: verification uses the embedded
    // PUBLIC key only, and nothing a caller passes can change the outcome.
    const payload = verifyCode('', deviceId, raw);
    if (!payload) {
      try { fs.writeFileSync(attemptsPath, String(attempts + 1), 'utf-8'); } catch { /* ignore */ }
      return { success: false, message: 'كود التفعيل غير صحيح أو غير مخصص لهذا الجهاز' };
    }

    // Already expired at the moment of entry.
    if (payload.expiryDays !== 0 && daysRemaining(payload.expiryDays) <= 0) {
      return { success: false, message: 'هذا الكود منتهي الصلاحية - اطلب كوداً جديداً' };
    }

    // Refuse to silently downgrade an existing, longer licence.
    const licensePath = path.join(app.getPath('userData'), LICENSE_FILE);
    if (fs.existsSync(licensePath)) {
      const current = decrypt(fs.readFileSync(licensePath, 'utf-8'));
      if (current && current.deviceId === deviceId) {
        if (current.serial === payload.serial) {
          return { success: false, message: 'تم استخدام هذا الكود بالفعل على هذا الجهاز' };
        }
        const currentUnlimited = current.expiryDays === 0;
        if (currentUnlimited) {
          return { success: false, message: 'الترخيص الحالي غير محدود - لا حاجة للتجديد' };
        }
        if (payload.expiryDays !== 0 && payload.expiryDays < current.expiryDays) {
          return { success: false, message: 'الكود المدخل أقصر من ترخيصك الحالي' };
        }
      }
    }

    const now = new Date().toISOString();
    const license = {
      deviceId,
      serial: payload.serial,
      expiryDays: payload.expiryDays,
      startDate: now,
      hash: crypto.createHash('sha256')
        .update(deviceId + payload.serial + payload.expiryDays + now + SECRET_KEY)
        .digest('hex'),
    };

    try {
      if (fs.existsSync(licensePath)) fs.chmodSync(licensePath, 0o644);
      fs.writeFileSync(licensePath, encrypt(license), 'utf-8');
      fs.chmodSync(licensePath, 0o444);
    } catch (err: any) {
      return safeFailure('license:activate', err, 'تعذّر حفظ الترخيص');
    }

    try { fs.unlinkSync(attemptsPath); } catch { /* ignore */ }

    const label = payload.expiryDays === 0
      ? 'غير محدود'
      : expiryToDate(payload.expiryDays).toISOString().slice(0, 10);
    return {
      success: true,
      message: `تم التفعيل بنجاح - صالح حتى: ${label}`,
      expiry: label,
      remainingDays: payload.expiryDays === 0 ? null : daysRemaining(payload.expiryDays),
    };
  });

  // Activation codes can NO LONGER be minted from inside the app.
  //
  // This used to work because both sides shared one HMAC secret, and that is
  // exactly why the scheme was replaceable: a build that can MINT a licence
  // contains the key that mints licences. Under Ed25519 the signing key is
  // private and never ships, so an installed copy has nothing to sign with —
  // and giving it one would recreate the original hole.
  //
  // Codes are issued with `npm run license:new` on the developer's own
  // machine. The handler stays so the console can explain that clearly rather
  // than appearing broken.
  ipcMain.handle('license:generateCode', async (_event, data: {
    days: number;              // 0 = perpetual
    customerDeviceId: string;  // required — the code is bound to it
    devToken: string;
  }) => {
    if (!verifyDevToken(data?.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }
    const target = String(data?.customerDeviceId ?? '').trim().toLowerCase();
    if (target.length < 8) {
      return { success: false, message: 'يجب إدخال معرّف جهاز العميل' };
    }
    const days = Number(data?.days);
    if (!Number.isFinite(days) || days < 0) {
      return { success: false, message: 'عدد الأيام غير صالح' };
    }

    // Refused, deliberately and always. The device id is echoed back so the
    // developer can copy it straight into the keygen on their own machine.
    return {
      success: false,
      deviceId: target,
      message:
        'لا يمكن إصدار كود التفعيل من داخل البرنامج. '
        + 'مفتاح التوقيع الخاص لا يُشحن مع أي نسخة — وهذا ما يمنع تزوير التراخيص. '
        + `أصدر الكود من جهازك بالأمر:  npm run license:new -- --device ${target} --days ${Math.floor(days)}`,
    };
  });

  // Deactivate license (dev only - for transferring to new device)
  ipcMain.handle('license:deactivate', async (_event, data: { devToken: string }) => {
    // SECURITY: verified against a short-lived token issued by `dev:login`
    // (main-process bcrypt check + rate limiting) instead of comparing a
    // plaintext password that shipped inside the packaged app.
    if (!verifyDevToken(data.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }

    const licensePath = path.join(app.getPath('userData'), LICENSE_FILE);
    const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');
    const trialPath = path.join(app.getPath('userData'), TRIAL_FILE);

    try {
      if (fs.existsSync(licensePath)) {
        fs.unlinkSync(licensePath);
      }
      if (fs.existsSync(lastAccessPath)) {
        fs.unlinkSync(lastAccessPath);
      }
      if (fs.existsSync(trialPath)) {
        fs.unlinkSync(trialPath);
      }
      return { success: true, message: 'تم إلغاء التفعيل - يمكن تفعيله على جهاز آخر' };
    } catch (err: any) {
      return safeFailure('license:deactivate', err);
    }
  });

  // Get device ID
  ipcMain.handle('license:getDeviceId', async () => {
    return getDeviceId();
  });

  /**
   * Explains a clock problem in plain terms, and lets the owner recover.
   *
   * A "tampered" verdict is reachable WITHOUT any dishonesty: when a PC's CMOS
   * battery dies the clock jumps to a default date, often years ahead. If the
   * shop keeps selling, those invoices are written with that future date. Once
   * the clock is corrected the app sees documents dated in the future and locks
   * the whole application — the owner cannot even reach their own accounts to
   * see what happened.
   *
   * Refusing to provide a way out would punish a hardware fault. This handler
   * reports exactly which records look wrong so the situation is explainable,
   * and `license:repairClockState` clears the stale marker afterwards.
   */
  ipcMain.handle('license:clockDiagnostics', async () => {
    const db = getDb();
    const now = new Date();
    const today = businessToday(now);
    const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');

    let lastAccess: string | null = null;
    try {
      if (fs.existsSync(lastAccessPath)) {
        lastAccess = fs.readFileSync(lastAccessPath, 'utf-8').trim();
      }
    } catch { /* unreadable — treated as absent */ }

    // Per-table breakdown so the owner can find and correct the bad documents.
    const tables = [
      ['sales', 'فواتير البيع'],
      ['purchases', 'فواتير الشراء'],
      ['vouchers', 'السندات'],
      ['maintenance_tickets', 'تذاكر الصيانة'],
    ] as const;

    const future: Array<{ table: string; label: string; count: number; newest: string }> = [];
    for (const [table, label] of tables) {
      try {
        const row = db.prepare(
          `SELECT COUNT(*) AS n, MAX(Date) AS newest FROM ${table} WHERE Date > ?`,
        ).get(today) as any;
        if (row?.n > 0) {
          future.push({ table, label, count: row.n, newest: row.newest });
        }
      } catch { /* table missing in an old database */ }
    }

    return {
      today,
      systemTime: now.toISOString(),
      timezoneOffsetMinutes: -now.getTimezoneOffset(),
      lastAccess,
      futureRecords: future,
      totalFuture: future.reduce((s, f) => s + f.count, 0),
    };
  });

  /**
   * Clears the stale clock markers so the app can start again.
   *
   * Deliberately does NOT touch the licence file or the business data: it only
   * removes `lastaccess.dat`, which is a cache of "when was I last opened".
   * The subscription's own expiry is signed inside the activation code and is
   * unaffected, so this cannot be used to extend a subscription — the worst it
   * can do is forget one rollback signal, while the business-date check (which
   * reads the shop's real invoices) stays in force.
   */
  ipcMain.handle('license:repairClockState', async (_event, data: { devToken: string }) => {
    if (!verifyDevToken(data?.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }
    const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');
    try {
      if (fs.existsSync(lastAccessPath)) fs.unlinkSync(lastAccessPath);
      return {
        success: true,
        message: 'تم مسح سجل آخر تشغيل. أعد تشغيل البرنامج بعد ضبط تاريخ الجهاز.',
      };
    } catch (err: any) {
      return safeFailure('license:repairClockState', err);
    }
  });
}
