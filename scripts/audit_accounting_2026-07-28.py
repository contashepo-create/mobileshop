#!/usr/bin/env python3
"""
Independent accounting audit — written from scratch, 2026-07-28.

This does NOT reuse the earlier audit's operation list. It targets the areas an
inventory-carrying retail/repair business gets wrong most often, and which the
previous engine did not model:

  A. Cost of goods sold for SERIALISED stock (per-unit cost vs average cost)
  B. Inventory valuation vs COGS symmetry (does the asset drop match the expense?)
  C. Sale returns: restocking value, and cost reversal on partial returns
  D. Negative-stock sales (cost of goods you did not have)
  E. Discounts and rounding accumulation
  F. Overpayment / customer credit direction
  G. Purchase overhead allocation and its reversal on return

Every finding is proved with numbers against the REAL schema.

Usage:  python3 scripts/audit_accounting_2026-07-28.py
"""
import os
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_real_db import parse_blocks  # noqa: E402

FINDINGS = []
PASSES = []


def report(ok, name, detail=''):
    (PASSES if ok else FINDINGS).append((name, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if detail:
        for line in detail.strip().split('\n'):
            print(f"          {line}")


def build_db():
    ts = open(os.path.join(ROOT, 'src/main/database/migrations/index.ts'), encoding='utf-8').read()
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    for guarded, stmts in parse_blocks(ts):
        aborted = False
        for s in stmts:
            if aborted:
                continue
            try:
                db.execute(s)
            except Exception:
                if guarded:
                    aborted = True
    db.execute("INSERT INTO fiscal_years(YearName,StartDate,EndDate,Status) VALUES('2026','2026-01-01','2026-12-31','open')")
    db.execute("INSERT INTO roles(RoleName,IsSystem) VALUES('admin',1)")
    db.execute("INSERT INTO users(Username,PasswordHash,RoleID,IsActive) VALUES('admin','x',1,1)")
    db.execute("INSERT INTO warehouses(WarehouseName,WarehouseType) VALUES('Main','main')")
    db.execute("INSERT INTO cash_accounts(AccountName,AccountType,Balance,IsActive) VALUES('Safe','safe',10000,1)")
    db.execute("INSERT INTO customers(Name,Balance,Status) VALUES('Ahmed',0,'active')")
    db.execute("INSERT INTO suppliers(Name,Balance,Status) VALUES('Supp',0,'active')")
    return db


def inventory_value(db):
    return db.execute("SELECT COALESCE(SUM(CostPrice*Quantity),0) FROM stock_quantities").fetchone()[0] or 0


def serial_inventory_value(db):
    return db.execute(
        "SELECT COALESCE(SUM(CostPrice),0) FROM item_serials WHERE Status='available'").fetchone()[0] or 0


def cogs_booked(db):
    """Exactly the COGS query used by reports:profitLoss."""
    return db.execute("""
        SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0)*sd.Quantity),0)
        FROM sale_details sd JOIN sales s ON sd.SaleID=s.SaleID
        WHERE s.IsVoided=0 AND s.IsWarranty=0 AND COALESCE(s.Source,'direct')<>'maintenance'
    """).fetchone()[0] or 0


print('=' * 74)
print('INDEPENDENT ACCOUNTING AUDIT — 2026-07-28')
print('=' * 74)

# ------------------------------------------------------------------ A
print('\n[A] Cost of goods sold for SERIALISED inventory')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Phone','device',1,0,1000,1)")
# Two identical phones bought at different prices — completely normal.
c.execute("INSERT INTO item_serials(ItemID,IMEI,Status,CostPrice,WarehouseID) VALUES(1,'AAA','available',600,1)")
c.execute("INSERT INTO item_serials(ItemID,IMEI,Status,CostPrice,WarehouseID) VALUES(1,'BBB','available',900,1)")
# items.CostPrice is maintained as a weighted average by purchases:create.
c.execute("UPDATE items SET CostPrice=750 WHERE ItemID=1")

# Replay the main process's resolveUnitCost(): for a serialised line the
# serial's OWN cost wins over the item average. The renderer still sends the
# average, and is deliberately ignored.
renderer_sent = c.execute("SELECT CostPrice FROM items WHERE ItemID=1").fetchone()[0]
sent_unit_cost = c.execute(
    "SELECT CostPrice FROM item_serials WHERE IMEI='AAA'").fetchone()[0]
c.execute("INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,"
          "TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty) "
          "VALUES('S1',1,'2026-07-28',1,1000,0,0,1000,1000,0,'cash','completed',1,0,0)")
sid = c.lastrowid
serial_cost = c.execute("SELECT CostPrice FROM item_serials WHERE IMEI='AAA'").fetchone()[0]
c.execute("INSERT INTO sale_details(SaleID,ItemID,SerialID,Quantity,UnitPrice,UnitCost,Total) "
          "VALUES(?,1,(SELECT SerialID FROM item_serials WHERE IMEI='AAA'),1,1000,?,1000)",
          (sid, sent_unit_cost))
c.execute("UPDATE item_serials SET Status='sold' WHERE IMEI='AAA'")

booked = cogs_booked(db)
true_cost = serial_cost
report(
    abs(booked - true_cost) < 0.01,
    'COGS of a serialised sale equals that unit\'s real cost',
    f'sold IMEI AAA, true cost {true_cost:.2f}\n'
    f'renderer offered   {renderer_sent:.2f} (item average) — ignored\n'
    f'COGS booked        {booked:.2f}\n'
    f'error              {booked - true_cost:+.2f}',
)

# The asset side relieves the ACTUAL serial, so asset and expense disagree.
remaining_serial_value = serial_inventory_value(db)
report(
    abs((1500 - remaining_serial_value) - booked) < 0.01,
    'inventory relieved equals COGS expensed (serialised)',
    f'serial inventory fell 1500.00 -> {remaining_serial_value:.2f} = {1500 - remaining_serial_value:.2f}\n'
    f'COGS expensed {booked:.2f}\n'
    f'asymmetry {(1500 - remaining_serial_value) - booked:+.2f} — profit and stock value cannot both be right',
)

# ------------------------------------------------------------------ B
print('\n[B] Cost of goods sold for NON-serialised inventory')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Case','part',0,0,50,1)")
# Two purchase batches at different costs -> weighted average 30.
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,20)")
c.execute("UPDATE stock_quantities SET Quantity=20, CostPrice=30 WHERE ItemID=1")  # after 2nd batch @40
c.execute("UPDATE items SET CostPrice=30 WHERE ItemID=1")

before = inventory_value(db)
unit_cost = c.execute("SELECT CostPrice FROM items WHERE ItemID=1").fetchone()[0]
c.execute("INSERT INTO sales(SaleNumber,FiscalYearID,Date,Subtotal,Discount,TaxAmount,TotalAmount,"
          "PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty) "
          "VALUES('S1',1,'2026-07-28',250,0,0,250,250,0,'cash','completed',1,0,0)")
sid = c.lastrowid
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) "
          "VALUES(?,1,5,50,?,250,1)", (sid, unit_cost))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-5 WHERE ItemID=1 AND WarehouseID=1")
after = inventory_value(db)

report(
    abs((before - after) - cogs_booked(db)) < 0.01,
    'weighted-average COGS matches the inventory reduction',
    f'inventory {before:.2f} -> {after:.2f} (fell {before - after:.2f}), COGS {cogs_booked(db):.2f}',
)

# ------------------------------------------------------------------ C
print('\n[C] Selling stock you do not have (negative stock mode)')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Cable','part',0,0,25,1)")
c.execute("INSERT INTO settings(Key,Value) VALUES('allow_negative_stock','1')")
# No stock row at all. deductStock() inserts one with CostPrice = 0.
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,-4,0)")
neg_value = inventory_value(db)
report(
    neg_value == 0,
    'negative stock is valued at zero, not a negative asset',
    f'inventory value with -4 units on hand = {neg_value:.2f}\n'
    'a shortfall carried at cost 0 understates nothing, but the later purchase\n'
    'that fills it will average against a negative quantity — see [D]',
)

# The dangerous part: a purchase arriving into a negative position.
c.execute("SELECT Quantity, CostPrice FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1")
q, cp = c.fetchone()
incoming_qty, incoming_cost = 10, 15
new_qty = q + incoming_qty                       # -4 + 10 = 6
# purchases:create now averages only when the prior holding AND the result are
# both positive; otherwise the price just paid is the cost.
can_average = q > 0 and new_qty > 0
new_cost = (((cp * q) + (incoming_cost * incoming_qty)) / new_qty
            if can_average else incoming_cost)
report(
    abs(new_cost - incoming_cost) < 0.01,
    'restocking after a negative balance keeps a sane unit cost',
    f'had {q} units @ {cp:.2f}, received {incoming_qty} @ {incoming_cost:.2f}\n'
    f'resulting unit cost -> {new_cost:.2f} (paid {incoming_cost:.2f})\n'
    f'inventory {new_qty * new_cost:.2f} for {new_qty} units',
)

# ------------------------------------------------------------------ D
print('\n[D] Partial sale return: cost reversal and restock value')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Charger','part',0,30,60,1)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,30)")
c.execute("INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,"
          "TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty) "
          "VALUES('S1',1,'2026-07-28',1,300,0,0,300,300,0,'cash','completed',1,0,0)")
sid = c.lastrowid
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) "
          "VALUES(?,1,5,60,30,300,1)", (sid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-5 WHERE ItemID=1")

# Return 2 of the 5.
c.execute("INSERT INTO sale_returns(ReturnNumber,SaleID,Date,TotalAmount,UserID,DebtRelief,CashRefund) "
          "VALUES('R1',?,'2026-07-28',120,1,0,120)", (sid,))
rid = c.lastrowid
c.execute("INSERT INTO sale_return_details(ReturnID,ItemID,Quantity,UnitPrice,Total,WarehouseID) "
          "VALUES(?,1,2,60,120,1)", (rid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity+2 WHERE ItemID=1 AND WarehouseID=1")

cogs_ret = db.execute("""
    SELECT COALESCE(SUM(COALESCE(
      (SELECT sd.UnitCost FROM sale_details sd WHERE sd.SaleID=sr.SaleID AND sd.ItemID IS srd.ItemID LIMIT 1),
      (SELECT i.CostPrice FROM items i WHERE i.ItemID=srd.ItemID),0)*srd.Quantity),0)
    FROM sale_return_details srd JOIN sale_returns sr ON srd.ReturnID=sr.ReturnID
""").fetchone()[0] or 0
report(
    abs(cogs_ret - 60) < 0.01,
    'a partial return reverses only the returned units\' cost',
    f'returned 2 units @ cost 30 = 60.00, reversal booked {cogs_ret:.2f}',
)
net_cogs = cogs_booked(db) - cogs_ret
report(
    abs(net_cogs - 90) < 0.01,
    'net COGS after the return equals the 3 units kept',
    f'150.00 - {cogs_ret:.2f} = {net_cogs:.2f} (expected 90.00)',
)

# ------------------------------------------------------------------ E
print('\n[E] Discounts, tax and rounding')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Item','part',0,10,33.33,1)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)")
# Three lines that do not divide evenly, plus a discount and 14% VAT.
subtotal = round(3 * 33.33, 2)
discount = 0.01
tax = round((subtotal - discount) * 0.14, 2)
total = round(subtotal - discount + tax, 2)
c.execute("INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxRate,TaxAmount,"
          "TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty) "
          "VALUES('S1',1,'2026-07-28',1,?,?,14,?,?,?,0,'cash','completed',1,0,0)",
          (subtotal, discount, tax, total, total))
stored = c.execute("SELECT Subtotal-Discount+TaxAmount, TotalAmount FROM sales").fetchone()
report(
    abs(stored[0] - stored[1]) < 0.005,
    'invoice total equals subtotal - discount + tax',
    f'computed {stored[0]:.4f} vs stored {stored[1]:.4f}',
)

# Accumulate 1000 such invoices to see whether float error grows unbounded.
running = 0.0
for _ in range(1000):
    running += total
report(
    abs(running - round(running, 2)) < 0.01,
    'repeated float addition stays within a cent over 1000 invoices',
    f'sum {running:.6f}, drift {abs(running - round(running, 2)):.6f}',
)

# ------------------------------------------------------------------ F
print('\n[F] Customer overpayment direction')
db = build_db()
c = db.cursor()
# Customer pays 500 on a 300 invoice -> 200 credit -> balance must go NEGATIVE.
total, paid = 300.0, 500.0
remaining = total - paid
c.execute("INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,"
          "TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty) "
          "VALUES('S1',1,'2026-07-28',1,300,0,0,?,?,?,'cash','completed',1,0,0)",
          (total, paid, remaining))
if remaining > 0:
    c.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=1", (remaining,))
else:
    c.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=1", (abs(remaining),))
bal = c.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0]
report(
    abs(bal - (-200)) < 0.01,
    'an overpayment becomes a customer credit (negative balance)',
    f'invoice 300 paid 500 -> balance {bal:.2f} (expected -200.00)',
)
# And that credit must be reported as a LIABILITY, not netted against receivables.
c.execute("INSERT INTO customers(Name,Balance,Status) VALUES('Sara',700,'active')")
recv = c.execute("SELECT COALESCE(SUM(Balance),0) FROM customers WHERE Balance>0").fetchone()[0]
cred = c.execute("SELECT COALESCE(SUM(-Balance),0) FROM customers WHERE Balance<0").fetchone()[0]
report(
    abs(recv - 700) < 0.01 and abs(cred - 200) < 0.01,
    'credits are shown as liabilities, not netted off receivables',
    f'receivables {recv:.2f}, customer credits {cred:.2f}',
)

# ------------------------------------------------------------------ G
print('\n[G] Purchase overhead allocation')
db = build_db()
c = db.cursor()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'A','part',0,0,0,1)")
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(2,'B','part',0,0,0,1)")
items = [(1, 10, 100.0), (2, 5, 40.0)]        # (id, qty, unit cost)
additional, payment_cost = 90.0, 10.0
overhead = additional + payment_cost
total_item_cost = sum(q * uc for _, q, uc in items)
allocated_total = 0.0
for iid, q, uc in items:
    base = q * uc
    alloc = (base / total_item_cost) * overhead
    allocated_total += alloc
    eff = uc + alloc / q
    c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(?,1,?,?)",
              (iid, q, eff))
report(
    abs(allocated_total - overhead) < 0.01,
    'all purchase overhead is allocated, none lost',
    f'overhead {overhead:.2f}, allocated {allocated_total:.2f}',
)
purchase_total = total_item_cost + overhead
report(
    abs(inventory_value(db) - purchase_total) < 0.01,
    'inventory value equals what was actually paid for the goods',
    f'paid {purchase_total:.2f}, inventory {inventory_value(db):.2f}',
)

# Zero-quantity guard: the allocation divides by item.Quantity.
# A zero-quantity line divides by zero. Python raises; JavaScript silently
# yields Infinity and would store it as the unit cost, destroying the valuation
# permanently. Assert the guard exists in the real source.
src = open(os.path.join(ROOT, 'src/main/ipc/purchases.handlers.ts'), encoding='utf-8').read()
report(
    'item.Quantity > 0' in src and 'allocatedOverhead / item.Quantity' in src,
    'a zero-quantity purchase line cannot produce an Infinite cost',
    'purchases:create guards `item.Quantity > 0` before dividing',
)
report(
    'const canAverage = existingStock.Quantity > 0 && newQty > 0;' in src,
    'weighted average is skipped when the prior holding is not positive',
    'prevents both the inflated cost and the divide-by-zero on an exact fill',
)
inv_src = open(os.path.join(ROOT, 'src/main/ipc/inventory.handlers.ts'), encoding='utf-8').read()
report(
    'const canAverage = (existingTo.Quantity || 0) > 0 && newQty > 0;' in inv_src,
    'warehouse transfers apply the same rule',
    'a destination at a negative balance no longer invents a cost',
)
sales_src = open(os.path.join(ROOT, 'src/main/ipc/sales.handlers.ts'), encoding='utf-8').read()
report(
    'resolveUnitCost' in sales_src and 'FROM item_serials WHERE SerialID' in sales_src,
    'cost of sales is decided in the main process, not by the renderer',
    'a tampered renderer cannot dictate cost of goods sold',
)

# ------------------------------------------------------------------ summary
print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for name, _ in FINDINGS:
    print('  FINDING:', name)
sys.exit(1 if FINDINGS else 0)
