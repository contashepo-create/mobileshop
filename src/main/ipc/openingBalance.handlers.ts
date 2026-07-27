import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

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
    db.prepare('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = ?').run(balance, id);
    return { success: true };
  });

  // Update payment method opening balance
  ipcMain.handle('openingBalances:updatePaymentMethod', async (_event, id: number, balance: number) => {
    const db = getDb();
    db.prepare('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = ?').run(balance, id);
    return { success: true };
  });

  // Update customer opening balance
  ipcMain.handle('openingBalances:updateCustomer', async (_event, id: number, balance: number) => {
    const db = getDb();
    db.prepare('UPDATE customers SET Balance = ? WHERE CustomerID = ?').run(balance, id);
    return { success: true };
  });

  // Update supplier opening balance
  ipcMain.handle('openingBalances:updateSupplier', async (_event, id: number, balance: number) => {
    const db = getDb();
    db.prepare('UPDATE suppliers SET Balance = ? WHERE SupplierID = ?').run(balance, id);
    return { success: true };
  });

  // Update employee opening balance
  ipcMain.handle('openingBalances:updateEmployee', async (_event, id: number, balance: number) => {
    const db = getDb();
    db.prepare('UPDATE employees SET Balance = ? WHERE EmployeeID = ?').run(balance, id);
    return { success: true };
  });

  // Update stock quantity opening balance
  ipcMain.handle('openingBalances:updateStock', async (_event, itemId: number, warehouseId: number, quantity: number, costPrice: number) => {
    const db = getDb();
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
