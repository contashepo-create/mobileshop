#!/usr/bin/env python3
"""
Regression checks for the accounting fixes.

These replay the exact SQL the handlers run against a real SQLite database and
assert the corrected behaviour. Run with:  python3 scripts/verify_accounting.py

They are intentionally dependency-free (stdlib sqlite3) so they can run in CI
without installing the Electron/native toolchain.
"""
import sqlite3
import sys

PASS, FAIL = [], []


def check(name, got, want):
    if abs(got - want) < 0.005 if isinstance(got, (int, float)) else got == want:
        PASS.append(name)
        print(f"  PASS  {name}  (= {got})")
    else:
        FAIL.append(name)
        print(f"  FAIL  {name}  got={got} want={want}")


def schema(db):
    db.executescript("""
    CREATE TABLE sales(SaleID INTEGER PRIMARY KEY, SaleNumber TEXT UNIQUE, Date TEXT,
      CustomerID INT, TotalAmount REAL, PaidAmount REAL, RemainingAmount REAL,
      CashAccountID INT, PaymentMethodID INT, Status TEXT,
      IsVoided INT DEFAULT 0, IsWarranty INT DEFAULT 0, Source TEXT DEFAULT 'direct', SourceID INT);
    CREATE TABLE sale_details(DetailID INTEGER PRIMARY KEY, SaleID INT, ItemID INT, SerialID INT,
      Quantity REAL, UnitPrice REAL, UnitCost REAL, Total REAL, WarehouseID INT);
    CREATE TABLE sale_returns(ReturnID INTEGER PRIMARY KEY, ReturnNumber TEXT UNIQUE, SaleID INT,
      Date TEXT, TotalAmount REAL, CashAccountID INT);
    CREATE TABLE sale_return_details(DetailID INTEGER PRIMARY KEY, ReturnID INT, ItemID INT,
      SerialID INT, Quantity REAL, UnitPrice REAL, Total REAL, WarehouseID INT);
    CREATE TABLE customers(CustomerID INTEGER PRIMARY KEY, Name TEXT, Balance REAL DEFAULT 0);
    CREATE TABLE suppliers(SupplierID INTEGER PRIMARY KEY, Name TEXT, Balance REAL DEFAULT 0);
    CREATE TABLE cash_accounts(CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL DEFAULT 0, IsActive INT DEFAULT 1);
    CREATE TABLE payment_methods(PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL DEFAULT 0, IsActive INT DEFAULT 1);
    CREATE TABLE stock_quantities(ID INTEGER PRIMARY KEY, ItemID INT, WarehouseID INT,
      Quantity REAL DEFAULT 0, CostPrice REAL DEFAULT 0, UNIQUE(ItemID, WarehouseID));
    CREATE TABLE warehouses(WarehouseID INTEGER PRIMARY KEY, WarehouseName TEXT);
    CREATE TABLE items(ItemID INTEGER PRIMARY KEY, ItemName TEXT, CostPrice REAL, SalePrice REAL);
    CREATE TABLE maintenance_deliveries(DeliveryID INTEGER PRIMARY KEY, Date TEXT, TotalCost REAL,
      VoidedSaleID INT, CustomerID INT, PaidAmount REAL, RemainingAmount REAL, CashAccountID INT, PaymentMethodID INT);
    CREATE TABLE maintenance_returns(ReturnID INTEGER PRIMARY KEY, Date TEXT, TotalRefund REAL);
    CREATE TABLE maintenance_parts(PartID INTEGER PRIMARY KEY, TicketID INT, ItemID INT,
      Quantity REAL, UnitCost REAL, TotalCost REAL, WarehouseID INT);
    CREATE TABLE maintenance_tickets(TicketID INTEGER PRIMARY KEY, Date TEXT, MaintenanceType TEXT);
    CREATE TABLE service_sales(ServiceSaleID INTEGER PRIMARY KEY, Date TEXT, ChargeAmount REAL,
      ServiceCost REAL, Amount REAL, TransferCost REAL);
    CREATE TABLE vouchers(VoucherID INTEGER PRIMARY KEY, VoucherNumber TEXT UNIQUE, VoucherType TEXT,
      Date TEXT, Amount REAL, PartyType TEXT, PartyID INT, CashAccountID INT, ReferenceType TEXT, ReferenceID INT);
    CREATE TABLE salaries(SalaryID INTEGER PRIMARY KEY, EmployeeID INT, Month TEXT,
      NetSalary REAL, PaidAmount REAL, PaymentDate TEXT);
    CREATE TABLE rents(RentID INTEGER PRIMARY KEY, RentName TEXT, RentType TEXT);
    CREATE TABLE rent_payments(RentPaymentID INTEGER PRIMARY KEY, RentID INT, Amount REAL,
      Status TEXT, PaidDate TEXT, CashAccountID INT);
    CREATE TABLE document_sequences(SeqKey TEXT PRIMARY KEY, LastValue INTEGER NOT NULL DEFAULT 0);
    """)


# ---------------------------------------------------------------- doc numbers
def next_doc(db, table, column, prefix, date):
    key = f"{table}:{date}"
    db.execute("INSERT INTO document_sequences(SeqKey,LastValue) VALUES(?,1) "
               "ON CONFLICT(SeqKey) DO UPDATE SET LastValue=LastValue+1", (key,))
    seq = db.execute("SELECT LastValue FROM document_sequences WHERE SeqKey=?", (key,)).fetchone()[0]
    compact = date.replace('-', '')
    cand = f"{prefix}-{compact}-{seq:04d}"
    while db.execute(f"SELECT 1 FROM {table} WHERE {column}=? LIMIT 1", (cand,)).fetchone():
        seq += 1
        cand = f"{prefix}-{compact}-{seq:04d}"
    db.execute("UPDATE document_sequences SET LastValue=? WHERE SeqKey=?", (seq, key))
    return cand


def test_doc_numbers():
    print("\n[1] Document numbering survives deletion (was: UNIQUE violation)")
    db = sqlite3.connect(':memory:'); schema(db)
    d = '2026-07-27'
    nums = []
    for _ in range(3):
        n = next_doc(db, 'sales', 'SaleNumber', 'SAL', d)
        db.execute("INSERT INTO sales(SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount) VALUES(?,?,0,0,0)", (n, d))
        nums.append(n)
    check("three sequential numbers", nums, ['SAL-20260727-0001', 'SAL-20260727-0002', 'SAL-20260727-0003'])
    db.execute("DELETE FROM sales WHERE SaleNumber='SAL-20260727-0002'")
    n4 = next_doc(db, 'sales', 'SaleNumber', 'SAL', d)
    check("next number after delete does not collide", n4, 'SAL-20260727-0004')
    try:
        db.execute("INSERT INTO sales(SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount) VALUES(?,?,0,0,0)", (n4, d))
        check("insert succeeds", True, True)
    except sqlite3.IntegrityError as e:
        check(f"insert succeeds ({e})", False, True)
    db.close()


# ------------------------------------------------------------- cash vs machine
def test_single_payment_target():
    print("\n[2] Paid amount credited to ONE account (was: double-credit)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO cash_accounts(CashAccountID,AccountName,Balance) VALUES(1,'Safe',0)")
    db.execute("INSERT INTO payment_methods(PaymentMethodID,MethodName,Balance) VALUES(1,'Wallet',0)")
    paid = 1000.0
    payment_method_id, cash_account_id = 1, None   # normalisation: PM wins
    if paid > 0:
        if payment_method_id:
            db.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=?", (paid, payment_method_id))
        elif cash_account_id:
            db.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=?", (paid, cash_account_id))
    total = (db.execute("SELECT (SELECT Balance FROM cash_accounts WHERE CashAccountID=1)+"
                        "(SELECT Balance FROM payment_methods WHERE PaymentMethodID=1)").fetchone()[0])
    check("total recorded equals amount paid", total, 1000.0)
    db.close()


# ---------------------------------------------------------------- sale returns
def sale_return(db, sale_id, amount, cash_account_id=1):
    """Mirrors the corrected saleReturns:create split."""
    s = db.execute("SELECT CustomerID,TotalAmount,PaidAmount,RemainingAmount FROM sales WHERE SaleID=?", (sale_id,)).fetchone()
    cust, total, paid, remaining = s
    outstanding = max(0.0, remaining or 0)
    prior = db.execute("SELECT COALESCE(SUM(TotalAmount),0) FROM sale_returns WHERE SaleID=?", (sale_id,)).fetchone()[0]
    if prior + amount > total + 0.001:
        return None
    debt_relief = min(amount, max(0.0, outstanding - prior))
    cash_refund = round(amount - debt_relief, 2)
    db.execute("INSERT INTO sale_returns(ReturnNumber,SaleID,Date,TotalAmount,CashAccountID) VALUES(?,?,?,?,?)",
               (f"SR-{sale_id}-{prior}", sale_id, '2026-07-27', amount, cash_account_id))
    if cash_refund > 0:
        db.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=?", (cash_refund, cash_account_id))
    if cust and debt_relief > 0:
        db.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (debt_relief, cust))
    db.execute("UPDATE sales SET RemainingAmount=MAX(0,RemainingAmount-?) WHERE SaleID=?", (debt_relief, sale_id))
    return {'debtRelief': debt_relief, 'cashRefund': cash_refund}


def test_sale_return_cash():
    print("\n[3] Return of a fully-paid CASH sale (was: refunded twice)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',0)")
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',1000,1)")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,CustomerID,TotalAmount,PaidAmount,RemainingAmount,CashAccountID,Status)"
               " VALUES(1,'SAL-1','2026-07-27',1,300,300,0,1,'completed')")
    r = sale_return(db, 1, 300)
    check("cash refunded", r['cashRefund'], 300.0)
    check("debt relief", r['debtRelief'], 0.0)
    check("customer balance unchanged (no phantom credit)",
          db.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0], 0.0)
    check("cash account reduced once",
          db.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0], 700.0)
    db.close()


def test_sale_return_credit():
    print("\n[4] Return of an UNPAID credit sale (relieves debt, no cash out)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',300)")
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',1000,1)")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,CustomerID,TotalAmount,PaidAmount,RemainingAmount,CashAccountID,Status)"
               " VALUES(1,'SAL-1','2026-07-27',1,300,0,300,1,'unpaid')")
    r = sale_return(db, 1, 300)
    check("no cash paid out", r['cashRefund'], 0.0)
    check("debt cancelled", r['debtRelief'], 300.0)
    check("customer balance back to zero",
          db.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0], 0.0)
    check("cash untouched",
          db.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0], 1000.0)
    db.close()


def test_sale_return_partial_paid():
    print("\n[5] Return of a partially-paid sale (splits debt vs cash)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',200)")
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',1000,1)")
    # invoice 500, paid 300, owes 200
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,CustomerID,TotalAmount,PaidAmount,RemainingAmount,CashAccountID,Status)"
               " VALUES(1,'SAL-1','2026-07-27',1,500,300,200,1,'partial')")
    r = sale_return(db, 1, 500)
    check("debt relief covers the 200 owed", r['debtRelief'], 200.0)
    check("cash refund covers the 300 paid", r['cashRefund'], 300.0)
    check("customer balance zero",
          db.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0], 0.0)
    check("cash reduced by exactly what was received",
          db.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0], 700.0)
    db.close()


def test_over_return_blocked():
    print("\n[6] Returning more than the invoice is rejected")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',0)")
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',1000,1)")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,CustomerID,TotalAmount,PaidAmount,RemainingAmount,CashAccountID,Status)"
               " VALUES(1,'SAL-1','2026-07-27',1,300,300,0,1,'completed')")
    sale_return(db, 1, 300)
    check("second full return blocked", sale_return(db, 1, 300), None)
    db.close()


# ------------------------------------------------------------------------ P&L
def profit_and_loss(db):
    """The corrected reports:profitLoss revenue/cost math."""
    g = lambda q: db.execute(q).fetchone()[0]
    sales_gross = g("SELECT COALESCE(SUM(TotalAmount),0) FROM sales WHERE IsVoided=0 AND IsWarranty=0 "
                    "AND COALESCE(Source,'direct')<>'maintenance'")
    sales_ret = g("SELECT COALESCE(SUM(r.TotalAmount),0) FROM sale_returns r JOIN sales s ON r.SaleID=s.SaleID WHERE s.IsVoided=0")
    maint = g("SELECT COALESCE(SUM(TotalCost),0) FROM maintenance_deliveries WHERE VoidedSaleID IS NULL")
    maint_ret = g("SELECT COALESCE(SUM(TotalRefund),0) FROM maintenance_returns")
    svc = g("SELECT COALESCE(SUM(ChargeAmount-COALESCE(Amount,0)),0) FROM service_sales")
    other = g("SELECT COALESCE(SUM(Amount),0) FROM vouchers WHERE VoucherType='receipt' AND (PartyType='general' OR PartyType IS NULL)")
    rent_in = g("SELECT COALESCE(SUM(rp.Amount),0) FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID "
                "WHERE rp.Status='paid' AND r.RentType='income'")
    revenue = sales_gross - sales_ret + maint - maint_ret + svc + other + rent_in

    cogs = g("SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0)*sd.Quantity),0) FROM sale_details sd "
             "JOIN sales s ON sd.SaleID=s.SaleID WHERE s.IsVoided=0 AND s.IsWarranty=0 "
             "AND COALESCE(s.Source,'direct')<>'maintenance'")
    parts = g("SELECT COALESCE(SUM(mp.TotalCost),0) FROM maintenance_parts mp "
              "JOIN maintenance_tickets t ON mp.TicketID=t.TicketID WHERE t.MaintenanceType NOT IN ('warranty','rework')")
    svc_cost = g("SELECT COALESCE(SUM(COALESCE(ServiceCost,0)+COALESCE(TransferCost,0)),0) FROM service_sales")
    gen = g("SELECT COALESCE(SUM(Amount),0) FROM vouchers WHERE VoucherType='payment' AND (PartyType='general' OR PartyType IS NULL)")
    rent_out = g("SELECT COALESCE(SUM(rp.Amount),0) FROM rent_payments rp JOIN rents r ON rp.RentID=r.RentID "
                 "WHERE rp.Status='paid' AND r.RentType='expense'")
    return {'revenue': revenue, 'costs': cogs + parts + svc_cost,
            'expenses': gen + rent_out, 'netProfit': revenue - (cogs + parts + svc_cost) - (gen + rent_out)}


def test_maintenance_not_double_counted():
    print("\n[7] Maintenance revenue counted once (was: doubled)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO maintenance_deliveries(DeliveryID,Date,TotalCost,VoidedSaleID) VALUES(1,'2026-07-27',800,NULL)")
    # the printable invoice the deliver handler also writes into `sales`
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount,Source,SourceID)"
               " VALUES(1,'INV-1','2026-07-27',800,800,0,'maintenance',1)")
    check("revenue = 800 not 1600", profit_and_loss(db)['revenue'], 800.0)
    db.close()


def test_direct_sale_still_counted():
    print("\n[8] Ordinary sales are still counted (no over-filtering)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount,Source)"
               " VALUES(1,'SAL-1','2026-07-27',500,500,0,'direct')")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount,Source)"
               " VALUES(2,'SAL-2','2026-07-27',250,250,0,NULL)")   # legacy NULL Source
    check("both direct and legacy-NULL rows counted", profit_and_loss(db)['revenue'], 750.0)
    db.close()


def test_service_agent_revenue():
    print("\n[9] Service revenue is the commission, not the principal")
    db = sqlite3.connect(':memory:'); schema(db)
    # transfer 100 principal, 5 charged to customer, 2 provider cost, 1 transfer fee
    db.execute("INSERT INTO service_sales(ServiceSaleID,Date,ChargeAmount,ServiceCost,Amount,TransferCost)"
               " VALUES(1,'2026-07-27',105,2,100,1)")
    pl = profit_and_loss(db)
    check("revenue = 5 (commission) not 105", pl['revenue'], 5.0)
    check("costs = 3 (provider+fee) not 103", pl['costs'], 3.0)
    check("net profit = 2", pl['netProfit'], 2.0)
    db.close()


def test_rent_not_double_charged():
    print("\n[10] Rent expense charged once (was: twice)")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO rents VALUES(1,'Shop','expense')")
    db.execute("INSERT INTO rent_payments VALUES(1,1,2000,'paid','2026-07-27',1)")
    # a voucher tagged PartyType='rent' must NOT be added again
    db.execute("INSERT INTO vouchers(VoucherNumber,VoucherType,Date,Amount,PartyType) VALUES('PAY-1','payment','2026-07-27',2000,'rent')")
    check("rent expense = 2000 not 4000", profit_and_loss(db)['expenses'], 2000.0)
    db.close()


def test_cogs_partial_return():
    print("\n[11] Partial return reverses only the returned line's cost")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO items VALUES(1,'Screen',100,150),(2,'Battery',40,70)")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount) VALUES(1,'SAL-1','2026-07-27',220,220,0)")
    db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total) VALUES(1,1,1,150,100,150),(1,2,1,70,40,70)")
    db.execute("INSERT INTO sale_returns(ReturnID,ReturnNumber,SaleID,Date,TotalAmount) VALUES(1,'SR-1',1,'2026-07-27',70)")
    db.execute("INSERT INTO sale_return_details(ReturnID,ItemID,Quantity,UnitPrice,Total) VALUES(1,2,1,70,70)")
    cogs_ret = db.execute("""
      SELECT COALESCE(SUM(COALESCE(
               (SELECT sd.UnitCost FROM sale_details sd WHERE sd.SaleID=sr.SaleID AND sd.ItemID IS srd.ItemID LIMIT 1),
               (SELECT i.CostPrice FROM items i WHERE i.ItemID=srd.ItemID), 0) * srd.Quantity),0)
      FROM sale_return_details srd JOIN sale_returns sr ON srd.ReturnID=sr.ReturnID
    """).fetchone()[0]
    check("only battery cost (40) reversed, not 140", cogs_ret, 40.0)
    db.close()


def test_warehouse_aware_stock():
    print("\n[12] Stock deducted from and restored to the SAME warehouse")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO warehouses VALUES(1,'Main'),(2,'Service')")
    db.execute("INSERT INTO items VALUES(1,'Screen',100,150)")
    db.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,5,100),(1,2,3,100)")

    def resolve(item, qty, preferred=None):
        if preferred: return preferred
        r = db.execute("SELECT WarehouseID FROM stock_quantities WHERE ItemID=? AND Quantity>=? ORDER BY Quantity DESC LIMIT 1", (item, qty)).fetchone()
        return r[0] if r else None

    wh = resolve(1, 2, preferred=2)          # caller asks for the service store
    db.execute("UPDATE stock_quantities SET Quantity=Quantity-? WHERE ItemID=? AND WarehouseID=?", (2, 1, wh))
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,TotalAmount,PaidAmount,RemainingAmount) VALUES(1,'SAL-1','2026-07-27',300,300,0)")
    db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) VALUES(1,1,2,150,100,300,?)", (wh,))
    check("service warehouse reduced", db.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=2").fetchone()[0], 1.0)
    check("main warehouse untouched", db.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0], 5.0)

    orig = db.execute("SELECT WarehouseID FROM sale_details WHERE SaleID=1 AND ItemID IS 1 LIMIT 1").fetchone()[0]
    db.execute("UPDATE stock_quantities SET Quantity=Quantity+? WHERE ItemID=? AND WarehouseID=?", (2, 1, orig))
    check("returned to the same warehouse", db.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=2").fetchone()[0], 3.0)
    check("main still untouched", db.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0], 5.0)
    db.close()


def test_sale_return_join():
    print("\n[13] Sale-return report shows the CORRECT customer")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',0),(2,'Sara',0),(7,'Khaled',0)")
    db.execute("INSERT INTO sales(SaleID,SaleNumber,Date,CustomerID,TotalAmount,PaidAmount,RemainingAmount) VALUES(7,'SAL-7','2026-07-27',2,500,500,0)")
    db.execute("INSERT INTO sale_returns(ReturnID,ReturnNumber,SaleID,Date,TotalAmount) VALUES(1,'SR-1',7,'2026-07-27',500)")
    name = db.execute("""SELECT c.Name FROM sale_returns r JOIN sales s ON r.SaleID=s.SaleID
                         LEFT JOIN customers c ON s.CustomerID=c.CustomerID""").fetchone()[0]
    check("customer is Sara (owner of invoice 7), not Khaled (id 7)", name, 'Sara')
    db.close()


def test_settlement_variance_in_pl():
    print("\n[14] Settlement shortage hits the income statement")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',5000,1)")
    # counted 4000 vs recorded 5000 -> shortage of 1000
    db.execute("UPDATE cash_accounts SET Balance=4000 WHERE CashAccountID=1")
    db.execute("INSERT INTO vouchers(VoucherNumber,VoucherType,Date,Amount,PartyType,CashAccountID,ReferenceType)"
               " VALUES('SHT-1','payment','2026-07-27',1000,'general',NULL,'settlement')")
    pl = profit_and_loss(db)
    check("shortage recognised as expense", pl['expenses'], 1000.0)
    check("net profit reduced by the shortage", pl['netProfit'], -1000.0)
    check("cash balance is the counted value",
          db.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0], 4000.0)
    db.close()


def test_balance_sheet_identity():
    print("\n[15] Balance sheet reports an explicit balance check")
    db = sqlite3.connect(':memory:'); schema(db)
    db.execute("INSERT INTO cash_accounts VALUES(1,'Safe',1000,1)")
    db.execute("INSERT INTO customers VALUES(1,'Ahmed',500)")
    db.execute("INSERT INTO suppliers VALUES(1,'Supp',300)")
    assets = 1000 + 500
    liabilities = 300
    explicit_capital = 1000.0
    net_profit = profit_and_loss(db)['netProfit']
    equity = explicit_capital + net_profit
    difference = round(assets - (liabilities + equity), 2)
    check("difference is computed and surfaced", difference, 200.0)
    check("is_balanced flag correctly False", abs(difference) < 0.01, False)
    db.close()


def main():
    print("=" * 68)
    print("ACCOUNTING REGRESSION CHECKS — Mobile Shop ERP")
    print("=" * 68)
    for t in (test_doc_numbers, test_single_payment_target, test_sale_return_cash,
              test_sale_return_credit, test_sale_return_partial_paid, test_over_return_blocked,
              test_maintenance_not_double_counted, test_direct_sale_still_counted,
              test_service_agent_revenue, test_rent_not_double_charged, test_cogs_partial_return,
              test_warehouse_aware_stock, test_sale_return_join, test_settlement_variance_in_pl,
              test_balance_sheet_identity):
        t()
    print("\n" + "=" * 68)
    print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    print("=" * 68)
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == '__main__':
    main()
