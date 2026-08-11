#!/usr/bin/env node
// SECTION 5 — PAYROLL: the whole employee-money lifecycle through the REAL
// handlers on the REAL production stack (better-sqlite3 file DB, real
// connection.ts, real migrations). Runs against the exact channel names the
// renderer uses.
//
// Covers employees:create/update/delete/list/get + the validation refusals,
// advances:create/delete with their cash movement and guards,
// deductions:create/delete with the reason whitelist and damage costing,
// salaries:issue's arithmetic (commissions/deductions/advances absorption,
// oldest-first partial settlement, the zero-net floor), salaries:pay's cash
// and balance movement (partial -> paid, double-pay and insufficient-cash
// refusals), the mid-month commission hole (issued AFTER the salary, settled
// by pay anyway), the check-then-act race window on both pay and advances,
// and the closing statement/report identity (employeeStatement, reports:employees,
// P&L salaries expense, balance sheet employees/advances, assets = liabilities
// + equity).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');

const SELF = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SELF, '..');

const PASS = [];
const FAIL = [];
const t = (name, cond, detail = '') => {
  (cond ? PASS : FAIL).push(name);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n          ${detail}`}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.__FOUND_DIALOGS__ = { save: [], open: [] };

const electronStub = `
  const registry = (globalThis.__FOUND_HANDLERS__ ||= new Map());
  module.exports = {
    ipcMain: { handle: (c, f) => registry.set(c, f), removeHandler: (c) => registry.delete(c) },
    app: {
      getPath: (k) => { const p = globalThis.__FOUND_PATHS__;
        if (k === 'userData') return p.userData; if (k === 'temp') return p.temp;
        if (k === 'exe') return p.exe; return p.userData; },
      getVersion: () => '1.0.51', getName: () => 'mobile-shop-erp',
      getAppPath: () => globalThis.__FOUND_PATHS__.appPath,
      get isPackaged() { return !!globalThis.__FOUND_PACKAGED__; },
      quit: () => {}, whenReady: async () => {}, on: () => {},
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 1 }), showErrorBox: () => {},
    },
    shell: {}, contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => undefined, on() {} },
    webContents: { getAllWebContents: () => [] },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    Notification: class {},
  };
`;

const ENTRY = `
  export { runMigrations } from './src/main/database/migrations/index.ts';
  export { getDb, getDbPath } from './src/main/database/connection.ts';
  export { registerHrHandlers } from './src/main/ipc/hr.handlers.ts';
  export { registerPayrollHandlers } from './src/main/ipc/payroll.handlers.ts';
  export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
  export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_payroll_entry.ts');
writeFileSync(entryFile, ENTRY);

const paths = {
  userData: mkdtempSync(join(tmpdir(), 'pay-user-')),
  temp: mkdtempSync(join(tmpdir(), 'pay-tmp-')),
  exe: join(mkdtempSync(join(tmpdir(), 'pay-exe-')), 'MobileShopERP', 'app.exe'),
  appPath: mkdtempSync(join(tmpdir(), 'pay-app-')),
};
globalThis.__FOUND_PATHS__ = paths;
globalThis.__FOUND_PACKAGED__ = false;

console.log('Building the real payroll bundle…');
const out = await build({
  entryPoints: [entryFile],
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
  external: ['better-sqlite3', 'bcryptjs'],
  plugins: [{
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: electronStub, loader: 'js' }));
    },
  }],
});
const bundleFile = join(PROJECT_ROOT, '_payroll_bundle.cjs');
writeFileSync(bundleFile, out.outputFiles[0].text);
const mod = require(bundleFile);
rmSync(bundleFile, { force: true });
rmSync(entryFile, { force: true });

const call = (channel, ...args) => {
  const fn = globalThis.__FOUND_HANDLERS__.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return fn({ sender: { id: 1 } }, ...args);
};

try {
  // ------------------------------------------------------------ setup
  const db = mod.getDb();
  mod.runMigrations(db);
  mod.registerHrHandlers();
  mod.registerPayrollHandlers();
  mod.registerDeleteHandlers();
  mod.registerReportsHandlers();

  db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO cash_accounts (CashAccountID, AccountName, AccountType, Balance, IsActive)
      VALUES (2, 'خزينة معطلة', 'safe', 5000, 0);
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 5000, 1);
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'كابل', 'accessory', 0, 40, 65, 1);
    -- The seeded books open with cash 100000 + machine 5000, mirrored as owner
    -- capital so the balance sheet's own identity check is meaningful.
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '105000');
  `);

  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const mach = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const empBal = (id) => q('SELECT Balance v FROM employees WHERE EmployeeID = ?', id).v;
  const payId = (empid, month = '2026-08') =>
    q('SELECT SalaryID v FROM salaries WHERE EmployeeID = ? AND Month = ?', empid, month)?.v;
  const advRow = (empid, amount) =>
    q('SELECT * FROM employee_advances WHERE EmployeeID = ? AND Amount = ? ORDER BY AdvanceID DESC LIMIT 1', empid, amount);
  const dedRow = (empid, amount) =>
    q('SELECT * FROM employee_deductions WHERE EmployeeID = ? AND Amount = ? ORDER BY DeductionID DESC LIMIT 1', empid, amount);
  const fp = async () => await call('reports:financialPosition');
  // Full-month range, as the reports screens call it. P&L reads `filters`
// unguardedly on the rent and salary lines, so an argument is required.
  const pl = async () => await call('reports:profitLoss', { fromDate: '2026-08-01', toDate: '2026-08-31' });
  const balanced = (r) => Math.abs(r?.capital?.difference ?? 1) < 0.01;

  // A rival till landing in the gap between validation and the transaction:
  // `db.transaction` is hooked, which is the precise moment validation has
  // finished and the write lock has not been taken yet.
  const raceProbe = (sabotage) => {
    const realTx = db.transaction.bind(db);
    let fired = false;
    db.transaction = (fn) => {
      const wrapped = realTx(fn);
      return (...args) => {
        if (!fired) { fired = true; sabotage(); }
        return wrapped(...args);
      };
    };
  };
  const emptyDrawer = () => db.prepare('UPDATE cash_accounts SET Balance = 0 WHERE CashAccountID = 1').run();

  // A running cash ledger, asserted after every movement.
  let cashL = 100000;

  console.log('SECTION 5 — PAYROLL: the whole employee-money lifecycle on the real stack\n');

  // ---------------------------------------------------------------- 1
  console.log('[1] Employees — create, validate, update, deactivate');
  {
    const e = (p) => call('employees:create', p);
    const noName1 = await e({ Name: '', BaseSalary: 1000 });
    t('an empty name is refused', noName1?.success === false && noName1?.message === 'اسم الموظف مطلوب', noName1?.message ?? JSON.stringify(noName1));
    const noName2 = await e({ Name: '   ', BaseSalary: 1000 });
    t('a whitespace-only name is refused', noName2?.success === false && noName2?.message === 'اسم الموظف مطلوب', noName2?.message ?? JSON.stringify(noName2));
    const noName3 = await e({ Name: 'ح'.repeat(5_000_000), BaseSalary: 1000 });
    t('a five-million-character name is refused',
      noName3?.success === false && noName3?.message === 'اسم الموظف أطول من الحد المسموح (200 حرف)', noName3?.message ?? JSON.stringify(noName3));
    const negBase = await e({ Name: 'سارة', BaseSalary: -3000 });
    t('a negative salary is refused', negBase?.success === false && negBase?.message === 'الراتب الأساسي يجب أن يكون رقماً غير سالب', negBase?.message ?? JSON.stringify(negBase));
    const negAll = await e({ Name: 'سارة', BaseSalary: 3000, Allowances: -500 });
    t('negative allowances are refused', negAll?.success === false && negAll?.message === 'البدلات يجب أن يكون رقماً غير سالب', negAll?.message ?? JSON.stringify(negAll));
    const badDate = await e({ Name: 'سارة', BaseSalary: 3000, HireDate: 'not-a-date' });
    t('a non-date hire date is refused', badDate?.success === false, badDate?.message ?? JSON.stringify(badDate));
    const noName = await e({ BaseSalary: 1000 });
    t('a missing name is refused', noName?.success === false && noName?.message === 'اسم الموظف مطلوب', noName?.message ?? JSON.stringify(noName));
    // A missing salary defaults to zero — legitimate for a commission-only hire,
    // so this one CREATES. It is deactivated right away to keep the roster clean.
    const noSalary = await e({ Name: 'صفرية' });
    t('a missing salary defaults to zero (commission-only hire)',
      noSalary?.success === true && q('SELECT BaseSalary v FROM employees WHERE EmployeeID = ?', noSalary.id).v === 0, JSON.stringify(noSalary));
    await call('employees:delete', noSalary.id);

    const sara = await e({ Name: 'سارة أحمد', Phone: '0111', Position: 'بائعة', Department: 'مبيعات', BaseSalary: 3000, Allowances: 500, HireDate: '2026-01-10', Notes: 'نظيرة' });
    const khaled = await e({ Name: 'خالد محمود', Phone: '0112', Position: 'أمين مخزن', Department: 'مخزون', BaseSalary: 1000 });
    const layla = await e({ Name: 'ليلى حسن', Phone: '0113', Position: 'محاسبة', Department: 'مالية', BaseSalary: 500 });
    t('three employees are created', sara?.success === true && khaled?.success === true && layla?.success === true, JSON.stringify([sara, khaled, layla]));

    const EMP = { sara: sara.id, khaled: khaled.id, layla: layla.id };

    const got = await call('employees:get', EMP.sara);
    t('employees:get returns the record with the saved fields',
      got?.Name === 'سارة أحمد' && got?.BaseSalary === 3000 && got?.Allowances === 500 && got?.IsActive === 1, JSON.stringify(got));
    t('a new employee starts with zero balance', got?.Balance === 0, String(got?.Balance));
    const missing = await call('employees:get', 99999);
    t('employees:get on a missing id returns nothing', missing === undefined, JSON.stringify(missing));

    const list = await call('employees:list', { isActive: 1 });
    t('employees:list returns the three active rows (plus the seeded admin)', list?.length === 4, String(list?.length));
    const del = await call('employees:delete', EMP.layla);
    t('employees:delete deactivates rather than removes',
      del?.success === true && q('SELECT IsActive v FROM employees WHERE EmployeeID = ?', EMP.layla).v === 0, JSON.stringify(del));
    const listInactive = await call('employees:list', { isActive: 0 });
    t('employees:list isolates inactive rows', listInactive?.length === 2, String(listInactive?.length));

    const up = await call('employees:update', EMP.khaled, { Name: 'خالد محمود', Phone: '0112', Position: 'أمين مخزن', Department: 'مخزون', BaseSalary: 1200, Allowances: 0, HireDate: null });
    t('employees:update changes the salary', up?.success === true && q('SELECT BaseSalary v FROM employees WHERE EmployeeID = ?', EMP.khaled).v === 1200, up?.message ?? JSON.stringify(up));
    const upMissing = await call('employees:update', 99999, { Name: 'أ', BaseSalary: 1 });
    t('employees:update on a missing id is refused', upMissing?.success === false && upMissing?.message === 'الموظف غير موجود', upMissing?.message ?? JSON.stringify(upMissing));

    const gotLayla = await call('employees:get', EMP.layla);
    t('the deactivated record still exists', gotLayla?.IsActive === 0, JSON.stringify(gotLayla));
    const delMissing = await call('employees:delete', 99999);
    t('employees:delete on a missing id is refused', delMissing?.success === false && delMissing?.message === 'الموظف غير موجود', delMissing?.message ?? JSON.stringify(delMissing));
    const reactivate = await call('employees:update', EMP.layla, { Name: 'ليلى حسن', BaseSalary: 500, IsActive: 1 });
    t('a deactivated employee can be reactivated',
      reactivate?.success === true && q('SELECT IsActive v FROM employees WHERE EmployeeID = ?', EMP.layla).v === 1, reactivate?.message ?? JSON.stringify(reactivate));

    globalThis.__EMP__ = EMP;
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Advances — cash out, guards, and the deletion reversal');
  {
    const EMP = globalThis.__EMP__;
    const mk = (p) => call('advances:create', { userId: 1, fiscalYearId: 1, ...p });

    const a1 = await mk({ EmployeeID: EMP.sara, Amount: 2000, Reason: 'شراء قطع غيار', CashAccountID: 1 });
    t('an advance leaves the drawer', a1?.success === true && cash() === 98000, JSON.stringify(a1));
    cashL -= 2000;
    t('the advance is recorded undeducted',
      advRow(EMP.sara, 2000)?.IsDeducted === 0 && advRow(EMP.sara, 2000)?.CashAccountID === 1, 'row check');
    const advancesList = await call('advances:list', EMP.sara);
    t('advances:list joins the employee name', advancesList?.some(a => a.EmployeeID === EMP.sara && a.EmployeeName === 'سارة أحمد'), JSON.stringify(advancesList?.map(a => a.EmployeeName)));

    const neg = await mk({ EmployeeID: EMP.sara, Amount: -500, CashAccountID: 1 });
    t('a negative advance is refused', neg?.success === false && neg?.message === 'مبلغ السلفة يجب أن يكون رقماً غير سالب', neg?.message ?? JSON.stringify(neg));
    const zero = await mk({ EmployeeID: EMP.sara, Amount: 0, CashAccountID: 1 });
    t('a zero advance is refused', zero?.success === false && zero?.message === 'مبلغ السلفة يجب أن يكون أكبر من صفر', zero?.message ?? JSON.stringify(zero));
    const huge = await mk({ EmployeeID: EMP.sara, Amount: 1e12, CashAccountID: 1 });
    t('an absurd advance is refused',
      huge?.success === false && huge?.message === 'الرصيد غير كافٍ في الخزينة للسلفة: المتاح 98000.00، المطلوب 1000000000000.00',
      huge?.message ?? JSON.stringify(huge));
    const noEmp = await mk({ Amount: 500, CashAccountID: 1 });
    t('a missing employee is refused', noEmp?.success === false && noEmp?.message === 'الموظف غير صالح', noEmp?.message ?? JSON.stringify(noEmp));
    const badEmp = await mk({ EmployeeID: 99999, Amount: 500, CashAccountID: 1 });
    t('a non-existent employee is refused', badEmp?.success === false && badEmp?.message === 'الموظف غير موجود', badEmp?.message ?? JSON.stringify(badEmp));
    const noDrawer = await mk({ EmployeeID: EMP.sara, Amount: 500 });
    t('an advance without a drawer is refused',
      noDrawer?.success === false && noDrawer?.message === 'اختر الخزينة التي تخرج منها السلفة', noDrawer?.message ?? JSON.stringify(noDrawer));
    const badDrawer = await mk({ EmployeeID: EMP.sara, Amount: 500, CashAccountID: 9999 });
    t('a non-existent drawer is refused', badDrawer?.success === false && badDrawer?.message === 'الخزينة غير موجودة', badDrawer?.message ?? JSON.stringify(badDrawer));

    // The purchases flow refuses a DEACTIVATED drawer outright ("الخزنة المختارة
    // غير مفعّلة"). Payroll handing money through one is the same hole: the
    // drawer the screen hid can still be named by a stale form.
    const dead = await mk({ EmployeeID: EMP.sara, Amount: 500, CashAccountID: 2 });
    t('a DEACTIVATED drawer cannot pay out an advance',
      dead?.success === false && dead?.message === 'الخزنة المختارة غير مفعّلة', dead?.message ?? JSON.stringify(dead));
    t('the deactivated drawer kept its money', q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 2').v === 5000, String(q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 2').v));

    const dry = await mk({ EmployeeID: EMP.sara, Amount: 999999, CashAccountID: 1 });
    t('an advance beyond the drawer is refused',
      dry?.success === false && dry?.message === 'الرصيد غير كافٍ في الخزينة للسلفة: المتاح 98000.00، المطلوب 999999.00',
      dry?.message ?? JSON.stringify(dry));
    t('the refusals moved nothing', cash() === 98000, `${cash()} vs ${cashL}`);

    const a2a = await mk({ EmployeeID: EMP.khaled, Amount: 600, CashAccountID: 1 });
    const a2b = await mk({ EmployeeID: EMP.khaled, Amount: 700, CashAccountID: 1 });
    const a3 = await mk({ EmployeeID: EMP.layla, Amount: 800, CashAccountID: 1 });
    t('khaled drew 600 and 700, layla 800', a2a?.success === true && a2b?.success === true && a3?.success === true, JSON.stringify([a2a, a2b, a3]));
    cashL -= 600 + 700 + 800;

    const undo = await call('delete:advance', advRow(EMP.sara, 2000).AdvanceID);
    t('an unsettled advance reverses: cash back and the row gone',
      undo?.success === true && cash() === cashL + 2000 && !q('SELECT 1 v FROM employee_advances WHERE Amount = 2000'), undo?.message ?? JSON.stringify(undo));
    cashL += 2000;
    const undoMissing = await call('delete:advance', 99999);
    t('delete:advance on a missing id is refused', undoMissing?.success === false && undoMissing?.message === 'السلفية غير موجودة', undoMissing?.message ?? JSON.stringify(undoMissing));

    // Re-draw the e1 advance so the issue section has something to absorb.
    const a1b = await mk({ EmployeeID: EMP.sara, Amount: 2000, Reason: 'شراء قطع غيار', CashAccountID: 1 });
    t('the e1 advance is re-drawn', a1b?.success === true && cash() === cashL - 2000, JSON.stringify(a1b));
    cashL -= 2000;
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Deductions — reasons, damage costing, and the deletion guard');
  {
    const EMP = globalThis.__EMP__;
    const mk = (p) => call('deductions:create', { userId: 1, fiscalYearId: 1, ...p });

    const d1 = await mk({ EmployeeID: EMP.sara, Amount: 100, Reason: 'absence' });
    t('an absence deduction is recorded', d1?.success === true && dedRow(EMP.sara, 100)?.Reason === 'absence' && dedRow(EMP.sara, 100)?.IsDeducted === 0, JSON.stringify(d1));
    const badReason = await mk({ EmployeeID: EMP.sara, Amount: 100, Reason: 'lateness' });
    t('an unknown reason is refused with the whitelist',
      badReason?.success === false && badReason?.message === 'سبب الخصم غير صالح — القيم المسموحة: absence، negligence، damage، other',
      badReason?.message ?? JSON.stringify(badReason));
    const dCost = await mk({ EmployeeID: EMP.sara, Amount: 5, Reason: 'damage', DamagedItemID: 1, DamageCostType: 'cost' });
    t('damage at COST prices the item', dCost?.success === true && dCost?.amount === 40, JSON.stringify(dCost));
    const dSale = await mk({ EmployeeID: EMP.sara, Amount: 5, Reason: 'damage', DamagedItemID: 1, DamageCostType: 'sale' });
    t('damage at SALE price prices the item', dSale?.success === true && dSale?.amount === 65, JSON.stringify(dSale));
    const dAmt = await mk({ EmployeeID: EMP.sara, Amount: 90, Reason: 'damage' });
    t('damage without an item keeps the given amount', dAmt?.success === true && dAmt?.amount === 90, JSON.stringify(dAmt));
    const neg = await mk({ EmployeeID: EMP.sara, Amount: -10, Reason: 'absence' });
    t('a negative deduction is refused', neg?.success === false && neg?.message === 'مبلغ الخصم يجب أن يكون رقماً غير سالب', neg?.message ?? JSON.stringify(neg));
    const zero = await mk({ EmployeeID: EMP.sara, Amount: 0, Reason: 'absence' });
    t('a zero deduction is refused', zero?.success === false && zero?.message === 'مبلغ الخصم يجب أن يكون أكبر من صفر', zero?.message ?? JSON.stringify(zero));
    const badEmp = await mk({ EmployeeID: 99999, Amount: 50, Reason: 'absence' });
    t('a non-existent employee is refused', badEmp?.success === false && badEmp?.message === 'الموظف غير موجود', badEmp?.message ?? JSON.stringify(badEmp));

    const dlist = await call('deductions:list', EMP.sara);
    t('deductions:list joins the employee and damage item names',
      dlist?.some(d => d.DamagedItemID === 1 && d.DamagedItemName === 'كابل'), JSON.stringify(dlist?.map(d => d.DamagedItemName)));

    // The three interlopers (40/65/90) are removed so the issue arithmetic
    // below sees exactly the one absence deduction. 40 is deleted through the
    // handler; 65 and 90 through it too (all unsettled, all reversible).
    const costRow = q('SELECT DeductionID v FROM employee_deductions WHERE EmployeeID = ? AND Amount = 40', EMP.sara).v;
    const undoD = await call('delete:deduction', costRow);
    t('an unsettled deduction can be deleted', undoD?.success === true && !q('SELECT 1 v FROM employee_deductions WHERE DeductionID = ?', costRow), undoD?.message ?? JSON.stringify(undoD));
    await call('delete:deduction', q('SELECT DeductionID v FROM employee_deductions WHERE EmployeeID = ? AND Amount = 65', EMP.sara).v);
    await call('delete:deduction', q('SELECT DeductionID v FROM employee_deductions WHERE EmployeeID = ? AND Amount = 90', EMP.sara).v);

    // A settled deduction is in a different bookkeeping world.
    const dSettled = await mk({ EmployeeID: EMP.sara, Amount: 77, Reason: 'other' });
    const settledId = q('SELECT DeductionID v FROM employee_deductions WHERE EmployeeID = ? AND Amount = 77', EMP.sara).v;
    run('UPDATE employee_deductions SET IsDeducted = 1, DeductedFromSalaryID = 999 WHERE DeductionID = ?', settledId);
    const undoSettled = await call('delete:deduction', settledId);
    t('a settled deduction is refused',
      undoSettled?.success === false && undoSettled?.message.includes('لا يمكن حذف خصم تم تطبيقه على راتب بالفعل'), undoSettled?.message ?? JSON.stringify(undoSettled));
  }

  // ---------------------------------------------------------------- 4
  console.log('\n[4] salaries:issue — the arithmetic of absorption');
  {
    const EMP = globalThis.__EMP__;

    // A maintenance delivery commission, written the same way
    // maintenance.handlers.ts:755 creates one.
    run(`INSERT INTO commissions (EmployeeID, CommissionType, Amount, Date, ReferenceType, ReferenceID, IsPaid, PaidAmount, FiscalYearID, UserID)
         VALUES (?, 'maintenance', 100, datetime('now','localtime'), 'maintenance_delivery', 1, 0, 0, 1, 1)`, EMP.sara);

    const issue = (empid) => call('salaries:issue', { EmployeeID: empid, Month: '2026-08', userId: 1, fiscalYearId: 1 });

    const sSara = await issue(EMP.sara);
    // gross 3000+500+100 = 3600; deductions 100 -> 3500; advance 2000 applied
    // fully -> net 1500.
    t('sara\'s issue comes out exactly', sSara?.success === true
      && sSara?.details?.baseSalary === 3000 && sSara?.details?.allowances === 500
      && sSara?.details?.commissions === 100 && sSara?.details?.deductions === 100
      && sSara?.details?.advances === 2000 && sSara?.details?.netSalary === 1500,
      JSON.stringify(sSara?.details));
    t('issue books the obligation on the employee',
      empBal(EMP.sara) === 1500, `balance ${empBal(EMP.sara)}`);
    t('the advance is marked settled with the salary id',
      q('SELECT IsDeducted v, DeductedFromSalaryID d FROM employee_advances WHERE EmployeeID = ? AND Amount = 2000', EMP.sara).v === 1
      && q('SELECT DeductedFromSalaryID d FROM employee_advances WHERE EmployeeID = ? AND Amount = 2000', EMP.sara).d === payId(EMP.sara),
      'advance row');
    t('the deduction is marked settled with the salary id',
      q('SELECT IsDeducted v, DeductedFromSalaryID d FROM employee_deductions WHERE EmployeeID = ? AND Reason = ?', EMP.sara, 'absence').v === 1
      && q('SELECT DeductedFromSalaryID d FROM employee_deductions WHERE EmployeeID = ? AND Reason = ?', EMP.sara, 'absence').d === payId(EMP.sara),
      'deduction row');
    t('the commission is marked paid into the salary',
      q('SELECT IsPaid v, PaidInSalaryID p, PaidAmount a FROM commissions WHERE EmployeeID = ? AND Amount = 100', EMP.sara).v === 1
      && q('SELECT PaidInSalaryID p FROM commissions WHERE EmployeeID = ? AND Amount = 100', EMP.sara).p === payId(EMP.sara)
      && q('SELECT PaidAmount a FROM commissions WHERE EmployeeID = ? AND Amount = 100', EMP.sara).a === 100,
      'commission row');
    const dup = await issue(EMP.sara);
    t('a second issue for the same month is refused',
      dup?.success === false && dup?.message === 'تم إصدار راتب هذا الشهر لهذا الموظف بالفعل', dup?.message ?? JSON.stringify(dup));

    // Khaled: base 1200, advances 600 + 700 = 1300. Only 1200 is absorbable:
    // the 600 settles in full, the 700 drops to 100 and stays OPEN.
    const sKhaled = await issue(EMP.khaled);
    t('khaled\'s issue caps at what the month can absorb', sKhaled?.success === true && sKhaled?.details?.netSalary === 0, JSON.stringify(sKhaled?.details));
    t('the first advance settled in full, the second only in part',
      q('SELECT IsDeducted v, DeductedFromSalaryID d FROM employee_advances WHERE EmployeeID = ? AND Amount = 600', EMP.khaled).v === 1
      && q('SELECT IsDeducted v FROM employee_advances WHERE EmployeeID = ? AND Amount = 100', EMP.khaled).v === 0
      && q('SELECT DeductedFromSalaryID d FROM employee_advances WHERE EmployeeID = ? AND Amount = 100', EMP.khaled).d === null,
      'advance rows');
    t('khaled owes the rest of the advance', empBal(EMP.khaled) === 0 && q('SELECT Balance v FROM employees WHERE EmployeeID = ?', EMP.khaled).v === 0, String(empBal(EMP.khaled)));

    // Layla: base 500 against a 800 advance -> net 0, 300 stays outstanding.
    const sLayla = await issue(EMP.layla);
    t('layla\'s issue floors at zero', sLayla?.success === true && sLayla?.details?.netSalary === 0 && sLayla?.details?.advances === 800, JSON.stringify(sLayla?.details));
    t('layla\'s issue absorbed only what the month could cover',
      q('SELECT AdvancesTotal v FROM salaries WHERE SalaryID = ?', payId(EMP.layla)).v === 500, 'row AdvancesTotal');
    t('the unabsorbed part stays open', q('SELECT Amount v, IsDeducted d FROM employee_advances WHERE EmployeeID = ?', EMP.layla).v === 300 && q('SELECT IsDeducted d FROM employee_advances WHERE EmployeeID = ?', EMP.layla).d === 0, 'advance row');

    const noEmp = await call('salaries:issue', { Month: '2026-08', userId: 1, fiscalYearId: 1 });
    t('issue without an employee is refused', noEmp?.success === false && noEmp?.message === 'رقم الموظف غير صالح', noEmp?.message ?? JSON.stringify(noEmp));
    const badEmp = await call('salaries:issue', { EmployeeID: 99999, Month: '2026-08', userId: 1, fiscalYearId: 1 });
    t('issue for a non-existent employee is refused', badEmp?.success === false && badEmp?.message === 'الموظف غير موجود', badEmp?.message ?? JSON.stringify(badEmp));

    // The mid-month-commission host: noura's salary is issued CLEAN, and the
    // commission arrives afterwards — as a delivery completed after the run.
    const noura = await call('employees:create', { Name: 'نورا علي', BaseSalary: 2500 });
    globalThis.__NOURA__ = noura.id;
    const sNoura = await issue(noura.id);
    t('noura\'s issue is clean', sNoura?.success === true && sNoura?.details?.netSalary === 2500, JSON.stringify(sNoura?.details));
    t('noura now carries the obligation', empBal(noura.id) === 2500, String(empBal(noura.id)));
    await sleep(1100); // the delivery happens strictly AFTER the payroll run
    run(`INSERT INTO commissions (EmployeeID, CommissionType, Amount, Date, ReferenceType, ReferenceID, IsPaid, PaidAmount, FiscalYearID, UserID)
         VALUES (?, 'maintenance', 400, datetime('now','localtime'), 'maintenance_delivery', 2, 0, 0, 1, 1)`, noura.id);
  }

  // ---------------------------------------------------------------- 5
  console.log('\n[5] salaries:pay — cash movement, partial runs, the refusals');
  {
    const EMP = globalThis.__EMP__;
    const noura = globalThis.__NOURA__;
    const pay = (p) => call('salaries:pay', { userId: 1, ...p });

    const r1 = await pay({ SalaryID: payId(EMP.sara), PaidAmount: 600, CashAccountID: 1 });
    t('a partial pay lands on the salary',
      r1?.success === true && r1?.status === 'partial'
      && q('SELECT Status v, PaidAmount p FROM salaries WHERE SalaryID = ?', payId(EMP.sara)).v === 'partial'
      && q('SELECT PaidAmount p FROM salaries WHERE SalaryID = ?', payId(EMP.sara)).p === 600,
      JSON.stringify(r1));
    cashL -= 600;
    t('the drawer paid 600', cash() === cashL, `${cash()} vs ${cashL}`);
    t('the balance follows', empBal(EMP.sara) === 900, String(empBal(EMP.sara)));

    const r2 = await pay({ SalaryID: payId(EMP.sara), PaidAmount: 900, CashAccountID: 1 });
    t('the second leg completes the salary', r2?.success === true && r2?.status === 'paid'
      && q('SELECT Status v FROM salaries WHERE SalaryID = ?', payId(EMP.sara)).v === 'paid'
      && q('SELECT PaymentDate v FROM salaries WHERE SalaryID = ?', payId(EMP.sara)).v !== null,
      JSON.stringify(r2));
    cashL -= 900;
    t('the drawer paid the rest', cash() === cashL, `${cash()} vs ${cashL}`);
    t('the employee balance is settled', empBal(EMP.sara) === 0, String(empBal(EMP.sara)));
    t('the salary row no longer owes anything',
      q('SELECT PaidAmount p, NetSalary n FROM salaries WHERE SalaryID = ?', payId(EMP.sara)).p === 1500, 'row values');

    const r3 = await pay({ SalaryID: payId(EMP.sara), PaidAmount: 100, CashAccountID: 1 });
    t('a paid salary cannot be paid again',
      r3?.success === false && r3?.message === 'تم صرف هذا الراتب بالفعل', r3?.message ?? JSON.stringify(r3));
    const missingSal = await pay({ PaidAmount: 100, CashAccountID: 1 });
    t('pay without a salary is refused', missingSal?.success === false && missingSal?.message === 'رقم الراتب غير صالح', missingSal?.message ?? JSON.stringify(missingSal));
    const badSal = await pay({ SalaryID: 99999, PaidAmount: 100, CashAccountID: 1 });
    t('pay for a non-existent salary is refused', badSal?.success === false && badSal?.message === 'الراتب غير موجود', badSal?.message ?? JSON.stringify(badSal));

    // Noura's pay must NOT sweep the commission that arrived after the run.
    // The commission was never part of her net, and marking it paid would
    // hand it to nobody while making the books think she got it.
    const r4 = await pay({ SalaryID: payId(noura), PaidAmount: 2500, CashAccountID: 1 });
    t('noura\'s salary pays in full', r4?.success === true && r4?.status === 'paid', JSON.stringify(r4));
    cashL -= 2500;
    t('the mid-month commission stays PENDING',
      q('SELECT IsPaid v, PaidInSalaryID p FROM commissions WHERE EmployeeID = ? AND Amount = 400', noura).v === 0
      && q('SELECT PaidInSalaryID p FROM commissions WHERE EmployeeID = ? AND Amount = 400', noura).p === null,
      JSON.stringify(q('SELECT IsPaid v, PaidInSalaryID p, PaidAmount a FROM commissions WHERE EmployeeID = ? AND Amount = 400', noura)));
    t('noura\'s salary shows exactly the issue figure',
      q('SELECT NetSalary n, PaidAmount p FROM salaries WHERE SalaryID = ?', payId(noura)).n === 2500
      && q('SELECT PaidAmount p FROM salaries WHERE SalaryID = ?', payId(noura)).p === 2500, 'salary row');

    const samir = await call('employees:create', { Name: 'سمير عادل', BaseSalary: 500000 });
    const sSamir = await call('salaries:issue', { EmployeeID: samir.id, Month: '2026-08', userId: 1, fiscalYearId: 1 });
    t('samir\'s issue is clean', sSamir?.success === true && sSamir?.details?.netSalary === 500000, JSON.stringify(sSamir?.details));
    const dry = await pay({ SalaryID: payId(samir.id), PaidAmount: 500000, CashAccountID: 1 });
    t('a salary the drawer cannot cover is refused',
      dry?.success === false && dry?.message === `الرصيد غير كافٍ في الخزينة لصرف الراتب: المتاح ${cashL.toFixed(2)}، المطلوب 500000.00`,
      dry?.message ?? JSON.stringify(dry));
    t('the failed pay moved nothing', cash() === cashL && empBal(samir.id) === 500000, `${cash()} vs ${cashL}`);

    const rami = await call('employees:create', { Name: 'رامي فؤاد', BaseSalary: 3000 });
    const sRami = await call('salaries:issue', { EmployeeID: rami.id, Month: '2026-08', userId: 1, fiscalYearId: 1 });
    t('rami\'s issue is clean', sRami?.success === true && sRami?.details?.netSalary === 3000, JSON.stringify(sRami?.details));
    globalThis.__RAMI__ = { id: rami.id, salaryId: payId(rami.id) };
  }

  // ---------------------------------------------------------------- 6
  console.log('\n[6] The race window — a rival till drains the drawer mid-flight');
  {
    const rami = globalThis.__RAMI__;
    const EMP = globalThis.__EMP__;

    // Before the tx opens, the drawer empties — the same gap a second till
    // occupies on a shared network database. The handler must re-check inside
    // the transaction or it pays money that is no longer there.
    raceProbe(emptyDrawer);
    const rPay = await call('salaries:pay', { SalaryID: rami.salaryId, PaidAmount: 3000, CashAccountID: 1, userId: 1 });
    t('a salary is refused when the drawer empties mid-flight',
      rPay?.success === false && cash() >= 0, `${rPay?.success ? 'ACCEPTED' : 'refused'}, cash ${cash()}`);
    t('the refused pay left no trace on the obligation', empBal(rami.id) === 3000, String(empBal(rami.id)));
    run('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = 1', cashL);

    raceProbe(emptyDrawer);
    const rAdv = await call('advances:create', { EmployeeID: EMP.sara, Amount: 500, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('an advance is refused when the drawer empties mid-flight',
      rAdv?.success === false && cash() >= 0, `${rAdv?.success ? 'ACCEPTED' : 'refused'}, cash ${cash()}`);
    run('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = 1', cashL);
  }

  // ---------------------------------------------------------------- 7
  console.log('\n[7] Statements, reports and the closing identity');
  {
    const EMP = globalThis.__EMP__;
    const noura = globalThis.__NOURA__;

    const stSara = await call('employeeStatement:get', EMP.sara);
    // 177 = the live absence deduction (100) + the deliberately settled 77 the
    // deletion-guard test left behind (it can no longer be deleted).
    t('sara\'s statement carries her history exactly',
      stSara?.totals?.totalSalariesNet === 1500 && stSara?.totals?.totalSalariesPaid === 1500
      && stSara?.totals?.totalSalariesRemaining === 0 && stSara?.totals?.totalAdvances === 2000
      && stSara?.totals?.totalCommissions === 100 && stSara?.totals?.totalDeductions === 177
      && stSara?.totals?.pendingAdvances === 0 && stSara?.totals?.currentBalance === 0,
      JSON.stringify(stSara?.totals));
    const stKhaled = await call('employeeStatement:get', EMP.khaled);
    t('khaled\'s statement shows what remains OWED',
      stKhaled?.totals?.totalAdvances === 700 && stKhaled?.totals?.pendingAdvances === 100 && stKhaled?.totals?.currentBalance === 0,
      JSON.stringify(stKhaled?.totals));
    const stLayla = await call('employeeStatement:get', EMP.layla);
    t('layla\'s statement carries the reduced advance', stLayla?.totals?.pendingAdvances === 300 && stLayla?.totals?.currentBalance === 0, JSON.stringify(stLayla?.totals));
    const stNoura = await call('employeeStatement:get', noura);
    t('noura\'s statement includes her still-unpaid commission',
      stNoura?.totals?.totalCommissions === 400 && stNoura?.totals?.pendingCommissions === 400 && stNoura?.totals?.currentBalance === 0,
      JSON.stringify(stNoura?.totals));

    const details1 = await call('salaries:getDetails', payId(EMP.sara));
    t('getDetails breaks the salary into its parts',
      details1?.salary?.NetSalary === 1500 && details1?.commissions?.length === 1
      && details1?.deductions?.length === 1 && details1?.advances?.length === 1
      && details1?.pending?.commissions?.length === 0
      && details1?.commissions?.[0]?.PaidInSalaryID === payId(EMP.sara),
      JSON.stringify({ c: details1?.commissions?.length, d: details1?.deductions?.length, a: details1?.advances?.length }));
    const detailsN = await call('salaries:getDetails', payId(noura));
    t('noura\'s details leave the late commission pending',
      detailsN?.commissions?.length === 0 && detailsN?.pending?.commissions?.length === 1
      && detailsN?.pending?.commissions?.[0]?.Amount === 400,
      JSON.stringify({ c: detailsN?.commissions?.length, pc: detailsN?.pending?.commissions?.length }));

    const rep = await call('reports:employees');
    const rowOf = (id) => rep?.rows?.find(r => r.EmployeeID === id);
    t('reports:employees foots to the live ledger',
      rowOf(EMP.sara)?.SalaryCount === 1 && rowOf(EMP.sara)?.TotalPaid === 1500
      && rowOf(EMP.sara)?.UnpaidAdvances === 0 && rowOf(EMP.khaled)?.UnpaidAdvances === 100
      && rowOf(noura)?.UnpaidCommissions === 400 && rowOf(globalThis.__RAMI__.id)?.SalaryCount === 1,
      JSON.stringify(rep?.rows?.map(r => ({ n: r.Name, c: r.SalaryCount, ua: r.UnpaidAdvances, uc: r.UnpaidCommissions }))));

    const liveExpense = q('SELECT COALESCE(SUM(NetSalary + COALESCE(AdvancesTotal,0)),0) v FROM salaries').v;
    const p = await pl();
    t('the P&L salaries expense is the gross accrual',
      near(p?.expenses?.salaries, liveExpense), `${p?.expenses?.salaries} vs live ${liveExpense}`);

    const f = await fp();
    t('employee advances sit on the balance sheet as an asset', near(f?.assets?.employeeAdvances ?? 0, 400), JSON.stringify(f?.assets));
    const liveEmpLiab = q('SELECT COALESCE(SUM(Balance),0) v FROM employees WHERE IsActive = 1 AND Balance > 0').v;
    t('the employee obligation sits on it as a liability',
      near(f?.liabilities?.totalEmployees ?? 0, liveEmpLiab), `${f?.liabilities?.totalEmployees} vs live ${liveEmpLiab}`);
    t('assets = liabilities + equity exactly', balanced(f), JSON.stringify(f?.capital));
    t('the balance sheet cash equals the tracked cash', near(f?.assets?.totalCash, cashL), `${f?.assets?.totalCash} vs ${cashL}`);
    t('the balance sheet machine equals the tracked machine', near(f?.assets?.totalPaymentMethods, mach()), `${f?.assets?.totalPaymentMethods} vs ${mach()}`);
    t('P&L and balance sheet compute the SAME profit', near(p?.netProfit ?? NaN, f?.capital?.netProfit ?? NaN), `${p?.netProfit} vs ${f?.capital?.netProfit}`);
    t('every employee balance is the unpaid salary sum',
      qa('SELECT EmployeeID, Balance FROM employees').every(e =>
        near(e.Balance, q('SELECT COALESCE(SUM(NetSalary - PaidAmount),0) v FROM salaries WHERE EmployeeID = ?', e.EmployeeID).v)),
      'invariant');
  }

  console.log(`\nSECTION 5 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
}