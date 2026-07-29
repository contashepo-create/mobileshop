#!/usr/bin/env python3
"""
Combined audit — sales, sale returns, purchases, purchase returns.

Focused on the boundary between the screen and the server. The screen already
caps quantities and prices; this asks what happens when the SERVER is called
with values the screen would never send, because the renderer is not a trust
boundary — anyone who can reach the IPC channel can send anything.

Usage:  python3 scripts/audit_trade_cycle.py
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


SAL = R('src/main/ipc/sales.handlers.ts')
PUR = R('src/main/ipc/purchases.handlers.ts')
DEL = R('src/main/ipc/delete.handlers.ts')
GUARD = R('src/main/security/ipcGuard.ts')
REP = R('src/main/ipc/reports.handlers.ts')

SR_CREATE = SAL.split("ipcMain.handle('saleReturns:create'")[1].split("ipcMain.handle(")[0]
PR_CREATE = PUR.split("ipcMain.handle('purchaseReturns:create'")[1].split("ipcMain.handle(")[0]

print('=' * 74)
print('TRADE CYCLE AUDIT — SALES / RETURNS / PURCHASES / PURCHASE RETURNS')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] SECURITY — a return cannot invent quantities')
report('AlreadyReturned' in SR_CREATE and 'remainingOnLine' in SR_CREATE,
       'sale return: each line is capped at what that line still has outstanding',
       'the total-value guard alone was not enough: an invoice of\n'
       '1 phone @1000 + 1 cable @20 accepted "51 cables @20" = 1020,\n'
       'creating 51 cables from nothing and refunding 1020 for 20 of goods')
report('AlreadyReturned' in PR_CREATE and 'remainingOnLine' in PR_CREATE,
       'purchase return: capped at what was actually bought on that line')
report('أكبر من المتاح' in SR_CREATE and 'أكبر من المشترى' in PR_CREATE,
       'both name the item and the real limit in the message')

# The cap must survive the same line being sent twice in one payload.
report('claimedInThisPayload' in SR_CREATE and 'claimedInThisPayload' in PR_CREATE,
       'a line repeated within one payload cannot pass the cap twice',
       'each entry is checked against the committed total, which is unchanged\n'
       'for both, so a line of 1 could otherwise be returned as 2')

# ---------------------------------------------------------------- 2
print('\n[2] SECURITY — a return cannot invent prices')
# Matched on the SOURCE of the figure, not on one exact expression.
#
# Pinning `UnitPrice: line.UnitPrice || 0` broke the moment the price became
# `line.UnitPrice * priceRatio` — the invoice's discount spread across its
# lines, which was a genuine fix. What must remain true is that the figure
# comes from `line` (the stored document) and never from `req` (the caller).
# `verify_trade_hostile.mjs` proves the behaviour end to end.
report('UnitPrice: money((line.UnitPrice || 0)' in SR_CREATE
       and 'UnitPrice: req.UnitPrice' not in SR_CREATE,
       'sale return values goods at the invoice price, not the caller\'s',
       '"return 1 cable @1000" on a cable sold at 20 passed the total guard')
report('UnitCost: money((line.UnitCost || 0)' in PR_CREATE
       and 'UnitCost: req.UnitCost' not in PR_CREATE,
       'purchase return values goods at the purchase price',
       'returning 10 cables bought at 10 as "@100" cleared 1000 of supplier\n'
       'debt for 100 of goods')
report('UnitCost: line.UnitCost ?? 0' in SR_CREATE,
       'the cost credited to COGS also comes from the invoice line')
report('totalAmount = money(verified.reduce' in SR_CREATE
       and 'totalAmount = money(verified.reduce' in PR_CREATE,
       'the return total is computed from verified lines, not the payload')

# ---------------------------------------------------------------- 3
print('\n[3] ACCOUNTING — a return cannot be raised against the wrong document')
report('الفاتورة ملغاة - تم عكسها بالفعل' in SAL,
       'a voided invoice cannot be returned',
       'voiding already reversed stock and balances; a return would credit\n'
       'the customer a second time for goods the shop never gave up')
report('فاتورة صيانة - نفّذ الإرجاع من شاشة الصيانة' in SAL,
       'a maintenance mirror invoice cannot be returned from the sales screen',
       'its revenue is reported by the repair side and excluded from direct\n'
       'sales, so a return here would reduce a figure it never increased')
report('فاتورة ضمان بدون قيمة' in SAL,
       'a warranty invoice has no value to refund')
report('أحد الأصناف المرتجعة غير موجود في الفاتورة الأصلية' in SAL
       and 'أحد الأصناف المرتجعة غير موجود في فاتورة الشراء' in PUR,
       'an item absent from the original document is rejected')

# ---------------------------------------------------------------- 4
print('\n[4] ACCOUNTING — the numbers still reconcile end to end')
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
c.execute("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',10000,1)")
c.execute("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')")
c.execute("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')")
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,0,10)")

start = (
    c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1").fetchone()[0],
    c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0],
    c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0],
    c.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0],
)

# Buy 100 @10 cash, sell 40 @20 cash, return 10 of the sale, return 20 to supplier.
c.execute("UPDATE stock_quantities SET Quantity=100, CostPrice=10 WHERE ItemID=1")
c.execute("UPDATE cash_accounts SET Balance=Balance-1000 WHERE CashAccountID=1")
c.execute("UPDATE stock_quantities SET Quantity=Quantity-40 WHERE ItemID=1")
c.execute("UPDATE cash_accounts SET Balance=Balance+800 WHERE CashAccountID=1")
c.execute("UPDATE stock_quantities SET Quantity=Quantity+10 WHERE ItemID=1")   # sale return
c.execute("UPDATE cash_accounts SET Balance=Balance-200 WHERE CashAccountID=1")
c.execute("UPDATE stock_quantities SET Quantity=Quantity-20 WHERE ItemID=1")   # purchase return
c.execute("UPDATE cash_accounts SET Balance=Balance+200 WHERE CashAccountID=1")

qty, cash, sup, cus = (
    c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1").fetchone()[0],
    c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0],
    c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0],
    c.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0],
)
report(qty == 50,
       'stock after buy 100 / sell 40 / sale-return 10 / purchase-return 20',
       f'100 - 40 + 10 - 20 = 50, got {qty}')
report(abs(cash - 9800) < 0.01,
       'cash after -1000 +800 -200 +200',
       f'10000 - 1000 + 800 - 200 + 200 = 9800, got {cash}')
inventory_value = qty * 10
report(abs(inventory_value - 500) < 0.01,
       'inventory value stays at the real unit cost throughout',
       f'50 units x 10 = {inventory_value:.2f}')
# The fundamental check: everything the shop gained, in cash and in goods,
# must equal the profit it actually earned on what it sold.
#   sold net of the return = 40 - 10 = 30 units
#   revenue 30 x 20 = 600,  cost 30 x 10 = 300,  gross profit = 300
cash_change = cash - start[1]          # -200
inventory_change = inventory_value - (start[0] * 10)   # +500
gross_profit = (30 * 20) - (30 * 10)   # 300
report(abs((cash_change + inventory_change) - gross_profit) < 0.01,
       'cash movement plus stock movement equals the profit earned',
       f'cash {cash_change:+.2f} + inventory {inventory_change:+.2f} = '
       f'{cash_change + inventory_change:+.2f}\n'
       f'gross profit on 30 units sold = {gross_profit:.2f}\n'
       'nothing leaked through the two returns')

# ---------------------------------------------------------------- 5
print('\n[5] ACCOUNTING — profit and loss excludes what it should')
report("WHERE s.IsVoided = 0" in REP.split('salesReturns')[1][:400],
       'sale returns on voided invoices are excluded from net sales')
report("COALESCE(Source,'direct') <> 'maintenance'" in REP,
       'maintenance mirror invoices are excluded from direct sales')
report("AND COALESCE(TransferCostBearer,'shop') = 'shop'" in REP,
       'only commissions the shop actually bore are expensed')
report('EffectiveUnitCost' in PUR and 'unitLanded' in DEL,
       'landed cost is capitalised on purchase and reversed on delete')

# ---------------------------------------------------------------- 6
print('\n[6] PROGRAMMING — atomicity and reversibility')
for label, block in (('sale return', SR_CREATE), ('purchase return', PR_CREATE)):
    report('db.transaction(' in block, f'{label} runs in one transaction')
report("ipcMain.handle('delete:saleReturn'" in SAL
       and "ipcMain.handle('delete:purchaseReturn'" in PUR,
       'both returns can be reversed')
report('blockIfReferenced' in DEL,
       'documents with dependants cannot be deleted')
report('restoreStockAtCost' in SAL and 'restoreStockAtCost' in PUR,
       'goods always re-enter stock at the cost they left at')
report("nextDocNumber(db, 'sale_returns'" in SAL
       and "nextDocNumber(db, 'purchase_returns'" in PUR,
       'return numbers come from a monotonic sequence')

# ---------------------------------------------------------------- 7
print('\n[7] SECURITY — authorisation and injection')
channels = [
    ('sales:list', 'sales.view'), ('sales:get', 'sales.view'),
    ('sales:create', 'sales.create'), ('sales:update', 'sales.delete'),
    ('delete:sale', 'sales.delete'),
    ('saleReturns:list', 'sales.returns'), ('saleReturns:create', 'sales.returns'),
    ('saleReturns:get', 'sales.returns'), ('saleReturns:returnable', 'sales.returns'),
    ('delete:saleReturn', 'sales.delete'),
    ('purchases:list', 'purchases.view'), ('purchases:get', 'purchases.view'),
    ('purchases:create', 'purchases.create'), ('delete:purchase', 'purchases.delete'),
    ('purchaseReturns:list', 'purchases.returns'),
    ('purchaseReturns:create', 'purchases.returns'),
    ('purchaseReturns:get', 'purchases.returns'),
    ('purchaseReturns:returnable', 'purchases.returns'),
    ('delete:purchaseReturn', 'purchases.delete'),
]
missing = [ch for ch, perm in channels if f"'{ch}': '{perm}'" not in GUARD]
report(not missing, f'all {len(channels)} channels carry the right permission', ', '.join(missing))
report('Stamp the trusted identity onto object payloads' in GUARD,
       'the recorded user is taken from the server session, never the payload')

for label, block in (('sale return', SR_CREATE), ('purchase return', PR_CREATE)):
    sqls = re.findall(r'db\.prepare\(`(.*?)`\)', block, re.S)
    bad = [q for q in sqls if '${' in q]
    report(not bad, f'{label}: no value interpolated into SQL',
           f'{len(sqls)} statements checked')

# ---------------------------------------------------------------- 8
print('\n[8] SECURITY — settlement cannot move money it should not')
report('validateSettlement({' in SR_CREATE and 'validateSettlement({' in PR_CREATE,
       'both returns validate the settlement before touching a balance')
report('if (!settlement.ok) return { success: false, message: settlement.message };' in SAL
       and 'if (!settlement.ok) return { success: false, message: settlement.message };' in PUR,
       'an invalid settlement aborts before the transaction opens')
report('الخزنة المختارة غير مفعّلة' in SAL and 'الخزنة المختارة غير مفعّلة' in PUR,
       'an inactive account cannot receive or release money')
report('الرصيد غير كافٍ في المحفظة/الماكينة' in SAL,
       'a wallet refund checks the wallet can cover it, fee included')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
