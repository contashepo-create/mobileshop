import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { getCallerUserId } from '../security/ipcGuard';
import { businessToday } from '../../shared/businessDate';

export function registerFiscalYearHandlers() {
  ipcMain.handle('fiscalYear:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM fiscal_years ORDER BY StartDate DESC').all();
  });

  ipcMain.handle('fiscalYear:getActive', async () => {
    const db = getDb();
    const active = db.prepare("SELECT * FROM fiscal_years WHERE Status = 'open' ORDER BY StartDate DESC LIMIT 1").get() as any;
    if (!active) return null;
    const openingBalances = db.prepare(
      'SELECT OpeningID, AccountType, AccountID, Name, Balance FROM fiscal_year_openings WHERE FiscalYearID = ? ORDER BY AccountType, AccountID'
    ).all(active.FiscalYearID);
    return { ...active, openingBalances };
  });

  // The fiscal year that CONTAINS a given date — the answer to "which year does
  // this backdated document belong to?" Used by the screens to show the user
  // where a chosen date lands before they save.
  ipcMain.handle('fiscalYear:forDate', async (_event, date: string) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, message: 'التاريخ غير صالح' };
    }
    const db = getDb();
    const year = db.prepare(
      'SELECT * FROM fiscal_years WHERE StartDate <= ? AND EndDate >= ? ORDER BY StartDate DESC LIMIT 1'
    ).get(date, date) as any;
    if (!year) return { success: false, message: `لا توجد سنة مالية تغطي تاريخ ${date}` };
    return { success: true, year };
  });

  ipcMain.handle('fiscalYear:create', async (_event, data: { YearName: string; StartDate: string; EndDate: string }) => {
    const db = getDb();

    if (!data?.YearName?.trim()) {
      return { success: false, message: 'اسم السنة المالية مطلوب' };
    }
    if (!data?.StartDate || !data?.EndDate) {
      return { success: false, message: 'تاريخ البداية والنهاية مطلوبان' };
    }
    if (data.EndDate <= data.StartDate) {
      return { success: false, message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.StartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(data.EndDate)) {
      return { success: false, message: 'تواريخ السنة المالية غير صالحة - الصيغة المطلوبة YYYY-MM-DD' };
    }

    // No TWO OPEN years may cover the same date, but a non-overlapping open
    // year may exist beside the current one.
    //
    // Previously the rule was "exactly one open year, ever" — which silently
    // blocked the common backdating case: a shop that installed in 2026 (its
    // year opens automatically on first run) could never open a 2025 year to
    // record the operations it brought over from its old register, even
    // though the posting guard has since become DATE-DRIVEN and would route a
    // 2025-dated document to the 2025 year regardless of which year id the
    // screen sent. Overlap is the only real hazard now: two open years
    // covering the same day makes the resolution ambiguous.
    //
    // `fiscalYear:getActive` still resolves "the current year" deterministically
    // (the LATEST open one, `ORDER BY StartDate DESC`), and new documents
    // dated today land there — the backdated year only ever receives documents
    // whose dates fall inside its period.
    const overlapping = db.prepare(
      "SELECT YearName FROM fiscal_years WHERE Status = 'open' AND StartDate <= ? AND EndDate >= ? LIMIT 1",
    ).get(data.EndDate, data.StartDate) as any;
    if (overlapping) {
      return {
        success: false,
        message: `لا يمكن فتح سنة مالية فترة نشاطها متداخلة مع سنة مفتوحة حالياً («${overlapping.YearName}»).`,
      };
    }

    const result = db.prepare('INSERT INTO fiscal_years (YearName, StartDate, EndDate, Status) VALUES (?, ?, ?, ?)').run(data.YearName, data.StartDate, data.EndDate, 'open');
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('fiscalYear:close', async (event, fiscalYearId: number, _userId?: number) => {
    // Identity comes from the session, never from the renderer argument.
    const userId = getCallerUserId(event, _userId);
    const db = getDb();
    const fy = db.prepare('SELECT * FROM fiscal_years WHERE FiscalYearID = ?').get(fiscalYearId) as any;
    if (!fy) return { success: false, message: 'السنة المالية غير موجودة' };
    if (fy.Status === 'closed') return { success: false, message: 'السنة المالية مغلقة بالفعل' };

    const dateStr = businessToday();

    // A year must have ACTUALLY ended before it can be closed.
    //
    // Before this guard existed, closing 2026 in July opened a 2027 that
    // started in January: every document posted between July and December was
    // dated INSIDE the closed year while being stamped with the new year's
    // id. Reports filter by DATE, so those documents kept appearing in the
    // closed year's figures after the close — the numbers the owner relied on
    // kept moving, which is exactly what closing is supposed to stop.
    if (dateStr < fy.EndDate) {
      return {
        success: false,
        message: `لا يمكن إقفال سنة «${fy.YearName}» قبل انتهائها فعلياً (${fy.EndDate}). الإقفال متاح اعتباراً من هذا التاريخ فقط.`,
      };
    }

    db.transaction(() => {
      // Close current year
      db.prepare('UPDATE fiscal_years SET Status = ?, ClosedAt = ?, ClosedByUserID = ? WHERE FiscalYearID = ?')
        .run('closed', dateStr, userId, fiscalYearId);

      // Create the new year, starting the day after this one ended.
      //
      // TWO DEFECTS MEASURED HERE, both from the same line.
      //
      // 1. THE NAME WAS A YEAR OUT. Closing 2026 (ending 2026-12-31) produced
      //    a year running 2027-01-01 to 2028-01-01 called
      //    «السنة المالية 2028». Every document posted in 2027 would carry a
      //    year labelled 2028, and the owner reading a report would be looking
      //    at the wrong caption on the right figures — or file under the wrong
      //    year entirely. The name must come from the START of the period.
      //
      // 2. THE PERIOD WAS 366 DAYS. `setFullYear(+1)` on 2027-01-01 gives
      //    2028-01-01, so the new year INCLUDES the first day of the year
      //    after it. That day then belongs to two fiscal years at once, and
      //    the ranges no longer partition time — a report bounded by
      //    `BETWEEN StartDate AND EndDate` counts it twice.
      //
      // Both fixed by ending one day before the anniversary, which is what a
      // twelve-month period actually is.
      const startDate = new Date(fy.EndDate);
      startDate.setDate(startDate.getDate() + 1);
      const endDate = new Date(startDate);
      endDate.setFullYear(endDate.getFullYear() + 1);
      endDate.setDate(endDate.getDate() - 1);

      const newYearName = `السنة المالية ${startDate.getFullYear()}`;
      const inserted = db.prepare('INSERT INTO fiscal_years (YearName, StartDate, EndDate, Status) VALUES (?, ?, ?, ?)').run(
        newYearName, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], 'open'
      );
      const newFyId = Number(inserted.lastInsertRowid);

      // Carry the current balances into the new year as its OPENING BALANCES
      // — the CLOSING DOCUMENT.
      //
      // The balances are stored, cumulative columns, so they already continue
      // across the boundary — this is the written snapshot of what the new
      // year started with, account by account, taken inside the same
      // transaction that closed the old year. The statements recompute the
      // true opening from movements (a late entry in a reopened year must
      // still reach the year that follows); these rows are the record the
      // owner asked for, nothing the reports ever read.
      //
      // Every family mirrors the SAME query the balance sheet uses
      // (`reports:financialPosition`), so the document equals the report, and
      // the closing figure for retained earnings is derived — assets minus
      // liabilities minus capital — which makes the written document balance
      // by construction, exactly as the report asserts with `isBalanced`.
      const totalAssetsWritten = () => db.prepare(`
        SELECT COALESCE(SUM(Balance),0) as total FROM fiscal_year_openings
        WHERE FiscalYearID = ? AND AccountType IN
          ('cash_account','payment_method','customer','inventory','advance','supplier_credit','rent_advance_held')
      `).get(newFyId) as any;
      const totalLiabilitiesWritten = () => db.prepare(`
        SELECT COALESCE(SUM(Balance),0) as total FROM fiscal_year_openings
        WHERE FiscalYearID = ? AND AccountType IN
          ('supplier','employee','customer_credit','commission','rent_advance_collected')
      `).get(newFyId) as any;

      // 1. Liquid assets — every active vault/bank and wallet/terminal.
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'cash_account', CashAccountID, AccountName, Balance FROM cash_accounts WHERE IsActive = 1
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'payment_method', PaymentMethodID, MethodName, Balance FROM payment_methods WHERE IsActive = 1
      `).run(newFyId);

      // 2. Customers and suppliers, split by direction. Money owed to us is an
      //    asset, money we owe is a liability — the same split the balance
      //    sheet makes (`Balance > 0` asset on the customer side, `Balance < 0`
      //    credit owed back to the customer as a liability, and the supplier
      //    side mirrored).
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'customer', CustomerID, Name, Balance FROM customers WHERE Balance > 0
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'customer_credit', CustomerID, Name, ABS(Balance) FROM customers WHERE Balance < 0
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'supplier', SupplierID, Name, Balance FROM suppliers WHERE Balance > 0
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'supplier_credit', SupplierID, Name, ABS(Balance) FROM suppliers WHERE Balance < 0
      `).run(newFyId);

      // 3. Inventory valued at cost. Serialised items are valued at the sum of
      //    the devices' OWN costs, ordinary items at Quantity × CostPrice, and
      //    a serialised item received without an IMEI falls back to the
      //    warehouse valuation — the only complete figure. Mirrors `valueOf`
      //    in reports:financialPosition exactly.
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'inventory', i.ItemID, i.ItemName,
               CASE WHEN i.IsSerialized = 1
                      AND NOT EXISTS (SELECT 1 FROM purchase_details pd
                                      WHERE pd.ItemID = i.ItemID AND (pd.IMEI IS NULL OR pd.IMEI = ''))
                    THEN (SELECT COALESCE(SUM(CostPrice),0) FROM item_serials
                          WHERE ItemID = i.ItemID AND Status = 'available')
                    ELSE (SELECT COALESCE(SUM(CostPrice * Quantity),0) FROM stock_quantities
                          WHERE ItemID = i.ItemID)
               END
        FROM items i
        WHERE i.IsActive = 1
          AND ((SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) > 0
               OR (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') > 0)
      `).run(newFyId);

      // 4. Employee money. Cash advanced and not yet recovered is an ASSET;
      //    commissions earned but not yet paid are a LIABILITY; the net salary
      //    the shop owes its staff (positive `employees.Balance`) is a
      //    liability. Each is written per employee.
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'advance', a.EmployeeID, e.Name, SUM(a.Amount)
        FROM employee_advances a JOIN employees e ON a.EmployeeID = e.EmployeeID
        WHERE a.IsDeducted = 0 GROUP BY a.EmployeeID
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'commission', c.EmployeeID, e.Name, SUM(c.Amount)
        FROM commissions c JOIN employees e ON c.EmployeeID = e.EmployeeID
        WHERE c.IsPaid = 0 GROUP BY c.EmployeeID
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'employee', EmployeeID, Name, Balance
        FROM employees WHERE IsActive = 1 AND Balance > 0
      `).run(newFyId);

      // 5. Rent advances. Money advanced on an expense contract is still an
      //    asset until applied to an instalment; money collected on an income
      //    contract is still owed until applied — the mirror.
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'rent_advance_held', RentID, RentName, AdvanceBalance
        FROM rents WHERE RentType = 'expense' AND COALESCE(AdvanceBalance,0) > 0
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        SELECT ?, 'rent_advance_collected', RentID, RentName, AdvanceBalance
        FROM rents WHERE RentType = 'income' AND COALESCE(AdvanceBalance,0) > 0
      `).run(newFyId);

      // 6. Equity, frozen as a record. Capital is the owner's paid-in figure;
      //    retained earnings are whatever the books above it account for —
      //    assets minus liabilities minus capital. Derived like this, the
      //    written document satisfies the accounting identity by construction,
      //    the same identity `reports:financialPosition` asserts live. These
      //    rows are documentation only: the report keeps computing equity from
      //    movements, never from this snapshot.
      const capitalSetting = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
      const explicitCapital = capitalSetting ? (parseFloat(capitalSetting.Value) || 0) : 0;
      const retainedEarnings = totalAssetsWritten().total - totalLiabilitiesWritten().total - explicitCapital;
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        VALUES (?, 'equity_capital', 1, 'رأس المال', ?)
      `).run(newFyId, explicitCapital);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Name, Balance)
        VALUES (?, 'equity_retained', 1, 'الأرباح المحتجزة', ?)
      `).run(newFyId, retainedEarnings);
    })();

    return { success: true };
  });

  // The opening-balance snapshot a year started with (the closing document
  // written when it was created by closing the year before it — liquid assets,
  // customers and suppliers, inventory, employee advances and commissions,
  // rent advances, and the equity position).
  ipcMain.handle('fiscalYear:openings', async (_event, fiscalYearId: number) => {
    if (!Number.isInteger(fiscalYearId)) {
      return { success: false, message: 'معرف السنة المالية غير صالح' };
    }
    const db = getDb();
    const openings = db.prepare(
      'SELECT OpeningID, AccountType, AccountID, Name, Balance FROM fiscal_year_openings WHERE FiscalYearID = ? ORDER BY AccountType, AccountID'
    ).all(fiscalYearId);
    return { success: true, openings };
  });

  // Reopening a closed year so documents from its period can still be
  // recorded — the deliberate way to add old operations (an invoice found a
  // year later, a voucher that was never written).
  // This is an accounting act with consequences, not a cosmetic flip: it
  // changes figures the owner already relied on, and it invalidates the
  // opening-balance snapshots of every year that followed (they were taken
  // when THIS year was closed, and late entries move those balances). The
  // statements recompute the true openings from movements, so the numbers
  // stay right everywhere — but the snapshots on the fiscal-year screen are
  // deleted for the later years, and they are re-taken at the next close.
  ipcMain.handle('fiscalYear:reopen', async (event, fiscalYearId: number, _userId?: number) => {
    getCallerUserId(event, _userId);
    const db = getDb();
    const fy = db.prepare('SELECT * FROM fiscal_years WHERE FiscalYearID = ?').get(fiscalYearId) as any;
    if (!fy) return { success: false, message: 'السنة المالية غير موجودة' };
    if (fy.Status === 'open') return { success: false, message: 'السنة المالية مفتوحة بالفعل' };

    db.transaction(() => {
      db.prepare('UPDATE fiscal_years SET Status = ?, ClosedAt = NULL, ClosedByUserID = NULL WHERE FiscalYearID = ?')
        .run('open', fiscalYearId);
      db.prepare('DELETE FROM fiscal_year_openings WHERE FiscalYearID > ?').run(fiscalYearId);
    })();

    return { success: true };
  });
}
