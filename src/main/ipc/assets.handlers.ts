import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount } from '../../shared/money';

export function registerAssetsHandlers() {
  // ===== CASH ACCOUNTS (BANKS & SAFES) =====
  ipcMain.handle('cashAccounts:list', async (_event, filters?: { isActive?: number }) => {
    const db = getDb();
    let query = 'SELECT * FROM cash_accounts WHERE 1=1';
    const params: any[] = [];
    if (filters?.isActive !== undefined) {
      query += ' AND IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY AccountType ASC, AccountName ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('cashAccounts:create', async (_event, data: any) => {
    const db = getDb();
    // A cash box cannot be created already holding less than nothing.
    //
    // Unlike a customer, whose negative balance legitimately means the shop
    // owes them, physical money has no credit side. Measured before this
    // guard: a safe was created at -99,999 and every later report — the
    // balance sheet, total liquid funds, the stocktake screen — inherited it.
    const bal = checkAmount(data?.Balance ?? 0, 'الرصيد الافتتاحي للخزينة');
    if (!bal.ok) return { success: false, message: bal.message };
    const result = db.prepare(`
      INSERT INTO cash_accounts (AccountName, AccountType, Balance, BankName, AccountNumber, IsActive)
      VALUES (@AccountName, @AccountType, @Balance, @BankName, @AccountNumber, 1)
    `).run(data);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('cashAccounts:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE cash_accounts SET
        AccountName = @AccountName, AccountType = @AccountType,
        BankName = @BankName, AccountNumber = @AccountNumber, IsActive = @IsActive
      WHERE CashAccountID = ?
    `).run({ ...data, id });
    return { success: true };
  });

  ipcMain.handle('cashAccounts:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE cash_accounts SET IsActive = 0 WHERE CashAccountID = ?').run(id);
    return { success: true };
  });

  // ===== PAYMENT METHODS =====
  ipcMain.handle('paymentMethods:list', async (_event, filters?: { isActive?: number }) => {
    const db = getDb();
    let query = 'SELECT * FROM payment_methods WHERE 1=1';
    const params: any[] = [];
    if (filters?.isActive !== undefined) {
      query += ' AND IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY MethodName ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('paymentMethods:create', async (_event, data: any) => {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO payment_methods (MethodName, MethodType, Provider, PhoneNumber, Balance, IsActive)
      VALUES (@MethodName, @MethodType, @Provider, @PhoneNumber, 0, 1)
    `).run(data);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('paymentMethods:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE payment_methods SET
        MethodName = @MethodName, MethodType = @MethodType,
        Provider = @Provider, PhoneNumber = @PhoneNumber, IsActive = @IsActive
      WHERE PaymentMethodID = ?
    `).run({ ...data, id });
    return { success: true };
  });

  ipcMain.handle('paymentMethods:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE payment_methods SET IsActive = 0 WHERE PaymentMethodID = ?').run(id);
    return { success: true };
  });
}
