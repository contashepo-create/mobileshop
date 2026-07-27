import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

export function registerSettlementHandlers() {
  // Apply settlement - actually update balances in DB
  ipcMain.handle('settlements:apply', async (_event, data: {
    section: string;
    items: {
      ItemID: number;
      ItemName: string;
      RecordedBalance: number;
      ActualBalance: number;
      Difference: number;
      AdjustmentType: string;
    }[];
    userId: number;
    fiscalYearId: number;
  }) => {
    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];
    const numResult = db.prepare("SELECT COUNT(*) as count FROM settlements WHERE Date = ?").get(dateStr) as any;
    const settlementNumber = `SET-${dateStr.replace(/-/g, '')}-${(numResult.count + 1).toString().padStart(4, '0')}`;

    const tx = db.transaction(() => {
      // Create settlement record
      const totalDiff = data.items.reduce((s, i) => s + Math.abs(i.Difference), 0);
      const result = db.prepare(`
        INSERT INTO settlements (SettlementNumber, Date, FiscalYearID, Section, TotalDifference, Status, UserID)
        VALUES (?, ?, ?, ?, ?, 'completed', ?)
      `).run(settlementNumber, dateStr, data.fiscalYearId, data.section, totalDiff, data.userId);

      const settlementId = result.lastInsertRowid;

      // Apply each adjustment
      for (const item of data.items) {
        // Record the detail
        db.prepare(`
          INSERT INTO settlement_details (SettlementID, ItemType, ItemID, ItemName, RecordedBalance, ActualBalance, Difference, AdjustmentType)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(settlementId, data.section, item.ItemID, item.ItemName, item.RecordedBalance, item.ActualBalance, item.Difference, item.AdjustmentType);

        // Apply the actual balance change
        if (data.section === 'cash') {
          db.prepare('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = ?').run(item.ActualBalance, item.ItemID);
        } else if (data.section === 'customers') {
          db.prepare('UPDATE customers SET Balance = ? WHERE CustomerID = ?').run(item.ActualBalance, item.ItemID);
        } else if (data.section === 'suppliers') {
          db.prepare('UPDATE suppliers SET Balance = ? WHERE SupplierID = ?').run(item.ActualBalance, item.ItemID);
        } else if (data.section === 'inventory') {
          // For inventory, update stock_quantities
          const stock = db.prepare('SELECT ID FROM stock_quantities WHERE ItemID = ?').get(item.ItemID) as any;
          if (stock) {
            db.prepare('UPDATE stock_quantities SET Quantity = ? WHERE ID = ?').run(item.ActualBalance, stock.ID);
          }
        } else if (data.section === 'paymentMethods') {
          db.prepare('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = ?').run(item.ActualBalance, item.ItemID);
        }
      }
    });

    tx();
    return { success: true, settlementNumber, count: data.items.length };
  });

  // List previous settlements
  ipcMain.handle('settlements:list', async (_event, filters?: { section?: string }) => {
    const db = getDb();
    let query = `
      SELECT s.*, u.Username
      FROM settlements s
      JOIN users u ON s.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.section && filters.section !== 'all') {
      query += ' AND s.Section = ?';
      params.push(filters.section);
    }
    query += ' ORDER BY s.Date DESC, s.SettlementID DESC';
    return db.prepare(query).all(...params);
  });

  // Get settlement details
  ipcMain.handle('settlements:getDetails', async (_event, settlementId: number) => {
    const db = getDb();
    const settlement = db.prepare('SELECT * FROM settlements WHERE SettlementID = ?').get(settlementId);
    const details = db.prepare('SELECT * FROM settlement_details WHERE SettlementID = ?').all(settlementId);
    return { settlement, details };
  });
}
