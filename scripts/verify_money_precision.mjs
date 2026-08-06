#!/usr/bin/env node
/**
 * RUNNING BALANCES MUST NOT DRIFT.
 *
 * WHAT WAS MEASURED
 * -----------------
 * Every money column in this schema is REAL — a binary float. Individual
 * documents are fine: the handlers pass their totals through `money()`, so an
 * invoice of 0.1 + 0.2 stores as exactly 0.3 (checked below).
 *
 * The running balances were not, because they are never recomputed. They are
 * accumulated by 92 statements shaped like
 *
 *     UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?
 *
 * and that addition happens inside SQLite, after `money()` has done its work.
 * MEASURED, 300 credit sales of 33.33 driven through the real handlers:
 *
 *     expected            9999.000000000000
 *     customers.Balance   9998.999999999982      <- 1.8e-11 short
 *
 * plus a `cash_accounts.Balance` holding a fraction of a piastre.
 *
 * WHY A HUNDRED-BILLIONTH OF A POUND IS WORTH A SUITE
 * ---------------------------------------------------
 * Not because it prints wrong — it rounds to 9,999.00 everywhere. Because of
 * the COMPARISONS made against these numbers:
 *
 *   - `Balance = 0` decides whether a customer is settled. A residue of
 *     -1.8e-11 keeps a fully-paid customer on the aging report forever, owing
 *     an amount that displays as 0.00 and cannot be collected or cleared.
 *   - `Balance >= amount` decides whether the drawer can pay. A drawer holding
 *     999.9999999999 refuses a payment of 1,000 it can plainly make.
 *   - `CreditLimit` comparisons refuse a sale that is exactly at the limit.
 *
 * These are the failures a shop cannot diagnose, because every figure on
 * screen agrees with them.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED
 * -----------------------------------
 * That the amounts are integers, or that a decimal library is used. Both were
 * considered and measured against. `decimal.js` cannot see this arithmetic at
 * all — `Balance = Balance + ?` never passes through JavaScript. Integer
 * piastres would work, but the safe float range is 2^53 piastres = 90 trillion
 * pounds, ninety times the application's own MAX_AMOUNT ceiling, so magnitude
 * was never the problem. Only accumulation was, and `ROUND(..., 2)` in the SQL
 * is the operation that fixes exactly that.
 *
 * Run:  node --experimental-strip-types scripts/verify_money_precision.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `fileURLToPath`, never `.pathname`.
//
// On Windows a file:// URL's pathname is `/D:/coding%20projects/...` — it
// keeps a leading slash and it is percent-encoded. MEASURED on the owner's
// machine, joining that with a subdirectory produced
//
//     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
//
// — the drive letter twice and the spaces still as %20. `fileURLToPath` is the
// documented conversion and handles both.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

const { buildDatabase, loadHandlers, call, currentDb } =
  await import(join(ROOT, 'scripts/lib/handlerHarness.mjs'));

const db = buildDatabase();
await loadHandlers();

db.prepare("INSERT INTO roles (RoleID,RoleName,IsSystem) VALUES (1,'مدير',1)").run();
db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','$2a$10$x',1,1)").run();
db.prepare("INSERT INTO fiscal_years (FiscalYearID,YearName,StartDate,EndDate,Status) VALUES (1,'2026','2026-01-01','2026-12-31','open')").run();
await call('warehouses:create', { WarehouseName: 'المخزن', WarehouseType: 'main' });
await call('cashAccounts:create', { AccountName: 'الخزينة', AccountType: 'safe', Balance: 0 });
await call('customers:create', { Name: 'عميل الكسور', Phone: '0100', CreditLimit: 10_000_000 });
await call('suppliers:create', { Name: 'مورد', Phone: '0111' });
const item = await call('items:create', { ItemName: 'اكسسوار', ItemType: 'accessory', SalePrice: 33.33, Barcode: 'A1' });
await call('purchases:create', {
  SupplierID: 1, PaidAmount: 0, PaymentMethod: 'cash',
  items: [{ ItemID: item.id, Quantity: 5000, UnitCost: 10, WarehouseID: 1 }],
  userId: 1, fiscalYearId: 1,
});

// ===========================================================================
console.log('\n── 1. 300 accumulating documents do not drift ──');
// ===========================================================================
{
  const N = 300;
  let rejected = 0;
  for (let i = 0; i < N; i++) {
    const r = await call('sales:create', {
      CustomerID: 1, PaidAmount: 0, PaymentMethod: 'credit',
      items: [{ ItemID: item.id, Quantity: 1, UnitPrice: 33.33, WarehouseID: 1 }],
      userId: 1, fiscalYearId: 1,
    });
    if (!r?.success) { rejected++; break; }
  }
  ok('all 300 sales were accepted', rejected === 0);

  const balance = db.prepare('SELECT Balance FROM customers WHERE CustomerID=1').get().Balance;
  const docSum = db.prepare('SELECT COALESCE(SUM(TotalAmount),0) s FROM sales WHERE IsVoided=0').get().s;

  console.log(`   balance ${Number(balance).toFixed(12)}   documents ${Number(docSum).toFixed(12)}`);

  // EXACT equality, not a tolerance. A tolerance is what hid this for months:
  // every invariant check in the project compares with an epsilon, so a drift
  // smaller than the epsilon is invisible to all of them.
  ok('the ledger balance EXACTLY equals the sum of its documents',
    balance === docSum, `${balance} vs ${docSum}`);
  ok('the balance is exactly 9999, not 9998.999999999982',
    balance === 9999, String(balance));
}

// ===========================================================================
console.log('── 2. a fully-settled account reads exactly zero ──');
// ===========================================================================
{
  // The comparison that matters most: `Balance = 0` is how the program decides
  // a customer owes nothing.
  const owed = db.prepare('SELECT Balance FROM customers WHERE CustomerID=1').get().Balance;
  const v = await call('vouchers:create', {
    VoucherType: 'receipt', Date: '2026-02-03', Amount: Number(owed),
    PartyType: 'customer', PartyID: 1, CashAccountID: 1,
    FiscalYearID: 1, fiscalYearId: 1, Description: 'سداد كامل', userId: 1,
  });
  ok('the settling receipt was accepted', v?.success === true, JSON.stringify(v).slice(0, 120));

  const after = db.prepare('SELECT Balance FROM customers WHERE CustomerID=1').get().Balance;
  ok('a fully-paid customer reads EXACTLY zero', after === 0,
    `${after} — the account stays on the aging report showing 0.00 owing`);

  // ...and the equality the reports actually run.
  const stillOwing = db.prepare(
    'SELECT COUNT(*) n FROM customers WHERE CustomerID=1 AND Balance <> 0'
  ).get().n;
  ok('SQL agrees the customer is settled', stillOwing === 0);
}

// ===========================================================================
console.log('── 3. no stored amount carries a sub-piastre fraction ──');
// ===========================================================================
{
  const rows = db.prepare(`
    SELECT 'sales.TotalAmount' src, COUNT(*) n FROM sales WHERE ABS(TotalAmount*100 - ROUND(TotalAmount*100)) > 1e-9
    UNION ALL SELECT 'sale_details.Total', COUNT(*) FROM sale_details WHERE ABS(Total*100 - ROUND(Total*100)) > 1e-9
    UNION ALL SELECT 'customers.Balance', COUNT(*) FROM customers WHERE ABS(Balance*100 - ROUND(Balance*100)) > 1e-9
    UNION ALL SELECT 'suppliers.Balance', COUNT(*) FROM suppliers WHERE ABS(Balance*100 - ROUND(Balance*100)) > 1e-9
    UNION ALL SELECT 'cash_accounts.Balance', COUNT(*) FROM cash_accounts WHERE ABS(Balance*100 - ROUND(Balance*100)) > 1e-9
    UNION ALL SELECT 'payment_methods.Balance', COUNT(*) FROM payment_methods WHERE ABS(Balance*100 - ROUND(Balance*100)) > 1e-9
  `).all();
  for (const r of rows) {
    ok(`${r.src} holds whole piastres only`, r.n === 0, `${r.n} row(s) with a sub-piastre fraction`);
  }
}

// ===========================================================================
console.log('── 4. the classic 0.1 + 0.2, through the product ──');
// ===========================================================================
{
  await call('customers:create', { Name: 'عميل الكسر', Phone: '0102', CreditLimit: 1000 });
  const s = await call('sales:create', {
    CustomerID: 2, PaidAmount: 0, PaymentMethod: 'credit',
    items: [
      { ItemID: item.id, Quantity: 1, UnitPrice: 0.1, WarehouseID: 1 },
      { ItemID: item.id, Quantity: 1, UnitPrice: 0.2, WarehouseID: 1 },
    ],
    userId: 1, fiscalYearId: 1,
  });
  ok('the two-line sale was accepted', s?.success === true, JSON.stringify(s).slice(0, 120));
  const sid = s?.id ?? s?.saleId ?? db.prepare('SELECT MAX(SaleID) m FROM sales').get().m;
  const h = db.prepare('SELECT TotalAmount FROM sales WHERE SaleID=?').get(sid);
  ok('0.1 + 0.2 is stored as 0.3, not 0.30000000000000004',
    h?.TotalAmount === 0.3, String(h?.TotalAmount));
  ok('the customer owes exactly 0.3',
    db.prepare('SELECT Balance FROM customers WHERE CustomerID=2').get().Balance === 0.3);
}

// ===========================================================================
console.log('── 5. the rewrite is narrow and it is mirrored ──');
// ===========================================================================
{
  // The fix rewrites SQL at `prepare`. Two things must hold: it must not touch
  // any other arithmetic, and the test stub must do the same thing or every
  // suite above measures a database layer that does not ship.
  const conn = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf8');
  const stub = readFileSync(join(ROOT, 'scripts/lib/stubs/betterSqlite.mjs'), 'utf8');

  // The SHIPPED driver must actually CALL the rewrite, not merely contain it.
  // A mutation test proved this matters: changing
  // `const sql = roundBalanceArithmetic(rawSql)` to `const sql = rawSql`
  // left the function, the regex and every string this file looks for exactly
  // where they were, and the suite passed while the shipped app drifted. The
  // harness runs the STUB, so nothing else here can see that.
  ok('connection.ts rewrites the balance arithmetic',
    /SET Balance = ROUND\(Balance \$\{op\} \?, 2\)/.test(conn));
  ok('hardenBinding actually CALLS the rewrite on the SQL it prepares',
    /const sql = roundBalanceArithmetic\(rawSql\);/.test(conn)
    && /originalPrepare\(sql\)/.test(conn),
    'the function exists but the prepared statement bypasses it');
  ok('the test stub mirrors it',
    /SET Balance = ROUND\(Balance \$\{op\} \?, 2\)/.test(stub),
    'the harness would exercise unrounded arithmetic while the app rounds');

  // Prove the narrowness by running the real function over statements that
  // must NOT change.
  const at = conn.indexOf('function roundBalanceArithmetic');
  ok('the rewrite lives in one named function', at >= 0);
  if (at >= 0) {
    const openBrace = conn.indexOf('{\n', conn.indexOf(')', at));
    let d = 0, end = -1;
    for (let i = openBrace; i < conn.length; i++) {
      if (conn[i] === '{') d++;
      else if (conn[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
    }
    const mod = await import('data:text/javascript,' + encodeURIComponent(
      conn.slice(at, end).replace(/:\s*string/g, '') + '\nexport default roundBalanceArithmetic;'));
    const rw = mod.default;

    ok('a customer balance UPDATE is rewritten',
      rw('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?')
        === 'UPDATE customers SET Balance = ROUND(Balance + ?, 2) WHERE CustomerID = ?');
    ok('subtraction is rewritten too',
      rw('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
        === 'UPDATE cash_accounts SET Balance = ROUND(Balance - ?, 2) WHERE CashAccountID = ?');

    // Everything else must pass through byte for byte.
    for (const untouched of [
      'SELECT Balance FROM customers WHERE CustomerID = ?',
      'UPDATE customers SET Name = ? WHERE CustomerID = ?',
      'UPDATE items SET SalePrice = SalePrice + ? WHERE ItemID = ?',
      'UPDATE stock_quantities SET Quantity = Quantity - ? WHERE ItemID = ?',
      'UPDATE customers SET Balance = ? WHERE CustomerID = ?',
      'INSERT INTO customers (Name, Balance) VALUES (?, ?)',
      "SELECT SUM(Balance) FROM cash_accounts WHERE AccountType = 'safe'",
    ]) {
      ok(`unchanged: ${untouched.slice(0, 52)}`, rw(untouched) === untouched, rw(untouched));
    }
  }
}

// ===========================================================================
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — running balances are exact to the piastre`);
