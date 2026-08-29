import { ipcMain, app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getDb, closeDb, getDbPath } from '../database/connection';
import { migrateWithSafetyNet, SchemaTooNewError } from '../database/schemaVersion';
import { runMigrations } from '../database/migrations';
import { safeFailure } from '../security/errorResponse';
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
import { checkAttemptAllowed, recordAttemptFailure, recordAttemptSuccess, lockoutMessage } from '../security/loginThrottle';
import { stripControlChars, LIMITS } from '../../shared/validate';

/**
 * Verifies a candidate file can safely become the shop's books, in the same
 * order `backup:restore` verifies a backup: SQLite header, full integrity
 * walk, then "is it THIS application's database". The file is opened read-only
 * and never written, so checking cannot damage it.
 */
async function verifyImportableDatabase(file: string): Promise<{ ok: boolean; reason: string }> {
  interface Probe {
    pragma: (s: string) => unknown;
    prepare: (s: string) => { get: (...a: unknown[]) => unknown };
    close: () => void;
  }
  let probe: Probe | null = null;
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
      return { ok: false, reason: 'الملف ليس قاعدة بيانات SQLite' };
    }

    const { default: Database } = await import('better-sqlite3');
    probe = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Probe;
    const result = probe.pragma('integrity_check');
    const rows = Array.isArray(result) ? result : [result];
    const first = rows[0] as { integrity_check?: string } | string | undefined;
    const verdict = typeof first === 'string' ? first : first?.integrity_check;
    if (verdict !== 'ok') {
      return { ok: false, reason: String(verdict ?? 'فحص السلامة فشل').slice(0, 120) };
    }

    const row = probe.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sales','purchases','customers','items')",
    ).get() as { n?: number } | undefined;
    if ((row?.n ?? 0) < 4) {
      return { ok: false, reason: 'قاعدة بيانات سليمة لكنها ليست قاعدة بيانات هذا البرنامج' };
    }
    return { ok: true, reason: '' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message.slice(0, 120) };
  } finally {
    try { probe?.close(); } catch { /* already closed */ }
  }
}

export function registerSettingsHandlers() {
  // The real installed version. The About page used to read the `app_version`
  // Reports the REAL running code version. `app.getVersion()` reads the
  // version stamped into the exe by the NSIS installer, which does NOT
  // change when a code push swaps app.asar. After a fast-lane update the
  // exe still says 1.0.11 but app.asar says 1.0.26 — the About page showed
  // the wrong version to customers. Fix: read package.json from app.asar
  // directly, falling back to app.getVersion() if the read fails.
  ipcMain.handle('app:getVersion', async () => {
    try {
      // app.getAppPath() points to app.asar in a packaged build.
      const pkgPath = path.join(app.getAppPath(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return String(pkg.version || app.getVersion());
    } catch {
      return app.getVersion();
    }
  });

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

  /**
   * Keys the settings screens may NOT write.
   *
   * `settings:get` already refuses to READ these. Writing them was wide open,
   * which is the asymmetry this closes: closing the door and leaving the
   * window is not a control.
   *
   * MEASURED against the real handler — every one of these succeeded and was
   * stored:
   *
   *   settings:set('db_path', 'PWNED')
   *       Repoints the database. `db:switchToShared` writes this key
   *       deliberately, after validating the folder and copying the file; a
   *       raw write points the next launch at a path that does not exist.
   *
   *   settings:set('cloud_api_key', 'PWNED')
   *   settings:set('telegram_bot_token', 'PWNED')
   *       Bearer credentials. `settings:get` hides them behind `isSecretKey`
   *       precisely because holding one is holding the account — but they
   *       could be OVERWRITTEN, which silently breaks backups and, in the
   *       Telegram case, lets a caller redirect the shop's alerts to a bot
   *       they control.
   *
   *   settings:set('setup_completed', '0')
   *       Re-opens `setup:complete`, which is unauthenticated by design.
   *
   *   settings:set('owner_capital', '999999')
   *       The equity figure the balance sheet is built on. It has its own
   *       permission-gated channel (`capital:set`); this bypassed it.
   *
   * Each of these has a proper channel that does the accompanying work. The
   * generic key/value setter is for the ordinary preferences the settings
   * screens edit, and that is now all it can reach.
   *
   * NOT IN THIS LIST, DELIBERATELY: the four `allow_negative_*` switches.
   * They ARE dangerous — `allow_negative_stock` turns off the check that stops
   * a sale of goods the shop does not have — but they are also four real
   * checkboxes on the General Settings tab, owned by the shop and saved
   * through `settings:setMany` behind the `settings.edit` permission. Blocking
   * them here would have broken a working feature to close a hole that the
   * permission already governs. What they get instead is a VALUE check below,
   * so the switch can only ever hold "0" or "1" — an unrecognised value read
   * by `allowNeg?.Value !== '1'` is not a third state, it is an accident
   * waiting to be interpreted.
   */
  const UNWRITABLE_KEYS = new Set([
    'db_path',
    'setup_completed',
    'owner_capital',
    'phone_verified',
    'phone_verified_at',
    'registration_consent',
    'registered_at',
    'license_summary',
  ]);

  /**
   * Keys whose value must be exactly "0" or "1".
   *
   * These drive `if (setting?.Value !== '1')` branches all over the trading
   * handlers, so anything else silently means "off" while the checkbox that
   * wrote it may well be showing as on.
   */
  const BOOLEAN_KEYS = new Set([
    'allow_negative_stock',
    'allow_negative_cash',
    'allow_negative_customer',
    'allow_negative_supplier',
    'vat_enabled',
  ]);

  /**
   * Maximum stored size for a value (in CHARACTERS). `logo_path` carries a
   * base64 data URL, so a 512 KB image becomes ~680 KB of text — far past the
   * generic 20,000-char cap that fits normal preferences. It gets its own,
   * matching the image-size cap in settings:pickLogo (512 KB -> ~683 KB base64
   * + the `data:image/png;base64,` prefix).
   */
  const LOGO_VALUE_LIMIT = 1024 * 1024; // characters, ~= a 768 KB image

  /**
   * True for a key the generic setter must refuse.
   *
   * The `cloud_`, `sync_` and `telegram_` families are matched by PREFIX, the
   * same way `isSecretKey` matches them for reading, so a credential added
   * later is covered without anyone remembering to add it here.
   */
  const isUnwritableKey = (key: string): boolean =>
    UNWRITABLE_KEYS.has(key)
    || /^cloud_/.test(key) || /^sync_/.test(key) || /^telegram_/.test(key);

  /**
   * Validates one key/value pair for the generic setters.
   *
   * The key shape is restricted as well as the key NAME. Settings are read
   * with `WHERE Key = ?` and rendered into the settings screens, and a key of
   * 100,000 characters was measured being stored — that is a row nobody can
   * see, delete or explain.
   */
  const checkSetting = (key: unknown, value: unknown): string | null => {
    if (typeof key !== 'string' || !key.trim()) return 'مفتاح الإعداد مطلوب';
    if (key.length > LIMITS.SETTING_KEY) return 'مفتاح الإعداد أطول من الحد المسموح';
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) return 'مفتاح الإعداد غير صالح';
    if (isUnwritableKey(key)) {
      return 'هذا الإعداد لا يمكن تغييره من هنا - استخدم الشاشة المخصصة له';
    }
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return 'قيمة الإعداد يجب أن تكون نصاً';
    }
    if (String(value).length > LIMITS.SETTING_VALUE
        && !(key === 'logo_path' && String(value).length <= LOGO_VALUE_LIMIT)) {
      return 'قيمة الإعداد أطول من الحد المسموح';
    }
    if (BOOLEAN_KEYS.has(key) && String(value) !== '0' && String(value) !== '1') {
      return 'قيمة هذا الإعداد يجب أن تكون 0 أو 1';
    }
    return null;
  };

  // Set setting
  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    const db = getDb();
    const problem = checkSetting(key, value);
    if (problem) return { success: false, message: problem };
    // Control characters are stripped for the same reason as everywhere else:
    // these values are printed on invoices and written into CSV exports.
    value = stripControlChars(String(value ?? ''));
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
    // The bulk setter is the same hole as the single one, reached in a loop —
    // and it is the one the settings screens actually use, so it needed the
    // identical rule rather than a weaker one.
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return { success: false, message: 'بيانات الإعدادات غير صالحة' };
    }
    const entries = Object.entries(settings);
    if (entries.length > 200) {
      return { success: false, message: 'عدد الإعدادات أكبر من الحد المسموح' };
    }
    // Every pair is checked BEFORE anything is written, so a rejected key
    // cannot leave half the batch applied.
    for (const [key, value] of entries) {
      const problem = checkSetting(key, value);
      if (problem) return { success: false, message: `${key}: ${problem}` };
    }
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (const [key, value] of entries) {
        stmt.run(key, stripControlChars(String(value ?? '')));
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
    };
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
        // No consent flag anymore: the owner is always told — but only after
        // they finish setup, best-effort and unreachable-offline. The key is
        // kept for the settings privacy list + devices screen.
        'registration_consent': '1',
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

      // RETIRE THE SEEDED DEFAULT ACCOUNT.
      //
      // `seedData` creates `admin` / `admin123` so a fresh database is usable
      // before the wizard runs. The upsert above only replaces that account
      // when the owner happens to choose the SAME username — and the wizard
      // invites them to choose their own.
      //
      // MEASURED: after a complete, successful setup as `mohamed`, logging in
      // as `admin` / `admin123` still succeeded with full administrator
      // rights. A published default credential is the first thing anyone
      // tries, and it would have shipped on every install.
      //
      // Deactivated rather than deleted: `UserID = 1` is referenced by seeded
      // rows and by any document created before the wizard ran, and deleting
      // it would either fail on the foreign key or orphan those records. An
      // inactive user cannot log in — `auth:login` filters on `IsActive = 1` —
      // and the password is scrambled as well, so even re-activating it by
      // hand does not restore a known credential.
      if (admin.username !== 'admin') {
        const seeded = db.prepare(
          "SELECT UserID FROM users WHERE Username = 'admin'").get() as any;
        if (seeded) {
          db.prepare('UPDATE users SET IsActive = 0, PasswordHash = ? WHERE UserID = ?')
            .run(bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10), seeded.UserID);
        }
      }

      // Create initial customer if name provided
      // (REMOVED: the first-run wizard no longer asks for a customer. A shop
      //  that already has customers creates them from the Customers screen when
      //  it needs them — the wizard must not invent a trading history.)

      // Mark setup complete
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('setup_completed', '1')").run();
    });
    tx();

    // Tell the developer who registered. There is no consent checkbox for this
    // anymore — training a new shop is easier when one can see it exists. The
    // message is deliberately small (profile only, never books), best-effort
    // and time-limited, so an offline shop is simply not registered until a
    // later launch and never sees an error.
    //
    // Deliberately AFTER the transaction commits and deliberately not awaited:
    // the shop is now set up, and a slow or unreachable server must not delay
    // or fail the wizard.
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

    return { success: true };
  });

  // ===== FIRST-RUN: IMPORT AN EXISTING DATABASE =====
  //
  // For the shop that reinstalled Windows (or moved to a new machine) with an
  // old copy of `mobile_shop.db`: instead of filling the setup wizard from
  // scratch, the owner can point at the database that already holds their
  // customers, invoices and balances. The file is verified, the fresh empty
  // database is replaced by it, and the schema is brought up to the current
  // version the same way a normal upgrade would.
  //
  // PUBLIC on purpose — it runs before the first login, inside the wizard.
  ipcMain.handle('setup:importDatabase', async () => {
    const db = getDb();

    // Only reachable while setup has not completed. A shop that is already
    // running must not silently swap its live books from here.
    const done = db.prepare("SELECT Value FROM settings WHERE Key = 'setup_completed'").get() as any;
    if (done?.Value === '1') {
      // The shop already has live books on this machine. Importing would swap
      // them without a second thought — the proper tool there is `backup:restore`
      // from behind the login, which takes the same path deliberately.
      return { success: false, message: 'هذا الجهاز مُعدّ بالفعل - استخدم استعادة النسخة الاحتياطية من داخل البرنامج' };
    }

    const result = await dialog.showOpenDialog({
      title: 'استيراد قاعدة البيانات من نسخة سابقة',
      filters: [{ name: 'Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'تم الإلغاء' };
    }
    const importPath = result.filePaths[0];
    const livePath = getDbPath();
    if (path.resolve(importPath) === path.resolve(livePath)) {
      return { success: false, message: 'اختر ملف نسخة احتياطية منفصلاً عن قاعدة البيانات الحالية' };
    }

    // Verify the file is a real, intact MobileShopERP database. Same order as
    // `backup:restore`: header, integrity, ownership. A file that passes all
    // three is safe to adopt as the shop's books.
    const probe = await verifyImportableDatabase(importPath);
    if (!probe.ok) {
      return { success: false, message: `الملف غير صالح للاستيراد (${probe.reason})` };
    }

    // The fresh database created for this install is a deployment artifact,
    // not data — but keep a copy anyway, in the same backups folder the app
    // already watches, on the off chance the import is regretted.
    let freshBackup = '';
    try {
      const dir = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
      freshBackup = path.join(dir, `pre_import_${stamp}.db`);
      db.exec(`VACUUM INTO '${freshBackup.replace(/'/g, "''")}'`);
    } catch { /* best effort — a fresh empty database has nothing of value */ }

    closeDb();

    try {
      // Adopt the imported file as the live database, then drop any stale
      // WAL/SHM that belonged to the fresh file — SQLite would otherwise try
      // to replay them on top of the imported rows.
      fs.copyFileSync(importPath, livePath);
      for (const suffix of ['-wal', '-shm']) {
        const p = `${livePath}${suffix}`;
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      }

      // Bring the imported schema up to the current version. An imported file
      // almost always came from an older build; the safety net takes a
      // `pre_upgrade_v*` snapshot first and restores it if the migration blows
      // up, exactly as it would on a normal launch.
      const reopened = getDb();
      const upgrade = migrateWithSafetyNet(reopened, app.getPath('userData'), runMigrations);
      if (upgrade.error) {
        // The detail is logged for diagnostics, never shown to the user: this
        // channel is reachable before login, and raw errors leak paths and SQL.
        console.error('[Import] migration failed:', upgrade.error);
        return {
          success: false,
          message: 'تعذر ترقية قاعدة البيانات المستوردة إلى الإصدار الحالي - ستحتفظ بنسختك القديمة، أعد المحاولة بنسخة أحدث من البرنامج',
        };
      }

      const importedDone = reopened.prepare(
        "SELECT Value FROM settings WHERE Key = 'setup_completed'").get() as any;
      return {
        success: true,
        message: 'تم استيراد قاعدة البيانات بنجاح - سيُعاد التشغيل الآن',
        setupComplete: importedDone?.Value === '1',
      };
    } catch (err: any) {
      return safeFailure('setup:importDatabase', err, 'تعذر استيراد قاعدة البيانات');
    }
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
      return safeFailure('settings:pickLogo', err, 'تعذّر قراءة الصورة');
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
    // BRUTE FORCE. Step 1 of wiping the shop's entire database. The password
    // was compared with no counter: measured at ~13 guesses/second, unlimited.
    // Shares the 'dangerous' scope with the export and reset-password prompts,
    // so an attacker cannot simply move between them after being locked out of
    // one.
    const throttleId = `user:${data?.userId}`;
    const locked = checkAttemptAllowed('dangerous', throttleId);
    if (locked) {
      return { success: false, code: 'LOCKED_OUT', message: lockoutMessage(locked.lockedForSec) };
    }

    const user = db.prepare('SELECT UserID, Username, PasswordHash FROM users WHERE UserID = ?')
      .get(data?.userId) as any;
    if (!user) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'المستخدم غير موجود' };
    }
    if (!bcrypt.compareSync(String(data?.password ?? ''), user.PasswordHash)) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'كلمة المرور غير صحيحة' };
    }
    recordAttemptSuccess('dangerous', throttleId);

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

    // BRUTE FORCE. Step 2 of wiping the database. Because each handler stands
    // on its own and re-checks the password, this is a second unlimited
    // password oracle — measured at ~13 guesses/second with no counter. The
    // Telegram code below is attempt-limited, but only once the password has
    // been passed, so the password itself needed its own guard.
    const throttleId = `user:${data?.userId}`;
    const locked = checkAttemptAllowed('dangerous', throttleId);
    if (locked) {
      return { success: false, code: 'LOCKED_OUT', message: lockoutMessage(locked.lockedForSec) };
    }

    // Proof 1: the password, re-verified here. Step 1 is not trusted to have
    // happened — each handler must stand on its own.
    const user = db.prepare('SELECT UserID, Username, PasswordHash FROM users WHERE UserID = ?')
      .get(data?.userId) as any;
    if (!user) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'المستخدم غير موجود' };
    }
    if (!bcrypt.compareSync(String(data?.password ?? ''), user.PasswordHash)) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'كلمة المرور غير صحيحة' };
    }
    recordAttemptSuccess('dangerous', throttleId);

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
      return safeFailure('settings:resetDatabase', err, 'تعذّر إنشاء نسخة احتياطية قبل التصفير');
    }

    // Tables to preserve (system config only)
    //
    // `security_events` is on this list for a different reason from the rest.
    // The others are configuration the shop would have to re-enter. The audit
    // trail is preserved because a database reset is ITSELF one of the events
    // it records — a wipe that erased the log would be a wipe with no witness,
    // and the row written a few lines below would be the only survivor of an
    // account of what happened.
    //
    // It is also now enforced by the database: `ck_security_events_no_delete`
    // aborts any DELETE on that table. Leaving it out of this list would make
    // `settings:resetDatabase` fail outright — MEASURED, the trigger refused
    // the wipe and the whole transaction rolled back, so the shop could no
    // longer reset at all. Two layers agreeing is the point; two layers
    // disagreeing is an outage.
    const systemTables = [
      'users', 'roles', 'role_permissions', 'permissions', 'settings',
      'fiscal_years', 'security_events',
    ];

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
      return safeFailure('settings:resetDatabase', err, 'تعذّر تصفير قاعدة البيانات');
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
