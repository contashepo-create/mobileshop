import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../database/connection';
import bcrypt from 'bcryptjs';
import { devLogin, revokeDevToken } from '../security/devAuth';
import { getRemoteOverrides } from '../remote/remoteStore';
import { isRemoteManaged } from '../remote/remoteConfig';

export function registerSettingsHandlers() {
  // ===== DEVELOPER AUTHENTICATION =====
  // Verifying developer credentials in the MAIN process (bcrypt + lockout) and
  // handing back a short-lived token. Previously the renderer compared a
  // base64-obfuscated password itself and simply set
  // `sessionStorage.dev_unlocked = 'true'`, which anyone could do from DevTools.
  ipcMain.handle('dev:login', async (_event, data: { username: string; password: string }) => {
    return devLogin(data?.username ?? '', data?.password ?? '');
  });

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
        AND Key NOT IN ('db_path')
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

  // Get single setting
  ipcMain.handle('settings:get', async (_event, key: string) => {
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
    company: { companyName: string; ownerName: string; phone: string; email: string; address: string; taxNumber: string };
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
    return { success: true };
  });

  // ===== RESET DATABASE (WIPE ALL DATA) =====
  ipcMain.handle('settings:resetDatabase', async (_event, data: { userId: number; password: string }) => {
    const db = getDb();

    // Verify password against user record
    const user = db.prepare('SELECT PasswordHash FROM users WHERE UserID = ?').get(data.userId) as any;
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    const valid = bcrypt.compareSync(data.password, user.PasswordHash);
    if (!valid) return { success: false, message: 'كلمة المرور غير صحيحة' };

    // Safety net: this wipes every transactional table, so take a snapshot the
    // user can fall back on. Without it a mis-click is unrecoverable.
    try {
      const backupDir = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await db.backup(path.join(backupDir, `before_reset_${stamp}.db`));
    } catch (err) {
      return { success: false, message: `تعذّر إنشاء نسخة احتياطية قبل التصفير: ${err}` };
    }

    // Tables to preserve (system config only)
    const systemTables = ['users', 'roles', 'role_permissions', 'permissions', 'settings', 'fiscal_years'];

    // Get all user tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[];

    // Delete from all tables except system ones (disabling FK for cross-ref safety)
    const tx = db.transaction(() => {
      db.exec('PRAGMA foreign_keys = OFF');
      for (const t of tables) {
        if (!systemTables.includes(t.name)) {
          db.exec(`DELETE FROM "${t.name}"`);
        }
      }
      db.exec('PRAGMA foreign_keys = ON');
    });

    tx();
    return { success: true, message: 'تم تصفير قاعدة البيانات بنجاح' };
  });
}
