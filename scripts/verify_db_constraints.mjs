#!/usr/bin/env node
/**
 * DATABASE-LEVEL GUARDS — the layer that cannot be forgotten.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sixty-one tables carried NOT ONE constraint on a VALUE. Measured by writing
 * straight to the database, bypassing every handler:
 *
 *   customer with CreditLimit -9999          accepted
 *   customer with Status 'GOD_MODE'          accepted
 *   item with SalePrice -500                 accepted
 *   item with ItemType 'WEAPON'              accepted
 *   cash account with Balance -100000        accepted
 *   sale with TotalAmount -50                accepted
 *   sale line with Quantity 0, and with -5   accepted
 *   voucher of type 'MAGIC'                  accepted
 *   voucher with Amount -999                 accepted
 *   voucher with Date 'BANANA'               accepted
 *   maintenance ticket in status 'ALIEN'     accepted
 *
 * The handler validation added earlier closes the ordinary route, and that is
 * where the helpful Arabic message belongs. But it is ONE layer. A future
 * handler that forgets a check, a repair script, a hand edit, or a restore
 * from a doctored backup all reach the tables without passing through it.
 *
 * TWO THINGS THIS SUITE ALSO PINS
 * -------------------------------
 * 1. That the guards are VISIBLE TO THE TESTS. The first version generated the
 *    triggers in a loop; the harness builds its schema by extracting
 *    ``db.exec(`...`)`` templates and skips any containing `${`, so the
 *    application enforced 44 guards the test database did not have. The tests
 *    would have passed while the guards were untested — the exact blind spot
 *    this review exists to remove.
 *
 * 2. That they do not OVER-REACH. A guard that refuses a legitimate business
 *    state is worse than the hole it closes: a customer may open in credit,
 *    a party balance may be negative, an item may be free. Every refusal below
 *    is paired with an acceptance.
 *
 * Run:  node --experimental-strip-types scripts/verify_db_constraints.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const { buildDatabase } = await import(pathToFileURL(join(ROOT, 'scripts/lib/handlerHarness.mjs')).href);
const db = buildDatabase();

/** The write must be REFUSED by the database itself. */
function refused(label, sql, ...args) {
  checks += 1;
  try {
    db.prepare(sql).run(...args);
    failures.push(`${label} — the database ACCEPTED it`);
  } catch { /* refused, as required */ }
}
/** The write must be ALLOWED: a guard that blocks real business is a bug. */
function allowed(label, sql, ...args) {
  checks += 1;
  try { db.prepare(sql).run(...args); }
  catch (e) { failures.push(`${label} — the database REFUSED a legitimate value: ${String(e.message).slice(0, 70)}`); }
}

// Seed the rows the foreign keys need.
db.prepare("INSERT INTO roles VALUES (1,'مدير',1)").run();
db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','x',1,1)").run();
db.prepare("INSERT INTO fiscal_years (FiscalYearID,YearName,StartDate,EndDate,Status) VALUES (1,'2026','2026-01-01','2026-12-31','open')").run();
db.prepare("INSERT INTO warehouses (WarehouseID,WarehouseName,WarehouseType,IsActive) VALUES (1,'م','main',1)").run();

// ===========================================================================
console.log('\n── 1. the guards exist and the TESTS can see them ──');
// ===========================================================================
{
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ck_%'").all();
  ok('the database carries value guards', triggers.length >= 40,
    `${triggers.length} found — the harness skips db.exec templates containing \${, `
    + 'so a generated block would be invisible here while live in the app');

  // Both events, or an UPDATE walks straight past the INSERT guard.
  const names = triggers.map(t => t.name);
  ok('guards cover INSERT', names.some(n => n.endsWith('_insert')));
  ok('guards cover UPDATE', names.some(n => n.endsWith('_update')));

  // The migration must be re-runnable on an existing install.
  const src = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf8');
  const block = src.slice(src.indexOf('CREATE TRIGGER IF NOT EXISTS ck_'));
  ok('every guard is IF NOT EXISTS (safe to re-run)',
    !/CREATE TRIGGER (?!IF NOT EXISTS)/.test(block));
}

// ===========================================================================
console.log('── 2. money may not be negative where it has no credit side ──');
// ===========================================================================
{
  refused('a cash box cannot open below zero',
    "INSERT INTO cash_accounts (AccountName,AccountType,Balance,IsActive) VALUES ('n','safe',-1,1)");
  refused('a wallet cannot open below zero',
    "INSERT INTO payment_methods (MethodName,MethodType,Balance,IsActive) VALUES ('w','digital_wallet',-5,1)");

  allowed('a cash box CAN open at zero',
    "INSERT INTO cash_accounts (CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES (1,'خ','safe',0,1)");
  // The UPDATE guard is tested only AFTER a row exists: `UPDATE ... WHERE 1=1`
  // against an empty table changes nothing and fires no trigger, so asserting
  // a refusal there passes for the wrong reason. Found by this suite failing.
  refused('nor can an existing box be driven below zero',
    "UPDATE cash_accounts SET Balance = -1 WHERE CashAccountID = 1");
  allowed('and at a real balance',
    "INSERT INTO cash_accounts (CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES (2,'ب','bank',50000,1)");
  allowed('a wallet CAN open at zero',
    "INSERT INTO payment_methods (PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES (1,'و','digital_wallet',0,1)");
}

// ===========================================================================
console.log('── 3. a party balance MAY be negative — that is credit ──');
// ===========================================================================
{
  // The opposite of section 2, and the reason each guard is per-column rather
  // than a blanket "no negatives" rule. A customer in credit means the shop
  // owes them, which is an ordinary position and must not be blocked.
  allowed('a customer may carry a credit balance',
    "INSERT INTO customers (CustomerID,Name,Balance,Status) VALUES (1,'عميل',-500,'active')");
  allowed('a supplier may carry a debit balance',
    "INSERT INTO suppliers (SupplierID,Name,Balance,Status) VALUES (1,'مورد',-300,'active')");
  allowed('an employee balance may be negative',
    "INSERT INTO employees (EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES (1,'موظف',3000,0,-100,1)");

  // But a credit LIMIT is a ceiling, and a negative ceiling is meaningless.
  refused('a negative credit limit is refused',
    "INSERT INTO customers (Name,Balance,Status,CreditLimit) VALUES ('x',0,'active',-9999)");
  allowed('a null credit limit means no limit',
    "INSERT INTO customers (CustomerID,Name,Balance,Status,CreditLimit) VALUES (2,'y',0,'active',NULL)");
  allowed('and a real limit is fine',
    "INSERT INTO customers (CustomerID,Name,Balance,Status,CreditLimit) VALUES (3,'z',0,'active',5000)");
}

// ===========================================================================
console.log('── 4. vocabularies the reports depend on ──');
// ===========================================================================
{
  refused('an unknown party status', "UPDATE customers SET Status='GOD_MODE' WHERE CustomerID=1");
  allowed('a real party status', "UPDATE customers SET Status='suspended' WHERE CustomerID=1");

  refused('an unknown item type',
    "INSERT INTO items (ItemName,ItemType,SalePrice,CostPrice,IsActive) VALUES ('w','WEAPON',1,0,1)");
  for (const t of ['phone', 'accessory', 'service']) {
    allowed(`item type "${t}"`,
      "INSERT INTO items (ItemName,ItemType,SalePrice,CostPrice,IsActive) VALUES (?,?,1,0,1)", `i-${t}`, t);
  }

  refused('an unknown voucher type',
    "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('V-M','MAGIC',1,'2026-01-01',10,'d',1)");
  refused('a voucher type differing only in case',
    "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('V-U','RECEIPT',1,'2026-01-01',10,'d',1)");
  for (const t of ['receipt', 'payment']) {
    allowed(`voucher type "${t}"`,
      "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES (?,?,1,'2026-01-01',10,'d',1)", `V-${t}`, t);
  }

  refused('an unknown ticket status',
    "INSERT INTO maintenance_tickets (TicketNumber,FiscalYearID,Date,CustomerName,CustomerPhone,DeviceModel,ProblemDesc,Status,UserID) VALUES ('M-A',1,'2026-01-01','c','0','d','p','ALIEN',1)");
  for (const st of ['received', 'inspecting', 'in_progress', 'ready', 'delivered', 'cancelled', 'returned']) {
    allowed(`ticket status "${st}"`,
      "INSERT INTO maintenance_tickets (TicketNumber,FiscalYearID,Date,CustomerName,CustomerPhone,DeviceModel,ProblemDesc,Status,UserID) VALUES (?,1,'2026-01-01','c','0','d','p',?,1)", `M-${st}`, st);
  }
}

// ===========================================================================
console.log('── 5. documents, lines and dates ──');
// ===========================================================================
{
  refused('a sale with a negative total',
    "INSERT INTO sales (SaleNumber,FiscalYearID,Date,Subtotal,TotalAmount,PaidAmount,Discount,UserID,IsVoided,PaymentMethod) VALUES ('S-N',1,'2026-01-01',-50,-50,0,0,1,0,'cash')");
  refused('a sale with a negative paid amount',
    "INSERT INTO sales (SaleNumber,FiscalYearID,Date,Subtotal,TotalAmount,PaidAmount,Discount,UserID,IsVoided,PaymentMethod) VALUES ('S-P',1,'2026-01-01',50,50,-10,0,1,0,'cash')");
  allowed('a real sale',
    "INSERT INTO sales (SaleID,SaleNumber,FiscalYearID,Date,Subtotal,TotalAmount,PaidAmount,Discount,UserID,IsVoided,PaymentMethod) VALUES (1,'S-OK',1,'2026-01-01',100,100,100,0,1,0,'cash')");
  allowed('a fully unpaid sale is legitimate (credit)',
    "INSERT INTO sales (SaleID,SaleNumber,FiscalYearID,Date,Subtotal,TotalAmount,PaidAmount,Discount,UserID,IsVoided,PaymentMethod) VALUES (2,'S-CR',1,'2026-01-01',100,100,0,0,1,0,'credit')");

  refused('a sale line of zero quantity',
    "INSERT INTO sale_details (SaleID,ItemID,Quantity,UnitPrice,Total) VALUES (1,1,0,10,0)");
  refused('a sale line of negative quantity',
    "INSERT INTO sale_details (SaleID,ItemID,Quantity,UnitPrice,Total) VALUES (1,1,-5,10,-50)");
  allowed('a real sale line', "INSERT INTO sale_details (SaleID,ItemID,Quantity,UnitPrice,Total) VALUES (1,1,2,10,20)");
  allowed('a free line is legitimate (a giveaway)',
    "INSERT INTO sale_details (SaleID,ItemID,Quantity,UnitPrice,Total) VALUES (1,1,1,0,0)");

  // Dates are compared as TEXT everywhere, so a non-date sorts anywhere and
  // silently falls outside or inside every report range.
  for (const bad of ['BANANA', '2026/01/01', '01-01-2026', '']) {
    refused(`a date of ${JSON.stringify(bad)}`,
      "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES (?, 'receipt',1,?,10,'d',1)",
      `V-D-${bad || 'empty'}`, bad);
  }
  allowed('a well-formed date',
    "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('V-D-OK','receipt',1,'2026-12-31',10,'d',1)");

  refused('a voucher of zero', "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('V-Z','receipt',1,'2026-01-01',0,'d',1)");
  refused('a voucher of a negative amount', "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('V-NEG','receipt',1,'2026-01-01',-999,'d',1)");
}

// ===========================================================================
console.log('── 6. payroll ──');
// ===========================================================================
{
  // CashAccountID is NOT NULL on this table; omitting it made the "legitimate
  // value" case fail for a reason unrelated to the guard under test.
  refused('an advance of zero',
    "INSERT INTO employee_advances (EmployeeID,Amount,Date,CashAccountID,FiscalYearID,UserID,IsDeducted) VALUES (1,0,'2026-01-01',1,1,1,0)");
  refused('an advance of a negative amount',
    "INSERT INTO employee_advances (EmployeeID,Amount,Date,CashAccountID,FiscalYearID,UserID,IsDeducted) VALUES (1,-100,'2026-01-01',1,1,1,0)");
  allowed('a real advance',
    "INSERT INTO employee_advances (EmployeeID,Amount,Date,CashAccountID,FiscalYearID,UserID,IsDeducted) VALUES (1,500,'2026-01-01',1,1,1,0)");
  refused('a negative net salary',
    "INSERT INTO salaries (EmployeeID,Month,BaseSalary,NetSalary,FiscalYearID,UserID) VALUES (1,'2026-01',3000,-1,1,1)");
  allowed('a zero net salary (fully absorbed by advances)',
    "INSERT INTO salaries (EmployeeID,Month,BaseSalary,NetSalary,FiscalYearID,UserID) VALUES (1,'2026-02',3000,0,1,1)");
}

console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — the database refuses what no handler should have let through`);
