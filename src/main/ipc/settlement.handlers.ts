import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';
import { checkAmount } from '../../shared/money';

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

    // A stocktake states what was COUNTED. You cannot count minus fifty
    // handsets, and a negative counted balance was being written straight to
    // the shelf: measured, an actual of -50 left the item at -46 units and the
    // stock valuation went negative with it.
    //
    // Cash and wallets are held to the same rule. Customer and supplier
    // balances are NOT — a credit balance there is legitimate, it means the
    // shop owes them.
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: 'لا توجد عناصر للتسوية' };
    }
    const countable = data.section === 'inventory'
      || data.section === 'cash' || data.section === 'paymentMethods';
    for (const item of data.items) {
      const label = `الرصيد الفعلي لـ ${item.ItemName ?? item.ItemID}`;
      const res = checkAmount(item.ActualBalance, label);
      if (countable && !res.ok) {
        return { success: false, message: res.message };
      }
      if (!Number.isFinite(Number(item.ActualBalance))) {
        return { success: false, message: `${label} يجب أن يكون رقماً صحيحاً` };
      }
    }

    const dateStr = businessToday();
    const settlementNumber = nextDocNumber(db, 'settlements', 'SettlementNumber', 'SET', dateStr);

    // Settlement variances must hit the income statement. Writing the new
    // balance without an offsetting entry made shortages/surpluses vanish from
    // profit entirely (a 5,000 cash shortage simply disappeared).
    const activeFy = db.prepare("SELECT FiscalYearID FROM fiscal_years WHERE Status = 'open' ORDER BY StartDate DESC LIMIT 1").get() as any;
    const fiscalYearId = data.fiscalYearId || activeFy?.FiscalYearID || null;

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
          // Inventory rows are per (ItemID, WarehouseID), but the count the
          // user enters is the total ACROSS all warehouses — that is what the
          // stocktake screen shows them.
          //
          // Writing that total into the largest warehouse row treated it as if
          // it were that row's own figure and left every other warehouse
          // untouched. Measured: 10 in the main store plus 4 in the second,
          // counted as 12, ended as 12 + 4 = 16. The shop asked to REMOVE two
          // units and gained two instead, and every count made the error worse.
          //
          // The difference is applied to one row instead, so the item's total
          // ends at exactly the counted figure.
          const target = db.prepare(
            'SELECT ID, Quantity FROM stock_quantities WHERE ItemID = ? ORDER BY Quantity DESC LIMIT 1'
          ).get(item.ItemID) as any;
          if (target) {
            const delta = Number(item.ActualBalance) - Number(item.RecordedBalance);
            const adjusted = Number(target.Quantity || 0) + delta;
            db.prepare('UPDATE stock_quantities SET Quantity = ? WHERE ID = ?').run(adjusted, target.ID);
          } else {
            const wh = db.prepare('SELECT WarehouseID FROM warehouses ORDER BY WarehouseID ASC LIMIT 1').get() as any;
            if (wh) {
              db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, 0)')
                .run(item.ItemID, wh.WarehouseID, item.ActualBalance);
            }
          }
        } else if (data.section === 'paymentMethods') {
          db.prepare('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = ?').run(item.ActualBalance, item.ItemID);
        }

        // === RECOGNISE THE VARIANCE IN P&L ===
        // A shortage is an expense, a surplus is other income. Recorded as a
        // 'general' voucher so both reports pick it up, with CashAccountID left
        // NULL so it does not move any account balance a second time (the
        // balance was already set to the counted value above).
        const diff = +(Number(item.Difference) || 0).toFixed(2);
        if (Math.abs(diff) >= 0.01) {
          const isShortage = diff < 0;
          const vType = isShortage ? 'payment' : 'receipt';
          const vNum = nextDocNumber(db, 'vouchers', 'VoucherNumber', isShortage ? 'SHT' : 'SUR', dateStr);
          db.prepare(`
            INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
              PartyType, PartyName, Description, CashAccountID, ReferenceType, ReferenceID, UserID)
            VALUES (?, ?, ?, ?, ?, 'general', ?, ?, NULL, 'settlement', ?, ?)
          `).run(
            vNum, vType, fiscalYearId, dateStr, Math.abs(diff),
            isShortage ? 'عجز تسوية' : 'زيادة تسوية',
            `${isShortage ? 'عجز' : 'زيادة'} تسوية ${data.section} - ${item.ItemName}`,
            settlementId, data.userId
          );
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
