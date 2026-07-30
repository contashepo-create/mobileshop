#!/usr/bin/env node
/**
 * MONEY TRANSFERS AND DELETION GUARDS
 *
 * WHY THIS EXISTS
 * ---------------
 * Two things in this system are unusually easy to get wrong, and both were.
 *
 * A TRANSFER moves money between the shop's own accounts. It must be perfectly
 * neutral — the total the shop holds cannot change just because cash was
 * carried from the till to the bank. Anything that breaks that neutrality
 * invents or destroys money without a trace, because there is no customer or
 * supplier on the other side to notice.
 *
 * A DELETION removes a record that other records may depend on. The dangerous
 * case is not the missing row; it is the row that SURVIVES and now makes no
 * sense — a salary reduced by a deduction whose record has been erased, so the
 * employee is permanently short and nothing on file explains why.
 *
 * MEASURED BEFORE THE FIXES IN THIS ROUND
 * ---------------------------------------
 *   transfers:create with Amount -5000  -> accepted, and ran BACKWARDS: the
 *                                          source gained 5,000 and the
 *                                          destination lost it, while the
 *                                          document still read as a normal
 *                                          transfer in the stated direction
 *   transfers:create from an account to ITSELF -> accepted
 *   delete:deduction on a deduction already taken out of a salary
 *                                       -> deleted cleanly, leaving NetSalary
 *                                          at 2,800 with nothing to explain
 *                                          the missing 200
 *
 * Run with:  node --experimental-strip-types scripts/verify_transfers_deletes.mjs
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const q = (sql, ...a) => currentDb().prepare(sql).get(...a);
const near = (a, b) => Math.abs(r2(a) - r2(b)) < 0.011;

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',100000,1)");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(2,'Bank','bank',50000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'Wallet','wallet',30000,1)");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(1,'Tech',3000,0,0,1)");
  return db;
}

const safe = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v;
const bank = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=2').v;
const wallet = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID=1').v;
const liquid = () => r2(safe() + bank() + wallet());

const transfer = o => call('transfers:create', {
  FromType: 'cash_account', FromID: 1, ToType: 'cash_account', ToID: 2,
  Amount: 5000, TransferCost: 0, TransferCostSource: 'separate',
  Notes: '', Date: '2026-07-30', fiscalYearId: 1, userId: 1, ...o,
});

console.log('MONEY TRANSFERS AND DELETION GUARDS\n');

// ---------------------------------------------------------------- 1
console.log('[1] Carrying money between the shop\'s own accounts changes nothing');
{
  seed();
  const before = liquid();
  const res = await transfer({});
  t('the transfer is accepted', res?.success === true, JSON.stringify(res).slice(0, 60));
  t('the source falls by exactly the amount', near(safe(), 95000), `safe ${safe()}`);
  t('the destination rises by exactly the amount', near(bank(), 55000), `bank ${bank()}`);
  t('and the shop holds precisely what it held before',
    near(liquid(), before), `${before} -> ${liquid()}`);
}
{
  seed();
  const before = liquid();
  await transfer({ ToType: 'payment_method', ToID: 1, Amount: 2000 });
  t('a transfer into a wallet is neutral too',
    near(liquid(), before) && near(wallet(), 32000), `wallet ${wallet()}, total ${liquid()}`);
}
{
  // A fee is a REAL cost: the shop is genuinely poorer by the commission, so
  // total funds fall by exactly the fee and by nothing else.
  seed();
  const before = liquid();
  await transfer({ Amount: 5000, TransferCost: 50 });
  t('a transfer fee reduces total funds by the fee alone',
    near(before - liquid(), 50), `${before} -> ${liquid()}, fee 50`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A transfer cannot run backwards or go nowhere');
{
  seed();
  const before = [safe(), bank()];
  const res = await transfer({ Amount: -5000 });
  t('a negative amount is refused',
    res?.success === false && near(safe(), before[0]) && near(bank(), before[1]),
    `safe ${safe()}, bank ${bank()} — it used to ADD 5,000 to the source`);
}
{
  seed();
  const res = await transfer({ Amount: 0 });
  t('a zero transfer is refused — it is not a movement', res?.success === false,
    JSON.stringify(res).slice(0, 65));
}
{
  seed();
  const res = await transfer({ FromID: 1, ToID: 1 });
  t('transferring an account to ITSELF is refused', res?.success === false,
    JSON.stringify(res).slice(0, 65));
}
{
  seed();
  const res = await transfer({ TransferCost: -100 });
  t('a negative fee is refused', res?.success === false, JSON.stringify(res).slice(0, 65));
}
{
  seed();
  const res = await transfer({ Amount: 999999 });
  t('a transfer larger than the source holds is refused',
    res?.success === false && safe() >= 0, `safe ${safe()}`);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Cancelling a transfer restores both sides exactly');
{
  seed();
  const before = [safe(), bank()];
  await transfer({});
  const tid = q('SELECT TransferID v FROM asset_transfers ORDER BY TransferID DESC')?.v;
  const res = await call('delete:transfer', tid);
  t('the deletion succeeds', res?.success === true, JSON.stringify(res).slice(0, 60));
  t('both accounts return to their opening figures',
    near(safe(), before[0]) && near(bank(), before[1]),
    `${JSON.stringify(before)} -> ${JSON.stringify([safe(), bank()])}`);
}
{
  seed();
  const before = liquid();
  await transfer({ Amount: 3000, TransferCost: 25 });
  const tid = q('SELECT TransferID v FROM asset_transfers ORDER BY TransferID DESC')?.v;
  await call('delete:transfer', tid);
  t('cancelling also gives back the fee', near(liquid(), before),
    `${before} -> ${liquid()}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A record another record depends on cannot just vanish');
{
  // The damage is not the missing row — it is the salary that survives and
  // now makes no sense.
  seed();
  await call('deductions:create', {
    EmployeeID: 1, Amount: 200, Reason: 'absence', Date: '2026-07-30',
    fiscalYearId: 1, userId: 1,
  });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const net = q('SELECT NetSalary v FROM salaries').v;
  const did = q('SELECT DeductionID v FROM employee_deductions').v;
  const res = await call('delete:deduction', did);

  t('the salary really was reduced by the deduction', near(net, 2800), `net ${net}`);
  t('deleting that deduction afterwards is refused',
    res?.success === false && !!q('SELECT 1 v FROM employee_deductions WHERE DeductionID=?', did),
    `the employee would be 200 short with nothing on file to explain it — ${JSON.stringify(res).slice(0, 55)}`);
}
{
  // The guard must not over-reach: a deduction not yet applied is just a note.
  seed();
  await call('deductions:create', {
    EmployeeID: 1, Amount: 150, Reason: 'absence', Date: '2026-07-30',
    fiscalYearId: 1, userId: 1,
  });
  const did = q('SELECT DeductionID v FROM employee_deductions').v;
  const res = await call('delete:deduction', did);
  t('but a deduction NOT yet applied can still be removed',
    res?.success === true && !q('SELECT 1 v FROM employee_deductions WHERE DeductionID=?', did),
    JSON.stringify(res).slice(0, 60));
}
{
  seed();
  const res = await call('delete:deduction', 9999);
  t('deleting a deduction that does not exist is refused, not silently ignored',
    res?.success === false, JSON.stringify(res).slice(0, 60));
}
{
  // Same rule, already fixed earlier, pinned here so both halves of the pair
  // are protected by one suite.
  seed();
  await call('advances:create', {
    EmployeeID: 1, Amount: 500, Reason: 'r', Date: '2026-07-30',
    CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
  await call('salaries:issue', { EmployeeID: 1, Month: '2026-07', fiscalYearId: 1, userId: 1 });
  const aid = q('SELECT AdvanceID v FROM employee_advances').v;
  const res = await call('delete:advance', aid);
  t('an advance already recovered from a salary is protected the same way',
    res?.success === false, JSON.stringify(res).slice(0, 60));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
