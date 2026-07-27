import { ipcMain } from 'electron';
import { getDb } from '../database/connection';


export function registerStatementHandlers() {
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

    // SECURITY: dates are bound parameters. Previously they were interpolated
    // directly into the SQL text, which was an injection vector reachable from
    // the renderer via window.api.invoke('cashAccount:statement', ...).
    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;

    /**
     * Returns an `AND ...` predicate for `field` plus the values to bind.
     * The caller composes the final argument list so ordering stays correct.
     */
    const df = (field: string) => {
      const parts: string[] = [];
      const vals: string[] = [];
      if (from) { parts.push(`${field} >= ?`); vals.push(from); }
      if (to) { parts.push(`${field} <= ?`); vals.push(to); }
      return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', vals };
    };

    const operations: any[] = [];
    /** Runs a query whose first bind is the account id, followed by date values. */
    const q = (sql: string, f: { sql: string; vals: string[] }) =>
      db.prepare(sql).all(accountId, ...f.vals) as any[];

    // Sales (money coming IN) — exclude maintenance invoices; the delivery row
    // below already carries the cash movement for those.
    const fSales = df('Date');
    const sales = q(`
      SELECT Date, SaleNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
        0 as OutAmount, 'sale' as OpType, 'فاتورة بيع' as OpLabel, SaleID as RefID
      FROM sales
      WHERE CashAccountID = ? AND PaidAmount > 0 AND IsVoided = 0
        AND COALESCE(Source,'direct') <> 'maintenance' ${fSales.sql}
    `, fSales);

    // Sale returns (money going OUT)
    const fRets = df('r.Date');
    const rets = q(`
      SELECT r.Date, r.ReturnNumber as RefNumber, c.Name as Party, 0 as InAmount,
        r.TotalAmount as OutAmount, 'return' as OpType, 'مرتجع مبيعات' as OpLabel, r.ReturnID as RefID
      FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${fRets.sql}
    `, fRets);

    // Voucher receipts (money IN)
    const fVR = df('Date');
    const vReceipts = q(`
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, Amount as InAmount,
        0 as OutAmount, 'voucher_receipt' as OpType, 'سند قبض' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'receipt' AND Amount > 0 ${fVR.sql}
    `, fVR);

    // Voucher payments (money OUT)
    const fVP = df('Date');
    const vPayments = q(`
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, 0 as InAmount,
        Amount as OutAmount, 'voucher_payment' as OpType, 'سند صرف' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'payment' AND Amount > 0 ${fVP.sql}
    `, fVP);

    // Purchases (money OUT)
    // FIX: the column is `PaymentSource`, not `PaymentSourceType`. The old query
    // threw "no such column" on every call, so this whole statement was broken.
    const fPur = df('p.Date');
    const purchases = q(`
      SELECT p.Date, p.PurchaseNumber as RefNumber, s.Name as Party, 0 as InAmount,
        p.PaidAmount as OutAmount, 'purchase' as OpType, 'فاتورة شراء' as OpLabel, p.PurchaseID as RefID
      FROM purchases p JOIN suppliers s ON p.SupplierID = s.SupplierID
      WHERE p.PaymentSource = 'cash_account' AND p.PaymentSourceID = ? AND p.PaidAmount > 0 ${fPur.sql}
    `, fPur);

    // Purchase returns (money IN)
    const fPR = df('r.Date');
    const purRets = q(`
      SELECT r.Date, r.ReturnNumber as RefNumber, s.Name as Party, r.TotalAmount as InAmount,
        0 as OutAmount, 'purchase_return' as OpType, 'مرتجع مشتريات' as OpLabel, r.ReturnID as RefID
      FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID
      JOIN suppliers s ON p.SupplierID = s.SupplierID
      WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${fPR.sql}
    `, fPR);

    // Salaries (money OUT)
    const fSal = df('s.PaymentDate');
    const salaries = q(`
      SELECT s.PaymentDate as Date, 'SAL-' || s.SalaryID as RefNumber, e.Name as Party, 0 as InAmount,
        s.PaidAmount as OutAmount, 'salary' as OpType, 'راتب' as OpLabel, s.SalaryID as RefID
      FROM salaries s JOIN employees e ON s.EmployeeID = e.EmployeeID
      WHERE s.CashAccountID = ? AND s.PaidAmount > 0 ${fSal.sql}
    `, fSal);

    // Advances (money OUT)
    const fAdv = df('a.Date');
    const advances = q(`
      SELECT a.Date, 'ADV-' || a.AdvanceID as RefNumber, e.Name as Party, 0 as InAmount,
        a.Amount as OutAmount, 'advance' as OpType, 'سلفة' as OpLabel, a.AdvanceID as RefID
      FROM employee_advances a JOIN employees e ON a.EmployeeID = e.EmployeeID
      WHERE a.CashAccountID = ? AND a.Amount > 0 ${fAdv.sql}
    `, fAdv);

    // Maintenance deliveries (money IN)
    const fMD = df('Date');
    const maintDel = q(`
      SELECT Date, DeliveryNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
        0 as OutAmount, 'maintenance_delivery' as OpType, 'تسليم صيانة' as OpLabel, DeliveryID as RefID
      FROM maintenance_deliveries WHERE CashAccountID = ? AND PaidAmount > 0 ${fMD.sql}
    `, fMD);

    // Maintenance returns (money OUT)
    const fMR = df('r.Date');
    const maintRets = q(`
      SELECT r.Date, r.ReturnNumber as RefNumber, d.CustomerName as Party, 0 as InAmount,
        r.TotalRefund as OutAmount, 'maintenance_return' as OpType, 'مرتجع صيانة' as OpLabel, r.ReturnID as RefID
      FROM maintenance_returns r
      JOIN maintenance_deliveries d ON r.DeliveryID = d.DeliveryID
      WHERE r.CashAccountID = ? AND r.TotalRefund > 0 ${fMR.sql}
    `, fMR);

    // Rent payments (expense = OUT, income = IN)
    // FIX: `rents` has no PropertyName column — the correct column is RentName.
    const fRent = df('rp.PaidDate');
    const rents = q(`
      SELECT rp.PaidDate as Date, 'RNT-' || rp.RentPaymentID as RefNumber, r.RentName as Party,
        CASE WHEN r.RentType = 'income' THEN rp.Amount ELSE 0 END as InAmount,
        CASE WHEN r.RentType = 'expense' THEN rp.Amount ELSE 0 END as OutAmount,
        'rent' as OpType, CASE WHEN r.RentType = 'income' THEN 'إيجار وارد' ELSE 'إيجار منصرف' END as OpLabel,
        rp.RentPaymentID as RefID
      FROM rent_payments rp JOIN rents r ON rp.RentID = r.RentID
      WHERE rp.CashAccountID = ? AND rp.Status = 'paid' ${fRent.sql}
    `, fRent);

    // Service sales (money IN)
    const fSrv = df('Date');
    const services = q(`
      SELECT Date, ServiceNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
        0 as OutAmount, 'service_sale' as OpType, 'خدمة' as OpLabel, ServiceSaleID as RefID
      FROM service_sales WHERE CashAccountID = ? AND PaidAmount > 0 ${fSrv.sql}
    `, fSrv);

    // Asset transfers (IN or OUT depending on direction)
    const fTIn = df('Date');
    const transfersIn = q(`
      SELECT Date, TransferNumber as RefNumber, '' as Party,
        ReceivedAmount as InAmount, 0 as OutAmount,
        'transfer_in' as OpType, 'تحويل وارد' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE ToType = 'cash_account' AND ToID = ? ${fTIn.sql}
    `, fTIn);

    // Only the separately-funded commission leaves the source account on top of
    // the transferred amount; when the fee is taken from the amount it is already
    // included in `Amount`.
    const fTOut = df('Date');
    const transfersOut = q(`
      SELECT Date, TransferNumber as RefNumber, '' as Party, 0 as InAmount,
        (Amount + CASE WHEN TransferCostSource = 'separate' THEN TransferCost ELSE 0 END) as OutAmount,
        'transfer_out' as OpType, 'تحويل صادر' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE FromType = 'cash_account' AND FromID = ? ${fTOut.sql}
    `, fTOut);

    operations.push(
      ...sales, ...rets, ...vReceipts, ...vPayments, ...purchases, ...purRets,
      ...salaries, ...advances, ...maintDel, ...maintRets, ...rents, ...services,
      ...transfersIn, ...transfersOut
    );

    // Sort by date (NULL-safe)
    operations.sort((a, b) => String(a.Date ?? '').localeCompare(String(b.Date ?? '')));

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
}

export function registerCustomerStatementHandlers() {
  // Full customer statement - all operations in chronological order
  ipcMain.handle('customerStatement:get', async (_event, customerId: number, filters?: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    const customer = db.prepare('SELECT * FROM customers WHERE CustomerID = ?').get(customerId) as any;
    if (!customer) return { success: false, message: 'العميل غير موجود' };

    const operations: any[] = [];

    // Build a date predicate per column.
    // The old code built one string with a literal `Date` column and then used
    // String.replace('Date', 'r.Date'), which only substitutes the FIRST match —
    // so with both from/to set the second `Date` stayed unqualified and the
    // JOIN queries failed with "ambiguous column name".
    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;
    const df = (col: string) => {
      let sql = '';
      const vals: string[] = [];
      if (from) { sql += ` AND ${col} >= ?`; vals.push(from); }
      if (to) { sql += ` AND ${col} <= ?`; vals.push(to); }
      return { sql, vals };
    };

    const fSales = df('Date');
    const fRet = df('r.Date');
    const fDel = df('d.Date');
    const fVR = df('v.Date');
    const fVP = df('v.Date');

    // Sales (debit = full invoice amount, credit = amount paid at time of sale)
    const sales = db.prepare(`
      SELECT SaleID as RefID, SaleNumber as RefNumber, Date,
             TotalAmount as Debit,
             PaidAmount as Credit,
             'sale' as OpType,
             'فاتورة بيع' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM sales WHERE CustomerID = ? AND IsVoided = 0 ${fSales.sql}
    `).all(customerId, ...fSales.vals);
    operations.push(...sales);

    // Sale returns (credit - decreases customer balance)
    const returns = db.prepare(`
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, 0 as Debit, r.TotalAmount as Credit,
             'sale_return' as OpType, 'مرتجع مبيعات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      WHERE s.CustomerID = ? ${fRet.sql}
    `).all(customerId, ...fRet.vals);
    operations.push(...returns);

    // Maintenance deliveries (debit = total cost, credit = amount paid at delivery)
    const deliveries = db.prepare(`
      SELECT d.DeliveryID as RefID, d.DeliveryNumber as RefNumber, d.Date,
             d.TotalCost as Debit,
             d.PaidAmount as Credit,
             'maintenance_delivery' as OpType, 'تسليم صيانة' as Description,
             d.PaymentMethod, d.PaidAmount, d.RemainingAmount, NULL as Status
      FROM maintenance_deliveries d
      WHERE d.CustomerID = ? AND d.VoidedSaleID IS NULL ${fDel.sql}
    `).all(customerId, ...fDel.vals);
    operations.push(...deliveries);

    // Receipt vouchers (credit - customer pays, reduces balance)
    const receipts = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${fVR.sql}
    `).all(customerId, ...fVR.vals);
    operations.push(...receipts);

    // Payment vouchers (debit - refund to customer)
    const payments = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${fVP.sql}
    `).all(customerId, ...fVP.vals);
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
    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;
    const df = (col: string) => {
      let sql = '';
      const vals: string[] = [];
      if (from) { sql += ` AND ${col} >= ?`; vals.push(from); }
      if (to) { sql += ` AND ${col} <= ?`; vals.push(to); }
      return { sql, vals };
    };
    const fPur = df('Date');
    const fPRet = df('r.Date');
    const fVPay = df('v.Date');
    const fVRec = df('v.Date');

    // Purchases (credit - increases supplier balance / we owe them)
    const purchases = db.prepare(`
      SELECT PurchaseID as RefID, PurchaseNumber as RefNumber, Date, 0 as Debit, TotalAmount as Credit,
             'purchase' as OpType, 'فاتورة شراء' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM purchases WHERE SupplierID = ? ${fPur.sql}
    `).all(supplierId, ...fPur.vals);
    operations.push(...purchases);

    // Purchase returns (debit)
    const returns = db.prepare(`
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, r.TotalAmount as Debit, 0 as Credit,
             'purchase_return' as OpType, 'مرتجع مشتريات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      WHERE p.SupplierID = ? ${fPRet.sql}
    `).all(supplierId, ...fPRet.vals);
    operations.push(...returns);

    // Payment vouchers (debit - we pay supplier)
    const payments = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${fVPay.sql}
    `).all(supplierId, ...fVPay.vals);
    operations.push(...payments);

    // Receipt vouchers (credit - supplier refunds us)
    const receipts = db.prepare(`
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${fVRec.sql}
    `).all(supplierId, ...fVRec.vals);
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
