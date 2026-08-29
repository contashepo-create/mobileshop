import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday, resolveDocDate } from '../../shared/businessDate';
import { checkAmount, checkAmounts } from '../../shared/money';
import { requireId, optionalText, optionalId, LIMITS } from '../../shared/validate';

/**
 * Confirms a payroll record names a real employee and a real cash box.
 *
 * MEASURED before this existed: `EmployeeID: 99999` threw
 * "FOREIGN KEY constraint failed" out of the transaction. The IPC guard turns
 * that into the generic "تعذّر تنفيذ العملية - راجع سجل الأخطاء", so the
 * person at the till is told the operation failed and not which field is
 * wrong. A stale id is ordinary: a second terminal deactivating an employee
 * while this one has the form open produces exactly it.
 */
function checkPayrollParties(
  db: ReturnType<typeof getDb>,
  employeeId: unknown,
  cashAccountId?: unknown,
): { ok: true; employeeId: number; cashAccountId: number | null } | { ok: false; message: string } {
  const emp = requireId(employeeId, 'الموظف');
  if (!emp.ok) return { ok: false, message: emp.message };
  const exists = db.prepare('SELECT 1 AS ok FROM employees WHERE EmployeeID = ?').get(emp.value);
  if (!exists) return { ok: false, message: 'الموظف غير موجود' };

  let cash: number | null = null;
  if (cashAccountId !== undefined) {
    const c = optionalId(cashAccountId, 'الخزينة');
    if (!c.ok) return { ok: false, message: c.message };
    if (c.value !== null) {
      const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(c.value) as any;
      if (!acc) return { ok: false, message: 'الخزينة غير موجودة' };
      // A DEACTIVATED drawer must not hand money out. The purchases flow has
      // refused it for the same reason; without the check a stale form could
      // advance wages through the very drawer the screen hides. Measured: a
      // deactivated drawer paid out a 500 advance.
      if (acc.IsActive !== 1) return { ok: false, message: 'الخزنة المختارة غير مفعّلة' };
    }
    cash = c.value;
  }
  return { ok: true, employeeId: emp.value, cashAccountId: cash };
}

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
  //
  // An advance is settled MANUALLY: the issue form shows every open advance and
  // a value to deduct from each (any amount, zero leaves it open). The caller
  // sends that as `deductAmounts`; the engine validates every amount against
  // the advance's remaining balance and refuses when the SUM exceeds what this
  // month's pay can absorb (net >= 0). Without `deductAmounts` the historical
  // automatic behaviour is kept — settle the oldest advances first, up to the
  // cap — so old callers and the verification suites are unchanged.
  ipcMain.handle('salaries:issue', async (_event, data: {
    EmployeeID: number; Month: string;
    userId: number; fiscalYearId: number;
    deductAmounts?: Array<{ AdvanceID: number; Amount: number }>;
  }) => {
    const db = getDb();
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const issueEmp = requireId(data?.EmployeeID, 'رقم الموظف');
    if (!issueEmp.ok) return { success: false, message: issueEmp.message };
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

    // A month's pay can never be a negative number.
    //
    // Advances and deductions were subtracted without a floor, so an employee
    // who had drawn more than the month's wage produced a salary of
    // -611.47 — which the shop could then "pay", running the whole transaction
    // backwards: cash flowed INTO the drawer and the employee's balance moved
    // the wrong way. Measured by the fuzzer on seed 12.
    //
    // Only as much of the advance as this month's pay can absorb is settled
    // here; the rest stays outstanding and is recovered from the next salary,
    // which is both the correct accounting and what the employee expects.
    const grossPay = emp.BaseSalary + emp.Allowances + commissionsTotal;
    const payAfterDeductions = Math.max(0, grossPay - deductionsTotal);

    // `advancesTotal` is the SUM of every open advance — what the screen shows
    // as still owed, and what the statement reports. `advancesApplied` is how
    // much THIS salary actually settles, which is the figure that lands in the
    // row and on the balance sheet. The two differ whenever the month cannot
    // absorb everything, and in manual mode they are independent by design.
    const manual = Array.isArray(data?.deductAmounts) && data.deductAmounts.length > 0;

    // Each amount is checked against the LIVE advance before anything moves. A
    // requested deduction is capped by the advance's remaining balance (never
    // more than the employee actually owes), and the SUM is capped by this
    // month's net — the same zero-floor guarantee the automatic path has. The
    // amounts are validated here, then re-applied against fresh rows inside the
    // transaction so a rival till cannot slip an already-settled advance in.
    let advancesApplied: number;
    const requested: Array<{ AdvanceID: number; Amount: number }> = [];
    if (manual) {
      const open = db.prepare(
        'SELECT AdvanceID, Amount FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0',
      ).all(data.EmployeeID) as any[];
      let sum = 0;
      for (const entry of data.deductAmounts!) {
        const advId = requireId(entry?.AdvanceID, 'رقم السلفة');
        if (!advId.ok) return { success: false, message: advId.message };
        const amt = checkAmount(entry?.Amount, 'قيمة خصم السلفة', { allowZero: true });
        if (!amt.ok) return { success: false, message: amt.message };
        const live = open.find(a => Number(a.AdvanceID) === advId.value);
        if (!live) {
          return { success: false, message: 'السلفة غير موجودة أو تم خصمها بالفعل' };
        }
        if (amt.value > Number(live.Amount) + 0.005) {
          return {
            success: false,
            message: `قيمة الخصم تتجاوز الرصيد المتبقي للسلفة (${Number(live.Amount).toFixed(2)})`,
          };
        }
        requested.push({ AdvanceID: advId.value, Amount: +amt.value.toFixed(2) });
        sum += amt.value;
      }
      const totalRequested = +sum.toFixed(2);
      if (totalRequested > payAfterDeductions + 0.005) {
        return {
          success: false,
          message: `مجموع خصم السلف (${totalRequested.toFixed(2)}) يتجاوز الصافي المتاح بعد البدلات والعمولات والخصومات (${payAfterDeductions.toFixed(2)})`,
        };
      }
      advancesApplied = totalRequested;
    } else {
      advancesApplied = Math.min(advancesTotal, payAfterDeductions);
    }
    const netSalary = +(payAfterDeductions - advancesApplied).toFixed(2);

    const tx = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO salaries (EmployeeID, Month, FiscalYearID, BaseSalary, Allowances,
          CommissionsTotal, DeductionsTotal, AdvancesTotal, NetSalary, PaidAmount, Status, UserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
      `).run(
        data.EmployeeID, data.Month, data.fiscalYearId,
        emp.BaseSalary, emp.Allowances,
        commissionsTotal, deductionsTotal, advancesApplied,
        netSalary, data.userId
      );
      const salaryId = ins.lastInsertRowid as number;

      // ACCRUAL: issuing a salary creates an obligation to the employee even
      // though no cash has moved yet. The P&L recognises the expense at issue
      // time (filtered on `Month`), so without the matching liability the
      // balance sheet was short by every unpaid salary.
      //
      // The obligation is booked GROSS (before advances) and the outstanding
      // advances are settled against it in the same step. That keeps the
      // liability, the expense and the advance asset consistent: the advance
      // stops being an asset exactly when it starts reducing what we still owe.
      db.prepare('UPDATE employees SET Balance = Balance + ? WHERE EmployeeID = ?')
        .run(netSalary + advancesApplied, data.EmployeeID);
      if (advancesApplied > 0) {
        db.prepare('UPDATE employees SET Balance = Balance - ? WHERE EmployeeID = ?')
          .run(advancesApplied, data.EmployeeID);
        // One ledger for every actual claw-back, shared by both settle paths
        // below: each advance reduced this month gets a row recording WHICH
        // month, HOW MUCH and the balance left after — the monthly payback
        // history the advances tab and the employee statement read.
        const recordDeduction = db.prepare(`
          INSERT INTO advance_deductions (AdvanceID, SalaryID, Month, Amount, RemainingAfter)
          VALUES (?, ?, ?, ?, ?)
        `);
        if (manual) {
          // Settle exactly what the form asked for, re-read under the write
          // lock so a rival till cannot settle the same advance in between.
          // An amount of zero leaves the advance OPEN, which is the point of
          // manual deduction: the owner chooses which advance to claw back and
          // by how much, independently of age.
          const stillOpen = db.prepare(
            'SELECT AdvanceID, Amount FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0',
          ).all(data.EmployeeID) as any[];
          for (const req of requested) {
            const live = stillOpen.find(a => Number(a.AdvanceID) === req.AdvanceID);
            if (!live || req.Amount <= 0.005) continue;
            const remaining = Number(live.Amount);
            if (req.Amount >= remaining - 0.005) {
              db.prepare('UPDATE employee_advances SET IsDeducted = 1, DeductedFromSalaryID = ? WHERE AdvanceID = ?')
                .run(salaryId, req.AdvanceID);
              recordDeduction.run(req.AdvanceID, salaryId, data.Month, +remaining.toFixed(2), 0);
            } else {
              // Partly recovered: reduce it and leave the remainder outstanding.
              db.prepare('UPDATE employee_advances SET Amount = ? WHERE AdvanceID = ?')
                .run(+(remaining - req.Amount).toFixed(2), req.AdvanceID);
              recordDeduction.run(req.AdvanceID, salaryId, data.Month, +req.Amount.toFixed(2), +(remaining - req.Amount).toFixed(2));
            }
          }
        } else {
          // Settle advances oldest-first, and only up to what this month's pay
          // could actually absorb. Marking them ALL deducted when the pay could
          // not cover them wrote off money the employee still owes.
          let left = advancesApplied;
          const open = db.prepare(
            'SELECT AdvanceID, Amount FROM employee_advances WHERE EmployeeID = ? AND IsDeducted = 0 ORDER BY AdvanceID',
          ).all(data.EmployeeID) as any[];
          for (const adv of open) {
            if (left <= 0.005) break;
            if (Number(adv.Amount) <= left + 0.005) {
              db.prepare('UPDATE employee_advances SET IsDeducted = 1, DeductedFromSalaryID = ? WHERE AdvanceID = ?')
                .run(salaryId, adv.AdvanceID);
              recordDeduction.run(adv.AdvanceID, salaryId, data.Month, +Number(adv.Amount).toFixed(2), 0);
              left = +(left - Number(adv.Amount)).toFixed(2);
            } else {
              // Partly recovered: reduce it and leave the remainder outstanding.
              db.prepare('UPDATE employee_advances SET Amount = ? WHERE AdvanceID = ?')
                .run(+(Number(adv.Amount) - left).toFixed(2), adv.AdvanceID);
              recordDeduction.run(adv.AdvanceID, salaryId, data.Month, +left.toFixed(2), +(Number(adv.Amount) - left).toFixed(2));
              left = 0;
            }
          }
        }
      }

      // Deductions and commissions must be marked settled too.
      //
      // Both were read with `IsDeducted = 0` / `IsPaid = 0` and folded into the
      // salary, but nothing ever flipped those flags — so the SAME penalty was
      // taken from the employee's wage again the next month, and every month
      // after that, for ever. Measured: a 300 absence deduction reduced both
      // July and August. Commissions had the mirror fault, being paid out
      // repeatedly.
      if (deductionsTotal > 0) {
        db.prepare(`
          UPDATE employee_deductions SET IsDeducted = 1, DeductedFromSalaryID = ?
          WHERE EmployeeID = ? AND IsDeducted = 0
        `).run(salaryId, data.EmployeeID);
      }
      if (commissionsTotal > 0) {
        db.prepare(`
          UPDATE commissions SET IsPaid = 1, PaidInSalaryID = ?, PaidAmount = Amount
          WHERE EmployeeID = ? AND IsPaid = 0
        `).run(salaryId, data.EmployeeID);
      }
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
        advancesApplied,
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
    // The id is bound straight into the lookup below; an absent or
    // non-numeric value threw "Provided value cannot be bound to SQLite
    // parameter 1." OUT of the handler rather than returning a reply.
    const paySal = requireId(data?.SalaryID, 'رقم الراتب');
    if (!paySal.ok) return { success: false, message: paySal.message };
    const salary = db.prepare('SELECT * FROM salaries WHERE SalaryID = ?').get(data.SalaryID) as any;
    if (!salary) return { success: false, message: 'الراتب غير موجود' };
    if (salary.Status === 'paid') return { success: false, message: 'تم صرف هذا الراتب بالفعل' };

    const netSalary = salary.NetSalary;
    // Each pay may hand over at most what the salary still owes. The old cap
    // used the FULL net salary every time, so a third installment could pay
    // past the remaining balance: one run paid 600, 900 then 100 against a
    // net of 1500 and the employee ended up overpaid by 500 with the drawer
    // drained. The remaining figure ties each leg to what issue actually
    // owes.
    const alreadyPaid = Number(salary.PaidAmount) || 0;
    const remaining = +(netSalary - alreadyPaid).toFixed(2);
    const paidAmount = data.PaidAmount !== undefined && data.PaidAmount > 0 ? Math.min(data.PaidAmount, remaining) : remaining;
    const status = paidAmount >= remaining - 0.001 ? 'paid' : 'partial';
    const paymentDate = resolveDocDate(data as any);
    if (!paymentDate) return { success: false, message: 'تاريخ المستند غير صالح' };

    // Check sufficient balance before paying salary (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && data.CashAccountID && paidAmount > 0) {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < paidAmount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لصرف الراتب: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}` };
      }
    }

    const tx = db.transaction(() => {
      // The read above ran before the transaction bound the write lock; a
      // rival flow could drain the drawer in between, so the balance is
      // re-checked here under the lock. Without it, a sabotaged drawer
      // accepted a 3000 pay whose deduction then blew the negative-cash
      // trigger with a raw crash instead of a refusal.
      if (allowNegCash?.Value !== '1' && data.CashAccountID && paidAmount > 0) {
        const accTx = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
        if (!accTx || (accTx.Balance || 0) < paidAmount) {
          const e = new Error(`الرصيد غير كافٍ في الخزينة لصرف الراتب: المتاح ${(accTx?.Balance || 0).toFixed(2)}، المطلوب ${paidAmount.toFixed(2)}`);
          (e as any).userRefusal = true;
          throw e;
        }
      }

      // Update salary record. PaidAmount ACCUMULATES across installments —
      // the old write stored only the latest leg, so a 600-then-900 sequence
      // left the row at 900 while its status said "paid"; statements and the
      // employees report then footed 600 less than the drawer actually paid.
      db.prepare(`
        UPDATE salaries SET PaidAmount = COALESCE(PaidAmount, 0) + ?, Status = ?, CashAccountID = ?, PaymentDate = ?
        WHERE SalaryID = ?
      `).run(paidAmount, status, data.CashAccountID ?? null, paymentDate, data.SalaryID);

      // Mark commissions as paid. Only the ones that existed when the salary
      // was issued may enter it: a commission earned AFTER issue is not part
      // of NetSalary, so paying it here would hand out money nobody budgeted
      // for. (Measured: a 400 commission earned 1.1s after issue was swept
      // into the pay despite never appearing in the figures.)
      const commissions = db.prepare("SELECT * FROM commissions WHERE EmployeeID = ? AND IsPaid = 0 AND CreatedAt <= ?")
        .all(salary.EmployeeID, salary.CreatedAt) as any[];
      for (const c of commissions) {
        db.prepare('UPDATE commissions SET IsPaid = 1, PaidInSalaryID = ?, PaidAmount = ? WHERE CommissionID = ?')
          .run(data.SalaryID, c.Amount, c.CommissionID);
      }

      // Mark deductions as deducted — same boundary: only the ones that were
      // part of the issued net may be settled here.
      const deductions = db.prepare("SELECT * FROM employee_deductions WHERE EmployeeID = ? AND IsDeducted = 0 AND CreatedAt <= ?")
        .all(salary.EmployeeID, salary.CreatedAt) as any[];
      for (const d of deductions) {
        db.prepare('UPDATE employee_deductions SET IsDeducted = 1, DeductedFromSalaryID = ? WHERE DeductionID = ?').run(data.SalaryID, d.DeductionID);
      }

      // Advances were already applied and settled by `salaries:issue` (they are
      // part of AdvancesTotal on this row), so nothing to do here. Re-settling
      // them would swallow advances taken AFTER this salary was issued.

      // Settle the liability that `salaries:issue` recorded. Paying reduces what
      // we owe by exactly the amount handed over; any unpaid remainder stays on
      // the employee account. (This used to ADD `netSalary - paidAmount`, which
      // double-counted the obligation once issue started booking it.)
      db.prepare('UPDATE employees SET Balance = Balance - ? WHERE EmployeeID = ?').run(paidAmount, salary.EmployeeID);

      // Deduct from cash account
      if (data.CashAccountID && paidAmount > 0) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(paidAmount, data.CashAccountID);
      }
    });

    try {
      tx();
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      throw err;
    }
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

    // Monthly advance deductions — the payback schedule: which month clawed how
    // much back and what the advance still owed after that month. A credit
    // against the advance's own debit, so the statement shows the money going
    // out (سلفية) and coming back month by month (خصم سلفة).
    const advanceDeductions = db.prepare(`
      SELECT ad.DeductionRecordID as RefID, 'ADD-' || ad.DeductionRecordID as RefNumber,
             ad.Month || '-01' as Date, 0 as Debit, ad.Amount as Credit,
             'advance_deduction' as OpType,
             'خصم سلفة من راتب شهر ' || ad.Month as Description,
             ad.RemainingAfter
      FROM advance_deductions ad
      JOIN employee_advances a ON ad.AdvanceID = a.AdvanceID
      WHERE a.EmployeeID = ?
      ORDER BY ad.DeductionRecordID
    `).all(employeeId);
    operations.push(...advanceDeductions);

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
    const totalAdvanceRecovered = operations.filter(o => o.OpType === 'advance_deduction').reduce((s, o) => s + (o.Credit || 0), 0);
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
        totalAdvanceRecovered,
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
    query += ' ORDER BY a.Date DESC, a.AdvanceID DESC';
    const rows = db.prepare(query).all(...params) as any[];

    // Attach each advance's monthly payback schedule. `employee_advances` only
    // holds the LIVE balance; the actual history (which month took how much and
    // what was left after) lives in `advance_deductions`, written by
    // `salaries:issue` in the same transaction as the claw-back.
    const ids = rows.map(r => r.AdvanceID);
    const history: any[] = ids.length
      ? db.prepare(`
          SELECT ad.AdvanceID, ad.SalaryID, ad.Month, ad.Amount, ad.RemainingAfter,
            s.Month as SalaryMonth
          FROM advance_deductions ad
          LEFT JOIN salaries s ON ad.SalaryID = s.SalaryID
          WHERE ad.AdvanceID IN (${ids.map(() => '?').join(',')})
          ORDER BY ad.DeductionRecordID
        `).all(...ids)
      : [];
    const byAdvance = new Map<number, any[]>();
    for (const h of history) {
      if (!byAdvance.has(h.AdvanceID)) byAdvance.set(h.AdvanceID, []);
      byAdvance.get(h.AdvanceID)!.push(h);
    }
    for (const r of rows) r.history = byAdvance.get(r.AdvanceID) ?? [];
    return rows;
  });

  ipcMain.handle('advances:create', async (_event, data: {
    EmployeeID: number; Amount: number; Reason?: string;
    CashAccountID: number; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };

    // A negative advance ran the payment backwards: measured, Amount = -5000
    // ADDED 5,000 to the cash box while recording an advance to the employee.
    const badAdv = checkAmounts([[data.Amount, 'مبلغ السلفة', { allowZero: false }]]);
    if (badAdv) return { success: false, message: badAdv };

    const parties = checkPayrollParties(db, data.EmployeeID, data.CashAccountID);
    if (!parties.ok) return { success: false, message: parties.message };
    if (parties.cashAccountId === null) {
      return { success: false, message: 'اختر الخزينة التي تخرج منها السلفة' };
    }
    const advReason = optionalText(data.Reason, 'سبب السلفة', LIMITS.DESCRIPTION);
    if (!advReason.ok) return { success: false, message: advReason.message };
    data = {
      ...data,
      EmployeeID: parties.employeeId,
      CashAccountID: parties.cashAccountId,
      Reason: advReason.value ?? undefined,
    };

    // Check sufficient balance (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1') {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < data.Amount) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة للسلفة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}` };
      }
    }

    const tx = db.transaction(() => {
      // Same lock-time re-check as salaries:pay: the validation above ran
      // outside the write lock, and a rival flow can drain the drawer in
      // that window. Under the lock this keeps the advance from being issued
      // against balance that is already gone.
      if (allowNegCash?.Value !== '1') {
        const accTx = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
        if (!accTx || (accTx.Balance || 0) < data.Amount) {
          const e = new Error(`الرصيد غير كافٍ في الخزينة للسلفة: المتاح ${(accTx?.Balance || 0).toFixed(2)}، المطلوب ${data.Amount.toFixed(2)}`);
          (e as any).userRefusal = true;
          throw e;
        }
      }

      db.prepare(`
        INSERT INTO employee_advances (EmployeeID, Amount, Date, Reason, CashAccountID, IsDeducted, FiscalYearID, UserID)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(data.EmployeeID, data.Amount, dateStr, data.Reason ?? null, data.CashAccountID, data.fiscalYearId, data.userId);

      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.Amount, data.CashAccountID);
    });

    try {
      tx();
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      throw err;
    }

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
    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };

    // A negative deduction is a bonus nobody authorised.
    const badDed = checkAmounts([[data.Amount, 'مبلغ الخصم', { allowZero: false }]]);
    if (badDed) return { success: false, message: badDed };

    const dedParties = checkPayrollParties(db, data.EmployeeID);
    if (!dedParties.ok) return { success: false, message: dedParties.message };
    const dedNotes = optionalText(data.Notes, 'ملاحظات', LIMITS.NOTES);
    if (!dedNotes.ok) return { success: false, message: dedNotes.message };
    // `Reason` selects the damage-costing branch below, so it decides how much
    // is taken from the employee.
    //
    // The list is read off `deductionReasons` in PayrollPage.tsx rather than
    // guessed. A first draft of this line invented 'late' and 'penalty' and
    // omitted 'negligence', which would have refused a reason the dropdown
    // actually offers — a validator that rejects the shop's own form is worse
    // than no validator, because the screen gives no way to proceed.
    const DEDUCTION_REASONS = ['absence', 'negligence', 'damage', 'other'] as const;
    if (!DEDUCTION_REASONS.includes(String(data.Reason ?? '') as any)) {
      return {
        success: false,
        message: `سبب الخصم غير صالح — القيم المسموحة: ${DEDUCTION_REASONS.join('، ')}`,
      };
    }
    data = { ...data, EmployeeID: dedParties.employeeId, Notes: dedNotes.value ?? undefined };

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

  // ===== COMMISSIONS =====
  //
  // A commission is earned when the job is delivered (`IsPaid = 0`). It can be
  // settled two ways: it is folded into a monthly salary (`PaidInSalaryID`), or
  // it is disbursed IMMEDIATELY through `commissions:payImmediate`, which pays
  // it out of a drawer as its own 'COMM-' voucher. Both routes must put the
  // expense in the P&L once — the salary route inside NetSalary, the immediate
  // route as a standing commission expense whose liability has been released.
  ipcMain.handle('commissions:list', async (_event, filters?: { employeeId?: number; status?: 'pending' | 'paid' }) => {
    const db = getDb();
    let query = `
      SELECT c.*, e.Name as EmployeeName,
        (SELECT VoucherNumber FROM vouchers WHERE VoucherID = c.PaidVoucherID) as VoucherNumber,
        (SELECT Month FROM salaries WHERE SalaryID = c.PaidInSalaryID) as SalaryMonth,
        CASE WHEN c.ReferenceType = 'maintenance_delivery'
          THEN (SELECT DeliveryNumber FROM maintenance_deliveries WHERE DeliveryID = c.ReferenceID)
          ELSE NULL END as RefNumber
      FROM commissions c
      JOIN employees e ON c.EmployeeID = e.EmployeeID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.employeeId) { query += ' AND c.EmployeeID = ?'; params.push(filters.employeeId); }
    if (filters?.status === 'pending') { query += ' AND c.IsPaid = 0'; }
    if (filters?.status === 'paid') { query += ' AND c.IsPaid = 1'; }
    query += ' ORDER BY c.Date DESC, c.CommissionID DESC';
    return db.prepare(query).all(...params);
  });

  // Pay a commission immediately, out of the drawer, as its own voucher.
  //
  // The commission is released (IsPaid = 1, PaidAmount = Amount) and tied to a
  // 'COMM-' voucher that moved the cash. The P&L keeps the earned commission as
  // an expense (it reads `PaidInSalaryID IS NULL`, which covers BOTH the unpaid
  // and the immediately-paid rows), while the balance sheet drops the liability
  // (it reads `IsPaid = 0`). The employee's account is NOT touched here: a
  // standalone commission never carried an obligation on `employees.Balance` —
  // that column holds salary accruals — so crediting it would create one.
  ipcMain.handle('commissions:payImmediate', async (_event, data: {
    CommissionID: number; CashAccountID: number;
    userId: number; fiscalYearId: number; Date?: string;
  }) => {
    const db = getDb();
    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };

    // The id is bound straight into the lookup below; an absent or non-numeric
    // value would throw out of the handler instead of returning a reply.
    const comId = requireId(data?.CommissionID, 'رقم العمولة');
    if (!comId.ok) return { success: false, message: comId.message };
    const commission = db.prepare('SELECT * FROM commissions WHERE CommissionID = ?').get(comId.value) as any;
    if (!commission) return { success: false, message: 'العمولة غير موجودة' };
    if (commission.IsPaid === 1) return { success: false, message: 'العمولة مسددة بالفعل' };
    if (!(commission.Amount > 0)) return { success: false, message: 'مبلغ العمولة غير صالح' };

    const parties = checkPayrollParties(db, commission.EmployeeID, data.CashAccountID);
    if (!parties.ok) return { success: false, message: parties.message };
    if (parties.cashAccountId === null) {
      return { success: false, message: 'اختر الخزينة التي تُصرف منها العمولة' };
    }

    // Check sufficient balance (unless negative cash allowed).
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1') {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(parties.cashAccountId) as any;
      if (!acc || (acc.Balance || 0) < commission.Amount) {
        return {
          success: false,
          message: `الرصيد غير كافٍ في الخزينة لصرف العمولة: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${commission.Amount.toFixed(2)}`,
        };
      }
    }

    let voucherNumber = '';
    const tx = db.transaction(() => {
      // Same lock-time re-check as salaries:pay and advances:create: the
      // validation above ran outside the write lock, and a rival flow can drain
      // the drawer in that window.
      if (allowNegCash?.Value !== '1') {
        const accTx = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(parties.cashAccountId) as any;
        if (!accTx || (accTx.Balance || 0) < commission.Amount) {
          const e = new Error(`الرصيد غير كافٍ في الخزينة لصرف العمولة: المتاح ${(accTx?.Balance || 0).toFixed(2)}، المطلوب ${commission.Amount.toFixed(2)}`);
          (e as any).userRefusal = true;
          throw e;
        }
      }

      const empName = (db.prepare('SELECT Name FROM employees WHERE EmployeeID = ?').get(parties.employeeId) as any)?.Name ?? '';
      voucherNumber = nextDocNumber(db, 'vouchers', 'VoucherNumber', 'COMM', dateStr);
      const vIns = db.prepare(`
        INSERT INTO vouchers (VoucherNumber, VoucherType, FiscalYearID, Date, Amount,
          PartyType, PartyID, PartyName, Description, CashAccountID, UserID,
          ReferenceType, ReferenceID)
        VALUES (?, 'payment', ?, ?, ?, 'employee', ?, ?, 'صرف عمولة فوري', ?, ?, 'commission', ?)
      `).run(
        voucherNumber, data.fiscalYearId, dateStr, commission.Amount,
        parties.employeeId, empName, parties.cashAccountId, data.userId, commission.CommissionID,
      );
      const voucherId = vIns.lastInsertRowid as number;

      db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
        .run(commission.Amount, parties.cashAccountId);

      db.prepare('UPDATE commissions SET IsPaid = 1, PaidAmount = ?, PaidVoucherID = ?, PaidDate = ? WHERE CommissionID = ?')
        .run(commission.Amount, voucherId, dateStr, commission.CommissionID);
    });

    try {
      tx();
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      throw err;
    }
    return { success: true, paidAmount: commission.Amount, voucherNumber };
  });
}
