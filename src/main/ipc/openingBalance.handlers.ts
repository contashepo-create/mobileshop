import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { checkAmount, MAX_AMOUNT } from '../../shared/money';
import { requireId } from '../../shared/validate';

export function registerOpeningBalanceHandlers() {
  // Get all opening balances overview
  ipcMain.handle('openingBalances:overview', async () => {
    const db = getDb();

    const cashAccounts = db.prepare(`
      SELECT CashAccountID, AccountName, AccountType, Balance, BankName
      FROM cash_accounts WHERE IsActive = 1 ORDER BY AccountType, AccountName
    `).all();

    const paymentMethods = db.prepare(`
      SELECT PaymentMethodID, MethodName, MethodType, Provider, PhoneNumber, Balance
      FROM payment_methods WHERE IsActive = 1 ORDER BY MethodName
    `).all();

    const customers = db.prepare(`
      SELECT CustomerID, Name, Phone, Balance, Status
      FROM customers ORDER BY Name
    `).all();

    const suppliers = db.prepare(`
      SELECT SupplierID, Name, Phone, Balance, Status
      FROM suppliers ORDER BY Name
    `).all();

    const employees = db.prepare(`
      SELECT EmployeeID, Name, Position, Balance, BaseSalary, Allowances
      FROM employees WHERE IsActive = 1 ORDER BY Name
    `).all();

    const inventory = db.prepare(`
      SELECT i.ItemID, i.ItemName, i.ItemType, i.IsSerialized,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
        (SELECT COALESCE(SUM(CostPrice * Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as StockValue
      FROM items i WHERE i.IsActive = 1 ORDER BY i.ItemName
    `).all();

    const totalCash = cashAccounts.reduce((s: number, c: any) => s + c.Balance, 0);
    const totalPaymentMethods = paymentMethods.reduce((s: number, c: any) => s + c.Balance, 0);
    const totalCustomers = customers.reduce((s: number, c: any) => s + c.Balance, 0);
    const totalSuppliers = suppliers.reduce((s: number, c: any) => s + c.Balance, 0);
    const totalEmployees = employees.reduce((s: number, c: any) => s + c.Balance, 0);
    const totalInventory = inventory.reduce((s: number, i: any) => s + i.StockValue, 0);

    return {
      cashAccounts, paymentMethods, customers, suppliers, employees, inventory,
      totals: {
        totalCash, totalPaymentMethods, totalCustomers, totalSuppliers, totalEmployees, totalInventory,
        totalAssets: totalCash + totalPaymentMethods + totalCustomers + totalInventory,
        totalLiabilities: totalSuppliers + totalEmployees,
      }
    };
  });

  // Update cash account opening balance
  ipcMain.handle('openingBalances:updateCash', async (_event, id: number, balance: number) => {
    const db = getDb();
    const res = checkAmount(balance, 'الرصيد الافتتاحي للخزينة');
    if (!res.ok) return { success: false, message: res.message };
    // Get the old balance to compute the difference for capital adjustment
    const old = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(id) as any;
    const oldBalance = Number(old?.Balance) || 0;
    const diff = balance - oldBalance;
    db.prepare('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = ?').run(balance, id);
    // Adjust owner capital so the financial position stays balanced
    if (Math.abs(diff) > 0.001) {
      const cap = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
      const newCap = (Number(cap?.Value) || 0) + diff;
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('owner_capital', ?)").run(String(newCap));
    }
    return { success: true };
  });

  // Update payment method opening balance
  ipcMain.handle('openingBalances:updatePaymentMethod', async (_event, id: number, balance: number) => {
    const db = getDb();
    const res = checkAmount(balance, 'الرصيد الافتتاحي لطريقة الدفع');
    if (!res.ok) return { success: false, message: res.message };
    // Get the old balance to compute the difference for capital adjustment
    const old = db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID = ?').get(id) as any;
    const oldBalance = Number(old?.Balance) || 0;
    const diff = balance - oldBalance;
    db.prepare('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = ?').run(balance, id);
    // Adjust owner capital so the financial position stays balanced
    if (Math.abs(diff) > 0.001) {
      const cap = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
      const newCap = (Number(cap?.Value) || 0) + diff;
      db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('owner_capital', ?)").run(String(newCap));
    }
    return { success: true };
  });

  // Update customer opening balance
  ipcMain.handle('openingBalances:updateCustomer', async (_event, id: number, balance: number) => {
    const db = getDb();
    // `id` and `balance` are bound straight into the UPDATE. An absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler instead of returning a reply.
    const rid = requireId(id, 'رقم العميل');
    if (!rid.ok) return { success: false, message: rid.message };
    // NOT `checkAmount`: a PARTY may legitimately open in credit.
    //
    // A customer balance of -500 means the shop owes them 500, which is a real
    // accounting position and the existing suite pins it. A first draft used
    // checkAmount here and broke that — a guard that refuses a valid business
    // state is a worse bug than the crash it was fixing. Only the TYPE is
    // checked: a finite number, within the magnitude the money helpers allow.
    const balNum = typeof balance === 'number' ? balance : Number(balance);
    if (!Number.isFinite(balNum)) {
      return { success: false, message: 'الرصيد الافتتاحي يجب أن يكون رقماً' };
    }
    if (Math.abs(balNum) > MAX_AMOUNT) {
      return { success: false, message: 'الرصيد الافتتاحي أكبر من الحد المسموح' };
    }
    const bal = { ok: true as const, value: balNum };
    const info = db.prepare('UPDATE customers SET Balance = ? WHERE CustomerID = ?').run(bal.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'العميل غير موجود' };
    return { success: true };
  });

  // Update supplier opening balance
  ipcMain.handle('openingBalances:updateSupplier', async (_event, id: number, balance: number) => {
    const db = getDb();
    // `id` and `balance` are bound straight into the UPDATE. An absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler instead of returning a reply.
    const rid = requireId(id, 'رقم المورد');
    if (!rid.ok) return { success: false, message: rid.message };
    // NOT `checkAmount`: a PARTY may legitimately open in credit.
    //
    // A customer balance of -500 means the shop owes them 500, which is a real
    // accounting position and the existing suite pins it. A first draft used
    // checkAmount here and broke that — a guard that refuses a valid business
    // state is a worse bug than the crash it was fixing. Only the TYPE is
    // checked: a finite number, within the magnitude the money helpers allow.
    const balNum = typeof balance === 'number' ? balance : Number(balance);
    if (!Number.isFinite(balNum)) {
      return { success: false, message: 'الرصيد الافتتاحي يجب أن يكون رقماً' };
    }
    if (Math.abs(balNum) > MAX_AMOUNT) {
      return { success: false, message: 'الرصيد الافتتاحي أكبر من الحد المسموح' };
    }
    const bal = { ok: true as const, value: balNum };
    const info = db.prepare('UPDATE suppliers SET Balance = ? WHERE SupplierID = ?').run(bal.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'المورد غير موجود' };
    return { success: true };
  });

  // Update employee opening balance
  ipcMain.handle('openingBalances:updateEmployee', async (_event, id: number, balance: number) => {
    const db = getDb();
    // `id` and `balance` are bound straight into the UPDATE. An absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler instead of returning a reply.
    const rid = requireId(id, 'رقم الموظف');
    if (!rid.ok) return { success: false, message: rid.message };
    // NOT `checkAmount`: a PARTY may legitimately open in credit.
    //
    // A customer balance of -500 means the shop owes them 500, which is a real
    // accounting position and the existing suite pins it. A first draft used
    // checkAmount here and broke that — a guard that refuses a valid business
    // state is a worse bug than the crash it was fixing. Only the TYPE is
    // checked: a finite number, within the magnitude the money helpers allow.
    const balNum = typeof balance === 'number' ? balance : Number(balance);
    if (!Number.isFinite(balNum)) {
      return { success: false, message: 'الرصيد الافتتاحي يجب أن يكون رقماً' };
    }
    if (Math.abs(balNum) > MAX_AMOUNT) {
      return { success: false, message: 'الرصيد الافتتاحي أكبر من الحد المسموح' };
    }
    const bal = { ok: true as const, value: balNum };
    const info = db.prepare('UPDATE employees SET Balance = ? WHERE EmployeeID = ?').run(bal.value, rid.value);
    if (info.changes === 0) return { success: false, message: 'الموظف غير موجود' };
    return { success: true };
  });

  // Update stock quantity opening balance
  ipcMain.handle('openingBalances:updateStock', async (_event, itemId: number, warehouseId: number, quantity: number, costPrice: number) => {
    const db = getDb();
    // Neither a negative count nor a negative unit cost is a thing that can be
    // observed on a shelf, and both would poison the stock valuation from the
    // first day.
    for (const [value, label] of [
      [quantity, 'الكمية الافتتاحية'],
      [costPrice, 'تكلفة الوحدة الافتتاحية'],
    ] as const) {
      const res = checkAmount(value, label);
      if (!res.ok) return { success: false, message: res.message };
    }
    const existing = db.prepare('SELECT ID FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(itemId, warehouseId) as any;
    if (existing) {
      db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?').run(quantity, costPrice, existing.ID);
    } else {
      db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)').run(itemId, warehouseId, quantity, costPrice);
    }
    return { success: true };
  });

  // Batch update opening balances
  ipcMain.handle('openingBalances:batchUpdate', async (_event, data: {
    cashAccounts: { id: number; balance: number }[];
    paymentMethods: { id: number; balance: number }[];
    customers: { id: number; balance: number }[];
    suppliers: { id: number; balance: number }[];
    employees: { id: number; balance: number }[];
  }) => {
    const db = getDb();

    // Shape first. `for (const x of data.cashAccounts)` threw
    // "data.cashAccounts is not iterable" — an uncaught TypeError across IPC —
    // when a caller omitted a group. Every group is optional to the caller and
    // must simply be treated as empty.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { success: false, message: 'بيانات الأرصدة الافتتاحية غير صالحة' };
    }
    for (const group of ['cashAccounts', 'paymentMethods', 'customers', 'suppliers', 'employees'] as const) {
      const v = (data as any)[group];
      if (v === undefined || v === null) { (data as any)[group] = []; continue; }
      if (!Array.isArray(v)) {
        return { success: false, message: 'بيانات الأرصدة الافتتاحية غير صالحة' };
      }
    }

    // Validated BEFORE anything is written.
    //
    // The single-record handlers above all run `checkAmount`; this one wrote
    // whatever it was handed. Measured against a real database: -99999 was
    // stored verbatim, and NaN silently became NULL — which is worse, because
    // a null balance is not a number the reports can even add up.
    //
    // Cash boxes and wallets cannot hold less than nothing. Customer,
    // supplier and employee balances CAN legitimately be negative — that is
    // the shop owing them — so those are only checked for being real numbers.
    const problems: string[] = [];
    for (const [rows, label, allowNegative] of [
      [data.cashAccounts, 'رصيد الخزينة', false],
      [data.paymentMethods, 'رصيد وسيلة الدفع', false],
      [data.customers, 'رصيد العميل', true],
      [data.suppliers, 'رصيد المورد', true],
      [data.employees, 'رصيد الموظف', true],
    ] as const) {
      for (const row of rows || []) {
        const n = Number(row?.balance);
        if (!Number.isFinite(n)) {
          problems.push(`${label}: قيمة غير صالحة`);
        } else if (!allowNegative) {
          const res = checkAmount(n, label);
          // `message` is only present on a failure, so it is optional in the
          // type. Fall back rather than push `undefined` into the list.
          if (!res.ok) problems.push(res.message ?? `${label}: قيمة غير صالحة`);
        }
      }
    }
    if (problems.length > 0) {
      return { success: false, message: problems.slice(0, 3).join(' • ') };
    }

    const tx = db.transaction(() => {
      for (const c of data.cashAccounts) {
        db.prepare('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = ?').run(c.balance, c.id);
      }
      for (const p of data.paymentMethods) {
        db.prepare('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = ?').run(p.balance, p.id);
      }
      for (const c of data.customers) {
        db.prepare('UPDATE customers SET Balance = ? WHERE CustomerID = ?').run(c.balance, c.id);
      }
      for (const s of data.suppliers) {
        db.prepare('UPDATE suppliers SET Balance = ? WHERE SupplierID = ?').run(s.balance, s.id);
      }
      for (const e of data.employees) {
        db.prepare('UPDATE employees SET Balance = ? WHERE EmployeeID = ?').run(e.balance, e.id);
      }
    });
    tx();
    return { success: true };
  });
}
