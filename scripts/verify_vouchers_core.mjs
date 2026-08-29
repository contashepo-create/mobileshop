#!/usr/bin/env node
// SECTION 10 — VOUCHERS: receipts and payments against the drawer, the
// machine, customers, suppliers and employees — including the rent-instalment
// link — executed against the REAL bundle on the REAL schema.
//
// Same harness as sections 8-9: an ESM entry re-exporting only the handler
// registration functions, esbuild CJS bundle, an electron stub, and a scratch
// userData directory. Every channel below runs the actual production code.
//
// The accounting claim under test: a voucher names exactly ONE asset and it
// moves exactly that asset; a party voucher touches the party ledger exactly
// once; a rent-linked voucher settles the instalment exactly once; the P&L
// sees general + rent vouchers and nothing else; every statement foots to the
// real balances; and deletion reverses every leg it owns — while refusing to
// delete what belongs to a transfer or an instalment.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
export { registerTransfersHandlers } from './src/main/ipc/transfers.handlers.ts';
export { registerRentHandlers } from './src/main/ipc/rent.handlers.ts';
export { registerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_voucher_entry.ts');
writeFileSync(entryFile, ENTRY);

const electronStub = `
const path = require('path');
const { EventEmitter } = require('events');
const emitter = new EventEmitter();
emitter.getPath = (k) => process.env.PAYROOT + '/data';
emitter.dirname = path.dirname;
module.exports = {
  app: emitter,
  ipcMain: {
    emitter,
    handle(channel, fn) {
      if (!globalThis.__FOUND_HANDLERS__) globalThis.__FOUND_HANDLERS__ = new Map();
      globalThis.__FOUND_HANDLERS__.set(channel, fn);
    },
  },
  BrowserWindow: class { constructor() {} loadURL() {} on() { return this; } },
};\n`;

let userData;
try {
  userData = mkdtempSync(join(tmpdir(), 'rn-user-'));
  process.env.PAYROOT = userData;
  console.log('Building the real vouchers bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_voucher_bundle.cjs');
  writeFileSync(bundleFile, out.outputFiles[0].text);
  const require = createRequire(import.meta.url);
  const mod = require(bundleFile);

  const PASS = [];
  const FAIL = [];
  const t = (name, ok, diag) => {
    if (ok) PASS.push(name); else FAIL.push(name);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        ${diag}`);
  };
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.01;

  // -------------------------------------------------- per-scenario isolation
  const DB_FILES = ['mobile_shop.db', 'mobile_shop.db-wal', 'mobile_shop.db-shm'];
  const wipeDb = () => {
    for (const f of DB_FILES) {
      try { rmSync(join(userData, 'data', f), { force: true }); } catch { /* not open */ }
    }
  };
  const scenario = async (fn) => {
    mod.closeDb();
    wipeDb();
    globalThis.__FOUND_HANDLERS__ = new Map();
    for (const [name, exp] of Object.entries(mod)) {
      if (typeof exp === 'function' && name.startsWith('register')) exp();
    }
    const db = mod.getDb();
    mod.runMigrations(db);
    const call = (channel, ...args) => {
      const handler = globalThis.__FOUND_HANDLERS__.get(channel);
      if (!handler) throw new Error(`channel not registered: ${channel}`);
      return handler({ sender: { id: 1 } }, ...args);
    };
    await fn({ db, call });
  };

  // ---------------------------------------------------------------- helpers
  const q = (db, sql, ...p) => db.prepare(sql).get(...p);
  const qa = (db, sql, ...p) => db.prepare(sql).all(...p);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

  // Opening net worth: cash 100000 + machine 5000 + customer debt 2000
  // - supplier 1500 - employee 1000 = 104500.
  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO cash_accounts (CashAccountID, AccountName, AccountType, Balance, IsActive)
      VALUES (2, 'خزنة معطلة', 'safe', 0, 0);
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 5000, 1), (2, 'ماكينة معطلة', 'card', 0, 0);
    INSERT INTO customers (CustomerID, Name, Phone, Balance, Status)
      VALUES (1, 'عميل السندات', '0100', 2000, 'active');
    INSERT INTO suppliers (SupplierID, Name, Phone, Balance, Status)
      VALUES (1, 'مورد السندات', '0111', 1500, 'active');
    UPDATE employees SET Name = 'موظف السندات', Position = 'فني', Department = 'صيانة',
      BaseSalary = 0, Allowances = 0, HireDate = '2026-01-01', Balance = 1000, IsActive = 1
      WHERE EmployeeID = 1;
    INSERT INTO settings (Key, Value) VALUES ('allow_negative_cash', '0')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '104500')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const customer = (db) => q(db, 'SELECT Balance v FROM customers WHERE CustomerID = 1').v;
  const supplier = (db) => q(db, 'SELECT Balance v FROM suppliers WHERE SupplierID = 1').v;
  const employee = (db) => q(db, 'SELECT Balance v FROM employees WHERE EmployeeID = 1').v;
  const voucher = (call, o) => call('vouchers:create', {
    VoucherType: 'receipt', Amount: 100, Description: 'سند', CashAccountID: 1,
    userId: 1, fiscalYearId: 1, ...o,
  });
  const fp = async (call) => await call('reports:financialPosition');
  const pl = async (call) => await call('reports:profitLoss', { fromDate: daysAgo(30), toDate: fmt(new Date()) });
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;
  const safeCall = async (call, channel, ...args) => {
    try { return await call(channel, ...args); } catch (e) { return { threw: true, message: String(e?.message ?? e) }; }
  };

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A general receipt lands in the drawer, once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await voucher(call, { Amount: 400, Description: 'وارد عام' });
    t('the receipt is accepted', r?.success === true, r?.message ?? '');
    t('the drawer gained exactly the amount', near(cash(db), 100400), `cash ${cash(db)}`);
    t('nothing else moved', near(wallet(db), 5000), `wallet ${wallet(db)}`);
    const p = await pl(call);
    t('the P&L counts the general receipt as income', near(p?.revenue?.otherIncome ?? 0, 400), `income ${p?.revenue?.otherIncome}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement shows the receipt', cs?.operations?.some(o => o.OpType === 'voucher_receipt' && near(o.InAmount, 400)),
      JSON.stringify(cs?.operations ?? []).slice(0, 140));
    t('the drawer statement foots', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), 400));
    const row = q(db, 'SELECT * FROM vouchers ORDER BY VoucherID DESC');
    t('the voucher is recorded with its number', !!row && row.VoucherNumber.startsWith('RCV'), row?.VoucherNumber ?? 'none');
    const fetched = await call('vouchers:get', row.VoucherID);
    t('vouchers:get returns it with the username', fetched?.VoucherID === row.VoucherID, JSON.stringify(fetched ?? {}).slice(0, 120));
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] A general payment leaves the drawer, once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await voucher(call, { VoucherType: 'payment', Amount: 300, Description: 'منصرف عام' });
    t('the payment is accepted', r?.success === true, r?.message ?? '');
    t('the drawer lost exactly the amount', near(cash(db), 99700), `cash ${cash(db)}`);
    const p = await pl(call);
    t('the P&L charges it as a general expense', near(p?.expenses?.general ?? 0, 300), `expense ${p?.expenses?.general}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement shows the payment', cs?.operations?.some(o => o.OpType === 'voucher_payment' && near(o.OutAmount, 300)),
      JSON.stringify(cs?.operations ?? []).slice(0, 140));
    const row = q(db, 'SELECT * FROM vouchers ORDER BY VoucherID DESC');
    t('the voucher number carries the PAY prefix', row.VoucherNumber.startsWith('PAY'), row.VoucherNumber);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] A receipt into the machine moves the machine only');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await voucher(call, { Amount: 600, CashAccountID: undefined, PaymentMethodID: 1, Description: 'وارد ماكينة' });
    t('the machine receipt is accepted', r?.success === true, r?.message ?? '');
    t('the machine gained the amount', near(wallet(db), 5600), `wallet ${wallet(db)}`);
    t('the drawer did not move', near(cash(db), 100000), `cash ${cash(db)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), 600),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] A customer receipt settles the debt without touching the P&L');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await voucher(call, { Amount: 700, PartyType: 'customer', PartyID: 1, PartyName: 'عميل السندات', Description: 'سداد عميل' });
    t('the customer receipt is accepted', r?.success === true, r?.message ?? '');
    t('the debt went down', near(customer(db), 1300), `customer ${customer(db)}`);
    t('the drawer gained the amount', near(cash(db), 100700), `cash ${cash(db)}`);
    const p = await pl(call);
    t('repaying a debt creates no income', near(p?.revenue?.otherIncome ?? 0, 0) && near(p?.netProfit ?? 0, 0),
      `income ${p?.revenue?.otherIncome}, profit ${p?.netProfit}`);
    const cs = await call('cashAccount:statement', 1, {});
    const leg = cs?.operations?.find(o => o.OpType === 'voucher_receipt');
    t('the statement records the settled debt with its party', leg?.Party === 'عميل السندات', JSON.stringify(leg ?? {}).slice(0, 120));
    const f = await fp(call);
    t('the books balance — the debt moved off the balance sheet', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] Supplier and employee directions move the ledgers the right way');
  await scenario(async ({ db, call }) => {
    seed(db);
    const pay = await voucher(call, { VoucherType: 'payment', Amount: 400, PartyType: 'supplier', PartyID: 1, PartyName: 'مورد', Description: 'سداد مورد' });
    t('a supplier payment is accepted', pay?.success === true, pay?.message ?? '');
    t('what we owe the supplier shrank', near(supplier(db), 1100), `supplier ${supplier(db)}`);
    const rec = await voucher(call, { Amount: 200, PartyType: 'supplier', PartyID: 1, PartyName: 'مورد', Description: 'مرتجع من مورد' });
    t('a supplier receipt raises what they owe us', rec?.success === true && near(supplier(db), 1300), `supplier ${supplier(db)}`);
    const ePay = await voucher(call, { VoucherType: 'payment', Amount: 300, PartyType: 'employee', PartyID: 1, PartyName: 'موظف', Description: 'دفعة راتب' });
    t('an employee payment reduces what we owe', ePay?.success === true && near(employee(db), 700), `employee ${employee(db)}`);
    const eRec = await voucher(call, { Amount: 150, PartyType: 'employee', PartyID: 1, PartyName: 'موظف', Description: 'استرداد سلفة' });
    t('an employee receipt raises what we owe', eRec?.success === true && near(employee(db), 850), `employee ${employee(db)}`);
    t('the drawer foots all four moves', near(cash(db), 100000 - 400 + 200 - 300 + 150), `cash ${cash(db)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] The guards refuse the degenerate vouchers');
  await scenario(async ({ db, call }) => {
    seed(db);
    const z = await voucher(call, { Amount: 0 });
    t('a zero amount is refused', z?.success === false, z?.message ?? '');
    const neg = await voucher(call, { Amount: -50 });
    t('a negative amount is refused', neg?.success === false, neg?.message ?? '');
    const alien = await voucher(call, { VoucherType: 'RECEIPT', Amount: 100 });
    t('an alien type is refused', alien?.success === false, alien?.message ?? '');
    const alienParty = await voucher(call, { PartyType: 'rent', PartyID: 1 });
    t('an alien party type is refused', alienParty?.success === false, alienParty?.message ?? '');
    const ghostCust = await voucher(call, { PartyType: 'customer', PartyID: 99999 });
    t('a ghost customer is refused', ghostCust?.success === false, ghostCust?.message ?? '');
    const ghostSup = await voucher(call, { PartyType: 'supplier', PartyID: 99999 });
    t('a ghost supplier is refused', ghostSup?.success === false, ghostSup?.message ?? '');
    const ghostEmp = await voucher(call, { PartyType: 'employee', PartyID: 99999 });
    t('a ghost employee is refused', ghostEmp?.success === false, ghostEmp?.message ?? '');
    const noAsset = await voucher(call, { CashAccountID: undefined, PaymentMethodID: undefined });
    t('a voucher naming no asset is refused', noAsset?.success === false, noAsset?.message ?? '');
    const both = await voucher(call, { CashAccountID: 1, PaymentMethodID: 1 });
    t('a voucher naming two assets is refused', both?.success === false, both?.message ?? '');
    const nodesc = await voucher(call, { Description: '' });
    t('an empty description is refused', nodesc?.success === false, nodesc?.message ?? '');
    t('nothing moved, nothing recorded', near(cash(db), 100000) && near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM vouchers').v === 0,
      `cash ${cash(db)}, vouchers ${q(db, 'SELECT COUNT(*) v FROM vouchers').v}`);
  });

  // ---------------------------------------------------------------- 7
  console.log('\n[7] A voucher cannot land in an account that is not there');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ghostCash = await voucher(call, { Amount: 500, CashAccountID: 99999 });
    t('a receipt into a ghost drawer is refused', ghostCash?.success === false, ghostCash?.message ?? '');
    const ghostMach = await voucher(call, { Amount: 500, CashAccountID: undefined, PaymentMethodID: 99999 });
    t('a receipt into a ghost machine is refused', ghostMach?.success === false, ghostMach?.message ?? '');
    const ghostPay = await voucher(call, { VoucherType: 'payment', Amount: 500, CashAccountID: 99999 });
    t('a payment from a ghost drawer is refused', ghostPay?.success === false, ghostPay?.message ?? '');
    t('nothing was recorded anywhere', near(cash(db), 100000) && near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM vouchers').v === 0,
      `cash ${cash(db)}, vouchers ${q(db, 'SELECT COUNT(*) v FROM vouchers').v}`);
  });

  // ---------------------------------------------------------------- 8
  console.log('\n[8] A voucher cannot use a disabled asset');
  await scenario(async ({ db, call }) => {
    seed(db);
    const deadSafe = await voucher(call, { Amount: 500, CashAccountID: 2 });
    t('a receipt into a disabled drawer is refused', deadSafe?.success === false, deadSafe?.message ?? '');
    const deadMach = await voucher(call, { Amount: 500, CashAccountID: undefined, PaymentMethodID: 2 });
    t('a receipt into a disabled machine is refused', deadMach?.success === false, deadMach?.message ?? '');
    t('nothing moved', near(cash(db), 100000) && near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM vouchers').v === 0);
  });

  // ---------------------------------------------------------------- 9
  console.log('\n[9] allow_negative_cash opens the drawer, and the machine answers, not throws');
  await scenario(async ({ db, call }) => {
    seed(db);
    const over = await voucher(call, { VoucherType: 'payment', Amount: 100400, Description: 'سحب فوق المتاح' });
    t('an overdrawn drawer is refused while locked', over?.success === false, over?.message ?? '');
    db.exec("UPDATE settings SET Value = '1' WHERE Key = 'allow_negative_cash'");
    const neg = await voucher(call, { VoucherType: 'payment', Amount: 100400, Description: 'سحب فوق المتاح' });
    t('a drawer allowed to go negative may overdraw', neg?.success === true, neg?.message ?? '');
    t('the drawer went negative', near(cash(db), -400), `cash ${cash(db)}`);
    const mach = await safeCall(call, 'vouchers:create', {
      VoucherType: 'payment', Amount: 5300, Description: 'سحب ماكينة شامل',
      PaymentMethodID: 1, userId: 1, fiscalYearId: 1,
    });
    t('an overdrawn machine ANSWERS instead of throwing', mach?.threw !== true, JSON.stringify(mach ?? {}).slice(0, 140));
    t('the machine refusal is soft', mach?.success === false, mach?.message ?? '');
    t('the machine did not move', near(wallet(db), 5000), `wallet ${wallet(db)}`);
    db.exec("UPDATE settings SET Value = '0' WHERE Key = 'allow_negative_cash'");
    const f = await fp(call);
    t('the books balance with the till in the red', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 10
  console.log('\n[10] The rent link settles the instalment exactly once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const rc = await call('rents:create', {
      RentName: 'كراج', RentType: 'expense', Amount: 1500, Period: 'monthly', StartDate: daysAgo(40),
    });
    await call('rents:generatePayments', rc.id, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID v FROM rent_payments LIMIT 1').v;
    const paid = await voucher(call, {
      VoucherType: 'payment', Amount: 1500, Description: 'إيجار الكراج', RentPaymentID: pid,
    });
    t('the linked payment is accepted', paid?.success === true, paid?.message ?? '');
    t('the instalment is paid', q(db, 'SELECT Status v FROM rent_payments WHERE RentPaymentID = ?', pid).v === 'paid');
    t('the reply reports the remaining and status', near(paid?.rentRemaining ?? -1, 0) && paid?.rentStatus === 'paid',
      JSON.stringify(paid ?? {}).slice(0, 140));
    const p = await pl(call);
    t('the P&L charges rent exactly once', near(p?.expenses?.rent ?? 0, 1500), `rent ${p?.expenses?.rent}`);
    const txn = q(db, `SELECT * FROM rent_transactions WHERE RentPaymentID = ? AND ReversedAt IS NULL`, pid);
    t('the settle wrote a voucher-sourced ledger row', txn?.SourceType === 'voucher', JSON.stringify(txn ?? {}).slice(0, 140));
    t('the drawer paid it once', near(cash(db), 98500), `cash ${cash(db)}`);

    const again = await voucher(call, { VoucherType: 'payment', Amount: 1500, Description: 'دفعة مكررة', RentPaymentID: pid });
    t('paying a settled instalment again is refused', again?.success === false, again?.message ?? '');
    const receiptLink = await voucher(call, { Amount: 1500, Description: 'إيصال مربوط', RentPaymentID: pid });
    t('a receipt cannot link to an instalment', receiptLink?.success === false, receiptLink?.message ?? '');
    const ghostLink = await voucher(call, { VoucherType: 'payment', Amount: 100, Description: 'x', RentPaymentID: 99999 });
    t('a ghost instalment link is refused', ghostLink?.success === false, ghostLink?.message ?? '');

    const rc2 = await call('rents:create', {
      RentName: 'كراج ثانٍ', RentType: 'expense', Amount: 1000, Period: 'monthly', StartDate: daysAgo(30),
    });
    await call('rents:generatePayments', rc2.id, 1, 1, 1);
    await call('rents:cancel', { RentID: rc2.id, Reason: 'لاغٍ' });
    const cpid = q(db, 'SELECT RentPaymentID v FROM rent_payments WHERE RentID = ?', rc2.id).v;
    const cancelledLink = await voucher(call, { VoucherType: 'payment', Amount: 100, Description: 'x', RentPaymentID: cpid });
    t('a cancelled instalment cannot be linked', cancelledLink?.success === false, cancelledLink?.message ?? '');

    const overpay = await voucher(call, { VoucherType: 'payment', Amount: 9999, Description: 'x', RentPaymentID: pid });
    t('overpaying the remaining is refused', overpay?.success === false, overpay?.message ?? '');

    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 11
  console.log('\n[11] Deleting a voucher reverses every leg it owns');
  await scenario(async ({ db, call }) => {
    seed(db);
    await voucher(call, { Amount: 400, Description: 'وارد' });
    await voucher(call, { VoucherType: 'payment', Amount: 300, Description: 'منصرف' });
    await voucher(call, { Amount: 700, PartyType: 'customer', PartyID: 1, PartyName: 'عميل', Description: 'سداد' });
    const ids = qa(db, 'SELECT VoucherID FROM vouchers ORDER BY VoucherID');
    t('three vouchers exist', ids.length === 3);
    const del1 = await call('delete:voucher', ids[0].VoucherID);
    t('the first delete succeeds', del1?.success === true, del1?.message ?? '');
    const del2 = await call('delete:voucher', ids[1].VoucherID);
    t('the second delete succeeds', del2?.success === true, del2?.message ?? '');
    await call('delete:voucher', ids[2].VoucherID);
    t('everything is back where it started', near(cash(db), 100000) && near(customer(db), 2000), `cash ${cash(db)}, customer ${customer(db)}`);
    t('no vouchers remain', q(db, 'SELECT COUNT(*) v FROM vouchers').v === 0);
    const p = await pl(call);
    t('the P&L is silent', near(p?.netProfit ?? 0, 0), `profit ${p?.netProfit}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the statement foots to nothing', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), 0));
    const ghost = await call('delete:voucher', 99999);
    t('deleting a ghost is refused', ghost?.success === false, ghost?.message ?? '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 12
  console.log('\n[12] What belongs to a transfer or an instalment cannot be deleted sideways');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('transfers:create', {
      FromType: 'cash_account', FromID: 1, ToType: 'payment_method', ToID: 1,
      Amount: 2000, TransferCost: 40, TransferCostSource: 'separate', Notes: 't', userId: 1, fiscalYearId: 1,
    });
    const fee = q(db, `SELECT VoucherID FROM vouchers WHERE ReferenceType = 'transfer'`);
    t('the transfer fee voucher exists', !!fee, 'no fee voucher');
    const side = await call('delete:voucher', fee.VoucherID);
    t('deleting the transfer fee voucher is refused', side?.success === false, side?.message ?? '');
    t('the fee voucher is still there', q(db, `SELECT VoucherID FROM vouchers WHERE ReferenceType = 'transfer'`)?.VoucherID === fee.VoucherID);

    await call('rents:create', {
      RentName: 'كراج', RentType: 'expense', Amount: 1200, Period: 'monthly', StartDate: daysAgo(40),
    });
    await call('rents:generatePayments', 1, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID v FROM rent_payments LIMIT 1').v;
    await voucher(call, { VoucherType: 'payment', Amount: 1200, Description: 'إيجار', RentPaymentID: pid });
    const rentVoucher = q(db, "SELECT VoucherID FROM vouchers WHERE Description = 'إيجار'");
    const sideRent = await call('delete:voucher', rentVoucher.VoucherID);
    t('deleting a rent-linked voucher is refused', sideRent?.success === false, sideRent?.message ?? '');
    t('the instalment is still paid', q(db, 'SELECT Status v FROM rent_payments WHERE RentPaymentID = ?', pid).v === 'paid');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 13
  console.log('\n[13] Penny-exact vouchers foot to the piastre');
  await scenario(async ({ db, call }) => {
    seed(db);
    await voucher(call, { Amount: 2000.1, Description: 'a' });
    await voucher(call, { VoucherType: 'payment', Amount: 0.3, Description: 'b' });
    await voucher(call, { Amount: 0.2, Description: 'c', CashAccountID: undefined, PaymentMethodID: 1 });
    await voucher(call, { VoucherType: 'payment', Amount: 1999.6, Description: 'd', CashAccountID: undefined, PaymentMethodID: 1 });
    t('the drawer foots exactly', near(cash(db), 100000 + 2000.1 - 0.3), `cash ${cash(db)}`);
    t('the machine foots exactly', near(wallet(db), 5000 + 0.2 - 1999.6), `wallet ${wallet(db)}`);
    const p = await pl(call);
    t('the P&L agrees to the piastre', near(p?.netProfit ?? 0, 2000.1 + 0.2 - 0.3 - 1999.6), `profit ${p?.netProfit}`);
    const f = await fp(call);
    t('the books balance to the piastre', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 220));
  });

  // ---------------------------------------------------------------- 14
  console.log('\n[14] A mixed day — statements, P&L and the balance sheet agree');
  await scenario(async ({ db, call }) => {
    seed(db);
    await voucher(call, { Amount: 500, Description: 'وارد عام' });
    await voucher(call, { VoucherType: 'payment', Amount: 200, Description: 'منصرف عام' });
    await voucher(call, { Amount: 700, PartyType: 'customer', PartyID: 1, PartyName: 'عميل', Description: 'سداد' });
    await voucher(call, { VoucherType: 'payment', Amount: 400, PartyType: 'supplier', PartyID: 1, PartyName: 'مورد', Description: 'سداد مورد' });
    await voucher(call, { Amount: 600, CashAccountID: undefined, PaymentMethodID: 1, Description: 'وارد ماكينة' });
    await call('rents:create', {
      RentName: 'كراج', RentType: 'expense', Amount: 1500, Period: 'monthly', StartDate: daysAgo(40),
    });
    await call('rents:generatePayments', 1, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID v FROM rent_payments LIMIT 1').v;
    await voucher(call, { VoucherType: 'payment', Amount: 1500, Description: 'إيجار', RentPaymentID: pid });

    t('the drawer is exactly where the day put it', near(cash(db), 100000 + 500 - 200 + 700 - 400 - 1500), `cash ${cash(db)}`);
    t('the machine is exactly where the day put it', near(wallet(db), 5600), `wallet ${wallet(db)}`);
    t('the customer debt reflects the day', near(customer(db), 1300), `customer ${customer(db)}`);
    t('the supplier debt reflects the day', near(supplier(db), 1100), `supplier ${supplier(db)}`);
    const p = await pl(call);
    t('the P&L sees general receipts, general expenses and rent — the machine receipt is income too',
      near(p?.revenue?.otherIncome ?? 0, 1100)
      && near(p?.expenses?.general ?? 0, 200) && near(p?.expenses?.rent ?? 0, 1500),
      `income ${p?.revenue?.otherIncome}, general ${p?.expenses?.general}, rent ${p?.expenses?.rent}`);
    t('the net profit agrees', near(p?.netProfit ?? 0, 500 - 200 - 1500 + 600), `profit ${p?.netProfit}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement foots to the drawer', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), cash(db) - 100000),
      `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots to the machine', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), wallet(db) - 5000),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the balance sheet holds the whole day', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
    const list = await call('vouchers:list', {});
    t('vouchers:list returns all six', Array.isArray(list) && list.length === 6, `rows ${list?.length}`);
    const typed = await call('vouchers:list', { type: 'receipt' });
    t('the type filter works', Array.isArray(typed) && typed.length === 3, `rows ${typed?.length}`);
  });

  // ---------------------------------------------------------------- 15
  console.log('\n[15] Sixty random vouchers never drift a piastre');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('rents:create', {
      RentName: 'كراج', RentType: 'expense', Amount: 600, Period: 'monthly', StartDate: daysAgo(60),
    });
    await call('rents:generatePayments', 1, 3, 1, 1);
    const pids = qa(db, 'SELECT RentPaymentID v FROM rent_payments ORDER BY DueDate').map(r => r.v);
    let expectedCash = 100000, expectedWallet = 5000, expectedProfit = 0;
    let rentIdx = 0;
    for (let i = 0; i < 60; i++) {
      const receipt = i % 2 === 0;
      const amount = Math.round((Math.random() * 800 + 0.05) * 100) / 100;
      const useRent = i % 6 === 5 && rentIdx < pids.length;
      const actual = useRent ? 300 : amount;
      const useMachine = i % 4 === 3 && (receipt || expectedWallet >= actual + 0.001);
      const kind = i % 3 === 1 ? 'customer' : i % 3 === 2 ? 'supplier' : 'general';
      const payload = {
        VoucherType: receipt ? 'receipt' : 'payment',
        Amount: actual,
        Description: `سند ${i}`,
        CashAccountID: useMachine ? undefined : 1,
        PaymentMethodID: useMachine ? 1 : undefined,
        ...(!useRent && kind === 'customer' ? { PartyType: 'customer', PartyID: 1, PartyName: 'عميل' } : {}),
        ...(!useRent && kind === 'supplier' ? { PartyType: 'supplier', PartyID: 1, PartyName: 'مورد' } : {}),
        ...(useRent ? { RentPaymentID: pids[rentIdx++] } : {}),
        userId: 1, fiscalYearId: 1,
      };
      const r = await safeCall(call, 'vouchers:create', payload);
      t(`random voucher ${i + 1} is accepted`, r?.success === true, r?.message ?? '');
      const net = receipt ? amount : -amount;
      if (useRent) {
        if (useMachine) expectedWallet -= 300; else expectedCash -= 300;
        expectedProfit -= 300;
      } else if (kind === 'general') {
        if (useMachine) expectedWallet += net; else expectedCash += net;
        expectedProfit += net;
      } else {
        if (useMachine) expectedWallet += net; else expectedCash += net;
      }
    }
    t('the drawer is exactly where the day put it', near(cash(db), expectedCash), `cash ${cash(db)} vs ${expectedCash}`);
    t('the machine is exactly where the day put it', near(wallet(db), expectedWallet), `wallet ${wallet(db)} vs ${expectedWallet}`);
    const p = await pl(call);
    t('the P&L agrees with the vouchers', near(p?.netProfit ?? 0, expectedProfit), `profit ${p?.netProfit} vs ${expectedProfit}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement foots to the drawer', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), cash(db) - 100000),
      `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots to the machine', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), wallet(db) - 5000),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the books balance after sixty moves', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 16
  console.log('\n[16] A payment voucher closes a commission exactly once — and deletion reopens it');
  await scenario(async ({ db, call }) => {
    seed(db);
    db.prepare(`
      INSERT INTO commissions (EmployeeID, CommissionType, Amount, Date, ReferenceType,
        ReferenceID, IsPaid, PaidAmount, PaidInSalaryID, FiscalYearID, UserID)
      VALUES (1, 'maintenance', 250, ?, 'maintenance', 1, 0, 0, NULL, 1, 1)
    `).run(fmt(new Date()));
    const cid = q(db, 'SELECT CommissionID v FROM commissions').v;

    const reject = await voucher(call, { Amount: 250, Description: 'لا', CommissionID: cid });
    t('a receipt cannot close a commission', reject?.success === false, reject?.message ?? '');
    const ghost = await voucher(call, { VoucherType: 'payment', Amount: 250, Description: 'x', CommissionID: 99999 });
    t('a ghost commission link is refused', ghost?.success === false, ghost?.message ?? '');
    const misAmt = await voucher(call, { VoucherType: 'payment', Amount: 100, Description: 'x', CommissionID: cid });
    t('a mismatched amount is refused', misAmt?.success === false, misAmt?.message ?? '');
    const bothLink = await voucher(call, { VoucherType: 'payment', Amount: 250, Description: 'x', CommissionID: cid, RentPaymentID: 1 });
    t('a rent AND commission link is refused', bothLink?.success === false, bothLink?.message ?? '');
    const withParty = await voucher(call, { VoucherType: 'payment', Amount: 250, Description: 'x', CommissionID: cid, PartyType: 'employee', PartyID: 1, PartyName: 'موظف' });
    t('a party cannot ride a commission voucher', withParty?.success === false, withParty?.message ?? '');

    const paid = await voucher(call, { VoucherType: 'payment', Amount: 250, Description: 'صرف عمولة فني', CommissionID: cid });
    t('the linked payment is accepted', paid?.success === true, paid?.message ?? '');
    const vrow = q(db, "SELECT * FROM vouchers WHERE ReferenceType = 'commission'");
    const com = q(db, 'SELECT * FROM commissions WHERE CommissionID = ?', cid);
    t('the voucher is stamped as a commission', vrow?.ReferenceID === cid, JSON.stringify(vrow ?? {}).slice(0, 140));
    t('the commission is closed by this voucher', com?.IsPaid === 1 && com?.PaidVoucherID === vrow?.VoucherID && near(com?.PaidAmount, 250) && !!com?.PaidDate,
      JSON.stringify(com ?? {}).slice(0, 140));
    t('the drawer paid it once', near(cash(db), 99750), `cash ${cash(db)}`);
    t('the employee ledger was not touched', near(employee(db), 1000), `employee ${employee(db)}`);

    const p = await pl(call);
    t('the P&L books the commission from the VOUCHER, once', near(p?.expenses?.general ?? 0, 250) && near(p?.expenses?.commissions ?? 0, 0),
      `general ${p?.expenses?.general}, commissions ${p?.expenses?.commissions}`);
    t('the net profit wears it once', near(p?.netProfit ?? 0, -250), `profit ${p?.netProfit}`);

    const again = await voucher(call, { VoucherType: 'payment', Amount: 250, Description: 'مرة أخرى', CommissionID: cid });
    t('closing a closed commission again is refused', again?.success === false, again?.message ?? '');

    const f0 = await fp(call);
    t('the books balance with the commission inside the voucher expense', balanced(f0), JSON.stringify(f0?.capital ?? {}).slice(0, 240));

    const del = await call('delete:voucher', vrow.VoucherID);
    t('deleting the commission voucher is accepted', del?.success === true, del?.message ?? '');
    const reopened = q(db, 'SELECT * FROM commissions WHERE CommissionID = ?', cid);
    t('the commission is owed again', reopened?.IsPaid === 0 && reopened?.PaidVoucherID === null,
      JSON.stringify(reopened ?? {}).slice(0, 140));
    t('the drawer got the cash back', near(cash(db), 100000), `cash ${cash(db)}`);
    const p2 = await pl(call);
    t('the P&L holds the accrual again', near(p2?.expenses?.general ?? 0, 0) && near(p2?.expenses?.commissions ?? 0, 250),
      `general ${p2?.expenses?.general}, commissions ${p2?.expenses?.commissions}`);
    const f = await fp(call);
    t('the books balance with the commission held as a liability', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  console.log(`\nSECTION 10 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_voucher_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}