import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount } from '../../shared/money';
import {
  requireText, optionalText, optionalId, optionalDate, oneOf,
  searchTerm, LIMITS, PARTY_STATUSES,
} from '../../shared/validate';

/**
 * Validates the fields a customer and a supplier have in common.
 *
 * WHY BOTH GO THROUGH ONE FUNCTION
 * --------------------------------
 * `customers:create` and `suppliers:create` were byte-for-byte the same
 * statement with a different table name, and both trusted the payload
 * completely. Two copies of a missing check is two places to forget it again.
 *
 * What was MEASURED before this existed, calling the real handlers:
 *
 *   - `Name: ''`            stored the empty string. The screen refuses it
 *                           (`if (!form.Name)`), the handler did not, and the
 *                           customer list then showed a blank row that could
 *                           be sold to and owed money.
 *   - `Name: '        '`    stored eight spaces — a row that looks empty and
 *                           is not, so a second one can be created beside it.
 *   - `Name: 'ح'.repeat(5_000_000)`
 *                           stored all five million characters. Every list
 *                           query, every print, every backup then carries it.
 *   - `Status: 'GOD_MODE'`  stored. The screen offers three values; the debt
 *                           colour-coding and the credit-block check test for
 *                           `'suspended'`, so an unknown status silently means
 *                           "never blocked".
 *
 * `CreditLimit` is money and goes through the existing `checkAmount`, which
 * already refuses negatives and absurd magnitudes.
 */
function validateParty(
  data: any,
  label: string,
  { withStatus }: { withStatus: boolean },
): { ok: true; value: any } | { ok: false; message: string } {
  const name = requireText(data?.Name, `اسم ${label}`, LIMITS.NAME);
  if (!name.ok) return { ok: false, message: name.message };

  const phone = optionalText(data?.Phone, 'رقم الهاتف', LIMITS.PHONE);
  if (!phone.ok) return { ok: false, message: phone.message };

  const email = optionalText(data?.Email, 'البريد الإلكتروني', LIMITS.EMAIL);
  if (!email.ok) return { ok: false, message: email.message };

  const address = optionalText(data?.Address, 'العنوان', LIMITS.ADDRESS);
  if (!address.ok) return { ok: false, message: address.message };

  // Null means "no limit", which is different from a limit of zero, so the
  // amount check only runs when a value was actually supplied.
  let creditLimit: number | null = null;
  if (data?.CreditLimit !== null && data?.CreditLimit !== undefined && data?.CreditLimit !== '') {
    const cl = checkAmount(data.CreditLimit, 'الحد الائتماني');
    if (!cl.ok) return { ok: false, message: cl.message! };
    creditLimit = cl.value;
  }

  // The create statements hardcode `'active'`, so they bind no `Status`
  // parameter at all. Returning the key regardless would make better-sqlite3
  // reject the whole INSERT with "Unknown named parameter 'Status'" — the
  // named-parameter binder requires the object to match the statement exactly.
  const value: any = {
    Name: name.value,
    Phone: phone.value,
    Email: email.value,
    Address: address.value,
    CreditLimit: creditLimit,
  };

  if (withStatus) {
    const s = oneOf(data?.Status ?? 'active', 'الحالة', PARTY_STATUSES);
    if (!s.ok) return { ok: false, message: s.message };
    value.Status = s.value;
  }

  return { ok: true, value };
}

export function registerHrHandlers() {
  // ===== EMPLOYEES =====
  ipcMain.handle('employees:list', async (_event, filters?: { isActive?: number }) => {
    const db = getDb();
    let query = 'SELECT * FROM employees WHERE 1=1';
    const params: any[] = [];
    if (filters?.isActive !== undefined) {
      query += ' AND IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY Name ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('employees:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare('SELECT * FROM employees WHERE EmployeeID = ?').get(id);
  });

  /**
   * Validates an employee record.
   *
   * MEASURED before this existed: `BaseSalary: -99999`, `Allowances: -500` and
   * `HireDate: 'not-a-date'` were all stored verbatim. The salary is what
   * `salaries:issue` pays out, so a negative one produces a payroll run that
   * TAKES money from the employee and books it as a wage expense; the hire
   * date is used to prorate a first month, and a string that is not a date
   * makes every comparison against it false.
   */
  function validateEmployee(data: any, forUpdate: boolean) {
    const name = requireText(data?.Name, 'اسم الموظف', LIMITS.NAME);
    if (!name.ok) return { ok: false as const, message: name.message };

    const phone = optionalText(data?.Phone, 'رقم الهاتف', LIMITS.PHONE);
    if (!phone.ok) return { ok: false as const, message: phone.message };

    const position = optionalText(data?.Position, 'الوظيفة', LIMITS.NAME);
    if (!position.ok) return { ok: false as const, message: position.message };

    const department = optionalText(data?.Department, 'القسم', LIMITS.NAME);
    if (!department.ok) return { ok: false as const, message: department.message };

    const salary = checkAmount(data?.BaseSalary ?? 0, 'الراتب الأساسي');
    if (!salary.ok) return { ok: false as const, message: salary.message! };

    const allowances = checkAmount(data?.Allowances ?? 0, 'البدلات');
    if (!allowances.ok) return { ok: false as const, message: allowances.message! };

    const hireDate = optionalDate(data?.HireDate, 'تاريخ التعيين');
    if (!hireDate.ok) return { ok: false as const, message: hireDate.message };

    const notes = optionalText(data?.Notes, 'ملاحظات', LIMITS.NOTES);
    if (!notes.ok) return { ok: false as const, message: notes.message };

    const value: any = {
      Name: name.value, Phone: phone.value, Position: position.value,
      Department: department.value, BaseSalary: salary.value,
      Allowances: allowances.value, HireDate: hireDate.value, Notes: notes.value,
    };
    if (forUpdate) value.IsActive = data?.IsActive === 0 || data?.IsActive === false ? 0 : 1;
    return { ok: true as const, value };
  }

  ipcMain.handle('employees:create', async (_event, data: any) => {
    const db = getDb();
    const v = validateEmployee(data, false);
    if (!v.ok) return { success: false, message: v.message };
    const result = db.prepare(`
      INSERT INTO employees (Name, Phone, Position, Department, BaseSalary, Allowances, HireDate, Notes)
      VALUES (@Name, @Phone, @Position, @Department, @BaseSalary, @Allowances, @HireDate, @Notes)
    `).run(v.value);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('employees:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم الموظف');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم الموظف غير صالح' };
    const v = validateEmployee(data, true);
    if (!v.ok) return { success: false, message: v.message };
    const exists = db.prepare('SELECT 1 AS ok FROM employees WHERE EmployeeID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الموظف غير موجود' };
    db.prepare(`
      UPDATE employees SET
        Name = @Name, Phone = @Phone, Position = @Position, Department = @Department,
        BaseSalary = @BaseSalary, Allowances = @Allowances, HireDate = @HireDate,
        IsActive = @IsActive, Notes = @Notes
      WHERE EmployeeID = @id
    `).run({ ...v.value, id: rid.value });
    return { success: true };
  });

  ipcMain.handle('employees:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE employees SET IsActive = 0 WHERE EmployeeID = ?').run(id);
    return { success: true };
  });

  // Employee account statement
  ipcMain.handle('employees:statement', async (_event, employeeId: number) => {
    const db = getDb();
    const salaries = db.prepare('SELECT * FROM salaries WHERE EmployeeID = ? ORDER BY Month DESC').all(employeeId);
    const advances = db.prepare('SELECT * FROM employee_advances WHERE EmployeeID = ? ORDER BY Date DESC').all(employeeId);
    const commissions = db.prepare('SELECT * FROM commissions WHERE EmployeeID = ? ORDER BY Date DESC').all(employeeId);
    const deductions = db.prepare('SELECT * FROM employee_deductions WHERE EmployeeID = ? ORDER BY Date DESC').all(employeeId);
    return { salaries, advances, commissions, deductions };
  });

  // ===== CUSTOMERS =====
  ipcMain.handle('customers:list', async (_event, filters?: { status?: string; search?: string }) => {
    const db = getDb();
    let query = 'SELECT * FROM customers WHERE 1=1';
    const params: any[] = [];
    if (filters?.status && filters.status !== 'all') {
      query += ' AND Status = ?';
      params.push(filters.status);
    }
    // `%` and `_` are LIKE wildcards. A search for `%` matched every row in
    // the table, and a 60,000-character term made SQLite throw
    // "LIKE or GLOB pattern too complex", which reached the screen as a blank
    // list and a generic error. `searchTerm` caps the length and escapes the
    // metacharacters; `ESCAPE` tells SQLite how they were escaped.
    const term = searchTerm(filters?.search);
    if (term) {
      query += " AND (Name LIKE ? ESCAPE '\\' OR Phone LIKE ? ESCAPE '\\')";
      params.push(`%${term}%`, `%${term}%`);
    }
    query += ' ORDER BY Name ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('customers:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare('SELECT * FROM customers WHERE CustomerID = ?').get(id);
  });

  ipcMain.handle('customers:create', async (_event, data: any) => {
    const db = getDb();
    const v = validateParty(data, 'العميل', { withStatus: false });
    if (!v.ok) return { success: false, message: v.message };
    const result = db.prepare(`
      INSERT INTO customers (Name, Phone, Email, Address, Balance, Status, CreditLimit)
      VALUES (@Name, @Phone, @Email, @Address, 0, 'active', @CreditLimit)
    `).run(v.value);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('customers:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم العميل');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم العميل غير صالح' };
    const v = validateParty(data, 'العميل', { withStatus: true });
    if (!v.ok) return { success: false, message: v.message };
    const exists = db.prepare('SELECT 1 AS ok FROM customers WHERE CustomerID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'العميل غير موجود' };
    db.prepare(`
      UPDATE customers SET
        Name = @Name, Phone = @Phone, Email = @Email, Address = @Address,
        Status = @Status, CreditLimit = @CreditLimit
      WHERE CustomerID = @id
    `).run({ ...v.value, id: rid.value });
    return { success: true };
  });

  ipcMain.handle('customers:updateStatus', async (_event, id: number, status: string) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم العميل');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم العميل غير صالح' };
    // MEASURED: `'GOD_MODE'` was stored. The suspension check that stops a
    // sale to a blocked customer reads `Status === 'suspended'`, so any
    // unrecognised value is treated as "in good standing" everywhere.
    const s = oneOf(status, 'الحالة', PARTY_STATUSES);
    if (!s.ok) return { success: false, message: s.message };
    const info = db.prepare('UPDATE customers SET Status = ? WHERE CustomerID = ?')
      .run(s.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'العميل غير موجود' };
    return { success: true };
  });

  // ===== SUPPLIERS =====
  ipcMain.handle('suppliers:list', async (_event, filters?: { status?: string; search?: string }) => {
    const db = getDb();
    let query = 'SELECT * FROM suppliers WHERE 1=1';
    const params: any[] = [];
    if (filters?.status && filters.status !== 'all') {
      query += ' AND Status = ?';
      params.push(filters.status);
    }
    // `%` and `_` are LIKE wildcards. A search for `%` matched every row in
    // the table, and a 60,000-character term made SQLite throw
    // "LIKE or GLOB pattern too complex", which reached the screen as a blank
    // list and a generic error. `searchTerm` caps the length and escapes the
    // metacharacters; `ESCAPE` tells SQLite how they were escaped.
    const term = searchTerm(filters?.search);
    if (term) {
      query += " AND (Name LIKE ? ESCAPE '\\' OR Phone LIKE ? ESCAPE '\\')";
      params.push(`%${term}%`, `%${term}%`);
    }
    query += ' ORDER BY Name ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('suppliers:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare('SELECT * FROM suppliers WHERE SupplierID = ?').get(id);
  });

  ipcMain.handle('suppliers:create', async (_event, data: any) => {
    const db = getDb();
    const v = validateParty(data, 'المورد', { withStatus: false });
    if (!v.ok) return { success: false, message: v.message };
    const result = db.prepare(`
      INSERT INTO suppliers (Name, Phone, Email, Address, Balance, Status, CreditLimit)
      VALUES (@Name, @Phone, @Email, @Address, 0, 'active', @CreditLimit)
    `).run(v.value);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('suppliers:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم المورد');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم المورد غير صالح' };
    const v = validateParty(data, 'المورد', { withStatus: true });
    if (!v.ok) return { success: false, message: v.message };
    const exists = db.prepare('SELECT 1 AS ok FROM suppliers WHERE SupplierID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'المورد غير موجود' };
    db.prepare(`
      UPDATE suppliers SET
        Name = @Name, Phone = @Phone, Email = @Email, Address = @Address,
        Status = @Status, CreditLimit = @CreditLimit
      WHERE SupplierID = @id
    `).run({ ...v.value, id: rid.value });
    return { success: true };
  });

  ipcMain.handle('suppliers:updateStatus', async (_event, id: number, status: string) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم المورد');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم المورد غير صالح' };
    // MEASURED: `'HACKED'` was stored. Same consequence as the customer case.
    const s = oneOf(status, 'الحالة', PARTY_STATUSES);
    if (!s.ok) return { success: false, message: s.message };
    const info = db.prepare('UPDATE suppliers SET Status = ? WHERE SupplierID = ?')
      .run(s.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'المورد غير موجود' };
    return { success: true };
  });
}
