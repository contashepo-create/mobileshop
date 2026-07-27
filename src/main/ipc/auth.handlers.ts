import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';
import { createSession, destroySession, getSession } from '../security/session';

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
      return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
    }

    if (!bcrypt.compareSync(password, user.PasswordHash)) {
      return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
    }

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
