import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { resolveSourceWarehouse, deductStock, deductStockAtCost, restoreStock, restoreStockAtCost, totalStock } from '../database/stock';
import { businessToday } from '../../shared/businessDate';
import { validateSettlement, suggestSettlement, money } from '../../shared/returnSettlement';

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
    const soldLines = db.prepare(`
      SELECT sd.ItemID,
             MIN(sd.SerialID) AS SerialID,
             SUM(sd.Quantity) AS Quantity,
             MAX(sd.UnitPrice) AS UnitPrice,
             MAX(sd.UnitCost) AS UnitCost,
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
        UnitPrice: line.UnitPrice || 0,
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
            INSERT INTO sale_return_details (ReturnID, ItemID, SerialID, Quantity, UnitPrice, Total, WarehouseID)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(returnId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitPrice,
                 money(item.Quantity * item.UnitPrice), returnWarehouse);

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
          if (!item.SerialID && item.ItemID && returnWarehouse) {
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
        const invoiceOffset = money(Math.min(debtRelief, outstanding));
        if (invoiceOffset > 0) {
          db.prepare(`
            UPDATE sales
            SET RemainingAmount = MAX(0, RemainingAmount - ?),
                Status = CASE WHEN MAX(0, RemainingAmount - ?) <= 0 THEN 'completed' ELSE Status END
            WHERE SaleID = ?
          `).run(invoiceOffset, invoiceOffset, data.SaleID);
        }
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

      const subtotal = rawSubtotal;
      const totalAmount = subtotal - discountIn + taxIn;
      const remaining = totalAmount - paidIn;
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
          } else if (line.ItemID) {
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
          if (!item.SerialID && item.ItemID && lineWarehouse) {
            deductStock(db, item.ItemID, lineWarehouse, item.Quantity);
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
    // Sold quantity per item, minus everything already returned for the same
    // invoice. Without this the UI could offer to return more than was bought,
    // and the goods would be restocked out of thin air.
    const lines = db.prepare(`
      SELECT sd.ItemID, sd.SerialID, sd.IMEI, sd.Quantity, sd.UnitPrice, sd.WarehouseID,
             i.ItemName,
             COALESCE((
               SELECT SUM(rd.Quantity) FROM sale_return_details rd
               JOIN sale_returns r ON rd.ReturnID = r.ReturnID
               WHERE r.SaleID = sd.SaleID AND rd.ItemID IS sd.ItemID
             ), 0) AS AlreadyReturned
      FROM sale_details sd
      LEFT JOIN items i ON sd.ItemID = i.ItemID
      WHERE sd.SaleID = ?
    `).all(saleId) as any[];

    return lines.map(l => ({
      ...l,
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

      const tx = db.transaction(() => {
        for (const line of details) {
          // The goods go back OUT of stock — the customer keeps them again.
          if (line.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'sold' WHERE SerialID = ?").run(line.SerialID);
          } else if (line.ItemID && line.WarehouseID) {
            // Remove exactly the value the return added. The goods came back at
            // the sale line's cost, so they must leave at that same cost —
            // subtracting at the pool's blended average would take out more (or
            // less) value than was ever put in.
            const origCost = (db.prepare(
              'SELECT UnitCost FROM sale_details WHERE SaleID = ? AND ItemID IS ? LIMIT 1',
            ).get(ret.SaleID, line.ItemID) as any)?.UnitCost ?? 0;
            deductStockAtCost(db, line.ItemID, line.WarehouseID, line.Quantity, origCost);
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
          const restoredOnInvoice = money(Math.min(debtRelief, (sale.TotalAmount || 0) - (sale.PaidAmount || 0)));
          if (restoredOnInvoice > 0) {
            db.prepare(`
              UPDATE sales
              SET RemainingAmount = RemainingAmount + ?,
                  Status = CASE WHEN RemainingAmount + ? > 0
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
      console.error('[Sales] Error reversing return:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });
}
