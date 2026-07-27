import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

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

  ipcMain.handle('employees:create', async (_event, data: any) => {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO employees (Name, Phone, Position, Department, BaseSalary, Allowances, HireDate, Notes)
      VALUES (@Name, @Phone, @Position, @Department, @BaseSalary, @Allowances, @HireDate, @Notes)
    `).run(data);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('employees:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE employees SET
        Name = @Name, Phone = @Phone, Position = @Position, Department = @Department,
        BaseSalary = @BaseSalary, Allowances = @Allowances, HireDate = @HireDate,
        IsActive = @IsActive, Notes = @Notes
      WHERE EmployeeID = ?
    `).run({ ...data, id });
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
    if (filters?.search) {
      query += ' AND (Name LIKE ? OR Phone LIKE ?)';
      params.push(`%${filters.search}%`, `%${filters.search}%`);
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
    const result = db.prepare(`
      INSERT INTO customers (Name, Phone, Email, Address, Balance, Status, CreditLimit)
      VALUES (@Name, @Phone, @Email, @Address, 0, 'active', @CreditLimit)
    `).run(data);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('customers:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE customers SET
        Name = @Name, Phone = @Phone, Email = @Email, Address = @Address,
        Status = @Status, CreditLimit = @CreditLimit
      WHERE CustomerID = ?
    `).run({ ...data, id });
    return { success: true };
  });

  ipcMain.handle('customers:updateStatus', async (_event, id: number, status: string) => {
    const db = getDb();
    db.prepare('UPDATE customers SET Status = ? WHERE CustomerID = ?').run(status, id);
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
    if (filters?.search) {
      query += ' AND (Name LIKE ? OR Phone LIKE ?)';
      params.push(`%${filters.search}%`, `%${filters.search}%`);
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
    const result = db.prepare(`
      INSERT INTO suppliers (Name, Phone, Email, Address, Balance, Status, CreditLimit)
      VALUES (@Name, @Phone, @Email, @Address, 0, 'active', @CreditLimit)
    `).run(data);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('suppliers:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE suppliers SET
        Name = @Name, Phone = @Phone, Email = @Email, Address = @Address,
        Status = @Status, CreditLimit = @CreditLimit
      WHERE SupplierID = ?
    `).run({ ...data, id });
    return { success: true };
  });

  ipcMain.handle('suppliers:updateStatus', async (_event, id: number, status: string) => {
    const db = getDb();
    db.prepare('UPDATE suppliers SET Status = ? WHERE SupplierID = ?').run(status, id);
    return { success: true };
  });
}
