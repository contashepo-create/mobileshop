import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../database/connection';

export function registerAuthHandlers() {
  ipcMain.handle('auth:login', async (_event, { username, password }: { username: string; password: string }) => {
    const db = getDb();

    const user = db.prepare(`
      SELECT u.UserID, u.Username, u.EmployeeID, u.PasswordHash, u.IsActive,
             e.Name as EmployeeName, r.RoleID, r.RoleName
      FROM users u
      LEFT JOIN employees e ON u.EmployeeID = e.EmployeeID
      LEFT JOIN roles r ON u.RoleID = r.RoleID
      WHERE u.Username = ? AND u.IsActive = 1
    `).get(username) as any;

    if (!user) {
      return { success: false, message: 'المستخدم غير موجود أو غير نشط' };
    }

    const valid = bcrypt.compareSync(password, user.PasswordHash);
    if (!valid) {
      return { success: false, message: 'كلمة المرور غير صحيحة' };
    }

    return {
      success: true,
      user: {
        userId: user.UserID,
        username: user.Username,
        employeeId: user.EmployeeID,
        employeeName: user.EmployeeName,
        roleId: user.RoleID,
        roleName: user.RoleName,
      },
    };
  });
}
