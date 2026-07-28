import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { resolveSourceWarehouse, warehouseStock, deductStock, restoreStockAtCost } from '../database/stock';
import { businessToday } from '../../shared/businessDate';
import { validateSettlement, suggestSettlement, money } from '../../shared/returnSettlement';

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
      if (!supplier) return { success: false, message: 'المورد غير موجود' };
      if (supplier?.Status === 'suspended') {
        return { success: false, message: 'المورد موقوف - لا يمكن إتمام عملية الشراء' };
      }

      // === INPUT VALIDATION ===
      // Mirrors sales:create. A purchase sets the cost of everything sold
      // afterwards, so a malformed figure here quietly distorts every future
      // margin rather than failing loudly.
      if (!Array.isArray(data.items) || data.items.length === 0) {
        return { success: false, message: 'لا يمكن حفظ فاتورة شراء بدون أصناف' };
      }
      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
      for (const item of data.items) {
        const qty = num(item.Quantity);
        const cost = num(item.UnitCost);
        // Quantity must be strictly positive: zero would divide by zero when
        // allocating overhead, and negative would credit stock that never came.
        if (!Number.isFinite(qty) || qty <= 0) {
          return { success: false, message: 'الكمية يجب أن تكون رقماً أكبر من صفر' };
        }
        if (!Number.isFinite(cost) || cost < 0) {
          return { success: false, message: 'سعر الشراء يجب أن يكون رقماً غير سالب' };
        }
        if (!item.WarehouseID) {
          return { success: false, message: 'اختر المخزن لكل صنف' };
        }
        const wh = db.prepare('SELECT WarehouseID FROM warehouses WHERE WarehouseID = ?').get(item.WarehouseID);
        if (!wh) return { success: false, message: 'المخزن المختار غير موجود' };
      }

      for (const [label, value] of [
        ['الخصم', data.Discount], ['الضريبة', data.TaxAmount],
        ['المدفوع', data.PaidAmount], ['المصاريف الإضافية', data.AdditionalCost],
        ['عمولة الدفع', data.PaymentCost],
      ] as const) {
        const v = num(value ?? 0);
        if (!Number.isFinite(v) || v < 0) {
          return { success: false, message: `${label} يجب أن يكون رقماً غير سالب` };
        }
      }

      const goodsTotal = data.items.reduce((s, i) => s + (num(i.Quantity) * num(i.UnitCost)), 0);
      if (num(data.Discount ?? 0) > goodsTotal) {
        return {
          success: false,
          message: `الخصم (${num(data.Discount).toFixed(2)}) أكبر من إجمالي الأصناف (${goodsTotal.toFixed(2)})`,
        };
      }

      // The account we pay FROM must exist and be usable, otherwise the
      // UPDATE silently matches no rows and the money is never deducted while
      // the invoice still records it as paid.
      if (num(data.PaidAmount ?? 0) > 0) {
        if (!data.PaymentSourceID || !data.PaymentSourceType) {
          return { success: false, message: 'اختر مصدر دفع المبلغ (خزنة أو ماكينة)' };
        }
        if (data.PaymentSourceType === 'cash_account') {
          const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.PaymentSourceID) as any;
          if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
          if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
        } else if (data.PaymentSourceType === 'payment_method') {
          const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentSourceID) as any;
          if (!pm) return { success: false, message: 'ماكينة الدفع المختارة غير موجودة' };
          if (!pm.IsActive) return { success: false, message: 'ماكينة الدفع المختارة غير مفعّلة' };
        }
      }

      const subtotal = data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitCost), 0);
      const additionalCost = data.AdditionalCost || 0;
      const paymentCost = data.PaymentCost || 0;
      const totalAmount = subtotal - data.Discount + data.TaxAmount + additionalCost + paymentCost;
      const paidAmount = data.PaidAmount || 0;
      const remaining = totalAmount - paidAmount;

      const dateStr = businessToday();
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
          // Guard the division: a line with Quantity = 0 makes this Infinity in
          // JavaScript (no exception), and Infinity was then written straight
          // into stock_quantities.CostPrice, permanently destroying the
          // inventory valuation and every report derived from it.
          const effectiveUnitCost = item.Quantity > 0
            ? item.UnitCost + (allocatedOverhead / item.Quantity)
            : item.UnitCost;

          db.prepare(`
            INSERT INTO purchase_details (PurchaseID, ItemID, IMEI, Quantity, UnitCost, UnitPrice, Total, WarehouseID, EffectiveUnitCost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(purchaseId, item.ItemID, item.IMEI ?? null, item.Quantity, item.UnitCost,
                 item.UnitPrice ?? null, itemBaseCost, item.WarehouseID, effectiveUnitCost);

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
            // Weighted average only makes sense when BOTH the existing holding
            // and the resulting holding are positive.
            //
            // In negative-stock mode the existing quantity can be below zero
            // (goods sold before they arrived). Averaging against a negative
            // quantity produced nonsense: -4 units at cost 0 plus 10 units at
            // 15 gave a "weighted average" of 25 per unit — the shop would
            // value stock it paid 15 for at 25, inflating both inventory and
            // future profit. Worse, an exact fill (-10 + 10) divides by zero
            // and stored Infinity.
            //
            // When the prior balance is not a real positive holding, the price
            // just paid IS the cost. Nothing is averaged because there is no
            // earlier valid layer to average with.
            const canAverage = existingStock.Quantity > 0 && newQty > 0;
            const newCost = canAverage
              ? ((existingStock.CostPrice * existingStock.Quantity) + (effectiveUnitCost * item.Quantity)) / newQty
              : effectiveUnitCost;
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
    PurchaseID: number; items: { ItemID: number; SerialID?: number; Quantity: number; UnitCost: number; WarehouseID?: number }[];
    Reason?: string; userId: number;
    // How the value is settled — chosen, not computed. Omitted = suggested.
    AccountCredit?: number; CashRefund?: number; TransferRefund?: number;
    CashAccountID?: number; PaymentMethodID?: number;
    TransferCost?: number; TransferCostBearer?: 'shop' | 'party';
  }) => {
    const db = getDb();
    const dateStr = businessToday();

    // === EVERY FIGURE COMES FROM THE ORIGINAL PURCHASE, NOT THE CALLER ===
    //
    // Same reasoning as the sale return: the caller names the line and the
    // quantity, nothing more. The unit cost is read from `purchase_details`.
    // Trusting the payload let a cheap line be returned at an expensive price —
    //
    //   bought 1 phone @900 + 10 cables @10  (total 1000)
    //   "return 10 cables @100"  -> 1000, the total guard passes
    //     -> 1000 of supplier debt cleared for 100 of goods
    //
    // and let more be sent back than ever arrived on that line.
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: 'حدد الأصناف المرتجعة' };
    }

    const boughtLines = db.prepare(`
      SELECT pd.ItemID, pd.Quantity, pd.UnitCost, pd.EffectiveUnitCost, pd.WarehouseID,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM purchase_return_details rd
               JOIN purchase_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.PurchaseID = pd.PurchaseID AND rd.ItemID = pd.ItemID
             ), 0) AS AlreadyReturned
      FROM purchase_details pd WHERE pd.PurchaseID = ?
    `).all(data.PurchaseID) as any[];

    const verified: Array<{
      ItemID: number; SerialID: number | null; Quantity: number;
      UnitCost: number; WarehouseID: number | null;
    }> = [];

    // Guards against the same line appearing twice in one payload: each entry
    // would otherwise be checked against the committed total only, which is
    // unchanged for both, letting a line of 1 be returned as 2.
    const claimedInThisPayload = new Map<number, number>();

    for (const req of data.items) {
      const qty = Number(req.Quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, message: 'الكمية المرتجعة يجب أن تكون رقماً أكبر من صفر' };
      }
      const line = boughtLines.find(l => l.ItemID === req.ItemID);
      if (!line) {
        return { success: false, message: 'أحد الأصناف المرتجعة غير موجود في فاتورة الشراء الأصلية' };
      }
      const alreadyClaimed = claimedInThisPayload.get(line.ItemID) || 0;
      const remainingOnLine = money(
        (line.Quantity || 0) - (line.AlreadyReturned || 0) - alreadyClaimed);
      if (qty > remainingOnLine + 0.001) {
        const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(req.ItemID) as any;
        return {
          success: false,
          message: `الكمية المرتجعة من "${info?.ItemName || req.ItemID}" أكبر من المشترى: المطلوب ${qty}، المتاح ${Math.max(0, remainingOnLine)}`,
        };
      }
      claimedInThisPayload.set(line.ItemID, alreadyClaimed + qty);
      verified.push({
        ItemID: line.ItemID,
        SerialID: req.SerialID ?? null,
        Quantity: qty,
        // The supplier credits what they charged, so the return is valued at the
        // invoice price — not the landed cost, which includes our own shipping.
        UnitCost: line.UnitCost || 0,
        WarehouseID: line.WarehouseID ?? null,
      });
    }

    const totalAmount = money(verified.reduce((sum, l) => sum + (l.Quantity * l.UnitCost), 0));
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

    const priorCashIn = (db.prepare(
      `SELECT COALESCE(SUM(COALESCE(CashRefund,0) + COALESCE(TransferRefund,0)),0) AS total
         FROM purchase_returns WHERE PurchaseID = ?`
    ).get(data.PurchaseID) as any)?.total || 0;
    const refundableCash = money(Math.max(0, (originalPurchase.PaidAmount || 0) - priorCashIn));

    // === HOW THE VALUE IS SETTLED ===
    // Mirror of the sale-return model. A supplier always has an account, so
    // every combination is available: leave it against what we owe them, take
    // it back in cash, receive it by transfer, or any mix.
    const explicit = data.AccountCredit != null || data.CashRefund != null || data.TransferRefund != null;
    const proposed = explicit
      ? {
          accountCredit: data.AccountCredit ?? 0,
          cashRefund: data.CashRefund ?? 0,
          transferRefund: data.TransferRefund ?? 0,
        }
      : suggestSettlement(totalAmount, Math.max(0, outstanding - priorReturns), true);

    const settlement = validateSettlement({
      total: totalAmount,
      ...proposed,
      hasAccount: true,
      cashAccountId: data.CashAccountID ?? null,
      paymentMethodId: data.PaymentMethodID ?? null,
      transferCost: data.TransferCost ?? 0,
      transferCostBearer: data.TransferCostBearer,
      // We can only take back money we actually paid the supplier.
      paidSoFar: refundableCash,
    });
    if (!settlement.ok) return { success: false, message: settlement.message };

    const debtRelief = settlement.accountCredit;
    const cashRefund = settlement.cashRefund;

    // Money coming IN needs a valid destination, but no balance check: a
    // deposit can never overdraw an account.
    if (cashRefund > 0) {
      const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
      if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
    }
    if (settlement.transferRefund > 0) {
      const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
      if (!pm) return { success: false, message: 'المحفظة/الماكينة المختارة غير موجودة' };
      if (!pm.IsActive) return { success: false, message: 'المحفظة/الماكينة المختارة غير مفعّلة' };
    }

    // Check sufficient stock before return (unless negative stock allowed)
    // Goods go back to the supplier FROM the warehouse they were received into.
    // Resolved once here and reused below so the check and the deduction can
    // never disagree.
    const lineWarehouse = (itemId: number, preferred?: number | null): number | null => {
      if (preferred) return preferred;
      const orig = db.prepare(
        'SELECT WarehouseID FROM purchase_details WHERE PurchaseID = ? AND ItemID = ? LIMIT 1',
      ).get(data.PurchaseID, itemId) as any;
      return orig?.WarehouseID ?? resolveSourceWarehouse(db, itemId, 0, null);
    };

    const allowNegStock = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;
    if (allowNegStock?.Value !== '1') {
      for (const item of verified) {
        const wh = lineWarehouse(item.ItemID, item.WarehouseID);
        // Checked against THAT warehouse, not the total across all of them:
        // stock sitting in another branch cannot be handed to this supplier.
        const qty = wh ? warehouseStock(db, item.ItemID, wh) : 0;
        if (qty < item.Quantity) {
          const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(item.ItemID) as any;
          return {
            success: false,
            message: `الكمية غير متوفرة في المخزن للمرتجع للصنف "${info?.ItemName || item.ItemID}": المطلوب ${item.Quantity}، المتاح ${qty}`,
          };
        }
      }
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO purchase_returns (ReturnNumber, PurchaseID, Date, TotalAmount, Reason, UserID, CashAccountID,
          DebtRelief, CashRefund, TransferRefund, PaymentMethodID, TransferCost, TransferCostBearer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, data.PurchaseID, dateStr, totalAmount, data.Reason ?? null, data.userId,
             data.CashAccountID ?? null, debtRelief, cashRefund,
             settlement.transferRefund, data.PaymentMethodID ?? null,
             settlement.transferCost, settlement.transferCostBearer);

      const returnId = result.lastInsertRowid;

      for (const item of verified) {
        db.prepare(`
          INSERT INTO purchase_return_details (ReturnID, ItemID, SerialID, Quantity, UnitCost, Total, WarehouseID)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitCost,
               money(item.Quantity * item.UnitCost), lineWarehouse(item.ItemID, item.WarehouseID));

        // Mark serial as returned
        if (item.SerialID) {
          db.prepare("UPDATE item_serials SET Status = 'returned' WHERE SerialID = ?").run(item.SerialID);
        }

        // Deduct from the warehouse the goods actually came into. The previous
        // query had no WarehouseID and silently picked whichever row came
        // first, so returning branch stock drove the main store negative.
        const wh = lineWarehouse(item.ItemID, item.WarehouseID);
        if (wh) deductStock(db, item.ItemID, wh, item.Quantity);
      }

      // Cancel only the part we still owe the supplier
      if (originalPurchase.SupplierID && debtRelief > 0) {
        db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(debtRelief, originalPurchase.SupplierID);
      }

      // Cash leg: the supplier hands money back into the drawer.
      if (data.CashAccountID && cashRefund > 0) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(cashRefund, data.CashAccountID);
      }

      // Transfer leg: money arrives in the wallet/machine. If the supplier
      // deducted the provider's fee, we receive less than the agreed figure.
      if (data.PaymentMethodID && settlement.transferRefund > 0) {
        db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?')
          .run(settlement.transferReceived, data.PaymentMethodID);
      }

      // Keep the purchase consistent with what remains owed
      // Only the portion that offsets THIS invoice's outstanding amount
      // reduces it; credit beyond that is carried on the supplier account.
      const invoiceOffset = money(Math.min(debtRelief, outstanding));
      if (invoiceOffset > 0) {
        db.prepare(`
          UPDATE purchases
          SET RemainingAmount = MAX(0, RemainingAmount - ?),
              Status = CASE WHEN MAX(0, RemainingAmount - ?) <= 0 THEN 'completed' ELSE Status END
          WHERE PurchaseID = ?
        `).run(invoiceOffset, invoiceOffset, data.PurchaseID);
      }
    });

    tx();
    return { success: true, returnNumber };
  });

  /** One purchase return with its lines — used to print the debit note. */
  ipcMain.handle('purchaseReturns:get', async (_event, returnId: number) => {
    const db = getDb();
    const header = db.prepare(`
      SELECT r.*, p.PurchaseNumber, p.SupplierID, sup.Name AS SupplierName
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      JOIN suppliers sup ON p.SupplierID = sup.SupplierID
      WHERE r.ReturnID = ?
    `).get(returnId);
    const details = db.prepare(`
      SELECT rd.*, i.ItemName, w.WarehouseName
      FROM purchase_return_details rd
      LEFT JOIN items i ON rd.ItemID = i.ItemID
      LEFT JOIN warehouses w ON rd.WarehouseID = w.WarehouseID
      WHERE rd.ReturnID = ?
    `).all(returnId);
    return { header, details };
  });

  /**
   * How much of each purchase line may still be returned to the supplier.
   *
   * Two independent limits apply, and the smaller one wins:
   *   1. what was bought and not yet returned — you cannot send back more than
   *      arrived;
   *   2. what is physically still in that warehouse — goods already sold to a
   *      customer are gone and cannot also go back to the supplier.
   *
   * Reporting both figures lets the screen explain WHY a line is capped.
   */
  ipcMain.handle('purchaseReturns:returnable', async (_event, purchaseId: number) => {
    const db = getDb();
    const lines = db.prepare(`
      SELECT pd.ItemID, pd.IMEI, pd.Quantity, pd.UnitCost, pd.WarehouseID,
             pd.EffectiveUnitCost, i.ItemName, w.WarehouseName,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM purchase_return_details rd
               JOIN purchase_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.PurchaseID = pd.PurchaseID AND rd.ItemID = pd.ItemID
             ), 0) AS AlreadyReturned
      FROM purchase_details pd
      LEFT JOIN items i ON pd.ItemID = i.ItemID
      LEFT JOIN warehouses w ON pd.WarehouseID = w.WarehouseID
      WHERE pd.PurchaseID = ?
    `).all(purchaseId) as any[];

    return lines.map(l => {
      const notYetReturned = Math.max(0, (l.Quantity || 0) - (l.AlreadyReturned || 0));
      const inStock = l.WarehouseID ? warehouseStock(db, l.ItemID, l.WarehouseID) : 0;
      return {
        ...l,
        InStock: inStock,
        NotYetReturned: notYetReturned,
        Returnable: Math.min(notYetReturned, Math.max(0, inStock)),
        // Set when stock, not the invoice, is the binding constraint — the
        // screen uses it to say "you have already sold some of these".
        LimitedByStock: inStock < notYetReturned,
      };
    });
  });

  /**
   * Reverses a purchase return — the "undo" for a debit note raised in error.
   *
   * Mirror image of `purchaseReturns:create`: the goods come back into the same
   * warehouse at the same landed cost, the cash we took back goes out again,
   * and the debt we had cancelled is restored to the supplier.
   */
  ipcMain.handle('delete:purchaseReturn', async (_event, returnId: number) => {
    const db = getDb();
    try {
      const ret = db.prepare('SELECT * FROM purchase_returns WHERE ReturnID = ?').get(returnId) as any;
      if (!ret) return { success: false, message: 'المرتجع غير موجود' };

      const purchase = db.prepare('SELECT * FROM purchases WHERE PurchaseID = ?').get(ret.PurchaseID) as any;
      const details = db.prepare('SELECT * FROM purchase_return_details WHERE ReturnID = ?')
        .all(returnId) as any[];

      // Undoing the return means paying the supplier back what they refunded
      // us, so the drawer must be able to cover it.
      const cashRefund = ret.CashRefund || 0;
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      if (allowNegCash?.Value !== '1' && ret.CashAccountID && cashRefund > 0) {
        const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?')
          .get(ret.CashAccountID) as any;
        if (!acc || (acc.Balance || 0) < cashRefund) {
          return {
            success: false,
            message: `الرصيد غير كافٍ لإعادة المبلغ للمورد: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${cashRefund.toFixed(2)}`,
          };
        }
      }

      const tx = db.transaction(() => {
        for (const line of details) {
          if (line.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(line.SerialID);
          } else if (line.ItemID && line.WarehouseID) {
            // Back in at the cost the goods left at, so inventory value and the
            // purchase-returns figure in the P&L stay in step.
            restoreStockAtCost(db, line.ItemID, line.WarehouseID, line.Quantity, line.UnitCost || 0);
          }
        }

        if (ret.CashAccountID && cashRefund > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
            .run(cashRefund, ret.CashAccountID);
        }

        // Send back what arrived by transfer — the amount actually received,
        // which is net of the fee when the supplier deducted it.
        const transferReceived = (ret.TransferCostBearer ?? 'shop') === 'party'
          ? money((ret.TransferRefund || 0) - (ret.TransferCost || 0))
          : (ret.TransferRefund || 0);
        if (ret.PaymentMethodID && transferReceived > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?')
            .run(transferReceived, ret.PaymentMethodID);
        }

        const debtRelief = ret.DebtRelief || 0;
        if (purchase?.SupplierID && debtRelief > 0) {
          db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?')
            .run(debtRelief, purchase.SupplierID);
          db.prepare(`
            UPDATE purchases
            SET RemainingAmount = RemainingAmount + ?,
                Status = CASE WHEN RemainingAmount + ? > 0
                              THEN (CASE WHEN PaidAmount > 0 THEN 'partial' ELSE 'unpaid' END)
                              ELSE 'completed' END
            WHERE PurchaseID = ?
          `).run(debtRelief, debtRelief, ret.PurchaseID);
        }

        db.prepare('DELETE FROM purchase_return_details WHERE ReturnID = ?').run(returnId);
        db.prepare('DELETE FROM purchase_returns WHERE ReturnID = ?').run(returnId);
      });

      tx();
      return { success: true, message: 'تم إلغاء مرتجع الشراء وعكس كل تأثيراته' };
    } catch (err: any) {
      console.error('[Purchases] Error reversing return:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });
}
