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
      'SELECT AccountType, AccountID, Balance FROM fiscal_year_openings WHERE FiscalYearID = ? ORDER BY AccountType, AccountID'
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

      // Carry the current balances into the new year as its OPENING BALANCES.
      //
      // The balances are stored, cumulative columns, so they already continue
      // across the boundary — this is the written snapshot of what the new
      // year started with, account by account, taken inside the same
      // transaction that closed the old year. The statements recompute the
      // true opening from movements (a late entry in a reopened year must
      // still reach the year that follows), but the document the owner asked
      // for — "the balances are carried over as the new year's opening" — is
      // this: one row per cash account, payment method, customer and supplier.
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Balance)
        SELECT ?, 'cash_account', CashAccountID, Balance FROM cash_accounts WHERE IsActive = 1
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Balance)
        SELECT ?, 'payment_method', PaymentMethodID, Balance FROM payment_methods WHERE IsActive = 1
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Balance)
        SELECT ?, 'customer', CustomerID, Balance FROM customers
      `).run(newFyId);
      db.prepare(`
        INSERT INTO fiscal_year_openings (FiscalYearID, AccountType, AccountID, Balance)
        SELECT ?, 'supplier', SupplierID, Balance FROM suppliers
      `).run(newFyId);
    })();

    return { success: true };
  });

  // The opening-balance snapshot a year started with (one row per cash
  // account, payment method, customer and supplier, taken when it was created
  // by closing the year before it).
  ipcMain.handle('fiscalYear:openings', async (_event, fiscalYearId: number) => {
    if (!Number.isInteger(fiscalYearId)) {
      return { success: false, message: 'معرف السنة المالية غير صالح' };
    }
    const db = getDb();
    const openings = db.prepare(
      'SELECT AccountType, AccountID, Balance FROM fiscal_year_openings WHERE FiscalYearID = ? ORDER BY AccountType, AccountID'
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
