import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount } from '../../shared/money';
import {
  requireText, optionalText, optionalId, requireId, oneOf, requireFlag,
  LIMITS, CASH_ACCOUNT_TYPES,
} from '../../shared/validate';

/**
 * The payment-machine kinds, read off the `<option>` values in
 * PaymentMethodsPage.tsx — NOT guessed.
 *
 * A first draft said `['wallet','bank','instapay','other']`, none of which the
 * form can produce. The real three are `pos_machine`, `digital_wallet` and
 * `transfer`, and the list badge renders them as ماكينة / محفظة / تحويل. That
 * draft would have refused every payment method the shop creates while
 * accepting four values nothing in the product understands — the same mistake
 * as writing an allow-list from the column name instead of from the caller.
 *
 * MEASURED before any allow-list existed: `MethodType: 'ANYTHING'` was stored,
 * and a wallet whose type nothing recognises falls through every branch of the
 * badge to "تحويل" regardless of what it actually is.
 */
const PAYMENT_METHOD_TYPES = ['pos_machine', 'digital_wallet', 'transfer'] as const;

export function registerAssetsHandlers() {
  // ===== CASH ACCOUNTS (BANKS & SAFES) =====
  ipcMain.handle('cashAccounts:list', async (_event, filters?: { isActive?: number }) => {
    const db = getDb();
    let query = 'SELECT * FROM cash_accounts WHERE 1=1';
    const params: any[] = [];
    if (filters?.isActive !== undefined) {
      query += ' AND IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY AccountType ASC, AccountName ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('cashAccounts:create', async (_event, data: any) => {
    const db = getDb();
    // A cash box cannot be created already holding less than nothing.
    //
    // Unlike a customer, whose negative balance legitimately means the shop
    // owes them, physical money has no credit side. Measured before this
    // guard: a safe was created at -99,999 and every later report — the
    // balance sheet, total liquid funds, the stocktake screen — inherited it.
    const bal = checkAmount(data?.Balance ?? 0, 'الرصيد الافتتاحي للخزينة');
    if (!bal.ok) return { success: false, message: bal.message };

    // MEASURED: `AccountName: ''` created an unnamed safe that still appeared
    // in every payment dropdown, and `AccountType: 'BITCOIN'` was stored — the
    // balance sheet splits liquid funds into cash and bank by this exact
    // string, so a third value is counted in neither column.
    const name = requireText(data?.AccountName, 'اسم الخزينة', LIMITS.NAME);
    if (!name.ok) return { success: false, message: name.message };
    const type = oneOf(data?.AccountType || 'safe', 'نوع الحساب', CASH_ACCOUNT_TYPES);
    if (!type.ok) return { success: false, message: type.message };
    const bank = optionalText(data?.BankName, 'اسم البنك', LIMITS.NAME);
    if (!bank.ok) return { success: false, message: bank.message };
    const accNo = optionalText(data?.AccountNumber, 'رقم الحساب', LIMITS.CODE);
    if (!accNo.ok) return { success: false, message: accNo.message };

    const result = db.prepare(`
      INSERT INTO cash_accounts (AccountName, AccountType, Balance, BankName, AccountNumber, IsActive)
      VALUES (@AccountName, @AccountType, @Balance, @BankName, @AccountNumber, 1)
    `).run({
      AccountName: name.value, AccountType: type.value, Balance: bal.value,
      BankName: bank.value, AccountNumber: accNo.value,
    });
    // An opening balance is real money that must walk the books: the wallet
    // handler has always raised owner capital for it, and the cash-account
    // handler did NOT — so creating a bank with 20,000 made the balance sheet
    // disagree with itself by 20,000 (assets rose, equity did not) while the
    // machine equivalent stayed balanced. MEASURED in section 11: the same
    // creation on both registries left the bank's identity off by its balance.
    if (bal.value > 0) {
      const currentCapital = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
      const newCapital = (Number(currentCapital?.Value) || 0) + bal.value;
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('owner_capital', ?)").run(String(newCapital));
    }
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('cashAccounts:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم الخزينة');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم الخزينة غير صالح' };
    const name = requireText(data?.AccountName, 'اسم الخزينة', LIMITS.NAME);
    if (!name.ok) return { success: false, message: name.message };
    const type = oneOf(data?.AccountType || 'safe', 'نوع الحساب', CASH_ACCOUNT_TYPES);
    if (!type.ok) return { success: false, message: type.message };
    const bank = optionalText(data?.BankName, 'اسم البنك', LIMITS.NAME);
    if (!bank.ok) return { success: false, message: bank.message };
    const accNo = optionalText(data?.AccountNumber, 'رقم الحساب', LIMITS.CODE);
    if (!accNo.ok) return { success: false, message: accNo.message };
    const active = requireFlag(data?.IsActive, 'نشط', 1);
    if (!active.ok) return { success: false, message: active.message };
    // Deactivating through the update form is the same act as delete: a
    // balance must be moved out first or it vanishes from the reports while
    // the equity backing it stays (see `cashAccounts:delete`).
    if (active.value === 0) {
      const bal = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(rid.value) as any;
      if (bal && Number(bal.Balance || 0) !== 0) {
        return { success: false, message: 'لا يمكن إغلاق خزينة عليها رصيد — انقل الرصيد أولاً ثم أعد المحاولة' };
      }
    }
    const info = db.prepare(`
      UPDATE cash_accounts SET
        AccountName = @AccountName, AccountType = @AccountType,
        BankName = @BankName, AccountNumber = @AccountNumber, IsActive = @IsActive
      WHERE CashAccountID = @id
    `).run({
      AccountName: name.value, AccountType: type.value, BankName: bank.value,
      AccountNumber: accNo.value, IsActive: active.value, id: rid.value,
    });
    if (info.changes === 0) return { success: false, message: 'الخزينة غير موجودة' };
    return { success: true };
  });

  /**
   * Deactivates a cash account.
   *
   * The id is validated and the row confirmed BEFORE the write, for two
   * reasons measured on this handler:
   *
   *   - `cashAccounts:delete(undefined)` bound `undefined` straight into the
   *     UPDATE. That is a write, and a write with an unbindable parameter is
   *     now refused loudly (see `hardenBinding`), so the channel answered with
   *     a technical error instead of a plain refusal.
   *   - a well-formed id that matches nothing changed no rows and still
   *     returned `{ success: true }`. The screen then reported "تم الحذف" for
   *     an account that was never touched.
   */
  ipcMain.handle('cashAccounts:delete', async (_event, id: number) => {
    const db = getDb();
    const rid = requireId(id, 'رقم الخزينة');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM cash_accounts WHERE CashAccountID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الخزينة غير موجودة' };
    // Deactivating is not deleting: the money in a closed drawer does not stop
    // existing, but the balance sheet only lists IsActive = 1 assets, so the
    // cash would vanish from every report while the equity that backs it
    // stayed — the identity broke by exactly the held balance. MEASURED in
    // section 11: closing a drawer holding 100,000 left `difference: -100,000`.
    // The money must be moved out before the drawer can be closed.
    const bal = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(rid.value) as any;
    if (Number(bal?.Balance || 0) !== 0) {
      return { success: false, message: 'لا يمكن إغلاق خزينة عليها رصيد — انقل الرصيد أولاً ثم أعد المحاولة' };
    }
    db.prepare('UPDATE cash_accounts SET IsActive = 0 WHERE CashAccountID = ?').run(rid.value);
    return { success: true };
  });

  // ===== PAYMENT METHODS =====
  ipcMain.handle('paymentMethods:list', async (_event, filters?: { isActive?: number }) => {
    const db = getDb();
    let query = 'SELECT * FROM payment_methods WHERE 1=1';
    const params: any[] = [];
    if (filters?.isActive !== undefined) {
      query += ' AND IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY MethodName ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('paymentMethods:create', async (_event, data: any) => {
    const db = getDb();
    // MEASURED: `MethodName: ''` and `MethodType: 'ANYTHING'` were both stored.
    const name = requireText(data?.MethodName, 'اسم طريقة الدفع', LIMITS.NAME);
    if (!name.ok) return { success: false, message: name.message };
    const type = oneOf(data?.MethodType || 'pos_machine', 'نوع طريقة الدفع', PAYMENT_METHOD_TYPES);
    if (!type.ok) return { success: false, message: type.message };
    const provider = optionalText(data?.Provider, 'المزود', LIMITS.NAME);
    if (!provider.ok) return { success: false, message: provider.message };
    const phone = optionalText(data?.PhoneNumber, 'رقم الهاتف', LIMITS.PHONE);
    if (!phone.ok) return { success: false, message: phone.message };
    // An opening balance is money the machine actually holds. `Math.max(0, …)`
    // used to swallow a NEGATIVE value into a silent zero — the form said
    // "تم إنشاء" for a machine that never existed as entered — while the cash
    // registry refuses the same input. MEASURED in section 11: -50 was clamped
    // to 0 instead of refused.
    const openingBalance = checkAmount(data?.OpeningBalance ?? 0, 'الرصيد الافتتاحي لطريقة الدفع');
    if (!openingBalance.ok) return { success: false, message: openingBalance.message };
    const result = db.prepare(`
      INSERT INTO payment_methods (MethodName, MethodType, Provider, PhoneNumber, Balance, IsActive)
      VALUES (@MethodName, @MethodType, @Provider, @PhoneNumber, @Balance, 1)
    `).run({
      MethodName: name.value, MethodType: type.value,
      Provider: provider.value, PhoneNumber: phone.value,
      Balance: openingBalance.value,
    });
    // If an opening balance was set, add it to owner capital so the financial
    // position balances (Assets = Liabilities + Equity).
    if (openingBalance.value > 0) {
      const currentCapital = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
      const newCapital = (Number(currentCapital?.Value) || 0) + openingBalance.value;
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('owner_capital', ?)").run(String(newCapital));
    }
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('paymentMethods:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const rid = optionalId(id, 'رقم طريقة الدفع');
    if (!rid.ok || rid.value === null) return { success: false, message: 'رقم طريقة الدفع غير صالح' };
    const name = requireText(data?.MethodName, 'اسم طريقة الدفع', LIMITS.NAME);
    if (!name.ok) return { success: false, message: name.message };
    const type = oneOf(data?.MethodType || 'pos_machine', 'نوع طريقة الدفع', PAYMENT_METHOD_TYPES);
    if (!type.ok) return { success: false, message: type.message };
    const provider = optionalText(data?.Provider, 'المزود', LIMITS.NAME);
    if (!provider.ok) return { success: false, message: provider.message };
    const phone = optionalText(data?.PhoneNumber, 'رقم الهاتف', LIMITS.PHONE);
    if (!phone.ok) return { success: false, message: phone.message };
    const active = requireFlag(data?.IsActive, 'نشط', 1);
    if (!active.ok) return { success: false, message: active.message };
    // Same rule as `paymentMethods:delete`: closing a machine that still
    // holds money hides the balance from every report.
    if (active.value === 0) {
      const bal = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(rid.value) as any;
      if (bal && Number(bal.Balance || 0) !== 0) {
        return { success: false, message: 'لا يمكن إغلاق طريقة دفع عليها رصيد — انقل الرصيد أولاً ثم أعد المحاولة' };
      }
    }
    const info = db.prepare(`
      UPDATE payment_methods SET
        MethodName = @MethodName, MethodType = @MethodType,
        Provider = @Provider, PhoneNumber = @PhoneNumber, IsActive = @IsActive
      WHERE PaymentMethodID = @id
    `).run({
      MethodName: name.value, MethodType: type.value, Provider: provider.value,
      PhoneNumber: phone.value, IsActive: active.value, id: rid.value,
    });
    if (info.changes === 0) return { success: false, message: 'طريقة الدفع غير موجودة' };
    return { success: true };
  });

  /** Deactivates a payment method. Same reasoning as `cashAccounts:delete`. */
  ipcMain.handle('paymentMethods:delete', async (_event, id: number) => {
    const db = getDb();
    const rid = requireId(id, 'رقم طريقة الدفع');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM payment_methods WHERE PaymentMethodID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'طريقة الدفع غير موجودة' };
    // Same rule as the drawer: a machine holding money cannot be closed, or
    // the balance sheet drops the balance while the equity that backs it
    // stays — measured off by the held amount in section 11.
    const bal = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(rid.value) as any;
    if (Number(bal?.Balance || 0) !== 0) {
      return { success: false, message: 'لا يمكن إغلاق طريقة دفع عليها رصيد — انقل الرصيد أولاً ثم أعد المحاولة' };
    }
    db.prepare('UPDATE payment_methods SET IsActive = 0 WHERE PaymentMethodID = ?').run(rid.value);
    return { success: true };
  });
}
