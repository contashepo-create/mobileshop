import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';

export function registerVouchersHandlers() {
  ipcMain.handle('vouchers:get', async (_event, voucherId: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT v.*, u.Username, ca.AccountName as CashAccountName
      FROM vouchers v
      JOIN users u ON v.UserID = u.UserID
      LEFT JOIN cash_accounts ca ON v.CashAccountID = ca.CashAccountID
      WHERE v.VoucherID = ?
    `).get(voucherId);
  });

  ipcMain.handle('vouchers:list', async (_event, filters?: { type?: string; fromDate?: string; toDate?: string }) => {
    const db = getDb();
    let query = `
      SELECT v.*, u.Username
      FROM vouchers v
      JOIN users u ON v.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.type && filters.type !== 'all') { query += ' AND v.VoucherType = ?'; params.push(filters.type); }
    if (filters?.fromDate) { query += ' AND v.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND v.Date <= ?'; params.push(filters.toDate); }
    query += ' ORDER BY v.Date DESC, v.VoucherID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('vouchers:create', async (_event, data: {
    VoucherType: string; Amount: number;
    PartyType?: string; PartyID?: number; PartyName?: string;
    Description: string; CashAccountID: number; PaymentMethodID?: number;
    ReferenceType?: string; ReferenceID?: number;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const dateStr = businessToday();
    const prefix = data.VoucherType === 'receipt' ? 'RCV' : 'PAY';
    const voucherNumber = nextDocNumber(db, 'vouchers', 'VoucherNumber', prefix, dateStr);

    // Check sufficient balance for payment vouchers (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && data.VoucherType === 'payment') {
      if (data.CashAccountID) {
        const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
        if (!acc || (acc.Balance || 0) < data.Amount) {
          return { success: false, message: `الرصيد غير كافٍ في الخزينة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
        }
      }
      if (data.PaymentMethodID) {
        const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
        if (!pm || (pm.Balance || 0) < data.Amount) {
          return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
        }
      }
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
          PartyType, PartyID, PartyName, Description, CashAccountID, PaymentMethodID,
          ReferenceType, ReferenceID, UserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voucherNumber, data.VoucherType, data.fiscalYearId, dateStr, data.Amount,
        data.PartyType ?? null, data.PartyID ?? null, data.PartyName ?? null,
        data.Description, data.CashAccountID, data.PaymentMethodID ?? null,
        data.ReferenceType ?? null, data.ReferenceID ?? null, data.userId
      );

      // Update cash account balance
      if (data.VoucherType === 'receipt') {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(data.Amount, data.CashAccountID);
        if (data.PaymentMethodID) {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(data.Amount, data.PaymentMethodID);
        }
      } else {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.Amount, data.CashAccountID);
        if (data.PaymentMethodID) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(data.Amount, data.PaymentMethodID);
        }
      }

      // Update party balance
      if (data.PartyType === 'customer' && data.PartyID) {
        if (data.VoucherType === 'receipt') {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(data.Amount, data.PartyID);
        }
      } else if (data.PartyType === 'supplier' && data.PartyID) {
        if (data.VoucherType === 'payment') {
          db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?').run(data.Amount, data.PartyID);
        }
      } else if (data.PartyType === 'employee' && data.PartyID) {
        if (data.VoucherType === 'payment') {
          db.prepare('UPDATE employees SET Balance = Balance - ? WHERE EmployeeID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE employees SET Balance = Balance + ? WHERE EmployeeID = ?').run(data.Amount, data.PartyID);
        }
      }
    });

    tx();
    return { success: true, voucherNumber };
  });
}
