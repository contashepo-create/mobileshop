import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday, resolveDocDate } from '../../shared/businessDate';
import { applyToInstalment, remainingOn } from './rentSettle';
import { checkAmounts } from '../../shared/money';
import {
  oneOf, optionalOneOf, requireText, optionalText,
  LIMITS, VOUCHER_TYPES, PARTY_TYPES,
} from '../../shared/validate';

export function registerVouchersHandlers() {
  ipcMain.handle('vouchers:get', async (_event, voucherId: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT v.*, u.Username, ca.AccountName as CashAccountName
      FROM vouchers v
      JOIN users u ON v.UserID = u.UserID
      LEFT JOIN cash_accounts ca ON v.CashAccountID = ca.CashAccountID
      WHERE v.VoucherID = ?
    `).get(voucherId);
  });

  ipcMain.handle('vouchers:list', async (_event, filters?: { type?: string; fromDate?: string; toDate?: string }) => {
    const db = getDb();
    let query = `
      SELECT v.*, u.Username
      FROM vouchers v
      JOIN users u ON v.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.type && filters.type !== 'all') { query += ' AND v.VoucherType = ?'; params.push(filters.type); }
    if (filters?.fromDate) { query += ' AND v.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND v.Date <= ?'; params.push(filters.toDate); }
    query += ' ORDER BY v.Date DESC, v.VoucherID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('vouchers:create', async (_event, data: {
    VoucherType: string; Amount: number;
    PartyType?: string; PartyID?: number; PartyName?: string;
    Description: string; CashAccountID: number; PaymentMethodID?: number;
    ReferenceType?: string; ReferenceID?: number;
    /** Settles a specific rent instalment. See the block in the transaction. */
    RentPaymentID?: number;
    /** Closes a specific earned commission; the shop decides the payout is now. */
    CommissionID?: number;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    // Direction is expressed by VoucherType, never by the sign of the money.
    // Measured: a receipt of -9999 took 9,999 OUT of the till and recorded it
    // as cash coming in, so the document and the balance agreed on a figure
    // that was the exact opposite of the truth.
    const badAmount = checkAmounts([[data.Amount, 'مبلغ السند', { allowZero: false }]]);
    if (badAmount) return { success: false, message: badAmount };

    // The TYPE decides which way the money goes, so it is the one field that
    // must be exactly one of two words.
    //
    // Nothing checked it. `sign` below is `VoucherType === 'receipt' ? 1 : -1`,
    // so ANY other string — including `'RECEIPT'` with capitals — fell to the
    // -1 branch and took the amount OUT of the till while the document read as
    // money coming in. Worse, every report and statement filters
    // `WHERE VoucherType = 'receipt'` or `= 'payment'` exactly, so the row
    // matched neither and became invisible.
    //
    // MEASURED: `VoucherType: 'RECEIPT'`, 5,000 EGP. The safe went from 10,000
    // to 5,000, `SELECT COUNT(*) WHERE VoucherType IN ('receipt','payment')`
    // returned 0 of 1, and the profit-and-loss statement showed no expense.
    // Five thousand pounds left the shop and no report in the system could say
    // where it went.
    const vType = oneOf(data.VoucherType, 'نوع السند', VOUCHER_TYPES);
    if (!vType.ok) return { success: false, message: vType.message };

    // The party type selects the ledger table updated further down. An
    // unrecognised value matched no branch, so the voucher moved the cash and
    // updated nobody's balance — the same silent half-operation as an
    // unrecognised VoucherType, one table along.
    const pType = optionalOneOf(data.PartyType, 'نوع الطرف', PARTY_TYPES);
    if (!pType.ok) return { success: false, message: pType.message };

    // The description is printed on the voucher the customer is handed, and
    // was measured storing 1,000,000 characters.
    const desc = requireText(data.Description, 'بيان السند', LIMITS.DESCRIPTION);
    if (!desc.ok) return { success: false, message: desc.message };
    const pName = optionalText(data.PartyName, 'اسم الطرف', LIMITS.NAME);
    if (!pName.ok) return { success: false, message: pName.message };

    // Bind the checked values back, so everything below this point — the
    // INSERT, the sign, the ledger branch — reads the validated form rather
    // than the raw payload.
    data = {
      ...data,
      VoucherType: vType.value,
      PartyType: pType.value ?? undefined,
      Description: desc.value,
      PartyName: pName.value ?? undefined,
    };

    // A voucher MUST name exactly one asset.
    //
    // Neither: the voucher was accepted and no balance changed at all — the
    // expense or income was recorded while the money existed nowhere. Both:
    // the form let a safe AND a wallet be chosen, and the code below moves the
    // WALLET and silently ignores the safe, so the printed document named an
    // asset that never moved. Both cases were reachable from the ordinary
    // form, which is why the screen now asks the question once.
    if (!data.CashAccountID && !data.PaymentMethodID) {
      return { success: false, message: 'اختر الأصل الذي يخرج منه المبلغ أو يدخل إليه' };
    }
    // A named party MUST exist.
    //
    // The ledger update below is a bare `UPDATE ... WHERE CustomerID = ?`.
    // SQLite matches zero rows for an id that is not there and reports no
    // error, so the voucher was written and the CASH moved while the debt it
    // was supposed to settle was never touched.
    //
    // MEASURED: a receipt of 100 against customer 99999 raised net worth by
    // 100 out of nothing — the shop's books gained money that no customer
    // ever paid. A stale id is not exotic either: a second till deleting a
    // customer while this one has the form open produces exactly this.
    if (data.PartyID && data.PartyType) {
      const table = data.PartyType === 'customer' ? 'customers'
        : data.PartyType === 'supplier' ? 'suppliers'
          : data.PartyType === 'employee' ? 'employees' : null;
      if (table) {
        const idCol = data.PartyType === 'customer' ? 'CustomerID'
          : data.PartyType === 'supplier' ? 'SupplierID' : 'EmployeeID';
        const exists = db.prepare(
          `SELECT 1 AS ok FROM ${table} WHERE ${idCol} = ?`).get(data.PartyID) as any;
        if (!exists) {
          const label = data.PartyType === 'customer' ? 'العميل'
            : data.PartyType === 'supplier' ? 'المورد' : 'الموظف';
          return { success: false, message: `${label} غير موجود` };
        }
      }
    }

    if (data.CashAccountID && data.PaymentMethodID) {
      return {
        success: false,
        message: 'اختر أصلاً واحداً فقط - إما خزينة/بنك أو محفظة',
      };
    }
    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
    const prefix = data.VoucherType === 'receipt' ? 'RCV' : 'PAY';
    const voucherNumber = nextDocNumber(db, 'vouchers', 'VoucherNumber', prefix, dateStr);

    // Both chosen assets must EXIST and be ACTIVE, in either direction.
    //
    // Receipts never ran any asset check: a receipt into a ghost drawer or into
    // a disabled one sailed past every guard and either threw the SQLite
    // foreign-key error out of the handler (a receipt into cash_accounts 99999)
    // or — worse — landed money in a disabled safe that no one will ever look
    // at. And a payment with `allow_negative_cash = '1'` skips the balance
    // check below, so it reached the INSERT and threw the same FK error.
    //
    // MEASURED: receipts into cash_accounts 99999 and payment_methods 99999
    // both crashed the handler with 'FOREIGN KEY constraint failed' instead of
    // answering the form.
    if (data.CashAccountID) {
      const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?')
        .get(data.CashAccountID) as any;
      if (!acc) return { success: false, message: 'الخزينة غير موجودة' };
      if (!acc.IsActive) return { success: false, message: 'لا يمكن استخدام خزينة معطلة' };
    }
    if (data.PaymentMethodID) {
      const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?')
        .get(data.PaymentMethodID) as any;
      if (!pm) return { success: false, message: 'طريقة الدفع غير موجودة' };
      if (!pm.IsActive) return { success: false, message: 'لا يمكن استخدام طريقة دفع معطلة' };
    }

    // Check sufficient balance for payment vouchers.
    //
    // The DRAWER obeys the `allow_negative_cash` switch: when it is off the
    // handler refuses here, and when it is on the UPDATE below is free to run
    // (the cash trigger in the schema carries the same switch).
    //
    // The MACHINE never does. Its trigger refuses a negative balance with no
    // exception, and MEASURED a payment of 5,300 against a 5,000 wallet threw
    // "wallet balance must not be negative" straight out of the handler while
    // the switch said `allow_negative_cash = '1'`. A form that the machine is
    // allowed to refuse must answer with a message, not a crash, so the
    // machine balance is checked HERE unconditionally, switch or not.
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (data.VoucherType === 'payment') {
      if (data.PaymentMethodID) {
        const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
        if (!pm || (pm.Balance || 0) < data.Amount) {
          return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
        }
      }
      if (allowNegCash?.Value !== '1' && data.CashAccountID) {
        const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
        if (!acc || (acc.Balance || 0) < data.Amount) {
          return { success: false, message: `الرصيد غير كافٍ في الخزينة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
        }
      }
    }

    // A voucher may settle a specific rent instalment.
    //
    // Before this existed, writing a voucher for rent moved money and updated
    // NOTHING: the profit and loss excludes PartyType='rent' (rent is supposed
    // to arrive from rent_payments), so the amount left the till and appeared
    // in no expense figure at all. The month also stayed unpaid, so it could
    // be settled AGAIN from the rent screen.
    //
    // Checked here, before anything is written, so a bad link cannot leave a
    // voucher recorded against an instalment it could not settle.
    if (data.RentPaymentID) {
      if (data.VoucherType !== 'payment') {
        return { success: false, message: 'ربط الإيجار متاح لسندات الصرف فقط' };
      }
      if (data.PartyType && data.PartyID) {
        return {
          success: false,
          message: 'لا يجوز ربط السند بقسط إيجار وبطرف معاً — '
            + 'الدفعة الواحدة إما إيجار أو تسوية طرف.',
        };
      }
      const rp = db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID = ?')
        .get(data.RentPaymentID) as any;
      if (!rp) return { success: false, message: 'القسط المحدد غير موجود' };
      if (rp.CancelledAt) return { success: false, message: 'القسط المحدد ملغى' };
      const left = remainingOn(rp);
      if (left <= 0) return { success: false, message: 'تم دفع هذا القسط بالكامل' };
      if (data.Amount > left + 0.005) {
        return {
          success: false,
          message: `المبلغ أكبر من المتبقي على القسط: المتبقي ${left.toFixed(2)}`,
        };
      }
    }

    // A voucher may close an earned commission.
    //
    // The general payment voucher is the DOCUMENT that moves the cash, and the
    // commission is a single amount that is whole or not paid at all — so the
    // voucher amount must match the commission being closed, and the commission
    // is marked paid (IsPaid = 1, PaidVoucherID = the new voucher) inside the
    // same transaction. The P&L then books the technician's expense from this
    // voucher exactly once and the balance sheet stops holding the commission
    // as a liability. Mirrors the rent link: checked before anything is written
    // so a bad link can never leave a voucher recorded against a commission it
    // did not settle.
    if (data.CommissionID) {
      if (data.VoucherType !== 'payment') {
        return { success: false, message: 'ربط العمولة متاح لسندات الصرف فقط' };
      }
      if (data.RentPaymentID) {
        return {
          success: false,
          message: 'لا يجوز ربط السند بعملية إيجار وعمولة معاً — اختر واحدة.',
        };
      }
      if (data.PartyID && data.PartyType) {
        return {
          success: false,
          message: 'سند العمولة لا يُقيَّد بطرف — العمولة تُصرف لصاحبها مباشرة.',
        };
      }
      const com = db.prepare('SELECT * FROM commissions WHERE CommissionID = ?')
        .get(data.CommissionID) as any;
      if (!com) return { success: false, message: 'العمولة غير موجودة' };
      if (com.IsPaid === 1) return { success: false, message: 'هذه العمولة مسددة بالفعل' };
      if (!(com.Amount > 0)) return { success: false, message: 'مبلغ العمولة غير صالح' };
      if (Math.abs(data.Amount - com.Amount) > 0.005) {
        return {
          success: false,
          message: `مبلغ السند يجب أن يساوي مبلغ العمولة (${com.Amount.toFixed(2)}) لإقفالها كاملة`,
        };
      }
      data = { ...data, ReferenceType: 'commission', ReferenceID: com.CommissionID };
    }

    let rentResult: any = null;
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
          PartyType, PartyID, PartyName, Description, CashAccountID, PaymentMethodID,
          ReferenceType, ReferenceID, UserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voucherNumber, data.VoucherType, data.fiscalYearId, dateStr, data.Amount,
        data.PartyType ?? null, data.PartyID ?? null, data.PartyName ?? null,
        data.Description, data.CashAccountID ?? null, data.PaymentMethodID ?? null,
        data.RentPaymentID ? 'rent' : (data.ReferenceType ?? null),
        data.RentPaymentID ? data.RentPaymentID : (data.ReferenceID ?? null), data.userId
      );

      // The money lands in exactly ONE place.
      //
      // These used to be a cash update with a NESTED wallet update, so a
      // voucher naming both a cash box and a machine moved the amount TWICE.
      // Measured: a 300 receipt from a customer credited the safe 300 AND the
      // wallet 300, so the shop booked 600 against a single 300 payment and
      // invented cash out of nothing. A payment voucher destroyed it the same
      // way. The UI offers both fields, so this needed no unusual input.
      //
      // `maintenance:deliver` already carries the identical fix; this is the
      // same defect in the voucher path.
      const sign = data.VoucherType === 'receipt' ? 1 : -1;
      if (data.PaymentMethodID) {
        db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?')
          .run(sign * data.Amount, data.PaymentMethodID);
      } else if (data.CashAccountID) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
          .run(sign * data.Amount, data.CashAccountID);
      }

      // Settle the linked instalment.
      //
      // `skipCashMove` because the voucher has ALREADY moved the money a few
      // lines above. Letting the settle helper move it again would take the
      // amount twice for one payment — exactly the class of defect this whole
      // section was rebuilt to remove.
      //
      // The voucher carries `ReferenceType = 'rent'` so every report can tell
      // "a voucher that settled rent" apart from "a general expense". The P&L
      // and both statements used to count the linked voucher AND the
      // `rent_payments` row it created — the same cash leaving twice on one
      // page. MEASURED: a 1,500 rent voucher charged 3,000 to profit and -2,400
      // on the drawer's own statement, and the balance sheet disagreed by the
      // double-counted 1,500.
      if (data.RentPaymentID) {
        rentResult = applyToInstalment({
          db,
          rentPaymentId: data.RentPaymentID,
          amount: data.Amount,
          txnDate: dateStr,
          cashAccountId: data.CashAccountID ?? null,
          paymentMethodId: data.PaymentMethodID ?? null,
          sourceType: 'voucher',
          sourceId: Number(result.lastInsertRowid),
          userId: data.userId,
          fiscalYearId: data.fiscalYearId,
          notes: data.Description ?? null,
          skipCashMove: true,
        });
        // Abandon the whole voucher if the instalment refused it, so a voucher
        // can never exist claiming to have paid a month that it did not.
        if (!rentResult.success) throw new Error('RENT_REJECTED');
      }

      // Close the linked commission.
      //
      // Marked paid by THIS voucher (PaidVoucherID) so the P&L stops counting
      // it as an accrued liability and books the expense from the document
      // that actually paid it; `delete:voucher` reopens it the same way.
      if (data.CommissionID) {
        db.prepare('UPDATE commissions SET IsPaid = 1, PaidAmount = ?, PaidVoucherID = ?, PaidDate = ? WHERE CommissionID = ?')
          .run(data.Amount, Number(result.lastInsertRowid), dateStr, data.CommissionID);
      }

      // Update party balance
      if (data.PartyType === 'customer' && data.PartyID) {
        if (data.VoucherType === 'receipt') {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(data.Amount, data.PartyID);
        }
      } else if (data.PartyType === 'supplier' && data.PartyID) {
        if (data.VoucherType === 'payment') {
          db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?').run(data.Amount, data.PartyID);
        }
      } else if (data.PartyType === 'employee' && data.PartyID) {
        if (data.VoucherType === 'payment') {
          db.prepare('UPDATE employees SET Balance = Balance - ? WHERE EmployeeID = ?').run(data.Amount, data.PartyID);
        } else {
          db.prepare('UPDATE employees SET Balance = Balance + ? WHERE EmployeeID = ?').run(data.Amount, data.PartyID);
        }
      }
    });

    try {
      tx();
    } catch (err: any) {
      // A rejected instalment rolls the voucher back with it. Report the
      // instalment's own reason — "the amount exceeds what the month owes" is
      // useful; an opaque failure is not.
      if (err?.message === 'RENT_REJECTED') {
        return rentResult ?? { success: false, message: 'تعذّر ربط السند بالقسط' };
      }
      throw err;
    }
    return {
      success: true,
      voucherNumber,
      ...(rentResult ? { rentRemaining: rentResult.remaining, rentStatus: rentResult.status } : {}),
    };
  });
}
