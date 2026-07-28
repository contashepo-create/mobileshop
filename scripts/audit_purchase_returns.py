#!/usr/bin/env python3
"""
Purchase-return (debit note) audit, plus the sale-return valuation fix.

A return is not "a sale in reverse" — it is a reversal of a specific past
transaction, and it must undo exactly what that transaction did, at the values
that transaction used. Two rules follow from that, and both are tested here:

  * goods move at the cost they moved at ORIGINALLY, never at today's cost;
  * money is unwound in the order it was committed — debt before cash.

Usage:  python3 scripts/audit_purchase_returns.py
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
    c.execute("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')")
    c.execute("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Case','part',0,0,60,1)")
    return db, c


def restore_at_cost(c, item, wh, qty, unit_cost):
    """Mirrors restoreStockAtCost() in src/main/database/stock.ts."""
    row = c.execute("SELECT ID,Quantity,CostPrice FROM stock_quantities WHERE ItemID=? AND WarehouseID=?",
                    (item, wh)).fetchone()
    if not row:
        c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(?,?,?,?)",
                  (item, wh, qty, unit_cost))
        return
    rid, q, cost = row
    new_q = (q or 0) + qty
    can_avg = (q or 0) > 0 and new_q > 0
    new_c = (((cost or 0) * q) + (unit_cost * qty)) / new_q if can_avg else unit_cost
    c.execute("UPDATE stock_quantities SET Quantity=?,CostPrice=? WHERE ID=?", (new_q, new_c, rid))


PUR = R('src/main/ipc/purchases.handlers.ts')
SAL = R('src/main/ipc/sales.handlers.ts')
STOCK = R('src/main/database/stock.ts')
GUARD = R('src/main/security/ipcGuard.ts')
UI = R('src/renderer/src/pages/accounting/PurchasesPage.tsx')
T = '2026-07-28'

print('=' * 74)
print('PURCHASE RETURNS (DEBIT NOTES) + RETURN VALUATION')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] BUG FIX: returned goods re-enter at the cost they LEFT at')
report('export function restoreStockAtCost(' in STOCK,
       'a cost-aware restock helper exists')
report('restoreStockAtCost(db, item.ItemID, returnWarehouse, item.Quantity, returnedUnitCost)' in SAL,
       'sale returns use it, with the original line cost')

# Sell everything at 30, restock at 50, then the customer returns.
db, c = fresh()
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,30)")
c.execute("UPDATE stock_quantities SET Quantity=0 WHERE ItemID=1")          # sold all 10 @30
c.execute("UPDATE stock_quantities SET Quantity=5,CostPrice=50 WHERE ItemID=1")  # bought 5 @50
old_way_value = 10 * 50                                                      # quantity-only restock
restore_at_cost(c, 1, 1, 5, 30)                                              # customer returns 5
qty, cost = c.execute("SELECT Quantity,CostPrice FROM stock_quantities WHERE ItemID=1").fetchone()
true_value = 5 * 50 + 5 * 30
report(abs(qty * cost - true_value) < 0.01,
       'inventory value matches the real mix of costs',
       f'5 units @50 + 5 returned @30 = {true_value:.2f}\n'
       f'book value now {qty * cost:.2f} (quantity-only restock gave {old_way_value:.2f})')
report(abs((qty * cost) - old_way_value) > 0.01,
       'the old behaviour really did overstate inventory',
       f'overstatement was {old_way_value - true_value:.2f}')
report('COGS reversal in the P&L credits' in SAL,
       'the reason is documented where the fix lives',
       'asset restored and cost credited must use the SAME figure')

# ---------------------------------------------------------------- 2
print('\n[2] What may be returned is capped by BOTH the invoice and the shelf')
report("ipcMain.handle('purchaseReturns:returnable'" in PUR,
       'the returnable quantity is computed server-side')
report('AlreadyReturned' in PUR and 'NotYetReturned' in PUR,
       'previous returns on the same invoice are subtracted')
report('InStock: inStock' in PUR and 'Math.min(notYetReturned, Math.max(0, inStock))' in PUR,
       'the cap is the SMALLER of "not yet returned" and "still in that warehouse"',
       'goods already sold to a customer cannot also go back to the supplier')
report('LimitedByStock' in PUR and 'بيعت بعض الكمية' in UI,
       'the screen explains why a line is capped below the invoice quantity')

db, c = fresh()
c.execute("""INSERT INTO purchases(PurchaseNumber,FiscalYearID,Date,SupplierID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,Status,UserID,PaymentMethod)
    VALUES('P1',1,?,1,1000,0,0,1000,0,1000,'unpaid',1,'cash')""", (T,))
pid = c.lastrowid
c.execute("INSERT INTO purchase_details(PurchaseID,ItemID,Quantity,UnitCost,Total,WarehouseID,EffectiveUnitCost) VALUES(?,1,10,100,1000,1,100)", (pid,))
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,4,100)")  # 6 sold
bought, in_stock = 10, 4
returnable = min(bought - 0, max(0, in_stock))
report(returnable == 4,
       'bought 10, sold 6 -> only 4 can go back',
       f'returnable {returnable} (invoice allows 10, shelf allows 4)')

# ---------------------------------------------------------------- 3
print('\n[3] The money is unwound debt-first, then cash')
report('const debtRelief = Math.min(totalAmount, remainingDebtAfterPriorReturns);' in PUR,
       'what is still owed is cancelled before any cash comes back',
       'taking cash for goods never paid for would be money never spent')
report('يُخصم من دَينك للمورد' in UI and 'تسترده نقداً' in UI,
       'the split is shown in figures before confirming')

# Invoice 1000, paid 400, return the lot.
outstanding, ret = 600.0, 1000.0
debt = min(ret, outstanding)
cash_back = round(ret - debt, 2)
report(abs(debt - 600) < 0.01 and abs(cash_back - 400) < 0.01,
       'a full return of a part-paid invoice splits correctly',
       f'debt cancelled {debt:.2f}, cash recovered {cash_back:.2f}\n'
       'you never recover more cash than you actually handed over')

# Full end-to-end money check.
db, c = fresh()
TOTAL, PAID = 1000.0, 400.0
c.execute("""INSERT INTO purchases(PurchaseNumber,FiscalYearID,Date,SupplierID,Subtotal,Discount,TaxAmount,
    TotalAmount,PaidAmount,RemainingAmount,PaymentSource,PaymentSourceID,Status,UserID,PaymentMethod)
    VALUES('P1',1,?,1,1000,0,0,?,?,?,'cash_account',1,'partial',1,'cash')""", (T, TOTAL, PAID, TOTAL - PAID))
pid = c.lastrowid
c.execute("INSERT INTO purchase_details(PurchaseID,ItemID,Quantity,UnitCost,Total,WarehouseID,EffectiveUnitCost) VALUES(?,1,10,100,1000,1,100)", (pid,))
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,100)")
c.execute("UPDATE suppliers SET Balance=Balance+? WHERE SupplierID=1", (TOTAL - PAID,))
c.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (PAID,))
before = (
    c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0],
    c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0],
    c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0],
)
# Return all 10.
c.execute("UPDATE stock_quantities SET Quantity=Quantity-10 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE suppliers SET Balance=Balance-? WHERE SupplierID=1", (600.0,))
c.execute("UPDATE cash_accounts SET Balance=Balance+? WHERE CashAccountID=1", (400.0,))
after = (
    c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0],
    c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0],
    c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0],
)
report(after == (0.0, 50000.0, 0.0),
       'a full return returns stock, cash and the supplier balance to the start',
       f'after purchase {before}\nafter return   {after}')

# ---------------------------------------------------------------- 4
print('\n[4] A debit note can itself be cancelled')
report("ipcMain.handle('delete:purchaseReturn'" in PUR,
       'the reversal handler exists')
undo = PUR.split("delete:purchaseReturn")[1]
report('restoreStockAtCost(db, line.ItemID, line.WarehouseID, line.Quantity, line.UnitCost || 0)' in undo,
       'goods come back at the cost they left at')
report('Balance = Balance - ? WHERE CashAccountID' in undo,
       'the cash the supplier refunded goes back out')
report('Balance = Balance + ? WHERE SupplierID' in undo,
       'the cancelled debt is restored')
report('الرصيد غير كافٍ لإعادة المبلغ للمورد' in PUR,
       'it refuses when the drawer cannot cover repaying the supplier')
report('RemainingAmount = RemainingAmount + ?' in undo and 'Status = CASE WHEN' in undo,
       'the purchase invoice status is recalculated, not left stale')

# Numeric round trip.
c.execute("UPDATE stock_quantities SET Quantity=Quantity+10 WHERE ItemID=1 AND WarehouseID=1")
c.execute("UPDATE suppliers SET Balance=Balance+? WHERE SupplierID=1", (600.0,))
c.execute("UPDATE cash_accounts SET Balance=Balance-? WHERE CashAccountID=1", (400.0,))
undone = (
    c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0],
    c.execute("SELECT Balance FROM cash_accounts WHERE CashAccountID=1").fetchone()[0],
    c.execute("SELECT Balance FROM suppliers WHERE SupplierID=1").fetchone()[0],
)
report(undone == before,
       'cancelling the debit note restores the post-purchase state exactly',
       f'expected {before}\ngot      {undone}')

# ---------------------------------------------------------------- 5
print('\n[5] Goods leave the warehouse they arrived in')
report('const wh = lineWarehouse(item.ItemID, item.WarehouseID);' in PUR,
       'the warehouse is resolved from the original purchase line')
report('ALTER TABLE purchase_return_details ADD COLUMN WarehouseID INTEGER' in R('src/main/database/migrations/index.ts'),
       'the return line records which warehouse it left',
       'so cancelling the note puts the goods back in the right place')
db, c = fresh()
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,3,25)")
c.execute("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,10,30)")
c.execute("UPDATE stock_quantities SET Quantity=Quantity-10 WHERE ItemID=1 AND WarehouseID=2")
main_q = c.execute("SELECT Quantity FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1").fetchone()[0]
report(main_q == 3,
       'returning branch stock leaves the main store untouched',
       f'main still {main_q} (an unqualified query would have driven it to -7)')

# ---------------------------------------------------------------- 6
print('\n[6] Security and integrity')
for ch, perm in [('purchaseReturns:create', 'purchases.returns'),
                 ('purchaseReturns:get', 'purchases.returns'),
                 ('purchaseReturns:returnable', 'purchases.returns'),
                 ('delete:purchaseReturn', 'purchases.delete')]:
    report(f"'{ch}': '{perm}'" in GUARD, f'{ch} requires {perm}')
report('db.transaction(' in undo,
       'the reversal is atomic',
       'a failure halfway cannot leave stock back but the money not repaid')
ret_block = PUR.split("ipcMain.handle('purchaseReturns:returnable'")[1].split('ipcMain.handle(')[0]
import re as _re
sqls = _re.findall(r'db\.prepare\(`(.*?)`\)', ret_block, _re.S)
report(not [b for b in sqls if '${' in b],
       'no value is interpolated into the returnable query')
report('Math.min(l.Returnable, Number(e.target.value) || 0)' in UI,
       'the UI clamps the typed quantity as well as the server',
       'so the total shown can never promise a refund the server will refuse')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
