import { ipcMain, app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../database/connection';
import bcrypt from 'bcryptjs';
import { devLogin, revokeDevToken, createDevChallenge, devLoginSigned } from '../security/devAuth';
import { LICENSE_PUBLIC_KEY } from '../security/licenseCrypto';
import { getRemoteOverrides } from '../remote/remoteStore';
import { isRemoteManaged } from '../remote/remoteConfig';
import { requestCode, verifyCode } from '../security/confirmCode';
import { verifyPhoneViaTelegram } from '../security/phoneVerify';
import { validateRegistration } from '../../shared/registration';
import { notifyDeveloperOfRegistration } from '../security/resetNotify';
import { notifyDatabaseReset, notifyDeveloperOfReset } from '../security/resetNotify';
import { recordSecurityEvent } from '../security/securityLog';

export function registerSettingsHandlers() {
  // ===== DEVELOPER AUTHENTICATION =====
  // Verifying developer credentials in the MAIN process (bcrypt + lockout) and
  // handing back a short-lived token. Previously the renderer compared a
  // base64-obfuscated password itself and simply set
  // `sessionStorage.dev_unlocked = 'true'`, which anyone could do from DevTools.
  ipcMain.handle('dev:login', async (_event, data: { username: string; password: string }) => {
    return devLogin(data?.username ?? '', data?.password ?? '');
  });

  /**
   * Issues a challenge for the developer to sign on their OWN machine.
   *
   * Public because it must answer before anyone is authenticated — it is part
   * of getting in. It reveals nothing: a random nonce is not a secret, and
   * being able to ask for one does not help produce a signature.
   */
  ipcMain.handle('dev:challenge', async () => {
    const { nonce, expiresInSec } = createDevChallenge();
    return {
      success: true,
      nonce,
      expiresInSec,
      command: `npm run dev:sign -- ${nonce}`,
    };
  });

  /**
   * The strong path into the developer console.
   *
   * Requires BOTH a signature over the challenge — produced with a private key
   * that never ships — and the password. Cracking the shipped hash gets an
   * attacker one factor; stealing the key gets them the other. Neither alone
   * opens anything.
   */
  ipcMain.handle('dev:loginSigned', async (_event, data: {
    nonce?: string; signature?: string; password?: string;
  }) => devLoginSigned(
    LICENSE_PUBLIC_KEY, data?.nonce, data?.signature, data?.password ?? '',
  ));

  ipcMain.handle('dev:logout', async (_event, data: { devToken?: string }) => {
    revokeDevToken(data?.devToken);
    return { success: true };
  });

  // NOTE: the previous `sidebar:repairConfig` implementation called
  // `webContents.executeJavaScript(...)` from the main process to rewrite
  // localStorage. That is an arbitrary-code-execution pattern with no upside —
  // the sidebar config lives in the renderer, so the renderer repairs it
  // locally now (see sidebar.store.ts `repairConfig`). Channel removed.
  // Get all settings
  /**
   * SECURITY: this channel is reachable BEFORE login (the login screen needs
   * the shop name/logo), so it must never return secrets. Cloud credentials
   * and sync tokens live in the same table and were previously handed to any
   * caller. Use `db:getCloudSettings` (permission-gated) for those.
   */
  ipcMain.handle('settings:getAll', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT Key, Value FROM settings
      WHERE Key NOT LIKE 'cloud_%'
        AND Key NOT LIKE 'sync_%'
        AND Key NOT LIKE 'telegram_%'
        AND Key NOT IN (
          'db_path',
          -- Personal data about the owner, added with the registration fields.
          -- This channel is PUBLIC: it must answer before anyone logs in so the
          -- login screen can render the shop branding. Returning a date of
          -- birth and a verified phone number to an unauthenticated caller is
          -- a privacy leak, and none of it is needed to draw that screen.
          'owner_birth_date', 'phone_verified', 'phone_verified_at',
          'registration_consent', 'registered_at'
        )
    `).all() as any[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.Key] = row.Value;
    }

    // Layer the developer's remote values on top of the local ones.
    // `getRemoteOverrides` only ever returns keys from the client-side
    // allow-list, so this cannot silently change an accounting setting.
    for (const [key, value] of Object.entries(getRemoteOverrides())) {
      settings[key] = value;
    }
    return settings;
  });

  /**
   * Keys that must never be readable through the public settings channels.
   *
   * `settings:get` and `settings:getAll` are PUBLIC — they have to be, because
   * the login screen renders the shop's branding before anyone signs in. But
   * `settings:get` returned ANY key it was asked for by name, so an
   * unauthenticated renderer could read `cloud_api_key`, and would have been
   * able to read the Telegram bot token. Both are bearer credentials: holding
   * one is the same as holding the account.
   *
   * `settings:getAll` filters the same families in its WHERE clause. The
   * secrets are still reachable by the screens that own them, through the
   * permission-gated `db:getCloudSettings` / `telegram:getSettings`.
   */
  const PRIVATE_KEYS = new Set([
    'db_path',
    'owner_birth_date', 'phone_verified', 'phone_verified_at',
    'registration_consent', 'registered_at',
  ]);

  const isSecretKey = (key: unknown): boolean =>
    typeof key === 'string'
    && (/^cloud_/.test(key) || /^sync_/.test(key) || /^telegram_/.test(key)
        || PRIVATE_KEYS.has(key));

  // Get single setting
  ipcMain.handle('settings:get', async (_event, key: string) => {
    if (isSecretKey(key)) return null;
    const db = getDb();
    const row = db.prepare('SELECT Value FROM settings WHERE Key = ?').get(key) as any;
    return row?.Value ?? null;
  });

  // Set setting
  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)').run(key, value);
    // Writing a key the developer currently controls would appear to work and
    // then silently revert on the next sync, so say so explicitly.
    if (isRemoteManaged(key) && key in getRemoteOverrides()) {
      return { success: true, overriddenRemotely: true,
        message: 'تم الحفظ محلياً، لكن هذا الحقل يديره المطور وسيُستبدل عند المزامنة' };
    }
    return { success: true };
  });

  // Set multiple settings
  ipcMain.handle('settings:setMany', async (_event, settings: Record<string, string>) => {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        stmt.run(key, value);
      }
    });
    tx();
    return { success: true };
  });

  // ===== FIRST-RUN SETUP =====
  ipcMain.handle('setup:isComplete', async () => {
    const db = getDb();
    const row = db.prepare("SELECT Value FROM settings WHERE Key = 'setup_completed'").get() as any;
    return { complete: row?.Value === '1' };
  });

  /**
   * SECURITY: unauthenticated (first-run wizard) and it wrote ARBITRARY setting
   * keys, so a caller could flip `allow_negative_stock`, rewrite
   * `owner_capital`, or repoint `db_path`. It is now closed after setup and
   * restricted to the company-profile keys the wizard actually collects.
   */
  const SETUP_ALLOWED_KEYS = new Set([
    'company_name', 'owner_name', 'phone', 'email', 'address',
    'tax_number', 'logo_path', 'currency', 'app_name',
  ]);

  ipcMain.handle('setup:complete', async (_event, data: Record<string, string>) => {
    const db = getDb();
    const done = db.prepare("SELECT Value FROM settings WHERE Key = 'setup_completed'").get() as any;
    if (done?.Value === '1') {
      return { success: false, message: 'تم إعداد النظام بالفعل' };
    }
    const rejected = Object.keys(data || {}).filter(k => !SETUP_ALLOWED_KEYS.has(k));
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(data || {})) {
        if (!SETUP_ALLOWED_KEYS.has(key)) continue;
        db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)').run(key, String(value ?? ''));
      }
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('setup_completed', '1')").run();
    });
    tx();
    if (rejected.length) console.warn('[Setup] ignored non-profile keys:', rejected.join(', '));
    return { success: true };
  });

  // ===== FIRST-RUN INITIALIZATION =====
  ipcMain.handle('setup:initialize', async (_event, data: {
    company: {
      companyName: string; ownerName: string; phone: string; email: string;
      address: string; taxNumber: string;
      governorate?: string; city?: string; birthDate?: string;
      shareWithDeveloper?: boolean;
    };
    customer: { name: string; phone: string; email: string; address: string };
    admin: { username: string; password: string; employeeName: string; position: string; phone: string };
  }) => {
    const db = getDb();

    // SECURITY: this channel is callable without authentication (it runs the
    // first-run wizard) AND it upserts the admin password
    // (ON CONFLICT ... DO UPDATE SET PasswordHash). Without this guard anyone
    // able to reach IPC could re-run it with username 'admin' and take over the
    // account. Once setup is done, it is permanently closed.
    const done = db.prepare("SELECT Value FROM settings WHERE Key = 'setup_completed'").get() as any;
    if (done?.Value === '1') {
      return { success: false, message: 'تم إعداد النظام بالفعل - استخدم صفحة المستخدمين لتغيير كلمة المرور' };
    }

    const company = data.company;
    const customer = data.customer;
    const admin = data.admin;

    if (!admin?.username?.trim() || typeof admin.password !== 'string' || admin.password.length < 6) {
      return { success: false, message: 'اسم المستخدم مطلوب وكلمة المرور 6 أحرف على الأقل' };
    }

    // Validated HERE, not only in the wizard. The renderer can be modified or
    // bypassed entirely — this channel is reachable before any login — so the
    // rules have to be enforced where they cannot be skipped. Same module the
    // wizard uses, so the two can never disagree about what is acceptable.
    const problems = validateRegistration({
      companyName: company?.companyName,
      ownerName: company?.ownerName,
      phone: company?.phone,
      email: company?.email,
      governorate: company?.governorate,
      city: company?.city,
      address: company?.address,
      birthDate: company?.birthDate,
    });
    if (problems.length > 0) {
      return { success: false, message: problems.map(p => p.message).join(' • '), problems };
    }

    const tx = db.transaction(() => {
      // Save company settings
      const settings = {
        'app_name': 'موبايل شوب سيستم',
        'company_name': company.companyName,
        'owner_name': company.ownerName,
        'phone': company.phone,
        'email': company.email,
        'address': company.address,
        'tax_number': company.taxNumber,
        'governorate': company.governorate || '',
        'city': company.city || '',
        'owner_birth_date': company.birthDate || '',
        'registered_at': new Date().toISOString(),
        'registration_consent': company.shareWithDeveloper ? '1' : '0',
      };
      for (const [key, value] of Object.entries(settings)) {
        db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)').run(key, value);
      }

      // Create admin user (update password if user exists)
      const hash = bcrypt.hashSync(admin.password, 10);
      db.prepare(`
        INSERT INTO users (Username, PasswordHash, EmployeeID, RoleID, IsActive)
        VALUES (?, ?, NULL, 1, 1)
        ON CONFLICT(Username) DO UPDATE SET PasswordHash = excluded.PasswordHash
      `).run(admin.username, hash);

      // Create initial customer if name provided
      if (customer.name.trim()) {
        db.prepare(`
          INSERT INTO customers (Name, Phone, Email, Address, Status)
          VALUES (?, ?, ?, ?, 'active')
        `).run(customer.name.trim(), customer.phone?.trim() || null, customer.email?.trim() || null, customer.address?.trim() || null);
      }

      // Mark setup complete
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('setup_completed', '1')").run();
    });
    tx();

    // Tell the developer who registered — only with explicit consent.
    //
    // Deliberately AFTER the transaction commits and deliberately not awaited:
    // the shop is now set up, and a slow or unreachable server must not delay
    // or fail the wizard. Personal data is involved, so silence is the default
    // and the checkbox is the only thing that turns it on.
    if (company.shareWithDeveloper) {
      void notifyDeveloperOfRegistration({
        companyName: company.companyName,
        ownerName: company.ownerName,
        phone: company.phone,
        email: company.email,
        governorate: company.governorate || '',
        city: company.city || '',
        address: company.address,
        birthDate: company.birthDate || '',
      });
    }

    return { success: true };
  });

  // ===== RESET DATABASE (WIPE ALL DATA) =====
  // ===== DATABASE RESET =====
  //
  // The most destructive action in the program: it erases the entire trading
  // history. Three independent proofs are required before a single row goes.
  //
  //   1. the caller's own password           — proves who is at the keyboard
  //   2. a code on the shop's Telegram        — proves control of the owner's
  //                                             phone, which a passer-by who
  //                                             saw a password typed does not
  //                                             have
  //   3. a verified backup on disk            — proves the data is recoverable
  //                                             BEFORE it is destroyed
  //
  // Steps 1 and 2 are separate IPC calls on purpose. The code is only sent
  // after the password is verified, so an attacker cannot spam the owner's
  // phone with reset prompts without first knowing a valid password.

  /** Reads the SHOP's own Telegram bot. Never the developer's. */
  const shopTelegram = (): { botToken: string; chatId: string } | null => {
    const db = getDb();
    const rows = db.prepare(
      "SELECT Key, Value FROM settings WHERE Key IN ('telegram_bot_token','telegram_chat_id')",
    ).all() as any[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.Key] = r.Value;
    if (!map.telegram_bot_token || !map.telegram_chat_id) return null;
    return { botToken: map.telegram_bot_token, chatId: map.telegram_chat_id };
  };

  const shopName = (): string => {
    const row = getDb().prepare("SELECT Value FROM settings WHERE Key = 'company_name'").get() as any;
    return row?.Value || '';
  };

  /** True when the shop can receive a confirmation code at all. */
  /**
   * Choose a shop logo and return it as a data URL.
   *
   * Stored inline rather than as a filesystem path, deliberately:
   *   - a path breaks the moment the database is restored on another machine,
   *     or moved to a shared network folder, and the invoice silently loses its
   *     logo with no error anywhere;
   *   - a data URL travels inside the backup, so a restored shop keeps its
   *     branding.
   *
   * Size is capped because this ends up in every settings read. A logo is a
   * small image; anything larger is a photograph chosen by mistake.
   */
  ipcMain.handle('settings:pickLogo', async () => {
    const result = await dialog.showOpenDialog({
      title: 'اختر صورة الشعار',
      filters: [{ name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: '' };
    }

    const file = result.filePaths[0];
    try {
      const stat = fs.statSync(file);
      const MAX_BYTES = 512 * 1024;
      if (stat.size > MAX_BYTES) {
        return {
          success: false,
          message: `حجم الصورة ${(stat.size / 1024).toFixed(0)} كيلوبايت - الحد الأقصى 512 كيلوبايت`,
        };
      }

      const bytes = fs.readFileSync(file);
      // Identify the type from the file's own bytes, not its extension: a
      // renamed file must not be embedded with a mime type that lies.
      const sig = bytes.subarray(0, 12);
      let mime = '';
      if (sig[0] === 0x89 && sig[1] === 0x50) mime = 'image/png';
      else if (sig[0] === 0xff && sig[1] === 0xd8) mime = 'image/jpeg';
      else if (sig.subarray(0, 4).toString('ascii') === 'RIFF'
               && sig.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
      else if (sig.subarray(0, 3).toString('ascii') === 'GIF') mime = 'image/gif';
      if (!mime) return { success: false, message: 'الملف المختار ليس صورة صالحة' };

      return { success: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    } catch (err: any) {
      return { success: false, message: `تعذّر قراءة الصورة: ${err?.message || err}` };
    }
  });

  /**
   * Confirm the shop's phone number through its own Telegram bot.
   *
   * Reachable during first-run setup, so it cannot require a session. It sends
   * nothing anywhere except the shop's own bot, and it only ever reports
   * whether the number the shop typed was confirmed.
   */
  ipcMain.handle('phone:verify', async (_event, data: { phone?: unknown }) => {
    const target = shopTelegram();
    if (!target) {
      return {
        success: false,
        message: 'لتأكيد الرقم اضبط بوت تليجرام أولاً من الإعدادات ← النسخ الاحتياطي',
      };
    }
    const result = await verifyPhoneViaTelegram(target, String(data?.phone ?? ''));
    if (result.success) {
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)')
        .run('phone_verified', result.phone || '');
      db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)')
        .run('phone_verified_at', new Date().toISOString());
    }
    return result;
  });

  ipcMain.handle('settings:resetIsAvailable', async () => ({
    available: shopTelegram() !== null,
  }));

  /**
   * Step 1 — verify the password, then send a confirmation code.
   *
   * The code is never returned here; it goes only to the shop's Telegram.
   */
  ipcMain.handle('settings:resetRequestCode', async (_event, data: { userId: number; password: string }) => {
    const db = getDb();
    const user = db.prepare('SELECT UserID, Username, PasswordHash FROM users WHERE UserID = ?')
      .get(data?.userId) as any;
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    if (!bcrypt.compareSync(String(data?.password ?? ''), user.PasswordHash)) {
      return { success: false, message: 'كلمة المرور غير صحيحة' };
    }

    const target = shopTelegram();
    if (!target) {
      return {
        success: false,
        message: 'لا يمكن التصفير قبل ضبط بوت تليجرام - اضبطه من الإعدادات ← النسخ الاحتياطي',
      };
    }

    return requestCode(
      'database_reset',
      target,
      Number(data.userId),
      `\u26a0\ufe0f\u0637\u0644\u0628 \u062a\u0635\u0641\u064a\u0631 \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a`,
    );
  });

  /**
   * Step 2 — password + code, snapshot, wipe, alert.
   *
   * Order matters and is asserted by the test suite: the backup is taken and
   * VERIFIED readable before anything is deleted, because a snapshot nobody
   * checked is not a safety net.
   */
  ipcMain.handle('settings:resetDatabase', async (_event, data: { userId: number; password: string; code?: string }) => {
    const db = getDb();

    // Proof 1: the password, re-verified here. Step 1 is not trusted to have
    // happened — each handler must stand on its own.
    const user = db.prepare('SELECT UserID, Username, PasswordHash FROM users WHERE UserID = ?')
      .get(data?.userId) as any;
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    if (!bcrypt.compareSync(String(data?.password ?? ''), user.PasswordHash)) {
      return { success: false, message: 'كلمة المرور غير صحيحة' };
    }

    // Proof 2: the Telegram code, bound to the user who requested it.
    const code = String(data?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      return { success: false, message: 'أدخل رمز التحقق المرسل على تليجرام (٦ أرقام)' };
    }
    const verified = verifyCode('database_reset', Number(data.userId), code);
    if (!verified.success) {
      recordSecurityEvent(db, 'database_reset_rejected', user.UserID, user.Username,
        `محاولة تصفير فاشلة: ${verified.message}`);
      return { success: false, message: verified.message };
    }

    // Proof 3: a snapshot that is proven readable before the wipe.
    let backupPath = '';
    try {
      const backupDir = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(backupDir, `before_reset_${stamp}.db`);
      await db.backup(backupPath);

      // Verify it: `db.backup()` reporting success is not the same as a file
      // that can be opened. A backup taken and never checked is exactly the
      // backup that turns out to be unreadable on the day it is needed.
      const stat = fs.statSync(backupPath);
      if (stat.size < 1024) throw new Error('حجم النسخة غير معقول');
      const header = Buffer.alloc(16);
      const fd = fs.openSync(backupPath, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
        throw new Error('النسخة الناتجة ليست قاعدة بيانات صالحة');
      }
    } catch (err: any) {
      return { success: false, message: `تعذّر إنشاء نسخة احتياطية قبل التصفير: ${err?.message || err}` };
    }

    // Tables to preserve (system config only)
    const systemTables = ['users', 'roles', 'role_permissions', 'permissions', 'settings', 'fiscal_years'];

    // Get all user tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[];

    // Foreign keys are switched off OUTSIDE the transaction, and this matters.
    //
    // `PRAGMA foreign_keys` is a NO-OP while a transaction is open — SQLite
    // silently ignores it and returns no error. A previous version issued it
    // as the first statement INSIDE `db.transaction(...)`, so enforcement
    // stayed ON for the whole wipe. Tables are deleted alphabetically, which
    // reaches `customers` before `sales`; the orphaned reference threw, the
    // transaction rolled back, and NOTHING was deleted while the screen showed
    // "فشل تصفير قاعدة البيانات".
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      // Still one transaction: a failure part-way must not leave the shop with
      // half its history deleted.
      db.transaction(() => {
        for (const t of tables) {
          if (!systemTables.includes(t.name)) {
            db.exec(`DELETE FROM "${t.name}"`);
          }
        }
      })();
    } catch (err: any) {
      return { success: false, message: `تعذّر تصفير قاعدة البيانات: ${err?.message || err}` };
    } finally {
      // Restore enforcement whatever happened. Leaving it off would let every
      // later screen write orphaned rows into a database that looks healthy.
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }

    // Durable local record first — it must exist even if every network is down.
    recordSecurityEvent(db, 'database_reset', user.UserID, user.Username,
      `تصفير قاعدة البيانات - النسخة الاحتياطية: ${path.basename(backupPath)}`);

    // Then the two alerts, both best-effort: the data is already gone, so a
    // failed notification must not report the reset itself as failed.
    void notifyDatabaseReset(shopTelegram(), String(user.Username || ''), shopName(), backupPath);
    void notifyDeveloperOfReset(shopName(), String(user.Username || ''));

    return {
      success: true,
      message: `تم تصفير قاعدة البيانات - النسخة الاحتياطية محفوظة باسم ${path.basename(backupPath)}`,
      backupPath,
    };
  });
}
