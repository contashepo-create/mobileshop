#!/usr/bin/env node
/**
 * SECTION 1 — SECURITY CORE: fresh behavioural tests.
 *
 * The existing suites proved the guard's wiring (verify_ipc_guard_runtime),
 * the login throttle (verify_auth_audit), the licence cryptography
 * (verify_license_ed25519) and the recovery flow (verify_password_recovery).
 * None of them drive the REAL users/roles/permissions handlers with a REAL
 * database, and none exercise the session absolute timeout, the closed-year
 * refusal, the book guard's conservation rule or the error-response filter
 * against the real code. Those are the gaps this suite closes.
 *
 * Run with:  node --experimental-strip-types scripts/verify_security_core.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb, session } from './lib/handlerHarness.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/handlerHarness.mjs';

// `refuseClosedYear` in ipcGuard.ts reaches the database through a synchronous
// CommonJS `require('../database/connection')`. CommonJS require does NOT pass
// through the harness's ESM loader hook, so it must be shimmed by hand: the
// connection specifier returns the harness stub (which serves the SAME
// in-memory database the test is exercising), everything else falls back to a
// real require so unrelated lookups still work.
const realRequire = createRequire(import.meta.url);
globalThis.require = (spec) => {
  if (/database[/\\]connection$/.test(spec)) {
    return { getDb: () => currentDb() };
  }
  return realRequire(spec);
};

const PASS = [], FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail && !ok) console.log(`          ${String(detail).split(/\r?\n/).join('\n          ')}`);
}

const q1 = (sql, ...a) => currentDb().prepare(sql).get(...a);
const qa = (sql, ...a) => currentDb().prepare(sql).all(...a);

/** Fresh database + seed data, so every scenario starts from a known state. */
async function reset() {
  const db = buildDatabase();
  const x = sql => db.exec(sql);
  x(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'admin',1),(2,'sales',0)`);
  x(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive)
     VALUES(1,'admin','x',1,1),(2,'cashier','x',2,1)`);
  x(`INSERT INTO permissions(PermissionID,PermissionKey,PermissionName,Module)
     VALUES(1,'sales.view','عرض المبيعات','sales'),(2,'sales.create','إنشاء مبيعات','sales'),
           (3,'sales.delete','حذف مبيعات','sales')`);
  x(`INSERT INTO role_permissions(RoleID,PermissionID) VALUES(1,1),(1,2),(1,3),(2,1)`);
  x(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status)
     VALUES(1,'2026','2026-01-01','2026-12-31','open'),(2,'2025','2025-01-01','2025-12-31','closed')`);
  x(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')`);
  x(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive)
     VALUES(1,'Safe','safe',100000,1)`);
  x(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'Ahmed',0,'active')`);
  x(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive)
     VALUES(1,'Cable','accessory',0,10,20,1)`);
  x(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice)
     VALUES(1,1,100,10)`);
  return db;
}

await loadHandlers();

console.log('='.repeat(74));
console.log('SECTION 1 — SECURITY CORE (fresh behavioural tests)');
console.log('='.repeat(74));

// ---------------------------------------------------------------- 1
console.log('\n[1] users:create — username normalisation, password rules, role checks');
{
  await reset();
  const r1 = await call('users:create', { username: '  NewUser ', password: 'secret1', roleId: 2 });
  check('spaces are trimmed and the name is lower-cased on create',
    r1?.success === true && /newuser/.test(String(q1('SELECT Username FROM users WHERE UserID = ?', 3)?.Username)),
    JSON.stringify(r1));

  const r2 = await call('users:create', { username: 'NEWUSER', password: 'secret1', roleId: 2 });
  check('a case-only duplicate is refused',
    r2?.success === false, JSON.stringify(r2));

  const r3 = await call('users:create', { username: 'bob', password: 'short', roleId: 2 });
  check('a password under six characters is refused',
    r3?.success === false, JSON.stringify(r3));

  const r4 = await call('users:create', { username: 'bob', password: 'secret1', roleId: 999 });
  check('a role that does not exist is refused',
    r4?.success === false, JSON.stringify(r4));

  const r5 = await call('users:create', { username: 'bob', password: 'secret1', roleId: 2, employeeId: 999 });
  check('an employee that does not exist is refused',
    r5?.success === false, JSON.stringify(r5));

  const r6 = await call('users:create', { username: 'مع مسافات', password: 'secret1', roleId: 2 });
  check('a username with spaces or non-Latin characters is refused',
    r6?.success === false, JSON.stringify(r6));

  const long = await call('users:create', { username: 'bob', password: 'a'.repeat(100), roleId: 2 });
  check('a password over 72 bytes is refused (bcrypt truncation guard)',
    long?.success === false, JSON.stringify(long));

  const arabic = await call('users:create', { username: 'bob2', password: 'كلمةمرورعربيةطويلة' + 'x'.repeat(50), roleId: 2 });
  check('a long Arabic password is refused by BYTE length, not character count',
    arabic?.success === false, JSON.stringify(arabic));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] users:update — rename clashes, blank username, last-admin lockout');
{
  await reset();
  const r1 = await call('users:update', 2, { username: 'ADMIN' });
  check('renaming another user onto an existing name is refused',
    r1?.success === false, JSON.stringify(r1));

  const r2 = await call('users:update', 2, { username: 'cashier2', roleId: 2, isActive: 1 });
  check('a valid rename succeeds',
    r2?.success === true, JSON.stringify(r2));

  const r3 = await call('users:update', 2, { username: '   ', roleId: 2, isActive: 1 });
  check('blanking a username is refused',
    r3?.success === false, JSON.stringify(r3));

  const r4 = await call('users:update', 1, { roleId: 2, isActive: 1 });
  check('demoting the last active administrator is refused',
    r4?.success === false, JSON.stringify(r4));

  const r5 = await call('users:update', 1, { roleId: 1, isActive: 0 });
  check('deactivating the last active administrator is refused',
    r5?.success === false, JSON.stringify(r5));

  const r6 = await call('users:create', { username: 'admin2', password: 'secret1', roleId: 1 });
  check('a second administrator can be created',
    r6?.success === true, JSON.stringify(r6));
  const r7 = await call('users:update', 1, { roleId: 2, isActive: 1 });
  check('demoting the admin is now allowed — another admin exists',
    r7?.success === true, JSON.stringify(r7));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] users:delete — last-admin lockout and session termination');
{
  await reset();
  const r1 = await call('users:delete', 1);
  check('deleting the last active administrator is refused',
    r1?.success === false, JSON.stringify(r1));

  const r2 = await call('users:delete', 2);
  check('a non-last user can be deactivated',
    r2?.success === true, JSON.stringify(r2));
  const row = q1('SELECT IsActive FROM users WHERE UserID = 2');
  check('the row is marked inactive, not removed',
    row?.IsActive === 0, JSON.stringify(row));

  await call('users:create', { username: 'admin3', password: 'secret1', roleId: 1 });
  const r3 = await call('users:delete', 1);
  check('deleting the first admin is allowed once a second exists',
    r3?.success === true, JSON.stringify(r3));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] roles — system-role protection, duplicates, delete reassigns users');
{
  await reset();
  const r1 = await call('roles:create', 'Manager');
  check('a role is created',
    r1?.success === true, JSON.stringify(r1));
  const r2 = await call('roles:create', 'manager');
  check('a duplicate role name is refused (case-insensitive)',
    r2?.success === false, JSON.stringify(r2));

  const r3 = await call('roles:delete', 1);
  check('a system role cannot be deleted',
    r3?.success === false, JSON.stringify(r3));

  await call('users:create', { username: 'bob', password: 'secret1', roleId: 2 });
  const r4 = await call('roles:delete', 2);
  check('a custom role with members can be deleted',
    r4?.success === true, JSON.stringify(r4));
  const moved = qa('SELECT RoleID FROM users WHERE Username = ?', 'bob');
  check('its members are reassigned to the administrator role',
    moved.every(r => r.RoleID === 1), JSON.stringify(moved));
  const perms = qa('SELECT PermissionID FROM role_permissions WHERE RoleID = 2');
  check('its permissions are cleaned up',
    perms.length === 0, `left ${perms.length}`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] permissions:setForRole — atomicity, de-duplication, unknown ids');
{
  await reset();
  const r1 = await call('permissions:setForRole', 2, [1, 1, 2, 3]);
  check('duplicate permission ids are accepted once',
    r1?.success === true, JSON.stringify(r1));
  const got = qa('SELECT PermissionID FROM role_permissions WHERE RoleID = 2 ORDER BY PermissionID');
  check('the stored set is de-duplicated and complete',
    got.length === 3 && got.map(g => g.PermissionID).join() === '1,2,3', JSON.stringify(got));

  const r2 = await call('permissions:setForRole', 2, [1, 999]);
  check('an unknown permission id is refused',
    r2?.success === false, JSON.stringify(r2));
  const after = qa('SELECT PermissionID FROM role_permissions WHERE RoleID = 2 ORDER BY PermissionID');
  check('the previous set survives the refused update (atomic)',
    after.length === 3 && after.map(g => g.PermissionID).join() === '1,2,3', JSON.stringify(after));

  const r3 = await call('permissions:setForRole', 2, 'not-an-array');
  check('a non-array payload is refused without wiping permissions',
    r3?.success === false && qa('SELECT PermissionID FROM role_permissions WHERE RoleID = 2').length === 3,
    JSON.stringify(r3));

  const r4 = await call('permissions:setForRole', 999, [1]);
  check('a role that does not exist is refused',
    r4?.success === false, JSON.stringify(r4));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] user overrides — grant/deny semantics and invalid types');
{
  await reset();
  const r1 = await call('permissions:setOverride', 2, 3, 'grant');
  check('a grant override is accepted',
    r1?.success === true, JSON.stringify(r1));
  const r2 = await call('permissions:setOverride', 2, 3, 'something-else');
  check('an invalid override type is refused',
    r2?.success === false, JSON.stringify(r2));
  const r3 = await call('permissions:setOverride', 999, 1, 'deny');
  check('an override for a missing user is refused',
    r3?.success === false, JSON.stringify(r3));
  const r4 = await call('permissions:setOverride', 2, 999, 'deny');
  check('an override for a missing permission is refused',
    r4?.success === false, JSON.stringify(r4));
  const r5 = await call('permissions:removeOverride', 2, 3);
  check('removing an override succeeds',
    r5?.success === true, JSON.stringify(r5));
  const rows = qa('SELECT * FROM user_overrides WHERE UserID = 2');
  check('no override remains after removal',
    rows.length === 0, JSON.stringify(rows));
}


// ---------------------------------------------------------------- 8
console.log('\n[8] book guard — conservation on reversals, negative-cash detection');
{
  await reset();
  // Build a real sale, then reverse it through the real delete handler. Net
  // worth must be identical before and after the pair.
  const db = currentDb();
  const worth0 = () => {
    const g = (s) => Number(db.prepare(s).get().v) || 0;
    return Math.round(100 * (
      g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
      + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
      + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
      + g('SELECT COALESCE(SUM(Balance),0) v FROM customers')
      - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers'))) / 100;
  };
  const before = worth0();
  const sale = await call('sales:create', {
    CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1,
    fiscalYearId: 1,
  });
  check('the sale itself succeeds',
    sale?.success === true, JSON.stringify(sale));
  const saleId = sale.id ?? sale.saleId ?? q1('SELECT MAX(SaleID) m FROM sales')?.m;
  const del = await call('delete:sale', Number(saleId));
  check('deleting the sale succeeds',
    del?.success === true, JSON.stringify(del));
  const after = worth0();
  check('net worth is conserved across create + delete (no drift)',
    Math.abs(after - before) <= 1.0, `before=${before} after=${after}`);

  const guard = await import(pathToFileURL(join(ROOT, 'src/main/security/bookGuard.ts')).href);
  const verdict = guard.checkBooks(db, 'delete:sale', before);
  check('the books pass the invariant check after the reversal',
    verdict.ok === true, JSON.stringify(verdict));

  // The database itself enforces non-negative cash through triggers, and
  // `checkBooks` re-checks it for data written before the triggers existed.
  // Prove both layers: the trigger refuses a direct negative write…
  let triggerRefused = false;
  try {
    db.prepare('UPDATE cash_accounts SET Balance = -5 WHERE CashAccountID = 1').run();
  } catch (err) {
    triggerRefused = /must not be negative/.test(String(err?.message || err));
  }
  check('a negative cash write is refused by the database trigger',
    triggerRefused === true);

  // …and the book guard flags the same condition when it sees it.
  const Wrapped = (await import('./lib/stubs/betterSqlite.mjs')).default;
  const mini = new Wrapped(':memory:');
  mini.exec(`CREATE TABLE cash_accounts (CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL)`);
  mini.exec(`CREATE TABLE payment_methods (PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL)`);
  mini.exec(`CREATE TABLE customers (CustomerID INTEGER PRIMARY KEY, Balance REAL)`);
  mini.exec(`CREATE TABLE suppliers (SupplierID INTEGER PRIMARY KEY, Balance REAL)`);
  mini.exec(`CREATE TABLE stock_quantities (ItemID INTEGER, WarehouseID INTEGER, Quantity REAL, CostPrice REAL)`);
  mini.prepare('INSERT INTO cash_accounts VALUES (1, ?, ?)').run('Safe', -5);
  const breach = guard.checkBooks(mini, 'delete:sale', 100);
  check('a negative cash box is flagged as a breach',
    breach.ok === false && breach.breach?.rule === 'noNegativeCash', JSON.stringify(breach));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] session — absolute timeout cannot be extended by activity');
{
  const sessionMod = await import(pathToFileURL(join(ROOT, 'src/main/security/session.ts')).href);
  sessionMod.destroySession(77);
  sessionMod.createSession(77, {
    userId: 9, username: 'tester', roleId: 1, employeeId: null,
    permissions: new Set(['sales.view']),
  });

  // Fast-forward time past the idle timeout.
  const realNow = Date.now;
  Date.now = () => realNow() + sessionMod.SESSION_LIMITS.idleMs + 1000;
  const idleGone = sessionMod.getSession(77);
  Date.now = realNow;
  check('a session older than the IDLE timeout is dropped',
    idleGone === null, JSON.stringify(idleGone));

  // Recreate, then jump past the ABSOLUTE timeout in one step — the activity
  // on the last getSession should NOT be able to extend the ceiling.
  sessionMod.createSession(77, {
    userId: 9, username: 'tester', roleId: 1, employeeId: null,
    permissions: new Set(['sales.view']),
  });
  sessionMod.getSession(77);                       // refresh lastSeenAt
  Date.now = () => realNow() + sessionMod.SESSION_LIMITS.absoluteMs + 1000;
  const absGone = sessionMod.getSession(77);
  Date.now = realNow;
  check('a session older than the ABSOLUTE timeout is dropped even with fresh activity',
    absGone === null, JSON.stringify(absGone));
  sessionMod.destroySession(77);
}

// ---------------------------------------------------------------- 10
console.log('\n[10] error responses — technical details never cross the IPC boundary');
{
  const er = await import(pathToFileURL(join(ROOT, 'src/main/security/errorResponse.ts')).href);
  const samples = [
    "ENOENT: no such file or directory, open 'C:\\Users\\mohamed\\app.db'",
    'UNIQUE constraint failed: customers.Phone',
    'no such table: secret_table',
    'at src/main/ipc/sales.handlers.ts:123',
    '/home/shop/data/mobile_shop.db',
    'TypeError: Cannot read properties of undefined',
    'SQLITE_BUSY: database is locked',
  ];
  for (const s of samples) {
    check(`technical leakage is detected: "${s.slice(0, 40)}..."`,
      er.looksTechnical(s) === true);
  }
  const clean = 'لا يمكن حذف فاتورة الشراء - الصنف لم يعد بالمخزن';
  check('an intentional Arabic refusal is NOT flagged as technical',
    er.looksTechnical(clean) === false);

  const refusal = er.userRefusal(clean);
  const out = er.safeFailure('probe', refusal);
  check('a userRefusal passes through intact',
    out.message === clean && out.code === 'REFUSED', JSON.stringify(out));

  const hidden = er.safeFailure('probe', new Error('ENOENT: open /home/shop/app.db'));
  check('a raw filesystem error is replaced, never echoed',
    hidden.message !== 'ENOENT: open /home/shop/app.db', JSON.stringify(hidden));
  check('the replacement carries a reference code for support',
    /رمز/.test(hidden.message) && /[A-Z0-9]{6}/.test(hidden.ref || ''), JSON.stringify(hidden));
}

// ---------------------------------------------------------------- 11
// Runs LAST on purpose: it installs the REAL IPC guard over the shared handler
// registry, which changes how `call()` behaves. Every earlier section uses the
// plain harness path; this one proves the closed-year refusal on the guarded
// path exactly as the running app invokes it.
console.log('\n[11] closed fiscal year — the guard refuses writes on the real IPC path');
{
  await reset();
  const guardMod = await import(pathToFileURL(join(ROOT, 'src/main/security/ipcGuard.ts')).href);
  const sessionMod = await import(pathToFileURL(join(ROOT, 'src/main/security/session.ts')).href);
  sessionMod.createSession(900, {
    userId: 1, username: 'admin', roleId: 1, employeeId: null,
    permissions: new Set(['sales.create', 'sales.delete', 'sales.view']),
  });
  // The guard wraps `ipcMain.handle`, so only channels registered AFTER it
  // run through the authorisation + closed-year checks. Re-register the real
  // sales handlers through the guard — exactly the order the app itself uses.
  guardMod.installIpcGuard();
  const salesMod = await import(pathToFileURL(join(ROOT, 'src/main/ipc/sales.handlers.ts')).href);
  salesMod.registerSalesHandlers();
  const guardedCall = (payload) => globalThis.__TEST_HANDLERS__.get('sales:create')(
    { sender: { id: 900 } },
    { ...payload, userId: 1 },
  );

  const sale = await guardedCall({
    CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 20, CashAccountID: 1,
    fiscalYearId: 2,  // closed
  });
  check('a sale into a CLOSED fiscal year is refused',
    sale?.success === false, JSON.stringify(sale));
  check('it is refused with the closed-year code, not a generic error',
    sale?.code === 'FISCAL_YEAR_CLOSED', `code=${sale?.code}`);
  check('the customer balance is untouched by the refused sale',
    q1('SELECT Balance FROM customers WHERE CustomerID = 1')?.Balance === 0,
    `balance=${q1('SELECT Balance FROM customers WHERE CustomerID = 1')?.Balance}`);
  check('stock is untouched by the refused sale',
    q1('SELECT Quantity FROM stock_quantities WHERE ItemID = 1')?.Quantity === 100,
    `qty=${q1('SELECT Quantity FROM stock_quantities WHERE ItemID = 1')?.Quantity}`);

  // Same request into the OPEN year must pass through the same guard.
  const open = await guardedCall({
    CustomerID: 1,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 20 }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaymentMethod: 'cash', PaidAmount: 20, CashAccountID: 1,
    fiscalYearId: 1,
  });
  check('the identical sale into the OPEN year succeeds',
    open?.success === true, JSON.stringify(open));
  sessionMod.destroySession(900);
}

console.log('\n' + '='.repeat(74));
console.log(`SECTION 1 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log('\nFAILED:');
  for (const f of FAIL) console.log(`  - ${f}`);
}
process.exit(FAIL.length ? 1 : 0);
