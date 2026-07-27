import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

export function registerPayrollHandlers() {
  // ===== SALARIES =====
  ipcMain.handle('salaries:list', async (_event, filters?: { employeeId?: number; month?: string }) => {
    const db = getDb();
    let query = `
      SELECT s.*, e.Name as EmployeeName, u.Username
      FROM salaries s
      JOIN employees e ON s.EmployeeID = e.EmployeeID
      JOIN users u ON s.UserID = u.UserID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.employeeId) { query += ' AND s.EmployeeID = ?'; params.push(filters.employeeId); }
    if (filters?.month) { query += ' AND s.Month = ?'; params.push(filters.month); }
    query += ' ORDER BY s.Month DESC, s.SalaryID DESC';
    return db.prepare(query).all(...params);
  });

  // Issue salary (generate) - creates salary record WITHOUT paying
  // Calculates: base + allowances + commissions - deductions - advances
  ipcMain.handle('salaries:issue', async (_event, data: {
    EmployeeID: number; Month: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const emp = db.prepare('SELECT * FROM employees WHERE EmployeeID = ?').get(data.EmployeeID) as any;
    if (!emp) return { success: false, message: 'الموظف غير موجود' };

    // Check if salary already issued for this month
    const existing = db.prepare('SELECT SalaryID FROM salaries WHERE EmployeeID = ? AND Month = ?').get(data.EmployeeID, data.Month) as any;
    if (existing) return { success: false, message: 'تم إصدار راتب هذا الشهر لهذا الموظف بالفعل' };

    // Get unpaid commissions
    const commissions = db.prepare("SELECT * FROM commissions WHERE EmployeeID = ? AND IsPaid = 0").all(data.EmployeeID) as any[];
    const commissionsTotal = commissions.reduce((sum, c) => sum + c.Amount, 0);

    // Get unpaid deductions
    const deductions = db.prepare("SELECT * FROM employee_deductions WHERE EmployeeID = ? AND IsDeducted = 0").all(data.EmployeeID) as any[];
    const deductionsTotal = deductions.reduce((sum, d) => sum + d.Amount, 0);

    // Get unpaid advances
    const advances = db.prepare("SELECT * FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0").all(data.EmployeeID) as any[];
    const advancesTotal = advances.reduce((sum, a) => sum + a.Amount, 0);

    const netSalary = emp.BaseSalary + emp.Allowances + commissionsTotal - deductionsTotal - advancesTotal;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO salaries (EmployeeID, Month, FiscalYearID, BaseSalary, Allowances,
          CommissionsTotal, DeductionsTotal, AdvancesTotal, NetSalary, PaidAmount, Status, UserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
      `).run(
        data.EmployeeID, data.Month, data.fiscalYearId,
        emp.BaseSalary, emp.Allowances,
        commissionsTotal, deductionsTotal, advancesTotal,
        netSalary, data.userId
      );
    });
    tx();

    return {
      success: true,
      details: {
        baseSalary: emp.BaseSalary,
        allowances: emp.Allowances,
        commissions: commissionsTotal,
        deductions: deductionsTotal,
        advances: advancesTotal,
        netSalary,
        commissionCount: commissions.length,
        deductionCount: deductions.length,
        advanceCount: advances.length,
      }
    };
  });

  // Pay salary (issue payment) - marks salary as paid and processes all linked items
  ipcMain.handle('salaries:pay', async (_event, data: {
    SalaryID: number; PaidAmount?: number; CashAccountID?: number;
    userId: number;
  }) => {
    const db = getDb();
    const salary = db.prepare('SELECT * FROM salaries WHERE SalaryID = ?').get(data.SalaryID) as any;
    if (!salary) return { success: false, message: 'الراتب غير موجود' };
    if (salary.Status === 'paid') return { success: false, message: 'تم صرف هذا الراتب بالفعل' };

    const netSalary = salary.NetSalary;
    const paidAmount = data.PaidAmount !== undefined && data.PaidAmount > 0 ? Math.min(data.PaidAmount, netSalary) : netSalary;
    const status = paidAmount >= netSalary ? 'paid' : 'partial';
    const paymentDate = new Date().toISOString().split('T')[0];

    // Check sufficient balance before paying salary (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && data.CashAccountID && paidAmount > 0) {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < paidAmount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لصرف الراتب: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}` };
      }
    }

    const tx = db.transaction(() => {
      // Update salary record
      db.prepare(`
        UPDATE salaries SET PaidAmount = ?, Status = ?, CashAccountID = ?, PaymentDate = ?
        WHERE SalaryID = ?
      `).run(paidAmount, status, data.CashAccountID ?? null, paymentDate, data.SalaryID);

      // Mark commissions as paid
      const commissions = db.prepare("SELECT * FROM commissions WHERE EmployeeID = ? AND IsPaid = 0").all(salary.EmployeeID) as any[];
      for (const c of commissions) {
        db.prepare('UPDATE commissions SET IsPaid = 1, PaidInSalaryID = ?, PaidAmount = ? WHERE CommissionID = ?')
          .run(data.SalaryID, c.Amount, c.CommissionID);
      }

      // Mark deductions as deducted
      const deductions = db.prepare("SELECT * FROM employee_deductions WHERE EmployeeID = ? AND IsDeducted = 0").all(salary.EmployeeID) as any[];
      for (const d of deductions) {
        db.prepare('UPDATE employee_deductions SET IsDeducted = 1, DeductedFromSalaryID = ? WHERE DeductionID = ?').run(data.SalaryID, d.DeductionID);
      }

      // Mark advances as deducted
      const advances = db.prepare("SELECT * FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0").all(salary.EmployeeID) as any[];
      for (const a of advances) {
        db.prepare('UPDATE employee_advances SET IsDeducted = 1, DeductedFromSalaryID = ? WHERE AdvanceID = ?').run(data.SalaryID, a.AdvanceID);
      }

      // Update employee balance
      db.prepare('UPDATE employees SET Balance = Balance + ? WHERE EmployeeID = ?').run(netSalary - paidAmount, salary.EmployeeID);

      // Deduct from cash account
      if (data.CashAccountID && paidAmount > 0) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(paidAmount, data.CashAccountID);
      }
    });

    tx();
    return { success: true, netSalary, paidAmount, status };
  });

  // Get salary details (with breakdown of commissions, deductions, advances)
  ipcMain.handle('salaries:getDetails', async (_event, salaryId: number) => {
    const db = getDb();
    const salary = db.prepare(`
      SELECT s.*, e.Name as EmployeeName, e.Phone as EmployeePhone, e.Position, e.Department
      FROM salaries s
      JOIN employees e ON s.EmployeeID = e.EmployeeID
      WHERE s.SalaryID = ?
    `).get(salaryId) as any;

    if (!salary) return { success: false, message: 'الراتب غير موجود' };

    const commissions = db.prepare(`
      SELECT c.*, 'maintenance' as Type,
        CASE WHEN c.ReferenceType = 'maintenance_delivery' THEN (SELECT DeliveryNumber FROM maintenance_deliveries WHERE DeliveryID = c.ReferenceID) ELSE NULL END as RefNumber
      FROM commissions c WHERE c.EmployeeID = ? AND c.PaidInSalaryID = ?
    `).all(salary.EmployeeID, salaryId) as any[];

    const deductions = db.prepare(`
      SELECT d.*, i.ItemName as DamagedItemName
      FROM employee_deductions d
      LEFT JOIN items i ON d.DamagedItemID = i.ItemID
      WHERE d.EmployeeID = ? AND d.DeductedFromSalaryID = ?
    `).all(salary.EmployeeID, salaryId) as any[];

    const advances = db.prepare(`
      SELECT * FROM employee_advances WHERE EmployeeID = ? AND DeductedFromSalaryID = ?
    `).all(salary.EmployeeID, salaryId) as any[];

    // Pending (not yet in any salary)
    const pendingCommissions = db.prepare(`
      SELECT * FROM commissions WHERE EmployeeID = ? AND IsPaid = 0
    `).all(salary.EmployeeID) as any[];
    const pendingDeductions = db.prepare(`
      SELECT * FROM employee_deductions WHERE EmployeeID = ? AND IsDeducted = 0
    `).all(salary.EmployeeID) as any[];
    const pendingAdvances = db.prepare(`
      SELECT * FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0
    `).all(salary.EmployeeID) as any[];

    return {
      success: true,
      salary,
      commissions,
      deductions,
      advances,
      pending: {
        commissions: pendingCommissions,
        deductions: pendingDeductions,
        advances: pendingAdvances,
      }
    };
  });

  // ===== EMPLOYEE STATEMENT =====
  ipcMain.handle('employeeStatement:get', async (_event, employeeId: number) => {
    const db = getDb();
    const employee = db.prepare('SELECT * FROM employees WHERE EmployeeID = ?').get(employeeId) as any;
    if (!employee) return { success: false, message: 'الموظف غير موجود' };

    const operations: any[] = [];

    // Salaries
    const salaries = db.prepare(`
      SELECT SalaryID as RefID, 'SAL-' || SalaryID as RefNumber, Month, PaymentDate as Date,
             NetSalary as Debit, PaidAmount as Paid, (NetSalary - PaidAmount) as Remaining,
             'salary' as OpType, 'راتب ' || Month as Description,
             BaseSalary, Allowances, CommissionsTotal, DeductionsTotal, AdvancesTotal,
             Status
      FROM salaries WHERE EmployeeID = ?
    `).all(employeeId);
    operations.push(...salaries);

    // Advances
    const advances = db.prepare(`
      SELECT AdvanceID as RefID, 'ADV-' || AdvanceID as RefNumber, Date, Amount as Debit, 0 as Credit,
             'advance' as OpType, 'سلفية' as Description, Reason,
             IsDeducted
      FROM employee_advances WHERE EmployeeID = ?
    `).all(employeeId);
    operations.push(...advances);

    // Commissions
    const commissions = db.prepare(`
      SELECT CommissionID as RefID, 'COM-' || CommissionID as RefNumber, Date, Amount as Credit, 0 as Debit,
             'commission' as OpType,
             CASE WHEN CommissionType = 'sales' THEN 'عمولة مبيعات' WHEN CommissionType = 'maintenance' THEN 'عمولة صيانة' ELSE 'عمولة' END as Description,
             IsPaid, PaidAmount
      FROM commissions WHERE EmployeeID = ?
    `).all(employeeId);
    operations.push(...commissions);

    // Deductions
    const deductions = db.prepare(`
      SELECT DeductionID as RefID, 'DED-' || DeductionID as RefNumber, Date, Amount as Debit, 0 as Credit,
             'deduction' as OpType,
             CASE WHEN Reason = 'absence' THEN 'خصم غياب' WHEN Reason = 'negligence' THEN 'خصم تقصير' WHEN Reason = 'damage' THEN 'خصم إتلاف' ELSE 'خصم' END as Description,
             IsDeducted
      FROM employee_deductions WHERE EmployeeID = ?
    `).all(employeeId);
    operations.push(...deductions);

    // Voucher payments
    const voucherPayments = db.prepare(`
      SELECT VoucherID as RefID, VoucherNumber as RefNumber, Date, Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, Description as Description
      FROM vouchers WHERE PartyType = 'employee' AND PartyID = ? AND VoucherType = 'payment'
    `).all(employeeId);
    operations.push(...voucherPayments);

    const voucherReceipts = db.prepare(`
      SELECT VoucherID as RefID, VoucherNumber as RefNumber, Date, 0 as Debit, Amount as Credit,
             'voucher_receipt' as OpType, Description as Description
      FROM vouchers WHERE PartyType = 'employee' AND PartyID = ? AND VoucherType = 'receipt'
    `).all(employeeId);
    operations.push(...voucherReceipts);

    // Sort by date
    operations.sort((a, b) => {
      const dateA = a.Date || a.Month || '';
      const dateB = b.Date || b.Month || '';
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    });

    // Calculate totals
    const totalSalariesNet = operations.filter(o => o.OpType === 'salary').reduce((s, o) => s + (o.Debit || 0), 0);
    const totalSalariesPaid = operations.filter(o => o.OpType === 'salary').reduce((s, o) => s + (o.Paid || 0), 0);
    const totalSalariesRemaining = totalSalariesNet - totalSalariesPaid;
    const totalAdvances = operations.filter(o => o.OpType === 'advance').reduce((s, o) => s + (o.Debit || 0), 0);
    const totalCommissions = operations.filter(o => o.OpType === 'commission').reduce((s, o) => s + (o.Credit || 0), 0);
    const totalDeductions = operations.filter(o => o.OpType === 'deduction').reduce((s, o) => s + (o.Debit || 0), 0);

    // Pending items
    const pendingCommissions = db.prepare("SELECT COALESCE(SUM(Amount),0) as total FROM commissions WHERE EmployeeID = ? AND IsPaid = 0").get(employeeId) as any;
    const pendingDeductions = db.prepare("SELECT COALESCE(SUM(Amount),0) as total FROM employee_deductions WHERE EmployeeID = ? AND IsDeducted = 0").get(employeeId) as any;
    const pendingAdvances = db.prepare("SELECT COALESCE(SUM(Amount),0) as total FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0").get(employeeId) as any;

    return {
      success: true,
      employee,
      operations,
      totals: {
        totalSalariesNet,
        totalSalariesPaid,
        totalSalariesRemaining,
        totalAdvances,
        totalCommissions,
        totalDeductions,
        pendingCommissions: pendingCommissions.total,
        pendingDeductions: pendingDeductions.total,
        pendingAdvances: pendingAdvances.total,
        currentBalance: employee.Balance,
      },
    };
  });

  // ===== ADVANCES =====
  ipcMain.handle('advances:list', async (_event, employeeId?: number) => {
    const db = getDb();
    let query = `
      SELECT a.*, e.Name as EmployeeName
      FROM employee_advances a
      JOIN employees e ON a.EmployeeID = e.EmployeeID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (employeeId) { query += ' AND a.EmployeeID = ?'; params.push(employeeId); }
    query += ' ORDER BY a.Date DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('advances:create', async (_event, data: {
    EmployeeID: number; Amount: number; Reason?: string;
    CashAccountID: number; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];

    // Check sufficient balance (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1') {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < data.Amount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة للسلفة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
      }
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO employee_advances (EmployeeID, Amount, Date, Reason, CashAccountID, IsDeducted, FiscalYearID, UserID)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(data.EmployeeID, data.Amount, dateStr, data.Reason ?? null, data.CashAccountID, data.fiscalYearId, data.userId);

      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.Amount, data.CashAccountID);
    })();

    return { success: true };
  });

  // ===== DEDUCTIONS =====
  ipcMain.handle('deductions:list', async (_event, employeeId?: number) => {
    const db = getDb();
    let query = `
      SELECT d.*, e.Name as EmployeeName, i.ItemName as DamagedItemName
      FROM employee_deductions d
      JOIN employees e ON d.EmployeeID = e.EmployeeID
      LEFT JOIN items i ON d.DamagedItemID = i.ItemID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (employeeId) { query += ' AND d.EmployeeID = ?'; params.push(employeeId); }
    query += ' ORDER BY d.Date DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('deductions:create', async (_event, data: {
    EmployeeID: number; Amount: number; Reason: string;
    DamagedItemID?: number; DamageCostType?: string;
    Notes?: string; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];

    let amount = data.Amount;
    if (data.Reason === 'damage' && data.DamagedItemID) {
      if (data.DamageCostType === 'cost') {
        const item = db.prepare('SELECT CostPrice FROM items WHERE ItemID = ?').get(data.DamagedItemID) as any;
        amount = item?.CostPrice || amount;
      } else if (data.DamageCostType === 'sale') {
        const item = db.prepare('SELECT SalePrice FROM items WHERE ItemID = ?').get(data.DamagedItemID) as any;
        amount = item?.SalePrice || amount;
      }
    }

    db.prepare(`
      INSERT INTO employee_deductions (EmployeeID, Amount, Date, Reason, DamagedItemID, DamageCostType, IsDeducted, FiscalYearID, UserID, Notes)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(data.EmployeeID, amount, dateStr, data.Reason, data.DamagedItemID ?? null, data.DamageCostType ?? null, data.fiscalYearId, data.userId, data.Notes ?? null);

    return { success: true, amount };
  });
}
