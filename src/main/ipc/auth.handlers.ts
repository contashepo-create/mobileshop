import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';
import { createSession, destroySession, getSession } from '../security/session';
import {
  checkLoginAllowed, recordLoginFailure, recordLoginSuccess,
} from '../security/loginThrottle';

/**
 * Resolve the effective permission set for a user:
 *   role permissions  +  user 'grant' overrides  -  user 'deny' overrides
 */
export function loadPermissions(userId: number, roleId: number | null): Set<string> {
  const db = getDb();
  const perms = new Set<string>();

  if (roleId != null) {
    const rows = db.prepare(`
      SELECT p.PermissionKey
      FROM role_permissions rp
      JOIN permissions p ON rp.PermissionID = p.PermissionID
      WHERE rp.RoleID = ?
    `).all(roleId) as any[];
    for (const r of rows) perms.add(r.PermissionKey);
  }

  const overrides = db.prepare(`
    SELECT p.PermissionKey, o.Type
    FROM user_overrides o
    JOIN permissions p ON o.PermissionID = p.PermissionID
    WHERE o.UserID = ?
  `).all(userId) as any[];

  for (const o of overrides) {
    if (o.Type === 'grant') perms.add(o.PermissionKey);
    else if (o.Type === 'deny') perms.delete(o.PermissionKey);
  }

  return perms;
}

export function registerAuthHandlers() {
  // NOTE: registered directly on ipcMain (not via registerHandler) because it
  // is the call that establishes the session in the first place.
  ipcMain.handle('auth:login', async (event, payload: unknown) => {
    const { username, password } = (payload ?? {}) as { username?: unknown; password?: unknown };

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return { success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' };
    }

    // BRUTE FORCE.
    //
    // This channel had no rate limit at all. Measured against this very
    // handler: 100 wrong passwords in 7.8 seconds — ~13 guesses a second, for
    // as long as the attacker likes. bcrypt's cost was the only brake, and a
    // list of common passwords beats that in hours on an unattended till.
    //
    // Checked BEFORE the database is touched and before bcrypt runs, so a
    // locked account costs an attacker nothing to discover and gains them
    // nothing either.
    const locked = checkLoginAllowed(username);
    if (locked) {
      const mins = Math.ceil(locked.lockedForSec / 60);
      return {
        success: false,
        code: 'LOCKED_OUT',
        message: `تم إيقاف المحاولات مؤقتاً بعد عدة محاولات خاطئة - أعد المحاولة بعد ${mins} دقيقة`,
      };
    }

    const db = getDb();

    const user = db.prepare(`
      SELECT u.UserID, u.Username, u.EmployeeID, u.PasswordHash, u.IsActive, u.RoleID,
             e.Name as EmployeeName, r.RoleName
      FROM users u
      LEFT JOIN employees e ON u.EmployeeID = e.EmployeeID
      LEFT JOIN roles r ON u.RoleID = r.RoleID
      WHERE u.Username = ? AND u.IsActive = 1
    `).get(username) as any;

    // Uniform error message + a dummy compare so an attacker cannot distinguish
    // "user does not exist" from "wrong password" by response content or timing.
    if (!user) {
      bcrypt.compareSync(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO');
      // Counted even for a username that does not exist: otherwise an attacker
      // guessing usernames is never throttled, and the account that DOES exist
      // is found by watching which name starts locking out.
      recordLoginFailure(username);
      return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
    }

    if (!bcrypt.compareSync(password, user.PasswordHash)) {
      recordLoginFailure(username);
      return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
    }

    recordLoginSuccess(username);
    const permissions = loadPermissions(user.UserID, user.RoleID ?? null);

    createSession(event.sender.id, {
      userId: user.UserID,
      username: user.Username,
      roleId: user.RoleID ?? null,
      employeeId: user.EmployeeID ?? null,
      permissions,
    });

    return {
      success: true,
      user: {
        userId: user.UserID,
        username: user.Username,
        employeeId: user.EmployeeID,
        employeeName: user.EmployeeName,
        roleId: user.RoleID,
        roleName: user.RoleName,
        permissions: Array.from(permissions),
      },
    };
  });

  ipcMain.handle('auth:logout', async (event) => {
    destroySession(event.sender.id);
    return { success: true };
  });

  /** Lets the renderer restore UI state after a reload without re-authenticating. */
  ipcMain.handle('auth:session', async (event) => {
    const s = getSession(event.sender.id);
    if (!s) return { authenticated: false };
    const db = getDb();
    const extra = db.prepare(`
      SELECT e.Name as EmployeeName, r.RoleName
      FROM users u
      LEFT JOIN employees e ON u.EmployeeID = e.EmployeeID
      LEFT JOIN roles r ON u.RoleID = r.RoleID
      WHERE u.UserID = ?
    `).get(s.userId) as any;
    return {
      authenticated: true,
      user: {
        userId: s.userId,
        username: s.username,
        employeeId: s.employeeId,
        employeeName: extra?.EmployeeName ?? null,
        roleId: s.roleId,
        roleName: extra?.RoleName ?? null,
        permissions: Array.from(s.permissions),
      },
    };
  });
}
