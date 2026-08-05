import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';
import { verifyDevToken } from '../security/devAuth';
import { destroyAllSessionsForUser } from '../security/session';
import { requestResetCode, verifyResetCode, notifyResetDone } from '../security/passwordRecovery';
import { recordSecurityEvent } from '../security/securityLog';
import { checkAttemptAllowed, recordAttemptFailure, recordAttemptSuccess, lockoutMessage } from '../security/loginThrottle';
import { requireText, optionalId, requireFlag, LIMITS } from '../../shared/validate';


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
  // bcrypt silently truncates at 72 BYTES. A password longer than that is not
  // stronger, and an attacker who knows the first 72 bytes holds the account —
  // so a user who believes their 200-character passphrase is protecting them
  // is wrong in a way nothing tells them. Arabic is 2 bytes per character in
  // UTF-8, so the byte length is what must be measured, not the character
  // count.
  if (Buffer.byteLength(pw, 'utf8') > 72) {
    return 'كلمة المرور أطول من الحد المسموح (٧٢ بايت)';
  }
  return null;
}

/**
 * Normalises and checks a username.
 *
 * MEASURED before this existed, against the real `users:create`:
 *
 *   - `'kareem'`, `'kareem '` and `'KAREEM'` were all accepted and coexisted.
 *     The duplicate check is `WHERE Username = ?`, which is case-sensitive and
 *     space-sensitive, while `auth:login` looks up the same way — so three
 *     accounts existed that a human reading the users list cannot tell apart,
 *     and an administrator revoking "kareem" would leave two live back doors.
 *   - a 100,000-character username was stored.
 *
 * The stored form is trimmed and lower-cased. Lower-casing is safe here
 * because this application's usernames are Latin identifiers chosen by the
 * shop; it removes an entire class of impersonation for no loss of meaning.
 */
function normaliseUsername(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const u = requireText(raw, 'اسم المستخدم', LIMITS.USERNAME);
  if (!u.ok) return { ok: false, message: u.message };
  // Lower-cased, but NOT silently stripped of spaces.
  //
  // An earlier version deleted internal whitespace, so "ahmed ali" was quietly
  // saved as "ahmedali". That is a different string from the one the
  // administrator typed and the one they will try to log in with, and it fails
  // at the login screen with "wrong username or password" — a validator that
  // rewrites the input is worse than one that refuses it, because the refusal
  // is at least visible. The character allow-list below rejects the space and
  // says so.
  const value = u.value.toLowerCase();
  if (!/^[a-z0-9._@-]+$/.test(value)) {
    return {
      ok: false,
      message: 'اسم المستخدم يجب أن يحتوي على حروف إنجليزية وأرقام والرموز . _ - @ فقط بدون مسافات',
    };
  }
  return { ok: true, value };
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
    const uname = normaliseUsername(data?.username);
    if (!uname.ok) return { success: false, message: uname.message };
    const pwProblem = checkPassword(data?.password);
    if (pwProblem) return { success: false, message: pwProblem };

    // A role that does not exist would be caught by the foreign key as an
    // opaque "constraint failed"; naming the problem is more useful. More
    // importantly the role decides what the account may DO, so it is not a
    // field to accept unchecked.
    const roleId = optionalId(data?.roleId, 'الدور');
    if (!roleId.ok || roleId.value === null) return { success: false, message: 'الدور مطلوب' };
    const role = db.prepare('SELECT 1 AS ok FROM roles WHERE RoleID = ?').get(roleId.value);
    if (!role) return { success: false, message: 'الدور غير موجود' };

    const employeeId = optionalId(data?.employeeId, 'الموظف');
    if (!employeeId.ok) return { success: false, message: employeeId.message };
    if (employeeId.value !== null) {
      const emp = db.prepare('SELECT 1 AS ok FROM employees WHERE EmployeeID = ?').get(employeeId.value);
      if (!emp) return { success: false, message: 'الموظف غير موجود' };
    }

    // Compared against the NORMALISED form, so "Ahmed" can no longer be
    // created alongside "ahmed".
    const existing = db.prepare('SELECT UserID FROM users WHERE LOWER(TRIM(Username)) = ?').get(uname.value);
    if (existing) {
      return { success: false, message: 'اسم المستخدم موجود بالفعل' };
    }
    const hash = bcrypt.hashSync(data.password, 10);
    const result = db.prepare(`
      INSERT INTO users (Username, PasswordHash, EmployeeID, RoleID, IsActive)
      VALUES (?, ?, ?, ?, 1)
    `).run(uname.value, hash, employeeId.value, roleId.value);
    return { success: true, id: result.lastInsertRowid };
  });

  // Update user
  ipcMain.handle('users:update', async (_event, id: number, data: { username?: string; password?: string; employeeId?: number; roleId?: number; isActive?: number }) => {
    const db = getDb();

    // The same lockout applies to an EDIT: demoting the last administrator to
    // a salesperson, or switching them inactive, removes the last account that
    // can manage the system just as surely as deleting it.
    const rid = optionalId(id, 'رقم المستخدم');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم المستخدم غير صالح' };
    id = rid.value;

    const current = db.prepare('SELECT RoleID, IsActive, Username FROM users WHERE UserID = ?').get(id) as any;
    if (!current) return { success: false, message: 'المستخدم غير موجود' };

    // The same normalisation as `users:create`. An EDIT could otherwise
    // introduce the collision that create now prevents: renaming "sara" to
    // "Ahmed" while "ahmed" exists produced two accounts that look identical
    // in the list and are distinct to every lookup.
    //
    // The username was also written straight through with no check at all, so
    // an edit could blank it — `UPDATE users SET Username = undefined` binds
    // NULL, and an account with no username cannot be logged into or revoked
    // by name.
    let nextUsername = current.Username;
    if (data.username !== undefined) {
      const uname = normaliseUsername(data.username);
      if (!uname.ok) return { success: false, message: uname.message };
      const clash = db.prepare(
        'SELECT UserID FROM users WHERE LOWER(TRIM(Username)) = ? AND UserID != ?',
      ).get(uname.value, id) as any;
      if (clash) return { success: false, message: 'اسم المستخدم موجود بالفعل' };
      nextUsername = uname.value;
    }

    const roleCheck = optionalId(data.roleId ?? 1, 'الدور');
    if (!roleCheck.ok || roleCheck.value === null) return { success: false, message: 'الدور غير صالح' };
    const roleRow = db.prepare('SELECT 1 AS ok FROM roles WHERE RoleID = ?').get(roleCheck.value);
    if (!roleRow) return { success: false, message: 'الدور غير موجود' };

    const empCheck = optionalId(data.employeeId, 'الموظف');
    if (!empCheck.ok) return { success: false, message: empCheck.message };
    if (empCheck.value !== null) {
      const emp = db.prepare('SELECT 1 AS ok FROM employees WHERE EmployeeID = ?').get(empCheck.value);
      if (!emp) return { success: false, message: 'الموظف غير موجود' };
    }

    const activeCheck = requireFlag(data.isActive, 'نشط', 1);
    if (!activeCheck.ok) return { success: false, message: activeCheck.message };

    const nextRole = roleCheck.value;
    const nextActive = activeCheck.value;
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
      `).run(nextUsername, hash, empCheck.value, nextRole, nextActive, id);
    } else {
      db.prepare(`
        UPDATE users SET Username = ?, EmployeeID = ?, RoleID = ?, IsActive = ?
        WHERE UserID = ?
      `).run(nextUsername, empCheck.value, nextRole, nextActive, id);
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

  // MEASURED: `''` and a 50,000-character role name were both stored. A role
  // is chosen from a dropdown when creating a user, so a blank one is a
  // permission set nobody can identify.
  ipcMain.handle('roles:create', async (_event, name: string) => {
    const db = getDb();
    const n = requireText(name, 'اسم الدور', LIMITS.NAME);
    if (!n.ok) return { success: false, message: n.message };
    const clash = db.prepare('SELECT 1 AS ok FROM roles WHERE LOWER(TRIM(RoleName)) = ?')
      .get(n.value.toLowerCase());
    if (clash) return { success: false, message: 'اسم الدور موجود بالفعل' };
    const result = db.prepare('INSERT INTO roles (RoleName, IsSystem) VALUES (?, 0)').run(n.value);
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
    const rid = optionalId(roleId, 'الدور');
    if (!rid.ok || rid.value === null) return { success: false, message: 'الدور غير صالح' };
    const role = db.prepare('SELECT 1 AS ok FROM roles WHERE RoleID = ?').get(rid.value);
    if (!role) return { success: false, message: 'الدور غير موجود' };

    // This handler DELETES the role's whole permission set before inserting
    // the new one. A payload that is not an array — `undefined` from a screen
    // that failed to build it, say — made the `for...of` throw AFTER the
    // delete, and because the delete ran outside the transaction the role was
    // left with NO permissions at all. Every user holding it lost access with
    // no error shown.
    if (!Array.isArray(permissionIds)) {
      return { success: false, message: 'قائمة الصلاحيات غير صالحة' };
    }
    // De-duplicated, because `role_permissions` has
    // `PRIMARY KEY (RoleID, PermissionID)`. MEASURED: `[1, 2, 1]` threw
    // "UNIQUE constraint failed" from inside the loop. A list arriving with a
    // repeat is a screen bug, not an attack, and the honest response is to
    // save the set the administrator meant rather than to fail the save.
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const raw of permissionIds) {
      const pid = optionalId(raw, 'الصلاحية');
      if (!pid.ok || pid.value === null) return { success: false, message: 'رقم صلاحية غير صالح' };
      if (seen.has(pid.value)) continue;
      seen.add(pid.value);
      ids.push(pid.value);
    }
    if (ids.length > 500) return { success: false, message: 'عدد الصلاحيات أكبر من الحد المسموح' };
    // Verified before anything is deleted, so an unknown id cannot leave the
    // role stripped.
    const known = new Set(
      (db.prepare('SELECT PermissionID FROM permissions').all() as any[]).map(r => r.PermissionID),
    );
    for (const pid of ids) {
      if (!known.has(pid)) return { success: false, message: `الصلاحية ${pid} غير موجودة` };
    }

    const stmt = db.prepare('INSERT INTO role_permissions (RoleID, PermissionID) VALUES (?, ?)');
    // The delete moved INSIDE the transaction so a failure restores the set.
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM role_permissions WHERE RoleID = ?').run(rid.value);
      for (const pid of ids) {
        stmt.run(rid.value, pid);
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
    const uid = optionalId(userId, 'المستخدم');
    if (!uid.ok || uid.value === null) return { success: false, message: 'المستخدم غير صالح' };
    const pid = optionalId(permissionId, 'الصلاحية');
    if (!pid.ok || pid.value === null) return { success: false, message: 'الصلاحية غير صالحة' };

    // `loadPermissions` reads this column as
    //   if (Type === 'grant') add; else if (Type === 'deny') remove;
    // so ANY third value is a silent no-op. An administrator who denied a
    // permission would be shown an override in the list and the user would
    // keep the permission — the screen and the enforcement disagreeing is the
    // worst possible outcome for an access-control setting.
    if (type !== 'grant' && type !== 'deny') {
      return { success: false, message: 'نوع الاستثناء يجب أن يكون منح أو منع' };
    }
    const user = db.prepare('SELECT 1 AS ok FROM users WHERE UserID = ?').get(uid.value);
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    const perm = db.prepare('SELECT 1 AS ok FROM permissions WHERE PermissionID = ?').get(pid.value);
    if (!perm) return { success: false, message: 'الصلاحية غير موجودة' };

    db.transaction(() => {
      db.prepare('DELETE FROM user_overrides WHERE UserID = ? AND PermissionID = ?').run(uid.value, pid.value);
      db.prepare('INSERT INTO user_overrides (UserID, PermissionID, Type) VALUES (?, ?, ?)').run(uid.value, pid.value, type);
    })();
    // The session caches the permission set it was built with, so an override
    // applied to a signed-in user had no effect until they happened to log
    // out. Revoking access must take effect immediately.
    destroyAllSessionsForUser(uid.value);
    return { success: true };
  });

  ipcMain.handle('permissions:removeOverride', async (_event, userId: number, permissionId: number) => {
    const db = getDb();
    const uid = optionalId(userId, 'المستخدم');
    if (!uid.ok || uid.value === null) return { success: false, message: 'المستخدم غير صالح' };
    const pid = optionalId(permissionId, 'الصلاحية');
    if (!pid.ok || pid.value === null) return { success: false, message: 'الصلاحية غير صالحة' };
    db.prepare('DELETE FROM user_overrides WHERE UserID = ? AND PermissionID = ?').run(uid.value, pid.value);
    // Removing a 'grant' override takes a permission AWAY, so the cached
    // session must be ended for the same reason as `setOverride`.
    destroyAllSessionsForUser(uid.value);
    return { success: true };
  });

  // Admin resets another user's password (requires admin's current password)
  ipcMain.handle('users:adminResetPassword', async (_event, data: { adminId: number; adminPassword: string; targetUserId: number; newPassword: string }) => {
    const db = getDb();

    // BRUTE FORCE. This re-prompts for the administrator's password and, on
    // success, sets ANY user's password — including another administrator's.
    // It compared with no counter: measured at ~13 guesses/second, unlimited.
    // Guessing here is strictly better for an attacker than guessing at the
    // login screen, because it hands over the whole user table.
    const throttleId = `user:${data?.adminId}`;
    const locked = checkAttemptAllowed('dangerous', throttleId);
    if (locked) {
      return { success: false, code: 'LOCKED_OUT', message: lockoutMessage(locked.lockedForSec) };
    }

    const admin = db.prepare('SELECT PasswordHash FROM users WHERE UserID = ?').get(data.adminId) as any;
    if (!admin) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'المدير غير موجود' };
    }
    if (!bcrypt.compareSync(data.adminPassword, admin.PasswordHash)) {
      recordAttemptFailure('dangerous', throttleId);
      return { success: false, message: 'كلمة المرور الحالية غير صحيحة' };
    }
    recordAttemptSuccess('dangerous', throttleId);
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
    const rid = optionalId(roleId, 'رقم الدور');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم الدور غير صالح' };
    const n = requireText(name, 'اسم الدور', LIMITS.NAME);
    if (!n.ok) return { success: false, message: n.message };
    const clash = db.prepare(
      'SELECT 1 AS ok FROM roles WHERE LOWER(TRIM(RoleName)) = ? AND RoleID != ?',
    ).get(n.value.toLowerCase(), rid.value);
    if (clash) return { success: false, message: 'اسم الدور موجود بالفعل' };
    const info = db.prepare('UPDATE roles SET RoleName = ? WHERE RoleID = ?').run(n.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'الدور غير موجود' };
    return { success: true };
  });
}
