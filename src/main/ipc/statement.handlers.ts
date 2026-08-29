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
        return { primary: { ...delivery, ...ticket }, items: [], title: 'تسليم صيانة' };
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
      case 'advance_deduction': {
        const row = db.prepare(`
          SELECT ad.*, a.Date as AdvanceDate, a.Amount as OriginalAmount,
            a.Reason as AdvanceReason, e.Name as EmployeeName
          FROM advance_deductions ad
          JOIN employee_advances a ON ad.AdvanceID = a.AdvanceID
          JOIN employees e ON a.EmployeeID = e.EmployeeID
          WHERE ad.DeductionRecordID = ?
        `).get(refId);
        return { primary: row, items: [], title: 'خصم سلفة من راتب' };
      }
      case 'commission': {
        const commission = db.prepare(`
          SELECT c.*, e.Name as EmployeeName
          FROM commissions c JOIN employees e ON c.EmployeeID = e.EmployeeID WHERE c.CommissionID = ?
        `).get(refId);
        return { primary: commission, items: [], title: 'عمولة' };
      }
      case 'service_sale': {
        // The service rows name a customer either by id or by captured
        // name — the join must not clobber the captured name with NULL
        // (same collision fixed in `serviceSales:get`).
        const svc = db.prepare(`
          SELECT ss.*, u.Username,
            COALESCE(c.Name, ss.CustomerName) as CustomerName,
            COALESCE(c.Phone, ss.CustomerPhone) as CustomerPhone
          FROM service_sales ss
          LEFT JOIN customers c ON ss.CustomerID = c.CustomerID
          JOIN users u ON ss.UserID = u.UserID
          WHERE ss.ServiceSaleID = ?
        `).get(refId);
        return { primary: svc, items: [], title: 'خدمة' };
      }
      case 'service_return': {
        const ret = db.prepare(`
          SELECT r.*, ss.ServiceNumber, u.Username,
            COALESCE(c.Name, r.CustomerName) as CustomerName,
            COALESCE(c.Phone, r.CustomerPhone) as CustomerPhone
          FROM service_returns r
          JOIN service_sales ss ON r.ServiceSaleID = ss.ServiceSaleID
          LEFT JOIN customers c ON r.CustomerID = c.CustomerID
          JOIN users u ON r.UserID = u.UserID
          WHERE r.ReturnID = ?
        `).get(refId);
        return { primary: ret, items: [], title: 'مرتجع خدمة' };
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
     *
     * `mode: 'before'` produces `field < from` instead of the range bounds.
     * Every movement query is run in that mode once, to compute the balance
     * the account OPENED the period with — the carried-over figure that makes
     * the statement reconcile: opening + movements = the stored balance.
     */
    const df = (field: string, mode: 'range' | 'before' = 'range') => {
      const parts: string[] = [];
      const vals: string[] = [];
      if (mode === 'before') {
        if (from) { parts.push(`${field} < ?`); vals.push(from); }
      } else {
        if (from) { parts.push(`${field} >= ?`); vals.push(from); }
        if (to) { parts.push(`${field} <= ?`); vals.push(to); }
      }
      return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', vals };
    };

    const operations: any[] = [];
    /** Runs a query whose first bind is the account id, followed by date values. */
    const q = (sql: string, f: { sql: string; vals: string[] }) =>
      db.prepare(sql).all(accountId, ...f.vals) as any[];

    /**
     * Builds one movement query and runs it twice: for the statement range
     * and for the opening balance (every movement before the range starts).
     */
    const qq = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: q(sql(df(field)), df(field)),
      before: q(sql(df(field, 'before')), df(field, 'before')),
    });

    // Sales (money coming IN) — exclude maintenance invoices; the delivery row
    // below already carries the cash movement for those.
    // The InAmount is PAID MINUS the card/wallet commission. Whatever the
    // invoice says, the account was credited net of the fee in both bearer
    // cases, so a statement showing the gross would not reconcile with the
    // balance it describes.
    const sales = qq((f) => `
      SELECT Date, SaleNumber as RefNumber, CustomerName as Party,
        (PaidAmount - COALESCE(TransferCost,0)) as InAmount,
        0 as OutAmount, 'sale' as OpType, 'فاتورة بيع' as OpLabel, SaleID as RefID
      FROM sales
      WHERE CashAccountID = ? AND PaidAmount > 0 AND IsVoided = 0
        AND COALESCE(Source,'direct') <> 'maintenance' ${f.sql}
    `, 'Date');

    // Sale returns (money going OUT)
    const rets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, c.Name as Party, 0 as InAmount,
        r.TotalAmount as OutAmount, 'return' as OpType, 'مرتجع مبيعات' as OpLabel, r.ReturnID as RefID
      FROM sale_returns r JOIN sales s ON r.SaleID = s.SaleID
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${f.sql}
    `, 'r.Date');

    // Voucher receipts (money IN)
    const vReceipts = qq((f) => `
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, Amount as InAmount,
        0 as OutAmount, 'voucher_receipt' as OpType, 'سند قبض' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'receipt' AND Amount > 0 ${f.sql}
    `, 'Date');

    // Voucher payments (money OUT)
    //
    // Rent-linked vouchers are excluded: the instalment they settled already
    // appears as its OWN 'rent' row below, so keeping the voucher too showed
    // the same money leaving TWICE. MEASURED: a 1,500 rent voucher made the
    // drawer statement foot at -2,400 against a drawer that moved -900.
    const vPayments = qq((f) => `
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, 0 as InAmount,
        Amount as OutAmount, 'voucher_payment' as OpType, 'سند صرف' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE CashAccountID = ? AND VoucherType = 'payment' AND Amount > 0
        AND (ReferenceType IS NULL OR ReferenceType <> 'rent') ${f.sql}
    `, 'Date');

    // Purchases (money OUT)
    // FIX: the column is `PaymentSource`, not `PaymentSourceType`. The old query
    // threw "no such column" on every call, so this whole statement was broken.
    const purchases = qq((f) => `
      SELECT p.Date, p.PurchaseNumber as RefNumber, s.Name as Party, 0 as InAmount,
        p.PaidAmount as OutAmount, 'purchase' as OpType, 'فاتورة شراء' as OpLabel, p.PurchaseID as RefID
      FROM purchases p JOIN suppliers s ON p.SupplierID = s.SupplierID
      WHERE p.PaymentSource = 'cash_account' AND p.PaymentSourceID = ? AND p.PaidAmount > 0 ${f.sql}
    `, 'p.Date');

    // Purchase returns (money IN)
    const purRets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, s.Name as Party, r.TotalAmount as InAmount,
        0 as OutAmount, 'purchase_return' as OpType, 'مرتجع مشتريات' as OpLabel, r.ReturnID as RefID
      FROM purchase_returns r JOIN purchases p ON r.PurchaseID = p.PurchaseID
      JOIN suppliers s ON p.SupplierID = s.SupplierID
      WHERE r.CashAccountID = ? AND r.TotalAmount > 0 ${f.sql}
    `, 'r.Date');

    // Salaries (money OUT)
    const salaries = qq((f) => `
      SELECT s.PaymentDate as Date, 'SAL-' || s.SalaryID as RefNumber, e.Name as Party, 0 as InAmount,
        s.PaidAmount as OutAmount, 'salary' as OpType, 'راتب' as OpLabel, s.SalaryID as RefID
      FROM salaries s JOIN employees e ON s.EmployeeID = e.EmployeeID
      WHERE s.CashAccountID = ? AND s.PaidAmount > 0 ${f.sql}
    `, 's.PaymentDate');

    // Advances (money OUT)
    const advances = qq((f) => `
      SELECT a.Date, 'ADV-' || a.AdvanceID as RefNumber, e.Name as Party, 0 as InAmount,
        a.Amount as OutAmount, 'advance' as OpType, 'سلفة' as OpLabel, a.AdvanceID as RefID
      FROM employee_advances a JOIN employees e ON a.EmployeeID = e.EmployeeID
      WHERE a.CashAccountID = ? AND a.Amount > 0 ${f.sql}
    `, 'a.Date');

    // Maintenance deliveries (money IN)
    const maintDel = qq((f) => `
      SELECT Date, DeliveryNumber as RefNumber, CustomerName as Party, PaidAmount as InAmount,
        0 as OutAmount, 'maintenance_delivery' as OpType, 'تسليم صيانة' as OpLabel, DeliveryID as RefID
      FROM maintenance_deliveries WHERE CashAccountID = ? AND PaidAmount > 0 ${f.sql}
    `, 'Date');

    // Maintenance returns (money OUT)
    const maintRets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, d.CustomerName as Party, 0 as InAmount,
        r.TotalRefund as OutAmount, 'maintenance_return' as OpType, 'مرتجع صيانة' as OpLabel, r.ReturnID as RefID
      FROM maintenance_returns r
      JOIN maintenance_deliveries d ON r.DeliveryID = d.DeliveryID
      WHERE r.CashAccountID = ? AND r.TotalRefund > 0 ${f.sql}
    `, 'r.Date');

    // Rent payments (income = IN, expense = OUT)
    //
    // A PARTIAL instalment used to vanish from the statement entirely:
    // `Status = 'paid'` missed `Status = 'partial'`, and the row recorded
    // `PaidDate = NULL` for partials while the amount shown was the whole
    // instalment — 50 paid against a 600 instalment appeared as nothing, and
    // 50 paid against 600 appeared as 600. The statement must show what
    // actually moved: PaidAmount, whenever it is non-zero, dated by the
    // payment date when one was set.
    const rents = qq((f) => `
      SELECT COALESCE(rp.PaidDate, rp.DueDate) as Date,
        'RNT-' || rp.RentPaymentID as RefNumber, r.RentName as Party,
        CASE WHEN r.RentType = 'income' THEN rp.PaidAmount ELSE 0 END as InAmount,
        CASE WHEN r.RentType = 'expense' THEN rp.PaidAmount ELSE 0 END as OutAmount,
        'rent' as OpType, CASE WHEN r.RentType = 'income' THEN 'إيجار وارد' ELSE 'إيجار منصرف' END as OpLabel,
        rp.RentPaymentID as RefID
      FROM rent_payments rp JOIN rents r ON rp.RentID = r.RentID
      WHERE rp.CashAccountID = ? AND COALESCE(rp.PaidAmount, 0) > 0 ${f.sql}
    `, 'COALESCE(rp.PaidDate, rp.DueDate)');

    // Service sales — the full truth about both legs.
    //
    // The old row showed only the money received (PaidAmount) and never the
    // drawdown, so a service funded from the drawer looked like pure income:
    // the 1,000 sent to the customer's phone was gone from the ledger but the
    // statement of the very account it left showed nothing going out. The
    // statement footed to a phantom surplus (a drawer that lost 300 net
    // showed +100). Measured: a drawer-funded 300 transfer paid 100 showed
    // In 100 / Out 0 where the books moved In 100 / Out 300.
    //
    // Service sales do TWO things to a drawer: the customer's payment may
    // land HERE (the receiving asset — `ReceiveAccountType='cash_account'`),
    // and the shop may fund the transfer from HERE (`PaymentMethodID IS
    // NULL` — the drawer is the funding source). A drawer that only receives
    // shows the payment alone; one that also funds shows the drawdown too.
    // Pre-edit rows (`ReceiveAccountType` NULL) received into whatever also
    // funded them. The accountId is bound four times (two CASE lookups plus
    // the two WHERE tests), so these queries run through their own binder.
    const svcRun = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: db.prepare(sql(df(field))).all(accountId, accountId, accountId, accountId, ...df(field).vals) as any[],
      before: db.prepare(sql(df(field, 'before'))).all(accountId, accountId, accountId, accountId, ...df(field, 'before').vals) as any[],
    });
    const services = svcRun((f) => `
      SELECT Date, ServiceNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        CASE WHEN ReceiveAccountType = 'cash_account' AND ReceiveAccountID = ?
             THEN PaidAmount
             WHEN ReceiveAccountType IS NULL AND PaymentMethodID IS NULL AND CashAccountID = ?
             THEN PaidAmount
             ELSE 0 END as InAmount,
        CASE WHEN PaymentMethodID IS NULL
             THEN COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)
             ELSE 0 END as OutAmount,
        'service_sale' as OpType, 'خدمة' as OpLabel, ServiceSaleID as RefID
      FROM service_sales
      WHERE CashAccountID = ?
        AND ( (PaidAmount > 0 AND ((ReceiveAccountType = 'cash_account' AND ReceiveAccountID = ?)
                                   OR (ReceiveAccountType IS NULL AND PaymentMethodID IS NULL)))
              OR (PaymentMethodID IS NULL
                  AND (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) > 0) )
        ${f.sql}
    `, 'Date');

    // A returned service refunds the customer OUT of the receiving drawer and
    // the provider reimburses principal + fee back INTO the funding drawer.
    // Both legs appear, so a drawer that was on both sides nets to zero over
    // a full return — exactly as the money did.
    const svcRetRun = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: db.prepare(sql(df(field))).all(accountId, ...df(field).vals) as any[],
      before: db.prepare(sql(df(field, 'before'))).all(accountId, ...df(field, 'before').vals) as any[],
    });
    const svcRetRefunds = svcRetRun((f) => `
      SELECT Date, ReturnNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        0 as InAmount, PaidAmount as OutAmount,
        'service_return' as OpType, 'مرتجع خدمة' as OpLabel, ReturnID as RefID
      FROM service_returns
      WHERE RefundAccountType = 'cash_account' AND RefundAccountID = ? AND PaidAmount > 0 ${f.sql}
    `, 'Date');
    const svcRetReimburse = svcRetRun((f) => `
      SELECT Date, ReturnNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) as InAmount,
        0 as OutAmount,
        'service_return' as OpType, 'استرداد مزوّد' as OpLabel, ReturnID as RefID
      FROM service_returns
      WHERE CashAccountID = ? AND PaymentMethodID IS NULL
        AND (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) > 0 ${f.sql}
    `, 'Date');

    // Asset transfers (IN or OUT depending on direction)
    //
    // The separate fee is NOT added to the outgoing row: `transfers:create`
    // records it as its OWN payment voucher against the drawer, which already
    // appears here as a `voucher_payment` row. Adding it to the transfer too
    // showed the drawer losing the fee TWICE — measured: a 100 transfer with
    // a 2 separate fee footed the statement at 104 against a ledger movement
    // of 102. (When the fee is taken from the amount it is already inside
    // `Amount`.)
    const transfersIn = qq((f) => `
      SELECT Date, TransferNumber as RefNumber, '' as Party,
        ReceivedAmount as InAmount, 0 as OutAmount,
        'transfer_in' as OpType, 'تحويل وارد' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE ToType = 'cash_account' AND ToID = ? ${f.sql}
    `, 'Date');

    const transfersOut = qq((f) => `
      SELECT Date, TransferNumber as RefNumber, '' as Party, 0 as InAmount,
        Amount as OutAmount,
        'transfer_out' as OpType, 'تحويل صادر' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE FromType = 'cash_account' AND FromID = ? ${f.sql}
    `, 'Date');

    operations.push(
      ...sales.range, ...rets.range, ...vReceipts.range, ...vPayments.range, ...purchases.range,
      ...purRets.range, ...salaries.range, ...advances.range, ...maintDel.range, ...maintRets.range,
      ...rents.range, ...services.range, ...svcRetRefunds.range, ...svcRetReimburse.range,
      ...transfersIn.range, ...transfersOut.range
    );

    // Sort by date (NULL-safe)
    operations.sort((a, b) => String(a.Date ?? '').localeCompare(String(b.Date ?? '')));

    // The OPENING balance: everything that moved BEFORE the range started.
    //
    // This is the carried-over figure that makes the statement reconcile:
    // opening + net movement inside the range = the account's stored balance.
    // With no from date the statement covers the whole history and opens at 0.
    const openingBalance = from ? [
      ...sales.before, ...rets.before, ...vReceipts.before, ...vPayments.before,
      ...purchases.before, ...purRets.before, ...salaries.before, ...advances.before,
      ...maintDel.before, ...maintRets.before, ...rents.before, ...services.before,
      ...svcRetRefunds.before, ...svcRetReimburse.before,
      ...transfersIn.before, ...transfersOut.before,
    ].reduce((s, o) => s + (o.InAmount || 0) - (o.OutAmount || 0), 0) : 0;

    // Calculate running balance — starting at the opening balance, so the
    // first row carries what the account entered the period with.
    let runningBalance = openingBalance;
    for (const op of operations) {
      runningBalance += (op.InAmount || 0) - (op.OutAmount || 0);
      op.Balance = runningBalance;
    }

    return {
      success: true,
      account: { ...account, OpeningBalance: openingBalance },
      operations,
      totalIn: operations.reduce((s, o) => s + (o.InAmount || 0), 0),
      totalOut: operations.reduce((s, o) => s + (o.OutAmount || 0), 0),
      netChange: operations.reduce((s, o) => s + (o.InAmount || 0) - (o.OutAmount || 0), 0),
      openingBalance,
    };
  });

  // Statement for a card machine / digital wallet — every movement that touched
  // its balance, in one document, exactly as a cash account statement is.
  //
  // A wallet is settled net of the provider's fee: a sale credits it
  // `PaidAmount - TransferCost` (a shop-borne fee is a cost, a customer-borne
  // fee is inside the payment), and a return debits `TransferRefund` plus the
  // fee again only when the SHOP absorbed it. Mirroring those two rules keeps
  // the statement reconciling with the balance it describes.
  ipcMain.handle('paymentMethod:statement', async (_event, methodId: number, filters?: { fromDate?: string; toDate?: string }) => {
    const db = getDb();
    const method = db.prepare('SELECT * FROM payment_methods WHERE PaymentMethodID = ?').get(methodId) as any;
    if (!method) return { success: false, message: 'طريقة الدفع غير موجودة' };

    const from = typeof filters?.fromDate === 'string' && filters.fromDate ? filters.fromDate : null;
    const to = typeof filters?.toDate === 'string' && filters.toDate ? filters.toDate : null;
    const df = (field: string, mode: 'range' | 'before' = 'range') => {
      const parts: string[] = [];
      const vals: string[] = [];
      if (mode === 'before') {
        if (from) { parts.push(`${field} < ?`); vals.push(from); }
      } else {
        if (from) { parts.push(`${field} >= ?`); vals.push(from); }
        if (to) { parts.push(`${field} <= ?`); vals.push(to); }
      }
      return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', vals };
    };

    const operations: any[] = [];
    const q = (sql: string, f: { sql: string; vals: string[] }) =>
      db.prepare(sql).all(methodId, ...f.vals) as any[];

    /**
     * Builds one movement query and runs it twice: for the statement range
     * and for the opening balance (every movement before the range starts).
     */
    const qq = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: q(sql(df(field)), df(field)),
      before: q(sql(df(field, 'before')), df(field, 'before')),
    });

    // Sales (money IN). Credited net of the fee in BOTH bearer cases — when the
    // shop pays the fee it is a cost, when the customer pays it the fee arrived
    // inside the payment and then left again to the provider. Either way the
    // wallet balance only ACTUALLY rose by paid minus fee.
    const sales = qq((f) => `
      SELECT Date, SaleNumber as RefNumber, COALESCE(CustomerName, c.Name, 'عميل نقدي') as Party,
        (PaidAmount - COALESCE(TransferCost,0)) as InAmount,
        0 as OutAmount, 'sale' as OpType, 'فاتورة بيع' as OpLabel, SaleID as RefID
      FROM sales
      LEFT JOIN customers c ON sales.CustomerID = c.CustomerID
      WHERE PaymentMethodID = ? AND PaidAmount > 0 AND IsVoided = 0
        AND COALESCE(Source,'direct') <> 'maintenance' ${f.sql}
    `, 'Date');

    // Sale returns refunded through this machine (money OUT). MORE leaves than
    // the customer receives when the shop absorbs the provider fee.
    const rets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, COALESCE(c.Name,'') as Party, 0 as InAmount,
        (COALESCE(r.TransferRefund,0) + CASE WHEN COALESCE(r.TransferCostBearer,'shop') = 'shop'
           THEN COALESCE(r.TransferCost,0) ELSE 0 END) as OutAmount,
        'return' as OpType, 'مرتجع مبيعات' as OpLabel, r.ReturnID as RefID
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      LEFT JOIN customers c ON s.CustomerID = c.CustomerID
      WHERE r.PaymentMethodID = ? AND COALESCE(r.TransferRefund,0) > 0 ${f.sql}
    `, 'r.Date');

    // Purchases paid from this machine (money OUT).
    const purchases = qq((f) => `
      SELECT p.Date, p.PurchaseNumber as RefNumber, su.Name as Party, 0 as InAmount,
        p.PaidAmount as OutAmount, 'purchase' as OpType, 'فاتورة شراء' as OpLabel, p.PurchaseID as RefID
      FROM purchases p JOIN suppliers su ON p.SupplierID = su.SupplierID
      WHERE p.PaymentSource = 'payment_method' AND p.PaymentSourceID = ? AND p.PaidAmount > 0 ${f.sql}
    `, 'p.Date');

    // Purchase returns refunded to this machine (money IN) — the supplier hands
    // money back into the wallet, net of a fee the SHOP absorbs.
    const purRets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, su.Name as Party,
        (COALESCE(r.TransferRefund,0) - CASE WHEN COALESCE(r.TransferCostBearer,'shop') = 'shop'
           THEN COALESCE(r.TransferCost,0) ELSE 0 END) as InAmount,
        0 as OutAmount, 'purchase_return' as OpType, 'مرتجع مشتريات' as OpLabel, r.ReturnID as RefID
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      JOIN suppliers su ON p.SupplierID = su.SupplierID
      WHERE r.PaymentMethodID = ? AND COALESCE(r.TransferRefund,0) > 0 ${f.sql}
    `, 'r.Date');

    // Service sales touch a machine on either side: the transfer may be funded
    // from it (`PaymentMethodID`, money OUT — the principal plus fees), and
    // the customer's payment may be received INTO it (`ReceiveAccountType =
    // 'payment_method'`, money IN). A machine that only funded shows the
    // drawdown alone; pre-edit rows (`ReceiveAccountType` NULL) received
    // into whatever also funded them. The methodId is bound three times, so
    // this query runs through its own binder.
    const svcRun = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: db.prepare(sql(df(field))).all(methodId, methodId, methodId, ...df(field).vals) as any[],
      before: db.prepare(sql(df(field, 'before'))).all(methodId, methodId, methodId, ...df(field, 'before').vals) as any[],
    });
    const services = svcRun((f) => `
      SELECT Date, ServiceNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        CASE WHEN ReceiveAccountType = 'payment_method' AND ReceiveAccountID = ?
             THEN PaidAmount
             WHEN ReceiveAccountType IS NULL AND PaymentMethodID = ?
             THEN PaidAmount
             ELSE 0 END as InAmount,
        (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) as OutAmount,
        'service_sale' as OpType, COALESCE(ServiceType,'خدمة') as OpLabel, ServiceSaleID as RefID
      FROM service_sales
      WHERE PaymentMethodID = ?
        AND (PaidAmount > 0 OR COALESCE(Amount,0) > 0) ${f.sql}
    `, 'Date');

    // A returned service refunds the customer OUT of the receiving machine
    // and the provider reimburses principal + fee back into the funding one.
    const svcRetRun = (sql: (f: { sql: string; vals: string[] }) => string, field: string) => ({
      range: db.prepare(sql(df(field))).all(methodId, ...df(field).vals) as any[],
      before: db.prepare(sql(df(field, 'before'))).all(methodId, ...df(field, 'before').vals) as any[],
    });
    const svcRetRefunds = svcRetRun((f) => `
      SELECT Date, ReturnNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        0 as InAmount, PaidAmount as OutAmount,
        'service_return' as OpType, 'مرتجع خدمة' as OpLabel, ReturnID as RefID
      FROM service_returns
      WHERE RefundAccountType = 'payment_method' AND RefundAccountID = ? AND PaidAmount > 0 ${f.sql}
    `, 'Date');
    const svcRetReimburse = svcRetRun((f) => `
      SELECT Date, ReturnNumber as RefNumber, COALESCE(CustomerName,'') as Party,
        (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) as InAmount,
        0 as OutAmount,
        'service_return' as OpType, 'استرداد مزوّد' as OpLabel, ReturnID as RefID
      FROM service_returns
      WHERE PaymentMethodID = ?
        AND (COALESCE(Amount,0) + COALESCE(ServiceCost,0) + COALESCE(TransferCost,0)) > 0 ${f.sql}
    `, 'Date');

    // Vouchers (receipt = IN, payment = OUT)
    //
    // Rent-linked payments are excluded, exactly as in the cash statement: the
    // instalment they settled already appears as its own 'rent' row below, and
    // showing the voucher too would foot the statement at twice the movement.
    const vReceipts = qq((f) => `
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, Amount as InAmount,
        0 as OutAmount, 'voucher_receipt' as OpType, 'سند قبض' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE PaymentMethodID = ? AND VoucherType = 'receipt' AND Amount > 0 ${f.sql}
    `, 'Date');
    const vPayments = qq((f) => `
      SELECT Date, VoucherNumber as RefNumber, PartyName as Party, 0 as InAmount,
        Amount as OutAmount, 'voucher_payment' as OpType, 'سند صرف' as OpLabel, VoucherID as RefID
      FROM vouchers WHERE PaymentMethodID = ? AND VoucherType = 'payment' AND Amount > 0
        AND (ReferenceType IS NULL OR ReferenceType <> 'rent') ${f.sql}
    `, 'Date');

    // Maintenance deliveries paid through this machine (money IN)
    const maintDel = qq((f) => `
      SELECT Date, DeliveryNumber as RefNumber, COALESCE(CustomerName,'') as Party, PaidAmount as InAmount,
        0 as OutAmount, 'maintenance_delivery' as OpType, 'تسليم صيانة' as OpLabel, DeliveryID as RefID
      FROM maintenance_deliveries WHERE PaymentMethodID = ? AND PaidAmount > 0 ${f.sql}
    `, 'Date');

    // Maintenance returns refunded through the SAME machine the delivery was
    // paid through (money OUT) — the refund follows the delivery's source.
    const maintRets = qq((f) => `
      SELECT r.Date, r.ReturnNumber as RefNumber, COALESCE(d.CustomerName,'') as Party, 0 as InAmount,
        r.TotalRefund as OutAmount, 'maintenance_return' as OpType, 'مرتجع صيانة' as OpLabel, r.ReturnID as RefID
      FROM maintenance_returns r
      JOIN maintenance_deliveries d ON r.DeliveryID = d.DeliveryID
      WHERE d.PaymentMethodID = ? AND r.TotalRefund > 0 ${f.sql}
    `, 'r.Date');

    // Rent payments (income = IN, expense = OUT) — partial instalments too,
    // showing the amount that actually moved (same fix as the cash statement).
    const rents = qq((f) => `
      SELECT COALESCE(rp.PaidDate, rp.DueDate) as Date,
        'RNT-' || rp.RentPaymentID as RefNumber, r.RentName as Party,
        CASE WHEN r.RentType = 'income' THEN rp.PaidAmount ELSE 0 END as InAmount,
        CASE WHEN r.RentType = 'expense' THEN rp.PaidAmount ELSE 0 END as OutAmount,
        'rent' as OpType, CASE WHEN r.RentType = 'income' THEN 'إيجار وارد' ELSE 'إيجار منصرف' END as OpLabel,
        rp.RentPaymentID as RefID
      FROM rent_payments rp JOIN rents r ON rp.RentID = r.RentID
      WHERE rp.PaymentMethodID = ? AND COALESCE(rp.PaidAmount, 0) > 0 ${f.sql}
    `, 'COALESCE(rp.PaidDate, rp.DueDate)');

    // Asset transfers (IN = received, OUT = sent plus any separately-funded fee)
    const transfersIn = qq((f) => `
      SELECT Date, TransferNumber as RefNumber, '' as Party,
        ReceivedAmount as InAmount, 0 as OutAmount,
        'transfer_in' as OpType, 'تحويل وارد' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE ToType = 'payment_method' AND ToID = ? ${f.sql}
    `, 'Date');
    const transfersOut = qq((f) => `
      SELECT Date, TransferNumber as RefNumber, '' as Party, 0 as InAmount,
        (Amount + CASE WHEN TransferCostSource = 'separate' THEN TransferCost ELSE 0 END) as OutAmount,
        'transfer' as OpType, 'تحويل صادر' as OpLabel, TransferID as RefID
      FROM asset_transfers WHERE FromType = 'payment_method' AND FromID = ? ${f.sql}
    `, 'Date');

    operations.push(
      ...sales.range, ...rets.range, ...purchases.range, ...purRets.range, ...services.range,
      ...svcRetRefunds.range, ...svcRetReimburse.range,
      ...vReceipts.range, ...vPayments.range, ...maintDel.range, ...maintRets.range, ...rents.range,
      ...transfersIn.range, ...transfersOut.range
    );

    // Sort by date (NULL-safe)
    operations.sort((a, b) => String(a.Date ?? '').localeCompare(String(b.Date ?? '')));

    // The OPENING balance: everything that moved BEFORE the range started —
    // the carried-over figure that makes the statement reconcile with the
    // wallet's stored balance. With no from date it opens at 0.
    const openingBalance = from ? [
      ...sales.before, ...rets.before, ...purchases.before, ...purRets.before, ...services.before,
      ...svcRetRefunds.before, ...svcRetReimburse.before,
      ...vReceipts.before, ...vPayments.before, ...maintDel.before, ...maintRets.before, ...rents.before,
      ...transfersIn.before, ...transfersOut.before,
    ].reduce((s, o) => s + (o.InAmount || 0) - (o.OutAmount || 0), 0) : 0;

    // Running balance — starting at the opening balance, so the first row
    // carries what the wallet entered the period with.
    let runningBalance = openingBalance;
    for (const op of operations) {
      runningBalance += (op.InAmount || 0) - (op.OutAmount || 0);
      op.Balance = runningBalance;
    }

    return {
      success: true,
      method: { ...method, OpeningBalance: openingBalance },
      operations,
      totalIn: operations.reduce((s, o) => s + (o.InAmount || 0), 0),
      totalOut: operations.reduce((s, o) => s + (o.OutAmount || 0), 0),
      netChange: operations.reduce((s, o) => s + (o.InAmount || 0) - (o.OutAmount || 0), 0),
      openingBalance,
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
    const df = (col: string, mode: 'range' | 'before' = 'range') => {
      let sql = '';
      const vals: string[] = [];
      if (mode === 'before') {
        if (from) { sql += ` AND ${col} < ?`; vals.push(from); }
      } else {
        if (from) { sql += ` AND ${col} >= ?`; vals.push(from); }
        if (to) { sql += ` AND ${col} <= ?`; vals.push(to); }
      }
      return { sql, vals };
    };

    const qq = (sql: (f: { sql: string; vals: string[] }) => string, col: string) => ({
      range: db.prepare(sql(df(col))).all(customerId, ...df(col).vals) as any[],
      before: db.prepare(sql(df(col, 'before'))).all(customerId, ...df(col, 'before').vals) as any[],
    });

    // Sales (debit = full invoice amount, credit = amount paid at time of sale)
    // Maintenance deliveries write a mirror invoice into `sales` for printing;
    // that same charge is listed below from `maintenance_deliveries`, so it must
    // be excluded here or the customer is billed twice on their own statement.
    const sales = qq((f) => `
      SELECT SaleID as RefID, SaleNumber as RefNumber, Date,
             TotalAmount as Debit,
             PaidAmount as Credit,
             'sale' as OpType,
             'فاتورة بيع' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM sales
      WHERE CustomerID = ? AND IsVoided = 0
        AND COALESCE(Source,'direct') <> 'maintenance' ${f.sql}
    `, 'Date');
    operations.push(...sales.range);

    // Sale returns — only the portion that CANCELLED DEBT belongs on the
    // customer account. The cash-refunded portion left the till instead and
    // never touched their balance, so crediting the full return value made the
    // statement disagree with customers.Balance by exactly the refunded amount.
    // Legacy rows (before DebtRelief existed) fall back to the old behaviour
    // only when the invoice actually had an unpaid portion.
    const returns = qq((f) => `
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, 0 as Debit,
             COALESCE(r.DebtRelief,
               CASE WHEN COALESCE(s.PaidAmount,0) >= COALESCE(s.TotalAmount,0) THEN 0 ELSE r.TotalAmount END
             ) as Credit,
             r.TotalAmount as ReturnTotal,
             COALESCE(r.CashRefund, 0) as CashRefund,
             'sale_return' as OpType, 'مرتجع مبيعات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM sale_returns r
      JOIN sales s ON r.SaleID = s.SaleID
      WHERE s.CustomerID = ? ${f.sql}
    `, 'r.Date');
    operations.push(...returns.range);

    // Maintenance deliveries (debit = total cost, credit = amount paid at delivery)
    const deliveries = qq((f) => `
      SELECT d.DeliveryID as RefID, d.DeliveryNumber as RefNumber, d.Date,
             d.TotalCost as Debit,
             d.PaidAmount as Credit,
             'maintenance_delivery' as OpType, 'تسليم صيانة' as Description,
             d.PaymentMethod, d.PaidAmount, d.RemainingAmount, NULL as Status
      FROM maintenance_deliveries d
      WHERE d.CustomerID = ? AND d.VoidedSaleID IS NULL ${f.sql}
    `, 'd.Date');
    operations.push(...deliveries.range);

    // Service sales (balance transfers, bill payments, top-ups).
    // These charge the customer and can be left partly unpaid, so they move
    // customers.Balance — yet they were missing from the statement entirely,
    // making it disagree with the actual account balance.
    const services = qq((f) => `
      SELECT ss.ServiceSaleID as RefID, ss.ServiceNumber as RefNumber, ss.Date,
             ss.ChargeAmount as Debit,
             ss.PaidAmount as Credit,
             'service_sale' as OpType,
             COALESCE(ss.ServiceType,'خدمة') as Description,
             ss.PaymentMethod, ss.PaidAmount, ss.RemainingAmount, ss.Status
      FROM service_sales ss
      WHERE ss.CustomerID = ? ${f.sql}
    `, 'ss.Date');
    operations.push(...services.range);

    // Service returns cancel the unpaid remainder the returned operation
    // left on the ledger — a customer who owed for a service that never
    // happened stops owing it, and the statement still foots to
    // customers.Balance. The cash refund part left the RECEIVING asset
    // instead and never touched the customer's balance, so it belongs in
    // the cash/machine statement.
    const serviceReturns = qq((f) => `
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date, 0 as Debit,
             r.RemainingAmount as Credit,
             'service_return' as OpType, 'مرتجع خدمة' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, 'returned' as Status
      FROM service_returns r
      WHERE r.CustomerID = ? AND r.RemainingAmount != 0 ${f.sql}
    `, 'r.Date');
    operations.push(...serviceReturns.range);

    // Receipt vouchers (credit - customer pays, reduces balance)
    const receipts = qq((f) => `
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${f.sql}
    `, 'v.Date');
    operations.push(...receipts.range);

    // Payment vouchers (debit - refund to customer)
    const payments = qq((f) => `
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'customer' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${f.sql}
    `, 'v.Date');
    operations.push(...payments.range);

    // Sort by date ascending, then by insertion order
    operations.sort((a, b) => {
      const dateCompare = new Date(a.Date).getTime() - new Date(b.Date).getTime();
      return dateCompare !== 0 ? dateCompare : (a.RefID - b.RefID);
    });

    // Opening balance: the customer's debt from BEFORE the range started.
    // With no from date the statement opens at 0 (everything is shown).
    const openingBalance = from ? [
      ...sales.before, ...returns.before, ...deliveries.before, ...services.before,
      ...serviceReturns.before,
      ...receipts.before, ...payments.before,
    ].reduce((s, o) => s + (o.Debit || 0) - (o.Credit || 0), 0) : 0;

    // Calculate running balance — from the opening balance, so the last row
    // reconciles with the stored customers.Balance.
    let runningBalance = openingBalance;
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
      openingBalance,
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
    const df = (col: string, mode: 'range' | 'before' = 'range') => {
      let sql = '';
      const vals: string[] = [];
      if (mode === 'before') {
        if (from) { sql += ` AND ${col} < ?`; vals.push(from); }
      } else {
        if (from) { sql += ` AND ${col} >= ?`; vals.push(from); }
        if (to) { sql += ` AND ${col} <= ?`; vals.push(to); }
      }
      return { sql, vals };
    };
    const qq = (sql: (f: { sql: string; vals: string[] }) => string, col: string) => ({
      range: db.prepare(sql(df(col))).all(supplierId, ...df(col).vals) as any[],
      before: db.prepare(sql(df(col, 'before'))).all(supplierId, ...df(col, 'before').vals) as any[],
    });

    // Purchases (credit - increases supplier balance / we owe them)
    //
    // `PaidAmount` is booked as a DEBIT on the same line, exactly as the
    // customer statement does with a sale. Anything settled at the counter
    // never became a debt, so leaving it out overstated what the shop owes:
    // measured, an 800 invoice with 300 paid on the spot left the supplier
    // owed 500 in `suppliers.Balance` while the statement footed to 800.
    //
    // The owner reconciles a supplier from this page. A statement that
    // disagrees with the ledger by exactly the amount already handed over is
    // how a supplier gets paid twice.
    const purchases = qq((f) => `
      SELECT PurchaseID as RefID, PurchaseNumber as RefNumber, Date,
             COALESCE(PaidAmount,0) as Debit, TotalAmount as Credit,
             'purchase' as OpType, 'فاتورة شراء' as Description,
             PaymentMethod, PaidAmount, RemainingAmount, Status
      FROM purchases WHERE SupplierID = ? ${f.sql}
    `, 'Date');
    operations.push(...purchases.range);

    // Purchase returns — the returned VALUE goes off what we owe, whatever
    // The settlement has two legs: the returned VALUE goes on the debit side
    // (the supplier's claim on us drops by the goods that came back) and the
    // refunds they handed over (cash / machine) go on the credit side. The
    // legs always sum to the full value, so `Debit − Credit` is exactly the
    // `DebtRelief` the handler writes to `suppliers.Balance` — an 80 unit
    // refunded to a machine shows 80 against an 80 refund (net zero, which a
    // 0/0 row hid), a pure account credit shows 160 against nothing, and any
    // mix nets to what the balance actually moved.
    const returns = qq((f) => `
      SELECT r.ReturnID as RefID, r.ReturnNumber as RefNumber, r.Date,
             COALESCE(r.TotalAmount, 0) as Debit,
             COALESCE(r.CashRefund, 0) + COALESCE(r.TransferRefund, 0) as Credit,
             r.TotalAmount as ReturnTotal,
             COALESCE(r.CashRefund, 0) as CashRefund,
             'purchase_return' as OpType, 'مرتجع مشتريات' as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM purchase_returns r
      JOIN purchases p ON r.PurchaseID = p.PurchaseID
      WHERE p.SupplierID = ? ${f.sql}
    `, 'r.Date');
    operations.push(...returns.range);

    // Payment vouchers (debit - we pay supplier)
    const payments = qq((f) => `
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, v.Amount as Debit, 0 as Credit,
             'voucher_payment' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'payment'
      ${f.sql}
    `, 'v.Date');
    operations.push(...payments.range);

    // Receipt vouchers (credit - supplier refunds us)
    const receipts = qq((f) => `
      SELECT v.VoucherID as RefID, v.VoucherNumber as RefNumber, v.Date, 0 as Debit, v.Amount as Credit,
             'voucher_receipt' as OpType, v.Description as Description,
             NULL as PaymentMethod, NULL as PaidAmount, NULL as RemainingAmount, NULL as Status
      FROM vouchers v
      WHERE v.PartyType = 'supplier' AND v.PartyID = ? AND v.VoucherType = 'receipt'
      ${f.sql}
    `, 'v.Date');
    operations.push(...receipts.range);

    operations.sort((a, b) => {
      const dateCompare = new Date(a.Date).getTime() - new Date(b.Date).getTime();
      return dateCompare !== 0 ? dateCompare : (a.RefID - b.RefID);
    });

    // Opening balance: what the shop owed BEFORE the range started.
    const openingBalance = from ? [
      ...purchases.before, ...returns.before, ...payments.before, ...receipts.before,
    ].reduce((s, o) => s + (o.Credit || 0) - (o.Debit || 0), 0) : 0;

    let runningBalance = openingBalance;
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
      openingBalance,
      totals: {
        totalDebit,
        totalCredit,
        netBalance: totalCredit - totalDebit,
        currentBalance: supplier.Balance,
      },
    };
  });
}
