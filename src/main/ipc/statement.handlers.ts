import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

// Generic handler to fetch detail of any operation record for preview
ipcMain.handle('statement:getOperationDetail', async (_event, opType: string, refId: number) => {
  const db = getDb();
  switch (opType) {
    case 'sale': {
      const sale = db.prepare(`
        SELECT s.*, c.Name as CustomerName, c.Phone as CustomerPhone
        FROM sales s LEFT JOIN customers c ON s.CustomerID = c.CustomerID WHERE s.SaleID = ?
      `).get(refId);
      const details = db.prepare(`
        SELECT sd.*, i.ItemName FROM sale_details sd
        LEFT JOIN items i ON sd.ItemID = i.ItemID WHERE sd.SaleID = ?
      `).all(refId);
      return { primary: sale, items: details, title: 'فاتورة بيع' };
    }
    case 'sale_return': {
      const ret = db.prepare(`
        SELECT r.*, s.SaleNumber, c.Name as CustomerName
        FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID
        LEFT JOIN customers c ON s.CustomerID = c.CustomerID WHERE r.ReturnID = ?
      `).get(refId);
      const details = db.prepare(`
        SELECT rd.*, i.ItemName FROM sale_return_details rd
        LEFT JOIN items i ON rd.ItemID = i.ItemID WHERE rd.ReturnID = ?
      `).all(refId);
      return { primary: ret, items: details, title: 'مرتجع مبيعات' };
    }
    case 'maintenance_delivery': {
      const delivery: any = db.prepare(`
        SELECT d.*, c.Name as CustomerName, c.Phone as CustomerPhone
        FROM maintenance_deliveries d
        LEFT JOIN customers c ON d.CustomerID = c.CustomerID WHERE d.DeliveryID = ?
      `).get(refId);
      const ticket: any = db.prepare(`
        SELECT TicketNumber, DeviceModel, DeviceIMEI, ProblemDesc FROM maintenance_tickets WHERE TicketID = ?
      `).get(delivery?.TicketID);
      const additional = db.prepare(`
        SELECT * FROM maintenance_additional_costs WHERE DeliveryID = ?
      `).all(refId);
      return { primary: { ...delivery, ...ticket }, items: additional, title: 'تسليم صيانة' };
    }
    case 'purchase': {
      const purchase = db.prepare(`
        SELECT p.*, s.Name as SupplierName, s.Phone as SupplierPhone
        FROM purchases p JOIN suppliers s ON p.SupplierID = s.SupplierID WHERE p.PurchaseID = ?
      `).get(refId);
      const details = db.prepare(`
        SELECT pd.*, i.ItemName FROM purchase_details pd
        JOIN items i ON pd.ItemID = i.ItemID WHERE pd.PurchaseID = ?
      `).all(refId);
      return { primary: purchase, items: details, title: 'فاتورة شراء' };
    }
    case 'purchase_return': {
      const ret = db.prepare(`
        SELECT r.*, p.PurchaseNumber, s.Name as SupplierName
        FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID
        JOIN suppliers s ON p.SupplierID = s.SupplierID WHERE r.ReturnID = ?
      `).get(refId);
      const details = db.prepare(`
        SELECT rd.*, i.ItemName FROM purchase_return_details rd
        LEFT JOIN items i ON rd.ItemID = i.ItemID WHERE rd.ReturnID = ?
      `).all(refId);
      return { primary: ret, items: details, title: 'مرتجع مشتريات' };
    }
    case 'voucher_receipt':
    case 'voucher_payment': {
      const voucher = db.prepare(`
        SELECT v.*, u.Username, ca.AccountName as CashAccountName
        FROM vouchers v JOIN users u ON v.UserID = u.UserID
        LEFT JOIN cash_accounts ca ON v.CashAccountID = ca.CashAccountID WHERE v.VoucherID = ?
      `).get(refId);
      const label = opType === 'voucher_receipt' ? 'سند قبض' : 'سند صرف';
      return { primary: voucher, items: [], title: label };
    }
    case 'salary': {
      const salary = db.prepare(`
        SELECT s.*, e.Name as EmployeeName
        FROM salaries s JOIN employees e ON s.EmployeeID = e.EmployeeID WHERE s.SalaryID = ?
      `).get(refId);
      return { primary: salary, items: [], title: 'راتب' };
    }
    case 'advance': {
      const advance = db.prepare(`
        SELECT a.*, e.Name as EmployeeName
        FROM employee_advances a JOIN employees e ON a.EmployeeID = e.EmployeeID WHERE a.AdvanceID = ?
      `).get(refId);
      return { primary: advance, items: [], title: 'سلفية' };
    }
    case 'commission': {
      const commission = db.prepare(`
        SELECT c.*, e.Name as EmployeeName
        FROM commissions c JOIN employees e ON c.EmployeeID = e.EmployeeID WHERE c.CommissionID = ?
      `).get(refId);
      return { primary: commission, items: [], title: 'عمولة' };
    }
    case 'deduction': {
      const deduction = db.prepare(`
        SELECT d.*, e.Name as EmployeeName
        FROM employee_deductions d JOIN employees e ON d.EmployeeID = e.EmployeeID WHERE d.DeductionID = ?
      `).get(refId);
      return { primary: deduction, items: [], title: 'خصم' };
    }
    default:
      return null;
  }
});

// Full cash account statement - all transactions affecting a cash account
ipcMain.handle('cashAccount:statement', async (_event, accountId: number, filters?: { fromDate?: string; toDate?: string }) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM cash_accounts WHERE CashAccountID = ?').get(accountId) as any;
  if (!account) return { success: false, message: 'الحساب غير موجود' };

  const dateFilter = (field: string) => {
    const parts: string[] = [];
    if (filters?.fromDate) parts.push(`${field} >= '${filters.fromDate}'`);
    if (filters?.toDate) parts.push(`${field} <= '${filters.toDate}'`);
    return parts.length > 0 ? `AND ${parts.join(' AND ')}` : '';
  };

  const df = (f: string) => dateFilter(f);

  const operations: any[] = [];

  // Sales (money coming IN)
  const sales = db.prepare(`
    SELECT Date, SaleNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
      0 as OutAmount, 'sale' as OpType, 'فاتورة بيع' as OpLabel, SaleID as RefID
    FROM sales WHERE CashAccountID = ? AND PaidAmount > 0 AND IsVoided = 0 ${df('Date')}
  `).all(accountId);

  // Sale returns (money going OUT)
  const rets = db.prepare(`
    SELECT r.Date, r.ReturnNumber as RefNumber, c.Name as Party, 0 as InAmount,
      r.TotalAmount as OutAmount, 'return' as OpType, 'مرتجع مبيعات' as OpLabel, r.ReturnID as RefID
    FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID
    LEFT JOIN customers c ON s.CustomerID = c.CustomerID
    WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${df('r.Date')}
  `).all(accountId);

  // Voucher receipts (money IN)
  const vReceipts = db.prepare(`
    SELECT Date, VoucherNumber as RefNumber, PartyName as Party, Amount as InAmount,
      0 as OutAmount, 'voucher_receipt' as OpType, 'سند قبض' as OpLabel, VoucherID as RefID
    FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'receipt' AND Amount > 0 ${df('Date')}
  `).all(accountId);

  // Voucher payments (money OUT)
  const vPayments = db.prepare(`
    SELECT Date, VoucherNumber as RefNumber, PartyName as Party, 0 as InAmount,
      Amount as OutAmount, 'voucher_payment' as OpType, 'سند صرف' as OpLabel, VoucherID as RefID
    FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'payment' AND Amount > 0 ${df('Date')}
  `).all(accountId);

  // Purchases (money OUT)
  const purchases = db.prepare(`
    SELECT p.Date, p.PurchaseNumber as RefNumber, s.Name as Party, 0 as InAmount,
      p.PaidAmount as OutAmount, 'purchase' as OpType, 'فاتورة شراء' as OpLabel, p.PurchaseID as RefID
    FROM purchases p JOIN suppliers s ON p.SupplierID = s.SupplierID
    WHERE p.PaymentSourceType = 'cash_account' AND p.PaymentSourceID = ? AND p.PaidAmount > 0 ${df('p.Date')}
  `).all(accountId);

  // Purchase returns (money IN)
  const purRets = db.prepare(`
    SELECT r.Date, r.ReturnNumber as RefNumber, s.Name as Party, r.TotalAmount as InAmount,
      0 as OutAmount, 'purchase_return' as OpType, 'مرتجع مشتريات' as OpLabel, r.ReturnID as RefID
    FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID
    JOIN suppliers s ON p.SupplierID = s.SupplierID
    WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${df('r.Date')}
  `).all(accountId);

  // Salaries (money OUT)
  const salaries = db.prepare(`
    SELECT s.PaymentDate as Date, 'SAL-' || s.SalaryID as RefNumber, e.Name as Party, 0 as InAmount,
      s.PaidAmount as OutAmount, 'salary' as OpType, 'راتب' as OpLabel, s.SalaryID as RefID
    FROM salaries s JOIN employees e ON s.EmployeeID = e.EmployeeID
    WHERE s.CashAccountID = ? AND s.PaidAmount > 0 ${df('s.PaymentDate')}
  `).all(accountId);

  // Advances (money OUT)
  const advances = db.prepare(`
    SELECT Date, 'ADV-' || AdvanceID as RefNumber, e.Name as Party, 0 as InAmount,
      Amount as OutAmount, 'advance' as OpType, 'سلفة' as OpLabel, AdvanceID as RefID
    FROM employee_advances a JOIN employees e ON a.EmployeeID = e.EmployeeID
    WHERE a.CashAccountID = ? AND a.Amount > 0 ${df('a.Date')}
  `).all(accountId);

  // Maintenance deliveries (money IN)
  const maintDel = db.prepare(`
    SELECT Date, DeliveryNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
      0 as OutAmount, 'maintenance_delivery' as OpType, 'تسليم صيانة' as OpLabel, DeliveryID as RefID
    FROM maintenance_deliveries WHERE CashAccountID = ? AND PaidAmount > 0 ${df('Date')}
  `).all(accountId);

  // Maintenance returns (money OUT)
  const maintRets = db.prepare(`
    SELECT Date, ReturnNumber as RefNumber, d.CustomerName as Party, 0 as InAmount,
      TotalRefund as OutAmount, 'maintenance_return' as OpType, 'مرتجع صيانة' as OpLabel, ReturnID as RefID
    FROM maintenance_returns r
    JOIN maintenance_deliveries d ON r.DeliveryID = d.DeliveryID
    WHERE r.CashAccountID = ? AND r.TotalRefund > 0 ${df('r.Date')}
  `).all(accountId);

  // Rent payments (expense = OUT, income = IN)
  const rents = db.prepare(`
    SELECT rp.PaidDate as Date, 'RNT-' || rp.RentPaymentID as RefNumber, r.PropertyName as Party,
      CASE WHEN r.RentType = 'income' THEN rp.Amount ELSE 0 END as InAmount,
      CASE WHEN r.RentType = 'expense' THEN rp.Amount ELSE 0 END as OutAmount,
      'rent' as OpType, CASE WHEN r.RentType = 'income' THEN 'إيجار وارد' ELSE 'إيجار منصرف' END as OpLabel,
      rp.RentPaymentID as RefID
    FROM rent_payments rp JOIN rents r ON rp.RentID = r.RentID
    WHERE rp.CashAccountID = ? AND rp.Status = 'paid' ${df('rp.PaidDate')}
  `).all(accountId);

  // Service sales (money IN)
  const services = db.prepare(`
    SELECT Date, ServiceNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
      0 as OutAmount, 'service_sale' as OpType, 'خدمة' as OpLabel, ServiceSaleID as RefID
    FROM service_sales WHERE CashAccountID = ? AND PaidAmount > 0 ${df('Date')}
  `).all(accountId);

  // Asset transfers (IN or OUT depending on direction)
  const transfersIn = db.prepare(`
    SELECT Date, TransferNumber as RefNumber, '' as Party,
      ReceivedAmount as InAmount, 0 as OutAmount,
      'transfer_in' as OpType, 'تحويل وارد' as OpLabel, TransferID as RefID
    FROM asset_transfers WHERE ToType = 'cash_account' AND ToID = ? ${df('Date')}
  `).all(accountId);

  const transfersOut = db.prepare(`
    SELECT Date, TransferNumber as RefNumber, '' as Party, 0 as InAmount,
      (Amount + TransferCost) as OutAmount,
      'transfer_out' as OpType, 'تحويل صادر' as OpLabel, TransferID as RefID
    FROM asset_transfers WHERE FromType = 'cash_account' AND FromID = ? ${df('Date')}
  `).all(accountId);

  operations.push(
    ...sales, ...rets, ...vReceipts, ...vPayments, ...purchases, ...purRets,
    ...salaries, ...advances, ...maintDel, ...maintRets, ...rents, ...services,
    ...transfersIn, ...transfersOut
  );

  // Sort by date
  operations.sort((a, b) => a.Date.localeCompare(b.Date));

  // Calculate running balance
  let runningBalance = 0;
  for (const op of operations) {
    runningBalance += (op.InAmount || 0) - (op.OutAmount || 0);
    op.Balance = runningBalance;
  }

  return {
    success: true,
    account: { ...account, OpeningBalance: 0 },
    operations,
    totalIn: operations.reduce((s, o) => s + (o.InAmount || 0), 0),
    totalOut: operations.reduce((s, o) => s + (o.OutAmount || 0), 0),
    netChange: operations.reduce((s, o) => s + (o.InAmount || 0) - (o.OutAmount || 0), 0)
  };
});

export function registerCustomerStatementHandlers() {
  // Full customer statement - all operations in chronological order
  ipcMain.handle('customerStatement:get', async (_event, customerId: number, filters?: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    const customer = db.prepare('SELECT * FROM customers WHERE CustomerID = ?').get(customerId) as any;
    if (!customer) return { success: false, message: 'العميل غير موجود' };

    const operations: any[] = [];

    // Helper for date filter
    let dateFilter = '';
    const params: any[] = [];
    if (filters?.fromDate) { dateFilter += ' AND Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { dateFilter += ' AND Date <= ?'; params.push(filters.toDate); }

    // Sales (debit = full invoice amount, credit = amount paid at time of sale)
    const sales = db.prepare(`
      SELECT SaleID as RefID, SaleNumber as RefNumber, Date,
             TotalAmount as Debit,
             PaidAmount as Credit,
             'sale' as OpType,
             'فاتورة بيع' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM sales WHERE CustomerID = ? AND IsVoided = 0 ${dateFilter}
    `).all(customerId, ...params);
    operations.push(...sales);

    // Sale returns (credit - decreases customer balance)
    const returns = db.prepare(`
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, 0 as Debit, r.TotalAmount as Credit,
             'sale_return' as OpType, 'مرتجع مبيعات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      WHERE s.CustomerID = ? ${dateFilter.replace('Date', 'r.Date')}
    `).all(customerId, ...params);
    operations.push(...returns);

    // Maintenance deliveries (debit = total cost, credit = amount paid at delivery)
    const deliveries = db.prepare(`
      SELECT d.DeliveryID as RefID, d.DeliveryNumber as RefNumber, d.Date,
             d.TotalCost as Debit,
             d.PaidAmount as Credit,
             'maintenance_delivery' as OpType, 'تسليم صيانة' as Description,
             d.PaymentMethod, d.PaidAmount, d.RemainingAmount, NULL as Status
      FROM maintenance_deliveries d
      WHERE d.CustomerID = ? AND d.VoidedSaleID IS NULL ${dateFilter.replace('Date', 'd.Date')}
    `).all(customerId, ...params);
    operations.push(...deliveries);

    // Receipt vouchers (credit - customer pays, reduces balance)
    const receipts = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${dateFilter.replace('Date', 'v.Date')}
    `).all(customerId, ...params);
    operations.push(...receipts);

    // Payment vouchers (debit - refund to customer)
    const payments = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${dateFilter.replace('Date', 'v.Date')}
    `).all(customerId, ...params);
    operations.push(...payments);

    // Sort by date ascending, then by insertion order
    operations.sort((a, b) => {
      const dateCompare = new Date(a.Date).getTime() - new Date(b.Date).getTime();
      return dateCompare !== 0 ? dateCompare : (a.RefID - b.RefID);
    });

    // Calculate running balance
    let runningBalance = 0;
    for (const op of operations) {
      runningBalance += (op.Debit || 0) - (op.Credit || 0);
      op.Balance = runningBalance;
    }

    // Totals
    const totalDebit = operations.reduce((s, o) => s + (o.Debit || 0), 0);
    const totalCredit = operations.reduce((s, o) => s + (o.Credit || 0), 0);

    return {
      success: true,
      customer,
      operations,
      totals: {
        totalDebit,
        totalCredit,
        netBalance: totalDebit - totalCredit,
        currentBalance: customer.Balance,
      },
    };
  });

  // Supplier statement - same concept
  ipcMain.handle('supplierStatement:get', async (_event, supplierId: number, filters?: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE SupplierID = ?').get(supplierId) as any;
    if (!supplier) return { success: false, message: 'المورد غير موجود' };

    const operations: any[] = [];
    let dateFilter = '';
    const params: any[] = [];
    if (filters?.fromDate) { dateFilter += ' AND Date >= ?'; params.push(filters.fromDate); }
    if (filters?.toDate) { dateFilter += ' AND Date <= ?'; params.push(filters.toDate); }

    // Purchases (credit - increases supplier balance / we owe them)
    const purchases = db.prepare(`
      SELECT PurchaseID as RefID, PurchaseNumber as RefNumber, Date, 0 as Debit, TotalAmount as Credit,
             'purchase' as OpType, 'فاتورة شراء' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM purchases WHERE SupplierID = ? ${dateFilter}
    `).all(supplierId, ...params);
    operations.push(...purchases);

    // Purchase returns (debit)
    const returns = db.prepare(`
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, r.TotalAmount as Debit, 0 as Credit,
             'purchase_return' as OpType, 'مرتجع مشتريات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      WHERE p.SupplierID = ? ${dateFilter.replace('Date', 'r.Date')}
    `).all(supplierId, ...params);
    operations.push(...returns);

    // Payment vouchers (debit - we pay supplier)
    const payments = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${dateFilter.replace('Date', 'v.Date')}
    `).all(supplierId, ...params);
    operations.push(...payments);

    // Receipt vouchers (credit - supplier refunds us)
    const receipts = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${dateFilter.replace('Date', 'v.Date')}
    `).all(supplierId, ...params);
    operations.push(...receipts);

    operations.sort((a, b) => {
      const dateCompare = new Date(a.Date).getTime() - new Date(b.Date).getTime();
      return dateCompare !== 0 ? dateCompare : (a.RefID - b.RefID);
    });

    let runningBalance = 0;
    for (const op of operations) {
      runningBalance += (op.Credit || 0) - (op.Debit || 0);
      op.Balance = runningBalance;
    }

    const totalDebit = operations.reduce((s, o) => s + (o.Debit || 0), 0);
    const totalCredit = operations.reduce((s, o) => s + (o.Credit || 0), 0);

    return {
      success: true,
      supplier,
      operations,
      totals: {
        totalDebit,
        totalCredit,
        netBalance: totalCredit - totalDebit,
        currentBalance: supplier.Balance,
      },
    };
  });
}
