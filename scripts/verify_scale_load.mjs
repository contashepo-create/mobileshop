#!/usr/bin/env node
/**
 * HOW MUCH SHOP CAN THIS HOLD, AND HOW FAST IS IT WHEN FULL?
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other suite runs against a handful of rows. That proves the arithmetic
 * and proves nothing about the third year of trading, which is when a shop has
 * committed to the software and cannot leave. The failure mode there is not a
 * crash — it is a screen that takes eleven seconds, on a machine the owner
 * cannot upgrade, with a customer waiting at the counter.
 *
 * So this fills a REAL database file on disk with a REAL shop's volume and
 * measures the queries the shop actually waits for.
 *
 * WHAT A REAL SHOP LOOKS LIKE
 * ---------------------------
 * A busy Egyptian mobile shop: ~60 sales a day, six days a week, plus
 * purchases, maintenance tickets, vouchers and returns. Over three years that
 * is roughly 56,000 sales and 150,000 sale lines. This suite builds that and
 * then measures.
 *
 * The thresholds below are what a HUMAN notices, not what a benchmark likes:
 *   - under 100 ms  = instant
 *   - under 500 ms  = fine
 *   - over 2000 ms  = the shop complains
 * A dashboard that takes two seconds every time it is opened is a defect even
 * though nothing is wrong with the answer.
 *
 * Run:  node --experimental-strip-types scripts/verify_scale_load.mjs
 *       SCALE=small|full  (default full; small is for a quick check)
 */
import { readFileSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

function loadSqlite() {
  for (const base of [join(ROOT, 'node_modules'), join(ROOT, 'scripts', 'node_modules')]) {
    try { return createRequire(join(base, 'x.js'))('better-sqlite3'); } catch { /* next */ }
  }
  return null;
}
const Database = loadSqlite();

console.log('='.repeat(72));
console.log('SCALE & LOAD — three years of a busy shop');
console.log('='.repeat(72));

if (!Database) {
  console.log('\n  SKIP  better-sqlite3 is not installed');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const SCALE = process.env.SCALE === 'small' ? 'small' : 'full';
// 3 years x 6 days x ~60 sales. `small` keeps the same SHAPE so the suite is
// still meaningful in a hurry — only the row count changes.
const SALES = SCALE === 'small' ? 4000 : 56000;
const CUSTOMERS = SCALE === 'small' ? 300 : 3000;
const ITEMS = SCALE === 'small' ? 200 : 2000;

const dir = mkdtempSync(join(tmpdir(), 'scale-'));
const DB_PATH = join(dir, 'shop.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = ON');

// ---- the REAL schema, from the REAL migrations -----------------------------
{
  const ts = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');
  let blocks = 0;
  for (const m of ts.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)) {
    const sql = m[1];
    if (sql.includes('${')) continue;
    blocks++;
    for (const stmt of sql.split(/;\s*\n/)) {
      const s = stmt.trim();
      if (!s) continue;
      try { db.exec(s + ';'); } catch { /* ALTER on existing column, etc. */ }
    }
  }
  const tables = db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).get().n;
  t('the real schema builds', tables >= 30, `${tables} tables from ${blocks} migration blocks`);
}

const has = (table) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);

/** Inserts a row using only the columns that actually exist. */
function makeInserter(table, sample) {
  const available = new Set(cols(table));
  const keys = Object.keys(sample).filter(k => available.has(k));
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const stmt = db.prepare(sql);
  return (row) => stmt.run(...keys.map(k => row[k] ?? null));
}

// ---- fill ------------------------------------------------------------------
console.log(`\n[1] Filling a ${SCALE} shop (${SALES.toLocaleString()} sales)`);
const fillStart = Date.now();
{
  const insCustomer = makeInserter('customers',
    { Name: '', Phone: '', Balance: 0, Status: 'active', CreditLimit: 0 });
  const insItem = makeInserter('items',
    { ItemName: '', ItemType: 'product', Barcode: '', CostPrice: 0, SalePrice: 0, IsActive: 1 });
  const insSale = makeInserter('sales', {
    SaleNumber: '', FiscalYearID: 1, CustomerID: null, Date: '', Subtotal: 0,
    TotalAmount: 0, PaidAmount: 0, Discount: 0, UserID: 1, IsVoided: 0,
    PaymentMethod: 'cash',
  });
  const insLine = makeInserter('sale_details', {
    SaleID: 0, ItemID: null, Quantity: 1, UnitPrice: 0, UnitCost: 0, Total: 0,
  });

  // Parents first: the schema enforces foreign keys, so a sale needs a real
  // fiscal year and a real user before it can exist.
  const seed = db.transaction(() => {
    // roles first: users.RoleID references it.
    if (has('roles') && !db.prepare('SELECT 1 FROM roles WHERE RoleID = 1').get()) {
      makeInserter('roles', { RoleName: '', Description: '' })(
        { RoleName: 'admin', Description: 'مدير' });
    }
    const insUser = makeInserter('users',
      { Username: '', PasswordHash: '', FullName: '', RoleID: 1, IsActive: 1 });
    if (!db.prepare('SELECT 1 FROM users WHERE UserID = 1').get()) {
      insUser({ Username: 'admin', PasswordHash: 'x', FullName: 'المدير', RoleID: 1, IsActive: 1 });
    }
    const insFY = makeInserter('fiscal_years',
      { YearName: '', StartDate: '', EndDate: '', IsClosed: 0, IsActive: 1 });
    if (!db.prepare('SELECT 1 FROM fiscal_years WHERE FiscalYearID = 1').get()) {
      insFY({ YearName: '2023-2026', StartDate: '2023-01-01', EndDate: '2026-12-31',
        IsClosed: 0, IsActive: 1 });
    }
    if (has('warehouses') && !db.prepare('SELECT 1 FROM warehouses WHERE WarehouseID = 1').get()) {
      makeInserter('warehouses', { WarehouseName: '', IsActive: 1 })(
        { WarehouseName: 'المخزن الرئيسي', IsActive: 1 });
    }
  });
  seed();

  const tx = db.transaction(() => {
    for (let i = 1; i <= CUSTOMERS; i++) {
      insCustomer({ Name: `عميل رقم ${i}`, Phone: `010${String(10000000 + i)}`,
        Balance: 0, Status: 'active', CreditLimit: 5000 });
    }
    for (let i = 1; i <= ITEMS; i++) {
      insItem({ ItemName: `صنف ${i}`, ItemType: 'product', Barcode: `BC${1000000 + i}`,
        CostPrice: 100 + (i % 900), SalePrice: 150 + (i % 1200), IsActive: 1 });
    }
  });
  tx();

  // Sales are inserted in batched transactions, the way a real day accumulates
  // rather than one giant commit — closer to production behaviour on disk.
  const BATCH = 2000;
  const start = new Date('2023-01-01').getTime();
  let line = 0;
  for (let base = 0; base < SALES; base += BATCH) {
    const batch = db.transaction(() => {
      for (let i = base; i < Math.min(base + BATCH, SALES); i++) {
        const day = new Date(start + Math.floor(i / 60) * 86400000)
          .toISOString().slice(0, 10);
        const total = 200 + (i % 4000);
        const r = insSale({
          SaleNumber: `INV-${100000 + i}`, FiscalYearID: 1,
          CustomerID: (i % 5 === 0) ? null : (i % CUSTOMERS) + 1,
          Date: day, Subtotal: total, TotalAmount: total, PaidAmount: total, Discount: 0,
          UserID: 1, IsVoided: 0, PaymentMethod: i % 3 === 0 ? 'card' : 'cash',
        });
        const saleId = Number(r.lastInsertRowid);
        const n = 1 + (i % 3);
        for (let k = 0; k < n; k++) {
          line++;
          insLine({ SaleID: saleId, ItemID: ((i + k) % ITEMS) + 1, Quantity: 1 + (k % 3),
            UnitPrice: 150 + (k * 20), UnitCost: 100 + (k * 15), Total: (150 + k * 20) * (1 + (k % 3)) });
        }
      }
    });
    batch();
  }
  const secs = (Date.now() - fillStart) / 1000;
  const sizeMB = statSync(DB_PATH).size / 1048576;
  console.log(`      ${SALES.toLocaleString()} sales, ${line.toLocaleString()} lines, ` +
    `${CUSTOMERS.toLocaleString()} customers in ${secs.toFixed(1)}s — file ${sizeMB.toFixed(1)} MB`);

  // A shop's whole history has to fit somewhere it can be backed up and sent
  // over Telegram. Hundreds of megabytes for three years would be a design
  // fault, not a fact of life.
  t('three years fits in a sane file size', sizeMB < (SCALE === 'small' ? 20 : 250),
    `${sizeMB.toFixed(1)} MB`);
  t('writing stayed at a usable rate', (SALES / secs) > 300,
    `${Math.round(SALES / secs)} sales/sec`);
}

// ---- measure ---------------------------------------------------------------
console.log('\n[2] The queries a shop waits for');
function timed(label, fn, budgetMs) {
  // Run twice and keep the better: the first touch pays for cold page cache,
  // which the shop pays once per boot, not once per click.
  let best = Infinity, out;
  for (let i = 0; i < 2; i++) {
    const s = Date.now();
    out = fn();
    best = Math.min(best, Date.now() - s);
  }
  t(label, best <= budgetMs, `${best} ms (budget ${budgetMs} ms)`);
  return out;
}

timed('opening the sales list (newest 50)', () =>
  db.prepare('SELECT * FROM sales ORDER BY SaleID DESC LIMIT 50').all(), 100);

timed('searching an invoice by number', () =>
  db.prepare('SELECT * FROM sales WHERE SaleNumber = ?').get('INV-' + (100000 + Math.floor(SALES / 2))), 100);

timed('a full-year sales total', () =>
  db.prepare("SELECT COALESCE(SUM(TotalAmount),0) v FROM sales WHERE IsVoided = 0 AND Date >= '2023-01-01' AND Date <= '2023-12-31'").get(), 500);

timed('one customer\'s complete statement', () =>
  db.prepare('SELECT * FROM sales WHERE CustomerID = ? ORDER BY Date').all(7), 500);

timed('top items by revenue, all time', () =>
  db.prepare(`SELECT d.ItemID, SUM(d.Total) v FROM sale_details d
              JOIN sales s ON s.SaleID = d.SaleID AND s.IsVoided = 0
              GROUP BY d.ItemID ORDER BY v DESC LIMIT 20`).all(), 2000);

timed('a month of daily takings (the dashboard chart)', () =>
  db.prepare(`SELECT Date, SUM(TotalAmount) v FROM sales
              WHERE IsVoided = 0 AND Date >= '2024-06-01' AND Date <= '2024-06-30'
              GROUP BY Date ORDER BY Date`).all(), 500);

timed('customer search by name fragment', () =>
  db.prepare("SELECT * FROM customers WHERE Name LIKE '%1234%' LIMIT 50").all(), 500);

timed('inserting one more sale while full', () => {
  const r = db.prepare(
    'INSERT INTO sales (SaleNumber, FiscalYearID, Date, Subtotal, TotalAmount, PaidAmount, PaymentMethod, UserID, IsVoided) VALUES (?,1,?,?,?,?,\'cash\',?,0)',
  ).run('INV-STRESS-' + Date.now() + '-' + Math.random(), '2026-01-01', 500, 500, 500, 1);
  return r;
}, 100);

// ---- indexes ---------------------------------------------------------------
console.log('\n[3] The indexes those queries depend on');
{
  const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'").all();
  console.log(`      ${idx.length} indexes defined`);

  // A missing index does not fail a test, it just makes the shop slow — so the
  // PLAN is inspected rather than trusted.
  const plan = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all()
    .map(r => r.detail).join(' | ');

  const invoicePlan = plan("SELECT * FROM sales WHERE SaleNumber = 'INV-100001'");
  t('invoice lookup does not scan the whole table',
    /USING INDEX|SEARCH/.test(invoicePlan), invoicePlan);

  const datePlan = plan("SELECT SUM(TotalAmount) FROM sales WHERE Date >= '2024-01-01'");
  const dateScans = /SCAN sales/.test(datePlan);
  t('date-range reporting uses an index',
    !dateScans, dateScans ? 'FULL SCAN: ' + datePlan : datePlan);

  const custPlan = plan('SELECT * FROM sales WHERE CustomerID = 7');
  t('a customer statement uses an index',
    !/SCAN sales/.test(custPlan), custPlan);

  const linePlan = plan('SELECT * FROM sale_details WHERE SaleID = 7');
  t('invoice lines use an index', !/SCAN sale_details/.test(linePlan), linePlan);
}

// ---- integrity at size -----------------------------------------------------
console.log('\n[4] Integrity, at this size');
{
  const s = Date.now();
  const ok = db.pragma('integrity_check', { simple: true });
  t('integrity_check passes on the full database', ok === 'ok',
    `${ok} in ${Date.now() - s} ms`);

  const fk = db.pragma('foreign_key_check');
  t('no foreign-key violations', fk.length === 0, `${fk.length} violations`);

  const counted = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
  t('every sale written is present', counted >= SALES, `${counted.toLocaleString()} rows`);

  // Money must still add up after all that volume.
  const hdr = db.prepare('SELECT COALESCE(SUM(TotalAmount),0) v FROM sales WHERE IsVoided = 0').get().v;
  t('the sales total is a finite number', Number.isFinite(hdr), hdr.toLocaleString());
}

// ---- vacuum / maintenance --------------------------------------------------
console.log('\n[5] Housekeeping a shop will actually hit');
{
  const before = statSync(DB_PATH).size;
  const s = Date.now();
  db.exec('VACUUM');
  const took = Date.now() - s;
  const after = statSync(DB_PATH).size;
  t('VACUUM completes in a tolerable time', took < 60000,
    `${(took / 1000).toFixed(1)}s, ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MB`);

  const s2 = Date.now();
  db.exec('ANALYZE');
  t('ANALYZE completes', Date.now() - s2 < 60000, `${((Date.now() - s2) / 1000).toFixed(1)}s`);
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
