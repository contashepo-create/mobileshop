import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';
import { checkAmounts } from '../../shared/money';

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

    // Moving money to the account it already sits in is not a transfer. It
    // costs the shop the fee, writes a document that explains nothing, and on
    // a shared row would net to a no-op that still deducted the commission.
    if (data.FromType === data.ToType && Number(data.FromID) === Number(data.ToID)) {
      return { success: false, message: 'لا يمكن التحويل إلى نفس الحساب' };
    }

    try {
      // Check source balance
      const sourceBalance = getAccountBalance(db, data.FromType, data.FromID);
      const totalDeduction = data.Amount + (data.TransferCostSource === 'separate' ? data.TransferCost : 0);

      if (sourceBalance < totalDeduction) {
        return { success: false, message: `الرصيد غير كافٍ. الرصيد المتاح: ${sourceBalance.toFixed(2)} والمطلوب: ${totalDeduction.toFixed(2)}` };
      }

      const dateStr = businessToday();
      const transferNumber = nextDocNumber(db, 'asset_transfers', 'TransferNumber', 'TRF', dateStr);

      // Amount received at destination (if cost from amount)
      const receivedAmount = data.TransferCostSource === 'from_amount' ? data.Amount - data.TransferCost : data.Amount;

      // Check sufficient balance before transfer (unless negative cash allowed)
      const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
      if (allowNegCash?.Value !== '1') {
        if (data.FromType === 'cash_account') {
          const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.FromID) as any;
          if (!acc || (acc.Balance || 0) < totalDeduction) {
            return { success: false, message: `الرصيد غير كافٍ في الخزينة للتحويل: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${totalDeduction.toFixed(2)}` };
          }
        } else {
          const pm = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(data.FromID) as any;
          if (!pm || (pm.Balance || 0) < totalDeduction) {
            return { success: false, message: `الرصيد غير كافٍ في طريقة الدفع للتحويل: المتاح ${(pm?.Balance || 0).toFixed(2)}، المطلوب ${totalDeduction.toFixed(2)}` };
          }
        }
      }

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
          db.prepare(`
            INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
              PartyType, PartyName, Description, CashAccountID, UserID,
              ReferenceType, ReferenceID)
            VALUES (?, 'payment', ?, ?, ?, 'general', 'تكلفة تحويل', 'عمولة تحويل بين الحسابات', ?, ?,
                    'transfer', ?)
          `).run(
            nextDocNumber(db, 'vouchers', 'VoucherNumber', 'TRC', dateStr),
            data.fiscalYearId, dateStr, data.TransferCost,
            data.FromID, data.userId, transferId
          );
        }
      });

      tx();
      return { success: true, transferNumber, receivedAmount, transferCost: data.TransferCost };
    } catch (err: any) {
      console.error('[Transfer] Error:', err);
      return { success: false, message: `خطأ: ${err.message || err}` };
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
