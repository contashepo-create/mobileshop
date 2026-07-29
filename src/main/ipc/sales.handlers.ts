import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { resolveSourceWarehouse, deductStock, deductStockAtCost, restoreStock, restoreStockAtCost, totalStock, planStockAllocation, recordValuationResidual } from '../database/stock';
import type { StockShortage } from '../database/stock';
import { businessToday } from '../../shared/businessDate';
import { validateSettlement, suggestSettlement, money } from '../../shared/returnSettlement';

/**
 * Turns a shortage into a message that says what to DO about it.
 *
 * "not enough stock" and "enough stock, but spread across branches" look
 * identical in the numbers yet need opposite actions from the user, so they are
 * worded differently. Without this the split case reported the nonsense
 * "available 5 - requested 5".
 */
function describeShortage(db: ReturnType<typeof getDb>, s: StockShortage): string {
  const name = (db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(s.itemId) as any)?.ItemName || '';
  if (s.split) {
    const wh = s.warehouseId
      ? (db.prepare('SELECT WarehouseName FROM warehouses WHERE WarehouseID = ?').get(s.warehouseId) as any)?.WarehouseName
      : null;
    return `الكمية المطلوبة من "${name}" (${s.requested}) غير متوفرة في مخزن واحد — `
      + `المتاح في "${wh || s.warehouseId}" هو ${s.warehouseAvailable} فقط، والإجمالي ${s.available} موزّع على أكثر من مخزن. `
      + `انقل الكمية إلى مخزن واحد أو قسّم السطر على المخازن.`;
  }
  return `الرصيد غير كافي للصنف "${name}" - المتاح: ${s.available} - المطلوب: ${s.requested}`;
}

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
    /** 'shop' (default) = we absorb the fee; 'customer' = it is added to their bill. */
    TransferCostBearer?: 'shop' | 'customer';
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
      // === INPUT VALIDATION ===
      // The renderer checks these too, but the renderer is not a security or
      // integrity boundary: any of these values arriving malformed writes a
      // permanently wrong invoice that no report can later explain.
      if (!Array.isArray(data.items) || data.items.length === 0) {
        return { success: false, message: 'لا يمكن حفظ فاتورة بدون أصناف' };
      }

      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
      for (const item of data.items) {
        const qty = num(item.Quantity);
        const price = num(item.UnitPrice);
        // `Number.isFinite` rejects NaN and Infinity together. A NaN would
        // propagate into Subtotal/TotalAmount and, because SQLite stores NaN as
        // NULL, the invoice would silently disappear from every SUM().
        if (!Number.isFinite(qty) || qty <= 0) {
          return { success: false, message: 'الكمية يجب أن تكون رقماً أكبر من صفر' };
        }
        if (!Number.isFinite(price) || price < 0) {
          return { success: false, message: 'السعر يجب أن يكون رقماً غير سالب' };
        }
      }

      const discountIn = num(data.Discount ?? 0);
      const taxIn = num(data.TaxAmount ?? 0);
      const paidIn = num(data.PaidAmount ?? 0);
      if (!Number.isFinite(discountIn) || discountIn < 0) {
        return { success: false, message: 'الخصم يجب أن يكون رقماً غير سالب' };
      }
      if (!Number.isFinite(taxIn) || taxIn < 0) {
        return { success: false, message: 'الضريبة يجب أن تكون رقماً غير سالب' };
      }
      if (!Number.isFinite(paidIn) || paidIn < 0) {
        return { success: false, message: 'المبلغ المدفوع يجب أن يكون رقماً غير سالب' };
      }

      // A discount larger than the goods turns the invoice negative, which the
      // balance logic then books as money the SHOP owes the customer.
      const rawSubtotal = data.items.reduce((sum, i) => sum + (num(i.Quantity) * num(i.UnitPrice)), 0);
      if (discountIn > rawSubtotal) {
        return {
          success: false,
          message: `الخصم (${discountIn.toFixed(2)}) أكبر من إجمالي الأصناف (${rawSubtotal.toFixed(2)})`,
        };
      }

      // === PAYMENT TARGET MUST EXIST AND BE ACTIVE ===
      // `UPDATE ... WHERE ID = ?` against a missing id affects zero rows and
      // raises nothing, so the money simply evaporated while the invoice was
      // still saved as paid. Crediting an INACTIVE account is just as bad: every
      // report filters on IsActive = 1, so the cash becomes invisible.
      if (paidIn > 0) {
        if (!paymentMethodId && !cashAccountId) {
          return { success: false, message: 'اختر مصدر استلام المبلغ (خزنة أو ماكينة)' };
        }
        if (paymentMethodId) {
          const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?')
            .get(paymentMethodId) as any;
          if (!pm) return { success: false, message: 'ماكينة الدفع المختارة غير موجودة' };
          if (!pm.IsActive) return { success: false, message: 'ماكينة الدفع المختارة غير مفعّلة' };
        } else if (cashAccountId) {
          const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?')
            .get(cashAccountId) as any;
          if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
          if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
        }
      }


      // A walk-in has no account, so there is nowhere to record a debt or a
      // credit. Leaving an unpaid balance on such an invoice puts the amount in
      // `sales.RemainingAmount` while NO customer balance carries it: the money
      // is owed by nobody, invisible in receivables, and unrecoverable.
      //
      // `sales:update` and the screen already enforced this; `sales:create` did
      // not, so calling the channel directly bypassed the rule entirely.
      {
        const provisionalRemaining = money((rawSubtotal - discountIn + taxIn) - paidIn);
        if (!data.CustomerID && Math.abs(provisionalRemaining) > 0.005) {
          return {
            success: false,
            message: provisionalRemaining > 0
              ? `العميل النقدي يجب أن يدفع المبلغ كاملاً - المتبقي ${provisionalRemaining.toFixed(2)}. سجّل العميل أو حصّل المبلغ كاملاً.`
              : 'لا يمكن استلام مبلغ أكبر من الفاتورة لعميل نقدي - لا يوجد حساب لحفظ الزيادة',
          };
        }
      }
      const transferCost = Number.isFinite(num(data.TransferCost)) ? Math.max(0, num(data.TransferCost)) : 0;
      // Who absorbs the machine's commission. Anything other than an explicit
      // 'customer' means the shop pays it, which is the safer default: it books
      // the fee as a cost rather than silently assuming the customer covered it.
      const feeBearer = data.TransferCostBearer === 'customer' ? 'customer' : 'shop';
      // Only a fee the SHOP bears reduces what lands in our account and counts
      // as an expense. A fee passed on to the customer is collected from them
      // and handed straight to the provider — the shop is neither richer nor
      // poorer, so it must not be expensed.
      const shopBorneFee = feeBearer === 'shop' ? transferCost : 0;
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
          }
        }

        // Availability is checked against the warehouse each line will actually
        // be taken FROM, and with earlier lines of this same invoice already
        // counted.
        //
        // The old check summed the item across every warehouse and looked at
        // each line in isolation, while the deduction below hits one warehouse.
        // Both gaps produced negative stock with negative stock switched off:
        // 3 in the main store + 2 in the branch satisfied a request for 5 and
        // left the main store at -2, and an invoice carrying the same item on
        // two lines of 3 against a holding of 5 was accepted and ended at -1.
        const { shortages } = planStockAllocation(db, data.items);
        if (shortages.length) {
          return { success: false, message: describeShortage(db, shortages[0]) };
        }
      }

      const subtotal = money(data.items.reduce((sum, item) => sum + (item.Quantity * item.UnitPrice), 0));
      const totalAmount = money(subtotal - data.Discount + data.TaxAmount);
      const paidAmount = money(data.PaidAmount || 0);
      // Rounded, and a residue under one piastre is treated as settled.
      //
      // Money is kept to two decimals, so a balance of 0.00999999... is not a
      // debt — nobody can pay it and no report can show it. Left raw it stuck
      // the invoice on "partial" for ever: the customer appeared to owe a
      // hundredth of a piastre that could never be cleared. It arises whenever
      // a total divides unevenly, which a discount spread across lines does
      // routinely.
      const rawRemaining = money(totalAmount - paidAmount);
      const remaining = Math.abs(rawRemaining) < 0.01 ? 0 : rawRemaining;

      const dateStr = businessToday();
      const saleNumber = nextDocNumber(db, 'sales', 'SaleNumber', 'SAL', dateStr);

      const status = remaining > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'completed';

      /**
       * Authoritative unit cost for one sold line.
       *
       * The renderer sends `item.CostPrice`, which is the item's WEIGHTED
       * AVERAGE across every warehouse. For serialised goods that is simply the
       * wrong number: two identical phones bought at 600 and 900 both report a
       * cost of 750, so selling the cheap one understates profit by 150 and
       * selling the dear one overstates it by 150 — while the asset side
       * relieves the actual serial. Stock value and profit then disagree, and no
       * report can be right.
       *
       * Cost is therefore resolved HERE, in the main process, from the most
       * specific source available:
       *   1. the serial's own recorded cost (exact, for serialised units);
       *   2. the cost of the warehouse the goods actually left;
       *   3. the item's average cost;
       *   4. whatever the caller supplied, last.
       *
       * Deciding it server-side also means a tampered renderer cannot dictate
       * cost of sales.
       */
      const resolveUnitCost = (
        item: { ItemID?: number; SerialID?: number; UnitCost?: number; isService?: boolean },
        warehouseId: number | null,
      ): number | null => {
        if (item.isService) return item.UnitCost ?? null;

        if (item.SerialID) {
          const s = db.prepare('SELECT CostPrice FROM item_serials WHERE SerialID = ?')
            .get(item.SerialID) as any;
          if (s && s.CostPrice != null) return s.CostPrice;
        }

        if (item.ItemID && warehouseId) {
          const sq = db.prepare(
            'SELECT CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
          ).get(item.ItemID, warehouseId) as any;
          // A zero here is meaningful only if the row genuinely holds zero-cost
          // stock; treat it as usable but prefer a real average when it is 0.
          if (sq && sq.CostPrice) return sq.CostPrice;
        }

        if (item.ItemID) {
          const it = db.prepare('SELECT CostPrice FROM items WHERE ItemID = ?')
            .get(item.ItemID) as any;
          if (it && it.CostPrice != null) return it.CostPrice;
        }

        return item.UnitCost ?? null;
      };

      const tx = db.transaction(() => {
        // === RE-CHECK STOCK, NOW THAT THE WRITE LOCK IS HELD ===
        //
        // The validation above ran BEFORE this transaction opened, so nothing
        // stopped another till from selling the same units in between. That is
        // a check-then-act race, and it is not theoretical here: the app
        // deliberately supports a shared database on a network path
        // (`db:createNetwork`), where every till is a separate process against
        // one file. Verified by holding a write inside the window: a sale of 5
        // committed against an empty shelf and left the warehouse at -5, with
        // negative stock switched off.
        //
        // SQLite serialises writers, so a re-read inside the transaction sees
        // the committed truth and cannot be overtaken. Throwing rolls the whole
        // transaction back, leaving nothing half-written.
        if (!allowNegativeStock) {
          const late = planStockAllocation(db, data.items);
          if (late.shortages.length) {
            const refusal = new Error(describeShortage(db, late.shortages[0]));
            (refusal as any).userRefusal = true;
            throw refusal;
          }
          for (const item of data.items) {
            if (item.isService || !item.SerialID) continue;
            const sv = db.prepare(
              'SELECT Status FROM item_serials WHERE SerialID = ?',
            ).get(item.SerialID) as any;
            if (!sv || sv.Status !== 'available') {
              const refusal = new Error('الجهاز برقم IMEI غير متاح للبيع');
              (refusal as any).userRefusal = true;
              throw refusal;
            }
          }
        }

        // Create sale
        const result = db.prepare(`
          INSERT INTO sales (SaleNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
            Subtotal, Discount, TaxRate, TaxAmount, TotalAmount, PaidAmount, RemainingAmount,
            PaymentMethod, CashAccountID, PaymentMethodID, Status, UserID, Notes,
            TransferCost, TransferCostBearer)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          saleNumber, data.fiscalYearId, dateStr,
          data.CustomerID ?? null, data.CustomerName ?? null, data.CustomerPhone ?? null,
          subtotal, data.Discount, data.TaxRate, data.TaxAmount, totalAmount,
          paidAmount, remaining, data.PaymentMethod,
          cashAccountId, paymentMethodId,
          // Stored as a NUMBER in its own column so the P&L can charge it as a
          // cost. `Notes` keeps only what the user actually typed.
          status, data.userId, data.Notes ?? null, transferCost, feeBearer
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
            item.Quantity, item.UnitPrice, resolveUnitCost(item, lineWarehouse),
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

          // Deduct from the warehouse — for SERIALISED goods too.
          //
          // A purchase adds to `stock_quantities` whether or not the line
          // carries an IMEI, so a sale has to take it back out the same way.
          // Only marking the serial 'sold' left the quantity and its value
          // sitting in the warehouse for ever: after selling one of two
          // handsets the books still showed two, and inventory was overstated
          // by the cost of every serialised unit the shop had ever sold. For a
          // phone shop that is most of the stock value.
          //
          // The serial's OWN cost is removed, not the pool average, so the
          // value taken out matches the cost of sales recorded on the line —
          // `resolveUnitCost` already prefers `item_serials.CostPrice`.
          if (item.ItemID && lineWarehouse) {
            const soldCost = resolveUnitCost(item, lineWarehouse);
            if (item.SerialID) {
              const { residual } = deductStockAtCost(
                db, item.ItemID, lineWarehouse, item.Quantity, soldCost ?? 0);
              recordValuationResidual(db, {
                date: dateStr,
                itemId: item.ItemID,
                warehouseId: lineWarehouse,
                amount: residual,
                reason: 'بيع جهاز بسيريال أفرغ المخزن',
                refType: 'sale',
                refId: Number(saleId),
              });
            } else {
              deductStock(db, item.ItemID, lineWarehouse, item.Quantity);
            }
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
          // The commission never reaches the shop: a card machine or wallet
          // settles the sale MINUS its fee. Crediting the gross amount
          // overstated the asset by the fee on every single card sale, and the
          // fee itself was never expensed, so profit was overstated twice over.
          //
          // The customer still owes the full TotalAmount — only what lands in
          // our account is reduced. The fee is carried on the sale row as
          // TransferCost and charged as a cost in the profit & loss report.
          const netReceived = +(paidAmount - shopBorneFee).toFixed(2);
          if (paymentMethodId) {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(netReceived, paymentMethodId);
          } else if (cashAccountId) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(netReceived, cashAccountId);
          }
        }
      });

      tx();
      return { success: true, saleNumber, totalAmount, paidAmount, remaining, status };
    } catch (err: any) {
      // A refusal is a normal outcome, not a fault: the transaction rolled back
      // and nothing was written.
      if (err?.userRefusal) return { success: false, message: err.message };
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
    Reason?: string; userId: number;
    // How the value is settled. Omitted entirely = use the suggested split, so
    // an older caller keeps working.
    AccountCredit?: number; CashRefund?: number; TransferRefund?: number;
    CashAccountID?: number; PaymentMethodID?: number;
    TransferCost?: number; TransferCostBearer?: 'shop' | 'party';
  }) => {
    const db = getDb();
    const dateStr = businessToday();

    // === EVERY FIGURE COMES FROM THE ORIGINAL INVOICE, NOT THE CALLER ===
    //
    // The caller supplies only WHICH line and HOW MANY. The price is read from
    // `sale_details`, and the quantity is capped at what that line still has
    // outstanding. Trusting the payload allowed two attacks that the total-value
    // guard alone did not stop, because it only compared sums:
    //
    //   invoice = 1 phone @1000 + 1 cable @20  (total 1020)
    //   "return 51 cables @20"  -> 1020, total check passes
    //     -> 51 cables appear in stock from nothing, 1020 refunded for 20 of goods
    //
    //   "return 1 cable @1000"  -> 1000, total check passes
    //     -> 1000 refunded for an item sold at 20
    //
    // The screen already caps both, but the renderer is not a trust boundary.
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: 'حدد الأصناف المرتجعة' };
    }

    // Aggregated PER ITEM, not per row.
    //
    // One invoice may legitimately carry the same item on two lines (two
    // different prices, or simply added twice at the till). The returned
    // quantity is recorded against the item, so comparing that running total
    // against a single row's quantity is wrong in both directions: with two
    // lines of 1 the cap stayed at 1 and blocked a legitimate second return,
    // and with the rows ordered the other way it allowed more back than went
    // out. Summing the sold side the same way the returned side is summed
    // makes the two comparable.
    // A line's EFFECTIVE price: what the customer really paid for one unit,
    // after that line's share of any invoice-level discount and tax.
    //
    // `sale_details.UnitPrice` is the price before those. Refunding at it
    // handed back more than was ever received: an invoice of 10 cables at 100
    // with a 200 discount is paid at 800, but returning 8 units at the line
    // price refunded the whole 800 while the customer kept 2 cables. The
    // total-value guard did not catch it, because 800 does not exceed 800 —
    // only a FULL return would have tripped it.
    //
    // The ratio is TotalAmount / Subtotal, which spreads the discount and the
    // tax across the lines in proportion to their value, exactly as the invoice
    // total was formed. Guarded against a zero subtotal (a fully discounted
    // giveaway), where the ratio is meaningless and nothing is refundable.
    const inv = db.prepare(
      'SELECT Subtotal, TotalAmount FROM sales WHERE SaleID = ?',
    ).get(data.SaleID) as any;
    const grossSubtotal = Number(inv?.Subtotal) || 0;
    const netTotal = Number(inv?.TotalAmount) || 0;
    const priceRatio = grossSubtotal > 0 ? netTotal / grossSubtotal : 1;

    const soldLines = db.prepare(`
      SELECT sd.ItemID,
             MIN(sd.SerialID) AS SerialID,
             SUM(sd.Quantity) AS Quantity,
             -- Weighted averages rather than MAX: the same item may appear on
             -- several lines at different prices, and MAX would refund every
             -- unit at the dearest one and credit cost at the highest cost.
             SUM(sd.UnitPrice * sd.Quantity) / NULLIF(SUM(sd.Quantity),0) AS UnitPrice,
             SUM(COALESCE(sd.UnitCost,0) * sd.Quantity) / NULLIF(SUM(sd.Quantity),0) AS UnitCost,
             MAX(sd.WarehouseID) AS WarehouseID,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM sale_return_details rd
               JOIN sale_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.SaleID = sd.SaleID AND rd.ItemID IS sd.ItemID
             ), 0) AS AlreadyReturned
      FROM sale_details sd WHERE sd.SaleID = ?
      GROUP BY sd.ItemID, sd.SerialID
    `).all(data.SaleID) as any[];

    const verified: Array<{
      ItemID: number | null; SerialID: number | null; Quantity: number;
      UnitPrice: number; UnitCost: number; WarehouseID: number | null;
    }> = [];

    // Quantities already claimed by EARLIER entries in this same payload.
    // Without this the same line sent twice passes the cap twice: each entry
    // is checked against the committed `AlreadyReturned`, which is still 0
    // for both, so a line of 1 could be returned as 2.
    const claimedInThisPayload = new Map<string, number>();

    for (const req of data.items) {
      const qty = Number(req.Quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, message: 'الكمية المرتجعة يجب أن تكون رقماً أكبر من صفر' };
      }
      // `ItemID IS ?` rather than `=` so service lines (ItemID NULL) match too.
      const line = soldLines.find(l =>
        (l.ItemID ?? null) === (req.ItemID ?? null)
        && (req.SerialID ? l.SerialID === req.SerialID : true));
      if (!line) {
        return { success: false, message: 'أحد الأصناف المرتجعة غير موجود في الفاتورة الأصلية' };
      }
      const lineKey = `${line.ItemID ?? 'svc'}:${line.SerialID ?? ''}`;
      const alreadyClaimed = claimedInThisPayload.get(lineKey) || 0;
      const remainingOnLine = money(
        (line.Quantity || 0) - (line.AlreadyReturned || 0) - alreadyClaimed);
      if (qty > remainingOnLine + 0.001) {
        const info = req.ItemID
          ? (db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(req.ItemID) as any)
          : null;
        return {
          success: false,
          message: `الكمية المرتجعة من "${info?.ItemName || 'بند'}" أكبر من المتاح: المطلوب ${qty}، المتاح ${Math.max(0, remainingOnLine)}`,
        };
      }
      claimedInThisPayload.set(lineKey, alreadyClaimed + qty);
      verified.push({
        ItemID: line.ItemID ?? null,
        SerialID: req.SerialID ?? line.SerialID ?? null,
        Quantity: qty,
        // Authoritative price and cost, straight from the invoice.
        // Refunded at the EFFECTIVE price, so the customer gets back what they
        // actually paid for these units and no more.
        UnitPrice: money((line.UnitPrice || 0) * priceRatio),
        UnitCost: line.UnitCost ?? 0,
        WarehouseID: line.WarehouseID ?? null,
      });
    }

    const totalAmount = money(verified.reduce((sum, l) => sum + (l.Quantity * l.UnitPrice), 0));
    const returnNumber = nextDocNumber(db, 'sale_returns', 'ReturnNumber', 'SR', dateStr);

    const originalSale = db.prepare(
      `SELECT CustomerID, TotalAmount, PaidAmount, RemainingAmount, IsVoided, IsWarranty,
              COALESCE(Source,'direct') AS Source
         FROM sales WHERE SaleID = ?`
    ).get(data.SaleID) as any;
    if (!originalSale) return { success: false, message: 'الفاتورة الأصلية غير موجودة' };

    // A voided invoice has already been reversed in full — stock returned and
    // balances undone. Returning against it would credit the customer a second
    // time for goods the shop never gave up.
    if (originalSale.IsVoided) {
      return { success: false, message: 'الفاتورة ملغاة - تم عكسها بالفعل ولا يمكن عمل مرتجع لها' };
    }

    // A maintenance delivery writes a mirror invoice into `sales` so the
    // customer gets something printable. Its revenue is reported from the
    // maintenance side, and the profit report deliberately excludes it here —
    // so a return booked against it would reduce DIRECT sales for money that
    // was never counted as direct sales. Repairs are reversed from their own
    // screen, which also puts the spare parts back.
    if (originalSale.Source === 'maintenance') {
      return { success: false, message: 'فاتورة صيانة - نفّذ الإرجاع من شاشة الصيانة' };
    }

    // A warranty invoice carries no value, so there is nothing to refund.
    if (originalSale.IsWarranty) {
      return { success: false, message: 'فاتورة ضمان بدون قيمة - لا يوجد مبلغ للإرجاع' };
    }

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

    // Money already handed back on earlier returns for this invoice.
    const priorCashOut = (db.prepare(
      `SELECT COALESCE(SUM(COALESCE(CashRefund,0) + COALESCE(TransferRefund,0)),0) AS total
         FROM sale_returns WHERE SaleID = ?`
    ).get(data.SaleID) as any)?.total || 0;
    const refundableCash = money(Math.max(0, (originalSale.PaidAmount || 0) - priorCashOut));

    // === HOW THE VALUE IS SETTLED ===
    // Chosen by the user, not computed. See src/shared/returnSettlement.ts for
    // why a fixed formula could not express the real situations a shop meets.
    // A walk-in customer has no account, so nothing may be left on one.
    const hasAccount = !!originalSale.CustomerID;
    const explicit = data.AccountCredit != null || data.CashRefund != null || data.TransferRefund != null;
    const proposed = explicit
      ? {
          accountCredit: data.AccountCredit ?? 0,
          cashRefund: data.CashRefund ?? 0,
          transferRefund: data.TransferRefund ?? 0,
        }
      : suggestSettlement(totalAmount, Math.max(0, outstanding - priorReturns), hasAccount);

    const settlement = validateSettlement({
      total: totalAmount,
      ...proposed,
      hasAccount,
      cashAccountId: data.CashAccountID ?? null,
      paymentMethodId: data.PaymentMethodID ?? null,
      transferCost: data.TransferCost ?? 0,
      transferCostBearer: data.TransferCostBearer,
      // Cash can only be handed back out of what the customer actually paid,
      // less anything already refunded on earlier returns for this invoice.
      paidSoFar: refundableCash,
    });
    if (!settlement.ok) return { success: false, message: settlement.message };

    // `DebtRelief` keeps its old name in the database: it is the portion that
    // touches the customer account, which is exactly what the statement reads.
    const debtRelief = settlement.accountCredit;
    const cashRefund = settlement.cashRefund;

    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    const allowNegative = allowNegCash?.Value === '1';

    // Every account that money actually leaves must exist, be active, and —
    // unless negative balances are permitted — hold enough to cover its share.
    if (cashRefund > 0) {
      const acc = db.prepare('SELECT Balance, IsActive FROM cash_accounts WHERE CashAccountID = ?')
        .get(data.CashAccountID) as any;
      if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
      if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
      if (!allowNegative && (acc.Balance || 0) < cashRefund) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لرد المبلغ: المتاح ${(acc.Balance || 0).toFixed(2)}، المطلوب ${cashRefund.toFixed(2)}` };
      }
    }
    if (settlement.transferRefund > 0) {
      const pm = db.prepare('SELECT Balance, IsActive FROM payment_methods WHERE PaymentMethodID = ?')
        .get(data.PaymentMethodID) as any;
      if (!pm) return { success: false, message: 'المحفظة/الماكينة المختارة غير موجودة' };
      if (!pm.IsActive) return { success: false, message: 'المحفظة/الماكينة المختارة غير مفعّلة' };
      // The outflow includes the fee when the shop absorbs it.
      if (!allowNegative && (pm.Balance || 0) < settlement.transferOutflow) {
        return { success: false, message: `الرصيد غير كافٍ في المحفظة/الماكينة: المتاح ${(pm.Balance || 0).toFixed(2)}، المطلوب ${settlement.transferOutflow.toFixed(2)}` };
      }
    }

    try {
      const tx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO sale_returns (ReturnNumber, SaleID, Date, TotalAmount, Reason, UserID, CashAccountID,
            DebtRelief, CashRefund, TransferRefund, PaymentMethodID, TransferCost, TransferCostBearer)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(returnNumber, data.SaleID, dateStr, totalAmount, data.Reason ?? null, data.userId,
               data.CashAccountID ?? null, debtRelief, cashRefund,
               settlement.transferRefund, data.PaymentMethodID ?? null,
               settlement.transferCost, settlement.transferCostBearer);

        const returnId = result.lastInsertRowid;

        // `verified` carries the invoice's own prices, costs and warehouse —
        // the caller's numbers were only ever used to choose the line.
        for (const item of verified) {
          const returnWarehouse = item.WarehouseID
            ?? (item.ItemID ? resolveSourceWarehouse(db, item.ItemID, 0, null) : null);
          const returnedUnitCost = item.UnitCost;

          db.prepare(`
            INSERT INTO sale_return_details (ReturnID, ItemID, SerialID, Quantity, UnitPrice, Total, WarehouseID, UnitCost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitPrice,
                 money(item.Quantity * item.UnitPrice), returnWarehouse, returnedUnitCost);

          // Restore serial status
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(item.SerialID);
          }

          // Restore stock quantity into the correct warehouse.
          //
          // The COGS reversal in the P&L credits `sale_details.UnitCost` — the
          // cost the goods left at. The asset must come back at the SAME figure
          // or the two sides disagree. Adding only the quantity left the row's
          // existing CostPrice untouched, so goods sold at 30 and returned after
          // a restock at 50 came back valued at 50: inventory was overstated by
          // the difference while COGS was credited the smaller amount.
          // `ItemID` is null for a service line (labour, a custom charge).
          // Those carry no stock, so only their value is refunded.
          //
          // Serialised goods are restored HERE TOO. The sale now deducts the
          // quantity for them, so the return has to add it back or the handset
          // would come back on the shelf as a serial while the warehouse count
          // stayed one short for ever.
          if (item.ItemID && returnWarehouse) {
            restoreStockAtCost(db, item.ItemID, returnWarehouse, item.Quantity, returnedUnitCost);
          }
        }

        // --- Settle the value, exactly as the user chose.

        // Cash leg: money physically leaves the drawer.
        if (data.CashAccountID && cashRefund > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(cashRefund, data.CashAccountID);
        }

        // Transfer leg: money leaves the wallet/machine. When the shop absorbs
        // the provider's fee, MORE leaves than the customer receives — that
        // extra is the fee, and it is a real cost to the shop.
        if (data.PaymentMethodID && settlement.transferOutflow > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?')
            .run(settlement.transferOutflow, data.PaymentMethodID);
        }

        // Account leg: reduces what the customer owes. If they owed nothing,
        // the balance goes NEGATIVE — money the shop now owes them, which is
        // exactly right for a credit left on account.
        if (originalSale.CustomerID && debtRelief > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(debtRelief, originalSale.CustomerID);
        }

        // Keep the invoice consistent with what is still owed after the return.
        //
        // Only the part of the account credit that offsets THIS invoice's
        // outstanding amount reduces it. Credit beyond that is a balance the
        // customer carries forward, not a change to this invoice — writing it
        // here would drive RemainingAmount below zero and misreport the status.
        // When the LAST outstanding units come back, clear the remainder.
        //
        // Rounded per-unit shares of a total do not add back to the total: an
        // invoice of 55.00 over 3 units is 18.3333 each, stored as 18.33, so
        // returning all three credits 54.99 and leaves the invoice owing 0.01
        // for ever — a debt too small to pay and impossible to clear, which
        // pinned the invoice on "partial" permanently.
        //
        // The tail is only absorbed when nothing is left to return, so a
        // genuine partial return is unaffected.
        const stillOut = (db.prepare(`
          SELECT COALESCE(SUM(sd.Quantity),0) - COALESCE((
                   SELECT SUM(rd.Quantity) FROM sale_return_details rd
                   JOIN sale_returns r ON rd.ReturnID = r.ReturnID
                   WHERE r.SaleID = ?
                 ),0) AS q
          FROM sale_details sd WHERE sd.SaleID = ?
        `).get(data.SaleID, data.SaleID) as any)?.q ?? 0;
        const clearsInvoice = stillOut <= 0.001;
        const invoiceOffset = clearsInvoice && debtRelief > 0
          ? money(outstanding)
          : money(Math.min(debtRelief, outstanding));
        if (invoiceOffset > 0) {
          db.prepare(`
            UPDATE sales
            SET RemainingAmount = CASE WHEN ROUND(MAX(0, RemainingAmount - ?), 2) < 0.01 THEN 0
                                           ELSE ROUND(MAX(0, RemainingAmount - ?), 2) END,
                Status = CASE WHEN ROUND(MAX(0, RemainingAmount - ?), 2) < 0.01 THEN 'completed' ELSE Status END
            WHERE SaleID = ?
          `).run(invoiceOffset, invoiceOffset, invoiceOffset, data.SaleID);
        }
        // Recorded so cancelling this return puts back exactly this figure.
        // The reversal used to recompute it from the invoice as it stands
        // *now*, which is a different number once anything else has touched the
        // invoice in between.
        db.prepare('UPDATE sale_returns SET InvoiceOffset = ? WHERE ReturnID = ?')
          .run(invoiceOffset, returnId);
      });

      tx();
      return { success: true, returnNumber };
    } catch (err: any) {
      console.error('[Sales] Error creating return:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });

  /**
   * Edits an existing invoice.
   *
   * WHY THIS IS A REVERSE-AND-REISSUE RATHER THAN AN UPDATE
   * -------------------------------------------------------
   * A sale touches four things: stock, the customer's balance, a cash or
   * machine account, and the invoice itself. Patching a row in place would mean
   * hand-writing the delta for each of them for every possible change (fewer
   * items, a different customer, a switch from cash to card...), and any
   * combination the author did not think of would silently corrupt a balance.
   *
   * Instead the original effects are undone exactly as `delete:sale` undoes
   * them, and the new version is applied exactly as `sales:create` applies
   * them — the two code paths that are already audited and tested. The invoice
   * NUMBER is preserved, so the customer's copy still matches, and the whole
   * thing runs in a single transaction.
   *
   * Editing is refused once the invoice has returns, vouchers or a repair
   * delivery attached: those documents were issued against the old figures, and
   * changing the invoice underneath them would leave them referring to amounts
   * that no longer exist.
   */
  ipcMain.handle('sales:update', async (_event, data: {
    SaleID: number;
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    items: { ItemID: number; SerialID?: number; IMEI?: string; Quantity: number; UnitPrice: number; UnitCost?: number; isService?: boolean; ServiceName?: string; WarehouseID?: number }[];
    Discount: number; TaxRate: number; TaxAmount: number;
    PaymentMethod: string; PaidAmount: number;
    TransferCost?: number; TransferCostBearer?: 'shop' | 'customer';
    CashAccountID?: number; PaymentMethodID?: number;
    Notes?: string; userId: number;
  }) => {
    const db = getDb();
    try {
      const original = db.prepare('SELECT * FROM sales WHERE SaleID = ?').get(data.SaleID) as any;
      if (!original) return { success: false, message: 'الفاتورة غير موجودة' };
      if (original.IsVoided) return { success: false, message: 'الفاتورة ملغاة - لا يمكن تعديلها' };
      if ((original.Source ?? 'direct') === 'maintenance') {
        return { success: false, message: 'فاتورة صيانة - عدّلها من شاشة الصيانة' };
      }

      const linked = [
        { sql: 'SELECT COUNT(*) as n FROM sale_returns WHERE SaleID = ?', label: 'مرتجعات' },
        { sql: 'SELECT COUNT(*) as n FROM maintenance_deliveries WHERE SaleID = ?', label: 'تسليم صيانة' },
        { sql: "SELECT COUNT(*) as n FROM vouchers WHERE ReferenceType = 'sale' AND ReferenceID = ?", label: 'سندات' },
      ];
      for (const l of linked) {
        const n = (db.prepare(l.sql).get(data.SaleID) as any)?.n || 0;
        if (n > 0) {
          return { success: false, message: `لا يمكن تعديل الفاتورة - مرتبطة بـ${l.label}. احذفها أولاً.` };
        }
      }

      // ---- Validate the NEW version with the same rules as a new invoice.
      if (!Array.isArray(data.items) || data.items.length === 0) {
        return { success: false, message: 'لا يمكن حفظ فاتورة بدون أصناف' };
      }
      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
      for (const item of data.items) {
        const qty = num(item.Quantity);
        const price = num(item.UnitPrice);
        if (!Number.isFinite(qty) || qty <= 0) {
          return { success: false, message: 'الكمية يجب أن تكون رقماً أكبر من صفر' };
        }
        if (!Number.isFinite(price) || price < 0) {
          return { success: false, message: 'السعر يجب أن يكون رقماً غير سالب' };
        }
      }
      const discountIn = num(data.Discount ?? 0);
      const taxIn = num(data.TaxAmount ?? 0);
      const paidIn = num(data.PaidAmount ?? 0);
      if (!Number.isFinite(discountIn) || discountIn < 0
        || !Number.isFinite(taxIn) || taxIn < 0
        || !Number.isFinite(paidIn) || paidIn < 0) {
        return { success: false, message: 'قيم الخصم أو الضريبة أو المدفوع غير صالحة' };
      }
      const rawSubtotal = data.items.reduce((s, i) => s + (num(i.Quantity) * num(i.UnitPrice)), 0);
      if (discountIn > rawSubtotal) {
        return { success: false, message: `الخصم (${discountIn.toFixed(2)}) أكبر من إجمالي الأصناف (${rawSubtotal.toFixed(2)})` };
      }

      const newPaymentMethodId = data.PaymentMethodID ?? null;
      const newCashAccountId = newPaymentMethodId ? null : (data.CashAccountID ?? null);
      if (paidIn > 0) {
        if (!newPaymentMethodId && !newCashAccountId) {
          return { success: false, message: 'اختر مصدر استلام المبلغ (خزنة أو ماكينة)' };
        }
        if (newPaymentMethodId) {
          const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(newPaymentMethodId) as any;
          if (!pm) return { success: false, message: 'ماكينة الدفع المختارة غير موجودة' };
          if (!pm.IsActive) return { success: false, message: 'ماكينة الدفع المختارة غير مفعّلة' };
        } else if (newCashAccountId) {
          const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(newCashAccountId) as any;
          if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
          if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
        }
      }

      const transferCost = Number.isFinite(num(data.TransferCost)) ? Math.max(0, num(data.TransferCost)) : 0;
      const feeBearer = data.TransferCostBearer === 'customer' ? 'customer' : 'shop';
      const shopBorneFee = feeBearer === 'shop' ? transferCost : 0;

      const allowNegativeStockOnUpdate = (db.prepare(
        "SELECT Value FROM settings WHERE Key = 'allow_negative_stock'",
      ).get() as any)?.Value === '1';

      // Same rounding rule as `sales:create`: money is two decimals, and a
      // residue under one piastre is settled, not owed.
      const subtotal = money(rawSubtotal);
      const totalAmount = money(subtotal - discountIn + taxIn);
      const rawRemaining = money(totalAmount - paidIn);
      const remaining = Math.abs(rawRemaining) < 0.01 ? 0 : rawRemaining;
      const status = remaining > 0 ? (paidIn > 0 ? 'partial' : 'unpaid') : 'completed';

      if (!data.CustomerID && remaining !== 0) {
        return { success: false, message: 'العميل النقدي يجب أن يدفع المبلغ كاملاً' };
      }

      const resolveUnitCost = (
        item: { ItemID?: number; SerialID?: number; UnitCost?: number; isService?: boolean },
        warehouseId: number | null,
      ): number | null => {
        if (item.isService) return item.UnitCost ?? null;
        if (item.SerialID) {
          const s = db.prepare('SELECT CostPrice FROM item_serials WHERE SerialID = ?').get(item.SerialID) as any;
          if (s && s.CostPrice != null) return s.CostPrice;
        }
        if (item.ItemID && warehouseId) {
          const sq = db.prepare('SELECT CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?')
            .get(item.ItemID, warehouseId) as any;
          if (sq && sq.CostPrice) return sq.CostPrice;
        }
        if (item.ItemID) {
          const it = db.prepare('SELECT CostPrice FROM items WHERE ItemID = ?').get(item.ItemID) as any;
          if (it && it.CostPrice != null) return it.CostPrice;
        }
        return item.UnitCost ?? null;
      };

      const tx = db.transaction(() => {
        // ---- 1. Undo the original, exactly as delete:sale does.
        const oldLines = db.prepare('SELECT * FROM sale_details WHERE SaleID = ?').all(data.SaleID) as any[];
        for (const line of oldLines) {
          if (line.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(line.SerialID);
          }
          // Quantity comes back for serialised lines too, mirroring the sale.
          if (line.ItemID) {
            const wh = line.WarehouseID ?? resolveSourceWarehouse(db, line.ItemID, 0, null);
            // Un-sell at the cost the goods left at, so the value returned
            // equals the value removed. `restoreStock` keeps the pool's current
            // average when a row exists, which silently re-values the units.
            if (wh) restoreStockAtCost(db, line.ItemID, wh, line.Quantity, line.UnitCost || 0);
          }
        }
        if (original.CustomerID && original.RemainingAmount > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?')
            .run(original.RemainingAmount, original.CustomerID);
        } else if (original.CustomerID && original.RemainingAmount < 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?')
            .run(Math.abs(original.RemainingAmount), original.CustomerID);
        }
        const oldShopFee = (original.TransferCostBearer ?? 'shop') === 'shop' ? (original.TransferCost || 0) : 0;
        const oldNet = +((original.PaidAmount || 0) - oldShopFee).toFixed(2);
        if (original.CashAccountID && original.PaidAmount > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
            .run(oldNet, original.CashAccountID);
        }
        if (original.PaymentMethodID && original.PaidAmount > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?')
            .run(oldNet, original.PaymentMethodID);
        }
        db.prepare('DELETE FROM sale_details WHERE SaleID = ?').run(data.SaleID);

        // ---- 2. Apply the new version, exactly as sales:create does.
        db.prepare(`
          UPDATE sales SET
            CustomerID = ?, CustomerName = ?, CustomerPhone = ?,
            Subtotal = ?, Discount = ?, TaxRate = ?, TaxAmount = ?, TotalAmount = ?,
            PaidAmount = ?, RemainingAmount = ?, PaymentMethod = ?,
            CashAccountID = ?, PaymentMethodID = ?, Status = ?, Notes = ?,
            TransferCost = ?, TransferCostBearer = ?
          WHERE SaleID = ?
        `).run(
          data.CustomerID ?? null, data.CustomerName ?? null, data.CustomerPhone ?? null,
          subtotal, discountIn, data.TaxRate ?? 0, taxIn, totalAmount,
          paidIn, remaining, data.PaymentMethod,
          newCashAccountId, newPaymentMethodId, status, data.Notes ?? null,
          transferCost, feeBearer, data.SaleID,
        );

        // Availability for the NEW version, checked here rather than before the
        // transaction because the old lines have just been put back and form
        // part of what is now available.
        //
        // `sales:update` previously performed NO stock check whatsoever, so an
        // edit could raise the quantity far beyond anything held and drive the
        // warehouse negative in one step. Throwing rolls the whole transaction
        // back, leaving the original invoice exactly as it was.
        if (!allowNegativeStockOnUpdate) {
          const { shortages } = planStockAllocation(db, data.items);
          if (shortages.length) {
            // Tagged so the catch below can tell a deliberate refusal from a
            // genuine crash and report it plainly, without a stack trace in the
            // log for what is simply the user asking for too much stock.
            const refusal = new Error(describeShortage(db, shortages[0]));
            (refusal as any).userRefusal = true;
            throw refusal;
          }
        }

        for (const item of data.items) {
          const lineWarehouse = item.isService || !item.ItemID
            ? null
            : resolveSourceWarehouse(db, item.ItemID, item.Quantity, item.WarehouseID ?? null);

          db.prepare(`
            INSERT INTO sale_details (SaleID, ItemID, SerialID, IMEI, Quantity, UnitPrice, UnitCost, Total, IsWarranty, WarrantyMonths, WarehouseID)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
          `).run(
            data.SaleID,
            item.isService ? null : (item.ItemID || null),
            item.SerialID ?? null,
            item.isService ? (item.ServiceName || null) : (item.IMEI ?? null),
            item.Quantity, item.UnitPrice, resolveUnitCost(item, lineWarehouse),
            item.Quantity * item.UnitPrice,
            lineWarehouse,
          );

          if (item.isService) continue;
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'sold' WHERE SerialID = ?").run(item.SerialID);
          }
          if (item.ItemID && lineWarehouse) {
            if (item.SerialID) {
              // Serial's own cost, matching the figure written to the line.
              const soldCost = resolveUnitCost(item, lineWarehouse);
              const { residual } = deductStockAtCost(
                db, item.ItemID, lineWarehouse, item.Quantity, soldCost ?? 0);
              recordValuationResidual(db, {
                date: businessToday(),
                itemId: item.ItemID,
                warehouseId: lineWarehouse,
                amount: residual,
                reason: 'تعديل فاتورة بجهاز بسيريال أفرغ المخزن',
                refType: 'sale_update',
                refId: data.SaleID,
              });
            } else {
              deductStock(db, item.ItemID, lineWarehouse, item.Quantity);
            }
          }
        }

        if (data.CustomerID && remaining !== 0) {
          if (remaining > 0) {
            db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(remaining, data.CustomerID);
          } else {
            db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(remaining), data.CustomerID);
          }
        }

        if (paidIn > 0) {
          const netReceived = +(paidIn - shopBorneFee).toFixed(2);
          if (newPaymentMethodId) {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(netReceived, newPaymentMethodId);
          } else if (newCashAccountId) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(netReceived, newCashAccountId);
          }
        }
      });

      tx();
      return {
        success: true, saleNumber: original.SaleNumber,
        totalAmount, paidAmount: paidIn, remaining, status,
        message: `تم تعديل الفاتورة ${original.SaleNumber}`,
      };
    } catch (err: any) {
      // A refusal is a normal outcome, not a fault: the transaction rolled back
      // and the invoice is untouched. Only real faults are logged as errors.
      if (err?.userRefusal) {
        return { success: false, message: err.message };
      }
      console.error('[Sales] Error updating sale:', err);
      return { success: false, message: `خطأ في تعديل الفاتورة: ${err.message || err}` };
    }
  });

  /** One return with its lines — used to print the credit note. */
  ipcMain.handle('saleReturns:get', async (_event, returnId: number) => {
    const db = getDb();
    const header = db.prepare(`
      SELECT r.*, s.SaleNumber, s.CustomerID, s.CustomerName, s.CustomerPhone,
             c.Name AS CustomerAccountName
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      WHERE r.ReturnID = ?
    `).get(returnId);
    const details = db.prepare(`
      SELECT rd.*, i.ItemName
      FROM sale_return_details rd
      LEFT JOIN items i ON rd.ItemID = i.ItemID
      WHERE rd.ReturnID = ?
    `).all(returnId);
    return { header, details };
  });

  /** How much of an invoice may still be returned, per line. */
  ipcMain.handle('saleReturns:returnable', async (_event, saleId: number) => {
    const db = getDb();
    // Grouped exactly as `saleReturns:create` groups it — per item — so the
    // screen offers precisely what the server will accept.
    //
    // Listing each row separately showed two entries for an item sold on two
    // lines, each with its own cap, while the server checks the item's TOTAL.
    // The cashier could then fill both boxes and be refused, or return at the
    // dearer line's price. Quantities are summed and the price and cost are
    // weighted averages, matching the validator.
    const lines = db.prepare(`
      SELECT sd.ItemID,
             MIN(sd.SerialID) AS SerialID,
             MIN(sd.IMEI) AS IMEI,
             SUM(sd.Quantity) AS Quantity,
             SUM(sd.UnitPrice * sd.Quantity) / NULLIF(SUM(sd.Quantity),0) AS UnitPrice,
             MAX(sd.WarehouseID) AS WarehouseID,
             MAX(i.ItemName) AS ItemName,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM sale_return_details rd
               JOIN sale_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.SaleID = sd.SaleID AND rd.ItemID IS sd.ItemID
             ), 0) AS AlreadyReturned
      FROM sale_details sd
      LEFT JOIN items i ON sd.ItemID = i.ItemID
      WHERE sd.SaleID = ?
      GROUP BY sd.ItemID, sd.SerialID
    `).all(saleId) as any[];

    // The screen must offer the EFFECTIVE price — the same figure the validator
    // will use — or the cashier is shown a refund the server then refuses, or
    // worse, one that is larger than the customer ever paid. Mirrors the ratio
    // applied in `saleReturns:create`.
    const hdr = db.prepare('SELECT Subtotal, TotalAmount FROM sales WHERE SaleID = ?').get(saleId) as any;
    const gross = Number(hdr?.Subtotal) || 0;
    const ratio = gross > 0 ? (Number(hdr?.TotalAmount) || 0) / gross : 1;

    return lines.map(l => ({
      ...l,
      UnitPrice: money((l.UnitPrice || 0) * ratio),
      // Kept so the screen can show "was 100, after discount 80" if it wants.
      GrossUnitPrice: l.UnitPrice,
      // Service lines carry no ItemID and cannot be restocked, but their value
      // is still refundable, so they are returned as-is with a flag.
      IsService: l.ItemID == null,
      Returnable: Math.max(0, (l.Quantity || 0) - (l.AlreadyReturned || 0)),
    }));
  });

  /**
   * Reverses a sale return — the "undo" for a credit note issued by mistake.
   *
   * Every effect of `saleReturns:create` is undone in the opposite direction:
   * goods leave stock again, the cash refund is taken back, the cancelled debt
   * is restored to the customer, and the invoice's outstanding amount and
   * status are recalculated. Doing it in one transaction means a failure
   * halfway cannot leave the books half-reversed.
   */
  ipcMain.handle('delete:saleReturn', async (_event, returnId: number) => {
    const db = getDb();
    try {
      const ret = db.prepare('SELECT * FROM sale_returns WHERE ReturnID = ?').get(returnId) as any;
      if (!ret) return { success: false, message: 'المرتجع غير موجود' };

      const sale = db.prepare('SELECT * FROM sales WHERE SaleID = ?').get(ret.SaleID) as any;
      const details = db.prepare('SELECT * FROM sale_return_details WHERE ReturnID = ?')
        .all(returnId) as any[];

      // Refusing to take cash out of a drawer that cannot cover it keeps the
      // balance from going negative behind the user's back.
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      const cashRefund = ret.CashRefund || 0;
      // Undoing the return means taking the refunded money back IN, so no
      // balance check is needed for that direction. What must be checked is the
      // reverse: nothing here removes money.
      if (allowNegCash?.Value !== '1' && ret.CashAccountID && cashRefund > 0) {
        // Cash comes back into the drawer — always safe.
      }

      // The goods the customer brought back must still BE here to hand over
      // again. Cancelling the return takes them out of stock, and if they were
      // re-sold in the meantime that subtraction drives the warehouse negative,
      // inventing negative inventory and the negative value that goes with it.
      //
      // Same failure as deleting a purchase whose goods have gone: the reversal
      // is only valid while the movement it undoes is still undoable.
      const allowNegStock = db.prepare(
        "SELECT Value FROM settings WHERE Key = 'allow_negative_stock'",
      ).get() as any;
      if (allowNegStock?.Value !== '1') {
        const missing: string[] = [];
        for (const line of details) {
          // A named device must still be on the shelf.
          //
          // Once the customer brought it back it became available again, and
          // it may since have been sold to somebody else. Cancelling the return
          // hands it back to the FIRST customer, which cannot happen — the
          // phone is gone. Allowing it deducted a unit of stock while the
          // device was already recorded as sold, so the warehouse count fell
          // one below the device list and stayed there.
          if (line.SerialID) {
            const sv = db.prepare(
              'SELECT Status, IMEI FROM item_serials WHERE SerialID = ?',
            ).get(line.SerialID) as any;
            if (sv && sv.Status !== 'available') {
              missing.push(`IMEI ${sv.IMEI ?? line.SerialID} (الحالة: ${sv.Status})`);
              continue;
            }
          }
          if (!line.ItemID || !line.WarehouseID) continue;
          const held = (db.prepare(
            'SELECT COALESCE(SUM(Quantity),0) AS qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
          ).get(line.ItemID, line.WarehouseID) as any)?.qty || 0;
          if (held < line.Quantity - 0.001) {
            const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
            missing.push(`"${info?.ItemName || line.ItemID}" (المطلوب ${line.Quantity}، المتاح ${held})`);
          }
        }
        if (missing.length) {
          return {
            success: false,
            message: `لا يمكن إلغاء المرتجع - الأصناف المرتجعة لم تعد بالمخزن (بيعت أو نُقلت): ${missing.join('، ')}. `
              + `احذف عمليات البيع التالية أولاً.`,
          };
        }
      }

      const tx = db.transaction(() => {
        // === RE-CHECK AVAILABILITY, NOW THAT THE WRITE LOCK IS HELD ===
        // The goods could have been re-sold since the check above, which ran
        // before this transaction opened. Verified to drive stock to -2.
        if (allowNegStock?.Value !== '1') {
          for (const line of details) {
            if (!line.ItemID || !line.WarehouseID) continue;
            const held = (db.prepare(
              'SELECT COALESCE(SUM(Quantity),0) AS qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
            ).get(line.ItemID, line.WarehouseID) as any)?.qty || 0;
            if (held < line.Quantity - 0.001) {
              const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
              const refusal = new Error(
                `لا يمكن إلغاء المرتجع - "${info?.ItemName || line.ItemID}" لم يعد بالمخزن `
                + `(المطلوب ${line.Quantity}، المتاح ${held})`);
              (refusal as any).userRefusal = true;
              throw refusal;
            }
          }
        }

        for (const line of details) {
          // The goods go back OUT of stock — the customer keeps them again.
          //
          // When the return line names the device, that one goes back to the
          // customer. When it does not, the devices this SALE delivered are
          // used instead: the quantity leaves either way, so leaving them
          // 'available' left a handset on the shelf that nobody holds, and the
          // warehouse count fell one below the device list for ever.
          if (line.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'sold' WHERE SerialID = ?").run(line.SerialID);
          } else if (line.ItemID) {
            const isSerialised = (db.prepare(
              'SELECT IsSerialized FROM items WHERE ItemID = ?',
            ).get(line.ItemID) as any)?.IsSerialized;
            if (isSerialised) {
              const back = db.prepare(`
                SELECT s.SerialID FROM item_serials s
                JOIN sale_details sd ON sd.SerialID = s.SerialID AND sd.SaleID = ?
                WHERE s.ItemID = ? AND s.Status = 'available'
                ORDER BY s.SerialID
                LIMIT ?
              `).all(ret.SaleID, line.ItemID, Math.ceil(line.Quantity)) as any[];
              for (const b of back) {
                db.prepare("UPDATE item_serials SET Status = 'sold' WHERE SerialID = ?").run(b.SerialID);
              }
            }
          }
          // Quantity leaves for serialised lines as well, mirroring the sale.
          if (line.ItemID && line.WarehouseID) {
            // Remove exactly the value the return added, read from the return
            // line itself. Re-deriving it from `sale_details` with LIMIT 1
            // picked an arbitrary row when the invoice carried the same item
            // more than once, so the undo could remove a different amount of
            // value than the return put in. The fallback covers rows written
            // before UnitCost was recorded on the return.
            const origCost = line.UnitCost ?? (db.prepare(
              'SELECT UnitCost FROM sale_details WHERE SaleID = ? AND ItemID IS ? LIMIT 1',
            ).get(ret.SaleID, line.ItemID) as any)?.UnitCost ?? 0;
            // Taking the goods back out can empty the warehouse, leaving the
            // difference between the pool's average and this line's cost with
            // nothing to sit on. Booked as an adjustment instead of vanishing.
            const { residual } = deductStockAtCost(
              db, line.ItemID, line.WarehouseID, line.Quantity, origCost);
            recordValuationResidual(db, {
              date: businessToday(),
              itemId: line.ItemID,
              warehouseId: line.WarehouseID,
              amount: residual,
              reason: 'إلغاء مرتجع مبيعات أفرغ المخزن',
              refType: 'sale_return_delete',
              refId: returnId,
            });
          }
        }

        // Take back the cash that was handed over.
        if (ret.CashAccountID && cashRefund > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
            .run(cashRefund, ret.CashAccountID);
        }

        // Take back the transfer, including the fee if the shop absorbed it —
        // the same figure that left, so the wallet returns to its prior value.
        const transferOutflow = (ret.TransferCostBearer ?? 'shop') === 'shop'
          ? money((ret.TransferRefund || 0) + (ret.TransferCost || 0))
          : (ret.TransferRefund || 0);
        if (ret.PaymentMethodID && transferOutflow > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?')
            .run(transferOutflow, ret.PaymentMethodID);
        }

        // Restore the account credit the return had given.
        const debtRelief = ret.DebtRelief || 0;
        if (sale?.CustomerID && debtRelief > 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?')
            .run(debtRelief, sale.CustomerID);
          // Only the portion that actually reduced THIS invoice is added back,
          // mirroring the `invoiceOffset` applied when the return was created.
          //
          // Read from the return, not recomputed: the invoice's outstanding
          // amount is not what it was when the return was made, so re-deriving
          // it here restores a different figure than was taken away.
          // `InvoiceOffset` is null on returns written before it was recorded.
          const restoredOnInvoice = ret.InvoiceOffset != null
            ? ret.InvoiceOffset
            : money(Math.min(debtRelief, (sale.TotalAmount || 0) - (sale.PaidAmount || 0)));
          if (restoredOnInvoice > 0) {
            db.prepare(`
              UPDATE sales
              SET RemainingAmount = ROUND(RemainingAmount + ?, 2),
                  Status = CASE WHEN ROUND(RemainingAmount + ?, 2) > 0
                                THEN (CASE WHEN PaidAmount > 0 THEN 'partial' ELSE 'unpaid' END)
                                ELSE 'completed' END
              WHERE SaleID = ?
            `).run(restoredOnInvoice, restoredOnInvoice, ret.SaleID);
          }
        }

        db.prepare('DELETE FROM sale_return_details WHERE ReturnID = ?').run(returnId);
        db.prepare('DELETE FROM sale_returns WHERE ReturnID = ?').run(returnId);
      });

      tx();
      return { success: true, message: 'تم إلغاء المرتجع وعكس كل تأثيراته' };
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      console.error('[Sales] Error reversing return:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });
}
