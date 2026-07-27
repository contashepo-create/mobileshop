import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

export function registerServicesHandlers() {
  // List service sales
  ipcMain.handle('serviceSales:list', async (_event, filters?: { fromDate?: string; toDate?: string; customerId?: number }) => {
    const db = getDb();
    let query = `
      SELECT ss.*, c.Name as CustomerName, u.Username
      FROM service_sales ss
      LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
      JOIN users u ON ss.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.fromDate) { query += ' AND ss.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND ss.Date <= ?'; params.push(filters.toDate); }
    if (filters?.customerId) { query += ' AND ss.CustomerID = ?'; params.push(filters.customerId); }
    query += ' ORDER BY ss.Date DESC, ss.ServiceSaleID DESC';
    return db.prepare(query).all(...params);
  });

  // Create service sale (balance transfer, bill payment, top-up, etc.)
  ipcMain.handle('serviceSales:create', async (_event, data: {
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    ServiceType: string;
    ServiceTypeLabel?: string; // custom label for "other" type
    Provider: string;
    ProviderLabel?: string; // custom label for "other" provider
    TargetPhone: string;
    Amount: number;
    ServiceCost: number;
    ChargeAmount: number;
    PaymentMethod: string;
    PaidAmount: number;
    CashAccountID?: number;
    PaymentMethodID?: number;
    TransferCost?: number;
    Notes?: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const numResult = db.prepare("SELECT COUNT(*) as count FROM service_sales WHERE Date = ?").get(dateStr) as any;
      const serviceNumber = `SRV-${dateStr.replace(/-/g, '')}-${(numResult.count + 1).toString().padStart(4, '0')}`;

      const remaining = data.ChargeAmount - data.PaidAmount;
      const status = remaining > 0 ? (data.PaidAmount > 0 ? 'partial' : 'unpaid') : 'completed';
      const profit = data.ChargeAmount - data.ServiceCost - data.Amount - (data.TransferCost || 0);

      // Check sufficient balance in payment method for service cost (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      if (allowNegCash?.Value !== '1' && data.PaymentMethodID && data.Amount > 0) {
        const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
        if (!pm || (pm.Balance || 0) < data.Amount) {
          return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
        }
      }

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO service_sales (
            ServiceNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
            ServiceType, Provider, TargetPhone, Amount, ServiceCost, ChargeAmount,
            PaidAmount, RemainingAmount, Profit, PaymentMethod, CashAccountID, PaymentMethodID,
            TransferCost, Status, Notes, UserID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          serviceNumber, data.fiscalYearId, dateStr,
          data.CustomerID ?? null, data.CustomerName ?? null, data.CustomerPhone ?? null,
          data.ServiceType, data.Provider, data.TargetPhone,
          data.Amount, data.ServiceCost, data.ChargeAmount,
          data.PaidAmount, remaining, profit,
          data.PaymentMethod, data.CashAccountID ?? null, data.PaymentMethodID ?? null,
          data.TransferCost || 0, status, data.Notes ?? null, data.userId
        );

        if (data.CustomerID && remaining > 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(remaining, data.CustomerID);
        } else if (data.CustomerID && remaining < 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(remaining), data.CustomerID);
        }

        if (data.PaidAmount > 0 && data.CashAccountID) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(data.PaidAmount, data.CashAccountID);
        }

        if (data.PaymentMethodID && data.Amount > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(data.Amount, data.PaymentMethodID);
        }
      });

      tx();
      return { success: true, serviceNumber, profit, remaining, status };
    } catch (err: any) {
      console.error('[ServiceSales] Error:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });

  // Get service sale details
  ipcMain.handle('serviceSales:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT ss.*, c.Name as CustomerName, c.Phone as CustomerPhone, c.Balance as CustomerBalance
      FROM service_sales ss
      LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
      WHERE ss.ServiceSaleID = ?
    `).get(id);
  });
}
