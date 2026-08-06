#!/usr/bin/env node
/**
 * MUTATION TEST for verify_write_integrity.mjs.
 *
 * A suite that passes proves nothing on its own — it may be asserting things
 * that are true whatever the code does. This file breaks the guard on purpose,
 * one way at a time, and demands that the suite FAIL each time.
 *
 * The mutants are written to be the changes somebody would plausibly make:
 * reverting the fix, weakening the read/write split, letting the stub drift
 * from the shipped driver, and undoing the four handler repairs.
 *
 * Run:  node scripts/mutate_write_integrity.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CONN = join(ROOT, 'src/main/database/connection.ts');
const STUB = join(ROOT, 'scripts/lib/stubs/betterSqlite.mjs');
const ASSETS = join(ROOT, 'src/main/ipc/assets.handlers.ts');
const INV = join(ROOT, 'src/main/ipc/inventory.handlers.ts');
const HR = join(ROOT, 'src/main/ipc/hr.handlers.ts');

/** file -> [find, replace] */
const MUTANTS = [
  ['revert the fix in the stub: a refused write returns a no-op again', STUB, [
    `        if (writes) {
          throw new Error(\`[DB] refused to run a write with an unbindable parameter: \${shortSql}\`);
        }`,
    `        if (writes) { /* mutant: swallowed */ }`,
  ]],
  ['stub treats every statement as a read', STUB, [
    'const writes = isWriteStatement(sql);',
    'const writes = false;',
  ]],
  ['stub treats every statement as a write (reads would crash again)', STUB, [
    'const writes = isWriteStatement(sql);',
    'const writes = true;',
  ]],
  ['the read/write rule stops recognising UPDATE', STUB, [
    "  if (/^\\s*(SELECT|PRAGMA|EXPLAIN)\\b/.test(head) && !/\\b(INSERT|UPDATE|DELETE|REPLACE)\\b/.test(head)) {\n    return false;\n  }",
    "  if (!/^\\s*(INSERT|DELETE|REPLACE)\\b/.test(head)) {\n    return false;\n  }",
  ]],
  ['the rule stops stripping leading comments (a commented SELECT looks like a write)', STUB, [
    "    .replace(/--[^\\n]*/g, ' ')\n    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')\n    .trim()",
    '    .trim()',
  ]],
  ['the shipped driver keeps the no-op return', CONN, [
    `          if (writes) {`,
    `          if (false) {`,
  ]],
  ['the shipped rule and the stub rule drift apart', CONN, [
    "  if (/^\\s*WITH\\b/.test(head)) {\n    return /\\b(INSERT|UPDATE|DELETE|REPLACE)\\b/.test(head);\n  }",
    '  // mutant: WITH handling removed',
  ]],
  ['cashAccounts:delete stops validating its id', ASSETS, [
    `    const rid = requireId(id, 'رقم الخزينة');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM cash_accounts WHERE CashAccountID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الخزينة غير موجودة' };
    db.prepare('UPDATE cash_accounts SET IsActive = 0 WHERE CashAccountID = ?').run(rid.value);`,
    `    db.prepare('UPDATE cash_accounts SET IsActive = 0 WHERE CashAccountID = ?').run(id);`,
  ]],
  ['cashAccounts:delete validates the id but not the row', ASSETS, [
    `    const exists = db.prepare('SELECT 1 AS ok FROM cash_accounts WHERE CashAccountID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الخزينة غير موجودة' };`,
    '',
  ]],
  ['paymentMethods:delete stops validating its id', ASSETS, [
    `    const rid = requireId(id, 'رقم طريقة الدفع');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM payment_methods WHERE PaymentMethodID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'طريقة الدفع غير موجودة' };
    db.prepare('UPDATE payment_methods SET IsActive = 0 WHERE PaymentMethodID = ?').run(rid.value);`,
    `    db.prepare('UPDATE payment_methods SET IsActive = 0 WHERE PaymentMethodID = ?').run(id);`,
  ]],
  ['items:delete stops validating its id', INV, [
    `    const rid = requireId(id, 'رقم الصنف');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM items WHERE ItemID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الصنف غير موجود' };
    db.prepare('UPDATE items SET IsActive = 0 WHERE ItemID = ?').run(rid.value);`,
    `    db.prepare('UPDATE items SET IsActive = 0 WHERE ItemID = ?').run(id);`,
  ]],
  ['items:delete reports success for a row that does not exist', INV, [
    `    const exists = db.prepare('SELECT 1 AS ok FROM items WHERE ItemID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الصنف غير موجود' };`,
    '',
  ]],
  ['employees:delete stops validating its id', HR, [
    `    const rid = requireId(id, 'رقم الموظف');
    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM employees WHERE EmployeeID = ?').get(rid.value);
    if (!exists) return { success: false, message: 'الموظف غير موجود' };
    db.prepare('UPDATE employees SET IsActive = 0 WHERE EmployeeID = ?').run(rid.value);`,
    `    db.prepare('UPDATE employees SET IsActive = 0 WHERE EmployeeID = ?').run(id);`,
  ]],
  ['a delete channel leaks the SQL statement in its refusal', INV, [
    `    if (!rid.ok) return { success: false, message: rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM items WHERE ItemID = ?').get(rid.value);`,
    `    if (!rid.ok) return { success: false, message: 'UPDATE items SET IsActive = 0 failed: ' + rid.message };
    const exists = db.prepare('SELECT 1 AS ok FROM items WHERE ItemID = ?').get(rid.value);`,
  ]],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_write_integrity.mjs'],
      { cwd: ROOT, stdio: 'pipe' });
    return true;   // suite passed
  } catch {
    return false;  // suite failed
  }
};

// Sanity: the suite must pass on the unmutated tree, or every "caught" below
// would be meaningless.
console.log('baseline (no mutation):');
if (!runSuite()) {
  console.log('  the suite FAILS on the clean tree — fix that first');
  process.exit(1);
}
console.log('  passes\n');

let caught = 0;
const survived = [];

for (const [label, file, [find, replace]] of MUTANTS) {
  const backup = file + '.mutbak';
  copyFileSync(file, backup);
  const src = readFileSync(file, 'utf8');
  if (!src.includes(find)) {
    console.log(`SKIP     ${label}`);
    console.log('         (the text this mutant edits is not present — the mutant is stale)');
    unlinkSync(backup);
    survived.push(label + '  [STALE MUTANT]');
    continue;
  }
  writeFileSync(file, src.replace(find, replace), 'utf8');
  const passed = runSuite();
  copyFileSync(backup, file);
  unlinkSync(backup);

  if (passed) {
    survived.push(label);
    console.log(`SURVIVED ${label}`);
  } else {
    caught++;
    console.log(`caught   ${label}`);
  }
}

console.log('\n' + '═'.repeat(64));
console.log(`${caught} of ${MUTANTS.length} mutants caught`);
if (survived.length) {
  console.log('\nSURVIVED — the suite does not actually test these:');
  for (const s of survived) console.log('  • ' + s);
  process.exit(1);
}
console.log('every mutant was caught — the suite tests behaviour, not spelling');
