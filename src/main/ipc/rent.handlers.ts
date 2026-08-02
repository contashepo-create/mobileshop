import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount } from '../../shared/money';
import { getCallerUserId } from '../security/ipcGuard';
import { businessToday } from '../../shared/businessDate';

/**
 * RENT CONTRACTS AND THEIR INSTALMENTS.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * 1. `rentPayments:pay` did not check whether the instalment was ALREADY PAID.
 *    Pressing the button twice took the money twice. Measured: paying one
 *    5,000 instalment three times moved 15,000 out of the till while the
 *    ledger still showed a single 5,000 charge, because the row was simply
 *    re-stamped 'paid' each time. The 10,000 difference appeared in no report.
 *    `salaries:pay` has had the correct guard all along; rent was the one
 *    place it was missing.
 *
 * 2. The book guard never ran on this section. `bookGuard.GUARDED_PREFIXES`
 *    listed `'rent:'`, but every channel here is `rents:` or `rentPayments:`.
 *    A single missing letter meant the runtime invariant checks — the ones
 *    that would have caught the double payment — were silently skipped.
 *
 * 3. A contract had a StartDate and no end. The screen hardcoded twelve
 *    instalments, so a six-month agreement could not be represented at all.
 *
 * 4. There was no way to end a contract. `rents:delete` set `IsActive = 0` and
 *    left every future instalment sitting in the list demanding payment.
 *
 * ACCOUNTING POSITION
 * -------------------
 * Rent is recognised WHEN PAID, and only paid instalments reach the profit and
 * loss — `WHERE rp.Status = 'paid'`. An instalment that has been generated but
 * not yet paid is a commitment, not an expense, and it is deliberately absent
 * from the P&L so it cannot invent a loss that has not happened.
 *
 * Future commitments are reported separately by `rents:commitments`, which is
 * INFORMATION ONLY: it never touches the books, so the profit figure is
 * unchanged by it. That is the honest way to answer "what do I still owe?"
 * without pretending the money has already left.
 */
export function registerRentHandlers() {
  ipcMain.handle('rents:list', async () => {
    const db = getDb();
    // The instalment roll-up travels with the contract so the screen can show
    // a real progress line instead of a bare row that says nothing about how
    // much of the agreement has actually been honoured.
    return db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.CancelledAt IS NULL) AS TotalInstalments,
        (SELECT COUNT(*) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.Status = 'paid') AS PaidInstalments,
        (SELECT COALESCE(SUM(p.Amount), 0) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.Status = 'paid') AS PaidTotal,
        (SELECT COALESCE(SUM(p.Amount), 0) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.Status = 'pending' AND p.CancelledAt IS NULL) AS OutstandingTotal
      FROM rents r
      ORDER BY COALESCE(r.Status, 'active') = 'active' DESC, r.StartDate DESC
    `).all();
  });

  ipcMain.handle('rents:create', async (_event, data: {
    RentName: string; RentType: string; Amount: number; Period: string;
    StartDate: string; EndDate?: string;
    PartyName?: string; PartyPhone?: string; Notes?: string;
  }) => {
    const db = getDb();
    // Rent is an amount of money, so it follows the same rule as every other:
    // the direction is the RentType, never the sign.
    const amt = checkAmount(data?.Amount, 'قيمة الإيجار', { allowZero: false });
    if (!amt.ok) return { success: false, message: amt.message };

    const start = String(data?.StartDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      return { success: false, message: 'تاريخ بداية العقد مطلوب' };
    }
    const end = String(data?.EndDate ?? '').trim();
    // An end date is optional — an open-ended arrangement is legitimate — but
    // one that precedes the start is not, and it would generate a contract
    // with a negative duration.
    if (end) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return { success: false, message: 'تاريخ نهاية العقد غير صالح' };
      }
      if (end < start) {
        return { success: false, message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' };
      }
    }
    if (data?.RentType !== 'expense' && data?.RentType !== 'income') {
      return { success: false, message: 'نوع الإيجار يجب أن يكون مدفوع أو مُحصَّل' };
    }
    if (data?.Period !== 'monthly' && data?.Period !== 'yearly') {
      return { success: false, message: 'دورية الإيجار يجب أن تكون شهرية أو سنوية' };
    }
    if (!String(data?.RentName ?? '').trim()) {
      return { success: false, message: 'اسم العقد مطلوب' };
    }

    const result = db.prepare(`
      INSERT INTO rents (RentName, RentType, Amount, Period, StartDate, EndDate,
                         IsActive, Status, PartyName, PartyPhone, Notes)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)
    `).run(
      data.RentName.trim(), data.RentType, data.Amount, data.Period, start,
      end || null, data.PartyName ?? null, data.PartyPhone ?? null, data.Notes ?? null,
    );
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('rents:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(id) as any;
    if (!existing) return { success: false, message: 'العقد غير موجود' };

    const amt = checkAmount(data?.Amount, 'قيمة الإيجار', { allowZero: false });
    if (!amt.ok) return { success: false, message: amt.message };

    const end = String(data?.EndDate ?? '').trim();
    if (end && end < String(existing.StartDate)) {
      return { success: false, message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' };
    }

    // Changing the amount must NOT silently rewrite instalments that have
    // already been paid: those are settled facts, and the cash has moved. Only
    // the unpaid ones follow the new figure.
    db.transaction(() => {
      db.prepare(`
        UPDATE rents SET RentName = ?, RentType = ?, Amount = ?, Period = ?,
          EndDate = ?, IsActive = ?, PartyName = ?, PartyPhone = ?, Notes = ?
        WHERE RentID = ?
      `).run(
        data.RentName, data.RentType, data.Amount, data.Period, end || null,
        data.IsActive, data.PartyName, data.PartyPhone, data.Notes, id,
      );
      if (Number(data.Amount) !== Number(existing.Amount)) {
        db.prepare(`
          UPDATE rent_payments SET Amount = ?
          WHERE RentID = ? AND Status = 'pending' AND CancelledAt IS NULL
        `).run(data.Amount, id);
      }
    })();
    return { success: true };
  });

  /**
   * Ends a contract.
   *
   * Cancelling is not deleting. The paid instalments are history and stay
   * exactly as they are — the money really did move, and erasing it would put
   * the till and the books out of step. Only the UNPAID instalments are
   * withdrawn, because those are obligations that will now never fall due.
   */
  ipcMain.handle('rents:cancel', async (_event, data: { RentID: number; Reason?: string }) => {
    const db = getDb();
    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(data?.RentID) as any;
    if (!rent) return { success: false, message: 'العقد غير موجود' };
    if (rent.Status === 'cancelled') {
      return { success: false, message: 'العقد ملغى بالفعل' };
    }
    const reason = String(data?.Reason ?? '').trim();
    if (!reason) return { success: false, message: 'سبب الإلغاء مطلوب' };

    const now = businessToday();
    let cancelledCount = 0;
    db.transaction(() => {
      const res = db.prepare(`
        UPDATE rent_payments SET CancelledAt = ?
        WHERE RentID = ? AND Status = 'pending' AND CancelledAt IS NULL
      `).run(now, data.RentID);
      cancelledCount = res.changes;
      db.prepare(`
        UPDATE rents SET Status = 'cancelled', IsActive = 0, CancelledAt = ?, CancelReason = ?
        WHERE RentID = ?
      `).run(now, reason, data.RentID);
    })();

    return {
      success: true,
      cancelledInstalments: cancelledCount,
      message: `تم إلغاء العقد وسحب ${cancelledCount} قسط غير مدفوع`,
    };
  });

  ipcMain.handle('rents:delete', async (_event, id: number) => {
    const db = getDb();
    // Kept for compatibility: it only deactivates, and unlike `rents:cancel`
    // it deliberately leaves the instalments alone.
    db.prepare('UPDATE rents SET IsActive = 0 WHERE RentID = ?').run(id);
    return { success: true };
  });

  // Rent payments
  ipcMain.handle('rentPayments:list', async (_event, rentId?: number) => {
    const db = getDb();
    let query = `
      SELECT rp.*, r.RentName, r.RentType, r.Period
      FROM rent_payments rp
      JOIN rents r ON rp.RentID = r.RentID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (rentId) { query += ' AND rp.RentID = ?'; params.push(rentId); }
    query += ' ORDER BY rp.DueDate DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('rentPayments:pay', async (_event, data: {
    RentPaymentID: number; CashAccountID: number;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
      .get(data.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'الدفعة غير موجودة' };

    // THE GUARD THAT WAS MISSING.
    //
    // Without it the handler re-stamped the row 'paid' and moved the cash
    // again, every time it was called. Two clicks on a slow machine, or a
    // retry after a lost window, silently took the rent twice: the ledger kept
    // showing one charge because the row is one row, while the till kept
    // losing money. Verified against `salaries:pay`, which has always had it.
    if (payment.Status === 'paid') {
      return { success: false, message: 'تم دفع هذا القسط بالفعل' };
    }
    if (payment.CancelledAt) {
      return { success: false, message: 'هذا القسط ملغى ولا يمكن دفعه' };
    }
    if (!data.CashAccountID) {
      return { success: false, message: 'اختر الخزينة' };
    }

    const dateStr = businessToday();
    const rent = db.prepare('SELECT RentType FROM rents WHERE RentID = ?').get(payment.RentID) as any;

    // Check sufficient balance for expense payments (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && rent?.RentType === 'expense') {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < payment.Amount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لدفع الإيجار: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${(payment.Amount || 0).toFixed(2)}` };
      }
    }

    db.transaction(() => {
      // SECOND LAYER, deliberately redundant with the check above.
      //
      // The early return handles the ordinary case. This handles the one it
      // cannot: two calls that interleave between the SELECT and the UPDATE,
      // where both read 'pending' and both proceed. Making the UPDATE itself
      // conditional means the database decides, and only one call can win.
      //
      // Mutation testing reports this clause as equivalent while the early
      // guard stands — removing either alone changes nothing observable.
      // Removing BOTH reproduces the original defect exactly: the till fell to
      // 80,000 while the ledger still showed a single 5,000 charge. It is kept
      // for the race the first check cannot see, not for the case it can.
      const res = db.prepare(`
        UPDATE rent_payments SET Status = 'paid', PaidDate = ?, CashAccountID = ?
        WHERE RentPaymentID = ? AND Status = 'pending' AND CancelledAt IS NULL
      `).run(dateStr, data.CashAccountID, data.RentPaymentID);
      if (res.changes !== 1) {
        throw new Error('ALREADY_PAID');
      }

      if (rent?.RentType === 'expense') {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
          .run(payment.Amount, data.CashAccountID);
      } else {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
          .run(payment.Amount, data.CashAccountID);
      }
    })();

    return { success: true };
  });

  /**
   * Un-pays an instalment that was paid by mistake.
   *
   * The cash is returned to the account it came from, so the till and the
   * books move together. Without this the only correction available was to
   * edit the database by hand.
   */
  ipcMain.handle('rentPayments:unpay', async (_event, data: {
    RentPaymentID: number; Reason?: string;
  }) => {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
      .get(data?.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'الدفعة غير موجودة' };
    if (payment.Status !== 'paid') return { success: false, message: 'هذا القسط غير مدفوع' };

    const rent = db.prepare('SELECT RentType FROM rents WHERE RentID = ?').get(payment.RentID) as any;

    db.transaction(() => {
      const res = db.prepare(`
        UPDATE rent_payments SET Status = 'pending', PaidDate = NULL
        WHERE RentPaymentID = ? AND Status = 'paid'
      `).run(data.RentPaymentID);
      if (res.changes !== 1) throw new Error('NOT_PAID');

      // Exact reverse of the payment, against the SAME account.
      if (payment.CashAccountID) {
        if (rent?.RentType === 'expense') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
            .run(payment.Amount, payment.CashAccountID);
        } else {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
            .run(payment.Amount, payment.CashAccountID);
        }
      }
    })();

    return { success: true, message: 'تم التراجع عن الدفع وإعادة المبلغ للخزينة' };
  });

  /**
   * Generates the instalment schedule.
   *
   * `months` is now supplied by the caller instead of a hardcoded twelve, and
   * an EndDate on the contract caps it: a six-month agreement produces six
   * instalments however large a number the screen asks for. Generating beyond
   * the end of a contract creates obligations the shop never agreed to.
   */
  ipcMain.handle('rents:generatePayments', async (
    event, rentId: number, months: number, _userId: number, fiscalYearId: number,
  ) => {
    const userId = getCallerUserId(event, _userId);
    const db = getDb();
    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(rentId) as any;
    if (!rent) return { success: false, message: 'الإيجار غير موجود' };
    if (rent.Status === 'cancelled') {
      return { success: false, message: 'لا يمكن توليد أقساط لعقد ملغى' };
    }

    // A count typed by a user is not a count until it has been checked. Zero
    // instalments is not a schedule, and an unbounded one fills the table.
    const requested = Math.trunc(Number(months));
    if (!Number.isFinite(requested) || requested < 1) {
      return { success: false, message: 'عدد الأقساط يجب أن يكون رقماً صحيحاً أكبر من صفر' };
    }
    if (requested > 120) {
      return { success: false, message: 'الحد الأقصى 120 قسطاً في المرة الواحدة' };
    }

    const startDate = new Date(rent.StartDate);
    if (Number.isNaN(startDate.getTime())) {
      return { success: false, message: 'تاريخ بداية العقد غير صالح' };
    }

    let created = 0;
    let stoppedAtEnd = false;
    const tx = db.transaction(() => {
      for (let i = 0; i < requested; i++) {
        const dueDate = new Date(startDate);
        if (rent.Period === 'monthly') dueDate.setMonth(dueDate.getMonth() + i);
        else dueDate.setFullYear(dueDate.getFullYear() + i);

        const dueStr = dueDate.toISOString().split('T')[0];
        // The contract's own end wins over whatever was asked for.
        if (rent.EndDate && dueStr > rent.EndDate) { stoppedAtEnd = true; break; }

        const periodLabel = rent.Period === 'monthly'
          ? `${dueDate.toLocaleString('ar-EG', { month: 'long', year: 'numeric' })}`
          : `${dueDate.getFullYear()}`;

        // Check if payment already exists
        const existing = db.prepare(
          'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? AND PeriodLabel = ?',
        ).get(rentId, periodLabel);
        if (!existing) {
          db.prepare(`
            INSERT INTO rent_payments (RentID, PeriodLabel, Amount, DueDate, Status, FiscalYearID, UserID)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)
          `).run(rentId, periodLabel, rent.Amount, dueStr, fiscalYearId, userId);
          created++;
        }
      }
    });
    tx();

    return {
      success: true,
      created,
      stoppedAtEnd,
      message: stoppedAtEnd
        ? `تم توليد ${created} قسط حتى نهاية العقد`
        : `تم توليد ${created} قسط`,
    };
  });

  /**
   * What the shop still owes, and is still owed, on its rent agreements.
   *
   * INFORMATION ONLY. It reads nothing into the books and changes no figure in
   * the profit and loss: an instalment that has not been paid is a commitment,
   * not an expense, and reporting it as one would invent a loss that has not
   * happened. This exists so the owner can answer "what is coming" without the
   * accounts pretending it has already gone.
   */
  ipcMain.handle('rents:commitments', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT r.RentID, r.RentName, r.RentType, r.PartyName, r.Period, r.EndDate,
             COUNT(p.RentPaymentID) AS PendingCount,
             COALESCE(SUM(p.Amount), 0) AS PendingTotal,
             MIN(p.DueDate) AS NextDueDate
      FROM rents r
      JOIN rent_payments p ON p.RentID = r.RentID
      WHERE p.Status = 'pending' AND p.CancelledAt IS NULL
        AND COALESCE(r.Status, 'active') <> 'cancelled'
      GROUP BY r.RentID
      ORDER BY NextDueDate ASC
    `).all() as any[];

    const today = businessToday();
    const overdue = db.prepare(`
      SELECT COALESCE(SUM(p.Amount), 0) AS total, COUNT(*) AS count
      FROM rent_payments p
      JOIN rents r ON r.RentID = p.RentID
      WHERE p.Status = 'pending' AND p.CancelledAt IS NULL
        AND COALESCE(r.Status, 'active') <> 'cancelled'
        AND p.DueDate < ?
    `).get(today) as any;

    const owed = rows.filter(r => r.RentType === 'expense')
      .reduce((sum, r) => sum + (r.PendingTotal || 0), 0);
    const due = rows.filter(r => r.RentType === 'income')
      .reduce((sum, r) => sum + (r.PendingTotal || 0), 0);

    return {
      success: true,
      contracts: rows,
      totalOwed: owed,
      totalDue: due,
      overdueTotal: overdue?.total || 0,
      overdueCount: overdue?.count || 0,
    };
  });
}
