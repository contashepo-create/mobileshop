import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';

export function registerPurchasesHandlers() {
  ipcMain.handle('purchases:list', async (_event, filters?: { fromDate?: string; toDate?: string; supplierId?: number }) => {
    const db = getDb();
    let query = `
      SELECT p.*, sup.Name as SupplierName, u.Username
      FROM purchases p
      JOIN suppliers sup ON p.SupplierID = sup.SupplierID
      JOIN users u ON p.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.fromDate) { query += ' AND p.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND p.Date <= ?'; params.push(filters.toDate); }
    if (filters?.supplierId) { query += ' AND p.SupplierID = ?'; params.push(filters.supplierId); }
    query += ' ORDER BY p.Date DESC, p.PurchaseID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('purchases:get', async (_event, purchaseId: number) => {
    const db = getDb();
    const purchase = db.prepare(`
      SELECT p.*, sup.Name as SupplierName, sup.Phone as SupplierPhone, sup.Balance as SupplierBalance, sup.Status as SupplierStatus
      FROM purchases p
      JOIN suppliers sup ON p.SupplierID = sup.SupplierID
      WHERE p.PurchaseID = ?
    `).get(purchaseId);
    const details = db.prepare(`
      SELECT pd.*, i.ItemName
      FROM purchase_details pd
      JOIN items i ON pd.ItemID = i.ItemID
      WHERE pd.PurchaseID = ?
    `).all(purchaseId);
    return { purchase, details };
  });

  ipcMain.handle('purchases:create', async (_event, data: {
    SupplierID: number;
    items: { ItemID: number; IMEI?: string; Quantity: number; UnitCost: number; UnitPrice?: number; WarehouseID: number }[];
    Discount: number; TaxAmount: number;
    PaidAmount: number;
    AdditionalCost: number;
    PaymentCost: number;
    PaymentSourceType?: 'cash_account' | 'payment_method';
    PaymentSourceID?: number;
    Notes?: string; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    try {
      const supplier = db.prepare('SELECT Status FROM suppliers WHERE SupplierID = ?').get(data.SupplierID) as any;
      if (supplier?.Status === 'suspended') {
        return { success: false, message: 'المورد موقوف - لا يمكن إتمام عملية الشراء' };
      }

      const subtotal = data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitCost), 0);
      const additionalCost = data.AdditionalCost || 0;
      const paymentCost = data.PaymentCost || 0;
      const totalAmount = subtotal - data.Discount + data.TaxAmount + additionalCost + paymentCost;
      const paidAmount = data.PaidAmount || 0;
      const remaining = totalAmount - paidAmount;

      const dateStr = new Date().toISOString().split('T')[0];
      const purchaseNumber = nextDocNumber(db, 'purchases', 'PurchaseNumber', 'PUR', dateStr);

      const status = remaining > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'completed';

      // Check sufficient balance before payment (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      if (allowNegCash?.Value !== '1' && paidAmount > 0 && data.PaymentSourceID) {
        if (data.PaymentSourceType === 'cash_account') {
          const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.PaymentSourceID) as any;
          if (!acc || (acc.Balance || 0) < paidAmount) {
            return { success: false, message: `الرصيد غير كافٍ في الخزينة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}` };
          }
        } else if (data.PaymentSourceType === 'payment_method') {
          const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentSourceID) as any;
          if (!pm || (pm.Balance || 0) < paidAmount) {
            return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}` };
          }
        }
      }

      const tx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO purchases (PurchaseNumber, FiscalYearID, Date, SupplierID, Subtotal, Discount, TaxAmount,
            TotalAmount, PaidAmount, RemainingAmount, AdditionalCost, PaymentCost,
            PaymentSource, PaymentSourceID, Status, UserID, Notes, PaymentMethod)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          purchaseNumber, data.fiscalYearId, dateStr, data.SupplierID,
          subtotal, data.Discount, data.TaxAmount, totalAmount,
          paidAmount, remaining, additionalCost, paymentCost,
          data.PaymentSourceType ?? null, data.PaymentSourceID ?? null,
          status, data.userId, data.Notes ?? null, 'cash'
        );

        const purchaseId = result.lastInsertRowid;

        // Calculate cost distribution overhead
        const totalItemCost = data.items.reduce((s, i) => s + (i.Quantity * i.UnitCost), 0);
        const overhead = additionalCost + paymentCost;

        for (const item of data.items) {
          const itemBaseCost = item.Quantity * item.UnitCost;
          // Distribute overhead proportionally by item cost
          let allocatedOverhead = 0;
          if (totalItemCost > 0) {
            allocatedOverhead = (itemBaseCost / totalItemCost) * overhead;
          } else if (data.items.length > 0) {
            allocatedOverhead = overhead / data.items.length * (item.Quantity / data.items.reduce((s, i) => s + i.Quantity, 0));
          }
          const effectiveUnitCost = item.UnitCost + (allocatedOverhead / item.Quantity);

          db.prepare(`
            INSERT INTO purchase_details (PurchaseID, ItemID, IMEI, Quantity, UnitCost, UnitPrice, Total, WarehouseID)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(purchaseId, item.ItemID, item.IMEI ?? null, item.Quantity, item.UnitCost, item.UnitPrice ?? null, itemBaseCost, item.WarehouseID);

          // Add IMEI if provided
          if (item.IMEI) {
            const existingSerial = db.prepare('SELECT SerialID FROM item_serials WHERE IMEI = ?').get(item.IMEI);
            if (!existingSerial) {
              db.prepare(`
                INSERT INTO item_serials (ItemID, IMEI, Status, CostPrice, WarehouseID)
                VALUES (?, ?, 'available', ?, ?)
              `).run(item.ItemID, item.IMEI, effectiveUnitCost, item.WarehouseID);
            }
          }

          // Add to stock quantity using effectiveUnitCost (includes overhead)
          const existingStock = db.prepare('SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, item.WarehouseID) as any;
          if (existingStock) {
            const newQty = existingStock.Quantity + item.Quantity;
            const newCost = ((existingStock.CostPrice * existingStock.Quantity) + (effectiveUnitCost * item.Quantity)) / newQty;
            db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?').run(newQty, newCost, existingStock.ID);
          } else {
            db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)').run(item.ItemID, item.WarehouseID, item.Quantity, effectiveUnitCost);
          }

          // Update items.CostPrice to reflect weighted average across all warehouses
          const allStock = db.prepare('SELECT SUM(Quantity) as totalQty, SUM(CostPrice * Quantity) as totalValue FROM stock_quantities WHERE ItemID = ?').get(item.ItemID) as any;
          if (allStock && allStock.totalQty > 0) {
            db.prepare('UPDATE items SET CostPrice = ? WHERE ItemID = ?').run(allStock.totalValue / allStock.totalQty, item.ItemID);
          }
        }

        // === SUPPLIER BALANCE ===
        if (remaining !== 0) {
          if (remaining > 0) {
            db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?').run(remaining, data.SupplierID);
          } else {
            db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(Math.abs(remaining), data.SupplierID);
          }
        }

        // === PAYMENT SOURCE ===
        if (paidAmount > 0 && data.PaymentSourceID) {
          if (data.PaymentSourceType === 'cash_account') {
            db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(paidAmount, data.PaymentSourceID);
          } else if (data.PaymentSourceType === 'payment_method') {
            db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(paidAmount, data.PaymentSourceID);
          }
        }
      });

      tx();
      return { success: true, purchaseNumber, totalAmount, paidAmount, remaining, status };
    } catch (err: any) {
      console.error('[Purchases] Error creating purchase:', err);
      return { success: false, message: `خطأ في إنشاء الفاتورة: ${err.message || err}` };
    }
  });

  // ===== PURCHASE RETURNS =====
  ipcMain.handle('purchaseReturns:list', async () => {
    const db = getDb();
    return db.prepare(`
      SELECT r.*, p.PurchaseNumber, sup.Name as SupplierName
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      JOIN suppliers sup ON p.SupplierID = sup.SupplierID
      ORDER BY r.Date DESC
    `).all();
  });

  ipcMain.handle('purchaseReturns:create', async (_event, data: {
    PurchaseID: number; items: { ItemID: number; SerialID?: number; Quantity: number; UnitCost: number }[];
    Reason?: string; CashAccountID?: number; userId: number;
  }) => {
    const db = getDb();
    const totalAmount = data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitCost), 0);
    const dateStr = new Date().toISOString().split('T')[0];
    const returnNumber = nextDocNumber(db, 'purchase_returns', 'ReturnNumber', 'PR', dateStr);

    // === SPLIT THE REFUND BETWEEN DEBT RELIEF AND CASH ===
    // Mirror of the sale-return logic: a purchase return first cancels what we
    // still OWE the supplier; only the already-paid remainder comes back as
    // cash. Previously the full amount was BOTH received in cash AND deducted
    // from the supplier balance, benefitting us twice.
    const originalPurchase = db.prepare(
      'SELECT SupplierID, TotalAmount, PaidAmount, RemainingAmount FROM purchases WHERE PurchaseID = ?'
    ).get(data.PurchaseID) as any;
    if (!originalPurchase) return { success: false, message: 'فاتورة الشراء الأصلية غير موجودة' };

    const outstanding = Math.max(0, originalPurchase.RemainingAmount || 0);
    const priorReturns = (db.prepare(
      'SELECT COALESCE(SUM(TotalAmount),0) as total FROM purchase_returns WHERE PurchaseID = ?'
    ).get(data.PurchaseID) as any)?.total || 0;

    if (priorReturns + totalAmount > (originalPurchase.TotalAmount || 0) + 0.001) {
      return {
        success: false,
        message: `قيمة المرتجع تتجاوز قيمة الفاتورة: إجمالي الفاتورة ${(originalPurchase.TotalAmount || 0).toFixed(2)}، مرتجع سابق ${priorReturns.toFixed(2)}، المطلوب ${totalAmount.toFixed(2)}`,
      };
    }

    const remainingDebtAfterPriorReturns = Math.max(0, outstanding - priorReturns);
    const debtRelief = Math.min(totalAmount, remainingDebtAfterPriorReturns);
    const cashRefund = +(totalAmount - debtRelief).toFixed(2);

    // Check sufficient stock before return (unless negative stock allowed)
    const allowNegStock = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;
    if (allowNegStock?.Value !== '1') {
      for (const item of data.items) {
        const stock = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ?').get(item.ItemID) as any;
        if ((stock?.qty || 0) < item.Quantity) {
          return { success: false, message: `الكمية غير متوفرة للمرتجع للصنف #${item.ItemID}: المطلوب ${item.Quantity}، المتاح ${stock?.qty || 0}` };
        }
      }
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO purchase_returns (ReturnNumber, PurchaseID, Date, TotalAmount, Reason, UserID, CashAccountID)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, data.PurchaseID, dateStr, totalAmount, data.Reason ?? null, data.userId, data.CashAccountID ?? null);

      const returnId = result.lastInsertRowid;

      for (const item of data.items) {
        db.prepare(`
          INSERT INTO purchase_return_details (ReturnID, ItemID, SerialID, Quantity, UnitCost, Total)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitCost, item.Quantity * item.UnitCost);

        // Mark serial as returned
        if (item.SerialID) {
          db.prepare("UPDATE item_serials SET Status = 'returned' WHERE SerialID = ?").run(item.SerialID);
        }

        // Deduct from stock
        const stock = db.prepare('SELECT ID, Quantity FROM stock_quantities WHERE ItemID = ?').get(item.ItemID) as any;
        if (stock) {
          db.prepare('UPDATE stock_quantities SET Quantity = Quantity - ? WHERE ID = ?').run(item.Quantity, stock.ID);
        }
      }

      // Cancel only the part we still owe the supplier
      if (originalPurchase.SupplierID && debtRelief > 0) {
        db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(debtRelief, originalPurchase.SupplierID);
      }

      // Take back in cash only what we had already paid
      if (data.CashAccountID && cashRefund > 0) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(cashRefund, data.CashAccountID);
      }

      // Keep the purchase consistent with what remains owed
      db.prepare(`
        UPDATE purchases
        SET RemainingAmount = MAX(0, RemainingAmount - ?),
            Status = CASE WHEN MAX(0, RemainingAmount - ?) <= 0 THEN 'completed' ELSE Status END
        WHERE PurchaseID = ?
      `).run(debtRelief, debtRelief, data.PurchaseID);
    });

    tx();
    return { success: true, returnNumber };
  });
}
