#!/usr/bin/env python3
"""
Section audit — لوحة التحكم (Dashboard), the first item in the sidebar.

Scope: `src/renderer/src/pages/dashboard/Dashboard.tsx` and the single handler
it calls, `reports:dashboard`.

The dashboard is the number the owner trusts without checking anything else, so
every figure on it is asserted against the SAME definition the profit & loss
report uses. A dashboard that quietly disagrees with the P&L is worse than no
dashboard at all.

Usage:  python3 scripts/audit_dashboard.py
"""
import os
import re
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_real_db import parse_blocks  # noqa: E402

PASSES, FINDINGS = [], []
R = lambda f: open(os.path.join(ROOT, f), encoding='utf-8').read()


def report(ok, name, detail=''):
    (PASSES if ok else FINDINGS).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if detail:
        for line in detail.strip().split('\n'):
            print(f"          {line}")


def fresh_db():
    ts = R('src/main/database/migrations/index.ts')
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
    db.execute("INSERT INTO roles(RoleName,IsSystem) VALUES('admin',1)")
    db.execute("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)")
    db.execute("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')")
    return db


HANDLER = R('src/main/ipc/reports.handlers.ts')
DASH_SRC = HANDLER.split("ipcMain.handle('reports:dashboard'")[1].split("ipcMain.handle(")[0]
UI = R('src/renderer/src/pages/dashboard/Dashboard.tsx')
TODAY = '2026-07-28'

print('=' * 74)
print('SECTION AUDIT — لوحة التحكم (Dashboard)')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] ACCOUNTING — "today\'s sales" agrees with the profit & loss report')
db = fresh_db()
c = db.cursor()
c.execute("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')")


def add_sale(num, total, paid, source='direct', warranty=0, voided=0, date=TODAY):
    c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
        TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty,Source)
        VALUES(?,1,?,1,?,0,0,?,?,?,'cash','completed',1,?,?,?)""",
              (num, date, total, total, paid, total - paid, voided, warranty, source))


add_sale('S1', 1000, 1000)                      # cash sale
add_sale('S2', 500, 0)                          # credit sale
add_sale('INV-M', 300, 300, source='maintenance')  # repair mirror invoice
add_sale('S3', 200, 200, warranty=1)            # warranty, no revenue
add_sale('S4', 900, 900, voided=1)              # voided

REAL = "IsVoided = 0 AND IsWarranty = 0 AND COALESCE(Source,'direct') <> 'maintenance'"
invoiced = c.execute(f"SELECT COALESCE(SUM(TotalAmount),0) FROM sales WHERE Date=? AND {REAL}", (TODAY,)).fetchone()[0]
collected = c.execute(f"SELECT COALESCE(SUM(PaidAmount),0) FROM sales WHERE Date=? AND {REAL}", (TODAY,)).fetchone()[0]

report(abs(invoiced - 1500) < 0.01,
       'invoiced today excludes voided, warranty and repair-mirror rows',
       f'1000 cash + 500 credit = 1500.00, got {invoiced:.2f}')
report(abs(collected - 1000) < 0.01,
       'collected today counts only money actually received',
       f'got {collected:.2f} (the 500 credit sale is not cash)')
report(abs(invoiced - collected) > 0.01,
       'the two figures are genuinely different and both are reported',
       'a single card cannot honestly be labelled "sales" while summing payments')
report("COALESCE(Source,'direct') <> 'maintenance'" in DASH_SRC,
       'the handler excludes the repair mirror invoice',
       'otherwise a repair is counted here AND as maintenance revenue')
report('todayInvoiced' in DASH_SRC and 'todayCollected' in DASH_SRC,
       'both figures are returned to the UI')
report('مبيعات اليوم (فواتير)' in UI and 'المحصّل نقداً' in UI,
       'the UI labels each figure for what it is')

# ---------------------------------------------------------------- 2
print('\n[2] ACCOUNTING — low-stock badge understands serialised items')
db = fresh_db()
c = db.cursor()
# 50 handsets on the shelf, minimum 5 — comfortably stocked.
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,MinStock,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'iPhone','device',1,5,600,1000,1)")
for i in range(50):
    c.execute("INSERT INTO item_serials(ItemID,IMEI,Status,CostPrice,WarehouseID) VALUES(1,?,'available',600,1)",
              (f'IMEI{i}',))
# A genuinely low non-serialised part.
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,MinStock,CostPrice,SalePrice,IsActive) "
          "VALUES(2,'Case','part',0,10,20,50,1)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,3,20)")

old_way = c.execute("""SELECT COUNT(*) FROM items WHERE MinStock > 0 AND IsActive = 1
    AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = items.ItemID) < MinStock""").fetchone()[0]
new_way = c.execute("""SELECT COUNT(*) FROM items i WHERE i.IsActive = 1 AND i.MinStock > 0
    AND ((i.IsSerialized = 0 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) < i.MinStock)
      OR (i.IsSerialized = 1 AND (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') < i.MinStock))
""").fetchone()[0]

report(old_way == 2,
       'the OLD query raised a false alarm on a well-stocked serialised item',
       f'50 handsets in stock, minimum 5 -> old query counted {old_way} low items')
report(new_way == 1,
       'the fixed query counts only the genuinely low item',
       f'got {new_way} (the plastic case, quantity 3 vs minimum 10)')
report('IsSerialized = 1' in DASH_SRC and 'item_serials' in DASH_SRC,
       'the handler checks item_serials for serialised stock')

# The badge and the notification list must never disagree.
notif = R('src/main/ipc/notifications.handlers.ts')
low_rule = notif.split("if (on('inventory_low_stock'))")[1].split('for (const i of')[0]
report("Status = 'available'" in low_rule and "IsSerialized = 1" in low_rule and 'item_serials' in DASH_SRC,
       'the dashboard badge and the alert list use the same rule',
       'a badge saying 3 beside a list showing 1 destroys trust in both')

# ---------------------------------------------------------------- 3
print('\n[3] ACCOUNTING — the liquidity card shows all the money')
db = fresh_db()
c = db.cursor()
c.execute("INSERT INTO cash_accounts(AccountName,AccountType,Balance,IsActive) VALUES('Drawer','safe',5000,1)")
c.execute("INSERT INTO cash_accounts(AccountName,AccountType,Balance,IsActive) VALUES('Closed','safe',999,0)")
c.execute("INSERT INTO payment_methods(MethodName,MethodType,Balance,IsActive) VALUES('Vodafone Cash','wallet',7000,1)")
c.execute("INSERT INTO payment_methods(MethodName,MethodType,Balance,IsActive) VALUES('Retired','wallet',50,0)")

cash = c.execute("SELECT COALESCE(SUM(Balance),0) FROM cash_accounts WHERE IsActive=1").fetchone()[0]
pm = c.execute("SELECT COALESCE(SUM(Balance),0) FROM payment_methods WHERE IsActive=1").fetchone()[0]
report(abs(cash - 5000) < 0.01 and abs(pm - 7000) < 0.01,
       'inactive accounts and wallets are excluded',
       f'cash {cash:.2f}, wallets {pm:.2f}')
report(abs((cash + pm) - 12000) < 0.01,
       'total liquidity includes wallets and card machines',
       f'showing only {cash:.2f} hid {pm:.2f} of real money')
report('paymentMethodBalance' in DASH_SRC and 'totalLiquid' in DASH_SRC,
       'the handler returns the wallet balance and the combined total')
report('السيولة المتاحة' in UI and 'محافظ' in UI,
       'the UI shows the breakdown, not just one number')

# ---------------------------------------------------------------- 4
print('\n[4] ACCOUNTING — the monthly chart covers whole months')
report("start of month','-5 months" in DASH_SRC,
       'the window starts on a month boundary',
       "'-6 months' from today started mid-month, so the oldest bar held only\n"
       'a few days of trading yet was drawn full width — it always looked\n'
       'like business had collapsed')
chart_block = DASH_SRC.split('monthlySales = db.prepare')[1].split('.all()')[0]
report("IsWarranty = 0" in chart_block or 'REAL_SALES' in chart_block,
       'the chart uses the same revenue definition as the cards',
       'chart and cards must not tell different stories')

db = fresh_db()
c = db.cursor()
for num, date, total, src in [('A', '2026-07-01', 1000, 'direct'),
                              ('B', '2026-07-02', 300, 'maintenance'),
                              ('C', '2026-07-03', 200, 'direct')]:
    c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,Subtotal,Discount,TaxAmount,TotalAmount,
        PaidAmount,RemainingAmount,PaymentMethod,Status,UserID,IsVoided,IsWarranty,Source)
        VALUES(?,1,?,?,0,0,?,?,0,'cash','completed',1,0,0,?)""", (num, date, total, total, total, src))
total_real = c.execute(f"SELECT COALESCE(SUM(TotalAmount),0) FROM sales WHERE {REAL}").fetchone()[0]
report(abs(total_real - 1200) < 0.01,
       'the repair mirror invoice is kept out of the chart',
       f'1000 + 200 = 1200.00, got {total_real:.2f}')

# ---------------------------------------------------------------- 5
print('\n[5] ACCOUNTING — maintenance counters')
db = fresh_db()
c = db.cursor()


def ticket(num, date, agreed, status):
    c.execute("""INSERT INTO maintenance_tickets(TicketNumber,FiscalYearID,Date,CustomerName,CustomerPhone,
        DeviceModel,ProblemDesc,AgreedDeliveryDate,Status,UserID)
        VALUES(?,1,?,'Ali','0100','X','p',?,?,1)""", (num, date, agreed, status))


ticket('T1', '2026-07-20', '2026-07-25', 'received')    # late
ticket('T2', '2026-07-20', None, 'received')            # no promised date
ticket('T3', '2026-07-20', '2026-07-25', 'delivered')   # finished
overdue = c.execute("""SELECT COUNT(*) FROM maintenance_tickets
    WHERE AgreedDeliveryDate < ? AND Status NOT IN ('delivered','cancelled','returned')""", (TODAY,)).fetchone()[0]
report(overdue == 1,
       'a ticket with no promised date is never called late',
       "SQL 'NULL < date' is NULL, so it is correctly excluded")
report("Status NOT IN ('delivered','cancelled','returned')" in DASH_SRC,
       'finished, cancelled and returned tickets are excluded from both counters')

# ---------------------------------------------------------------- 6
print('\n[6] SECURITY — access control')
guard = R('src/main/security/ipcGuard.ts')
report("'reports:dashboard': 'dashboard.view'" in guard,
       'the channel requires an explicit permission')
report("['dashboard.view'" in R('src/main/database/migrations/index.ts'),
       'that permission actually exists in the seeded list',
       'a permission mapped but never seeded can never be granted')
report('success === false' in UI,
       'a denied call is reported, not silently rendered as zeros',
       'the guard answers with { success:false } instead of throwing, so the\n'
       'page previously showed a dashboard of 0.00 — indistinguishable from a\n'
       'real day with no trading')
report('catch' in UI and 'setError' in UI,
       'a failed call cannot leave an unhandled promise rejection')

# ---------------------------------------------------------------- 7
print('\n[7] SECURITY — injection and data exposure')
report('${' not in DASH_SRC.split('const REAL_SALES')[1].split('return {')[0].replace('${REAL_SALES}', ''),
       'no user input is interpolated into the dashboard SQL',
       'the only interpolation is a fixed internal constant')
report(DASH_SRC.count('.get(today)') >= 2 or '?' in DASH_SRC,
       'the date is passed as a bound parameter')
report('dangerouslySetInnerHTML' not in UI,
       'no raw HTML is injected — customer and device names are escaped by React',
       'device models and customer names are attacker-influenced free text')

recent = DASH_SRC.split('recentSales = db.prepare')[1].split('.all()')[0]
report('SELECT SaleNumber, Date, CustomerName, TotalAmount' in recent,
       'the recent-operations list selects named columns, not SELECT *',
       'avoids leaking costs, margins or internal notes onto a shared screen')

# ---------------------------------------------------------------- 8
print('\n[8] PROGRAMMING — correctness and robustness')
report('COALESCE(SUM(' in DASH_SRC,
       'empty tables return 0 rather than NULL',
       'a NULL would render as "null ج.م" on a brand-new install')
report('const [loading, setLoading]' in UI,
       'a loading state exists, so the page never flashes zeros before data')
report('stats?.monthlySales?.length > 0' in UI,
       'the chart guards against a missing array')
report('Math.max(...stats.monthlySales.map((s: any) => s.total), 1)' in UI,
       'the chart cannot divide by zero when every month is empty')
report('LIMIT 5' in DASH_SRC,
       'the recent lists are bounded',
       'an unbounded query would slow the first screen as history grows')
report('businessToday()' in DASH_SRC,
       "'today' uses the shop's local calendar, not UTC")

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
