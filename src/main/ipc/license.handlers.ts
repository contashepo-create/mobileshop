import { ipcMain, app } from 'electron';
import { getDb } from '../database/connection';
import { setRemoteState, ensureRemoteTables } from '../remote/remoteStore';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyDevToken } from '../security/devAuth';
import {
  VERIFIER_SECRET, verifyCode, signCode, daysRemaining, expiryToDate, dateToExpiry,
} from '../security/licenseCrypto';

// ===== LICENSE SYSTEM =====
// Encrypted license management - cannot be tampered with

const SECRET_KEY = 'm0b1l3_sh0p_3rp_s3cr3t_k3y_2026_z3r0c0ld';
const LICENSE_FILE = 'license.dat';
const DEVICE_FILE = 'device.id';
const TRIAL_FILE = 'trial.dat';
const TRIAL_DAYS = 7;

// Get or create unique device ID
function getDeviceId(): string {
  const devicePath = path.join(app.getPath('userData'), DEVICE_FILE);
  if (fs.existsSync(devicePath)) {
    return fs.readFileSync(devicePath, 'utf-8');
  }
  // Generate from machine hardware
  const mac = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.mac !== '00:00:00:00:00:00')?.mac || 'unknown';
  const cpu = os.cpus()[0]?.model || 'unknown';
  const hostname = os.hostname();
  const rawId = `${mac}_${cpu}_${hostname}`;
  const deviceId = crypto.createHash('sha256').update(rawId + SECRET_KEY).digest('hex').substring(0, 32);
  fs.writeFileSync(devicePath, deviceId, 'utf-8');
  fs.chmodSync(devicePath, 0o444); // Read-only
  return deviceId;
}

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
        if (fs.existsSync(lastAccessPath)) {
          // App ran before but trial.dat is gone → trial was deleted to restart
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

      // Date rollback — last access
      if (fs.existsSync(lastAccessPath)) {
        const lastAccess = new Date(fs.readFileSync(lastAccessPath, 'utf-8'));
        if (now.getTime() < lastAccess.getTime() - (1000 * 60 * 60 * 2)) {
          return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام للوراء' };
        }
      }
      fs.writeFileSync(lastAccessPath, now.toISOString(), 'utf-8');

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
          now.getTime() < lastAccess.getTime() - (1000 * 60 * 60 * 2)) {
        return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام للوراء' };
      }
    }

    const latestActivity = newestBusinessDate();
    if (latestActivity && now.toISOString().slice(0, 10) < latestActivity) {
      return {
        status: 'tampered', deviceId,
        message: `تم تغيير تاريخ النظام - يوجد نشاط مسجّل بتاريخ ${latestActivity}`,
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

    const payload = verifyCode(VERIFIER_SECRET, deviceId, raw);
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
      return { success: false, message: `تعذّر حفظ الترخيص: ${err.message}` };
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

  // Generate an activation code from inside the app (developer console).
  //
  // Codes are normally minted with `scripts/license-keygen.js` on the
  // developer's own machine — that keeps the signing secret off customer
  // installs. This handler exists for convenience when the developer is sitting
  // at a customer's machine; it produces exactly the same code because both
  // sides use the same HMAC construction.
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

    const expiryDays = days === 0 ? 0 : dateToExpiry(new Date()) + Math.floor(days);
    if (expiryDays > 0xffff) {
      return { success: false, message: 'المدة طويلة جداً' };
    }

    // Serial counter kept locally so repeat issues for the same device differ.
    const serialPath = path.join(app.getPath('userData'), 'issue_serial.dat');
    let serial = 1;
    try { serial = (parseInt(fs.readFileSync(serialPath, 'utf-8'), 10) || 0) + 1; } catch { serial = 1; }
    try { fs.writeFileSync(serialPath, String(serial), 'utf-8'); } catch { /* ignore */ }

    const code = signCode(VERIFIER_SECRET, target, { expiryDays, serial });
    const label = expiryDays === 0 ? 'غير محدود' : expiryToDate(expiryDays).toISOString().slice(0, 10);

    return { success: true, code, days, expiry: label, deviceId: target, serial };
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
      return { success: false, message: err.message };
    }
  });

  // Get device ID
  ipcMain.handle('license:getDeviceId', async () => {
    return getDeviceId();
  });
}
