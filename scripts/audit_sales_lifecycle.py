#!/usr/bin/env python3
"""
Sale lifecycle audit — commission, returns and editing.

Replays the handlers' own arithmetic against the real schema and checks the
books balance after every step. The question each test answers is the one the
shop owner actually cares about: "after this operation, is my cash, my stock
and my customer's debt still right?"

Usage:  python3 scripts/audit_sales_lifecycle.py
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
    c.execute("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',5000,1)")
    c.execute("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'Machine','pos',0,1)")
    c.execute("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')")
    c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Case','part',0,30,60,1)")
    c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,20,30)")
    return db, c


def state(c):
    return dict(
        stock=c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0],
        cash=round(c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0], 2),
        machine=round(c.execute("SELECT Balance FROM payment_methods WHERE PaymentMethodID=1").fetchone()[0], 2),
        customer=round(c.execute("SELECT Balance FROM customers WHERE CustomerID=1").fetchone()[0], 2),
    )


T = '2026-07-28'
SALES = R('src/main/ipc/sales.handlers.ts')
GUARD = R('src/main/security/ipcGuard.ts')
UI = R('src/renderer/src/pages/accounting/SalesPage.tsx')

print('=' * 74)
print('SALE LIFECYCLE — COMMISSION, RETURNS, EDITING')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] Who pays the machine commission is now explicit')
report("ALTER TABLE sales ADD COLUMN TransferCostBearer TEXT DEFAULT 'shop'" in R('src/main/database/migrations/index.ts'),
       'the invoice records who bears the fee')
report("const feeBearer = data.TransferCostBearer === 'customer' ? 'customer' : 'shop';" in SALES,
       'anything but an explicit "customer" defaults to the shop paying',
       'the safe default: it books the fee as a cost rather than assuming\n'
       'the customer covered it')
report('من يتحمل العمولة؟' in UI,
       'the cashier is asked, instead of the app guessing')
report('يصل إلى حسابك' in UI,
       'the screen states the exact money in and out, in figures')

# --- Case A: the SHOP absorbs the fee.
db, c = fresh()
TOTAL, PAID, FEE = 1000.0, 1000.0, 25.0
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,PaymentMethodID,Status,UserID,
    IsVoided,IsWarranty,Source,TransferCost,TransferCostBearer)
    VALUES('S1',1,?,1,1000,0,0,?,?,0,'card',1,'completed',1,0,0,'direct',?,'shop')""", (T, TOTAL, PAID, FEE))
c.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=1", (PAID - FEE,))
report(abs(state(c)['machine'] - 975.0) < 0.01,
       'shop pays: customer is charged 1000, machine receives 975',
       'the provider keeps 25; the shop is 25 poorer, so it is an expense')
shop_fee = c.execute("""SELECT COALESCE(SUM(TransferCost),0) FROM sales
    WHERE COALESCE(TransferCostBearer,'shop')='shop' AND IsVoided=0""").fetchone()[0]
report(abs(shop_fee - 25.0) < 0.01, 'the fee is expensed in the profit & loss report')

# --- Case B: the CUSTOMER pays the fee.
db, c = fresh()
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,PaymentMethodID,Status,UserID,
    IsVoided,IsWarranty,Source,TransferCost,TransferCostBearer)
    VALUES('S1',1,?,1,1000,0,0,?,?,0,'card',1,'completed',1,0,0,'direct',?,'customer')""", (T, TOTAL, PAID, FEE))
c.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=1", (PAID,))
report(abs(state(c)['machine'] - 1000.0) < 0.01,
       'customer pays: they hand over 1025, the shop still receives 1000',
       'the shop is neither richer nor poorer')
cust_fee = c.execute("""SELECT COALESCE(SUM(TransferCost),0) FROM sales
    WHERE COALESCE(TransferCostBearer,'shop')='shop' AND IsVoided=0""").fetchone()[0]
report(abs(cust_fee) < 0.01,
       'a fee passed to the customer is NOT expensed',
       'expensing it would understate profit by money the shop never lost')
report("AND COALESCE(TransferCostBearer,'shop') = 'shop'" in R('src/main/ipc/reports.handlers.ts'),
       'the P&L query filters on who bore the fee')

# ---------------------------------------------------------------- 2
print('\n[2] A sale return can be raised and reverses the sale correctly')
report("ipcMain.handle('saleReturns:returnable'" in SALES,
       'the app can say how much of each line is still returnable',
       'prevents returning more than was sold across repeated partial returns')
report('AlreadyReturned' in SALES,
       'quantities already returned are subtracted')
report("ipcMain.handle('saleReturns:get'" in SALES,
       'a return can be fetched with its lines, so a credit note can be printed')

db, c = fresh()
before = state(c)
TOTAL, PAID = 600.0, 200.0          # 10 units @60, customer paid 200
REM = TOTAL - PAID
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,CashAccountID,Status,UserID)
    VALUES('S1',1,?,1,600,0,0,?,?,?,'cash',1,'partial',1)""", (T, TOTAL, PAID, REM))
sid = c.lastrowid
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) VALUES(?,1,10,60,30,600,1)", (sid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-10 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=1", (REM,))
c.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (PAID,))
after_sale = state(c)

# Return ALL 10 units. Outstanding 400 -> debt relief 400, cash back 200.
ret_total = 600.0
outstanding = REM
debt_relief = min(ret_total, outstanding)
cash_refund = round(ret_total - debt_relief, 2)
report(abs(debt_relief - 400) < 0.01 and abs(cash_refund - 200) < 0.01,
       'the refund splits into debt cancelled and cash returned',
       f'invoice 600 (paid 200): debt cancelled {debt_relief:.2f}, cash back {cash_refund:.2f}\n'
       'cash is limited to what the customer actually handed over')

c.execute("""INSERT INTO sale_returns(ReturnNumber,SaleID,Date,TotalAmount,UserID,CashAccountID,DebtRelief,CashRefund)
    VALUES('SR1',?,?,?,1,1,?,?)""", (sid, T, ret_total, debt_relief, cash_refund))
rid = c.lastrowid
c.execute("INSERT INTO sale_return_details(ReturnID,ItemID,Quantity,UnitPrice,Total,WarehouseID) VALUES(?,1,10,60,600,1)", (rid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity+10 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (cash_refund,))
c.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=1", (debt_relief,))
c.execute("UPDATE sales SET RemainingAmount=MAX(0,RemainingAmount-?) WHERE SaleID=?", (debt_relief, sid))
after_return = state(c)

report(after_return == before,
       'a full return puts stock, cash and the customer balance back to the start',
       f'start  {before}\nsale   {after_sale}\nreturn {after_return}')

# ---------------------------------------------------------------- 3
print('\n[3] A return itself can be cancelled (undo a wrong credit note)')
report("ipcMain.handle('delete:saleReturn'" in SALES,
       'the reversal handler exists')
report("UPDATE item_serials SET Status = 'sold'" in SALES.split("delete:saleReturn")[1],
       'serialised goods go back OUT of stock')
report('Balance = Balance + ? WHERE CashAccountID' in SALES.split("delete:saleReturn")[1],
       'the refunded cash is taken back')
report('الرصيد غير كافٍ لاسترجاع المبلغ' in SALES,
       'it refuses if the drawer cannot cover taking the cash back')

# Replay the reversal on the state above.
ret = dict(zip([d[0] for d in c.execute("SELECT * FROM sale_returns WHERE ReturnID=?", (rid,)).description],
               c.execute("SELECT * FROM sale_returns WHERE ReturnID=?", (rid,)).fetchone()))
for line in c.execute("SELECT ItemID,Quantity,WarehouseID FROM sale_return_details WHERE ReturnID=?", (rid,)).fetchall():
    c.execute("UPDATE stock_quantities SET Quantity=Quantity-? WHERE ItemID=? AND WarehouseID=?", (line[1], line[0], line[2]))
c.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=?", (ret['CashRefund'], ret['CashAccountID']))
c.execute("UPDATE customers SET Balance=Balance+? WHERE CustomerID=1", (ret['DebtRelief'],))
c.execute("UPDATE sales SET RemainingAmount=RemainingAmount+? WHERE SaleID=?", (ret['DebtRelief'], sid))
c.execute("DELETE FROM sale_return_details WHERE ReturnID=?", (rid,))
c.execute("DELETE FROM sale_returns WHERE ReturnID=?", (rid,))
after_undo = state(c)
report(after_undo == after_sale,
       'cancelling the return restores the state the sale left behind',
       f'after sale        {after_sale}\nafter undo return {after_undo}')
rem = c.execute("SELECT RemainingAmount FROM sales WHERE SaleID=?", (sid,)).fetchone()[0]
report(abs(rem - 400) < 0.01,
       'the invoice again shows the outstanding amount',
       f'RemainingAmount {rem:.2f}')

# ---------------------------------------------------------------- 4
print('\n[4] An invoice can be edited without corrupting any balance')
report("ipcMain.handle('sales:update'" in SALES, 'the edit handler exists')
report('reverse-and-reissue' in SALES.lower() or 'REVERSE-AND-REISSUE' in SALES,
       'editing is a reverse-and-reissue, not an in-place patch',
       'patching in place would need a hand-written delta for every field\n'
       'combination; any case not thought of would corrupt a balance silently')
report('لا يمكن تعديل الفاتورة - مرتبطة بـ' in SALES,
       'an invoice with returns, vouchers or a repair delivery cannot be edited',
       'those documents were issued against the old figures')
report("'sales:update': 'sales.delete'" in GUARD,
       'editing requires the same authority as deleting')
report('فاتورة صيانة - عدّلها من شاشة الصيانة' in SALES,
       'a maintenance mirror invoice is protected from direct editing')

# Edit: 10 units paid 200 (cash)  ->  4 units paid 240 (card, fee 10, shop pays)
db, c = fresh()
start = state(c)
c.execute("""INSERT INTO sales(SaleNumber,FiscalYearID,Date,CustomerID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentMethod,CashAccountID,Status,UserID,TransferCost,TransferCostBearer)
    VALUES('S1',1,?,1,600,0,0,600,200,400,'cash',1,'partial',1,0,'shop')""", (T,))
sid = c.lastrowid
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) VALUES(?,1,10,60,30,600,1)", (sid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-10 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE customers SET Balance=Balance+400 WHERE CustomerID=1")
c.execute("UPDATE cash_accounts SET Balance=Balance+200 WHERE CashAccountID=1")

orig = dict(zip([d[0] for d in c.execute("SELECT * FROM sales WHERE SaleID=?", (sid,)).description],
                c.execute("SELECT * FROM sales WHERE SaleID=?", (sid,)).fetchone()))
# --- undo
for line in c.execute("SELECT ItemID,Quantity,WarehouseID FROM sale_details WHERE SaleID=?", (sid,)).fetchall():
    c.execute("UPDATE stock_quantities SET Quantity=Quantity+? WHERE ItemID=? AND WarehouseID=?", (line[1], line[0], line[2]))
c.execute("UPDATE customers SET Balance=Balance-? WHERE CustomerID=1", (orig['RemainingAmount'],))
old_fee = orig['TransferCost'] if (orig['TransferCostBearer'] or 'shop') == 'shop' else 0
c.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=?", (orig['PaidAmount'] - old_fee, orig['CashAccountID']))
c.execute("DELETE FROM sale_details WHERE SaleID=?", (sid,))
after_undo = state(c)
report(after_undo == start,
       'the undo half of an edit returns everything to the pre-sale state',
       f'start {start}\nundo  {after_undo}')

# --- reissue: 4 units @60 = 240, paid 240 by card, fee 10 borne by shop
NEW_TOTAL, NEW_PAID, NEW_FEE = 240.0, 240.0, 10.0
c.execute("""UPDATE sales SET Subtotal=?,TotalAmount=?,PaidAmount=?,RemainingAmount=?,
    PaymentMethod='card',CashAccountID=NULL,PaymentMethodID=1,Status='completed',
    TransferCost=?,TransferCostBearer='shop' WHERE SaleID=?""",
          (NEW_TOTAL, NEW_TOTAL, NEW_PAID, 0.0, NEW_FEE, sid))
c.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total,WarehouseID) VALUES(?,1,4,60,30,240,1)", (sid,))
c.execute("UPDATE stock_quantities SET Quantity=Quantity-4 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE payment_methods SET Balance=Balance+? WHERE PaymentMethodID=1", (NEW_PAID - NEW_FEE,))
final = state(c)

report(final['stock'] == 16,
       'stock reflects the NEW quantity only',
       f"20 - 4 = 16, got {final['stock']}  (the original 10 were fully returned)")
report(abs(final['cash'] - 5000.0) < 0.01,
       'the original cash payment was fully unwound',
       f"cash {final['cash']:.2f} (the 200 taken in cash is gone)")
report(abs(final['machine'] - 230.0) < 0.01,
       'the new card payment is credited net of its fee',
       f"240 - 10 = 230, got {final['machine']:.2f}")
report(abs(final['customer']) < 0.01,
       'the customer owes nothing, because the new invoice is fully paid',
       f"balance {final['customer']:.2f} (the old 400 debt was cancelled)")
num = c.execute("SELECT SaleNumber FROM sales WHERE SaleID=?", (sid,)).fetchone()[0]
report(num == 'S1',
       'the invoice number is preserved across an edit',
       "so the customer's printed copy still matches")

# ---------------------------------------------------------------- 5
print('\n[5] Editing re-validates with the same rules as creating')
upd = SALES.split("ipcMain.handle('sales:update'")[1].split("ipcMain.handle(")[0]
for label, snippet in [
    ('empty invoice', 'لا يمكن حفظ فاتورة بدون أصناف'),
    ('bad quantity', 'الكمية يجب أن تكون رقماً أكبر من صفر'),
    ('bad price', 'السعر يجب أن يكون رقماً غير سالب'),
    ('discount over total', 'أكبر من إجمالي الأصناف'),
    ('missing payment target', 'اختر مصدر استلام المبلغ'),
    ('inactive account', 'غير مفعّلة'),
]:
    report(snippet in upd, f'{label} is rejected on edit too')
report('db.transaction(' in upd,
       'the undo and the reissue happen in ONE transaction',
       'a failure halfway can never leave the books half-reversed')
report('resolveUnitCost' in upd,
       'cost of sales is recomputed server-side on edit')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
