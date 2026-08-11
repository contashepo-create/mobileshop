import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { safeFailure, safeMessage } from '../security/errorResponse';
import { requireId } from '../../shared/validate';
import { nextDocNumber } from '../database/docNumber';
import { resolveSourceWarehouse, warehouseStock, deductStock, deductStockAtCost, restoreStockAtCost, recordValuationResidual, addStockLot } from '../database/stock';
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

        // An IMEI identifies ONE physical handset. Receiving one that is
        // already on the shelf means either a typo or the same phone counted
        // twice, and the books would then show two units where one exists.
        // Re-receiving a handset that was sold, returned to the supplier or
        // written off is fine — that record is simply reactivated below.
        if (item.IMEI) {
          const onShelf = db.prepare(
            "SELECT SerialID FROM item_serials WHERE IMEI = ? AND Status = 'available'",
          ).get(item.IMEI) as any;
          if (onShelf) {
            return {
              success: false,
              message: `الرقم التسلسلي (IMEI) ${item.IMEI} موجود بالفعل في المخزن — لا يمكن استلام نفس الجهاز مرتين`,
            };
          }
        }

        // Two lines of the SAME invoice cannot carry one IMEI either.
        if (item.IMEI && data.items.filter(x => x.IMEI && x.IMEI === item.IMEI).length > 1) {
          return {
            success: false,
            message: `الرقم التسلسلي (IMEI) ${item.IMEI} مكرر في نفس الفاتورة`,
          };
        }

        // A serialised line is one physical device, so it cannot carry a
        // quantity other than 1 — otherwise one IMEI would stand for several
        // units and the count could never agree with the device list.
        const serialised = (db.prepare(
          'SELECT IsSerialized FROM items WHERE ItemID = ?',
        ).get(item.ItemID) as any)?.IsSerialized;
        if (serialised && item.IMEI && Number(item.Quantity) !== 1) {
          return {
            success: false,
            message: 'الجهاز ذو الرقم التسلسلي يجب أن تكون كميته 1 — أضف سطراً لكل جهاز',
          };
        }
      }

      // Normalised, not merely validated.
      //
      // The check below reads `value ?? 0`, but the INSERT further down bound
      // `data.Discount` RAW. An omitted field therefore passed validation as 0
      // and then reached better-sqlite3 as `undefined`, throwing
      // "Provided value cannot be bound to SQLite parameter 6." out of the
      // handler — a crash, not a reply. Defaulting on `data` makes them agree.
      data = {
        ...data,
        Discount: num(data.Discount ?? 0),
        TaxAmount: num(data.TaxAmount ?? 0),
        PaidAmount: num(data.PaidAmount ?? 0),
        AdditionalCost: num(data.AdditionalCost ?? 0),
        PaymentCost: num(data.PaymentCost ?? 0),
      };
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
        // === RE-CHECK THE DRAWER, NOW THAT THE WRITE LOCK IS HELD ===
        //
        // The balance check above ran before this transaction opened, so
        // another till could have spent the money in between. On a shared
        // network database (`db:createNetwork`) that is a real window, and it
        // was verified: a payment of 900 committed against an empty drawer and
        // left it at -900. Re-reading here cannot be overtaken, because SQLite
        // serialises writers. Throwing rolls everything back.
        if (allowNegCash?.Value !== '1' && paidAmount > 0 && data.PaymentSourceID) {
          const table = data.PaymentSourceType === 'cash_account' ? 'cash_accounts' : 'payment_methods';
          const idCol = data.PaymentSourceType === 'cash_account' ? 'CashAccountID' : 'PaymentMethodID';
          const row = db.prepare(
            `SELECT Balance FROM ${table} WHERE ${idCol} = ?`,
          ).get(data.PaymentSourceID) as any;
          if (!row || (row.Balance || 0) < paidAmount) {
            const refusal = new Error(
              `الرصيد غير كافٍ: المتاح ${(row?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}`);
            (refusal as any).userRefusal = true;
            throw refusal;
          }
        }

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

        // A discount from the supplier REDUCES what the goods cost.
        //
        // The landed cost started from the list price and only ever added
        // shipping, so an invoice-level discount was ignored: buying 10 cables
        // at 100 with a 200 discount put 1,000 of stock on the shelf though only
        // 800 was owed, inventing 200 of inventory value at the moment of
        // purchase. Spread in proportion to line value, exactly as the invoice
        // total was formed, and net of tax which is not part of the goods' cost
        // to the shop when it is recoverable.
        const discountShare = totalItemCost > 0 ? (data.Discount || 0) / totalItemCost : 0;

        for (const item of data.items) {
          const itemBaseCost = item.Quantity * item.UnitCost;
          // Distribute overhead proportionally by item cost
          let allocatedOverhead = 0;
          if (totalItemCost > 0) {
            allocatedOverhead = (itemBaseCost / totalItemCost) * overhead;
          } else if (data.items.length > 0) {
            allocatedOverhead = overhead / data.items.length * (item.Quantity / data.items.reduce((s, i) => s + i.Quantity, 0));
          }
          // This line's share of the discount, per unit.
          const discountPerUnit = item.UnitCost * discountShare;
          // Guard the division: a line with Quantity = 0 makes this Infinity in
          // JavaScript (no exception), and Infinity was then written straight
          // into stock_quantities.CostPrice, permanently destroying the
          // inventory valuation and every report derived from it.
          const effectiveUnitCost = item.Quantity > 0
            ? (item.UnitCost - discountPerUnit) + (allocatedOverhead / item.Quantity)
            : item.UnitCost;

          db.prepare(`
            INSERT INTO purchase_details (PurchaseID, ItemID, IMEI, Quantity, UnitCost, UnitPrice, Total, WarehouseID, EffectiveUnitCost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(purchaseId, item.ItemID, item.IMEI ?? null, item.Quantity, item.UnitCost,
                 item.UnitPrice ?? null, itemBaseCost, item.WarehouseID, effectiveUnitCost);

          // Add IMEI if provided.
          //
          // A handset that went back to the supplier, or was written off, can
          // legitimately be received again — the same physical phone returning
          // to the shelf. That is an UPDATE of the existing record, not a new
          // one, and it must carry the price just paid for it.
          //
          // Silently doing nothing (the previous behaviour) still added a unit
          // and its value to `stock_quantities`, so the pool counted two units
          // where one handset existed and valued it at a stale cost. The
          // warehouse total drifted away from the IMEI list permanently.
          if (item.IMEI) {
            const existingSerial = db.prepare(
              'SELECT SerialID, Status FROM item_serials WHERE IMEI = ?',
            ).get(item.IMEI) as any;
            if (!existingSerial) {
              db.prepare(`
                INSERT INTO item_serials (ItemID, IMEI, Status, CostPrice, WarehouseID)
                VALUES (?, ?, 'available', ?, ?)
              `).run(item.ItemID, item.IMEI, effectiveUnitCost, item.WarehouseID);
            } else {
              db.prepare(`
                UPDATE item_serials
                SET Status = 'available', CostPrice = ?, WarehouseID = ?, ItemID = ?
                WHERE SerialID = ?
              `).run(effectiveUnitCost, item.WarehouseID, item.ItemID, existingSerial.SerialID);
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

          // Record the delivery as its own cost layer, at the LANDED cost.
          //
          // This is what lets a later sale or return be valued at what these
          // particular units actually cost, instead of a blended average that
          // describes no real unit. The pool above is still maintained, so
          // everything that reads it is unaffected.
          addStockLot(db, item.ItemID, item.WarehouseID, item.Quantity, effectiveUnitCost,
            { type: 'purchase', id: Number(purchaseId), date: dateStr });

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
      // A refusal written for the user passes through, but is still screened:
      // several are built by interpolation and could carry a path or a
      // constraint name without anyone noticing.
      if (err?.userRefusal) return safeMessage('purchases:create', err.message, err);
      console.error('[Purchases] Error creating purchase:', err);
      return safeFailure('purchases:create', err, 'خطأ في إنشاء الفاتورة');
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

    // The EFFECTIVE cost of a line: what the shop really owed per unit after
    // that line's share of any invoice-level discount or tax.
    //
    // `purchase_details.UnitCost` is the price before those. Crediting at it
    // returned more than was ever owed: 10 cables at 100 with a 200 discount
    // is an 800 invoice, yet returning 8 units at the line cost credited the
    // whole 800 and wiped the supplier's balance while 2 cables stayed on the
    // shelf. The total guard did not catch it, because 800 does not exceed 800.
    //
    // Delivery charges (`AdditionalCost`) are deliberately EXCLUDED from the
    // ratio: the supplier never credits the shop's own shipping, and that cost
    // is already handled separately as unrecoverable freight.
    const purHdr = db.prepare(
      'SELECT Subtotal, TotalAmount, COALESCE(AdditionalCost,0) AS AdditionalCost, COALESCE(PaymentCost,0) AS PaymentCost FROM purchases WHERE PurchaseID = ?',
    ).get(data.PurchaseID) as any;
    const grossGoods = Number(purHdr?.Subtotal) || 0;
    const netGoods = (Number(purHdr?.TotalAmount) || 0)
      - (Number(purHdr?.AdditionalCost) || 0) - (Number(purHdr?.PaymentCost) || 0);
    const costRatio = grossGoods > 0 ? netGoods / grossGoods : 1;

    // Aggregated per item for the same reason as the sale side: an invoice may
    // carry one item on several lines, while returns are recorded per item.
    const boughtLines = db.prepare(`
      SELECT pd.ItemID,
             SUM(pd.Quantity) AS Quantity,
             -- Weighted average, not MAX: an invoice may carry the same item on
             -- several lines at different prices, and MAX would value every
             -- returned unit at the dearest of them.
             SUM(pd.UnitCost * pd.Quantity) / NULLIF(SUM(pd.Quantity),0) AS UnitCost,
             SUM(COALESCE(pd.EffectiveUnitCost, pd.UnitCost) * pd.Quantity)
               / NULLIF(SUM(pd.Quantity),0) AS EffectiveUnitCost,
             MAX(pd.WarehouseID) AS WarehouseID,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM purchase_return_details rd
               JOIN purchase_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.PurchaseID = pd.PurchaseID AND rd.ItemID = pd.ItemID
             ), 0) AS AlreadyReturned
      FROM purchase_details pd WHERE pd.PurchaseID = ?
      GROUP BY pd.ItemID
    `).all(data.PurchaseID) as any[];

    const verified: Array<{
      ItemID: number; SerialID: number | null; Quantity: number;
      UnitCost: number; EffectiveUnitCost: number; WarehouseID: number | null;
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
        // Carried so the reversal knows the freight embedded in these units.
        EffectiveUnitCost: line.EffectiveUnitCost ?? line.UnitCost ?? 0,
        // The supplier credits what they charged, so the return is valued at the
        // invoice price — not the landed cost, which includes our own shipping.
        // Credited at the EFFECTIVE cost, so the supplier is credited what the
        // shop actually owed for these units and no more.
        UnitCost: money((line.UnitCost || 0) * costRatio),
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

        // For a handset, a sufficient QUANTITY is not sufficient proof.
        //
        // The units on this invoice are specific devices. If they have since
        // been sold, the shop cannot hand them back to the supplier no matter
        // how many other phones of the same model are in stock. Accepting it
        // deducted a unit of value while no device left the shelf, so the
        // warehouse count and the IMEI list disagreed permanently.
        const isSerialised = (db.prepare(
          'SELECT IsSerialized FROM items WHERE ItemID = ?',
        ).get(item.ItemID) as any)?.IsSerialized;
        if (isSerialised) {
          if (item.SerialID) {
            const s = db.prepare(
              'SELECT Status, IMEI FROM item_serials WHERE SerialID = ?',
            ).get(item.SerialID) as any;
            if (!s || s.Status !== 'available') {
              return {
                success: false,
                message: `الجهاز (IMEI ${s?.IMEI ?? item.SerialID}) لم يعد بالمخزن — لا يمكن رده للمورد`,
              };
            }
          } else {
            // No serial named: count how many of THIS invoice's devices are
            // still on the shelf and available to send back.
            const onShelf = (db.prepare(`
              SELECT COUNT(*) AS n FROM item_serials s
              JOIN purchase_details pd ON pd.IMEI = s.IMEI AND pd.PurchaseID = ?
              WHERE s.ItemID = ? AND s.Status = 'available'
            `).get(data.PurchaseID, item.ItemID) as any)?.n || 0;
            // Only enforced when this invoice actually recorded IMEIs; a
            // serialised item received without one has no device to check.
            const tracked = (db.prepare(`
              SELECT COUNT(*) AS n FROM purchase_details
              WHERE PurchaseID = ? AND ItemID = ? AND IMEI IS NOT NULL AND IMEI <> ''
            `).get(data.PurchaseID, item.ItemID) as any)?.n || 0;
            if (tracked > 0 && onShelf < item.Quantity) {
              const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(item.ItemID) as any;
              return {
                success: false,
                message: `أجهزة "${info?.ItemName || item.ItemID}" من هذه الفاتورة لم تعد بالمخزن (بيعت أو رُدّت): المطلوب ${item.Quantity}، المتاح ${onShelf}`,
              };
            }
          }
        }
      }
    }

    const tx = db.transaction(() => {
      // === RE-CHECK STOCK, NOW THAT THE WRITE LOCK IS HELD ===
      // Same race as the sale side: the availability check above ran before
      // this transaction opened. Verified to drive a warehouse to -5.
      if (allowNegStock?.Value !== '1') {
        for (const item of verified) {
          const wh = lineWarehouse(item.ItemID, item.WarehouseID);
          const held = wh ? warehouseStock(db, item.ItemID, wh) : 0;
          if (held < item.Quantity) {
            const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(item.ItemID) as any;
            throw new Error(
              `الكمية غير متوفرة في المخزن للمرتجع للصنف "${info?.ItemName || item.ItemID}": `
              + `المطلوب ${item.Quantity}، المتاح ${held}`);
          }
        }
      }

      const result = db.prepare(`
        INSERT INTO purchase_returns (ReturnNumber, PurchaseID, Date, TotalAmount, Reason, UserID, CashAccountID,
          DebtRelief, CashRefund, TransferRefund, PaymentMethodID, TransferCost, TransferCostBearer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, data.PurchaseID, dateStr, totalAmount, data.Reason ?? null, data.userId,
             data.CashAccountID ?? null, debtRelief, cashRefund,
             settlement.transferRefund, data.PaymentMethodID ?? null,
             settlement.transferCost, settlement.transferCostBearer);

      const returnId = result.lastInsertRowid;
      let freightWrittenOff = 0;

      for (const item of verified) {
        // `LandedUnitCost` is what left the warehouse; `UnitCost` is what the
        // supplier credits. They differ by this line's share of the delivery
        // charge, and the reversal needs the former to put back exactly what
        // was taken out.
        const detailId = db.prepare(`
          INSERT INTO purchase_return_details (ReturnID, ItemID, SerialID, Quantity, UnitCost, Total, WarehouseID, LandedUnitCost)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitCost,
               money(item.Quantity * item.UnitCost), lineWarehouse(item.ItemID, item.WarehouseID),
               item.EffectiveUnitCost ?? item.UnitCost ?? 0).lastInsertRowid;

        // Mark the individual handsets as returned.
        //
        // When the caller names a serial, that is the one that goes back. When
        // it does not — the debit-note screen sends item and quantity only —
        // the serials still have to be resolved, because the warehouse quantity
        // IS reduced below either way. Leaving them 'available' created phantom
        // handsets: stock showed zero while the IMEI list still offered a
        // device for sale, and the next sale of it drove the count negative.
        //
        // They are taken from the IMEIs this very purchase brought in, oldest
        // first, and only ones still on the shelf are eligible.
        // The specific handsets that go back, with the cost each one carries.
        // Kept so the warehouse can be relieved of exactly THEIR value below.
        let returnedSerials: Array<{ SerialID: number; CostPrice: number }> = [];
        if (item.SerialID) {
          const s = db.prepare(
            'SELECT SerialID, CostPrice FROM item_serials WHERE SerialID = ?',
          ).get(item.SerialID) as any;
          if (s) returnedSerials = [s];
          db.prepare("UPDATE item_serials SET Status = 'returned' WHERE SerialID = ?").run(item.SerialID);
        } else {
          const isSerialised = (db.prepare(
            'SELECT IsSerialized FROM items WHERE ItemID = ?',
          ).get(item.ItemID) as any)?.IsSerialized;
          if (isSerialised) {
            returnedSerials = db.prepare(`
              SELECT s.SerialID, s.CostPrice FROM item_serials s
              JOIN purchase_details pd
                ON pd.IMEI = s.IMEI AND pd.PurchaseID = ?
              WHERE s.ItemID = ? AND s.Status = 'available'
              ORDER BY s.SerialID
              LIMIT ?
            `).all(data.PurchaseID, item.ItemID, Math.ceil(item.Quantity)) as any[];
            for (const c of returnedSerials) {
              db.prepare("UPDATE item_serials SET Status = 'returned' WHERE SerialID = ?").run(c.SerialID);
            }
          }
        }

        // Deduct from the warehouse the goods actually came into. The previous
        // query had no WarehouseID and silently picked whichever row came
        // first, so returning branch stock drove the main store negative.
        const wh = lineWarehouse(item.ItemID, item.WarehouseID);
        if (wh) {
          // Remove the value these particular units brought in, not the pool's
          // blended average. Buying 10 at 5 into a pool of 10 at 10 gives an
          // average of 7.50; sending those same 10 back at the average destroys
          // 75 of stock value while the supplier credits only 50, so 25 simply
          // vanished from the books.
          // For a SERIALISED line the warehouse must be relieved of the cost of
          // the very handsets being sent back, not the purchase line's figure.
          //
          // The two are different numbers whenever the shop bought the same
          // model at different prices: the pool was reduced by the line cost
          // while a serial carrying a different cost left the shelf, so the
          // remaining quantity and the remaining IMEIs disagreed in value and
          // the inventory total was wrong from then on.
          const landedCost = returnedSerials.length
            ? returnedSerials.reduce((sum, s) => sum + (s.CostPrice || 0), 0) / returnedSerials.length
            : (item.EffectiveUnitCost ?? item.UnitCost ?? 0);
          // Emptying the pool can leave a valuation residual with no units to
          // carry it — see `deductStockAtCost`. It is a real change in the
          // value of what the shop owns, so it is booked with the freight
          // write-off rather than left to disappear.
          // The pool's value BEFORE this line touches it.
          //
          // Every valuation adjustment below is derived from what actually
          // changed, measured here and compared after all the movements. The
          // previous version added up several estimates — a residual from the
          // deduction, a freight write-off, a floor at zero — and those
          // overlapped whenever more than one applied to the same line, so the
          // same loss was charged twice. Measuring once cannot double-count.
          const poolBefore = (db.prepare(
            'SELECT COALESCE(SUM(Quantity * CostPrice), 0) AS v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
          ).get(item.ItemID, wh) as any)?.v || 0;

          const { residual } = deductStockAtCost(db, item.ItemID, wh, item.Quantity, landedCost);
          if (Math.abs(residual) > 1e-9) {
            // Kept on the line so cancelling the return restores exactly this
            // amount to exactly this pool.
            db.prepare('UPDATE purchase_return_details SET ValuationResidual = ? WHERE DetailID = ?')
              .run(residual, detailId);
          }

          // Shipping and fees attached to the returned units do NOT come back.
          //
          // Stock is carried at the LANDED cost (supplier price plus this
          // line's share of shipping), but the supplier only credits what they
          // charged. Removing goods worth 13.50 each while cancelling 12.00 of
          // debt left the difference belonging to nothing: assets fell further
          // than liabilities, and the books drifted by exactly the freight on
          // the returned units.
          //
          // That freight is a genuine, unrecoverable cost — the shop paid to
          // bring in goods it then sent back. It is charged to the remaining
          // stock of the same line, which is where the surviving units' own
          // share of the same delivery already sits. When nothing remains it is
          // written off, since there is no inventory left to carry it.
          const landed = item.EffectiveUnitCost ?? item.UnitCost ?? 0;
          const freightPerUnit = landed - (item.UnitCost || 0);
          // NOT rounded, for the same reason the unit cost above is not.
          //
          // This figure is not a payment to anybody — no one hands over these
          // piastres. It is value already inside the business being moved from
          // the units that left onto the units that stayed, so the amount taken
          // out of the pool and the amount put back must be the SAME number to
          // the last bit.
          //
          // Rounding it broke that: 7.00 of freight over 3 units is 2.3333...
          // per unit, `money()` made it 2.33, and the missing third of a
          // piastre left the books on every partial return.
          const strandedFreight = freightPerUnit * item.Quantity;
          if (strandedFreight > 0) {
            const row = db.prepare(
              'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
            ).get(item.ItemID, wh) as any;
            if (row && row.Quantity > 0) {
              // NOT rounded to two decimals.
              //
              // `money()` is right for a TOTAL, because a total is a real sum
              // of piastres that someone actually pays. It is wrong for a
              // PER-UNIT cost, because this figure is multiplied back by the
              // whole holding every time inventory is valued, which magnifies
              // whatever the rounding discarded by the size of the pool.
              //
              // Spreading 5.00 of freight over 96 units gives 10.052083...
              // Rounding that to 10.05 and re-multiplying values the stock at
              // 964.80 instead of 965.00, so 0.20 left the books with no entry
              // anywhere. The loss scales with the holding — up to 0.005 x N,
              // which is 5.00 on a pool of a thousand units — and it was
              // repeatable on demand, not floating-point noise.
              //
              // The full-precision quotient is kept instead, so
              // Quantity x CostPrice still equals the value that went in.
              // Rounding happens only where money is displayed or paid.
              const newCost = ((row.CostPrice || 0) * row.Quantity + strandedFreight) / row.Quantity;
              db.prepare('UPDATE stock_quantities SET CostPrice = ? WHERE ID = ?').run(newCost, row.ID);

              // The individual devices must absorb it too.
              //
              // For a serialised item the warehouse row and the IMEI records
              // are two views of the same goods. Loading the freight onto the
              // pool alone moved one and not the other: the pool said 655 while
              // the one handset left on the shelf was still recorded at 635, so
              // inventory disagreed with the device list by exactly the freight
              // and stayed wrong for ever after.
              const survivors = db.prepare(`
                SELECT SerialID FROM item_serials
                WHERE ItemID = ? AND WarehouseID = ? AND Status = 'available'
              `).all(item.ItemID, wh) as any[];
              if (survivors.length) {
                const share = strandedFreight / survivors.length;
                for (const sv of survivors) {
                  db.prepare(
                    'UPDATE item_serials SET CostPrice = COALESCE(CostPrice,0) + ? WHERE SerialID = ?',
                  ).run(share, sv.SerialID);
                }
              }

              // Remember that it was absorbed rather than written off, so the
              // reversal takes it back off the survivors instead of guessing.
              db.prepare('UPDATE purchase_return_details SET FreightAbsorbed = ? WHERE DetailID = ?')
                .run(strandedFreight, detailId);
            } else {
              // No units left to carry it: the freight is spent and gone.
              // Recorded so it can be reported as a cost and reconciled later,
              // instead of disappearing silently from the books.
              //
              // Kept at full precision so it equals exactly the value that left
              // the warehouse. Rounding here would make the write-off disagree
              // with the stock movement it is meant to explain, which is the
              // same leak by another route. It is rounded for DISPLAY only.
              // Nothing to do: with an empty pool the freight cannot be
              // carried, and the single measured adjustment below already
              // accounts for every piastre that left the warehouse.
            }
          }

          // ONE adjustment per line, derived from what actually happened.
          //
          //   value the warehouse lost   = poolBefore - poolAfter
          //   value the supplier credits = Quantity x UnitCost
          //
          // Anything the supplier does not credit is a real loss to the shop —
          // unrecoverable freight, a pool floored at zero, an average that no
          // longer matched the units. Measuring the difference covers all of
          // them at once and cannot charge any of them twice.
          const poolAfter = (db.prepare(
            'SELECT COALESCE(SUM(Quantity * CostPrice), 0) AS v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
          ).get(item.ItemID, wh) as any)?.v || 0;
          const creditedBack = item.Quantity * (item.UnitCost || 0);
          const lineAdjustment = (poolBefore - poolAfter) - creditedBack;
          recordValuationResidual(db, {
            date: dateStr,
            itemId: item.ItemID,
            warehouseId: wh,
            amount: lineAdjustment,
            reason: 'فرق تقييم مخزون على مرتجع مشتريات (شحن غير مسترد/تسوية)',
            refType: 'purchase_return',
            refId: Number(returnId),
          });
        }
      }

      // `FreightWrittenOff` is kept up to date for the debit note, which prints
      // it, but the figure charged in the profit report now comes from
      // `inventory_adjustments` alone. Two columns describing the same loss
      // were charged twice and understated profit by the same amount twice.
      const woTotal = (db.prepare(`
        SELECT COALESCE(SUM(Amount),0) AS v FROM inventory_adjustments
        WHERE RefType = 'purchase_return' AND RefID = ?
      `).get(returnId) as any)?.v || 0;
      if (Math.abs(woTotal) > 1e-9) {
        db.prepare('UPDATE purchase_returns SET FreightWrittenOff = ? WHERE ReturnID = ?')
          .run(woTotal, returnId);
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
          SET RemainingAmount = CASE WHEN ROUND(MAX(0, RemainingAmount - ?), 2) < 0.01 THEN 0
                                         ELSE ROUND(MAX(0, RemainingAmount - ?), 2) END,
              Status = CASE WHEN ROUND(MAX(0, RemainingAmount - ?), 2) < 0.01 THEN 'completed' ELSE Status END
          WHERE PurchaseID = ?
        `).run(invoiceOffset, invoiceOffset, invoiceOffset, data.PurchaseID);
      }
      // Stored so cancelling this return restores exactly this much and no
      // more. The reversal used to add back the full credit, which inflated an
      // invoice that owed 4 into one owing 636 and left the supplier account
      // showing money they never received.
      db.prepare('UPDATE purchase_returns SET InvoiceOffset = ? WHERE ReturnID = ?')
        .run(invoiceOffset, returnId);
    });

    // A refusal thrown from inside the transaction (the stock re-check above)
    // must reach the user as a message, not as an unhandled crash. The rollback
    // has already happened, so nothing is half-written either way.
    try {
      tx();
    } catch (err: any) {
      return safeFailure('purchaseReturns:create', err, 'تعذر إتمام المرتجع');
    }
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

    // Offer the EFFECTIVE cost, the same figure the validator will use, so the
    // screen never proposes a credit larger than the shop actually owed.
    const hdr = db.prepare(
      'SELECT Subtotal, TotalAmount, COALESCE(AdditionalCost,0) AS AdditionalCost, COALESCE(PaymentCost,0) AS PaymentCost FROM purchases WHERE PurchaseID = ?',
    ).get(purchaseId) as any;
    const grossGoods = Number(hdr?.Subtotal) || 0;
    const netGoods = (Number(hdr?.TotalAmount) || 0)
      - (Number(hdr?.AdditionalCost) || 0) - (Number(hdr?.PaymentCost) || 0);
    const ratio = grossGoods > 0 ? netGoods / grossGoods : 1;

    return lines.map(l => {
      const notYetReturned = Math.max(0, (l.Quantity || 0) - (l.AlreadyReturned || 0));
      const inStock = l.WarehouseID ? warehouseStock(db, l.ItemID, l.WarehouseID) : 0;
      return {
        ...l,
        UnitCost: money((l.UnitCost || 0) * ratio),
        GrossUnitCost: l.UnitCost,
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
    // Bound straight into the lookups below; a malformed id crashed the
    // handler with a better-sqlite3 bind error instead of replying.
    const _rid = requireId(returnId, 'رقم مرتجع الشراء');
    if (!_rid.ok) return { success: false, message: _rid.message };
    returnId = _rid.value;
    const db = getDb();
    try {
      const ret = db.prepare('SELECT * FROM purchase_returns WHERE ReturnID = ?').get(returnId) as any;
      if (!ret) return { success: false, message: 'المرتجع غير موجود' };

      const purchase = db.prepare('SELECT * FROM purchases WHERE PurchaseID = ?').get(ret.PurchaseID) as any;
      const details = db.prepare('SELECT * FROM purchase_return_details WHERE ReturnID = ?')
        .all(returnId) as any[];

      // A return can only be un-done while its goods are still with the
      // supplier. A handset re-received under a later invoice and then sold
      // again is in neither place: "cancelling the return" would conjure it
      // back onto the shelf from nowhere, re-adding a unit the shop no longer
      // holds and leaving a phantom device available for a second sale.
      //
      // It is identified by serial STATE: 'returned' is the only condition in
      // which the supplier still holds it. Re-receipt flips it to 'available',
      // a sale flips it to 'sold' — either way the cancellation is refused.
      // The pooled analogue (an accessory re-purchased then sold) cannot be
      // told apart from the rest of the pool, so those lines are left alone.
      for (const line of details) {
        if (!line.ItemID) continue;
        const isSerialised = (db.prepare(
          'SELECT IsSerialized FROM items WHERE ItemID = ?',
        ).get(line.ItemID) as any)?.IsSerialized;
        if (!isSerialised) continue;
        const tracked = (db.prepare(`
          SELECT COUNT(*) AS n FROM purchase_details
          WHERE PurchaseID = ? AND ItemID = ? AND IMEI IS NOT NULL AND IMEI <> ''
        `).get(ret.PurchaseID, line.ItemID) as any)?.n || 0;
        if (tracked === 0) continue;
        const qty = Math.ceil(Number(line.Quantity) || 0);
        if (line.SerialID) {
          const s = db.prepare(
            'SELECT Status, IMEI FROM item_serials WHERE SerialID = ?',
          ).get(line.SerialID) as any;
          if (!s || s.Status !== 'returned') {
            return {
              success: false,
              message: `لا يمكن إلغاء المرتجع — الجهاز (IMEI ${s?.IMEI ?? line.SerialID}) لم يعد مرتجعاً للمورد`,
            };
          }
        } else {
          // No serial named on the line: the serials it marked 'returned' are
          // resolved from this purchase, oldest first, exactly as the create
          // side took them off the shelf.
          const onHand = (db.prepare(`
            SELECT COUNT(*) AS n FROM item_serials s
            JOIN purchase_details pd ON pd.IMEI = s.IMEI AND pd.PurchaseID = ?
            WHERE s.ItemID = ? AND s.Status = 'returned'
          `).get(ret.PurchaseID, line.ItemID) as any)?.n || 0;
          if (onHand < qty) {
            const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
            return {
              success: false,
              message: `لا يمكن إلغاء المرتجع — أجهزة "${info?.ItemName || line.ItemID}" لم تعد مرتجعة للمورد (المطلوب ${qty}، المتاح ${onHand})`,
            };
          }
        }
      }

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
          // Put the individual handsets back on the shelf.
          //
          // Both halves run: the quantity is restored below for serialised
          // lines too, so the serials must come back with it or the two records
          // disagree. When the return did not name a serial, the ones it marked
          // 'returned' from this purchase are reinstated, oldest first.
          if (line.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(line.SerialID);
          } else if (line.ItemID) {
            const isSerialised = (db.prepare(
              'SELECT IsSerialized FROM items WHERE ItemID = ?',
            ).get(line.ItemID) as any)?.IsSerialized;
            if (isSerialised) {
              const back = db.prepare(`
                SELECT s.SerialID FROM item_serials s
                JOIN purchase_details pd
                  ON pd.IMEI = s.IMEI AND pd.PurchaseID = ?
                WHERE s.ItemID = ? AND s.Status = 'returned'
                ORDER BY s.SerialID
                LIMIT ?
              `).all(ret.PurchaseID, line.ItemID, Math.ceil(line.Quantity)) as any[];
              for (const b of back) {
                db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(b.SerialID);
              }
            }
          }
          if (line.ItemID && line.WarehouseID) {
            // Back in at the LANDED cost — the value that actually left the
            // warehouse — not the supplier's price.
            //
            // The two differ by this line's share of the delivery charge.
            // Restoring at the supplier price put back less than the return
            // removed, so cancelling a return quietly destroyed the freight:
            // net worth fell and stayed fallen, with no entry to explain it.
            //
            // `LandedUnitCost` is null on rows written before it existed, and
            // for those the supplier price is the best figure available.
            const landed = line.LandedUnitCost ?? line.UnitCost ?? 0;
            restoreStockAtCost(db, line.ItemID, line.WarehouseID, line.Quantity, landed);

            // Put back the valuation the emptied pool could not carry.
            //
            // The return booked it as an adjustment because there were no units
            // left to hold it; now that the goods are back there are, so it
            // belongs to inventory again. Skipping this made cancelling a
            // return leave the shop permanently poorer by the residual.
            // `ValuationResidual` is positive when value was WRITTEN OFF, so
            // undoing it puts that value back onto the restored units.
            const residual = line.ValuationResidual || 0;
            if (Math.abs(residual) > 1e-9) {
              const row = db.prepare(
                'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
              ).get(line.ItemID, line.WarehouseID) as any;
              if (row && row.Quantity > 0) {
                // ADDED back, because a positive residual is value that was
                // written off. Subtracting it removed the value a second time
                // and left the shop poorer by twice the original amount.
                const newCost = ((row.CostPrice || 0) * row.Quantity + residual) / row.Quantity;
                db.prepare('UPDATE stock_quantities SET CostPrice = ? WHERE ID = ?').run(newCost, row.ID);
              }
            }

            // Undo whatever the return did with the unrecoverable freight.
            // If it was loaded onto the units left behind, take it back off
            // them; if the pool was empty it was written off, and putting the
            // goods back at their landed cost has already restored it.
            const absorbed = line.FreightAbsorbed || 0;
            if (absorbed > 0) {
              const row = db.prepare(
                'SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
              ).get(line.ItemID, line.WarehouseID) as any;
              if (row && row.Quantity > 0) {
                // Full precision, for the same reason as on the way in.
                const newCost = ((row.CostPrice || 0) * row.Quantity - absorbed) / row.Quantity;
                db.prepare('UPDATE stock_quantities SET CostPrice = ? WHERE ID = ?').run(newCost, row.ID);
              }
              // Take it back off the devices that absorbed it, mirroring the
              // create side so the two records stay in step.
              const bearers = db.prepare(`
                SELECT SerialID FROM item_serials
                WHERE ItemID = ? AND WarehouseID = ? AND Status = 'available'
              `).all(line.ItemID, line.WarehouseID) as any[];
              if (bearers.length) {
                const share = absorbed / bearers.length;
                for (const bv of bearers) {
                  db.prepare(
                    'UPDATE item_serials SET CostPrice = COALESCE(CostPrice,0) - ? WHERE SerialID = ?',
                  ).run(share, bv.SerialID);
                }
              }
            }
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

          // Restore only what was actually taken off this invoice.
          //
          // The credit given to the supplier and the amount deducted from the
          // invoice are NOT the same number: the invoice can only absorb what
          // it still owed, and any excess stays as a credit on the account.
          // Adding the whole credit back here turned an invoice that owed 4
          // into one owing 636.
          //
          // `InvoiceOffset` is null on returns written before it was recorded;
          // for those, re-derive the same clamp the create used.
          const offset = ret.InvoiceOffset != null
            ? ret.InvoiceOffset
            : money(Math.min(debtRelief, Math.max(0,
                (purchase.TotalAmount || 0) - (purchase.PaidAmount || 0) - (purchase.RemainingAmount || 0))));
          if (offset > 0) {
            db.prepare(`
              UPDATE purchases
              SET RemainingAmount = ROUND(RemainingAmount + ?, 2),
                  Status = CASE WHEN ROUND(RemainingAmount + ?, 2) > 0
                                THEN (CASE WHEN PaidAmount > 0 THEN 'partial' ELSE 'unpaid' END)
                                ELSE 'completed' END
              WHERE PurchaseID = ?
            `).run(offset, offset, ret.PurchaseID);
          }
        }

        // Cancel the valuation adjustments this return recorded.
        //
        // The stock movements above have already put that value back, so
        // leaving the ledger rows in place would charge the loss a second time:
        // the profit report reads this ledger, and the return it belonged to no
        // longer exists. Deleted rather than negated, because the document
        // itself is being erased.
        db.prepare("DELETE FROM inventory_adjustments WHERE RefType = 'purchase_return' AND RefID = ?")
          .run(returnId);

        db.prepare('DELETE FROM purchase_return_details WHERE ReturnID = ?').run(returnId);
        db.prepare('DELETE FROM purchase_returns WHERE ReturnID = ?').run(returnId);
      });

      tx();
      return { success: true, message: 'تم إلغاء مرتجع الشراء وعكس كل تأثيراته' };
    } catch (err: any) {
      console.error('[Purchases] Error reversing return:', err);
      return safeFailure('delete:purchaseReturn', err);
    }
  });
}
