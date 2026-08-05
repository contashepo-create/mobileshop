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
    return db.prepare("SELECT * FROM fiscal_years WHERE Status = 'open' ORDER BY StartDate DESC LIMIT 1").get();
  });

  ipcMain.handle('fiscalYear:create', async (_event, data: { YearName: string; StartDate: string; EndDate: string }) => {
    const db = getDb();

    // Exactly one year may be open at a time.
    //
    // `fiscalYear:getActive` resolves the year with `ORDER BY StartDate DESC
    // LIMIT 1`, and settlements, salaries and every document stamp themselves
    // with whatever it returns. With two years open that choice is silent and
    // arbitrary: postings meant for the old year land in the new one, and
    // every report that filters by year is then wrong in both directions with
    // nothing on screen to explain it. Measured — a second year was created
    // while the first was still open and both showed Status 'open'.
    //
    // Closing the previous year is a deliberate accounting act (it is what
    // fixes the comparatives), so it is required rather than done implicitly.
    const stillOpen = db.prepare(
      "SELECT YearName FROM fiscal_years WHERE Status = 'open' ORDER BY StartDate DESC LIMIT 1",
    ).get() as any;
    if (stillOpen) {
      return {
        success: false,
        message: `لا يمكن فتح سنة مالية جديدة قبل إقفال السنة الحالية (${stillOpen.YearName}).`,
      };
    }

    if (!data?.YearName?.trim()) {
      return { success: false, message: 'اسم السنة المالية مطلوب' };
    }
    if (!data?.StartDate || !data?.EndDate) {
      return { success: false, message: 'تاريخ البداية والنهاية مطلوبان' };
    }
    if (data.EndDate <= data.StartDate) {
      return { success: false, message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' };
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
      db.prepare('INSERT INTO fiscal_years (YearName, StartDate, EndDate, Status) VALUES (?, ?, ?, ?)').run(
        newYearName, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], 'open'
      );
    })();

    return { success: true };
  });
}
