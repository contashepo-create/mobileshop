import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { safeFailure } from '../security/errorResponse';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';
import { checkAmounts } from '../../shared/money';
import { oneOf } from '../../shared/validate';

/**
 * Who bears the transfer commission.
 *
 * Read off the `<Select>` in TransfersPage.tsx: `from_amount` takes the fee
 * out of the amount the destination receives; `separate` charges it to the
 * source account on top.
 */
const TRANSFER_COST_SOURCES = ['from_amount', 'separate'] as const;

export function registerTransfersHandlers() {
  // Transfer between cash accounts / payment methods
  ipcMain.handle('transfers:create', async (_event, data: {
    FromType: string; // 'cash_account' | 'payment_method'
    FromID: number;
    ToType: string; // 'cash_account' | 'payment_method'
    ToID: number;
    Amount: number;
    TransferCost: number; // commission/fee
    TransferCostSource: string; // 'from_amount' = deduct from transferred amount, 'separate' = from source account
    Notes?: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    // Direction is expressed by which account is FROM and which is TO, never
    // by the sign of the money. A negative transfer ran the whole operation
    // backwards: measured, -5,000 from the safe to the bank ADDED 5,000 to the
    // safe and took it from the bank, with the document still reading as a
    // normal transfer in that direction.
    const badMoney = checkAmounts([
      [data.Amount, 'مبلغ التحويل', { allowZero: false }],
      [data.TransferCost ?? 0, 'رسوم التحويل'],
    ]);
    if (badMoney) return { success: false, message: badMoney };

    // The fee-bearing rule decides WHO pays the commission, and both branches
    // below test it by equality:
    //
    //   totalDeduction  = Amount + (source === 'separate' ? fee : 0)
    //   receivedAmount  = source === 'from_amount' ? Amount - fee : Amount
    //
    // so any third value falls through BOTH and the fee is charged to nobody.
    // MEASURED with `TransferCostSource: 'ALIEN'` and a fee of 50: cash out
    // 1,000, wallet in 1,000, fee borne by no account — while the saved
    // document records `TransferCost 50`. The books then claim a cost the
    // shop never paid, and the transfer report cannot be reconciled.
    const costSource = oneOf(
      data.TransferCostSource || 'separate', 'مصدر رسوم التحويل', TRANSFER_COST_SOURCES);
    if (!costSource.ok) return { success: false, message: costSource.message };
    data = { ...data, TransferCostSource: costSource.value };

    // The account type is part of the identity of a funding source. A value
    // outside the two real ones fell through to the payment-method branch on
    // both the read AND the write: `getAccountBalance` treats anything that is
    // not 'cash_account' as a machine, and the UPDATE below does the same, so
    // `FromType: 'ALIEN'` with the drawer's id actually moved MACHINE money
    // while the document claimed an alien type. The type is validated before
    // any read or write can interpret it.
    const fromType = oneOf(data.FromType, 'نوع الحساب المصدر', ['cash_account', 'payment_method'] as const);
    if (!fromType.ok) return { success: false, message: fromType.message };
    const toType = oneOf(data.ToType, 'نوع حساب الوصول', ['cash_account', 'payment_method'] as const);
    if (!toType.ok) return { success: false, message: toType.message };
    data = { ...data, FromType: fromType.value, ToType: toType.value };

    // A destination that does not exist silently swallows the money: the
    // UPDATE matched no row, the source lost the amount, and the books wrote
    // a document for a transfer that never landed anywhere. MEASURED — a
    // 5,000 transfer to ToID 99999 deducted the drawer and credited nothing.
    if (data.FromType === 'cash_account') {
      const src = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.FromID) as any;
      if (!src) return { success: false, message: 'الحساب المصدر غير موجود' };
    } else {
      const src = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.FromID) as any;
      if (!src) return { success: false, message: 'الحساب المصدر غير موجود' };
    }
    if (data.ToType === 'cash_account') {
      const dst = db.prepare('SELECT CashAccountID FROM cash_accounts WHERE CashAccountID = ?').get(data.ToID) as any;
      if (!dst) return { success: false, message: 'حساب الوصول غير موجود' };
    } else {
      const dst = db.prepare('SELECT PaymentMethodID FROM payment_methods WHERE PaymentMethodID = ?').get(data.ToID) as any;
      if (!dst) return { success: false, message: 'حساب الوصول غير موجود' };
    }

    // Moving money to the account it already sits in is not a transfer. It
    // costs the shop the fee, writes a document that explains nothing, and on
    // a shared row would net to a no-op that still deducted the commission.
    if (data.FromType === data.ToType && Number(data.FromID) === Number(data.ToID)) {
      return { success: false, message: 'لا يمكن التحويل إلى نفس الحساب' };
    }

    // A fee taken FROM the money can never exceed it: the destination would
    // be credited a negative amount — the transfer would both take from the
    // source AND debit the destination, with the fee vouchered on top.
    // (When the fee is 'separate' the source simply covers both, which the
    // balance check below already enforces.)
    if (data.TransferCostSource === 'from_amount' && data.TransferCost > data.Amount) {
      return { success: false, message: 'رسوم التحويل أكبر من المبلغ المحوّل' };
    }

    try {
      // Check source balance
      const sourceBalance = getAccountBalance(db, data.FromType, data.FromID);
      const totalDeduction = data.Amount + (data.TransferCostSource === 'separate' ? data.TransferCost : 0);

      // Reliable balance in payment method for transfer (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;

      if (allowNegCash?.Value !== '1') {
        const over = (balance: number) =>
          `الرصيد غير كافٍ للتحويل: المتاح ${balance.toFixed(2)}، المطلوب ${totalDeduction.toFixed(2)}`;
        if (data.FromType === 'cash_account') {
          const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.FromID) as any;
          if (!acc || (acc.Balance || 0) < totalDeduction) return { success: false, message: over(acc?.Balance || 0) };
        } else {
          const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.FromID) as any;
          if (!pm || (pm.Balance || 0) < totalDeduction) return { success: false, message: over(pm?.Balance || 0) };
        }
      }

      const dateStr = businessToday();
      const transferNumber = nextDocNumber(db, 'asset_transfers', 'TransferNumber', 'TRF', dateStr);

      // Amount received at destination (if cost from amount)
      const receivedAmount = data.TransferCostSource === 'from_amount' ? data.Amount - data.TransferCost : data.Amount;

      const tx = db.transaction(() => {
        // Record transfer
        const inserted = db.prepare(`
          INSERT INTO asset_transfers (
            TransferNumber, Date, FiscalYearID,
            FromType, FromID, ToType, ToID,
            Amount, TransferCost, ReceivedAmount, TransferCostSource,
            Notes, UserID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          transferNumber, dateStr, data.fiscalYearId,
          data.FromType, data.FromID, data.ToType, data.ToID,
          data.Amount, data.TransferCost, receivedAmount, data.TransferCostSource,
          data.Notes ?? null, data.userId
        );
        const transferId = Number(inserted.lastInsertRowid);

        // Deduct from source
        if (data.FromType === 'cash_account') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(totalDeduction, data.FromID);
        } else {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(totalDeduction, data.FromID);
        }

        // Add to destination
        if (data.ToType === 'cash_account') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(receivedAmount, data.ToID);
        } else {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(receivedAmount, data.ToID);
        }

        // Record transfer cost as expense (general voucher if cost > 0)
        if (data.TransferCost > 0) {
          // ReferenceType/ReferenceID tie this voucher to THIS transfer.
          //
          // The delete used to find it by date + amount + a `TRC-%` prefix,
          // which is not an identity: two transfers on the same day with the
          // same fee produced two indistinguishable vouchers, and deleting
          // one transfer removed BOTH. Measured — one delete, two rows gone,
          // and the second transfer's fee silently vanished from the books.
          //
          // WHICH account the voucher attaches to is the fee's GEOGRAPHY, and
          // it must match where the fee actually left:
          //
          //   - separate + cash source: the fee is a separate drawer outflow,
          //     already counted in the source deduction; the voucher IS its
          //     statement leg, so it attaches to the drawer.
          //   - from_amount: the fee is inside the transferred Amount — the
          //     transfer leg of the source statement already carries it. An
          //     attached voucher would show the drawer (or machine) paying
          //     the fee a SECOND time.
          //   - separate + machine source: the machine statement folds the
          //     fee into its transfer leg for the same reason.
          //
          // In the last two cases the voucher must attach to NO account: it
          // is a P&L record only. Attaching it anyway put a payment METHOD
          // id into the CashAccountID column, which every statement query
          // matches — a machine-sourced transfer then showed a phantom fee
          // on the FIRST cash account (ids collide: cash 1, machine 1) while
          // the real machine leg already carried the fee. MEASURED — a
          // machine-to-drawer 1,000 transfer with a 20 separate fee showed
          // 20 extra leaving the drawer on its statement.
          const voucherSourceId = data.TransferCostSource === 'separate' && data.FromType === 'cash_account'
            ? data.FromID : null;
          db.prepare(`
            INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
              PartyType, PartyName, Description, CashAccountID, UserID,
              ReferenceType, ReferenceID)
            VALUES (?, 'payment', ?, ?, ?, 'general', 'تكلفة تحويل', 'عمولة تحويل بين الحسابات', ?, ?,
                    'transfer', ?)
          `).run(
            nextDocNumber(db, 'vouchers', 'VoucherNumber', 'TRC', dateStr),
            data.fiscalYearId, dateStr, data.TransferCost,
            voucherSourceId, data.userId, transferId
          );
        }
      });

      tx();
      return { success: true, transferNumber, receivedAmount, transferCost: data.TransferCost };
    } catch (err: any) {
      console.error('[Transfer] Error:', err);
      return safeFailure('transfers:create', err);
    }
  });

  // List transfers
  ipcMain.handle('transfers:list', async () => {
    const db = getDb();
    const transfers = db.prepare(`
      SELECT t.*,
        CASE WHEN t.FromType = 'cash_account' THEN (SELECT AccountName FROM cash_accounts WHERE CashAccountID = t.FromID) ELSE (SELECT MethodName FROM payment_methods WHERE PaymentMethodID = t.FromID) END as FromName,
        CASE WHEN t.ToType = 'cash_account' THEN (SELECT AccountName FROM cash_accounts WHERE CashAccountID = t.ToID) ELSE (SELECT MethodName FROM payment_methods WHERE PaymentMethodID = t.ToID) END as ToName
      FROM asset_transfers t
      ORDER BY t.Date DESC, t.TransferID DESC
    `).all();
    return transfers;
  });
}

function getAccountBalance(db: any, type: string, id: number): number {
  if (type === 'cash_account') {
    const row = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(id) as any;
    return row?.Balance || 0;
  } else {
    const row = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(id) as any;
    return row?.Balance || 0;
  }
}
