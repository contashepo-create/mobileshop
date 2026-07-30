import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount } from '../../shared/money';
import { getCallerUserId } from '../security/ipcGuard';
import { businessToday } from '../../shared/businessDate';

export function registerRentHandlers() {
  ipcMain.handle('rents:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM rents ORDER BY StartDate DESC').all();
  });

  ipcMain.handle('rents:create', async (_event, data: {
    RentName: string; RentType: string; Amount: number; Period: string;
    StartDate: string; PartyName?: string; PartyPhone?: string; Notes?: string;
  }) => {
    const db = getDb();
    // Rent is an amount of money, so it follows the same rule as every other:
    // the direction is the RentType, never the sign.
    const amt = checkAmount(data?.Amount, 'قيمة الإيجار', { allowZero: false });
    if (!amt.ok) return { success: false, message: amt.message };
    const result = db.prepare(`
      INSERT INTO rents (RentName, RentType, Amount, Period, StartDate, IsActive, PartyName, PartyPhone, Notes)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(data.RentName, data.RentType, data.Amount, data.Period, data.StartDate, data.PartyName ?? null, data.PartyPhone ?? null, data.Notes ?? null);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('rents:update', async (_event, id: number, data: any) => {
    const db = getDb();
    db.prepare(`
      UPDATE rents SET RentName = ?, RentType = ?, Amount = ?, Period = ?, IsActive = ?, PartyName = ?, PartyPhone = ?, Notes = ?
      WHERE RentID = ?
    `).run(data.RentName, data.RentType, data.Amount, data.Period, data.IsActive, data.PartyName, data.PartyPhone, data.Notes, id);
    return { success: true };
  });

  ipcMain.handle('rents:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE rents SET IsActive = 0 WHERE RentID = ?').run(id);
    return { success: true };
  });

  // Rent payments
  ipcMain.handle('rentPayments:list', async (_event, rentId?: number) => {
    const db = getDb();
    let query = `
      SELECT rp.*, r.RentName, r.RentType, r.Period
      FROM rent_payments rp
      JOIN rents r ON rp.RentID = r.RentID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (rentId) { query += ' AND rp.RentID = ?'; params.push(rentId); }
    query += ' ORDER BY rp.DueDate DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('rentPayments:pay', async (_event, data: {
    RentPaymentID: number; CashAccountID: number;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?').get(data.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'الدفعة غير موجودة' };

    const dateStr = businessToday();
    const isExpense = db.prepare('SELECT RentType FROM rents WHERE RentID = ?').get(payment.RentID) as any;

    // Check sufficient balance for expense payments (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && isExpense?.RentType === 'expense' && data.CashAccountID) {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < payment.Amount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لدفع الإيجار: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${(payment.Amount || 0).toFixed(2)}` };
      }
    }

    db.transaction(() => {
      db.prepare('UPDATE rent_payments SET Status = ?, PaidDate = ?, CashAccountID = ? WHERE RentPaymentID = ?')
        .run('paid', dateStr, data.CashAccountID, data.RentPaymentID);

      // Update cash account
      if (isExpense?.RentType === 'expense') {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(payment.Amount, data.CashAccountID);
      } else {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(payment.Amount, data.CashAccountID);
      }
    })();

    return { success: true };
  });

  // Generate rent payments for a period
  ipcMain.handle('rents:generatePayments', async (event, rentId: number, months: number, _userId: number, fiscalYearId: number) => {
    const userId = getCallerUserId(event, _userId);
    const db = getDb();
    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(rentId) as any;
    if (!rent) return { success: false, message: 'الإيجار غير موجود' };

    const startDate = new Date(rent.StartDate);
    const tx = db.transaction(() => {
      for (let i = 0; i < months; i++) {
        const dueDate = new Date(startDate);
        if (rent.Period === 'monthly') dueDate.setMonth(dueDate.getMonth() + i);
        else dueDate.setFullYear(dueDate.getFullYear() + i);

        const periodLabel = rent.Period === 'monthly'
          ? `${dueDate.toLocaleString('ar-EG', { month: 'long', year: 'numeric' })}`
          : `${dueDate.getFullYear()}`;

        // Check if payment already exists
        const existing = db.prepare('SELECT RentPaymentID FROM rent_payments WHERE RentID = ? AND PeriodLabel = ?').get(rentId, periodLabel);
        if (!existing) {
          db.prepare(`
            INSERT INTO rent_payments (RentID, PeriodLabel, Amount, DueDate, Status, FiscalYearID, UserID)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)
          `).run(rentId, periodLabel, rent.Amount, dueDate.toISOString().split('T')[0], fiscalYearId, userId);
        }
      }
    });
    tx();
    return { success: true };
  });
}
