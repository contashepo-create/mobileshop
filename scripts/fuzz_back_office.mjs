#!/usr/bin/env node
/**
 * BACK-OFFICE FUZZER — random sequences, checked against universal truths.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every hand-written test in this project can only cover a situation somebody
 * imagined. That limit is not theoretical: each review of this codebase found
 * a new fault precisely because each reviewer imagined something different.
 *
 * The trading fuzzer solved that for sales and purchases. The back office —
 * vouchers, payroll, services, settlements, rent — had no equivalent, so the
 * only combinations ever exercised were the ones written out by hand in
 * `verify_back_office.mjs`.
 *
 * This throws random VALID sequences of back-office operations at the real
 * handlers and, after every single step, asserts a small set of things that
 * must be true no matter what happened before. A violation is a bug whether or
 * not anyone thought of that ordering.
 *
 * WHAT IT ASSERTS AFTER EVERY OPERATION
 * -------------------------------------
 *   - no cash box or wallet holds less than nothing (a customer balance may
 *     legitimately be negative; physical money may not);
 *   - no stock line is negative or valued at a negative cost;
 *   - no money anywhere is NaN or Infinity;
 *   - a customer's statement still foots to that customer's ledger balance,
 *     and the same for suppliers — the cross-view check that found the
 *     supplier-statement fault, now run continuously;
 *   - every document's own arithmetic still holds (paid + remaining = total).
 *
 * Deterministic: the same seed always produces the same sequence, so a failure
 * can be replayed exactly.
 *
 * Run with:  node --experimental-strip-types scripts/fuzz_back_office.mjs [ops] [seed]
 */
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

const OPS = Number(process.argv[2]) || 150;
const SEED = Number(process.argv[3]) || 1;

/** xorshift32 — small, fast, and reproducible across runs. */
let state = SEED >>> 0 || 1;
function rnd() {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function seedDb() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(2,'Second')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'Safe','safe',500000,1)");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(2,'Bank','bank',500000,1)");
  db.exec("INSERT INTO payment_methods(PaymentMethodID,MethodName,MethodType,Balance,IsActive) VALUES(1,'W','digital_wallet',200000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(2,'B',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S1',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(2,'S2',0,'active')");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(1,'E1',3000,500,0,1)");
  db.exec("INSERT INTO employees(EmployeeID,Name,BaseSalary,Allowances,Balance,IsActive) VALUES(2,'E2',2000,0,0,1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'P1','accessory',0,100,200,1)");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(2,'P2','accessory',0,50,120,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,500,100)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,500,50)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,2,200,100)");
  return db;
}

const db = seedDb();
const one = (sql, ...a) => currentDb().prepare(sql).get(...a);
const many = (sql, ...a) => currentDb().prepare(sql).all(...a);
/** Deterministic row choice: ORDER BY is always explicit so replay is exact. */
const pickRow = sql => { const rows = many(sql); return rows.length ? rows[Math.floor(rnd() * rows.length)] : null; };

// ---------------------------------------------------------------- operations
async function opVoucher() {
  const type = pick(['receipt', 'payment']);
  const party = pick([null, 'customer', 'supplier', 'employee']);
  const useWallet = rnd() < 0.3;
  await call('vouchers:create', {
    VoucherType: type, Amount: between(10, 400), Date: '2026-07-30',
    PartyType: party,
    PartyID: party === 'customer' ? pick([1, 2]) : party ? 1 : null,
    PartyName: party ?? '', Description: 'fuzz',
    CashAccountID: pick([1, 2]),
    PaymentMethodID: useWallet ? 1 : undefined,
    fiscalYearId: 1, userId: 1,
  });
}
async function opDeleteVoucher() {
  const v = pickRow('SELECT VoucherID FROM vouchers ORDER BY VoucherID');
  if (v) await call('delete:voucher', v.VoucherID);
}
async function opService() {
  const amount = between(50, 2000);
  const paid = rnd() < 0.7 ? r2(amount + between(5, 30)) : 0;
  await call('serviceSales:create', {
    ServiceType: 'balance_transfer', Provider: 'vodafone', TargetPhone: '0100',
    CustomerID: pick([1, 2]), CustomerName: 'A', CustomerPhone: '0100',
    PaymentMethod: paid ? 'cash' : 'credit', Notes: '', PaidToProvider: amount,
    ChargeAmount: r2(amount + between(5, 30)), Date: '2026-07-30',
    PaidAmount: paid,
    CashAccountID: 1, PaymentMethodID: rnd() < 0.4 ? 1 : undefined,
    ReceiveAccountType: paid ? 'cash_account' : undefined,
    ReceiveAccountID: paid ? 1 : undefined,
    fiscalYearId: 1, userId: 1,
  });
}
async function opDeleteService() {
  const s = pickRow('SELECT ServiceSaleID FROM service_sales ORDER BY ServiceSaleID');
  if (s) await call('delete:serviceSale', s.ServiceSaleID);
}
async function opAdvance() {
  await call('advances:create', {
    EmployeeID: pick([1, 2]), Amount: between(50, 800), Reason: 'fuzz',
    Date: '2026-07-30', CashAccountID: pick([1, 2]), fiscalYearId: 1, userId: 1,
  });
}
async function opDeleteAdvance() {
  const a = pickRow('SELECT AdvanceID FROM employee_advances ORDER BY AdvanceID');
  if (a) await call('delete:advance', a.AdvanceID);
}
async function opDeduction() {
  await call('deductions:create', {
    EmployeeID: pick([1, 2]), Amount: between(10, 300), Reason: 'absence',
    Date: '2026-07-30', fiscalYearId: 1, userId: 1,
  });
}
async function opSalaryIssue() {
  await call('salaries:issue', {
    EmployeeID: pick([1, 2]), Month: pick(['2026-05', '2026-06', '2026-07']),
    fiscalYearId: 1, userId: 1,
  });
}
async function opSalaryPay() {
  const s = pickRow("SELECT SalaryID, NetSalary FROM salaries WHERE Status != 'paid' ORDER BY SalaryID");
  if (s) {
    await call('salaries:pay', {
      SalaryID: s.SalaryID,
      PaidAmount: rnd() < 0.7 ? s.NetSalary : r2(s.NetSalary / 2),
      CashAccountID: pick([1, 2]), userId: 1,
    });
  }
}
async function opSettleCash() {
  const acc = pickRow('SELECT CashAccountID, Balance FROM cash_accounts ORDER BY CashAccountID');
  if (!acc) return;
  // Counted figures stay non-negative; the point is the variance, not abuse.
  const actual = Math.max(0, r2(acc.Balance + between(-200, 200)));
  await call('settlements:apply', {
    section: 'cash',
    items: [{
      ItemID: acc.CashAccountID, ItemName: 'acc', RecordedBalance: acc.Balance,
      ActualBalance: actual, Difference: r2(actual - acc.Balance),
      AdjustmentType: actual > acc.Balance ? 'increase' : 'decrease',
    }],
    userId: 1, fiscalYearId: 1,
  });
}
async function opSettleStock() {
  const it = pickRow('SELECT ItemID, SUM(Quantity) tot FROM stock_quantities GROUP BY ItemID ORDER BY ItemID');
  if (!it) return;
  const actual = Math.max(0, Math.round(it.tot + between(-5, 5)));
  await call('settlements:apply', {
    section: 'inventory',
    items: [{
      ItemID: it.ItemID, ItemName: 'it', RecordedBalance: it.tot,
      ActualBalance: actual, Difference: r2(actual - it.tot),
      AdjustmentType: actual > it.tot ? 'increase' : 'decrease',
    }],
    userId: 1, fiscalYearId: 1,
  });
}
async function opSell() {
  await call('sales:create', {
    CustomerID: pick([1, 2]),
    items: [{ ItemID: pick([1, 2]), Quantity: Math.max(1, Math.round(between(1, 4))), UnitPrice: between(80, 250) }],
    Discount: 0, TaxRate: 0, TaxAmount: 0,
    PaidAmount: rnd() < 0.5 ? 0 : between(10, 300),
    PaymentMethod: 'cash', CashAccountID: 1, fiscalYearId: 1, userId: 1,
  });
}
async function opBuy() {
  const paid = rnd() < 0.5 ? 0 : between(10, 400);
  await call('purchases:create', {
    SupplierID: pick([1, 2]),
    items: [{ ItemID: pick([1, 2]), Quantity: Math.max(1, Math.round(between(1, 6))), UnitCost: between(40, 120), WarehouseID: pick([1, 2]) }],
    Discount: 0, TaxAmount: 0, PaidAmount: paid,
    PaymentSourceType: paid > 0 ? 'cash_account' : undefined,
    PaymentSourceID: paid > 0 ? 1 : undefined,
    fiscalYearId: 1, userId: 1,
  });
}

const OPERATIONS = [
  ['voucher', opVoucher], ['deleteVoucher', opDeleteVoucher],
  ['service', opService], ['deleteService', opDeleteService],
  ['advance', opAdvance], ['deleteAdvance', opDeleteAdvance],
  ['deduction', opDeduction],
  ['salaryIssue', opSalaryIssue], ['salaryPay', opSalaryPay],
  ['settleCash', opSettleCash], ['settleStock', opSettleStock],
  ['sell', opSell], ['buy', opBuy],
];

// ---------------------------------------------------------------- invariants
/**
 * Everything the shop is worth, as one number.
 *
 * Needed because the shape checks below cannot see invented money: a voucher
 * that credits the same 300 to both a cash box and a wallet leaves every
 * balance positive, every document consistent and every statement agreeing —
 * it just makes the shop richer than it is.
 *
 * That was not hypothetical. The first version of this fuzzer had no
 * conservation check, and when the double-credit fault was deliberately
 * re-injected it went UNDETECTED across eight seeds. A fuzzer that cannot fail
 * is not evidence, so this was added and the re-injection then failed
 * immediately.
 */
function netWorth() {
  const g = sql => Number(one(sql)?.v) || 0;
  return r2(
    g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers')
    - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers')
    // An advance is not an expense, it is a RECEIVABLE: the cash left the
    // drawer but the employee owes it back, so the shop is no poorer. Leaving
    // it out made every advance look like value vanishing.
    + g('SELECT COALESCE(SUM(Amount),0) v FROM employee_advances WHERE IsDeducted = 0')
    // What the shop owes its staff, taken from the column the handlers
    // actually maintain rather than re-derived from the salary rows.
    //
    // Deriving it as `NetSalary - PaidAmount` looked equivalent and was not:
    // `salaries:issue` credits `employees.Balance` and `salaries:pay` debits
    // it, so that column is the liability. Re-computing it from a different
    // source meant the model and the application disagreed whenever the two
    // drifted, which showed up as a phantom breach on `salaryPay`.
    - g('SELECT COALESCE(SUM(Balance),0) v FROM employees'),
  );
}

/**
 * What the shop's worth SHOULD be, given everything recorded so far.
 *
 * Opening position, plus every gain the books claim, minus every loss. Any
 * drift between this and `netWorth()` is money that appeared or vanished
 * without a document to explain it.
 */
function expectedWorth(opening) {
  const g = sql => Number(one(sql)?.v) || 0;
  // Salaries and advances interlock, and getting this wrong produced two false
  // alarms before it was measured rather than assumed:
  //
  //   - `salaries:issue` DEDUCTS any outstanding advance from the net salary
  //     and marks it deducted. The advance stops being a receivable at that
  //     moment and becomes a reduction of the wage bill instead, so counting
  //     the gross salary as the cost double-counts it.
  //   - a voucher against a customer or supplier is a SETTLEMENT, not income:
  //     cash rises and the receivable falls by the same amount. Only vouchers
  //     with no party are real income or expense. The model already had this
  //     right, but a deleted voucher briefly looked like drift until the
  //     deletion was measured and shown to be exactly neutral.
  // Taken from the SALARY rows, not from `employee_advances`. When a month's
  // pay can absorb only part of an advance the handler REDUCES that advance's
  // Amount and leaves the rest outstanding, so the settled rows no longer add
  // up to what was actually recovered. `AdvancesTotal` on the salary is the
  // figure that was really applied.
  const advancesDeducted = g('SELECT COALESCE(SUM(AdvancesTotal),0) v FROM salaries');
  return r2(
    opening
    // Wages actually incurred: the gross recorded on each salary PLUS the
    // advances that were netted off it, because those left the drawer earlier
    // and are no longer carried as a receivable.
    - advancesDeducted
    // Trading margin: what was sold for, less what it cost.
    + g('SELECT COALESCE(SUM(sd.Quantity*(sd.UnitPrice-COALESCE(sd.UnitCost,0))),0) v FROM sale_details sd JOIN sales s ON s.SaleID=sd.SaleID WHERE s.IsVoided=0')
    - g("SELECT COALESCE(SUM(srd.Quantity*(srd.UnitPrice-COALESCE(srd.UnitCost,0))),0) v FROM sale_return_details srd")
    // Services earn their margin.
    + g('SELECT COALESCE(SUM(Profit),0) v FROM service_sales')
    // Vouchers with no party are real income or real expense.
    + g("SELECT COALESCE(SUM(Amount),0) v FROM vouchers WHERE VoucherType='receipt' AND (PartyType IS NULL OR PartyType='general')")
    - g("SELECT COALESCE(SUM(Amount),0) v FROM vouchers WHERE VoucherType='payment' AND (PartyType IS NULL OR PartyType='general')")
    // Wages are a cost when they are EARNED, not when they are handed over:
    // `netWorth` already carries the unpaid part as a liability, so counting
    // the whole gross here keeps the two sides consistent whether or not the
    // salary has been paid yet.
    // NetSalary is ALREADY net of deductions and advances — `salaries:issue`
    // subtracts both when it computes the figure. Adding the deductions back
    // as a separate saving double-counted them, which showed up as a phantom
    // drift the moment a deduction existed.
    - g('SELECT COALESCE(SUM(NetSalary),0) v FROM salaries')
    // Freight and valuation write-offs are recorded losses.
    - g('SELECT COALESCE(SUM(Amount),0) v FROM inventory_adjustments'),
  );
}

async function checkInvariants(opening) {
  const bad = [];

  // Conservation. Checked FIRST because it is the only invariant here that can
  // see value being created out of nothing.
  const drift = r2(netWorth() - expectedWorth(opening));
  if (Math.abs(drift) > 1.0) {
    bad.push(`net worth drifted by ${drift} with no document explaining it `
      + `(actual ${netWorth()}, accounted ${expectedWorth(opening)})`);
  }

  const negCash = one('SELECT COUNT(*) v FROM cash_accounts WHERE Balance < -0.011').v;
  if (negCash) bad.push(`a cash account holds less than nothing (${negCash} rows)`);

  const negWallet = one('SELECT COUNT(*) v FROM payment_methods WHERE Balance < -0.011').v;
  if (negWallet) bad.push(`a wallet holds less than nothing (${negWallet} rows)`);

  const negStock = one('SELECT COUNT(*) v FROM stock_quantities WHERE Quantity < -0.001').v;
  if (negStock) bad.push(`negative stock (${negStock} rows)`);

  const negCost = one('SELECT COUNT(*) v FROM stock_quantities WHERE CostPrice < -0.001').v;
  if (negCost) bad.push(`negative unit cost (${negCost} rows)`);

  for (const [table, col] of [
    ['cash_accounts', 'Balance'], ['payment_methods', 'Balance'],
    ['customers', 'Balance'], ['suppliers', 'Balance'], ['employees', 'Balance'],
    ['stock_quantities', 'Quantity'], ['stock_quantities', 'CostPrice'],
  ]) {
    for (const row of many(`SELECT ${col} v FROM ${table} WHERE ${col} IS NOT NULL`)) {
      if (!Number.isFinite(row.v)) { bad.push(`${table}.${col} is ${row.v}`); break; }
    }
  }

  // Document arithmetic: paid + remaining must equal the total. A sale can
  // additionally settle part of it from the customer's STANDING CREDIT — money
  // they had deposited earlier and are now spending down — so that portion is
  // its own column and counts toward the total exactly like a payment.
  for (const [table, total, paid, rem] of [
    ['sales', 'TotalAmount', 'PaidAmount', 'RemainingAmount'],
    ['purchases', 'TotalAmount', 'PaidAmount', 'RemainingAmount'],
    ['service_sales', 'ChargeAmount', 'PaidAmount', 'RemainingAmount'],
  ]) {
    const credit = table === 'sales' ? ' + COALESCE(CreditApplied,0)' : '';
    const n = one(
      `SELECT COUNT(*) v FROM ${table} WHERE ABS(COALESCE(${paid},0)${credit} + COALESCE(${rem},0) - COALESCE(${total},0)) > 0.011`,
    ).v;
    if (n) bad.push(`${table}: paid + remaining != total on ${n} rows`);
  }

  // Cross-view: a statement is a second derivation of the same documents, so
  // it must agree with the ledger it summarises. This is the check that caught
  // the supplier-statement fault; here it runs after every operation.
  for (const c of many('SELECT CustomerID FROM customers ORDER BY CustomerID')) {
    const st = await call('customerStatement:get', c.CustomerID, {});
    if (st?.success) {
      const led = one('SELECT Balance v FROM customers WHERE CustomerID=?', c.CustomerID).v;
      if (Math.abs(r2(st.totals.netBalance) - r2(led)) > 0.011) {
        bad.push(`customer ${c.CustomerID}: statement ${r2(st.totals.netBalance)} vs ledger ${r2(led)}`);
      }
    }
  }
  for (const s of many('SELECT SupplierID FROM suppliers ORDER BY SupplierID')) {
    const st = await call('supplierStatement:get', s.SupplierID, {});
    if (st?.success) {
      const led = one('SELECT Balance v FROM suppliers WHERE SupplierID=?', s.SupplierID).v;
      if (Math.abs(r2(st.totals.netBalance) - r2(led)) > 0.011) {
        bad.push(`supplier ${s.SupplierID}: statement ${r2(st.totals.netBalance)} vs ledger ${r2(led)}`);
      }
    }
  }

  return bad;
}

// ---------------------------------------------------------------- run
console.log(`BACK-OFFICE FUZZ — ${OPS} operations, seed ${SEED}\n`);
const OPENING = netWorth();
let breached = null;
for (let step = 1; step <= OPS; step++) {
  const [name, fn] = pick(OPERATIONS);
  try {
    await fn();
  } catch (err) {
    breached = { step, name, msgs: [`the handler threw: ${err.message}`] };
    break;
  }
  const bad = await checkInvariants(OPENING);
  if (bad.length) { breached = { step, name, msgs: bad }; break; }
}

// On failure, dump the payroll state: these tables interlock (an advance is
// settled against a salary, which nets deductions) and the numbers alone are
// rarely enough to tell which side is wrong.
if (breached) {
  for (const [label, sql] of [
    ['salaries', 'SELECT SalaryID,EmployeeID,NetSalary,PaidAmount,Status,AdvancesTotal,DeductionsTotal FROM salaries'],
    ['advances', 'SELECT AdvanceID,Amount,IsDeducted,DeductedFromSalaryID FROM employee_advances'],
    ['deductions', 'SELECT DeductionID,Amount,IsDeducted FROM employee_deductions'],
  ]) {
    const rows = many(sql);
    if (rows.length) {
      console.log(`--- ${label} ---`);
      for (const r of rows) console.log('   ', JSON.stringify(r));
    }
  }
}
if (breached) {
  console.log(`INVARIANT BREACH at step ${breached.step}: ${breached.name}`);
  for (const m of breached.msgs) console.log(`  - ${m}`);
  console.log(`\nreplay: node --experimental-strip-types scripts/fuzz_back_office.mjs ${OPS} ${SEED}`);
  process.exit(1);
}

console.log(`OK — all ${OPS} operations preserved every invariant (seed ${SEED})`);
process.exit(0);
