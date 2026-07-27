import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { getCallerUserId } from '../security/ipcGuard';

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

    const dateStr = new Date().toISOString().split('T')[0];

    db.transaction(() => {
      // Close current year
      db.prepare('UPDATE fiscal_years SET Status = ?, ClosedAt = ?, ClosedByUserID = ? WHERE FiscalYearID = ?')
        .run('closed', dateStr, userId, fiscalYearId);

      // Create new year starting the day after
      const startDate = new Date(fy.EndDate);
      startDate.setDate(startDate.getDate() + 1);
      const endDate = new Date(startDate);
      endDate.setFullYear(endDate.getFullYear() + 1);

      const newYearName = `السنة المالية ${endDate.getFullYear()}`;
      db.prepare('INSERT INTO fiscal_years (YearName, StartDate, EndDate, Status) VALUES (?, ?, ?, ?)').run(
        newYearName, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], 'open'
      );
    })();

    return { success: true };
  });
}
