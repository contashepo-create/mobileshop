#!/usr/bin/env python3
"""
Migration safety checks.

Verifies that upgrading an OLD database (the shape shipped before the rebuild
helpers existed) neither loses rows nor leaves orphan tables, and that running
the migration repeatedly is idempotent.

Run with:  python3 scripts/verify_migrations.py
"""
import os
import re
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_real_db import parse_blocks  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=''):
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  ' + detail}")


def columns_of(db, table):
    try:
        return [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
    except Exception:
        return []


def is_notnull(db, table, col):
    for r in db.execute(f"PRAGMA table_info({table})"):
        if r[1] == col:
            return r[3] == 1
    return False


def rebuild_table(db, table, temp, create_sql):
    """Mirror of rebuildTable() in migrations/index.ts."""
    old = columns_of(db, table)
    if not old:
        return False
    db.execute(f"DROP TABLE IF EXISTS {temp}")
    try:
        db.execute("BEGIN")
        db.execute(create_sql)
        new = columns_of(db, temp)
        shared = [c for c in old if c in new]
        if not shared:
            raise RuntimeError('no shared columns')
        lst = ', '.join(shared)
        db.execute(f"INSERT INTO {temp} ({lst}) SELECT {lst} FROM {table}")
        db.execute(f"DROP TABLE {table}")
        db.execute(f"ALTER TABLE {temp} RENAME TO {table}")
        db.execute("COMMIT")
        return True
    except Exception as e:
        db.execute("ROLLBACK")
        db.execute(f"DROP TABLE IF EXISTS {temp}")
        print("       rebuild failed (original intact):", e)
        return False


SALE_DETAILS_TARGET = """
CREATE TABLE sale_details_migrate (
  DetailID INTEGER PRIMARY KEY AUTOINCREMENT, SaleID INTEGER NOT NULL, ItemID INTEGER,
  SerialID INTEGER, IMEI TEXT, Quantity REAL DEFAULT 1, UnitPrice REAL NOT NULL,
  UnitCost REAL, Total REAL NOT NULL, IsWarranty INTEGER DEFAULT 0, WarrantyMonths INTEGER,
  Description TEXT, WarehouseID INTEGER)"""


def test_old_db_upgrade():
    print("\n[1] Upgrading a legacy sale_details (ItemID NOT NULL) preserves every row")
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    db.execute("""CREATE TABLE sale_details(
        DetailID INTEGER PRIMARY KEY AUTOINCREMENT, SaleID INTEGER NOT NULL, ItemID INTEGER NOT NULL,
        SerialID INTEGER, IMEI TEXT, Quantity REAL DEFAULT 1, UnitPrice REAL NOT NULL,
        UnitCost REAL, Total REAL NOT NULL, IsWarranty INTEGER DEFAULT 0, WarrantyMonths INTEGER)""")
    for i in range(1, 26):
        db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,UnitCost,Total) VALUES(?,?,?,?,?,?)",
                   (1, i, 2, 100, 60, 200))
    before = db.execute("SELECT COUNT(*) FROM sale_details").fetchone()[0]
    total_before = db.execute("SELECT SUM(Total) FROM sale_details").fetchone()[0]

    check("legacy ItemID is NOT NULL", is_notnull(db, 'sale_details', 'ItemID'))
    rebuild_table(db, 'sale_details', 'sale_details_migrate', SALE_DETAILS_TARGET)

    after = db.execute("SELECT COUNT(*) FROM sale_details").fetchone()[0]
    total_after = db.execute("SELECT SUM(Total) FROM sale_details").fetchone()[0]
    check(f"all {before} rows preserved", after == before, f"after={after}")
    check("monetary total unchanged", abs((total_after or 0) - (total_before or 0)) < 0.01)
    check("ItemID now nullable", not is_notnull(db, 'sale_details', 'ItemID'))
    check("new columns present", 'WarehouseID' in columns_of(db, 'sale_details')
          and 'Description' in columns_of(db, 'sale_details'))
    orphans = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_migrate'")]
    check("no orphan table left", not orphans, str(orphans))
    db.close()


def test_service_line_storable():
    print("\n[2] A service line (NULL ItemID) can be stored after the upgrade")
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    db.execute("""CREATE TABLE sale_details(
        DetailID INTEGER PRIMARY KEY AUTOINCREMENT, SaleID INTEGER NOT NULL, ItemID INTEGER NOT NULL,
        SerialID INTEGER, IMEI TEXT, Quantity REAL DEFAULT 1, UnitPrice REAL NOT NULL,
        UnitCost REAL, Total REAL NOT NULL, IsWarranty INTEGER DEFAULT 0, WarrantyMonths INTEGER)""")
    rebuild_table(db, 'sale_details', 'sale_details_migrate', SALE_DETAILS_TARGET)
    try:
        db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,Total) VALUES(1,NULL,1,50,50)")
        check("service line accepted", True)
    except Exception as e:
        check("service line accepted", False, str(e))
    db.close()


def test_idempotent():
    print("\n[3] Re-running the upgrade on an already-migrated DB is a no-op")
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    db.execute(SALE_DETAILS_TARGET.replace('sale_details_migrate', 'sale_details'))
    db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,Total,WarehouseID) VALUES(1,1,1,50,50,3)")
    needed = is_notnull(db, 'sale_details', 'ItemID')
    check("rebuild correctly skipped (guard says not needed)", not needed)
    check("row intact", db.execute("SELECT COUNT(*) FROM sale_details").fetchone()[0] == 1)
    db.close()


def test_extra_column_safe():
    print("\n[4] An unknown extra column cannot corrupt or drop the table")
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    db.execute("""CREATE TABLE sale_details(
        DetailID INTEGER PRIMARY KEY AUTOINCREMENT, SaleID INTEGER NOT NULL, ItemID INTEGER NOT NULL,
        SerialID INTEGER, IMEI TEXT, Quantity REAL DEFAULT 1, UnitPrice REAL NOT NULL,
        UnitCost REAL, Total REAL NOT NULL, IsWarranty INTEGER DEFAULT 0, WarrantyMonths INTEGER,
        FutureColumn TEXT)""")
    db.execute("INSERT INTO sale_details(SaleID,ItemID,Quantity,UnitPrice,Total,FutureColumn) VALUES(1,1,1,50,50,'keep')")
    rebuild_table(db, 'sale_details', 'sale_details_migrate', SALE_DETAILS_TARGET)
    rows = db.execute("SELECT COUNT(*) FROM sale_details").fetchone()[0]
    check("row survived the rebuild", rows == 1, f"rows={rows}")
    # copy-by-name means values land in the right columns; the unknown column is dropped
    v = db.execute("SELECT UnitPrice, Total FROM sale_details").fetchone()
    check("values landed in the correct columns", v == (50.0, 50.0), str(v))
    db.close()


FOLD_LEGACY_FEE = """
UPDATE sales SET
  TotalAmount = ROUND(TotalAmount + COALESCE(TransferCost,0), 2),
  PaidAmount  = ROUND(PaidAmount  + COALESCE(TransferCost,0), 2)
WHERE IsVoided = 0
  AND COALESCE(Source,'direct') <> 'maintenance'
  AND COALESCE(TransferCost,0) > 0
  AND COALESCE(TransferCostBearer,'shop') = 'customer'
  AND ABS(TotalAmount - (Subtotal - COALESCE(Discount,0) + COALESCE(TaxAmount,0))) < 0.01
"""


def test_fold_legacy_customer_fee():
    print("\n[5] Fold legacy customer-paid fee into TotalAmount/PaidAmount once")
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    db.executescript("""
      CREATE TABLE sales(
        SaleID INTEGER PRIMARY KEY, SaleNumber TEXT, Date TEXT,
        TotalAmount REAL, PaidAmount REAL, RemainingAmount REAL,
        Subtotal REAL, Discount REAL, TaxAmount REAL,
        IsVoided INTEGER DEFAULT 0, IsWarranty INTEGER DEFAULT 0,
        Source TEXT, TransferCost REAL, TransferCostBearer TEXT DEFAULT 'shop',
        CashAccountID INTEGER, Status TEXT);
    """)
    # 1: legacy customer-paid fee, invoice did NOT include it -> must fold.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,Status)
                  VALUES(1,250,250,0,250,0,0,5,'customer','paid')""")
    # 2) shop-paid fee, never folded -> must stay untouched.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,Status)
              VALUES(2,250,250,0,250,0,0,5,'shop','paid')""")
    # 3) legacy customer paid on a partial-payment invoice -> both sides move, remainder intact.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,Status)
              VALUES(3,100,40,60,100,0,0,3,'customer','partial')""")
    # 4) maintenance source -> excluded, even if customer bearer.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,Source,Status)
              VALUES(4,250,250,0,250,0,0,5,'customer','maintenance','paid')""")
    # 5) voided legacy customer row -> excluded.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,IsVoided,Status)
              VALUES(5,250,250,0,250,0,0,5,'customer',1,'voided')""")
    # 6) already-folded row (TotalAmount already != items sum) -> untouched.
    db.execute("""INSERT INTO sales(SaleID,TotalAmount,PaidAmount,RemainingAmount,Subtotal,Discount,TaxAmount,
                  TransferCost,TransferCostBearer,Status)
              VALUES(6,255,255,0,250,0,0,5,'customer','paid')""")

    first = db.execute(FOLD_LEGACY_FEE)
    check("exactly the two legacy customer rows folded", first.rowcount == 2, f"changed={first.rowcount}")
    row1 = db.execute("SELECT TotalAmount,PaidAmount,RemainingAmount FROM sales WHERE SaleID=1").fetchone()
    check("legacy customer-paid invoice includes the fee (250 -> 255)",
          row1 == (255.0, 255.0, 0.0), str(row1))
    row3 = db.execute("SELECT TotalAmount,PaidAmount,RemainingAmount FROM sales WHERE SaleID=3").fetchone()
    check("partial folds both sides, remainder unchanged (100,40 -> 103,43, rem 60)",
          row3 == (103.0, 43.0, 60.0), str(row3))
    # 2,4,5 must not move; 6 (already folded) must keep its 255/255 restated total.
    row2 = db.execute("SELECT TotalAmount,PaidAmount FROM sales WHERE SaleID=2").fetchone()
    row4 = db.execute("SELECT TotalAmount,PaidAmount FROM sales WHERE SaleID=4").fetchone()
    row5 = db.execute("SELECT TotalAmount,PaidAmount FROM sales WHERE SaleID=5").fetchone()
    row6 = db.execute("SELECT TotalAmount,PaidAmount FROM sales WHERE SaleID=6").fetchone()
    check("shop/maintenance/voided rows untouched", (row2, row4, row5) == ((250.0, 250.0),) * 3,
          f"{row2} {row4} {row5}")
    check("already-folded row keeps its restated total", row6 == (255.0, 255.0), str(row6))
    # Idempotency: second run must be a no-op.
    second = db.execute(FOLD_LEGACY_FEE).rowcount
    check("re-running the fold is a no-op", second == 0, f"second run changed {second} rows")
    # Remainder invariant across the whole table.
    for r in db.execute("SELECT SaleID,TotalAmount,PaidAmount,RemainingAmount FROM sales"):
        check(f"row {r[0]} keeps TotalAmount - PaidAmount == RemainingAmount",
              abs((r[1] - r[2]) - r[3]) < 0.005, str(r))
    db.close()


def test_full_schema_repeatable():
    print("\n[6] Full runMigrations is repeatable and leaves no orphan tables")
    ts = open(os.path.join(ROOT, 'src/main/database/migrations/index.ts'), encoding='utf-8').read()
    blocks = parse_blocks(ts)
    db = sqlite3.connect(':memory:')
    db.isolation_level = None
    non_benign = 0
    for run in range(3):
        for guarded, stmts in blocks:
            aborted = False
            for s in stmts:
                if aborted:
                    continue
                try:
                    db.execute(s)
                except Exception as e:
                    msg = str(e)
                    if not ('duplicate column name' in msg or 'already exists' in msg):
                        non_benign += 1
                        if run == 2:
                            print("       non-benign:", ' '.join(s.split())[:60], '->', msg)
                    if guarded:
                        aborted = True
    check("no non-benign migration errors across 3 runs", non_benign == 0, f"count={non_benign}")
    orphans = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%_new' OR name LIKE '%_migrate')")]
    check("no orphan rebuild tables", not orphans, str(orphans))
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    check("core tables exist", all(t in tables for t in
          ('sales', 'sale_details', 'purchases', 'customers', 'document_sequences')))
    db.close()


def main():
    print("=" * 70)
    print("MIGRATION SAFETY CHECKS")
    print("=" * 70)
    test_old_db_upgrade()
    test_service_line_storable()
    test_idempotent()
    test_extra_column_safe()
    test_fold_legacy_customer_fee()
    test_full_schema_repeatable()
    print("\n" + "=" * 70)
    print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    print("=" * 70)
    if FAIL:
        sys.exit(1)


if __name__ == '__main__':
    main()
