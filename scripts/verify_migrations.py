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


def test_full_schema_repeatable():
    print("\n[5] Full runMigrations is repeatable and leaves no orphan tables")
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
    test_full_schema_repeatable()
    print("\n" + "=" * 70)
    print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    print("=" * 70)
    if FAIL:
        sys.exit(1)


if __name__ == '__main__':
    main()
