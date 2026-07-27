#!/usr/bin/env python3
"""
Full double-entry style audit of the ERP's money flows.

Instead of testing individual SQL snippets, this replays the handler logic for
every money-moving operation and then asserts the fundamental accounting
identity holds across the whole system:

    Assets - Liabilities == Capital + NetProfit

Any operation that breaks this identity is reported with the exact drift, which
is how silent balance corruption gets caught.

Usage:  python3 scripts/audit_accounting_engine.py
"""
import os
import re
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_real_db import parse_blocks  # noqa: E402

FAILURES = []


def build_db():
    ts = open(os.path.join(ROOT, 'src/main/database/migrations/index.ts'), encoding='utf-8').read()
    blocks = parse_blocks(ts)
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    for guarded, stmts in blocks:
        aborted = False
        for s in stmts:
            if aborted:
                continue
            try:
                db.execute(s)
            except Exception:
                if guarded:
                    aborted = True
    # minimal seed
    db.execute("INSERT INTO fiscal_years(YearName,StartDate,EndDate,Status) VALUES('2026','2026-01-01','2026-12-31','open')")
    db.execute("INSERT INTO roles(RoleName,IsSystem) VALUES('admin',1)")
    db.execute("INSERT INTO employees(Name,BaseSalary,Allowances,IsActive) VALUES('Tech',3000,0,1)")
    db.execute("INSERT INTO users(Username,PasswordHash,EmployeeID,RoleID,IsActive) VALUES('admin','x',1,1,1)")
    db.execute("INSERT INTO warehouses(WarehouseName,WarehouseType) VALUES('Main','main')")
    db.execute("INSERT INTO warehouses(WarehouseName,WarehouseType) VALUES('Service','maintenance')")
    db.execute("INSERT INTO cash_accounts(AccountName,AccountType,Balance,IsActive) VALUES('Safe','safe',0,1)")
    db.execute("INSERT INTO payment_methods(MethodName,MethodType,Balance,IsActive) VALUES('Wallet','wallet',0,1)")
    db.execute("INSERT INTO customers(Name,Balance,Status) VALUES('Ahmed',0,'active')")
    db.execute("INSERT INTO suppliers(Name,Balance,Status) VALUES('Supplier',0,'active')")
    db.execute("INSERT INTO items(ItemName,ItemType,SalePrice,CostPrice,IsActive) VALUES('Screen','part',150,100,1)")
    db.execute("INSERT INTO settings(Key,Value) VALUES('owner_capital','0')")
    return db


# ---------------------------------------------------------------- P&L (mirrors reports.handlers)
def pl(db):
    g = lambda q, *a: db.execute(q, a).fetchone()[0] or 0
    sales = g("SELECT COALESCE(SUM(TotalAmount),0) FROM sales WHERE IsVoided=0 AND IsWarranty=0 AND COALESCE(Source,'direct')<>'maintenance'")
    sret = g("SELECT COALESCE(SUM(r.TotalAmount),0) FROM sale_returns r JOIN sales s ON r.SaleID=s.SaleID WHERE s.IsVoided=0")
    maint = g("SELECT COALESCE(SUM(TotalCost),0) FROM maintenance_deliveries WHERE VoidedSaleID IS NULL")
    mret = g("SELECT COALESCE(SUM(TotalRefund),0) FROM maintenance_returns")
    svc = g("SELECT COALESCE(SUM(ChargeAmount-COALESCE(Amount,0)),0) FROM service_sales")
    other = g("SELECT COALESCE(SUM(Amount),0) FROM vouchers WHERE VoucherType='receipt' AND (PartyType='general' OR PartyType IS NULL)")
    rin = g("SELECT COALESCE(SUM(rp.Amount),0) FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID WHERE rp.Status='paid' AND r.RentType='income'")
    revenue = sales - sret + maint - mret + svc + other + rin

    cogs = g("SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0)*sd.Quantity),0) FROM sale_details sd JOIN sales s ON sd.SaleID=s.SaleID WHERE s.IsVoided=0 AND s.IsWarranty=0 AND COALESCE(s.Source,'direct')<>'maintenance'")
    cogs_ret = g("""SELECT COALESCE(SUM(COALESCE(
        (SELECT sd.UnitCost FROM sale_details sd WHERE sd.SaleID=sr.SaleID AND sd.ItemID IS srd.ItemID LIMIT 1),
        (SELECT i.CostPrice FROM items i WHERE i.ItemID=srd.ItemID),0)*srd.Quantity),0)
        FROM sale_return_details srd JOIN sale_returns sr ON srd.ReturnID=sr.ReturnID""")
    parts = g("SELECT COALESCE(SUM(mp.TotalCost),0) FROM maintenance_parts mp JOIN maintenance_tickets t ON mp.TicketID=t.TicketID WHERE t.MaintenanceType NOT IN ('warranty','rework')")
    wparts = g("SELECT COALESCE(SUM(mp.TotalCost),0) FROM maintenance_parts mp JOIN maintenance_tickets t ON mp.TicketID=t.TicketID WHERE t.MaintenanceType IN ('warranty','rework')")
    svc_cost = g("SELECT COALESCE(SUM(COALESCE(ServiceCost,0)+COALESCE(TransferCost,0)),0) FROM service_sales")
    costs = cogs - cogs_ret + parts + svc_cost

    gen = g("SELECT COALESCE(SUM(Amount),0) FROM vouchers WHERE VoucherType='payment' AND (PartyType='general' OR PartyType IS NULL)")
    sal = g("SELECT COALESCE(SUM(NetSalary + COALESCE(AdvancesTotal,0)),0) FROM salaries")
    rout = g("SELECT COALESCE(SUM(rp.Amount),0) FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID WHERE rp.Status='paid' AND r.RentType='expense'")
    expenses = gen + sal + rout + wparts
    return {'revenue': revenue, 'costs': costs, 'expenses': expenses,
            'net': revenue - costs - expenses}


def balance_sheet(db):
    g = lambda q: db.execute(q).fetchone()[0] or 0
    cash = g("SELECT COALESCE(SUM(Balance),0) FROM cash_accounts WHERE IsActive=1")
    pm = g("SELECT COALESCE(SUM(Balance),0) FROM payment_methods WHERE IsActive=1")
    recv = g("SELECT COALESCE(SUM(Balance),0) FROM customers WHERE Balance>0")
    adv = g("SELECT COALESCE(SUM(Amount),0) FROM employee_advances WHERE IsDeducted=0")
    inv = g("SELECT COALESCE(SUM(CostPrice*Quantity),0) FROM stock_quantities")
    assets = cash + pm + recv + adv + inv
    pay = g("SELECT COALESCE(SUM(Balance),0) FROM suppliers WHERE Balance>0")
    empl = g("SELECT COALESCE(SUM(Balance),0) FROM employees WHERE IsActive=1 AND Balance>0")
    cred = g("SELECT COALESCE(SUM(-Balance),0) FROM customers WHERE Balance<0")
    liab = pay + empl + cred
    cap = float(db.execute("SELECT Value FROM settings WHERE Key='owner_capital'").fetchone()[0])
    return {'assets': assets, 'liabilities': liab, 'capital': cap,
            'cash': cash, 'pm': pm, 'recv': recv, 'inv': inv, 'payables': pay}


def identity(db, label):
    """Assets - Liabilities must equal Capital + NetProfit."""
    b = balance_sheet(db)
    p = pl(db)
    lhs = round(b['assets'] - b['liabilities'], 2)
    rhs = round(b['capital'] + p['net'], 2)
    drift = round(lhs - rhs, 2)
    status = 'OK  ' if abs(drift) < 0.01 else 'DRIFT'
    print(f"  {status} {label:<44} A-L={lhs:>10.2f}  C+P={rhs:>10.2f}  drift={drift:>8.2f}")
    if abs(drift) >= 0.01:
        FAILURES.append((label, drift))
    return drift


# ---------------------------------------------------------------- operations
def seq(db, table, col, prefix, date):
    key = f"{table}:{date}"
    db.execute("INSERT INTO document_sequences(SeqKey,LastValue) VALUES(?,1) ON CONFLICT(SeqKey) DO UPDATE SET LastValue=LastValue+1", (key,))
    n = db.execute("SELECT LastValue FROM document_sequences WHERE SeqKey=?", (key,)).fetchone()[0]
    return f"{prefix}-{date.replace('-','')}-{n:04d}"


def op_purchase(db, qty, unit_cost, paid, supplier=1, wh=1, item=1):
    """purchases:create"""
    d = '2026-07-01'
    sub = qty * unit_cost
    total = sub
    rem = total - paid
    num = seq(db, 'purchases', 'PurchaseNumber', 'PUR', d)
    db.execute("""INSERT INTO purchases(PurchaseNumber,FiscalYearID,Date,SupplierID,Subtotal,Discount,TaxAmount,
        TotalAmount,PaidAmount,RemainingAmount,AdditionalCost,PaymentCost,PaymentSource,PaymentSourceID,
        Status,UserID,PaymentMethod) VALUES(?,1,?,?,?,0,0,?,?,?,0,0,'cash_account',1,?,1,'cash')""",
        (num, d, supplier, sub, total, paid, rem, 'completed' if rem <= 0 else 'partial'))
    pid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("INSERT INTO purchase_details(PurchaseID,ItemID,Quantity,UnitCost,Total,WarehouseID) VALUES(?,?,?,?,?,?)",
               (pid, item, qty, unit_cost, sub, wh))
    row = db.execute("SELECT ID,Quantity,CostPrice FROM stock_quantities WHERE ItemID=? AND WarehouseID=?", (item, wh)).fetchone()
    if row:
        nq = row[1] + qty
        nc = ((row[2] * row[1]) + (unit_cost * qty)) / nq
        db.execute("UPDATE stock_quantities SET Quantity=?,CostPrice=? WHERE ID=?", (nq, nc, row[0]))
    else:
        db.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(?,?,?,?)", (item, wh, qty, unit_cost))
    if rem > 0:
        db.execute("UPDATE suppliers SET Balance=Balance+? WHERE SupplierID=?", (rem, supplier))
    elif rem < 0:
        db.execute("UPDATE suppliers SET Balance=Balance-? WHERE SupplierID=?", (abs(rem), supplier))
    if paid > 0:
        db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (paid,))
    return pid


def op_sale(db, qty, price, cost, paid, customer=1, wh=1, item=1, pm=None):
    """sales:create (post-fix: one payment target, warehouse recorded)"""
    d = '2026-07-02'
    sub = qty * price
    total = sub
    rem = total - paid
    num = seq(db, 'sales', 'SaleNumber', 'SAL', d)
    cash_id = None if pm else 1
    db.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxRate,TaxAmount,
        TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,CashAccountID,PaymentMethodID,Status,UserID,Source)
        VALUES(?,1,?,?,?,0,0,0,?,?,?,'cash',?,?,?,1,'direct')""",
        (num, d, customer, sub, total, paid, rem, cash_id, pm, 'completed' if rem <= 0 else 'partial'))
    sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) VALUES(?,?,?,?,?,?,?)",
               (sid, item, qty, price, cost, sub, wh))
    db.execute("UPDATE stock_quantities SET Quantity=Quantity-? WHERE ItemID=? AND WarehouseID=?", (qty, item, wh))
    if rem > 0:
        db.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=?", (rem, customer))
    elif rem < 0:
        db.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (abs(rem), customer))
    if paid > 0:
        if pm:
            db.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=?", (paid, pm))
        else:
            db.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (paid,))
    return sid


def op_sale_return(db, sale_id, amount, item=1, qty=1):
    """saleReturns:create (post-fix split)"""
    d = '2026-07-03'
    s = db.execute("SELECT CustomerID,TotalAmount,RemainingAmount FROM sales WHERE SaleID=?", (sale_id,)).fetchone()
    cust, total, rem = s
    prior = db.execute("SELECT COALESCE(SUM(TotalAmount),0) FROM sale_returns WHERE SaleID=?", (sale_id,)).fetchone()[0]
    if prior + amount > total + 0.001:
        return None
    relief = min(amount, max(0.0, max(0.0, rem) - prior))
    cash = round(amount - relief, 2)
    num = seq(db, 'sale_returns', 'ReturnNumber', 'SR', d)
    db.execute("INSERT INTO sale_returns(ReturnNumber,SaleID,Date,TotalAmount,UserID,CashAccountID,DebtRelief,CashRefund) VALUES(?,?,?,?,1,1,?,?)",
               (num, sale_id, d, amount, relief, cash))
    rid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    wh = db.execute("SELECT WarehouseID FROM sale_details WHERE SaleID=? AND ItemID IS ? LIMIT 1", (sale_id, item)).fetchone()
    wh = wh[0] if wh else 1
    db.execute("INSERT INTO sale_return_details(ReturnID,ItemID,Quantity,UnitPrice,Total,WarehouseID) VALUES(?,?,?,?,?,?)",
               (rid, item, qty, amount / qty, amount, wh))
    db.execute("UPDATE stock_quantities SET Quantity=Quantity+? WHERE ItemID=? AND WarehouseID=?", (qty, item, wh))
    if cash > 0:
        db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (cash,))
    if cust and relief > 0:
        db.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (relief, cust))
    db.execute("UPDATE sales SET RemainingAmount=MAX(0,RemainingAmount-?) WHERE SaleID=?", (relief, sale_id))
    return {'relief': relief, 'cash': cash}


def op_voucher_receipt_customer(db, amount, customer=1):
    d = '2026-07-04'
    num = seq(db, 'vouchers', 'VoucherNumber', 'RCV', d)
    db.execute("""INSERT INTO vouchers(VoucherNumber,VoucherType,FiscalYearID,Date,Amount,PartyType,PartyID,
        Description,CashAccountID,UserID) VALUES(?,'receipt',1,?,?,'customer',?,'collection',1,1)""", (num, d, amount, customer))
    db.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (amount,))
    db.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (amount, customer))


def op_expense(db, amount):
    d = '2026-07-05'
    num = seq(db, 'vouchers', 'VoucherNumber', 'PAY', d)
    db.execute("""INSERT INTO vouchers(VoucherNumber,VoucherType,FiscalYearID,Date,Amount,PartyType,
        Description,CashAccountID,UserID) VALUES(?,'payment',1,?,?,'general','electricity',1,1)""", (num, d, amount))
    db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (amount,))


def op_service(db, charge, principal, cost, transfer, paid, customer=None):
    d = '2026-07-06'
    num = seq(db, 'service_sales', 'ServiceNumber', 'SRV', d)
    rem = charge - paid
    profit = charge - cost - principal - transfer
    db.execute("""INSERT INTO service_sales(ServiceNumber,FiscalYearID,Date,ServiceType,Provider,TargetPhone,
        Amount,ServiceCost,ChargeAmount,PaidAmount,RemainingAmount,Profit,PaymentMethod,CashAccountID,
        PaymentMethodID,TransferCost,Status,UserID,CustomerID) VALUES(?,1,?,'transfer','v','010',?,?,?,?,?,?,'cash',1,1,?,'completed',1,?)""",
        (num, d, principal, cost, charge, paid, rem, profit, transfer, customer))
    # Handler behaviour: an unpaid balance is charged to the customer account.
    if customer and rem > 0:
        db.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=?", (rem, customer))
    elif customer and rem < 0:
        db.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (abs(rem), customer))
    if paid > 0:
        db.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (paid,))
    if principal > 0:
        db.execute("UPDATE payment_methods SET Balance=Balance-? WHERE PaymentMethodID=1", (principal,))
    # Real cost outflow (provider fee + transfer fee) now leaves the funding source.
    real_cost = cost + transfer
    if real_cost > 0:
        db.execute("UPDATE payment_methods SET Balance=Balance-? WHERE PaymentMethodID=1", (real_cost,))
    return profit


def op_maintenance(db, parts_cost, labor, charge, paid, mtype='normal', wh=2, item=1):
    d = '2026-07-07'
    tnum = seq(db, 'maintenance_tickets', 'TicketNumber', 'MNT', d)
    db.execute("""INSERT INTO maintenance_tickets(TicketNumber,FiscalYearID,Date,CustomerID,CustomerName,
        CustomerPhone,DeviceModel,ProblemDesc,Status,UserID,MaintenanceType,PartsCost,TotalCost,LaborCost)
        VALUES(?,1,?,1,'Ahmed','010','iPhone','broken','received',1,?,0,0,0)""", (tnum, d, mtype))
    tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    if parts_cost > 0:
        # Mirror maintenance:issuePart — it refuses to issue a part that is not
        # in the warehouse (unless negative stock is explicitly enabled).
        have = db.execute("SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID=? AND WarehouseID=?", (item, wh)).fetchone()[0]
        if have < 1:
            raise AssertionError(f"issuePart would be rejected: item {item} not in warehouse {wh}")
        # Post-fix behaviour: the cost booked is ALWAYS the inventory CostPrice,
        # never a caller-supplied override, so P&L and the balance sheet agree.
        row = db.execute("SELECT CostPrice FROM stock_quantities WHERE ItemID=? AND WarehouseID=?", (item, wh)).fetchone()
        actual = row[0] if row and row[0] else parts_cost
        db.execute("INSERT INTO maintenance_parts(TicketID,ItemID,Quantity,UnitCost,TotalCost,SalePrice,WarehouseID,IssuedByUserID) VALUES(?,?,1,?,?,0,?,1)",
                   (tid, item, actual, actual, wh))
        db.execute("UPDATE stock_quantities SET Quantity=Quantity-1 WHERE ItemID=? AND WarehouseID=?", (item, wh))
        db.execute("UPDATE maintenance_tickets SET PartsCost=PartsCost+? WHERE TicketID=?", (actual, tid))
    rem = charge - paid
    dnum = seq(db, 'maintenance_deliveries', 'DeliveryNumber', 'DLV', d)
    db.execute("""INSERT INTO maintenance_deliveries(DeliveryNumber,TicketID,Date,CustomerID,CustomerName,
        PartsCost,LaborCost,AdditionalCosts,TotalCost,PaidAmount,RemainingAmount,PaymentMethod,CashAccountID,
        UserID,ServiceCostTotal,TotalCostOnUs,TotalProfit) VALUES(?,?,?,1,'Ahmed',?,?,0,?,?,?,'cash',1,1,0,?,?)""",
        (dnum, tid, d, parts_cost, labor, charge, paid, rem, parts_cost, charge - parts_cost))
    did = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    snum = seq(db, 'sales', 'SaleNumber', 'INV', d)
    db.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxRate,TaxAmount,
        TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,Source,SourceID,IsWarranty)
        VALUES(?,1,?,1,?,0,0,0,?,?,?,'cash','completed',1,'maintenance',?,?)""",
        (snum, d, charge, charge, paid, rem, did, 1 if mtype in ('warranty', 'rework') else 0))
    db.execute("UPDATE maintenance_tickets SET Status='delivered',TotalCost=?,LaborCost=? WHERE TicketID=?", (charge, labor, tid))
    if rem > 0:
        db.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=1", (rem,))
    if paid > 0:
        db.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (paid,))
    return tid, did


def op_advance(db, amount, emp=1):
    db.execute("INSERT INTO employee_advances(EmployeeID,Amount,Date,CashAccountID,IsDeducted,FiscalYearID,UserID) VALUES(?,?,'2026-07-10',1,0,1,1)", (emp, amount))
    db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (amount,))


def op_salary_issue_and_pay(db, emp=1, month='2026-07', pay_ratio=1.0):
    e = db.execute("SELECT BaseSalary,Allowances FROM employees WHERE EmployeeID=?", (emp,)).fetchone()
    adv = db.execute("SELECT COALESCE(SUM(Amount),0) FROM employee_advances WHERE EmployeeID=? AND IsDeducted=0", (emp,)).fetchone()[0]
    net = e[0] + e[1] - adv
    db.execute("""INSERT INTO salaries(EmployeeID,Month,FiscalYearID,BaseSalary,Allowances,CommissionsTotal,
        DeductionsTotal,AdvancesTotal,NetSalary,PaidAmount,Status,UserID) VALUES(?,?,1,?,?,0,0,?,?,0,'pending',1)""",
        (emp, month, e[0], e[1], adv, net))
    sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    # issue: book the GROSS obligation, then settle outstanding advances against it
    db.execute("UPDATE employees SET Balance=Balance+? WHERE EmployeeID=?", (net + adv, emp))
    if adv > 0:
        db.execute("UPDATE employees SET Balance=Balance-? WHERE EmployeeID=?", (adv, emp))
        db.execute("UPDATE employee_advances SET IsDeducted=1,DeductedFromSalaryID=? WHERE EmployeeID=? AND IsDeducted=0", (sid, emp))
    # pay
    paid = round(net * pay_ratio, 2)
    status = 'paid' if pay_ratio >= 1 else 'partial'
    db.execute("UPDATE salaries SET PaidAmount=?,Status=?,CashAccountID=1,PaymentDate='2026-07-28' WHERE SalaryID=?", (paid, status, sid))
    db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (paid,))
    db.execute("UPDATE employees SET Balance=Balance-? WHERE EmployeeID=?", (paid, emp))
    return net


def reconcile_customer_statement(db, customer_id=1):
    """
    The customer statement must reproduce customers.Balance exactly.
    Any gap means the statement is missing (or double-counting) a document.
    """
    q = lambda s: db.execute(s, (customer_id,)).fetchone()
    a = q("SELECT COALESCE(SUM(TotalAmount),0),COALESCE(SUM(PaidAmount),0) FROM sales "
          "WHERE CustomerID=? AND IsVoided=0 AND COALESCE(Source,'direct')<>'maintenance'")
    b = q("SELECT COALESCE(SUM(TotalCost),0),COALESCE(SUM(PaidAmount),0) FROM maintenance_deliveries "
          "WHERE CustomerID=? AND VoidedSaleID IS NULL")
    c = q("SELECT COALESCE(SUM(ChargeAmount),0),COALESCE(SUM(PaidAmount),0) FROM service_sales WHERE CustomerID=?")
    ret = q("SELECT COALESCE(SUM(r.DebtRelief),0),0 FROM sale_returns r JOIN sales s ON r.SaleID=s.SaleID WHERE s.CustomerID=?")
    rcv = q("SELECT COALESCE(SUM(Amount),0),0 FROM vouchers WHERE PartyType='customer' AND PartyID=? AND VoucherType='receipt'")
    pay = q("SELECT COALESCE(SUM(Amount),0),0 FROM vouchers WHERE PartyType='customer' AND PartyID=? AND VoucherType='payment'")
    debit = a[0] + b[0] + c[0] + pay[0]
    credit = a[1] + b[1] + c[1] + ret[0] + rcv[0]
    stmt = round(debit - credit, 2)
    real = round(db.execute("SELECT Balance FROM customers WHERE CustomerID=?", (customer_id,)).fetchone()[0], 2)
    gap = round(stmt - real, 2)
    ok = abs(gap) < 0.01
    print(f"  {'OK  ' if ok else 'GAP '} customer statement reconciles"
          f"{'':<24} stmt={stmt:>10.2f}  balance={real:>10.2f}  gap={gap:>8.2f}")
    if not ok:
        FAILURES.append(("customer statement reconciliation", gap))


def main():
    print("=" * 96)
    print("DOUBLE-ENTRY AUDIT — every operation must preserve  Assets - Liabilities = Capital + NetProfit")
    print("=" * 96)

    db = build_db()
    # Owner injects capital as opening cash.
    db.execute("UPDATE cash_accounts SET Balance=100000 WHERE CashAccountID=1")
    db.execute("UPDATE settings SET Value='100000' WHERE Key='owner_capital'")
    identity(db, "opening capital 100,000")

    op_purchase(db, qty=10, unit_cost=100, paid=1000)
    identity(db, "purchase 10x100 paid cash")

    op_purchase(db, qty=5, unit_cost=100, paid=0)
    identity(db, "purchase 5x100 on credit")

    s1 = op_sale(db, qty=2, price=150, cost=100, paid=300)
    identity(db, "cash sale 2x150 (cost 100)")

    s2 = op_sale(db, qty=3, price=150, cost=100, paid=0)
    identity(db, "credit sale 3x150")

    op_voucher_receipt_customer(db, 450)
    identity(db, "collect 450 from customer")

    op_sale_return(db, s1, 150, qty=1)
    identity(db, "return 1 unit of the cash sale")

    op_sale_return(db, s2, 150, qty=1)
    identity(db, "return 1 unit of the credit sale")

    op_expense(db, 500)
    identity(db, "general expense 500")

    p = op_service(db, charge=105, principal=100, cost=2, transfer=1, paid=105)
    identity(db, f"service transfer (commission {p})")

    # Move stock into the service warehouse first (a real shop transfers parts
    # there); a straight warehouse transfer is value-neutral.
    db.execute("UPDATE stock_quantities SET Quantity=Quantity-4 WHERE ItemID=1 AND WarehouseID=1")
    db.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,4,100)")
    identity(db, "transfer 4 units main -> service warehouse")

    op_maintenance(db, parts_cost=100, labor=200, charge=350, paid=350)
    identity(db, "maintenance job, parts 100, charge 350")

    op_maintenance(db, parts_cost=80, labor=0, charge=0, paid=0, mtype='warranty')
    identity(db, "warranty repair, parts absorbed")

    op_salary_issue_and_pay(db)
    identity(db, "salary issued and paid")

    op_advance(db, 500)
    identity(db, "employee advance 500")

    op_salary_issue_and_pay(db, month='2026-08')
    identity(db, "next salary absorbs the advance")

    op_salary_issue_and_pay(db, month='2026-09', pay_ratio=0.4)
    identity(db, "salary paid only 40% (rest owed)")

    # Add a credit service so the statement has one of every document type.
    op_service(db, charge=60, principal=50, cost=1, transfer=0, paid=0, customer=1)
    identity(db, "credit service sale")

    print()
    reconcile_customer_statement(db)

    print("\n" + "-" * 96)
    b, p2 = balance_sheet(db), pl(db)
    print(f"  cash={b['cash']:.2f}  machine={b['pm']:.2f}  receivable={b['recv']:.2f}  "
          f"inventory={b['inv']:.2f}  payable={b['payables']:.2f}")
    print(f"  revenue={p2['revenue']:.2f}  costs={p2['costs']:.2f}  expenses={p2['expenses']:.2f}  net={p2['net']:.2f}")
    print(f"  negative stock rows: {db.execute('SELECT COUNT(*) FROM stock_quantities WHERE Quantity<0').fetchone()[0]}")

    print("\n" + "=" * 96)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} operation(s) broke the accounting identity")
        for label, drift in FAILURES:
            print(f"   DRIFT {drift:>10.2f}  <- {label}")
        sys.exit(1)
    print("RESULT: all operations preserved the accounting identity")


if __name__ == '__main__':
    main()
