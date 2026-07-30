#!/usr/bin/env node
/**
 * RUNTIME BOOK GUARD — does the shop's data get protected, or only the tests?
 *
 * WHY THIS EXISTS
 * ---------------
 * Sixteen invariants already state what must always be true of the books, and
 * a fuzzer throws thousands of random operation sequences at them. That has
 * found every accounting fault in this project. But it all lives in
 * `scripts/`: it protects the developer at test time and nobody in the shop.
 *
 * A fault on a path the fuzzer never reached still reaches the owner's real
 * data, silently and permanently. `src/main/security/bookGuard.ts` closes that
 * gap by re-checking the books after every money-moving IPC call and rolling
 * the operation back if it broke one.
 *
 * WHY NOT DOUBLE-ENTRY — MEASURED, NOT ASSUMED
 * --------------------------------------------
 * Section [1] runs the real fault this project hit (a customer's debt reversed
 * twice) through a double-entry model and through a conservation check. The
 * double-entry model accepts the fault as long as the mistake is balanced;
 * the conservation check does not. That measurement is the entire reason this
 * guard is built on conservation.
 *
 * Run with:  node scripts/verify_book_guard.mjs
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = f => readFileSync(join(ROOT, f), 'utf-8');
const code = f => R(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PASS = [], FAIL = [];
function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

let Database = null;
for (const base of [join(ROOT, 'package.json'), join(HERE, 'package.json')]) {
  try { Database = createRequire(base)('better-sqlite3'); break; } catch { /* next */ }
}

console.log('='.repeat(74));
console.log('RUNTIME BOOK GUARD — protecting the shop, not just the test suite');
console.log('='.repeat(74));

// ------------------------------------------------------------------ 1
console.log('\n[1] MEASURED: why conservation, and not double-entry');
{
  // The real fault: delete:maintenanceDelivery reversed the same debt twice.
  // Opening position: customer owes 600, 400 already banked.
  const postings = [];
  const post = lines => {
    const sum = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(sum) > 0.005) throw new Error(`unbalanced by ${sum}`);
    postings.push(...lines);
  };
  const acct = a => r2(postings.filter(l => l.acct === a)
    .reduce((s, l) => s + l.debit - l.credit, 0));

  post([
    { acct: 'cash', debit: 400, credit: 0 },
    { acct: 'customer', debit: 600, credit: 0 },
    { acct: 'income', debit: 0, credit: 1000 },
  ]);

  // (a) the careless version of the fault: double reversal, nothing else
  let rejected = false;
  try {
    post([
      { acct: 'cash', debit: 0, credit: 400 },
      { acct: 'customer', debit: 0, credit: 600 },
      { acct: 'customer', debit: 0, credit: 600 },
      { acct: 'income', debit: 1000, credit: 0 },
    ]);
  } catch { rejected = true; }
  check('double-entry DOES catch an unbalanced double reversal', rejected);

  // (b) the same fault, balanced against income — what a developer fixing a
  //     "transaction does not balance" error would plausibly write
  const p2 = [];
  const post2 = lines => {
    const sum = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(sum) > 0.005) throw new Error('unbalanced');
    p2.push(...lines);
  };
  const acct2 = a => r2(p2.filter(l => l.acct === a).reduce((s, l) => s + l.debit - l.credit, 0));
  post2([
    { acct: 'cash', debit: 400, credit: 0 },
    { acct: 'customer', debit: 600, credit: 0 },
    { acct: 'income', debit: 0, credit: 1000 },
  ]);
  let accepted = false;
  try {
    post2([
      { acct: 'cash', debit: 0, credit: 400 },
      { acct: 'customer', debit: 0, credit: 1200 },
      { acct: 'income', debit: 1600, credit: 0 },
    ]);
    accepted = true;
  } catch { /* still rejected */ }
  check('double-entry does NOT catch the same fault once it is balanced',
    accepted && Math.abs(acct2('customer') - -600) < 0.005,
    `customer ended at ${acct2('customer')}`);
  console.log(`        balanced double reversal accepted; customer left at ${acct2('customer')}`);

  // (c) conservation, over the same operation
  const opening = 100000;
  let cash = 100000, customer = 0;
  cash += 400; customer += 600;              // deliver
  cash -= 400; customer -= 600; customer -= 600;  // delete, with the fault
  const moved = r2((cash + customer) - (opening + 1000 - 1000));
  check('conservation DOES catch it, balanced or not',
    Math.abs(moved) > 0.011,
    'conservation missed a fault double-entry also missed');
  console.log(`        conservation saw net worth move by ${moved} on a neutral operation`);
}

// ------------------------------------------------------------------ 2
console.log('\n[2] MEASURED: a savepoint can undo a handler\'s own transaction');
if (Database) {
  // The handlers all use db.transaction(...). Transactions cannot nest, so the
  // guard must use SAVEPOINT. This proves ROLLBACK TO really does undo work a
  // handler already committed inside its own transaction.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE acct(id INTEGER PRIMARY KEY, bal REAL)');
  db.exec('INSERT INTO acct VALUES(1, 1000)');
  const bal = () => db.prepare('SELECT bal v FROM acct WHERE id=1').get().v;

  const faultyHandler = db.transaction(() => {
    db.prepare('UPDATE acct SET bal = bal - 600 WHERE id=1').run();
    db.prepare('UPDATE acct SET bal = bal - 600 WHERE id=1').run();
  });

  db.exec('SAVEPOINT g');
  faultyHandler();
  const during = bal();
  db.exec('ROLLBACK TO g');
  db.exec('RELEASE g');

  check('the handler\'s committed transaction is visible inside the savepoint',
    during === -200, `saw ${during}`);
  check('rolling back the savepoint restores the data exactly',
    bal() === 1000, `left at ${bal()}`);
  db.close();
} else {
  console.log('  SKIP  (better-sqlite3 unavailable)');
}

// ------------------------------------------------------------------ 3
console.log('\n[3] The guard\'s rules fire on real broken books');
if (Database) {
  const { checkBooks, netWorth, isGuardedChannel } =
    await import('../src/main/security/bookGuard.ts');

  const fresh = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings(Key TEXT PRIMARY KEY, Value TEXT);
      CREATE TABLE cash_accounts(CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL);
      CREATE TABLE payment_methods(PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL);
      CREATE TABLE customers(CustomerID INTEGER PRIMARY KEY, Balance REAL);
      CREATE TABLE suppliers(SupplierID INTEGER PRIMARY KEY, Balance REAL);
      CREATE TABLE stock_quantities(ItemID INTEGER, WarehouseID INTEGER, Quantity REAL, CostPrice REAL);
      INSERT INTO cash_accounts VALUES(1,'Safe',1000);
      INSERT INTO customers VALUES(1,0);
      INSERT INTO stock_quantities VALUES(1,1,10,50);
    `);
    return db;
  };

  let db = fresh();
  check('healthy books pass', checkBooks(db, 'sales:create', netWorth(db)).ok);

  db = fresh();
  db.exec('UPDATE cash_accounts SET Balance = -5 WHERE CashAccountID=1');
  check('a negative cash drawer is refused',
    !checkBooks(db, 'sales:create', null).ok);

  db = fresh();
  db.exec('UPDATE stock_quantities SET Quantity = -3');
  check('negative stock is refused when not permitted',
    !checkBooks(db, 'sales:create', null).ok);

  db = fresh();
  db.exec("INSERT INTO settings VALUES('allow_negative_stock','1')");
  db.exec('UPDATE stock_quantities SET Quantity = -3');
  check('...but allowed when the shop switched that on',
    checkBooks(db, 'sales:create', null).ok,
    'the guard must not override a setting the owner chose');

  db = fresh();
  db.exec('UPDATE stock_quantities SET CostPrice = -1');
  check('a negative unit cost is refused',
    !checkBooks(db, 'purchases:create', null).ok);

  // The headline case: the exact fault from delete:maintenanceDelivery.
  db = fresh();
  db.exec('UPDATE customers SET Balance = 600 WHERE CustomerID=1');
  const before = netWorth(db);
  db.exec('UPDATE customers SET Balance = Balance - 1200 WHERE CustomerID=1');
  const verdict = checkBooks(db, 'delete:maintenanceDelivery', before);
  check('a delete that moves net worth is refused',
    !verdict.ok && verdict.breach?.rule === 'worthMovedWithoutReason',
    JSON.stringify(verdict));
  check('and the refusal is explained in Arabic',
    /[\u0600-\u06FF]/.test(verdict.breach?.detail ?? ''));

  // A sale SHOULD change net worth. The guard must not fight normal trade.
  db = fresh();
  const b2 = netWorth(db);
  db.exec('UPDATE cash_accounts SET Balance = Balance + 500');
  check('a sale that legitimately earns profit is NOT refused',
    checkBooks(db, 'sales:create', b2).ok,
    'the guard must never block ordinary trading');

  // Rounding dust must not stop the shop working.
  db = fresh();
  const b3 = netWorth(db);
  db.exec('UPDATE customers SET Balance = Balance + 0.004');
  check('a fraction of a piastre does not trigger a refusal',
    checkBooks(db, 'delete:sale', b3).ok);

  check('read-only channels are not wrapped at all',
    !isGuardedChannel('sales:list') && !isGuardedChannel('maintenance:get')
    && !isGuardedChannel('reports:profitLoss'));
  check('money-moving channels are wrapped',
    isGuardedChannel('sales:create') && isGuardedChannel('delete:maintenanceDelivery')
    && isGuardedChannel('vouchers:create') && isGuardedChannel('maintenance:deliver'));
  check('a NEW handler under a guarded prefix is covered automatically',
    isGuardedChannel('sales:somethingInventedTomorrow'),
    'coverage must not depend on remembering to add to a list');
  db.close();
} else {
  console.log('  SKIP  (better-sqlite3 unavailable)');
}

// ------------------------------------------------------------------ 4
console.log('\n[4] The guard is actually installed in the real IPC path');
{
  const g = code('src/main/security/ipcGuard.ts');
  check('ipcGuard imports the book guard', /from '\.\/bookGuard'/.test(g));
  check('guarded channels are routed through runGuarded',
    /runGuarded\(channel/.test(g));
  check('unguarded channels still run untouched',
    /if \(!isGuardedChannel\(channel\)\)[\s\S]{0,80}return listener/.test(g));
  const bg = code('src/main/security/bookGuard.ts');
  check('the guard rolls back rather than reporting after the fact',
    /ROLLBACK TO/.test(g), 'detecting a fault without undoing it still corrupts the books');
  check('a refusal is a structured failure the UI already understands',
    /success: false/.test(g) && /BOOKS_INVARIANT/.test(g));
  check('the guard never blocks work when the database is unavailable',
    /catch \{[\s\S]{0,120}return run\(\);/.test(g));
  check('conservation is only demanded of value-neutral operations',
    /VALUE_NEUTRAL/.test(bg),
    'demanding it of a sale would block every profitable trade');
}

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(74));
process.exit(FAIL.length ? 1 : 0);
