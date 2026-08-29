import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { safeFailure } from '../security/errorResponse';
import { nextDocNumber } from '../database/docNumber';
import { resolveDocDate } from '../../shared/businessDate';
import { checkAmounts } from '../../shared/money';
import { oneOf, requireText, optionalText, optionalId, LIMITS } from '../../shared/validate';

/**
 * The service kinds and providers the screen offers.
 *
 * Copied from `serviceTypes` / `providers` in ServicesPage.tsx, which is the
 * only caller. MEASURED before the allow-list: `ServiceType: 'ALIEN'` was
 * accepted and stored, and the list screen renders the type through
 * `typeLabels[type] || type` — so the raw string is printed to the user, and
 * the customer statement shows it as the transaction description
 * (`COALESCE(ss.ServiceType, 'خدمة')` in statement.handlers.ts:394).
 */
const SERVICE_TYPES = [
  'balance_transfer', 'bill_payment', 'topup', 'electronic_payment', 'other',
] as const;
const SERVICE_PROVIDERS = [
  'vodafone', 'orange', 'etisalat', 'instapay', 'fawry', 'other',
] as const;

/**
 * The customer's payment is received into ONE asset while the transfer is
 * funded from possibly ANOTHER: a shop collecting cash at the counter funds
 * its transfers from its InstaPay wallet. Before these columns the two could
 * not differ — one dropdown was both the till that received the cash and the
 * wallet the money left, and the ledger stopped agreeing with the drawers.
 * NULL on a stored row means a pre-edit row, whose payment landed in the
 * funding asset.
 */
const RECEIVE_TYPES = ['cash_account', 'payment_method'] as const;

/** The money legs of a service operation, shared by create / update / return. */
interface ServiceLegs {
  CustomerID: number | null;
  PaidAmount: number;
  RemainingAmount: number;
  Amount: number;
  ServiceCost: number;
  TransferCost: number;
  ReceiveAccountType: string | null;
  ReceiveAccountID: number | null;
  CashAccountID: number | null;
  PaymentMethodID: number | null;
}

/**
 * Resolve the asset the customer's payment landed in (or refunds leave from).
 * New rows: `ReceiveAccountType/ID`. Pre-edit rows (`NULL`): the funding
 * asset, mirroring the historical behaviour where one account did both.
 */
function receiveAssetOf(c: ServiceLegs): { kind: 'cash_account' | 'payment_method'; id: number } {
  if (c.ReceiveAccountType === 'cash_account' || c.ReceiveAccountType === 'payment_method') {
    return { kind: c.ReceiveAccountType, id: c.ReceiveAccountID as number };
  }
  if (c.PaymentMethodID) return { kind: 'payment_method', id: c.PaymentMethodID };
  return { kind: 'cash_account', id: c.CashAccountID as number };
}

/** The asset the principal and fees leave from (the funding source). */
function fundAssetOf(c: ServiceLegs): { kind: 'cash_account' | 'payment_method'; id: number } {
  if (c.PaymentMethodID) return { kind: 'payment_method', id: c.PaymentMethodID };
  return { kind: 'cash_account', id: c.CashAccountID as number };
}

function applyLegs(db: any, c: ServiceLegs) {
  if (c.CustomerID && c.RemainingAmount > 0) {
    db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(c.RemainingAmount, c.CustomerID);
  } else if (c.CustomerID && c.RemainingAmount < 0) {
    db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(c.RemainingAmount), c.CustomerID);
  }

  if (c.PaidAmount > 0) {
    const recv = receiveAssetOf(c);
    if (recv.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(c.PaidAmount, recv.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(c.PaidAmount, recv.id);
    }
  }

  if (c.Amount > 0) {
    const fund = fundAssetOf(c);
    if (fund.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(c.Amount, fund.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(c.Amount, fund.id);
    }
  }

  const fees = c.ServiceCost + c.TransferCost;
  if (fees > 0) {
    const fund = fundAssetOf(c);
    if (fund.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(fees, fund.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(fees, fund.id);
    }
  }
}

/** Exact mirror of `applyLegs`, for deletion and return. */
function reverseLegs(db: any, c: ServiceLegs) {
  if (c.CustomerID && c.RemainingAmount > 0) {
    db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(c.RemainingAmount, c.CustomerID);
  } else if (c.CustomerID && c.RemainingAmount < 0) {
    db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(c.RemainingAmount), c.CustomerID);
  }

  if (c.PaidAmount > 0) {
    const recv = receiveAssetOf(c);
    if (recv.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(c.PaidAmount, recv.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(c.PaidAmount, recv.id);
    }
  }

  if (c.Amount > 0) {
    const fund = fundAssetOf(c);
    if (fund.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(c.Amount, fund.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(c.Amount, fund.id);
    }
  }

  const fees = c.ServiceCost + c.TransferCost;
  if (fees > 0) {
    const fund = fundAssetOf(c);
    if (fund.kind === 'cash_account') {
      db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(fees, fund.id);
    } else {
      db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(fees, fund.id);
    }
  }
}

export function registerServicesHandlers() {

  // List service sales
  ipcMain.handle('serviceSales:list', async (_event, filters?: { fromDate?: string; toDate?: string; customerId?: number }) => {
    const db = getDb();
    let query = `
      SELECT ss.*, COALESCE(c.Name, ss.CustomerName) as CustomerName, u.Username
      FROM service_sales ss
      LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
      JOIN users u ON ss.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.fromDate) { query += ' AND ss.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND ss.Date <= ?'; params.push(filters.toDate); }
    if (filters?.customerId) { query += ' AND ss.CustomerID = ?'; params.push(filters.customerId); }
    query += ' ORDER BY ss.Date DESC, ss.ServiceSaleID DESC';
    return db.prepare(query).all(...params);
  });

  // List service returns
  ipcMain.handle('serviceReturns:list', async (_event, filters?: { fromDate?: string; toDate?: string; customerId?: number }) => {

    const db = getDb();
    let query = `
      SELECT r.*, ss.ServiceNumber, COALESCE(c.Name, r.CustomerName) as CustomerName, u.Username
      FROM service_returns r
      JOIN service_sales ss ON r.ServiceSaleID = ss.ServiceSaleID
      LEFT JOIN customers c ON r.CustomerID = c.CustomerID
      JOIN users u ON r.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.fromDate) { query += ' AND r.Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { query += ' AND r.Date <= ?'; params.push(filters.toDate); }
    if (filters?.customerId) { query += ' AND r.CustomerID = ?'; params.push(filters.customerId); }
    query += ' ORDER BY r.Date DESC, r.ReturnID DESC';
    return db.prepare(query).all(...params);
  });

  function prepService(data: any):
    | { ok: false; message: string }
    | {
        ok: true;
        CustomerID: number | null;
        CustomerName: string | null;
        CustomerPhone: string | null;
        ServiceType: string;
        Provider: string;
        TargetPhone: string;
        Amount: number;
        Commission: number;   // = ServiceCost (unified provider fee)
        TransferCost: number;
        ChargeAmount: number;
        PaidAmount: number;
        RemainingAmount: number;
        Status: string;
        Profit: number;
        PaymentMethod: string;
        ReceiveAccountType: string | null;
        ReceiveAccountID: number | null;
        CashAccountID: number | null;
        PaymentMethodID: number | null;
        Notes: string | null;
      } {
    const db = getDb();
    // النموذج المبسّط: حقلان ماليتان فقط.
    //   PaidToProvider = المدفوع للمزوّد (كل ما يُدفع ويخرج من أصل التمويل)
    //   ChargeAmount   = المحصَّل من العميل (ما يُضاف إلى أصل الاستلام)
    // الربح مشتق آلياً ولا يذكره المستخدم أبداً: Profit = ChargeAmount - PaidToProvider.
    const paidTo = Number(data.PaidToProvider) || 0;
    const charge = Number(data.ChargeAmount) || 0;
    const paid = Number(data.PaidAmount) || 0;

    if (paidTo <= 0) {
      return { ok: false, message: 'أدخل المبلغ المدفوع للمزوّد' };
    }
    if (charge <= 0) {
      return { ok: false, message: 'أدخل المبلغ المحصَّل من العميل' };
    }
    if (paid > charge) {
      return { ok: false, message: 'المدفوع من العميل لا يتجاوز المحصَّل' };
    }
    if (paid > 0 && !data.ReceiveAccountType) {
      return { ok: false, message: 'اختر مصدر استلام المبلغ من العميل (خزنة أو ماكينة)' };
    }

    // كل المدفوع للمزوّد يُسجَّل كأصل العملية؛ العمولة ورسوم التحويل منعدمة.
    const amount = paidTo;
    const commission = 0;
    const transferCost = 0;
    const remaining = charge - paid;
    const profit = charge - amount;

    // إعداد Validate (نفس المخطط القديم)
    const badMoney = checkAmounts([
      [amount, 'المبلغ المحوَّل'],
      [charge, 'المبلغ المحصَّل'],
      [paid, 'المدفوع'],
      [commission, 'عمولة المزوّد'],
      [transferCost, 'رسوم التحويل'],
    ]);
    if (badMoney) return { ok: false, message: badMoney };

    const sType = oneOf(data.ServiceType, 'نوع الخدمة', SERVICE_TYPES);
    if (!sType.ok) return { ok: false, message: sType.message };
    const sProvider = oneOf(data.Provider || 'other', 'المزوّد', SERVICE_PROVIDERS);
    if (!sProvider.ok) return { ok: false, message: sProvider.message };

    const sPay = oneOf(data.PaymentMethod || 'cash', 'طريقة الدفع', ['cash', 'credit']);
    if (!sPay.ok) return { ok: false, message: sPay.message };

    const target = requireText(data.TargetPhone, 'رقم الوجهة', LIMITS.PHONE);
    if (!target.ok) return { ok: false, message: target.message };

    const sNotes = optionalText(data.Notes, 'ملاحظات', LIMITS.NOTES);
    if (!sNotes.ok) return { ok: false, message: sNotes.message };
    const sCustName = optionalText(data.CustomerName, 'اسم العميل', LIMITS.NAME);
    if (!sCustName.ok) return { ok: false, message: sCustName.message };
    const sCustPhone = optionalText(data.CustomerPhone, 'هاتف العميل', LIMITS.PHONE);
    if (!sCustPhone.ok) return { ok: false, message: sCustPhone.message };

    const sCustId = optionalId(data.CustomerID, 'العميل');
    if (!sCustId.ok) return { ok: false, message: sCustId.message };
    if (sCustId.value !== null) {
      const exists = db.prepare('SELECT 1 AS ok FROM customers WHERE CustomerID = ?').get(sCustId.value);
      if (!exists) return { ok: false, message: 'العميل غير موجود' };
    }

    if (!sCustId.value && remaining !== 0) {
      return { ok: false, message: 'العميل النقدي يدفع كامل المبلغ فوراً — المدفوع من العميل يجب أن يساوي المحصَّل' };
    }

    let receiveType: string | null = null;
    let receiveId: number | null = null;
    if (paid > 0) {
      if (!data.ReceiveAccountType || !data.ReceiveAccountID) {
        return { ok: false, message: 'اختر مصدر استلام المبلغ من العميل (خزنة أو ماكينة)' };
      }
      const sRecvType = oneOf(data.ReceiveAccountType, 'مصدر الاستلام', RECEIVE_TYPES);
      if (!sRecvType.ok) return { ok: false, message: sRecvType.message };
      if (sRecvType.value === 'cash_account') {
        const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.ReceiveAccountID) as any;
        if (!acc) return { ok: false, message: 'الخزنة المستلمة غير موجودة' };
        if (!acc.IsActive) return { ok: false, message: 'الخزنة المستلمة غير مفعّلة' };
      } else {
        const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(data.ReceiveAccountID) as any;
        if (!pm) return { ok: false, message: 'الماكينة المستلمة غير موجودة' };
        if (!pm.IsActive) return { ok: false, message: 'الماكينة المستلمة غير مفعّلة' };
      }
      receiveType = sRecvType.value;
      receiveId = data.ReceiveAccountID;
    }

    if (amount + commission + transferCost > 0 && !data.CashAccountID && !data.PaymentMethodID) {
      return { ok: false, message: 'اختر أصل تحويل الرصيد (الخزنة أو الماكينة التي يُدفع منها المزوّد)' };
    }

    return {
      ok: true,
      CustomerID: sCustId.value,
      CustomerName: sCustName.value ?? null,
      CustomerPhone: sCustPhone.value ?? null,
      ServiceType: sType.value,
      Provider: sProvider.value,
      TargetPhone: target.value,
      Amount: amount,
      Commission: commission,
      TransferCost: transferCost,
      ChargeAmount: charge,
      PaidAmount: paid,
      RemainingAmount: remaining,
      Status: remaining > 0 ? (paid > 0 ? 'partial' : 'unpaid') : 'completed',
      Profit: profit,
      PaymentMethod: sPay.value,
      ReceiveAccountType: receiveType,
      ReceiveAccountID: receiveId,
      CashAccountID: data.CashAccountID ? Number(data.CashAccountID) : null,
      PaymentMethodID: data.PaymentMethodID ? Number(data.PaymentMethodID) : null,
      Notes: sNotes.value ?? null,
    };
  }

  // The balances a funding source needs, and the friendly message when it
  // lacks them. Runs before AND inside the transaction (a rival till can
  // drain the source between the two reads).
  const guardFunds = (db: any, c: { Amount: number; Commission: number; TransferCost: number; PaidAmount: number; ReceiveAccountType: string | null; ReceiveAccountID: number | null; CashAccountID: number | null; PaymentMethodID: number | null }): string | null => {
    const totalOutflow = c.Amount + c.Commission + c.TransferCost;
    // Money landing INTO the same drawer offsets what it pays out — but only
    // when it is the SAME drawer. With separate receive/fund assets the
    // collection goes to another till and every pound still leaves this one.
    const landsInDrawer = c.PaidAmount > 0
      && ((c.ReceiveAccountType === 'cash_account' && c.ReceiveAccountID === c.CashAccountID)
          || (c.ReceiveAccountType === null && !c.PaymentMethodID && c.CashAccountID !== null));
    if (c.PaymentMethodID) {
      const pm = db.prepare('SELECT Balance, IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(c.PaymentMethodID);
      // A ghost machine used to answer "الرصيد غير كافٍ ... 0.00" — a typo'd
      // id read as a broke machine.
      if (!pm) return 'ماكينة الدفع المختارة غير موجودة';
      if (!pm.IsActive) return 'ماكينة الدفع المختارة غير مفعّلة';
      // The DB trigger makes a negative wallet impossible, so the check runs
      // no matter what `allow_negative_cash` says — that setting relaxes the
      // guard for the cash drawer only.
      if ((pm.Balance || 0) < totalOutflow) {
        return `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm.Balance || 0).toFixed(2)}، المطلوب ${totalOutflow.toFixed(2)}`;
      }
    } else if (c.CashAccountID) {
      const acc = db.prepare('SELECT Balance, IsActive FROM cash_accounts WHERE CashAccountID = ?').get(c.CashAccountID);
      if (!acc) return 'الخزنة المختارة غير موجودة';
      if (!acc.IsActive) return 'الخزنة المختارة غير مفعّلة';
      // What actually leaves the drawer: the principal AND the fees, minus
      // what lands straight back. The old figure checked fees alone, so a
      // drawer-funded transfer of 1,000,000 with no costs and no payment
      // sailed through a check that demanded nothing of it and drained the
      // drawer a million — the guard watched the fee, not the transfer.
      const netNeeded = totalOutflow - (landsInDrawer ? c.PaidAmount : 0);
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get();
      if (allowNegCash?.Value !== '1' && netNeeded > 0 && (acc.Balance || 0) < netNeeded) {
        return `الرصيد غير كافٍ في الخزينة: المتاح ${(acc.Balance || 0).toFixed(2)}، المطلوب ${netNeeded.toFixed(2)}`;
      }
    }
    return null;
  };

  /** The fiscal year that owns a date — or a refusal if none / closed. */
  const yearForDate = (db: any, dateStr: string): { ok: true; fy: any } | { ok: false; message: string } => {
    const fy = db.prepare('SELECT * FROM fiscal_years WHERE StartDate <= ? AND EndDate >= ?').get(dateStr, dateStr);
    if (!fy) return { ok: false, message: 'لا توجد سنة مالية تغطي هذا التاريخ' };
    if (fy.Status === 'closed') return { ok: false, message: 'السنة المالية لهذا التاريخ مغلقة — افتحها أو عدّل التاريخ' };
    return { ok: true, fy };
  };

  // Create service sale (balance transfer, bill payment, top-up, etc.)
  ipcMain.handle('serviceSales:create', async (_event, data: {
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    ServiceType: string;
    ServiceTypeLabel?: string; // custom label for "other" type
    Provider: string;
    ProviderLabel?: string; // custom label for "other" provider
    TargetPhone: string;
    PaidToProvider: number; // the total paid to the provider = Amount + any fee
    ChargeAmount: number;
    PaymentMethod: string;
    PaidAmount: number;
    CashAccountID?: number;
    PaymentMethodID?: number;
    ReceiveAccountType?: 'cash_account' | 'payment_method';
    ReceiveAccountID?: number;
    Notes?: string;
    Date?: string;
    userId: number; fiscalYearId: number;
  }) => {

    const db = getDb();

    const prep = prepService(data);
    if (!prep.ok) return { success: false, message: prep.message };

    try {
      const dateStr = resolveDocDate(data as any);
      if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
      const serviceNumber = nextDocNumber(db, 'service_sales', 'ServiceNumber', 'SRV', dateStr);

      const firstGuard = guardFunds(db, prep);
      if (firstGuard) return { success: false, message: firstGuard };

      const tx = db.transaction(() => {
        // Re-guard INSIDE the transaction: the pre-check above is a snapshot,
        // and a rival till can drain the funding source between it and this
        // write (measured: the wallet trigger then aborted with a generic
        // support-ref instead of the till's friendly message). Reading the
        // balance again here — in the same transaction as the writes — closes
        // the gap. Throwing aborts the whole transaction cleanly.
        const reGuard = guardFunds(db, prep);
        if (reGuard) throw Object.assign(new Error(reGuard), { isDeliberateGuard: true });

        db.prepare(`
          INSERT INTO service_sales (
            ServiceNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
            ServiceType, Provider, TargetPhone, Amount, ServiceCost, ChargeAmount,
            PaidAmount, RemainingAmount, Profit, PaymentMethod, CashAccountID, PaymentMethodID,
            TransferCost, ReceiveAccountType, ReceiveAccountID, Status, Notes, UserID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          serviceNumber, data.fiscalYearId, dateStr,
          prep.CustomerID, prep.CustomerName, prep.CustomerPhone,
          prep.ServiceType, prep.Provider, prep.TargetPhone,
          prep.Amount, prep.Commission, prep.ChargeAmount,
          prep.PaidAmount, prep.RemainingAmount, prep.Profit,
          prep.PaymentMethod, prep.CashAccountID, prep.PaymentMethodID,
          prep.TransferCost, prep.ReceiveAccountType, prep.ReceiveAccountID,
          prep.Status, prep.Notes, data.userId
        );

        applyLegs(db, {
          CustomerID: prep.CustomerID,
          PaidAmount: prep.PaidAmount,
          RemainingAmount: prep.RemainingAmount,
          Amount: prep.Amount,
          ServiceCost: prep.Commission,
          TransferCost: prep.TransferCost,
          ReceiveAccountType: prep.ReceiveAccountType,
          ReceiveAccountID: prep.ReceiveAccountID,
          CashAccountID: prep.CashAccountID,
          PaymentMethodID: prep.PaymentMethodID,
        });
      });

      tx();
      return { success: true, serviceNumber, profit: prep.Profit, remaining: prep.RemainingAmount, status: prep.Status };
    } catch (err: any) {
      if (err?.isDeliberateGuard) return { success: false, message: err.message };
      console.error('[ServiceSales] Error:', err);
      return safeFailure('serviceSales:create', err);
    }
  });

  // Edit a service sale — reverse the old legs, apply the new ones, keep the
  // document number. The original date stands unless a new one is declared.
  ipcMain.handle('serviceSales:update', async (_event, data: {
    id: number;
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    ServiceType: string; Provider: string; TargetPhone: string;
    PaidToProvider: number; ChargeAmount: number; PaymentMethod: string; PaidAmount: number;
    CashAccountID?: number; PaymentMethodID?: number;
    ReceiveAccountType?: 'cash_account' | 'payment_method'; ReceiveAccountID?: number;
    Notes?: string; Date?: string;
  }) => {

    const db = getDb();

    const prep = prepService(data);
    if (!prep.ok) return { success: false, message: prep.message };

    const sale = db.prepare('SELECT * FROM service_sales WHERE ServiceSaleID = ?').get(data.id) as any;
    if (!sale) return { success: false, message: 'العملية غير موجودة' };
    if (sale.Status === 'returned') return { success: false, message: 'لا يمكن تعديل عملية مرتجعة' };

    try {
      const dateStr = resolveDocDate(data as any) ?? sale.Date;
      if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
      if (dateStr !== sale.Date) {
        const yr = yearForDate(db, dateStr);
        if (!yr.ok) return { success: false, message: yr.message };
      }

      const firstGuard = guardFunds(db, prep);
      if (firstGuard) return { success: false, message: firstGuard };

      const tx = db.transaction(() => {
        const reGuard = guardFunds(db, prep);
        if (reGuard) throw Object.assign(new Error(reGuard), { isDeliberateGuard: true });

        reverseLegs(db, {
          CustomerID: sale.CustomerID,
          PaidAmount: sale.PaidAmount || 0,
          RemainingAmount: sale.RemainingAmount || 0,
          Amount: sale.Amount || 0,
          ServiceCost: sale.ServiceCost || 0,
          TransferCost: sale.TransferCost || 0,
          ReceiveAccountType: sale.ReceiveAccountType,
          ReceiveAccountID: sale.ReceiveAccountID,
          CashAccountID: sale.CashAccountID,
          PaymentMethodID: sale.PaymentMethodID,
        });

        if (dateStr !== sale.Date) {
          const yr = yearForDate(db, dateStr);
          if (!yr.ok) throw Object.assign(new Error(yr.message), { isDeliberateGuard: true });
        }

        db.prepare(`
          UPDATE service_sales SET
            Date = ?, FiscalYearID = ?, CustomerID = ?, CustomerName = ?, CustomerPhone = ?,
            ServiceType = ?, Provider = ?, TargetPhone = ?, Amount = ?, ServiceCost = ?,
            ChargeAmount = ?, PaidAmount = ?, RemainingAmount = ?, Profit = ?,
            PaymentMethod = ?, CashAccountID = ?, PaymentMethodID = ?, TransferCost = ?,
            ReceiveAccountType = ?, ReceiveAccountID = ?, Status = ?, Notes = ?
          WHERE ServiceSaleID = ?
        `).run(
          dateStr, dateStr !== sale.Date ? (yearForDate(db, dateStr) as any).fy.FiscalYearID : sale.FiscalYearID,
          prep.CustomerID, prep.CustomerName, prep.CustomerPhone,
          prep.ServiceType, prep.Provider, prep.TargetPhone,
          prep.Amount, prep.Commission, prep.ChargeAmount,
          prep.PaidAmount, prep.RemainingAmount, prep.Profit,
          prep.PaymentMethod, prep.CashAccountID, prep.PaymentMethodID, prep.TransferCost,
          prep.ReceiveAccountType, prep.ReceiveAccountID, prep.Status, prep.Notes,
          sale.ServiceSaleID
        );

        applyLegs(db, {
          CustomerID: prep.CustomerID,
          PaidAmount: prep.PaidAmount,
          RemainingAmount: prep.RemainingAmount,
          Amount: prep.Amount,
          ServiceCost: prep.Commission,
          TransferCost: prep.TransferCost,
          ReceiveAccountType: prep.ReceiveAccountType,
          ReceiveAccountID: prep.ReceiveAccountID,
          CashAccountID: prep.CashAccountID,
          PaymentMethodID: prep.PaymentMethodID,
        });
      });

      tx();
      return { success: true, profit: prep.Profit, remaining: prep.RemainingAmount, status: prep.Status };
    } catch (err: any) {
      if (err?.isDeliberateGuard) return { success: false, message: err.message };
      console.error('[ServiceSales] Update error:', err);
      return safeFailure('serviceSales:update', err);
    }
  });

  // Return a service sale — the operation failed and is reversed in full:
  // the customer gets his money back, the provider refunds principal and fee
  // into the funding source, and any unpaid remainder is cancelled. The
  // original row stays (Status='returned') so the ledger shows both sides.
  ipcMain.handle('serviceSales:return', async (_event, data: { id: number; Reason?: string; Date?: string; userId: number; fiscalYearId: number }) => {

    const db = getDb();

    const sale = db.prepare('SELECT * FROM service_sales WHERE ServiceSaleID = ?').get(data.id) as any;
    if (!sale) return { success: false, message: 'العملية غير موجودة' };
    if (sale.Status === 'returned') return { success: false, message: 'العملية مرتجعة بالفعل' };

    const sReason = optionalText(data.Reason, 'سبب الإرجاع', LIMITS.NOTES);
    if (!sReason.ok) return { success: false, message: sReason.message };

    try {
      const dateStr = resolveDocDate(data as any) ?? sale.Date;
      if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
      const yr = yearForDate(db, dateStr);
      if (!yr.ok) return { success: false, message: yr.message };

      // The customer's money leaves the RECEIVING asset. A refund that would
      // overdraw a drawer or a machine must be refused with a friendly line,
      // not a DB trigger abort.
      const legs = {
        CustomerID: sale.CustomerID,
        PaidAmount: sale.PaidAmount || 0,
        RemainingAmount: sale.RemainingAmount || 0,
        Amount: sale.Amount || 0,
        ServiceCost: sale.ServiceCost || 0,
        TransferCost: sale.TransferCost || 0,
        ReceiveAccountType: sale.ReceiveAccountType,
        ReceiveAccountID: sale.ReceiveAccountID,
        CashAccountID: sale.CashAccountID,
        PaymentMethodID: sale.PaymentMethodID,
      } as const;
      const recv = receiveAssetOf(legs);
      if (sale.PaidAmount > 0) {
        if (recv.kind === 'cash_account') {
          const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(recv.id) as any;
          const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
          if (allowNegCash?.Value !== '1' && (acc?.Balance || 0) < sale.PaidAmount) {
            return { success: false, message: `الرصيد غير كافٍ في الخزنة لرد المبلغ: المتاح ${(acc?.Balance || 0).toFixed(2)}` };
          }
        } else {
          const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(recv.id) as any;
          if ((pm?.Balance || 0) < sale.PaidAmount) {
            return { success: false, message: `الرصيد غير كافٍ في الماكينة لرد المبلغ: المتاح ${(pm?.Balance || 0).toFixed(2)}` };
          }
        }
      }

      const returnNumber = nextDocNumber(db, 'service_returns', 'ReturnNumber', 'SR', dateStr);

      const tx = db.transaction(() => {
        reverseLegs(db, legs);

        db.prepare(`
          INSERT INTO service_returns (
            ReturnNumber, ServiceSaleID, FiscalYearID, Date, CustomerID, CustomerName,
            CustomerPhone, ServiceType, Provider, TargetPhone, Amount, ServiceCost,
            TransferCost, ChargeAmount, PaidAmount, RemainingAmount,
            RefundAccountType, RefundAccountID, CashAccountID, PaymentMethodID,
            Reason, UserID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          returnNumber, sale.ServiceSaleID, yr.fy.FiscalYearID, dateStr,
          sale.CustomerID, sale.CustomerName, sale.CustomerPhone,
          sale.ServiceType, sale.Provider, sale.TargetPhone,
          sale.Amount || 0, sale.ServiceCost || 0, sale.TransferCost || 0,
          sale.ChargeAmount || 0, sale.PaidAmount || 0, sale.RemainingAmount || 0,
          recv.kind, recv.id, sale.CashAccountID, sale.PaymentMethodID,
          sReason.value ?? null, data.userId
        );

        db.prepare("UPDATE service_sales SET Status = 'returned' WHERE ServiceSaleID = ?").run(sale.ServiceSaleID);
      });

      tx();
      return { success: true, returnNumber, message: `تم إرجاع العملية ${sale.ServiceNumber}` };
    } catch (err: any) {
      console.error('[ServiceSales] Return error:', err);
      return safeFailure('serviceSales:return', err);
    }
  });

  // Get service sale details
  ipcMain.handle('serviceSales:get', async (_event, id: number) => {

    const db = getDb();
    // `ss.*` already carries the stored CustomerName — a second `c.Name as
    // CustomerName` alias would OVERWRITE it with NULL for a service recorded
    // against a name without a customer id (LEFT JOIN misses → c.Name is
    // NULL). The name vanished the moment the row was read back.
    return db.prepare(`
      SELECT ss.*,
        COALESCE(c.Name, ss.CustomerName) as CustomerName,
        COALESCE(c.Phone, ss.CustomerPhone) as CustomerPhone,
        c.Balance as CustomerBalance
      FROM service_sales ss
      LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
      WHERE ss.ServiceSaleID = ?
    `).get(id);
  });
}