import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { safeFailure } from '../security/errorResponse';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';
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

  // Create service sale (balance transfer, bill payment, top-up, etc.)
  ipcMain.handle('serviceSales:create', async (_event, data: {
    CustomerID?: number; CustomerName?: string; CustomerPhone?: string;
    ServiceType: string;
    ServiceTypeLabel?: string; // custom label for "other" type
    Provider: string;
    ProviderLabel?: string; // custom label for "other" provider
    TargetPhone: string;
    Amount: number;
    ServiceCost: number;
    ChargeAmount: number;
    PaymentMethod: string;
    PaidAmount: number;
    CashAccountID?: number;
    PaymentMethodID?: number;
    TransferCost?: number;
    Notes?: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    // Negative figures were accepted and stored. The cash box happened not to
    // move (the two sides cancelled), so nothing looked wrong — but the row
    // was saved with Amount -5000 / Charge -4900 and reported a phantom
    // profit of 100 in the income statement. A refund is a deletion, never a
    // negative sale.
    const badMoney = checkAmounts([
      [data.Amount, 'المبلغ المحوَّل'],
      [data.ChargeAmount, 'المبلغ المحصَّل'],
      [data.PaidAmount, 'المدفوع'],
      [data.ServiceCost ?? 0, 'تكلفة الخدمة'],
      [data.TransferCost ?? 0, 'رسوم التحويل'],
    ]);
    if (badMoney) return { success: false, message: badMoney };

    const sType = oneOf(data.ServiceType, 'نوع الخدمة', SERVICE_TYPES);
    if (!sType.ok) return { success: false, message: sType.message };
    const sProvider = oneOf(data.Provider || 'other', 'المزوّد', SERVICE_PROVIDERS);
    if (!sProvider.ok) return { success: false, message: sProvider.message };

    // The payment method is allow-listed, not stored raw. The screen sends
    // `paid > 0 ? 'cash' : 'credit'`; before the check an 'ALIEN' string was
    // accepted and stored, and it printed straight into the customer statement
    // and the service list (COALESCE only covers ServiceType).
    const sPay = oneOf(data.PaymentMethod || 'cash', 'طريقة الدفع', ['cash', 'credit']);
    if (!sPay.ok) return { success: false, message: sPay.message };

    // The destination number is what the shop is paid to send money TO. An
    // empty one was accepted and stored, leaving a transfer nobody can prove
    // was made and no way to chase it with the provider.
    const target = requireText(data.TargetPhone, 'رقم الوجهة', LIMITS.PHONE);
    if (!target.ok) return { success: false, message: target.message };

    const sNotes = optionalText(data.Notes, 'ملاحظات', LIMITS.NOTES);
    if (!sNotes.ok) return { success: false, message: sNotes.message };
    const sCustName = optionalText(data.CustomerName, 'اسم العميل', LIMITS.NAME);
    if (!sCustName.ok) return { success: false, message: sCustName.message };
    const sCustPhone = optionalText(data.CustomerPhone, 'هاتف العميل', LIMITS.PHONE);
    if (!sCustPhone.ok) return { success: false, message: sCustPhone.message };

    // A named customer must exist: the balance update below is a bare
    // `UPDATE ... WHERE CustomerID = ?`, which matches zero rows in silence
    // and leaves the unpaid remainder owed by nobody.
    const sCustId = optionalId(data.CustomerID, 'العميل');
    if (!sCustId.ok) return { success: false, message: sCustId.message };
    if (sCustId.value !== null) {
      const exists = db.prepare('SELECT 1 AS ok FROM customers WHERE CustomerID = ?').get(sCustId.value);
      if (!exists) return { success: false, message: 'العميل غير موجود' };
    }

    data = {
      ...data,
      ServiceType: sType.value,
      Provider: sProvider.value,
      TargetPhone: target.value,
      Notes: sNotes.value ?? undefined,
      CustomerName: sCustName.value ?? undefined,
      CustomerPhone: sCustPhone.value ?? undefined,
      CustomerID: sCustId.value ?? undefined,
      PaymentMethod: sPay.value,
    };

    try {
      const dateStr = businessToday();
      const serviceNumber = nextDocNumber(db, 'service_sales', 'ServiceNumber', 'SRV', dateStr);

      const remaining = data.ChargeAmount - data.PaidAmount;
      const status = remaining > 0 ? (data.PaidAmount > 0 ? 'partial' : 'unpaid') : 'completed';
      const profit = data.ChargeAmount - data.ServiceCost - data.Amount - (data.TransferCost || 0);

      // The customer's cash must land in a real chosen source. Before this
      // check a 500 payment with no drawer and no machine was booked onto the
      // row (PaidAmount = 500), moved nobody's balance, and left the statement
      // showing money that never appeared anywhere. The screen itself refuses
      // to submit when paid > 0 and neither is chosen.
      if ((data.PaidAmount || 0) > 0 && !data.CashAccountID && !data.PaymentMethodID) {
        return { success: false, message: 'اختر مصدر استلام المبلغ (خزنة أو ماكينة)' };
      }

      // Check sufficient balance in payment method for service cost (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      // Total leaving the funding source = principal + provider fee + transfer fee.
      // Checking only the principal let an operation overdraw by the fees.
      const totalOutflow = (data.Amount || 0) + (data.ServiceCost || 0) + (data.TransferCost || 0);
      // A friendlier "you don't have this" than the DB trigger's generic abort.
      // The trigger itself cannot be disabled, so this guard can only improve
      // the MESSAGE — a ghost source answers as missing, a dead one as
      // deactivated, a poor one with its numbers.
      const guardFunds = (): string | null => {
        if (data.PaymentMethodID) {
          const pm = db.prepare('SELECT Balance, IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
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
        } else if (data.CashAccountID) {
          const acc = db.prepare('SELECT Balance, IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
          if (!acc) return 'الخزنة المختارة غير موجودة';
          if (!acc.IsActive) return 'الخزنة المختارة غير مفعّلة';
          // What actually leaves the drawer: the principal AND the fees, minus
          // what lands straight back. The old figure checked fees alone, so a
          // drawer-funded transfer of 1,000,000 with no costs and no payment
          // sailed through a check that demanded nothing of it and drained the
          // drawer a million — the guard watched the fee, not the transfer.
          const netNeeded = totalOutflow - (data.PaidAmount || 0);
          if (allowNegCash?.Value !== '1' && netNeeded > 0 && (acc.Balance || 0) < netNeeded) {
            return `الرصيد غير كافٍ في الخزينة: المتاح ${(acc.Balance || 0).toFixed(2)}، المطلوب ${netNeeded.toFixed(2)}`;
          }
        }
        return null;
      };
      const firstGuard = guardFunds();
      if (firstGuard) return { success: false, message: firstGuard };

      const tx = db.transaction(() => {
        // Re-guard INSIDE the transaction: the pre-check above is a snapshot,
        // and a rival till can drain the funding source between it and this
        // write (measured: the wallet trigger then aborted with a generic
        // support-ref instead of the till's friendly message). Reading the
        // balance again here — in the same transaction as the writes — closes
        // the gap. Throwing aborts the whole transaction cleanly.
        const reGuard = guardFunds();
        if (reGuard) throw Object.assign(new Error(reGuard), { isDeliberateGuard: true });

        db.prepare(`
          INSERT INTO service_sales (
            ServiceNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
            ServiceType, Provider, TargetPhone, Amount, ServiceCost, ChargeAmount,
            PaidAmount, RemainingAmount, Profit, PaymentMethod, CashAccountID, PaymentMethodID,
            TransferCost, Status, Notes, UserID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          serviceNumber, data.fiscalYearId, dateStr,
          data.CustomerID ?? null, data.CustomerName ?? null, data.CustomerPhone ?? null,
          data.ServiceType, data.Provider, data.TargetPhone,
          data.Amount, data.ServiceCost, data.ChargeAmount,
          data.PaidAmount, remaining, profit,
          data.PaymentMethod, data.CashAccountID ?? null, data.PaymentMethodID ?? null,
          data.TransferCost || 0, status, data.Notes ?? null, data.userId
        );

        if (data.CustomerID && remaining > 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(remaining, data.CustomerID);
        } else if (data.CustomerID && remaining < 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(remaining), data.CustomerID);
        }

        if (data.PaidAmount > 0 && data.CashAccountID) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(data.PaidAmount, data.CashAccountID);
        } else if (data.PaidAmount > 0 && data.PaymentMethodID) {
          // No drawer chosen — the machine both funds and receives. Before
          // this branch the payment simply vanished: the row kept
          // PaidAmount but no account ever gained it.
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(data.PaidAmount, data.PaymentMethodID);
        }

        // The principal we push out to the target line.
        //
        // This only left the books when a MACHINE funded it. Funded from the
        // cash drawer, the 1,000 sent to the customer's phone was never
        // debited anywhere: the shop collected 1,020, sent 1,000, and its
        // books recorded a gain of 1,020 instead of 20. Measured on a single
        // transfer — 1,000 of value invented per operation, and a shop doing
        // twenty transfers a day would show a fortune it does not have.
        //
        // The money must leave the same place the fees leave from, and in the
        // same order of preference.
        if (data.Amount > 0) {
          if (data.PaymentMethodID) {
            db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(data.Amount, data.PaymentMethodID);
          } else if (data.CashAccountID) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.Amount, data.CashAccountID);
          }
        }

        // === REAL COST OUTFLOW ===
        // ServiceCost (what the provider charges us) and TransferCost (the
        // network/commission fee) are genuine outflows. They were recorded on
        // the service row and subtracted in the profit figure, but no account
        // was ever debited — so every service invented `ServiceCost +
        // TransferCost` of cash out of nothing and the balance sheet drifted.
        // We book them against the funding source and record a matching expense
        // voucher so the income statement and the cash movement agree.
        const realCost = (data.ServiceCost || 0) + (data.TransferCost || 0);
        if (realCost > 0) {
          if (data.PaymentMethodID) {
            db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(realCost, data.PaymentMethodID);
          } else if (data.CashAccountID) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(realCost, data.CashAccountID);
          }
        }
      });

      tx();
      return { success: true, serviceNumber, profit, remaining, status };
    } catch (err: any) {
      if (err?.isDeliberateGuard) return { success: false, message: err.message };
      console.error('[ServiceSales] Error:', err);
      return safeFailure('serviceSales:create', err);
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
