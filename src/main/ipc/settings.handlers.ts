import { BrowserWindow, ipcMain } from 'electron';
import { getDb } from '../database/connection';
import bcrypt from 'bcryptjs';

export function registerSettingsHandlers() {
  // Fix sidebar config: clear hidden items from localStorage
  ipcMain.handle('sidebar:repairConfig', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return { success: false, error: 'No window' };
    const result = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const raw = localStorage.getItem('sidebarConfig');
          if (!raw) return { success: false, error: 'No config found' };
          const cfg = JSON.parse(raw);
          const customKeys = Object.keys(cfg.customSections || {});
          const labelKeys = Object.keys(cfg.customLabels || {});
          const allCustom = [...customKeys, ...labelKeys];
          const protectedKeys = ['الإعدادات', '/settings'];
          cfg.hidden = (cfg.hidden || []).filter(h => !allCustom.includes(h) && !protectedKeys.includes(h));
          localStorage.setItem('sidebarConfig', JSON.stringify(cfg));
          return { success: true, data: cfg };
        } catch (e) {
          return { success: false, error: e.message };
        }
      })();
    `);
    return result;
  });
  // Get all settings
  ipcMain.handle('settings:getAll', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT Key, Value FROM settings').all() as any[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.Key] = row.Value;
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

  ipcMain.handle('setup:complete', async (_event, data: Record<string, string>) => {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(data)) {
        db.prepare('INSERT OR REPLACE INTO settings (Key, Value) VALUES (?, ?)').run(key, value);
      }
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('setup_completed', '1')").run();
    });
    tx();
    return { success: true };
  });

  // ===== FIRST-RUN INITIALIZATION =====
  ipcMain.handle('setup:initialize', async (_event, data: {
    company: { companyName: string; ownerName: string; phone: string; email: string; address: string; taxNumber: string };
    customer: { name: string; phone: string; email: string; address: string };
    admin: { username: string; password: string; employeeName: string; position: string; phone: string };
  }) => {
    const db = getDb();
    const company = data.company;
    const customer = data.customer;
    const admin = data.admin;

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
