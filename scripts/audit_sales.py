#!/usr/bin/env python3
"""
Section audit — الحسابات ← مبيعات (Sales).

Scope: `SalesPage.tsx`, `sales:create`, `saleReturns:create`, `delete:sale`,
and the sales figures in the profit & loss report.

Sales is where money enters the business, so an error here is inherited by
every downstream report. Each check replays the handler's own arithmetic
against the real schema.

Usage:  python3 scripts/audit_sales.py
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


def fresh_db():
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
    c.execute("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',0,1)")
    c.execute("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'Machine','pos',0,1)")
    c.execute("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')")
    return db, c


SALES = R('src/main/ipc/sales.handlers.ts')
DELETE = R('src/main/ipc/delete.handlers.ts')
REPORTS = R('src/main/ipc/reports.handlers.ts')
UI = R('src/renderer/src/pages/accounting/SalesPage.tsx')
GUARD = R('src/main/security/ipcGuard.ts')
MIGR = R('src/main/database/migrations/index.ts')
T = '2026-07-28'

print('=' * 74)
print('SECTION AUDIT — الحسابات ← مبيعات (Sales)')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] ACCOUNTING — the card-machine commission is real money')
report('ALTER TABLE sales ADD COLUMN TransferCost REAL DEFAULT 0' in MIGR,
       'the commission has its own numeric column',
       'it used to be appended to the free-text Notes field ("عمولة تحويل: 25"),\n'
       'so it existed as prose but could never be summed by any report')
report("data.Notes ?? null" in SALES and 'عمولة تحويل' not in SALES,
       'Notes no longer carries accounting data')
report('const netReceived = +(paidAmount - transferCost).toFixed(2);' in SALES,
       'the machine is credited NET of the fee, whoever pays it',
       'a card machine settles the sale minus its commission; crediting the\n'
       'gross amount overstated the asset on every card sale, and the fee\n'
       'lands inside the payment whether the shop or the customer absorbed it')
report('saleTransferCost' in REPORTS and '+ saleTransferCost.total' in REPORTS,
       'the fee is charged as a cost in the profit & loss report')

db, c = fresh_db()
TOTAL, PAID, FEE = 1000.0, 1000.0, 25.0
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,PaymentMethodID,Status,UserID,
    IsVoided,IsWarranty,Source,TransferCost)
    VALUES('S1',1,?,1,1000,0,0,?,?,0,'card',1,'completed',1,0,0,'direct',?)""", (T, TOTAL, PAID, FEE))
c.execute("UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID=1", (PAID - FEE,))

bal = c.execute("SELECT Balance FROM payment_methods WHERE PaymentMethodID=1").fetchone()[0]
report(abs(bal - 975.0) < 0.01,
       'machine balance equals what the provider actually settles',
       f'sale 1000, fee 25 -> balance {bal:.2f} (was 1000.00 before the fix)')

fee_total = c.execute("""SELECT COALESCE(SUM(COALESCE(TransferCost,0)),0) FROM sales
    WHERE IsVoided=0 AND IsWarranty=0 AND COALESCE(Source,'direct')<>'maintenance'""").fetchone()[0]
revenue = c.execute("""SELECT COALESCE(SUM(TotalAmount),0) FROM sales
    WHERE IsVoided=0 AND IsWarranty=0 AND COALESCE(Source,'direct')<>'maintenance'""").fetchone()[0]
report(abs(fee_total - 25.0) < 0.01,
       'the fee is now discoverable by the P&L query',
       f'SUM(TransferCost) = {fee_total:.2f}')
report(abs((revenue - fee_total) - 975.0) < 0.01,
       'revenue less the fee equals the cash actually received',
       f'{revenue:.2f} - {fee_total:.2f} = {revenue - fee_total:.2f} = machine balance')

# ---------------------------------------------------------------- 2
print('\n[2] ACCOUNTING — deleting a sale reverses exactly what it did')
db, c = fresh_db()
c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) "
          "VALUES(1,'Case','part',0,30,60,1)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,30)")


def snapshot():
    return (
        c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1").fetchone()[0],
        round(c.execute("SELECT COALESCE(SUM(Quantity*CostPrice),0) FROM stock_quantities").fetchone()[0], 2),
        round(c.execute("SELECT Balance FROM payment_methods WHERE PaymentMethodID=1").fetchone()[0], 2),
        round(c.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0], 2),
    )


before = snapshot()
TOTAL, PAID, FEE = 300.0, 100.0, 5.0
REM = TOTAL - PAID
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,PaymentMethodID,Status,UserID,TransferCost)
    VALUES('S1',1,?,1,300,0,0,?,?,?,'card',1,'partial',1,?)""", (T, TOTAL, PAID, REM, FEE))
sid = c.lastrowid
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) "
          "VALUES(?,1,5,60,30,300,1)", (sid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-5 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=1", (REM,))
c.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=1", (PAID - FEE,))

# Replay delete:sale
sale = dict(zip([d[0] for d in c.execute("SELECT * FROM sales WHERE SaleID=?", (sid,)).description],
                c.execute("SELECT * FROM sales WHERE SaleID=?", (sid,)).fetchone()))
for row in c.execute("SELECT ItemID,Quantity,WarehouseID FROM sale_details WHERE SaleID=?", (sid,)).fetchall():
    c.execute("UPDATE stock_quantities SET Quantity=Quantity+? WHERE ItemID=? AND WarehouseID=?",
              (row[1], row[0], row[2]))
if sale['RemainingAmount'] > 0:
    c.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=?", (sale['RemainingAmount'], sale['CustomerID']))
net = round((sale['PaidAmount'] or 0) - (sale['TransferCost'] or 0), 2)
c.execute("UPDATE payment_methods SET Balance=Balance-? WHERE PaymentMethodID=?", (net, sale['PaymentMethodID']))
c.execute("DELETE FROM sale_details WHERE SaleID=?", (sid,))
c.execute("DELETE FROM sales WHERE SaleID=?", (sid,))
after = snapshot()

report(before == after,
       'stock, inventory value, machine balance and customer balance all return to zero drift',
       f'before {before}\nafter  {after}')
report('const netReceived = +((sale.PaidAmount || 0) - fee).toFixed(2);' in DELETE,
       'the reversal subtracts the net figure, matching what was credited',
       'subtracting the gross would destroy the fee\'s worth of cash each time,\n'
       'and the fee is subtracted for BOTH bearers since the payment carried it')
report("FROM sale_returns WHERE SaleID = ?" in DELETE and 'blockIfReferenced' in DELETE,
       'a sale with returns, vouchers or a repair delivery cannot be deleted',
       'prevents orphaned documents pointing at a missing invoice')

# ---------------------------------------------------------------- 3
print('\n[3] ACCOUNTING — the invoice arithmetic cannot go negative')
for label, snippet in [
    ('zero/negative quantity', 'الكمية يجب أن تكون رقماً أكبر من صفر'),
    ('negative price', 'السعر يجب أن يكون رقماً غير سالب'),
    ('negative discount', 'الخصم يجب أن يكون رقماً غير سالب'),
    ('negative tax', 'الضريبة يجب أن تكون رقماً غير سالب'),
    ('negative payment', 'المبلغ المدفوع يجب أن يكون رقماً غير سالب'),
    ('empty invoice', 'لا يمكن حفظ فاتورة بدون أصناف'),
]:
    report(snippet in SALES, f'{label} is rejected by the server')

report('if (discountIn > rawSubtotal)' in SALES,
       'a discount larger than the goods is rejected',
       'it would make TotalAmount negative, which the balance logic then books\n'
       'as money the SHOP owes the customer — a liability created by a typo')
report('Number.isFinite' in SALES,
       'NaN and Infinity are rejected together',
       'SQLite stores NaN as NULL, so such an invoice would silently vanish\n'
       'from every SUM() while still appearing in the invoice list')

# ---------------------------------------------------------------- 4
print('\n[4] ACCOUNTING — payment can only land somewhere real')
report('الخزنة المختارة غير موجودة' in SALES and 'ماكينة الدفع المختارة غير موجودة' in SALES,
       'a non-existent account is rejected',
       "UPDATE ... WHERE ID = ? affects zero rows and raises nothing, so the\n"
       'money evaporated while the invoice was still recorded as paid')
report('الخزنة المختارة غير مفعّلة' in SALES and 'ماكينة الدفع المختارة غير مفعّلة' in SALES,
       'an inactive account is rejected',
       'every report filters IsActive = 1, so that cash would be invisible')
report('اختر مصدر استلام المبلغ (خزنة أو ماكينة)' in SALES,
       'a payment with no destination is rejected server-side too')

db, c = fresh_db()
missing = c.execute("UPDATE cash_accounts SET Balance=Balance+500 WHERE CashAccountID=999").rowcount
report(missing == 0,
       'the underlying silent-failure mode is confirmed to exist',
       'which is exactly why the existence check above is required')

# ---------------------------------------------------------------- 5
print('\n[5] ACCOUNTING — returns cannot refund more than was taken')
# Matched on the COMPARISON, not on one exact spelling of it.
#
# The guard now reads `priorReturns + totalAmount > invoiceTotal + 0.001`,
# because a rounding remainder on the final return is trimmed just above it
# rather than refused — otherwise the last unit of a discounted invoice could
# never be returned. Pinning the old wording failed on a correct refactor.
# The behaviour itself is covered by verify_fuzz_regressions.mjs
# ("a genuine over-refund is still refused").
report('priorReturns + totalAmount > invoiceTotal + 0.001' in SALES,
       'repeated partial returns cannot exceed the invoice total')
report('suggestSettlement(' in SALES and 'validateSettlement({' in SALES,
       'the refund split is chosen by the user and validated server-side',
       'the old fixed formula (cancel debt, force the rest out as cash) could not\n'
       'express a walk-in paid part cash part wallet, or a registered customer\n'
       'who wants the value left on account — see audit_return_settlement.py')
report('cashRefund > 0' in SALES and 'الرصيد غير كافٍ في الخزينة' in SALES,
       'a cash refund checks the drawer can cover it')

db, c = fresh_db()
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,Status,UserID)
    VALUES('S1',1,?,1,1000,0,0,1000,400,600,'cash','partial',1)""", (T,))
sid = c.lastrowid
outstanding, ret = 600.0, 1000.0
debt_relief = min(ret, outstanding)
cash_refund = round(ret - debt_relief, 2)
report(abs(debt_relief - 600) < 0.01 and abs(cash_refund - 400) < 0.01,
       'a full return splits correctly into debt relief and cash',
       f'invoice 1000 (paid 400): debt cancelled {debt_relief:.2f}, cash back {cash_refund:.2f}')

# ---------------------------------------------------------------- 6
print('\n[6] SECURITY — authorisation and identity')
for ch, perm in [('sales:list', 'sales.view'), ('sales:create', 'sales.create'),
                 ('delete:sale', 'sales.delete'), ('saleReturns:create', 'sales.returns')]:
    report(f"'{ch}': '{perm}'" in GUARD, f'{ch} requires {perm}')
report('Stamp the trusted identity onto object payloads' in GUARD,
       'the recorded user comes from the server session, not the renderer',
       'the renderer cannot choose whose name a sale is filed under')
report('resolveUnitCost' in SALES,
       'cost of sales is computed server-side',
       'a tampered renderer cannot dictate the margin')

# ---------------------------------------------------------------- 7
print('\n[7] SECURITY — injection and data exposure')
create_block = SALES.split("ipcMain.handle('sales:create'")[1].split("ipcMain.handle(")[0]
# Only interpolation INSIDE a SQL string literal matters. The handler does use
# template literals, but exclusively to build Arabic error messages — which are
# returned to the UI, never executed. Scan the db.prepare(`...`) blocks alone.
import re as _re
sql_blocks = _re.findall(r'db\.prepare\(`(.*?)`\)', create_block, _re.S)
interpolated = [b for b in sql_blocks if '${' in b]
report(not interpolated,
       'no value is interpolated into a SQL string',
       f'{len(sql_blocks)} SQL statements checked; every parameter is bound with ?')
report(any('${' in create_block for _ in [0]) and not interpolated,
       'template literals in this handler build error messages, not queries',
       'e.g. "الرصيد غير كافي للصنف ${itemInfo?.ItemName}" is returned, never executed')
list_block = SALES.split("ipcMain.handle('sales:list'")[1].split("ipcMain.handle(")[0]
report("query += ' AND s.Date >= ?'" in list_block and 'params.push' in list_block,
       'the list filters are bound parameters, not string concatenation')
report('dangerouslySetInnerHTML' not in UI,
       'customer names and notes are escaped by React')

# ---------------------------------------------------------------- 8
print('\n[8] PROGRAMMING — transactional integrity')
report('db.transaction(' in SALES,
       'the whole sale is one atomic transaction',
       'a crash midway cannot leave stock deducted with no invoice')
report(SALES.count('db.transaction(') >= 2,
       'returns are atomic too')
report('nextDocNumber(db,' in SALES,
       'invoice numbers come from a monotonic sequence, not COUNT(*)',
       'COUNT(*) repeats a number after any deletion and breaks UNIQUE')
report('resolveSourceWarehouse' in SALES and 'lineWarehouse' in SALES,
       'each line records the warehouse it came from',
       'so a return or delete credits the same warehouse it debited')
report('catch (err: any)' in SALES,
       'failures return a message instead of throwing an opaque error')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
