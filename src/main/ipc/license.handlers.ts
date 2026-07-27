import { ipcMain, app } from 'electron';
import { getDb } from '../database/connection';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyDevToken } from '../security/devAuth';

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

    // Verify device ID matches
    if (license.deviceId !== deviceId) {
      return { status: 'error', deviceId, message: 'هذا الترخيص مرتبط بجهاز آخر' };
    }

    // Check for tampering - verify hash
    const expectedHash = crypto.createHash('sha256')
      .update(license.deviceId + license.code + license.days + license.startDate + SECRET_KEY)
      .digest('hex');
    if (license.hash !== expectedHash) {
      return { status: 'tampered', deviceId, message: 'تم التلاعب ببيانات الترخيص' };
    }

    // Calculate expiry
    const startDate = new Date(license.startDate);
    const now = new Date();
    const elapsedDays = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    // Check for date rollback (if current date is before start date or before last known date)
    if (now.getTime() < startDate.getTime()) {
      return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام' };
    }

    // Check last access date (prevent rollback)
    const lastAccessPath = path.join(app.getPath('userData'), 'lastaccess.dat');
    if (fs.existsSync(lastAccessPath)) {
      const lastAccess = new Date(fs.readFileSync(lastAccessPath, 'utf-8'));
      if (now.getTime() < lastAccess.getTime() - (1000 * 60 * 60 * 2)) { // 2 hour tolerance
        return { status: 'tampered', deviceId, message: 'تم تغيير تاريخ النظام للوراء' };
      }
    }
    // Update last access
    fs.writeFileSync(lastAccessPath, now.toISOString(), 'utf-8');

    // Unlimited days (0 = forever)
    if (license.days === 0) {
      return {
        status: 'active',
        deviceId,
        type: license.type || 'full',
        code: license.code,
        startDate: license.startDate,
        days: 'غير محدود',
        elapsedDays,
        remainingDays: '∞',
        message: 'الترخيص مفعّل - غير محدود',
      };
    }

    const remainingDays = license.days - elapsedDays;
    if (remainingDays <= 0) {
      return {
        status: 'expired',
        deviceId,
        type: license.type || 'trial',
        code: license.code,
        startDate: license.startDate,
        days: license.days,
        elapsedDays,
        remainingDays: 0,
        message: 'انتهت صلاحية الترخيص',
      };
    }

    return {
      status: 'active',
      deviceId,
      type: license.type || 'trial',
      code: license.code,
      startDate: license.startDate,
      days: license.days,
      elapsedDays,
      remainingDays,
      message: `الترخيص مفعّل - متبقي ${remainingDays} يوم`,
    };
  });

  // Activate license with code
  ipcMain.handle('license:activate', async (_event, data: {
    code: string;
  }) => {
    // Normalize code: uppercase, strip dashes
    const normalizedCode = (data.code || '').toUpperCase().replace(/-/g, '').trim();
    const formattedCode = normalizedCode.match(/.{1,4}/g)?.join('-') || normalizedCode;

    // Read generated codes
    const codesPath = path.join(app.getPath('userData'), 'activation_codes.dat');
    if (!fs.existsSync(codesPath)) {
      return { success: false, message: 'كود التفعيل غير صالح' };
    }

    const encryptedCodes = fs.readFileSync(codesPath, 'utf-8');
    const codes = decrypt(encryptedCodes);
    if (!codes || !Array.isArray(codes)) {
      return { success: false, message: 'ملف أكواد التفعيل تالف' };
    }

    // Find the code (match both formatted and unformatted)
    const codeEntry = codes.find((c: any) =>
      c.code === formattedCode || c.code.replace(/-/g, '') === normalizedCode
    );
    if (!codeEntry) {
      return { success: false, message: 'كود التفعيل غير موجود' };
    }

    // Check if already used
    if (codeEntry.used) {
      return { success: false, message: 'تم استخدام هذا الكود من قبل' };
    }

    // Check if code is for a different device
    if (codeEntry.deviceId && codeEntry.deviceId !== getDeviceId()) {
      return { success: false, message: 'هذا الكود مرتبط بجهاز آخر' };
    }

    // Activate
    const deviceId = getDeviceId();
    const now = new Date().toISOString();
    const hash = crypto.createHash('sha256')
      .update(deviceId + codeEntry.code + codeEntry.days + now + SECRET_KEY)
      .digest('hex');

    const license = {
      deviceId,
      code: codeEntry.code,
      days: codeEntry.days,
      type: codeEntry.type || 'trial',
      startDate: now,
      hash,
    };

    // Save license file (encrypted)
    const licensePath = path.join(app.getPath('userData'), LICENSE_FILE);
    fs.writeFileSync(licensePath, encrypt(license), 'utf-8');
    fs.chmodSync(licensePath, 0o444); // Read-only

    // Mark code as used
    codeEntry.used = true;
    codeEntry.deviceId = deviceId;
    codeEntry.activatedAt = now;
    fs.writeFileSync(codesPath, encrypt(codes), 'utf-8');

    return {
      success: true,
      message: `تم تفعيل الترخيص بنجاح - ${codeEntry.days === 0 ? 'غير محدود' : codeEntry.days + ' يوم'}`,
      days: codeEntry.days,
    };
  });

  // Generate activation code (dev only)
  ipcMain.handle('license:generateCode', async (_event, data: {
    days: number; // 0 = unlimited
    type?: string; // 'trial' | 'full'
    customerDeviceId: string; // required: bind code to customer's device
    devToken: string;
  }) => {
    // SECURITY: verified against a short-lived token issued by `dev:login`
    // (main-process bcrypt check + rate limiting) instead of comparing a
    // plaintext password that shipped inside the packaged app.
    if (!verifyDevToken(data.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }

    if (!data.customerDeviceId || data.customerDeviceId.trim().length < 8) {
      return { success: false, message: 'يجب إدخال معرّف جهاز العميل' };
    }

    const code = generateActivationCode(data.days);

    // Read existing codes
    const codesPath = path.join(app.getPath('userData'), 'activation_codes.dat');
    let codes: any[] = [];
    if (fs.existsSync(codesPath)) {
      const existing = decrypt(fs.readFileSync(codesPath, 'utf-8'));
      if (Array.isArray(existing)) codes = existing;
    }

    // Add new code — bound to customer's device ID
    codes.push({
      code,
      days: data.days,
      type: data.type || (data.days === 0 ? 'full' : 'trial'),
      used: false,
      deviceId: data.customerDeviceId.trim(),
      createdAt: new Date().toISOString(),
      activatedAt: null,
    });

    // Save (encrypted)
    fs.writeFileSync(codesPath, encrypt(codes), 'utf-8');

    return {
      success: true,
      code,
      days: data.days,
      type: data.type || (data.days === 0 ? 'full' : 'trial'),
      deviceId: data.customerDeviceId.trim(),
    };
  });

  // List all generated codes (dev only)
  ipcMain.handle('license:listCodes', async (_event, data: { devToken: string }) => {
    // SECURITY: verified against a short-lived token issued by `dev:login`
    // (main-process bcrypt check + rate limiting) instead of comparing a
    // plaintext password that shipped inside the packaged app.
    if (!verifyDevToken(data.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }

    const codesPath = path.join(app.getPath('userData'), 'activation_codes.dat');
    if (!fs.existsSync(codesPath)) {
      return { success: true, codes: [] };
    }

    const codes = decrypt(fs.readFileSync(codesPath, 'utf-8'));
    return { success: true, codes: codes || [] };
  });

  // Revoke code (dev only)
  ipcMain.handle('license:revokeCode', async (_event, data: {
    code: string;
    devToken: string;
  }) => {
    // SECURITY: verified against a short-lived token issued by `dev:login`
    // (main-process bcrypt check + rate limiting) instead of comparing a
    // plaintext password that shipped inside the packaged app.
    if (!verifyDevToken(data.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }

    const codesPath = path.join(app.getPath('userData'), 'activation_codes.dat');
    if (!fs.existsSync(codesPath)) {
      return { success: false, message: 'لا توجد أكواد' };
    }

    const codes = decrypt(fs.readFileSync(codesPath, 'utf-8'));
    if (!Array.isArray(codes)) return { success: false, message: 'ملف تالف' };

    const filtered = codes.filter((c: any) => c.code !== data.code);
    fs.writeFileSync(codesPath, encrypt(filtered), 'utf-8');

    return { success: true };
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
