import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';
import { verifyDevToken } from '../security/devAuth';
import { destroyAllSessionsForUser } from '../security/session';
import { requestResetCode, verifyResetCode, notifyResetDone } from '../security/passwordRecovery';
import { recordSecurityEvent } from '../security/securityLog';


/**
 * The role that can administer the system. Seeded first, so RoleID 1.
 *
 * A shop must never be able to lock itself out of its own books: if the last
 * account that can manage users is deactivated or demoted, nobody can add
 * users, fix permissions or reach the settings again, and the only way back is
 * editing the database by hand.
 *
 * Measured before this guard existed: `users:delete` on the only administrator
 * returned `{ success: true }` and left zero active administrators.
 */

/**
 * Minimum password length, matching the first-run wizard.
 *
 * `setup:initialize` already refuses anything under six characters, but
 * `users:create` and `users:update` enforced nothing at all: an account could
 * be created with an EMPTY password. Login rejects a blank password, so such
 * an account cannot be used — the practical result is a user who exists, fills
 * a licence seat, appears in every dropdown, and can never sign in, with no
 * explanation offered to whoever created them.
 *
 * Validating in one place per rule is the point: the wizard and the users
 * screen must not disagree about what a valid password is.
 */
const MIN_PASSWORD_LENGTH = 6;

function checkPassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || !pw.trim()) return 'كلمة المرور مطلوبة';
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`;
  }
  return null;
}

const ADMIN_ROLE_ID = 1;

/** How many administrators would remain if `excludeUserId` stopped being one. */
function otherActiveAdmins(db: ReturnType<typeof getDb>, excludeUserId: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) n FROM users WHERE RoleID = ? AND IsActive = 1 AND UserID != ?',
  ).get(ADMIN_ROLE_ID, excludeUserId) as any;
  return Number(row?.n) || 0;
}

export function registerUsersHandlers() {
  // List users
  ipcMain.handle('users:list', async () => {
    const db = getDb();
    return db.prepare(`
      SELECT u.UserID, u.Username, u.IsActive, u.EmployeeID, u.RoleID,
             e.Name as EmployeeName, r.RoleName
      FROM users u
      LEFT JOIN employees e ON u.EmployeeID = e.EmployeeID
      LEFT JOIN roles r ON u.RoleID = r.RoleID
      ORDER BY u.Username ASC
    `).all();
  });

  // Create user
  ipcMain.handle('users:create', async (_event, data: { username: string; password: string; employeeId?: number; roleId: number }) => {
    const db = getDb();
    if (typeof data?.username !== 'string' || !data.username.trim()) {
      return { success: false, message: 'اسم المستخدم مطلوب' };
    }
    const pwProblem = checkPassword(data?.password);
    if (pwProblem) return { success: false, message: pwProblem };

    const existing = db.prepare('SELECT UserID FROM users WHERE Username = ?').get(data.username);
    if (existing) {
      return { success: false, message: 'اسم المستخدم موجود بالفعل' };
    }
    const hash = bcrypt.hashSync(data.password, 10);
    const result = db.prepare(`
      INSERT INTO users (Username, PasswordHash, EmployeeID, RoleID, IsActive)
      VALUES (?, ?, ?, ?, 1)
    `).run(data.username, hash, data.employeeId ?? null, data.roleId);
    return { success: true, id: result.lastInsertRowid };
  });

  // Update user
  ipcMain.handle('users:update', async (_event, id: number, data: { username?: string; password?: string; employeeId?: number; roleId?: number; isActive?: number }) => {
    const db = getDb();

    // The same lockout applies to an EDIT: demoting the last administrator to
    // a salesperson, or switching them inactive, removes the last account that
    // can manage the system just as surely as deleting it.
    const current = db.prepare('SELECT RoleID, IsActive FROM users WHERE UserID = ?').get(id) as any;
    if (!current) return { success: false, message: 'المستخدم غير موجود' };
    const nextRole = data.roleId ?? 1;
    const nextActive = data.isActive ?? 1;
    const wasAdmin = current.RoleID === ADMIN_ROLE_ID && current.IsActive;
    const staysAdmin = nextRole === ADMIN_ROLE_ID && nextActive;
    if (wasAdmin && !staysAdmin && otherActiveAdmins(db, id) === 0) {
      return {
        success: false,
        message: 'لا يمكن تغيير دور آخر مدير أو تعطيله — أنشئ مديراً آخر أولاً.',
      };
    }

    if (data.password) {
      // Only checked when a NEW password is supplied; leaving the field blank
      // on an edit means "keep the existing one", which is not a weak password.
      const pwProblem = checkPassword(data.password);
      if (pwProblem) return { success: false, message: pwProblem };
      const hash = bcrypt.hashSync(data.password, 10);
      db.prepare(`
        UPDATE users SET Username = ?, PasswordHash = ?, EmployeeID = ?, RoleID = ?, IsActive = ?
        WHERE UserID = ?
      `).run(data.username, hash, data.employeeId ?? null, data.roleId ?? 1, data.isActive ?? 1, id);
    } else {
      db.prepare(`
        UPDATE users SET Username = ?, EmployeeID = ?, RoleID = ?, IsActive = ?
        WHERE UserID = ?
      `).run(data.username, data.employeeId ?? null, data.roleId ?? 1, data.isActive ?? 1, id);
    }

    // A session caches the permission SET it was created with, so a change of
    // role — or switching the account off — has no effect on a window that is
    // already open. Demoting a manager to a cashier left them managing until
    // they happened to log out.
    //
    // Ending the session is the honest fix: the user signs in again and gets
    // exactly the rights they now have. Refreshing the cached set in place
    // would be gentler but leaves every OTHER cached decision stale, and the
    // one case that must never be gentle is revoking access.
    destroyAllSessionsForUser(id);
    return { success: true };
  });

  // Delete user (deactivate)
  ipcMain.handle('users:delete', async (_event, id: number) => {
    const db = getDb();
    const target = db.prepare('SELECT RoleID, IsActive FROM users WHERE UserID = ?').get(id) as any;
    if (!target) return { success: false, message: 'المستخدم غير موجود' };
    if (target.RoleID === ADMIN_ROLE_ID && target.IsActive && otherActiveAdmins(db, id) === 0) {
      return {
        success: false,
        message: 'لا يمكن تعطيل آخر مدير للنظام — أنشئ مديراً آخر أولاً، '
          + 'وإلا لن يتمكن أحد من إدارة المستخدمين أو الصلاحيات.',
      };
    }
    db.prepare('UPDATE users SET IsActive = 0 WHERE UserID = ?').run(id);
    // Deactivating an account must log it OUT, not merely stop the next login.
    //
    // `auth:login` checks `IsActive = 1`, but a session already established
    // lives in memory keyed by window id and never re-reads the user row. So a
    // cashier who was dismissed kept full access on whatever till was already
    // open — MEASURED: account deactivated, IsActive = 0 in the database, and
    // the existing session still authorised every call. Which is precisely the
    // moment the account is disabled for.
    destroyAllSessionsForUser(id);
    return { success: true };
  });

  // ===== ROLES =====
  ipcMain.handle('roles:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM roles ORDER BY RoleID ASC').all();
  });

  ipcMain.handle('roles:create', async (_event, name: string) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO roles (RoleName, IsSystem) VALUES (?, 0)').run(name);
    return { success: true, id: result.lastInsertRowid };
  });

  // ===== PERMISSIONS =====
  ipcMain.handle('permissions:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM permissions ORDER BY Module ASC, PermissionName ASC').all();
  });

  ipcMain.handle('permissions:getByRole', async (_event, roleId: number) => {
    const db = getDb();
    return db.prepare('SELECT PermissionID FROM role_permissions WHERE RoleID = ?').all(roleId);
  });

  ipcMain.handle('permissions:setForRole', async (_event, roleId: number, permissionIds: number[]) => {
    const db = getDb();
    db.prepare('DELETE FROM role_permissions WHERE RoleID = ?').run(roleId);
    const stmt = db.prepare('INSERT INTO role_permissions (RoleID, PermissionID) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (const pid of permissionIds) {
        stmt.run(roleId, pid);
      }
    });
    tx();
    return { success: true };
  });

  // ===== USER OVERRIDES =====
  ipcMain.handle('permissions:getOverrides', async (_event, userId: number) => {
    const db = getDb();
    return db.prepare('SELECT * FROM user_overrides WHERE UserID = ?').all(userId);
  });

  ipcMain.handle('permissions:setOverride', async (_event, userId: number, permissionId: number, type: 'grant' | 'deny') => {
    const db = getDb();
    // Remove existing override for this user+permission
    db.prepare('DELETE FROM user_overrides WHERE UserID = ? AND PermissionID = ?').run(userId, permissionId);
    // Insert new
    db.prepare('INSERT INTO user_overrides (UserID, PermissionID, Type) VALUES (?, ?, ?)').run(userId, permissionId, type);
    return { success: true };
  });

  ipcMain.handle('permissions:removeOverride', async (_event, userId: number, permissionId: number) => {
    const db = getDb();
    db.prepare('DELETE FROM user_overrides WHERE UserID = ? AND PermissionID = ?').run(userId, permissionId);
    return { success: true };
  });

  // Admin resets another user's password (requires admin's current password)
  ipcMain.handle('users:adminResetPassword', async (_event, data: { adminId: number; adminPassword: string; targetUserId: number; newPassword: string }) => {
    const db = getDb();
    const admin = db.prepare('SELECT PasswordHash FROM users WHERE UserID = ?').get(data.adminId) as any;
    if (!admin) return { success: false, message: 'المدير غير موجود' };
    if (!bcrypt.compareSync(data.adminPassword, admin.PasswordHash)) {
      return { success: false, message: 'كلمة المرور الحالية غير صحيحة' };
    }
    if (typeof data.newPassword !== 'string' || data.newPassword.length < 6) {
      return { success: false, message: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' };
    }
    const hash = bcrypt.hashSync(data.newPassword, 10);
    db.prepare('UPDATE users SET PasswordHash = ? WHERE UserID = ?').run(hash, data.targetUserId);
    destroyAllSessionsForUser(data.targetUserId);
    const target = db.prepare('SELECT Username FROM users WHERE UserID = ?').get(data.targetUserId) as any;
    recordSecurityEvent(db, 'password_reset_by_admin', data.targetUserId, target?.Username ?? null,
      `أعاد التعيين المستخدم رقم ${data.adminId}`);
    return { success: true, message: 'تم تغيير كلمة المرور بنجاح' };
  });

  // Reset any user's password with a valid developer token (forgotten password).
  // SECURITY: the token is minted by `dev:login`, which bcrypt-verifies the
  // developer credentials in the main process and rate-limits attempts. The old
  // version compared a base64-obfuscated password that was trivially
  // recoverable from the shipped bundle.
  ipcMain.handle('users:resetByDev', async (_event, data: { devToken: string; targetUserId: number; newPassword: string }) => {
    if (!verifyDevToken(data?.devToken)) {
      return { success: false, message: 'جلسة المطور غير صالحة - سجّل الدخول مرة أخرى' };
    }
    if (typeof data.newPassword !== 'string' || data.newPassword.length < 6) {
      return { success: false, message: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' };
    }
    const db = getDb();
    const user = db.prepare('SELECT UserID, Username FROM users WHERE UserID = ?').get(data.targetUserId) as any;
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    const hash = bcrypt.hashSync(data.newPassword, 10);
    db.prepare('UPDATE users SET PasswordHash = ? WHERE UserID = ?').run(hash, data.targetUserId);
    // Force re-login everywhere: an old session must not survive a password reset.
    destroyAllSessionsForUser(data.targetUserId);
    // The most privileged route of the three, so the least excusable to leave
    // untraced: developer access resets ANY account, not just an administrator.
    recordSecurityEvent(db, 'password_reset_by_developer', data.targetUserId, user.Username ?? null,
      'إعادة تعيين بواسطة المطور');
    return { success: true, message: 'تم إعادة تعيين كلمة المرور بنجاح' };
  });

  /**
   * Minimal user list for the "forgot password" picker on the login screen.
   * Exposes only id + username (no hashes, no roles) because it is reachable
   * before authentication.
   */
  ipcMain.handle('users:listBasic', async () => {
    const db = getDb();
    return db.prepare('SELECT UserID, Username FROM users WHERE IsActive = 1 ORDER BY Username ASC').all();
  });

  // ------------------------------------------------ self-service recovery
  /**
   * The administrators eligible for Telegram recovery.
   *
   * Reachable before login, so it must leak as little as possible: id and
   * username only, exactly like `users:listBasic`, and only accounts that can
   * actually use this route. A cashier is absent from this list on purpose —
   * their password is reset by their administrator, which already works.
   */
  ipcMain.handle('users:listRecoverable', async () => {
    const db = getDb();
    return db.prepare(
      'SELECT UserID, Username FROM users WHERE RoleID = ? AND IsActive = 1 ORDER BY Username ASC',
    ).all(ADMIN_ROLE_ID);
  });

  /**
   * Reads the SHOP's own Telegram bot from settings.
   *
   * This is the CUSTOMER's bot, configured in Settings -> Backup. The
   * developer's bot lives in the Cloudflare Worker's secrets and is never
   * consulted here: a customer's password reset must not travel through the
   * developer's phone, which is exactly the support call this feature removes.
   */
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

  /** True when the shop has configured a bot that can carry the code. */
  ipcMain.handle('recovery:isAvailable', async () => ({ available: shopTelegram() !== null }));

  /**
   * Step 1: send a six-digit code to the SHOP OWNER's own Telegram.
   *
   * The code is generated and delivered entirely on this machine. It is never
   * returned to the renderer, so pressing this button at the keyboard reveals
   * nothing — the only copy arrives on the owner's phone.
   */
  ipcMain.handle('recovery:requestCode', async (_event, data: { userId?: unknown }) => {
    const db = getDb();
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return { success: false, message: 'اختر المستخدم أولاً' };
    }
    const user = db.prepare(
      'SELECT UserID, Username, RoleID, IsActive FROM users WHERE UserID = ?',
    ).get(userId) as any;

    // Administrators only. A cashier who forgets their password is reset by
    // their administrator from the users screen, which already works and needs
    // no new trust. There is no enumeration risk in saying so plainly:
    // `users:listRecoverable` already told the caller which accounts exist.
    if (!user || !user.IsActive || user.RoleID !== ADMIN_ROLE_ID) {
      return { success: false, message: 'هذه الطريقة متاحة لحساب المدير فقط' };
    }

    return requestResetCode(shopTelegram(), user.UserID, String(user.Username || ''), shopName());
  });

  /**
   * Step 2: check the typed code, then write the new password.
   *
   * Verification happens in the MAIN process against state the renderer cannot
   * see or reach, so a patched screen cannot invent a success.
   */
  ipcMain.handle('recovery:resetPassword', async (
    _event,
    data: { userId?: unknown; code?: unknown; newPassword?: unknown },
  ) => {
    const db = getDb();
    const userId = Number(data?.userId);
    const code = String(data?.code ?? '').trim();
    const newPassword = data?.newPassword;

    if (!Number.isInteger(userId) || userId <= 0) {
      return { success: false, message: 'اختر المستخدم أولاً' };
    }
    // Validate the new password BEFORE spending the one-time code: failing
    // afterwards would burn it and force the owner to request another.
    const pwError = checkPassword(newPassword);
    if (pwError) return { success: false, message: pwError };
    if (!/^\d{6}$/.test(code)) {
      return { success: false, message: 'الرمز يجب أن يكون ٦ أرقام' };
    }

    const user = db.prepare(
      'SELECT UserID, Username, RoleID, IsActive FROM users WHERE UserID = ?',
    ).get(userId) as any;
    if (!user || !user.IsActive || user.RoleID !== ADMIN_ROLE_ID) {
      return { success: false, message: 'هذه الطريقة متاحة لحساب المدير فقط' };
    }

    const verified = verifyResetCode(user.UserID, code);
    if (!verified.success) {
      recordSecurityEvent(db, 'password_reset_rejected', user.UserID, user.Username,
        `محاولة فاشلة: ${verified.message}`);
      return { success: false, message: verified.message };
    }

    const hash = bcrypt.hashSync(newPassword as string, 10);
    db.prepare('UPDATE users SET PasswordHash = ? WHERE UserID = ?').run(hash, user.UserID);

    // An old session must never survive a password reset.
    destroyAllSessionsForUser(user.UserID);

    // Durable local record first — it must exist even if Telegram is down.
    recordSecurityEvent(db, 'password_reset_telegram', user.UserID, user.Username,
      'إعادة تعيين كلمة مرور المدير عبر رمز تليجرام');

    // Then tell the owner out-of-band, so an unauthorised reset is noticed.
    await notifyResetDone(shopTelegram(), String(user.Username || ''), shopName());

    return { success: true, message: 'تم تغيير كلمة المرور بنجاح - سجّل الدخول الآن' };
  });

  // Delete role (only non-system roles)
  ipcMain.handle('roles:delete', async (_event, roleId: number) => {
    const db = getDb();
    const role = db.prepare('SELECT IsSystem FROM roles WHERE RoleID = ?').get(roleId) as any;
    if (!role) return { success: false, message: 'المجموعة غير موجودة' };
    if (role.IsSystem) return { success: false, message: 'لا يمكن حذف مجموعة نظامية' };
    // Remove role from users
    db.prepare('UPDATE users SET RoleID = 1 WHERE RoleID = ?').run(roleId);
    // Delete role permissions
    db.prepare('DELETE FROM role_permissions WHERE RoleID = ?').run(roleId);
    // Delete role
    db.prepare('DELETE FROM roles WHERE RoleID = ?').run(roleId);
    return { success: true, message: 'تم حذف المجموعة' };
  });

  // Update role name
  ipcMain.handle('roles:update', async (_event, roleId: number, name: string) => {
    const db = getDb();
    db.prepare('UPDATE roles SET RoleName = ? WHERE RoleID = ?').run(name, roleId);
    return { success: true };
  });
}
