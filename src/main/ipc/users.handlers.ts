import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';

function decryptDev(str: string): string {
  try { return Buffer.from(str, 'base64').toString('utf-8').split('').reverse().join(''); } catch { return ''; }
}
const ENCRYPTED_DEV_USER = Buffer.from('zerocold'.split('').reverse().join('')).toString('base64');
const ENCRYPTED_DEV_PASS = Buffer.from('014253'.split('').reverse().join('')).toString('base64');

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
    if (data.password) {
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
    return { success: true };
  });

  // Delete user (deactivate)
  ipcMain.handle('users:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE users SET IsActive = 0 WHERE UserID = ?').run(id);
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
    const hash = bcrypt.hashSync(data.newPassword, 10);
    db.prepare('UPDATE users SET PasswordHash = ? WHERE UserID = ?').run(hash, data.targetUserId);
    return { success: true, message: 'تم تغيير كلمة المرور بنجاح' };
  });

  // Reset any user's password using dev/master credentials (for forgotten passwords)
  ipcMain.handle('users:resetByDev', async (_event, data: { devUser: string; devPassword: string; targetUserId: number; newPassword: string }) => {
    if (data.devUser !== decryptDev(ENCRYPTED_DEV_USER) || data.devPassword !== decryptDev(ENCRYPTED_DEV_PASS)) {
      return { success: false, message: 'بيانات المطور غير صحيحة' };
    }
    const db = getDb();
    const user = db.prepare('SELECT UserID FROM users WHERE UserID = ?').get(data.targetUserId) as any;
    if (!user) return { success: false, message: 'المستخدم غير موجود' };
    const hash = bcrypt.hashSync(data.newPassword, 10);
    db.prepare('UPDATE users SET PasswordHash = ? WHERE UserID = ?').run(hash, data.targetUserId);
    return { success: true, message: 'تم إعادة تعيين كلمة المرور بنجاح' };
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
