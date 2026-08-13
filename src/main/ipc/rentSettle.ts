import type Database from 'better-sqlite3';

/**
 * THE ONE PLACE MONEY IS APPLIED TO A RENT INSTALMENT.
 *
 * WHY IT IS SHARED
 * ----------------
 * Rent can now be settled from two screens: the rent page, and a payment
 * voucher tagged to a month. If each screen carried its own arithmetic they
 * would drift, and the drift would be silent — one path enforcing the
 * remaining balance while the other let it be exceeded, so the same month
 * could be paid twice through two different doors.
 *
 * Every rule about how much may be applied lives here, and both callers go
 * through it. The rule that matters most:
 *
 *     an instalment can never receive more than it still owes.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `rent_payments` had no PaidAmount. An instalment was paid or unpaid, full
 * stop, so half now and half at the end of the month could not be recorded at
 * all. And a voucher written for rent was excluded from the profit and loss
 * (`PartyType='rent'` is filtered out, because rent is supposed to come from
 * rent_payments) while updating no instalment — so the money left the till and
 * appeared in NO expense figure anywhere.
 */

export interface ApplyArgs {
  db: Database.Database;
  rentPaymentId: number;
  amount: number;
  txnDate: string;
  cashAccountId?: number | null;
  paymentMethodId?: number | null;
  /** 'rent' when settled from the rent screen, 'voucher' from a voucher. */
  sourceType: 'rent' | 'voucher';
  sourceId?: number | null;
  userId?: number | null;
  fiscalYearId?: number | null;
  notes?: string | null;
  /** Set by the caller when it has already moved the cash itself. */
  skipCashMove?: boolean;
}

export interface ApplyResult {
  success: boolean;
  message?: string;
  applied?: number;
  remaining?: number;
  status?: string;
}

/** Money is compared in whole piastres so 0.1 + 0.2 cannot leave a residue. */
const cents = (n: number) => Math.round((Number(n) || 0) * 100);
const money = (c: number) => c / 100;

/**
 * Applies a payment to one instalment, inside the caller's transaction.
 *
 * Returns a structured failure rather than throwing, so a caller that is
 * mid-transaction can decide whether to abandon it.
 */
export function applyToInstalment(args: ApplyArgs): ApplyResult {
  const {
    db, rentPaymentId, amount, txnDate,
    cashAccountId, paymentMethodId, sourceType, sourceId,
    userId, fiscalYearId, notes, skipCashMove,
  } = args;

  const payment = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
    .get(rentPaymentId) as any;
  if (!payment) return { success: false, message: 'القسط غير موجود' };
  if (payment.CancelledAt) return { success: false, message: 'هذا القسط ملغى ولا يمكن دفعه' };

  const rent = db.prepare('SELECT * FROM rents WHERE RentID = ?').get(payment.RentID) as any;
  if (!rent) return { success: false, message: 'العقد غير موجود' };
  if (rent.Status === 'cancelled') {
    return { success: false, message: 'العقد ملغى - لا يمكن دفع أقساطه' };
  }

  const due = cents(payment.Amount);
  const already = cents(payment.PaidAmount);
  const remaining = due - already;
  if (remaining <= 0) {
    return { success: false, message: 'تم دفع هذا القسط بالكامل' };
  }

  const wanted = cents(amount);
  if (!Number.isFinite(amount) || wanted <= 0) {
    return { success: false, message: 'المبلغ يجب أن يكون أكبر من صفر' };
  }
  // THE GUARD. Whichever door the money comes through, an instalment cannot
  // absorb more than it owes — that is what stops the same month being settled
  // twice, once from the rent screen and once from a voucher.
  if (wanted > remaining) {
    return {
      success: false,
      message: `المبلغ أكبر من المتبقي على القسط: المتبقي ${money(remaining).toFixed(2)}`,
    };
  }

  const nowPaid = already + wanted;
  const status = nowPaid >= due ? 'paid' : 'partial';

  // The UPDATE is conditional on the figure we just read. If anything changed
  // underneath us the update matches nothing and we refuse, rather than
  // writing a total computed from stale data.
  //
  // `PaidDate` is stamped on the FIRST money an instalment receives, partial
  // or not. Stamping only `paid` left PaidDate NULL on a partially-settled
  // month that had genuinely received payment — so the profit report's date
  // filter (which dates the income by PaidDate) silently dropped the money,
  // and the statements had to guess `COALESCE(PaidDate, DueDate)`.
  const res = db.prepare(`
    UPDATE rent_payments
       SET PaidAmount = ?, Status = ?,
           PaidDate = CASE WHEN ? > 0 THEN ? ELSE PaidDate END,
           CashAccountID = COALESCE(?, CashAccountID),
           PaymentMethodID = COALESCE(?, PaymentMethodID)
     WHERE RentPaymentID = ?
       AND COALESCE(PaidAmount, 0) = ?
       AND CancelledAt IS NULL
  `).run(
    money(nowPaid), status, money(nowPaid), txnDate,
    cashAccountId ?? null, paymentMethodId ?? null,
    rentPaymentId, money(already),
  );
  if (res.changes !== 1) {
    return { success: false, message: 'تعذّر تسجيل الدفع - أعد المحاولة' };
  }

  db.prepare(`
    INSERT INTO rent_transactions
      (RentID, RentPaymentID, RentPartyID, Kind, Amount, TxnDate,
       CashAccountID, PaymentMethodID, SourceType, SourceID, Notes, FiscalYearID, UserID)
    VALUES (?, ?, ?, 'instalment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payment.RentID, rentPaymentId, rent.RentPartyID ?? null,
    money(wanted), txnDate, cashAccountId ?? null, paymentMethodId ?? null,
    sourceType, sourceId ?? null, notes ?? null, fiscalYearId ?? null, userId ?? null,
  );

  if (!skipCashMove) {
    moveCash(db, rent.RentType, money(wanted), cashAccountId, paymentMethodId, +1);
  }

  return {
    success: true,
    applied: money(wanted),
    remaining: money(due - nowPaid),
    status,
  };
}

/**
 * Moves money for a rent settlement.
 *
 * `direction` is +1 for a payment and -1 for its reversal, so the same
 * function performs both and a reversal cannot use different arithmetic from
 * the payment it undoes.
 */
export function moveCash(
  db: Database.Database,
  rentType: string,
  amount: number,
  cashAccountId?: number | null,
  paymentMethodId?: number | null,
  // A default is REQUIRED here by the language, not by preference: a
  // parameter with no default cannot follow optional ones (TS1016), and the
  // two account ids above are both optional. I removed the default last time
  // to force every caller to state a direction, and shipped a file that does
  // not compile — the safety I wanted has to come from a check that runs.
  //
  // So: the default is +1 (a payment), and the guard below refuses anything
  // that is not exactly +1 or -1. A caller that omits it gets the ordinary
  // direction; a caller that passes nonsense is stopped rather than silently
  // multiplying money by a number nobody intended.
  direction: 1 | -1 = 1,
): void {
  if (direction !== 1 && direction !== -1) {
    throw new Error(`moveCash: direction must be +1 or -1, received ${String(direction)}`);
  }
  // An expense contract takes money OUT; an income contract brings it in.
  const sign = (rentType === 'expense' ? -1 : 1) * direction;
  const delta = sign * amount;
  if (paymentMethodId) {
    db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?')
      .run(delta, paymentMethodId);
  } else if (cashAccountId) {
    db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
      .run(delta, cashAccountId);
  }
}

/**
 * Refuses a payment the till cannot fund.
 *
 * Returns a message when the balance is short, or null when the payment may
 * proceed. Income contracts are exempt: money is arriving, not leaving.
 */
export function checkFunds(
  db: Database.Database,
  rentType: string,
  amount: number,
  cashAccountId?: number | null,
  paymentMethodId?: number | null,
): string | null {
  if (rentType !== 'expense') return null;
  const allowNeg = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'")
    .get() as any;
  if (allowNeg?.Value === '1') return null;

  if (paymentMethodId) {
    const pm = db.prepare('SELECT Balance, MethodName FROM payment_methods WHERE PaymentMethodID = ?')
      .get(paymentMethodId) as any;
    if (!pm || (pm.Balance || 0) < amount) {
      return `الرصيد غير كافٍ في ${pm?.MethodName || 'وسيلة الدفع'}: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${amount.toFixed(2)}`;
    }
    return null;
  }
  if (cashAccountId) {
    const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?')
      .get(cashAccountId) as any;
    if (!acc || (acc.Balance || 0) < amount) {
      return `الرصيد غير كافٍ في الخزينة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${amount.toFixed(2)}`;
    }
  }
  return null;
}

/** What an instalment still owes, in currency units. */
export function remainingOn(payment: { Amount: number; PaidAmount?: number }): number {
  return money(cents(payment.Amount) - cents(payment.PaidAmount ?? 0));
}
