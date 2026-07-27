import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

export function registerReportsHandlers() {
  // Dashboard stats
  ipcMain.handle('reports:dashboard', async () => {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const todaySales = db.prepare("SELECT COALESCE(SUM(PaidAmount),0) as total FROM sales WHERE Date = ? AND IsVoided = 0").get(today) as any;
    const pendingMaintenance = db.prepare("SELECT COUNT(*) as count FROM maintenance_tickets WHERE Status NOT IN ('delivered','cancelled','returned')").get() as any;
    const lowStock = db.prepare("SELECT COUNT(*) as count FROM items WHERE MinStock > 0 AND IsActive = 1 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = items.ItemID) < MinStock").get() as any;
    const cashBalance = db.prepare("SELECT COALESCE(SUM(Balance),0) as total FROM cash_accounts WHERE IsActive = 1").get() as any;

    // Monthly sales chart (last 6 months)
    const monthlySales = db.prepare(`
      SELECT strftime('%Y-%m', Date) as month, COALESCE(SUM(TotalAmount),0) as total
      FROM sales WHERE Date >= date('now','-6 months') AND IsVoided = 0
      GROUP BY month ORDER BY month ASC
    `).all();

    // Recent operations
    const recentSales = db.prepare("SELECT SaleNumber, Date, CustomerName, TotalAmount FROM sales WHERE IsVoided = 0 ORDER BY SaleID DESC LIMIT 5").all();
    const recentMaintenance = db.prepare("SELECT TicketNumber, Date, CustomerName, DeviceModel, Status FROM maintenance_tickets ORDER BY TicketID DESC LIMIT 5").all();

    // Pending installments / overdue maintenance
    const overdueMaintenance = db.prepare("SELECT COUNT(*) as count FROM maintenance_tickets WHERE AgreedDeliveryDate < ? AND Status NOT IN ('delivered','cancelled','returned')").get(today) as any;

    return {
      todaySales: todaySales.total,
      pendingMaintenance: pendingMaintenance.count,
      lowStock: lowStock.count,
      cashBalance: cashBalance.total,
      monthlySales,
      recentSales,
      recentMaintenance,
      overdueMaintenance: overdueMaintenance.count,
    };
  });

  // Sales report - includes all receipt vouchers from the customer (not just linked ones)
  ipcMain.handle('reports:sales', async (_event, filters: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    let query = `
      SELECT s.SaleID, s.SaleNumber, s.Date, s.CustomerID, s.CustomerName,
             s.Subtotal, s.Discount, s.TaxAmount,
             s.TotalAmount, s.PaidAmount, s.RemainingAmount,
             COALESCE((
               SELECT COALESCE(SUM(v.Amount),0)
               FROM vouchers v
               WHERE v.VoucherType = 'receipt'
                 AND (
                   (v.ReferenceType = 'sale' AND v.ReferenceID = s.SaleID)
                   OR (v.PartyType = 'customer' AND v.PartyID = s.CustomerID)
                 )
                 AND v.Date >= s.Date
             ), 0) as LaterPayments,
             (s.RemainingAmount - COALESCE((
               SELECT COALESCE(SUM(v.Amount),0)
               FROM vouchers v
               WHERE v.VoucherType = 'receipt'
                 AND (
                   (v.ReferenceType = 'sale' AND v.ReferenceID = s.SaleID)
                   OR (v.PartyType = 'customer' AND v.PartyID = s.CustomerID)
                 )
                 AND v.Date >= s.Date
             ), 0)) as ActualRemaining,
             s.Status, s.PaymentMethod, u.Username
      FROM sales s
      JOIN users u ON s.UserID = u.UserID
      WHERE s.IsVoided = 0
    `;
    const params: any[] = [];
    if (filters.fromDate) { query += ' AND s.Date >= ?'; params.push(filters.fromDate); }
    if (filters.toDate) { query += ' AND s.Date <= ?'; params.push(filters.toDate); }
    query += ' ORDER BY s.Date DESC';
    const rows = db.prepare(query).all(...params);

    const totals = rows.reduce((acc: any, r: any) => {
      acc.total += r.TotalAmount;
      acc.paid += r.PaidAmount;
      acc.laterPayments += r.LaterPayments || 0;
      acc.remaining += r.ActualRemaining || 0;
      return acc;
    }, { total: 0, paid: 0, laterPayments: 0, remaining: 0 });

    return { rows, totals };
  });

  // Purchases report
  ipcMain.handle('reports:purchases', async (_event, filters: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    let query = `
      SELECT p.PurchaseNumber, p.Date, sup.Name as SupplierName, p.Subtotal, p.Discount,
             p.TaxAmount, p.TotalAmount, p.PaidAmount, p.RemainingAmount, p.Status
      FROM purchases p
      JOIN suppliers sup ON p.SupplierID = sup.SupplierID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters.fromDate) { query += ' AND p.Date >= ?'; params.push(filters.fromDate); }
    if (filters.toDate) { query += ' AND p.Date <= ?'; params.push(filters.toDate); }
    query += ' ORDER BY p.Date DESC';
    const rows = db.prepare(query).all(...params);

    const totals = rows.reduce((acc: any, r: any) => {
      acc.total += r.TotalAmount;
      acc.paid += r.PaidAmount;
      acc.remaining += r.RemainingAmount;
      return acc;
    }, { total: 0, paid: 0, remaining: 0 });

    return { rows, totals };
  });

  // Maintenance report
  ipcMain.handle('reports:maintenance', async (_event, filters: { fromDate?: string; toDate?: string; technicianId?: number }) => {
    const db = getDb();
    let query = `
      SELECT t.TicketNumber, t.Date, t.CustomerName, t.CustomerPhone, t.DeviceModel,
             t.ProblemDesc, t.Status, t.MaintenanceType, t.TotalCost, t.PartsCost, t.LaborCost,
             e.Name as TechnicianName
      FROM maintenance_tickets t
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters.fromDate) { query += ' AND t.Date >= ?'; params.push(filters.fromDate); }
    if (filters.toDate) { query += ' AND t.Date <= ?'; params.push(filters.toDate); }
    if (filters.technicianId) { query += ' AND t.TechnicianID = ?'; params.push(filters.technicianId); }
    query += ' ORDER BY t.Date DESC';
    const rows = db.prepare(query).all(...params);

    const totals = rows.reduce((acc: any, r: any) => {
      acc.totalCost += r.TotalCost || 0;
      acc.partsCost += r.PartsCost || 0;
      acc.laborCost += r.LaborCost || 0;
      return acc;
    }, { totalCost: 0, partsCost: 0, laborCost: 0 });

    return { rows, totals };
  });

  // Customers report (balances)
  ipcMain.handle('reports:customers', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.CustomerID, c.Name, c.Phone, c.Balance, c.Status,
        (SELECT COUNT(*) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) as SalesCount,
        (SELECT COALESCE(SUM(TotalAmount),0) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) as TotalPurchases
      FROM customers c
      ORDER BY c.Balance DESC
    `).all();
    const totals = rows.reduce((acc: any, r: any) => {
      acc.totalBalance += r.Balance;
      acc.totalCustomers++;
      return acc;
    }, { totalBalance: 0, totalCustomers: 0 });
    return { rows, totals };
  });

  // Suppliers report
  ipcMain.handle('reports:suppliers', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT s.SupplierID, s.Name, s.Phone, s.Balance, s.Status,
        (SELECT COUNT(*) FROM purchases WHERE SupplierID = s.SupplierID) as PurchaseCount,
        (SELECT COALESCE(SUM(TotalAmount),0) FROM purchases WHERE SupplierID = s.SupplierID) as TotalPurchases
      FROM suppliers s
      ORDER BY s.Balance DESC
    `).all();
    const totals = rows.reduce((acc: any, r: any) => {
      acc.totalBalance += r.Balance;
      acc.totalSuppliers++;
      return acc;
    }, { totalBalance: 0, totalSuppliers: 0 });
    return { rows, totals };
  });

  // Employees report
  ipcMain.handle('reports:employees', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT e.EmployeeID, e.Name, e.Position, e.Department, e.BaseSalary, e.Allowances, e.Balance,
        (SELECT COUNT(*) FROM salaries WHERE EmployeeID = e.EmployeeID) as SalaryCount,
        (SELECT COALESCE(SUM(PaidAmount),0) FROM salaries WHERE EmployeeID = e.EmployeeID) as TotalPaid,
        (SELECT COALESCE(SUM(Amount),0) FROM commissions WHERE EmployeeID = e.EmployeeID AND IsPaid = 0) as UnpaidCommissions,
        (SELECT COALESCE(SUM(Amount),0) FROM employee_advances WHERE EmployeeID = e.EmployeeID AND IsDeducted = 0) as UnpaidAdvances
      FROM employees e
      WHERE e.IsActive = 1
      ORDER BY e.Name ASC
    `).all();
    return { rows };
  });

  // Inventory report
  ipcMain.handle('reports:inventory', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT i.ItemID, i.ItemName, i.ItemType, i.Barcode, i.SalePrice, i.CostPrice, i.MinStock,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'sold') as SoldSerials,
        i.IsSerialized
      FROM items i
      WHERE i.IsActive = 1
      ORDER BY i.ItemName ASC
    `).all();
    const totals = rows.reduce((acc: any, r: any) => {
      const stockValue = r.IsSerialized ? r.AvailableSerials * (r.CostPrice || 0) : r.TotalStock * (r.CostPrice || 0);
      acc.totalItems++;
      acc.stockValue += stockValue;
      acc.lowStock += r.TotalStock < r.MinStock ? 1 : 0;
      return acc;
    }, { totalItems: 0, stockValue: 0, lowStock: 0 });
    return { rows, totals };
  });

  // Profit & Loss report
  ipcMain.handle('reports:profitLoss', async (_event, filters: { fromDate?: string; toDate?: string }) => {
    const db = getDb();

    // Build an explicit predicate per column instead of string-replacing the
    // word "Date". The old `dateFilter.replace(/Date/g, 't.Date')` approach also
    // rewrote unrelated identifiers (e.g. `PaymentDate` -> `Paymentt.Date`) and
    // produced references to table aliases that did not exist in every query.
    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;
    const df = (col: string) => {
      let sql = '';
      const vals: string[] = [];
      if (from) { sql += ` AND ${col} >= ?`; vals.push(from); }
      if (to) { sql += ` AND ${col} <= ?`; vals.push(to); }
      return { sql, vals };
    };
    // Back-compat aliases used by the queries below.
    const fDate = df('Date');
    const dateFilter = fDate.sql;
    const params = fDate.vals;
    const joinFilterSales = df('s.Date').sql;
    const joinFilterReturn = df('r.Date').sql;
    const joinFilterTicket = df('t.Date').sql;

    // ===== REVENUE (الإيرادات) =====

    // 1. Net Sales = Sales - Sale Returns (exclude voided and warranty invoices)
    // IMPORTANT: maintenance deliveries also write a row into `sales` (Source =
    // 'maintenance') so the customer gets a printable invoice. That same money
    // is reported below as `maintenanceRevenue`, so those rows MUST be excluded
    // here or every maintenance job is counted as revenue twice.
    const salesGross = db.prepare(`SELECT COALESCE(SUM(TotalAmount),0) as total FROM sales WHERE IsVoided = 0 AND IsWarranty = 0 AND COALESCE(Source,'direct') <> 'maintenance' ${dateFilter}`).get(...params) as any;
    const salesReturns = db.prepare(`
      SELECT COALESCE(SUM(r.TotalAmount),0) as total
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      WHERE s.IsVoided = 0 ${joinFilterReturn}
    `).get(...params) as any;
    const netSales = salesGross.total - salesReturns.total;

    // 2. Maintenance Revenue (exclude voided deliveries)
    const maintenanceRevenue = db.prepare(`
      SELECT COALESCE(SUM(TotalCost),0) as total FROM maintenance_deliveries WHERE VoidedSaleID IS NULL ${dateFilter}
    `).get(...params) as any;

    // 3. Maintenance Returns (refunds given to customers - deduct from revenue)
    const maintenanceReturns = db.prepare(`
      SELECT COALESCE(SUM(TotalRefund),0) as total FROM maintenance_returns WHERE 1=1 ${dateFilter}
    `).get(...params) as any;

    // 4. Service Sales Revenue — NET of the principal that merely passes through.
    // For a balance transfer of 100 with a 5 fee the customer pays 105 and we
    // push 100 out of the machine. Only the 5 is our revenue (agent, not
    // principal). Reporting the full 105 inflated turnover enormously for shops
    // that move large transfer volumes.
    const serviceRevenue = db.prepare(`
      SELECT COALESCE(SUM(ChargeAmount - COALESCE(Amount,0)),0) as total FROM service_sales WHERE 1=1 ${dateFilter}
    `).get(...params) as any;
    // Kept for display so the UI can still show gross turnover if desired.
    const serviceGross = db.prepare(`
      SELECT COALESCE(SUM(ChargeAmount),0) as total FROM service_sales WHERE 1=1 ${dateFilter}
    `).get(...params) as any;

    // 5. Other Income (voucher receipts that are general, not customer/supplier payments)
    const otherIncome = db.prepare(`
      SELECT COALESCE(SUM(Amount),0) as total FROM vouchers
      WHERE VoucherType = 'receipt' AND (PartyType = 'general' OR PartyType IS NULL)
      ${dateFilter}
    `).get(...params) as any;

    // 6. Rent Income (rent we receive)
    const rentIncome = db.prepare(`
      SELECT COALESCE(SUM(rp.Amount),0) as total
      FROM rent_payments rp
      JOIN rents r ON rp.RentID = r.RentID
      WHERE rp.Status = 'paid' AND r.RentType = 'income'
      ${filters.fromDate ? 'AND rp.PaidDate >= ?' : ''} ${filters.toDate ? 'AND rp.PaidDate <= ?' : ''}
    `).get(...(filters.fromDate ? [filters.fromDate] : []), ...(filters.toDate ? [filters.toDate] : [])) as any;

    const totalRevenue = netSales + maintenanceRevenue.total - maintenanceReturns.total
      + serviceRevenue.total + otherIncome.total + rentIncome.total;

    // ===== DIRECT COSTS (التكاليف المباشرة) =====

    // 1. Cost of Goods Sold (from sale_details - exclude voided and warranty sales)
    // Maintenance-sourced invoices are excluded here because the cost of the
    // parts they contain is already captured by `partsCost` below (from
    // maintenance_parts). Counting both would deduct the same cost twice.
    const cogs = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0) * sd.Quantity),0) as total
      FROM sale_details sd
      JOIN sales s ON sd.SaleID = s.SaleID
      WHERE s.IsVoided = 0 AND s.IsWarranty = 0 AND COALESCE(s.Source,'direct') <> 'maintenance' ${joinFilterSales}
    `).get(...params) as any;

    // 2. COGS Reversal for Sale Returns (cost of returned items added back to inventory)
    // Must be driven by sale_return_details — joining sale_details on SaleID
    // pulled in EVERY line of the original invoice, so a partial return
    // reversed the cost of the whole invoice.
    const cogsReturns = db.prepare(`
      SELECT COALESCE(SUM(
               COALESCE(
                 (SELECT sd.UnitCost
                    FROM sale_details sd
                   WHERE sd.SaleID = sr.SaleID
                     AND sd.ItemID IS srd.ItemID
                   LIMIT 1),
                 (SELECT i.CostPrice FROM items i WHERE i.ItemID = srd.ItemID),
                 0
               ) * srd.Quantity
             ),0) as total
      FROM sale_return_details srd
      JOIN sale_returns sr ON srd.ReturnID = sr.ReturnID
      WHERE 1=1 ${df('sr.Date').sql}
    `).get(...params) as any;

    // 3. Maintenance Parts Cost (cost of parts from revenue-bearing tickets only — exclude warranty)
    const partsCost = db.prepare(`
      SELECT COALESCE(SUM(mp.TotalCost),0) as total
      FROM maintenance_parts mp
      JOIN maintenance_tickets t ON mp.TicketID = t.TicketID
      WHERE 1=1 ${joinFilterTicket}
      AND t.MaintenanceType NOT IN ('warranty', 'rework')
    `).get(...params) as any;

    // 4. Warranty Parts Consumed (cost of parts used on warranty/rework tickets — absorbed expense)
    const warrantyPartsCost = db.prepare(`
      SELECT COALESCE(SUM(mp.TotalCost),0) as total
      FROM maintenance_parts mp
      JOIN maintenance_tickets t ON mp.TicketID = t.TicketID
      WHERE 1=1 ${joinFilterTicket}
      AND t.MaintenanceType IN ('warranty', 'rework')
    `).get(...params) as any;

    // 4. Service Sales Cost — excludes `Amount` (the pass-through principal),
    // which is now netted out of serviceRevenue above. Only our real costs
    // (provider fee + transfer commission) remain.
    const serviceCost = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)),0) as total
      FROM service_sales WHERE 1=1 ${dateFilter}
    `).get(...params) as any;

    // 5. Purchase Returns value (items returned to supplier - reduces our stock cost basis)
    const purchaseReturnsCost = db.prepare(`
      SELECT COALESCE(SUM(r.TotalAmount),0) as total
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      WHERE 1=1 ${joinFilterReturn}
    `).get(...params) as any;

    const totalDirectCosts = cogs.total - cogsReturns.total + partsCost.total + serviceCost.total;

    // Gross Profit = Revenue - Direct Costs
    const grossProfit = totalRevenue - totalDirectCosts;

    // ===== OPERATING EXPENSES (المصروفات التشغيلية) =====

    // 1. General Expenses (voucher payments that are general)
    // `PartyType = 'rent'` is deliberately EXCLUDED: rent is reported from the
    // rent_payments table below. Including it in both places charged rent twice.
    const generalExpenses = db.prepare(`
      SELECT COALESCE(SUM(Amount),0) as total FROM vouchers
      WHERE VoucherType = 'payment' AND (PartyType = 'general' OR PartyType IS NULL)
      ${dateFilter}
    `).get(...params) as any;

    // 2. Salaries Expense — recognised on an ACCRUAL basis (when the salary is
    // issued), not when it is paid. `PaymentDate` stays NULL until payment, so
    // filtering on it silently dropped issued-but-unpaid salaries from the
    // income statement while the balance sheet still counted them, making the
    // two reports disagree. `Month` is the accrual period ('YYYY-MM').
    const salariesExpense = db.prepare(`
      SELECT COALESCE(SUM(NetSalary),0) as total FROM salaries
      WHERE 1=1
        ${filters.fromDate ? "AND Month >= substr(?,1,7)" : ''}
        ${filters.toDate ? "AND Month <= substr(?,1,7)" : ''}
    `).get(...(filters.fromDate ? [filters.fromDate] : []), ...(filters.toDate ? [filters.toDate] : [])) as any;

    // 3. Rent Expenses (rent we pay out)
    const rentExpenses = db.prepare(`
      SELECT COALESCE(SUM(rp.Amount),0) as total
      FROM rent_payments rp
      JOIN rents r ON rp.RentID = r.RentID
      WHERE rp.Status = 'paid' AND r.RentType = 'expense'
      ${filters.fromDate ? 'AND rp.PaidDate >= ?' : ''} ${filters.toDate ? 'AND rp.PaidDate <= ?' : ''}
    `).get(...(filters.fromDate ? [filters.fromDate] : []), ...(filters.toDate ? [filters.toDate] : [])) as any;

    const totalExpenses = generalExpenses.total + salariesExpense.total + rentExpenses.total + warrantyPartsCost.total;

    // Net Profit = Gross Profit - Operating Expenses
    const netProfit = grossProfit - totalExpenses;

    return {
      revenue: {
        netSales,
        salesGross: salesGross.total,
        salesReturns: salesReturns.total,
        maintenance: maintenanceRevenue.total,
        maintenanceReturns: maintenanceReturns.total,
        services: serviceRevenue.total,
        servicesGross: serviceGross.total,
        otherIncome: otherIncome.total,
        rentIncome: rentIncome.total,
        total: totalRevenue,
      },
      costs: {
        cogs: cogs.total,
        cogsReturns: cogsReturns.total,
        parts: partsCost.total,
        serviceCosts: serviceCost.total,
        // NOTE: warranty parts are an operating EXPENSE (see `expenses` below),
        // they are intentionally NOT part of `total` here. Exposed for display.
        warrantyParts: warrantyPartsCost.total,
        total: totalDirectCosts,
      },
      warrantyExpense: warrantyPartsCost.total,
      grossProfit,
      expenses: {
        general: generalExpenses.total,
        salaries: salariesExpense.total,
        rent: rentExpenses.total,
        warrantyParts: warrantyPartsCost.total,
        total: totalExpenses,
      },
      netProfit,
    };
  });

  // Financial Position (Balance Sheet)
  ipcMain.handle('reports:financialPosition', async () => {
    const db = getDb();

    // === ASSETS ===
    const cashAccounts = db.prepare('SELECT AccountName, AccountType, Balance FROM cash_accounts WHERE IsActive = 1').all() as any[];
    const totalCash = cashAccounts.reduce((s, c) => s + c.Balance, 0);

    const paymentMethods = db.prepare('SELECT MethodName, MethodType, Balance FROM payment_methods WHERE IsActive = 1').all() as any[];
    const totalPaymentMethods = paymentMethods.reduce((s, p) => s + p.Balance, 0);

    const customers = db.prepare('SELECT Name, Balance FROM customers WHERE Balance > 0').all() as any[];
    const totalCustomers = customers.reduce((s, c) => s + c.Balance, 0);

    const inventory = db.prepare(`
      SELECT i.ItemName, i.IsSerialized,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as Qty,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
        (SELECT COALESCE(SUM(CostPrice * Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as StockValue,
        i.CostPrice
      FROM items i WHERE i.IsActive = 1
        AND ((SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) > 0
             OR (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') > 0)
    `).all() as any[];
    const totalInventory = inventory.reduce((s, i) => {
      if (i.IsSerialized) return s + (i.AvailableSerials * (i.CostPrice || 0));
      return s + i.StockValue;
    }, 0);

    // Employee advances (cash advanced to employees = asset)
    const employeeAdvancesBalance = db.prepare(
      `SELECT COALESCE(SUM(Amount),0) as total FROM employee_advances WHERE IsDeducted = 0`
    ).get() as any;

    const totalAssets = totalCash + totalPaymentMethods + totalCustomers + totalInventory + employeeAdvancesBalance.total;

    // === LIABILITIES ===
    const suppliers = db.prepare('SELECT Name, Balance FROM suppliers WHERE Balance > 0').all() as any[];
    const totalSuppliers = suppliers.reduce((s, c) => s + c.Balance, 0);

    const employees = db.prepare('SELECT Name, Balance FROM employees WHERE IsActive = 1 AND Balance > 0').all() as any[];
    const totalEmployees = employees.reduce((s, e) => s + e.Balance, 0);

    // Customers with credit (negative balances = we owe them)
    const customerCredits = db.prepare('SELECT Name, Balance FROM customers WHERE Balance < 0').all() as any[];
    const totalCustomerCredits = customerCredits.reduce((s, c) => s + Math.abs(c.Balance), 0);

    const totalLiabilities = totalSuppliers + totalEmployees + totalCustomerCredits;

    // === CAPITAL (Owner's Equity) ===
    const capitalSetting = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
    const explicitCapital = capitalSetting ? parseFloat(capitalSetting.Value) : 0;

    // Net profit - using SAME methodology as P&L (all-time, exclude voided/warranty)
    // Maintenance-sourced sales rows are excluded (counted via maintenance_deliveries),
    // and service revenue is net of the pass-through principal — mirroring reports:profitLoss.
    const salesRevenue = db.prepare("SELECT COALESCE(SUM(TotalAmount),0) as total FROM sales WHERE IsVoided = 0 AND IsWarranty = 0 AND COALESCE(Source,'direct') <> 'maintenance'").get() as any;
    const salesReturns = db.prepare('SELECT COALESCE(SUM(r.TotalAmount),0) as total FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID WHERE s.IsVoided = 0').get() as any;
    const maintenanceRevenue = db.prepare('SELECT COALESCE(SUM(TotalCost),0) as total FROM maintenance_deliveries WHERE VoidedSaleID IS NULL').get() as any;
    const maintenanceReturns = db.prepare('SELECT COALESCE(SUM(TotalRefund),0) as total FROM maintenance_returns').get() as any;
    const serviceRevenue = db.prepare('SELECT COALESCE(SUM(ChargeAmount - COALESCE(Amount,0)),0) as total FROM service_sales').get() as any;
    const otherIncome = db.prepare("SELECT COALESCE(SUM(Amount),0) as total FROM vouchers WHERE VoucherType='receipt' AND (PartyType='general' OR PartyType IS NULL)").get() as any;
    const rentIncomeAll = db.prepare("SELECT COALESCE(SUM(rp.Amount),0) as total FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID WHERE rp.Status='paid' AND r.RentType='income'").get() as any;

    const cogs = db.prepare("SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0) * sd.Quantity),0) as total FROM sale_details sd JOIN sales s ON sd.SaleID = s.SaleID WHERE s.IsVoided = 0 AND s.IsWarranty = 0 AND COALESCE(s.Source,'direct') <> 'maintenance'").get() as any;
    const partsCost = db.prepare(`
      SELECT COALESCE(SUM(mp.TotalCost),0) as total
      FROM maintenance_parts mp
      JOIN maintenance_tickets t ON mp.TicketID = t.TicketID
      WHERE t.MaintenanceType NOT IN ('warranty', 'rework')
    `).get() as any;
    const warrantyPartsCost = db.prepare(`
      SELECT COALESCE(SUM(mp.TotalCost),0) as total
      FROM maintenance_parts mp
      JOIN maintenance_tickets t ON mp.TicketID = t.TicketID
      WHERE t.MaintenanceType IN ('warranty', 'rework')
    `).get() as any;
    // `Amount` excluded — it is the pass-through principal, already netted out
    // of serviceRevenue above (agent vs principal).
    const serviceCost = db.prepare("SELECT COALESCE(SUM(COALESCE(ServiceCost,0)+COALESCE(TransferCost,0)),0) as total FROM service_sales").get() as any;

    // PartyType='rent' excluded here — rent comes from rent_payments below.
    const generalExpenses = db.prepare("SELECT COALESCE(SUM(Amount),0) as total FROM vouchers WHERE VoucherType='payment' AND (PartyType='general' OR PartyType IS NULL)").get() as any;
    const salariesExpense = db.prepare('SELECT COALESCE(SUM(NetSalary),0) as total FROM salaries').get() as any;
    const rentExpenses = db.prepare("SELECT COALESCE(SUM(rp.Amount),0) as total FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID WHERE rp.Status='paid' AND r.RentType='expense'").get() as any;

    const netRevenue = salesRevenue.total - salesReturns.total + maintenanceRevenue.total - maintenanceReturns.total
      + serviceRevenue.total + otherIncome.total + rentIncomeAll.total;
    const totalCosts = cogs.total + partsCost.total + serviceCost.total;
    const totalExpenses = generalExpenses.total + salariesExpense.total + rentExpenses.total + warrantyPartsCost.total;
    const netProfit = netRevenue - totalCosts - totalExpenses;

    // === BALANCE CHECK ===
    // Accounting identity: Assets = Liabilities + Equity.
    // `equity` is what the books say (capital contributed + profit earned);
    // `difference` is the unexplained gap. It should be 0 — any other value
    // means balances drifted (e.g. an opening balance edited without a matching
    // capital entry) and must be investigated rather than silently hidden.
    const equity = explicitCapital + netProfit;
    const balanceCheck = totalAssets - totalLiabilities;
    const retainedEarnings = balanceCheck - explicitCapital;
    const difference = +(totalAssets - (totalLiabilities + equity)).toFixed(2);
    const isBalanced = Math.abs(difference) < 0.01;
    const calculatedCapital = equity;

    return {
      assets: {
        cashAccounts, totalCash,
        paymentMethods, totalPaymentMethods,
        customers, totalCustomers,
        employeeAdvances: employeeAdvancesBalance.total,
        inventory: inventory.map(i => ({
          ItemName: i.ItemName,
          Qty: i.IsSerialized ? i.AvailableSerials : i.Qty,
          Value: i.IsSerialized ? i.AvailableSerials * (i.CostPrice || 0) : i.StockValue,
        })),
        totalInventory,
        totalAssets,
      },
      liabilities: {
        suppliers, totalSuppliers,
        employees, totalEmployees,
        customerCredits, totalCustomerCredits,
        totalLiabilities,
      },
      capital: {
        explicitCapital,
        netProfit,
        calculatedCapital,
        retainedEarnings,
        balanceCheck,
        warrantyPartsCost: warrantyPartsCost.total,
        // Self-check so the report can surface drift instead of hiding it.
        equity,
        difference,
        isBalanced,
      },
    };
  });

  // Get/Set owner capital
  ipcMain.handle('capital:get', async () => {
    const db = getDb();
    const row = db.prepare("SELECT Value FROM settings WHERE Key = 'owner_capital'").get() as any;
    return row ? parseFloat(row.Value) : 0;
  });

  ipcMain.handle('capital:set', async (_event, amount: number) => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('owner_capital', ?)").run(amount.toString());
    return { success: true };
  });

  // ===== OPERATIONS LOG (comprehensive chronological log) =====
  ipcMain.handle('operations:log', async (_event, filters?: { fromDate?: string; toDate?: string; limit?: number }) => {
    const db = getDb();
    const rawLimit = Number(filters?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 5000) : 200;

    // SECURITY: dates are bound as parameters, never interpolated. The previous
    // implementation spliced `filters.fromDate` straight into the SQL string,
    // which allowed SQL injection through the IPC channel.
    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;

    /** Builds a `WHERE`/`AND` date predicate plus the matching bound values. */
    const df = (field: string, keyword: 'WHERE' | 'AND' = 'WHERE') => {
      const parts: string[] = [];
      const vals: string[] = [];
      if (from) { parts.push(`${field} >= ?`); vals.push(from); }
      if (to) { parts.push(`${field} <= ?`); vals.push(to); }
      return { sql: parts.length ? `${keyword} ${parts.join(' AND ')}` : '', vals };
    };

    const ops: any[] = [];
    const run = (sql: string, vals: string[]) => ops.push(...db.prepare(sql).all(...vals));

    // Sales (exclude maintenance-generated invoices — the delivery itself is logged)
    {
      const f = df('Date', 'AND');
      run(`
        SELECT Date, SaleNumber as RefNum, CustomerName as Party, TotalAmount as Amount,
          'فاتورة بيع' as OpType, 'sale' as OpKey, SaleID as RefID
        FROM sales WHERE IsVoided = 0 AND COALESCE(Source,'direct') <> 'maintenance' ${f.sql}
      `, f.vals);
    }

    // Sale returns — join through `sales` to reach the customer.
    // The old query joined `customers c ON r.SaleID = c.CustomerID`, matching an
    // invoice id against a customer id and showing the wrong customer name.
    {
      const f = df('r.Date');
      run(`
        SELECT r.Date, r.ReturnNumber as RefNum, c.Name as Party, r.TotalAmount as Amount,
          'مرتجع مبيعات' as OpType, 'sale_return' as OpKey, r.ReturnID as RefID
        FROM sale_returns r
        JOIN sales s ON r.SaleID = s.SaleID
        LEFT JOIN customers c ON s.CustomerID = c.CustomerID
        ${f.sql}
      `, f.vals);
    }

    // Purchases
    {
      const f = df('p.Date');
      run(`
        SELECT p.Date, p.PurchaseNumber as RefNum, s.Name as Party, p.TotalAmount as Amount,
          'فاتورة شراء' as OpType, 'purchase' as OpKey, p.PurchaseID as RefID
        FROM purchases p JOIN suppliers s ON p.SupplierID = s.SupplierID ${f.sql}
      `, f.vals);
    }

    // Purchase returns
    {
      const f = df('r.Date');
      run(`
        SELECT r.Date, r.ReturnNumber as RefNum, s.Name as Party, r.TotalAmount as Amount,
          'مرتجع مشتريات' as OpType, 'purchase_return' as OpKey, r.ReturnID as RefID
        FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID
        JOIN suppliers s ON p.SupplierID = s.SupplierID ${f.sql}
      `, f.vals);
    }

    // Maintenance tickets received
    {
      const f = df('Date');
      run(`
        SELECT Date, TicketNumber as RefNum, CustomerName as Party, 0 as Amount,
          'استقبال صيانة' as OpType, 'maintenance_receive' as OpKey, TicketID as RefID
        FROM maintenance_tickets ${f.sql}
      `, f.vals);
    }

    // Maintenance deliveries
    {
      const f = df('Date');
      run(`
        SELECT Date, DeliveryNumber as RefNum, CustomerName as Party, TotalCost as Amount,
          'تسليم صيانة' as OpType, 'maintenance_delivery' as OpKey, DeliveryID as RefID
        FROM maintenance_deliveries ${f.sql}
      `, f.vals);
    }

    // Maintenance returns
    {
      const f = df('r.Date');
      run(`
        SELECT r.Date, r.ReturnNumber as RefNum, d.CustomerName as Party, r.TotalRefund as Amount,
          'مرتجع صيانة' as OpType, 'maintenance_return' as OpKey, r.ReturnID as RefID
        FROM maintenance_returns r JOIN maintenance_deliveries d ON r.DeliveryID = d.DeliveryID ${f.sql}
      `, f.vals);
    }

    // Vouchers
    {
      const f = df('Date');
      run(`
        SELECT Date, VoucherNumber as RefNum, PartyName as Party, Amount as Amount,
          CASE WHEN VoucherType='receipt' THEN 'سند قبض' ELSE 'سند صرف' END as OpType,
          VoucherType as OpKey, VoucherID as RefID
        FROM vouchers ${f.sql}
      `, f.vals);
    }

    // Service sales
    {
      const f = df('Date');
      run(`
        SELECT Date, ServiceNumber as RefNum, CustomerName as Party, ChargeAmount as Amount,
          'خدمة' as OpType, 'service_sale' as OpKey, ServiceSaleID as RefID
        FROM service_sales ${f.sql}
      `, f.vals);
    }

    // Salaries
    {
      const f = df('s.PaymentDate', 'AND');
      run(`
        SELECT s.PaymentDate as Date, 'SAL-' || s.SalaryID as RefNum, e.Name as Party, s.PaidAmount as Amount,
          'راتب' as OpType, 'salary' as OpKey, s.SalaryID as RefID
        FROM salaries s JOIN employees e ON s.EmployeeID = e.EmployeeID
        WHERE s.PaidAmount > 0 ${f.sql}
      `, f.vals);
    }

    // Sort by date descending, limit
    // Guard against NULL dates (e.g. an unpaid salary) which would throw on .localeCompare
    ops.sort((a, b) => String(b.Date ?? '').localeCompare(String(a.Date ?? '')));
    return ops.slice(0, limit);
  });
}
