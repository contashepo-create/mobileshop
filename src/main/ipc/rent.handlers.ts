import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { requireId } from '../../shared/validate';
import { checkAmount } from '../../shared/money';
import { getCallerUserId } from '../security/ipcGuard';
import { businessToday } from '../../shared/businessDate';
import { applyToInstalment, moveCash, checkFunds, remainingOn } from './rentSettle';

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
    /** Links the contract to a landlord/tenant record. */
    RentPartyID?: number | null;
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
                         IsActive, Status, PartyName, PartyPhone, Notes, RentPartyID)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)
    `).run(
      data.RentName.trim(), data.RentType, data.Amount, data.Period, start,
      end || null, data.PartyName ?? null, data.PartyPhone ?? null, data.Notes ?? null,
      data.RentPartyID ?? null,
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
          EndDate = ?, IsActive = ?, PartyName = ?, PartyPhone = ?, Notes = ?,
          RentPartyID = COALESCE(?, RentPartyID)
        WHERE RentID = ?
      `).run(
        data.RentName, data.RentType, data.Amount, data.Period, end || null,
        data.IsActive, data.PartyName, data.PartyPhone, data.Notes,
        data.RentPartyID ?? null, id,
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
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const canRent = requireId(data?.RentID, 'رقم العقد');
    if (!canRent.ok) return { success: false, message: canRent.message };
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

  /**
   * Pays all or PART of an instalment.
   *
   * The arithmetic lives in `rentSettle.applyToInstalment`, shared with the
   * voucher path, so both doors enforce the same rule: an instalment can never
   * receive more than it still owes. That is what makes it impossible to
   * settle the same month twice through two different screens.
   */
  ipcMain.handle('rentPayments:pay', async (_event, data: {
    RentPaymentID: number; CashAccountID?: number; PaymentMethodID?: number;
    Amount?: number; userId: number; fiscalYearId: number; Notes?: string;
  }) => {
    const db = getDb();
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const payId = requireId(data?.RentPaymentID, 'رقم القسط');
    if (!payId.ok) return { success: false, message: payId.message };
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
      .get(data.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'الدفعة غير موجودة' };
    if (!data.CashAccountID && !data.PaymentMethodID) {
      return { success: false, message: 'اختر الخزينة أو وسيلة الدفع' };
    }

    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(payment.RentID) as any;
    if (!rent) return { success: false, message: 'العقد غير موجود' };

    // Absent amount means "settle what is left", which is the common case and
    // keeps the old one-click behaviour working.
    const outstanding = remainingOn(payment);
    const amount = data.Amount === undefined || data.Amount === null
      ? outstanding : Number(data.Amount);

    const shortfall = checkFunds(db, rent.RentType, amount, data.CashAccountID, data.PaymentMethodID);
    if (shortfall) return { success: false, message: shortfall };

    // The throw below rolls the transaction back; the structured failure that
    // caused it is what the caller sees. Without the try the rejection would
    // surface as an unhandled Error and the screen would show nothing useful.
    let result: any = { success: false, message: 'تعذّر الدفع' };
    try {
      db.transaction(() => {
      result = applyToInstalment({
        db,
        rentPaymentId: data.RentPaymentID,
        amount,
        txnDate: businessToday(),
        cashAccountId: data.CashAccountID ?? null,
        paymentMethodId: data.PaymentMethodID ?? null,
        sourceType: 'rent',
        userId: data.userId,
        fiscalYearId: data.fiscalYearId,
        notes: data.Notes ?? null,
      });
      if (!result.success) throw new Error('REJECTED');
      })();
    } catch {
      // `result` already holds the reason.
    }

    return result;
  });

  /**
   * Reverses everything received against an instalment.
   *
   * Each movement is undone against the ACCOUNT IT CAME FROM, using the same
   * `moveCash` the payment used. A partial paid half from the till and half
   * from a wallet returns half to each — reversing the total to one account
   * would leave one short and the other over by the same amount.
   */
  ipcMain.handle('rentPayments:unpay', async (_event, data: {
    RentPaymentID: number; Reason?: string;
  }) => {
    const db = getDb();
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const unpayId = requireId(data?.RentPaymentID, 'رقم القسط');
    if (!unpayId.ok) return { success: false, message: unpayId.message };
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
      .get(data?.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'الدفعة غير موجودة' };
    if ((payment.PaidAmount || 0) <= 0) {
      return { success: false, message: 'هذا القسط غير مدفوع' };
    }

    const rent = db.prepare('SELECT RentType FROM rents WHERE RentID = ?').get(payment.RentID) as any;
    const txns = db.prepare(`
      SELECT * FROM rent_transactions
       WHERE RentPaymentID = ? AND Kind = 'instalment' AND ReversedAt IS NULL
    `).all(data.RentPaymentID) as any[];

    const now = businessToday();
    db.transaction(() => {
      const res = db.prepare(`
        UPDATE rent_payments SET Status = 'pending', PaidAmount = 0, PaidDate = NULL
         WHERE RentPaymentID = ? AND COALESCE(PaidAmount, 0) > 0
      `).run(data.RentPaymentID);
      if (res.changes !== 1) throw new Error('NOT_PAID');

      if (txns.length > 0) {
        for (const t of txns) {
          moveCash(db, rent?.RentType, t.Amount, t.CashAccountID, t.PaymentMethodID, -1);
          db.prepare('UPDATE rent_transactions SET ReversedAt = ? WHERE RentTxnID = ?')
            .run(now, t.RentTxnID);
        }
      } else if (payment.CashAccountID) {
        // A row paid before rent_transactions existed has no movements to walk,
        // so fall back to the single account the instalment recorded.
        moveCash(db, rent?.RentType, payment.PaidAmount || payment.Amount,
          payment.CashAccountID, payment.PaymentMethodID, -1);
      }
    })();

    return { success: true, message: 'تم التراجع عن الدفع وإعادة المبلغ' };
  });

  /**
   * Records a deposit or prepayment held against the CONTRACT.
   *
   * Deliberately NOT an expense. The money has been handed over but no month
   * has been consumed by it yet, so it is an asset of the shop — a claim on
   * the landlord — until it is applied. Treating it as rent paid would charge
   * the profit and loss for a period that has not happened.
   */
  ipcMain.handle('rents:addAdvance', async (_event, data: {
    RentID: number; Amount: number;
    CashAccountID?: number; PaymentMethodID?: number;
    userId?: number; fiscalYearId?: number; Notes?: string;
  }) => {
    const db = getDb();
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const advRent = requireId(data?.RentID, 'رقم العقد');
    if (!advRent.ok) return { success: false, message: advRent.message };
    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(data?.RentID) as any;
    if (!rent) return { success: false, message: 'العقد غير موجود' };
    if (rent.Status === 'cancelled') return { success: false, message: 'العقد ملغى' };

    const amt = checkAmount(data?.Amount, 'قيمة المقدم', { allowZero: false });
    if (!amt.ok) return { success: false, message: amt.message };
    if (!data.CashAccountID && !data.PaymentMethodID) {
      return { success: false, message: 'اختر الخزينة أو وسيلة الدفع' };
    }

    const shortfall = checkFunds(db, rent.RentType, data.Amount, data.CashAccountID, data.PaymentMethodID);
    if (shortfall) return { success: false, message: shortfall };

    const now = businessToday();
    db.transaction(() => {
      db.prepare('UPDATE rents SET AdvanceBalance = COALESCE(AdvanceBalance,0) + ? WHERE RentID = ?')
        .run(data.Amount, data.RentID);
      db.prepare(`
        INSERT INTO rent_transactions
          (RentID, RentPaymentID, RentPartyID, Kind, Amount, TxnDate,
           CashAccountID, PaymentMethodID, SourceType, Notes, FiscalYearID, UserID)
        VALUES (?, NULL, ?, 'advance', ?, ?, ?, ?, 'rent', ?, ?, ?)
      `).run(
        data.RentID, rent.RentPartyID ?? null, data.Amount, now,
        data.CashAccountID ?? null, data.PaymentMethodID ?? null,
        data.Notes ?? null, data.fiscalYearId ?? null, data.userId ?? null,
      );
      moveCash(db, rent.RentType, data.Amount, data.CashAccountID, data.PaymentMethodID, +1);
    })();

    return { success: true, message: 'تم تسجيل المقدم' };
  });

  /**
   * Consumes part of the advance against a specific instalment.
   *
   * No cash moves here — it moved when the advance was taken. This only
   * converts a held balance into a settled month, which is the point at which
   * it becomes rent expense.
   */
  ipcMain.handle('rents:applyAdvance', async (_event, data: {
    RentPaymentID: number; Amount?: number; userId?: number; fiscalYearId?: number;
  }) => {
    const db = getDb();
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const applyId = requireId(data?.RentPaymentID, 'رقم القسط');
    if (!applyId.ok) return { success: false, message: applyId.message };
    const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
      .get(data?.RentPaymentID) as any;
    if (!payment) return { success: false, message: 'القسط غير موجود' };
    const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(payment.RentID) as any;
    if (!rent) return { success: false, message: 'العقد غير موجود' };

    const held = Number(rent.AdvanceBalance || 0);
    if (held <= 0) return { success: false, message: 'لا يوجد رصيد مقدم على هذا العقد' };

    const outstanding = remainingOn(payment);
    if (outstanding <= 0) return { success: false, message: 'تم دفع هذا القسط بالكامل' };

    // Never apply more than is held, and never more than the month owes.
    const amount = Math.min(
      data.Amount === undefined || data.Amount === null ? outstanding : Number(data.Amount),
      held, outstanding,
    );
    if (!(amount > 0)) return { success: false, message: 'المبلغ غير صالح' };

    let result: any = { success: false, message: 'تعذّر الخصم من المقدم' };
    try {
      db.transaction(() => {
        result = applyToInstalment({
          db,
          rentPaymentId: data.RentPaymentID,
          amount,
          txnDate: businessToday(),
          sourceType: 'rent',
          userId: data.userId ?? null,
          fiscalYearId: data.fiscalYearId ?? null,
          notes: 'خصم من المقدم',
          // The cash already left when the advance was taken; moving it again
          // here would take the money twice for one payment.
          //
          // Belt and braces: this call also passes no account, so `moveCash`
          // would find nothing to update even without the flag — mutation
          // testing confirms removing it changes nothing today. It is stated
          // anyway because it declares the INTENT. If an account is ever
          // threaded through here for reporting, the flag is what stops that
          // change from silently double-charging the till.
          skipCashMove: true,
        });
        if (!result.success) throw new Error('REJECTED');
        db.prepare('UPDATE rents SET AdvanceBalance = COALESCE(AdvanceBalance,0) - ? WHERE RentID = ?')
          .run(amount, payment.RentID);
      })();
    } catch { /* result carries the reason */ }

    return result;
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
