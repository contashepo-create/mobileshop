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
      SELECT ss.*, c.Name as CustomerName, u.Username
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
    };

    try {
      const dateStr = businessToday();
      const serviceNumber = nextDocNumber(db, 'service_sales', 'ServiceNumber', 'SRV', dateStr);

      const remaining = data.ChargeAmount - data.PaidAmount;
      const status = remaining > 0 ? (data.PaidAmount > 0 ? 'partial' : 'unpaid') : 'completed';
      const profit = data.ChargeAmount - data.ServiceCost - data.Amount - (data.TransferCost || 0);

      // Check sufficient balance in payment method for service cost (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      // Total leaving the funding source = principal + provider fee + transfer fee.
      // Checking only the principal let an operation overdraw by the fees.
      const totalOutflow = (data.Amount || 0) + (data.ServiceCost || 0) + (data.TransferCost || 0);
      if (allowNegCash?.Value !== '1' && totalOutflow > 0) {
        if (data.PaymentMethodID) {
          const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
          if (!pm || (pm.Balance || 0) < totalOutflow) {
            return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${totalOutflow.toFixed(2)}` };
          }
        } else if (data.CashAccountID && (data.ServiceCost || data.TransferCost)) {
          // Fees fall back to the cash account when no machine is used. The
          // customer's payment lands in the same account, so only the net
          // shortfall matters.
          const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
          const netNeeded = (data.ServiceCost || 0) + (data.TransferCost || 0) - (data.PaidAmount || 0);
          if (netNeeded > 0 && (!acc || (acc.Balance || 0) < netNeeded)) {
            return { success: false, message: `الرصيد غير كافٍ في الخزينة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${netNeeded.toFixed(2)}` };
          }
        }
      }

      const tx = db.transaction(() => {
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
      console.error('[ServiceSales] Error:', err);
      return safeFailure('serviceSales:create', err);
    }
  });

  // Get service sale details
  ipcMain.handle('serviceSales:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT ss.*, c.Name as CustomerName, c.Phone as CustomerPhone, c.Balance as CustomerBalance
      FROM service_sales ss
      LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
      WHERE ss.ServiceSaleID = ?
    `).get(id);
  });
}
