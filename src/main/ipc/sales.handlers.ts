import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { resolveSourceWarehouse, deductStock, restoreStock, totalStock } from '../database/stock';
import { businessToday } from '../../shared/businessDate';

export function registerSalesHandlers() {
  // ===== SALES =====
  ipcMain.handle('sales:list', async (_event, filters?: { fromDate?: string; toDate?: string; customerId?: number }) => {
    const db = getDb();
    let query = `
      SELECT s.*, c.Name as CustomerName, u.Username
      FROM sales s
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      JOIN users u ON s.UserID = u.UserID
      WHERE s.IsVoided = 0
    `;
    const params: any[] = [];
    if (filters?.fromDate) { query += ' AND s.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND s.Date <= ?'; params.push(filters.toDate); }
    if (filters?.customerId) { query += ' AND s.CustomerID = ?'; params.push(filters.customerId); }
    query += ' ORDER BY s.Date DESC, s.SaleID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('sales:get', async (_event, saleId: number) => {
    const db = getDb();
    const sale = db.prepare(`
      SELECT s.*, c.Name as CustomerName, c.Phone as CustomerPhone, c.Email as CustomerEmail, c.Address as CustomerAddress, c.Balance as CustomerBalance, c.Status as CustomerStatus
      FROM sales s
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      WHERE s.SaleID = ?
    `).get(saleId);
    const details = db.prepare(`
      SELECT sd.*, i.ItemName, i.ItemType
      FROM sale_details sd
      LEFT JOIN items i ON sd.ItemID = i.ItemID
      WHERE sd.SaleID = ?
    `).all(saleId);
    return { sale, details };
  });

  ipcMain.handle('sales:create', async (_event, data: {
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    items: { ItemID: number; SerialID?: number; IMEI?: string; Quantity: number; UnitPrice: number; UnitCost?: number; IsWarranty?: number; WarrantyMonths?: number; isService?: boolean; ServiceName?: string; WarehouseID?: number }[];
    Discount: number; TaxRate: number; TaxAmount: number;
    PaymentMethod: string; PaidAmount: number; TransferCost?: number;
    CashAccountID?: number; PaymentMethodID?: number;
    Notes?: string; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    // Normalise the payment target: money can only land in ONE account.
    // A payment method (machine/wallet) wins over a cash account when both are
    // supplied, and the sale row stores only the one that was actually credited
    // so that reversals (delete:sale) stay symmetrical.
    const paymentMethodId = data.PaymentMethodID ?? null;
    const cashAccountId = paymentMethodId ? null : (data.CashAccountID ?? null);

    try {
      // Check if customer is suspended
      if (data.CustomerID) {
        const customer = db.prepare('SELECT Status, Balance FROM customers WHERE CustomerID = ?').get(data.CustomerID) as any;
        if (customer?.Status === 'suspended') {
          return { success: false, message: 'العميل محظور - لا يمكن إتمام عملية البيع' };
        }
      }

      // === STOCK VALIDATION ===
      // Check if negative stock is allowed
      const negativeStockSetting = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;
      const allowNegativeStock = negativeStockSetting?.Value === '1';

      if (!allowNegativeStock) {
        for (const item of data.items) {
          if (item.isService) continue; // Skip service items
          if (item.SerialID) {
            // Check serial exists and is available
            const serial = db.prepare("SELECT Status FROM item_serials WHERE SerialID = ?").get(item.SerialID) as any;
            if (!serial || serial.Status !== 'available') {
              return { success: false, message: `الجهاز برقم IMEI غير متاح للبيع` };
            }
          } else if (item.ItemID) {
            // Check stock quantity
            const availableQty = totalStock(db, item.ItemID);
            if (item.Quantity > availableQty) {
              // Get item name for better message
              const itemInfo = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(item.ItemID) as any;
              return { success: false, message: `الرصيد غير كافي للصنف "${itemInfo?.ItemName || ''}" - المتاح: ${availableQty} - المطلوب: ${item.Quantity}` };
            }
          }
        }
      }

      const subtotal = data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitPrice), 0);
      const totalAmount = subtotal - data.Discount + data.TaxAmount;
      const paidAmount = data.PaidAmount || 0;
      const remaining = totalAmount - paidAmount; // positive = customer owes, negative = customer overpaid (credit)

      const dateStr = businessToday();
      const saleNumber = nextDocNumber(db, 'sales', 'SaleNumber', 'SAL', dateStr);

      const status = remaining > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'completed';

      const tx = db.transaction(() => {
        // Create sale
        const result = db.prepare(`
          INSERT INTO sales (SaleNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
            Subtotal, Discount, TaxRate, TaxAmount, TotalAmount, PaidAmount, RemainingAmount,
            PaymentMethod, CashAccountID, PaymentMethodID, Status, UserID, Notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          saleNumber, data.fiscalYearId, dateStr,
          data.CustomerID ?? null, data.CustomerName ?? null, data.CustomerPhone ?? null,
          subtotal, data.Discount, data.TaxRate, data.TaxAmount, totalAmount,
          paidAmount, remaining, data.PaymentMethod,
          cashAccountId, paymentMethodId,
          status, data.userId, data.Notes ? `${data.Notes} | عمولة تحويل: ${data.TransferCost || 0}` : (data.TransferCost ? `عمولة تحويل: ${data.TransferCost}` : null)
        );

        const saleId = result.lastInsertRowid;

        // Add sale details and update stock
        for (const item of data.items) {
          // Resolve the warehouse up-front and STORE it, so returns/deletes
          // put the stock back exactly where it came from.
          const lineWarehouse = item.isService || !item.ItemID
            ? null
            : resolveSourceWarehouse(db, item.ItemID, item.Quantity, item.WarehouseID ?? null);

          db.prepare(`
            INSERT INTO sale_details (SaleID, ItemID, SerialID, IMEI, Quantity, UnitPrice, UnitCost, Total, IsWarranty, WarrantyMonths, WarehouseID)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            saleId,
            item.isService ? null : (item.ItemID || null),
            item.SerialID ?? null,
            item.isService ? (item.ServiceName || null) : (item.IMEI ?? null),
            item.Quantity, item.UnitPrice, item.UnitCost ?? null,
            item.Quantity * item.UnitPrice,
            item.IsWarranty ?? 0, item.WarrantyMonths ?? null,
            lineWarehouse
          );

          // Skip stock operations for service items
          if (item.isService) continue;

          // Mark serial as sold
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'sold' WHERE SerialID = ?").run(item.SerialID);
          }

          // Deduct from the resolved warehouse (for non-serialized items)
          if (!item.SerialID && item.ItemID && lineWarehouse) {
            deductStock(db, item.ItemID, lineWarehouse, item.Quantity);
          }
        }

        // === CUSTOMER BALANCE HANDLING ===
        // remaining > 0: customer owes money → increase balance (debit)
        // remaining < 0: customer overpaid → decrease balance (credit to customer)
        // remaining = 0: fully paid, no change
        if (data.CustomerID && remaining !== 0) {
          if (remaining > 0) {
            // Customer owes remaining amount
            db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(remaining, data.CustomerID);
          } else {
            // Customer overpaid - credit the excess to their account
            // remaining is negative, so we subtract the absolute value
            db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(remaining), data.CustomerID);
          }
        }

        // === CASH ACCOUNT / PAYMENT METHOD HANDLING ===
        // The money arrives in exactly ONE place. Previously both branches were
        // independent `if`s, so selecting a cash account AND a payment method
        // credited the paid amount twice, inventing cash out of thin air.
        if (paidAmount > 0) {
          if (paymentMethodId) {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(paidAmount, paymentMethodId);
          } else if (cashAccountId) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(paidAmount, cashAccountId);
          }
        }
      });

      tx();
      return { success: true, saleNumber, totalAmount, paidAmount, remaining, status };
    } catch (err: any) {
      console.error('[Sales] Error creating sale:', err);
      return { success: false, message: `خطأ في إنشاء الفاتورة: ${err.message || err}` };
    }
  });

  // ===== SALE RETURNS =====
  ipcMain.handle('saleReturns:list', async () => {
    const db = getDb();
    return db.prepare(`
      SELECT r.*, s.SaleNumber, c.Name as CustomerName
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      ORDER BY r.Date DESC
    `).all();
  });

  ipcMain.handle('saleReturns:create', async (_event, data: {
    SaleID: number; items: { ItemID: number; SerialID?: number; Quantity: number; UnitPrice: number }[];
    Reason?: string; CashAccountID?: number; userId: number;
  }) => {
    const db = getDb();
    const totalAmount = data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitPrice), 0);
    const dateStr = businessToday();
    const returnNumber = nextDocNumber(db, 'sale_returns', 'ReturnNumber', 'SR', dateStr);

    // === SPLIT THE REFUND BETWEEN DEBT RELIEF AND CASH ===
    // A return must first cancel whatever the customer still OWES on that
    // invoice; only the remainder is genuinely refundable in cash.
    // Previously the full amount was BOTH paid out in cash AND deducted from
    // the customer balance, refunding the money twice.
    const originalSale = db.prepare(
      'SELECT CustomerID, TotalAmount, PaidAmount, RemainingAmount FROM sales WHERE SaleID = ?'
    ).get(data.SaleID) as any;
    if (!originalSale) return { success: false, message: 'الفاتورة الأصلية غير موجودة' };

    // How much of this invoice is still outstanding (never below zero).
    const outstanding = Math.max(0, originalSale.RemainingAmount || 0);
    // Already-returned value, so repeated partial returns cannot over-refund.
    const priorReturns = (db.prepare(
      'SELECT COALESCE(SUM(TotalAmount),0) as total FROM sale_returns WHERE SaleID = ?'
    ).get(data.SaleID) as any)?.total || 0;

    if (priorReturns + totalAmount > (originalSale.TotalAmount || 0) + 0.001) {
      return {
        success: false,
        message: `قيمة المرتجع تتجاوز قيمة الفاتورة: إجمالي الفاتورة ${(originalSale.TotalAmount || 0).toFixed(2)}، مرتجع سابق ${priorReturns.toFixed(2)}، المطلوب ${totalAmount.toFixed(2)}`,
      };
    }

    // Debt relief comes first, cash refund covers what the customer actually paid.
    const remainingDebtAfterPriorReturns = Math.max(0, outstanding - priorReturns);
    const debtRelief = Math.min(totalAmount, remainingDebtAfterPriorReturns);
    const cashRefund = +(totalAmount - debtRelief).toFixed(2);

    // Check sufficient cash for the portion actually paid back in cash
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && data.CashAccountID && cashRefund > 0) {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < cashRefund) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لرد المبلغ: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${cashRefund.toFixed(2)}` };
      }
    }

    try {
      const tx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO sale_returns (ReturnNumber, SaleID, Date, TotalAmount, Reason, UserID, CashAccountID,
            DebtRelief, CashRefund)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(returnNumber, data.SaleID, dateStr, totalAmount, data.Reason ?? null, data.userId,
               data.CashAccountID ?? null, debtRelief, cashRefund);

        const returnId = result.lastInsertRowid;

        for (const item of data.items) {
          // Put the goods back into the warehouse the sale took them from.
          const origLine = db.prepare(
            'SELECT WarehouseID FROM sale_details WHERE SaleID = ? AND ItemID IS ? LIMIT 1'
          ).get(data.SaleID, item.ItemID) as any;
          const returnWarehouse = origLine?.WarehouseID
            ?? resolveSourceWarehouse(db, item.ItemID, 0, null);

          db.prepare(`
            INSERT INTO sale_return_details (ReturnID, ItemID, SerialID, Quantity, UnitPrice, Total, WarehouseID)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitPrice, item.Quantity * item.UnitPrice, returnWarehouse);

          // Restore serial status
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(item.SerialID);
          }

          // Restore stock quantity into the correct warehouse
          if (!item.SerialID && returnWarehouse) {
            restoreStock(db, item.ItemID, returnWarehouse, item.Quantity);
          }
        }

        // Pay back only the cash portion (what the customer actually handed over)
        if (data.CashAccountID && cashRefund > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(cashRefund, data.CashAccountID);
        }

        // Cancel the outstanding debt portion on the customer account
        if (originalSale.CustomerID && debtRelief > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(debtRelief, originalSale.CustomerID);
        }

        // Keep the invoice consistent with what is still owed after the return
        db.prepare(`
          UPDATE sales
          SET RemainingAmount = MAX(0, RemainingAmount - ?),
              Status = CASE WHEN MAX(0, RemainingAmount - ?) <= 0 THEN 'completed' ELSE Status END
          WHERE SaleID = ?
        `).run(debtRelief, debtRelief, data.SaleID);
      });

      tx();
      return { success: true, returnNumber };
    } catch (err: any) {
      console.error('[Sales] Error creating return:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });
}
