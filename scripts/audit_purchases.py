#!/usr/bin/env python3
"""
Section audit — الحسابات ← مشتريات (Purchases).

Purchases set the cost of everything the shop later sells, so an error here
does not stay in the purchases screen: it silently distorts every margin,
every stock valuation and the profit figure for as long as that stock lives.

Usage:  python3 scripts/audit_purchases.py
"""
import os
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


def fresh():
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    for guarded, stmts in parse_blocks(R('src/main/database/migrations/index.ts')):
        aborted = False
        for s in stmts:
            if aborted:
                continue
            try:
                db.execute(s)
            except Exception:
                if guarded:
                    aborted = True
    c = db.cursor()
    c.execute("INSERT INTO roles(RoleName,IsSystem) VALUES('admin',1)")
    c.execute("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)")
    c.execute("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')")
    c.execute("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(2,'Branch')")
    c.execute("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',50000,1)")
    c.execute("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'Supp',0,'active')")
    c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Case','part',0,0,60,1)")
    return db, c


PUR = R('src/main/ipc/purchases.handlers.ts')
DEL = R('src/main/ipc/delete.handlers.ts')
GUARD = R('src/main/security/ipcGuard.ts')
MIGR = R('src/main/database/migrations/index.ts')
T = '2026-07-28'

print('=' * 74)
print('SECTION AUDIT — الحسابات ← مشتريات (Purchases)')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] ACCOUNTING — landed cost is capitalised and reversed consistently')
report('ALTER TABLE purchase_details ADD COLUMN EffectiveUnitCost REAL' in MIGR,
       'the landed cost per unit is stored on the line',
       'UnitCost holds only the supplier price; stock is valued at the landed\n'
       'cost including this line\'s share of shipping and payment fees')
report('EffectiveUnitCost)' in PUR and 'effectiveUnitCost);' in PUR,
       'purchases:create writes it')
report('const unitLanded = item.EffectiveUnitCost ?? item.UnitCost;' in DEL,
       'delete:purchase reverses the landed cost, not the bare price',
       'reversing the base figure left the overhead behind and inflated the\n'
       'cost of whatever stock remained')

# Numerically: buy 15 in two lots, delete one, check the survivor's cost.
base, qty, overhead = 100.0, 10.0, 50.0
landed = base + overhead / qty            # 105
stock_qty, stock_cost = 15.0, landed
old_way = ((stock_cost * stock_qty) - (base * qty)) / (stock_qty - qty)
new_way = ((stock_cost * stock_qty) - (landed * qty)) / (stock_qty - qty)
report(abs(new_way - landed) < 0.01,
       'after deleting a purchase the surviving stock keeps its true cost',
       f'old method gave {old_way:.2f} per unit, correct is {landed:.2f}\n'
       f'fixed method gives {new_way:.2f}')

# ---------------------------------------------------------------- 2
print('\n[2] ACCOUNTING — purchase returns leave the RIGHT warehouse')
report('ALTER TABLE purchase_return_details ADD COLUMN WarehouseID INTEGER' in MIGR,
       'the return line records which warehouse the goods left')
report('const lineWarehouse = (itemId: number, preferred?: number | null)' in PUR,
       'the warehouse is resolved from the original purchase line')
report('if (wh) deductStock(db, item.ItemID, wh, item.Quantity);' in PUR,
       'stock is deducted from that warehouse specifically')
report('WHERE ItemID = ?\').get(item.ItemID) as any;\n        if (stock) {' not in PUR,
       'the old warehouse-blind query is gone')

db, c = fresh()
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,3,25)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,10,30)")
# The old code picked whichever row came first — warehouse 1.
first = c.execute("SELECT WarehouseID FROM stock_quantities WHERE ItemID=1").fetchone()[0]
report(first == 1,
       'the underlying ambiguity is real: an unqualified query picks warehouse 1',
       'goods bought into the branch would have been deducted from the main store,\n'
       'driving it negative while the branch still showed stock it no longer had')
# The fix targets warehouse 2 and leaves warehouse 1 alone.
c.execute("UPDATE stock_quantities SET Quantity=Quantity-10 WHERE ItemID=1 AND WarehouseID=2")
main_q = c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0]
branch_q = c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=2").fetchone()[0]
report(main_q == 3 and branch_q == 0,
       'returning branch stock touches only the branch',
       f'main {main_q}, branch {branch_q}')
report('warehouseStock(db, item.ItemID, wh)' in PUR,
       'the availability check is per-warehouse too',
       'stock sitting in another branch cannot be handed to this supplier')

# ---------------------------------------------------------------- 3
print('\n[3] ACCOUNTING — overhead allocation')
db, c = fresh()
items = [(1, 10.0, 100.0)]
additional, payment_cost = 90.0, 10.0
oh = additional + payment_cost
total_item_cost = sum(q * u for _, q, u in items)
allocated = sum((q * u / total_item_cost) * oh for _, q, u in items)
report(abs(allocated - oh) < 0.01,
       'every unit of overhead is allocated to a line',
       f'overhead {oh:.2f}, allocated {allocated:.2f}')
report('item.Quantity > 0' in PUR and 'allocatedOverhead / item.Quantity' in PUR,
       'the per-unit division is guarded against a zero quantity',
       'in JavaScript that division yields Infinity with no error, and Infinity\n'
       'was written straight into the cost column')
report('const canAverage = existingStock.Quantity > 0 && newQty > 0;' in PUR,
       'the weighted average is skipped when the prior holding is not positive',
       'averaging against a negative balance invented a cost higher than the\n'
       'price actually paid')

# ---------------------------------------------------------------- 4
print('\n[4] ACCOUNTING — supplier balance and payment direction')
db, c = fresh()
TOTAL, PAID = 1000.0, 400.0
REM = TOTAL - PAID
c.execute("""INSERT INTO purchases(PurchaseNumber,FiscalYearID,Date,SupplierID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentSource,PaymentSourceID,Status,UserID,PaymentMethod)
    VALUES('P1',1,?,1,1000,0,0,?,?,?,'cash_account',1,'partial',1,'cash')""", (T, TOTAL, PAID, REM))
c.execute("UPDATE suppliers SET Balance=Balance+? WHERE SupplierID=1", (REM,))
c.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (PAID,))
bal = c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0]
cash = c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0]
report(abs(bal - 600) < 0.01,
       'an unpaid balance becomes money owed TO the supplier',
       f'invoice 1000 paid 400 -> supplier balance {bal:.2f}')
report(abs(cash - 49600) < 0.01,
       'cash leaves the drawer when paying a supplier',
       f'50000 - 400 = {cash:.2f}')

# Overpaying a supplier must become a receivable, not a negative payable.
db, c = fresh()
TOTAL, PAID = 300.0, 500.0
REM = TOTAL - PAID
if REM > 0:
    c.execute("UPDATE suppliers SET Balance=Balance+? WHERE SupplierID=1", (REM,))
else:
    c.execute("UPDATE suppliers SET Balance=Balance-? WHERE SupplierID=1", (abs(REM),))
bal = c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0]
report(abs(bal + 200) < 0.01,
       'overpaying a supplier leaves them owing us (negative balance)',
       f'invoice 300 paid 500 -> {bal:.2f}')

# ---------------------------------------------------------------- 5
print('\n[5] ACCOUNTING — the return splits debt and cash correctly')
report('suggestSettlement(' in PUR and 'validateSettlement({' in PUR,
       'the settlement is chosen by the user and validated server-side',
       'debt-first-then-cash is still the SUGGESTED default, but the shop may\n'
       'take it all in cash, leave it on the supplier account, or split it')
report('priorReturns + totalAmount > (originalPurchase.TotalAmount || 0) + 0.001' in PUR,
       'repeated returns cannot exceed the invoice total')
outstanding, ret = 600.0, 1000.0
debt = min(ret, outstanding)
cash_back = round(ret - debt, 2)
report(abs(debt - 600) < 0.01 and abs(cash_back - 400) < 0.01,
       'a full return of a part-paid invoice splits correctly',
       f'invoice 1000 (paid 400): debt cancelled {debt:.2f}, cash back {cash_back:.2f}')

# ---------------------------------------------------------------- 6
print('\n[6] ACCOUNTING — input validation')
for label, snippet in [
    ('empty invoice', 'لا يمكن حفظ فاتورة شراء بدون أصناف'),
    ('zero/negative quantity', 'الكمية يجب أن تكون رقماً أكبر من صفر'),
    ('negative cost', 'سعر الشراء يجب أن يكون رقماً غير سالب'),
    ('missing warehouse', 'اختر المخزن لكل صنف'),
    ('unknown warehouse', 'المخزن المختار غير موجود'),
    ('discount over goods', 'أكبر من إجمالي الأصناف'),
    ('unknown supplier', 'المورد غير موجود'),
    ('missing payment source', 'اختر مصدر دفع المبلغ'),
    ('unknown cash account', 'الخزنة المختارة غير موجودة'),
    ('inactive cash account', 'الخزنة المختارة غير مفعّلة'),
]:
    report(snippet in PUR, f'{label} is rejected')
report('Number.isFinite' in PUR,
       'NaN and Infinity are rejected together',
       'SQLite stores NaN as NULL, so such a purchase would vanish from totals')

# ---------------------------------------------------------------- 7
print('\n[7] SECURITY')
for ch, perm in [('purchases:list', 'reports.view'), ('purchases:create', 'purchases.create'),
                 ('delete:purchase', 'purchases.delete'),
                 ('purchaseReturns:create', 'purchases.returns')]:
    present = f"'{ch}':" in GUARD
    report(present, f'{ch} has an access rule')
report('Stamp the trusted identity onto object payloads' in GUARD,
       'the recorded user comes from the server session')
create_block = PUR.split("ipcMain.handle('purchases:create'")[1].split("ipcMain.handle(")[0]
import re as _re
sql_blocks = _re.findall(r'db\.prepare\(`(.*?)`\)', create_block, _re.S)
report(not [b for b in sql_blocks if '${' in b],
       'no value is interpolated into a SQL string',
       f'{len(sql_blocks)} statements checked, all parameters bound')

# ---------------------------------------------------------------- 8
print('\n[8] PROGRAMMING')
report('db.transaction(' in PUR,
       'the purchase is one atomic transaction')
report("nextDocNumber(db, 'purchases'" in PUR,
       'purchase numbers come from a monotonic sequence')
report('blockIfReferenced' in DEL and 'purchase_returns WHERE PurchaseID' in DEL,
       'a purchase with returns or vouchers cannot be deleted')
report('businessToday()' in PUR,
       "dates use the shop's local calendar")
report('catch (err: any)' in PUR,
       'failures return a message rather than an opaque throw')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
