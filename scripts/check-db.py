import sqlite3, os
files = [
  ('CURRENT (Roaming root)', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\mobile_shop.db'),
  ('NESTED (mobile-shop-erp/mobile-shop-erp)', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\mobile-shop-erp\mobile_shop.db'),
  ('pre_upgrade_v1', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\backups\pre_upgrade_v1_20260809T133135.db'),
  ('auto_backup_2026-08-09', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\backups\auto_backup_2026-08-09.db'),
  ('auto_backup_2026-08-08', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\backups\auto_backup_2026-08-08.db'),
  ('pre_upgrade_v0', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\backups\pre_upgrade_v0_20260809T182621.db'),
  ('before-restore', r'C:\Users\accmo\AppData\Roaming\mobile-shop-erp\mobile_shop.db.before-restore'),
]
key_tables = ['sales', 'sale_details', 'customers', 'purchases', 'inventory_items', 'cash_accounts']
for label, path in files:
    if not os.path.exists(path):
        print(f'{label}: NOT FOUND')
        continue
    size = os.path.getsize(path)
    try:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        counts = {}
        for t in key_tables:
            try:
                cur.execute(f'SELECT COUNT(*) FROM {t}')
                counts[t] = cur.fetchone()[0]
            except:
                counts[t] = 'N/A'
        print(f'{label} ({size//1024} KB): {len(tables)} tables')
        print(f'  {counts}')
        conn.close()
    except Exception as e:
        print(f'{label} ({size//1024} KB): ERROR - {str(e)[:80]}')
