#!/usr/bin/env node
// SECTION 7 — SERVICES & STATEMENTS: the counter services ledger and the
// reconciliation pages, executed against the REAL bundle on the REAL schema.
//
// Same harness as sections 5/6: an ESM entry re-exporting only the handler
// registration functions, esbuild CJS bundle, an electron stub, and a scratch
// userData directory. Every channel below runs the actual production code.
//
// The statements are a second view of the ledger written by independent SQL.
// Anything they disagree with the live balances by is a real drift, so each
// section ends by footing the statement against the account it describes.
import { build, } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerServicesHandlers } from './src/main/ipc/services.handlers.ts';
export { registerStatementHandlers, registerCustomerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerSalesHandlers } from './src/main/ipc/sales.handlers.ts';
export { registerPurchasesHandlers } from './src/main/ipc/purchases.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerMaintenanceHandlers } from './src/main/ipc/maintenance.handlers.ts';
export { registerPayrollHandlers } from './src/main/ipc/payroll.handlers.ts';
export { registerTransfersHandlers } from './src/main/ipc/transfers.handlers.ts';
export { registerRentHandlers } from './src/main/ipc/rent.handlers.ts';
export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_svc_entry.ts');
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
  userData = mkdtempSync(join(tmpdir(), 'svc-user-'));
  process.env.PAYROOT = userData;
  console.log('Building the real services/statements bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_svc_bundle.cjs');
  writeFileSync(bundleFile, out.outputFiles[0].text);
  const require = createRequire(import.meta.url);
  const mod = require(bundleFile);
  rmSync(bundleFile, { force: true });
  rmSync(entryFile, { force: true });

  const db = mod.getDb();
  mod.runMigrations(db);
  const registers = [
    mod.registerServicesHandlers, mod.registerStatementHandlers,
    mod.registerCustomerStatementHandlers, mod.registerSalesHandlers,
    mod.registerPurchasesHandlers, mod.registerVouchersHandlers,
    mod.registerMaintenanceHandlers, mod.registerPayrollHandlers,
    mod.registerTransfersHandlers, mod.registerRentHandlers,
    mod.registerDeleteHandlers, mod.registerReportsHandlers,
  ];
  for (const reg of registers) reg();

  const call = (channel, ...args) => {
    const fn = globalThis.__FOUND_HANDLERS__.get(channel);
    if (!fn) throw new Error(`channel not registered: ${channel}`);
    return fn({ sender: { id: 1 } }, ...args);
  };

  const PASS = [];
  const FAIL = [];
  const t = (name, ok, diag) => {
    if (ok) PASS.push(name); else FAIL.push(name);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        ${diag}`);
  };
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.01;

  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO cash_accounts (CashAccountID, AccountName, AccountType, Balance, IsActive)
      VALUES (2, 'خزينة معطلة', 'safe', 5000, 0);
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة رئيسية', 'card', 5000, 1),
             (2, 'محفظة معطلة', 'wallet', 5000, 0);
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'شاشة', 'accessory', 0, 40, 65, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (1, 1, 100, 40);
    INSERT INTO stock_lots (ItemID, WarehouseID, UnitCost, QtyReceived, QtyRemaining) VALUES (1, 1, 40, 100, 100);
    INSERT INTO customers (CustomerID, Name, Phone, Status, Balance)
      VALUES (1, 'عميل أحمد', '01111111111', 'active', 0),
             (2, 'وليد', '01000000002', 'active', 0);
    INSERT INTO suppliers (SupplierID, Name, Status, Balance) VALUES (1, 'مورد تور', 'active', 0);
    INSERT OR REPLACE INTO employees (EmployeeID, Name, Position, Department, BaseSalary, Allowances, Balance, IsActive)
      VALUES (1, 'سعيد الفني', 'فني', 'صيانة', 1000, 0, 0, 1);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '109000')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    INSERT INTO settings (Key, Value) VALUES ('allow_negative_cash', '0')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
  `);

  const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const mach = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const cust = (id = 1) => q('SELECT Balance v FROM customers WHERE CustomerID = ?', id).v;
  const sup = () => q('SELECT Balance v FROM suppliers WHERE SupplierID = 1').v;
  const tot = () => q('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = 1').v;
  const svcCount = () => q('SELECT COUNT(*) n FROM service_sales').n;

  let cashL = 100000;
  let machL = 5000;
  let cust1L = 0;
  let supL = 0;
  const sync = (label) => t(`${label} — the tracked balances match the ledger`,
    cash() === cashL && mach() === machL && cust(1) === cust1L && sup() === supL,
    `cash ${cash()} vs ${cashL}, mach ${mach()} vs ${machL}, cust1 ${cust(1)} vs ${cust1L}, sup ${sup()} vs ${supL}`);

  const raceProbe = (sabotage, restore) => {
    const realTx = db.transaction.bind(db);
    let fired = false;
    db.transaction = (fn) => {
      const wrapped = realTx(fn);
      return (...args) => {
        const wasFirst = !fired;
        try {
          if (!fired) { fired = true; sabotage(); }
          return wrapped(...args);
        } finally {
          db.transaction = realTx;
          if (wasFirst && restore) restore();
        }
      };
    };
  };
  const drainMachine = () => run('UPDATE payment_methods SET Balance = 0 WHERE PaymentMethodID = 1');
  const restoreMachine = () => run('UPDATE payment_methods SET Balance = ? WHERE PaymentMethodID = 1', machL);

  const service = (p) => call('serviceSales:create', { userId: 1, fiscalYearId: 1, ...p });
  const sell = (p) => call('sales:create', { fiscalYearId: 1, userId: 1, ...p });
  const buy = (p) => call('purchases:create', { fiscalYearId: 1, userId: 1, ...p });
  const sellBack = (p) => call('saleReturns:create', { fiscalYearId: 1, userId: 1, ...p });
  const buyBack = (p) => call('purchaseReturns:create', { userId: 1, ...p });
  const receipt = (p) => call('vouchers:create', { fiscalYearId: 1, userId: 1, ...p });

  console.log('SECTION 7 — SERVICES & STATEMENTS: the counter ledger on the real stack\n');

  // ---------------------------------------------------------------- 1
  console.log('[1] services — the door checks');
  {
    const lst = await call('serviceSales:list', {});
    t('a fresh shop has no services', Array.isArray(lst) && lst.length === 0,
      JSON.stringify(lst).slice(0, 80));

    const base = { CustomerName: 'عميل أحمد', ServiceType: 'topup', Provider: 'vodafone',
      TargetPhone: '01000000001', Amount: 100, ServiceCost: 0, ChargeAmount: 100, PaidAmount: 100, CashAccountID: 1 };

    const alien = await service({ ...base, ServiceType: 'ALIEN' });
    t('a junk service type is refused', alien?.success === false && /نوع الخدمة/.test(alien?.message ?? ''), alien?.message ?? JSON.stringify(alien));

    const alienP = await service({ ...base, Provider: 'ALIEN' });
    t('a junk provider is refused', alienP?.success === false && /المزوّد/.test(alienP?.message ?? ''), alienP?.message ?? JSON.stringify(alienP));

    const pageOther = await service({ ...base, Provider: 'مزوّد آخر' });
    t('the page\'s "other" provider LABEL is refused (the form must send the value)',
      pageOther?.success === false && /المزوّد/.test(pageOther?.message ?? ''), pageOther?.message ?? JSON.stringify(pageOther));

    const noTarget = await service({ ...base, TargetPhone: '' });
    t('a missing destination number is refused', noTarget?.success === false && noTarget?.message === 'رقم الوجهة مطلوب', noTarget?.message ?? '');

    const negAmount = await service({ ...base, Amount: -500 });
    t('a negative amount is refused', negAmount?.success === false, negAmount?.message ?? '');
    const negCharge = await service({ ...base, ChargeAmount: -4900 });
    t('a negative charge is refused', negCharge?.success === false, negCharge?.message ?? '');
    const negPaid = await service({ ...base, PaidAmount: -900 });
    t('a negative paid figure is refused', negPaid?.success === false, negPaid?.message ?? '');
    const nanPaid = await service({ ...base, PaidAmount: NaN });
    t('a NaN paid figure is refused', nanPaid?.success === false, nanPaid?.message ?? '');

    const junkPay = await service({ ...base, PaymentMethod: 'ALIEN' });
    t('a junk PaymentMethod is refused, not stored raw', junkPay?.success === false,
      junkPay?.message ?? 'accepted — stored unvalidated');

    const junkCust = await service({ ...base, CustomerID: {} });
    t('a junk customer id is refused', junkCust?.success === false, JSON.stringify(junkCust).slice(0, 80));
    const ghostCust = await service({ ...base, CustomerID: 999 });
    t('a ghost customer is refused', ghostCust?.success === false && ghostCust?.message === 'العميل غير موجود', ghostCust?.message ?? '');

    t('none of the refusals created anything', svcCount() === 0, `rows ${svcCount()}`);
    t('the drawer and the machine never moved', cash() === cashL && mach() === machL,
      `cash ${cash()} mach ${mach()}`);
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] a machine-funded transfer moves both accounts');
  {
    const s1 = await service({
      CustomerName: 'عميل أحمد', ServiceType: 'balance_transfer', Provider: 'fawry',
      TargetPhone: '01122223333', Amount: 1000, ServiceCost: 20, ChargeAmount: 1025,
      PaidAmount: 1025, PaymentMethod: 'cash', CashAccountID: 1, PaymentMethodID: 1, TransferCost: 5,
    });
    t('the transfer is booked', s1?.success === true && /^SRV-\d{8}-\d{4}$/.test(s1?.serviceNumber ?? ''), s1?.serviceNumber ?? JSON.stringify(s1));
    t('a paid-in-full transfer is completed with zero profit and zero remaining',
      s1?.status === 'completed' && near(s1?.profit, 0) && near(s1?.remaining, 0),
      JSON.stringify({ status: s1?.status, profit: s1?.profit, remaining: s1?.remaining }));

    machL -= 1000 + 25; cashL += 1025;
    t('the principal and the fees left the machine, the payment landed in the drawer',
      mach() === machL && cash() === cashL, `mach ${mach()} vs ${machL}, cash ${cash()} vs ${cashL}`);
    t('a paid-in-full transfer owes the customer nothing', cust(1) === 0, `${cust(1)}`);

    const got = await call('serviceSales:get', s1.serviceSaleID ?? (q('SELECT ServiceSaleID v FROM service_sales').v));
    t('the detail read returns the row with its customer', got?.ServiceNumber === s1.serviceNumber && got?.CustomerName === 'عميل أحمد',
      JSON.stringify(got).slice(0, 120));

    const lst = await call('serviceSales:list', {});
    t('the list sees exactly one operation', Array.isArray(lst) && lst.length === 1, `${lst?.length}`);
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] a partial payment books the debt — and the statement must show both legs');
  {
    const s2 = await service({
      CustomerID: 1, ServiceType: 'bill_payment', Provider: 'vodafone',
      TargetPhone: '01011112222', Amount: 300, ServiceCost: 0, ChargeAmount: 300,
      PaidAmount: 100, PaymentMethod: 'credit', CashAccountID: 1,
    });
    t('a partially-paid service is recorded as partial', s2?.success === true && s2?.status === 'partial',
      s2?.status ?? JSON.stringify(s2));
    t('its remaining figure is the unpaid share', near(s2?.remaining, 200), `${s2?.remaining}`);

    cashL -= 300 - 100; cust1L += 200;
    t('the principal left the drawer net of the payment, the debt went to the customer',
      cash() === cashL && cust(1) === cust1L, `cash ${cash()} vs ${cashL}, cust ${cust(1)} vs ${cust1L}`);

    const s2row = q('SELECT ServiceSaleID v FROM service_sales WHERE CustomerID = 1').v;
    const filter = await call('serviceSales:list', { customerId: 1 });
    t('the list filters to one customer', Array.isArray(filter) && filter.length === 1 && filter[0].ServiceSaleID === s2row, `${filter?.length}`);

    const cs = await call('customerStatement:get', 1, {});
    const svcOp = (cs.operations || []).find(o => o.OpType === 'service_sale');
    t('the customer statement carries the service with its true debit and credit',
      cs?.success === true && svcOp && near(svcOp.Debit, 300) && near(svcOp.Credit, 100),
      JSON.stringify(svcOp).slice(0, 140));
    t('the customer statement foots to the customer balance',
      near(cs.totals?.netBalance, cust1L) && near(cs.totals?.netBalance, cust(1)),
      `statement ${cs.totals?.netBalance} vs ledger ${cust(1)}`);

    const cashS = await call('cashAccount:statement', 1, {});
    const svcCash = (cashS.operations || []).filter(o => o.OpType === 'service_sale').find(o => o.RefID === s2row);
    t('the drawer statement shows the payment IN and the drawdown OUT on the same row',
      svcCash && near(svcCash.InAmount, 100) && near(svcCash.OutAmount, 300),
      JSON.stringify(svcCash).slice(0, 140));
    t('the drawer statement explains the whole movement',
      near((cashS.totalIn ?? 0) - (cashS.totalOut ?? 0), cashL - 100000),
      `net ${(cashS.totalIn ?? 0) - (cashS.totalOut ?? 0)} vs change ${cashL - 100000}`);
  }

  // ---------------------------------------------------------------- 4
  console.log('\n[4] deletion reverses every leg, exactly once');
  {
    const del2 = await call('delete:serviceSale', q('SELECT ServiceSaleID v FROM service_sales WHERE CustomerID = 1').v);
    t('deleting a partial service clears the debt and restores the drawer',
      del2?.success === true && cust(1) === 0 && cash() === 101025,
      `cust ${cust(1)}, cash ${cash()}`);
    cust1L = 0; cashL = 101025;

    const del2b = await call('delete:serviceSale', 99999);
    t('deleting it again is refused', del2b?.success === false && del2b?.message === 'العملية غير موجودة', del2b?.message ?? '');

    const s1id = q('SELECT ServiceSaleID v FROM service_sales WHERE PaymentMethodID = 1').v;
    const del1 = await call('delete:serviceSale', s1id);
    t('deleting a machine-funded transfer returns principal and fees to the machine',
      del1?.success === true && mach() === 5000 && cash() === 100000,
      `mach ${mach()}, cash ${cash()}`);
    machL = 5000; cashL = 100000;

    t('the services table is empty again', svcCount() === 0, `rows ${svcCount()}`);

    const fp = await call('reports:financialPosition');
    t('after deletions the books balance to the penny',
      Math.abs((fp?.capital?.difference ?? 1) - 0) < 0.01, JSON.stringify(fp?.capital ?? {}).slice(0, 160));
  }

  // ---------------------------------------------------------------- 5
  console.log('\n[5] the funding sources are real, active, and chosen');
  {
    const base = { ServiceType: 'topup', Provider: 'orange', TargetPhone: '01033334444',
      Amount: 1000, ServiceCost: 0, ChargeAmount: 1000, PaidAmount: 0 };

    const ghostMach = await service({ ...base, PaymentMethodID: 9999 });
    t('a ghost machine is refused as missing, not as broke',
      ghostMach?.success === false && ghostMach?.message === 'ماكينة الدفع المختارة غير موجودة',
      ghostMach?.message ?? 'accepted');

    const deadMach = await service({ ...base, PaymentMethodID: 2 });
    t('a deactivated machine is refused',
      deadMach?.success === false && deadMach?.message === 'ماكينة الدفع المختارة غير مفعّلة',
      deadMach?.message ?? 'accepted');

    const ghostCash = await service({ ...base, ServiceCost: 10, CashAccountID: 9999 });
    t('a ghost drawer is refused as missing, not as broke',
      ghostCash?.success === false && ghostCash?.message === 'الخزنة المختارة غير موجودة',
      ghostCash?.message ?? 'accepted');

    const deadCash = await service({ ...base, ServiceCost: 10, CashAccountID: 2 });
    t('a deactivated drawer is refused',
      deadCash?.success === false && deadCash?.message === 'الخزنة المختارة غير مفعّلة',
      deadCash?.message ?? 'accepted');

    const orphan = await service({ ...base, PaidAmount: 500, CashAccountID: undefined, PaymentMethodID: undefined });
    t('a payment with no destination is refused, not booked into thin air',
      orphan?.success === false && orphan?.message === 'اختر مصدر استلام المبلغ (خزنة أو ماكينة)',
      orphan?.message ?? `accepted — ${svcCount()} rows`);

    const brokeMach = await service({ ...base, Amount: 5200, PaidAmount: 5200, CashAccountID: 1, PaymentMethodID: 1 });
    t('an underfunded machine refuses with its numbers',
      brokeMach?.success === false && /الرصيد غير كافٍ في طريقة الدفع: المتاح 5000\.00، المطلوب 5200\.00/.test(brokeMach?.message ?? ''),
      brokeMach?.message ?? 'accepted');

    const brokeCash = await service({ ...base, ServiceCost: 100005, PaidAmount: 0, CashAccountID: 1 });
    t('an underfunded drawer refuses with its numbers',
      brokeCash?.success === false && /الرصيد غير كافٍ في الخزينة: المتاح 100000\.00، المطلوب 101005\.00/.test(brokeCash?.message ?? ''),
      brokeCash?.message ?? 'accepted');

    t('none of the refusals moved a single pound', cash() === 100000 && mach() === 5000 && svcCount() === 0,
      `cash ${cash()}, mach ${mach()}, rows ${svcCount()}`);

    // The DB enforces a non-negative floor on cash and machines with triggers
    // (`cash balance must not be negative`, `wallet balance must not be
    // negative`) that no setting overrides. So even with the friendly guard
    // switched off, the overdraw aborts and nothing is saved — the setting
    // only changes which message the user sees.
    run("UPDATE settings SET Value = '1' WHERE Key = 'allow_negative_cash'");
    const neg1 = await service({ ...base, Amount: 100005, ChargeAmount: 100000, ServiceCost: 5, PaidAmount: 0, CashAccountID: 1 });
    t('even with negative cash allowed the DB floor holds — the overdraw aborts, nothing is saved',
      neg1?.success === false && cash() === 100000 && svcCount() === 0,
      `${neg1?.message ?? 'accepted'} — cash ${cash()}`);
    const neg2 = await service({ ...base, Amount: 5200, PaidAmount: 0, PaymentMethodID: 1 });
    t('the machine refuses with its numbers regardless of the setting',
      neg2?.success === false && /الرصيد غير كافٍ في طريقة الدفع: المتاح 5000\.00، المطلوب 5200\.00/.test(neg2?.message ?? ''),
      neg2?.message ?? 'accepted');
    run("UPDATE settings SET Value = '0' WHERE Key = 'allow_negative_cash'");
    t('none of it moved a single pound', cash() === 100000 && mach() === 5000 && svcCount() === 0,
      `cash ${cash()}, mach ${mach()}, rows ${svcCount()}`);
  }

  // ---------------------------------------------------------------- 6
  console.log('\n[6] a rival till drains the funding source between the check and the write');
  {
    raceProbe(drainMachine, restoreMachine);
    const raced = await service({
      ServiceType: 'balance_transfer', Provider: 'fawry', TargetPhone: '01044445555',
      Amount: 1000, ServiceCost: 20, ChargeAmount: 1025, PaidAmount: 1025,
      PaymentMethod: 'cash', CashAccountID: 1, PaymentMethodID: 1, TransferCost: 5,
    });
    t('the drained machine refuses the transfer instead of overdrawing',
      raced?.success === false && /الرصيد غير كافٍ في طريقة الدفع: المتاح 0\.00، المطلوب 1025\.00/.test(raced?.message ?? ''),
      raced?.message ?? `accepted — machine now ${mach()}`);
    t('the books are untouched by the race', cash() === 100000 && mach() === 5000 && cust(1) === 0 && svcCount() === 0,
      `cash ${cash()}, mach ${mach()}, rows ${svcCount()}`);
  }

  // ---------------------------------------------------------------- 7
  console.log('\n[7] the mixed day — both statements foot to the accounts they describe');
  {
    // A card sale with a fee the shop absorbs.
    const s = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 65 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 130,
      PaymentMethod: 'card', PaymentMethodID: 1, TransferCost: 5, TransferCostBearer: 'shop' });
    t('a card sale is booked', s?.success === true, JSON.stringify(s).slice(0, 100));
    machL += 125; sync('sale');
    const saleId = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC').v;

    // Refund the whole sale back through the same machine. The customer
    // receives the 130 they paid; the machine pays that PLUS the 5 fee — the
    // settlement rule divides only the document value (TotalAmount = the
    // legs), and the shop-bearer fee leaves as an extra outflow.
    const sr = await sellBack({ SaleID: saleId, CustomerID: 1,
      items: [{ ItemID: 1, Quantity: 2, UnitPrice: 65 }], Reason: 'إلغاء',
      TransferRefund: 130, PaymentMethodID: 1, TransferCost: 5, TransferCostBearer: 'shop' });
    t('the machine refund is booked with its fee', sr?.success === true, JSON.stringify(sr).slice(0, 100));
    machL -= 135; sync('return');
    const retId = q('SELECT ReturnID v FROM sale_returns ORDER BY ReturnID DESC').v;

    // A purchase partly paid from the drawer.
    const p = await buy({ SupplierID: 1, items: [{ ItemID: 1, Quantity: 5, UnitCost: 80, WarehouseID: 1 }],
      Discount: 0, TaxAmount: 0, PaidAmount: 100, PaymentSourceType: 'cash_account', PaymentSourceID: 1 });
    t('a cash purchase is booked', p?.success === true, JSON.stringify(p).slice(0, 100));
    cashL -= 100; supL += 300; sync('purchase');
    const purId = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC').v;

    // Return one line back through the machine. The refund pays the shop's own
    // money back — the returned VALUE stays against what we owe the supplier
    // (the goods came back), so their balance does not move for a fully
    // refunded return.
    const pr = await buyBack({ PurchaseID: purId, SupplierID: 1,
      items: [{ ItemID: 1, Quantity: 1, UnitCost: 80, WarehouseID: 1 }], Reason: 'تالف',
      TransferRefund: 80, PaymentMethodID: 1 });
    t('the machine refund of the purchase is booked', pr?.success === true, JSON.stringify(pr).slice(0, 100));
    machL += 80; sync('purchase return');

    // General vouchers.
    const vr = await receipt({ VoucherType: 'receipt', Amount: 200, Date: '2026-08-12', PartyType: null, PartyID: null, PartyName: '', Description: 'وارد', CashAccountID: 1 });
    t('a general receipt is booked', vr?.success === true, JSON.stringify(vr).slice(0, 100));
    cashL += 200; sync('receipt');
    const vrId = q("SELECT VoucherID v FROM vouchers WHERE VoucherType = 'receipt'").v;
    const vp = await receipt({ VoucherType: 'payment', Amount: 50, Date: '2026-08-12', PartyType: null, PartyID: null, PartyName: '', Description: 'منصرف', CashAccountID: 1 });
    t('a general payment is booked', vp?.success === true, JSON.stringify(vp).slice(0, 100));
    cashL -= 50; sync('payment');
    const vpId = q("SELECT VoucherID v FROM vouchers WHERE VoucherType = 'payment'").v;

    // A partial counter service funded from the drawer.
    const sp = await service({ CustomerID: 1, ServiceType: 'bill_payment', Provider: 'vodafone',
      TargetPhone: '01055556666', Amount: 300, ServiceCost: 0, ChargeAmount: 300,
      PaidAmount: 100, PaymentMethod: 'credit', CashAccountID: 1 });
    t('a partial service is booked', sp?.success === true, JSON.stringify(sp).slice(0, 100));
    cashL -= 200; cust1L += 200; sync('partial service');
    const spId = q('SELECT ServiceSaleID v FROM service_sales WHERE ServiceNumber = ?', sp.serviceNumber).v;

    // A full machine-funded transfer, paid at the counter.
    const pm = await service({ ServiceType: 'balance_transfer', Provider: 'fawry',
      TargetPhone: '01066667777', Amount: 1000, ServiceCost: 20, ChargeAmount: 1025,
      PaidAmount: 1025, PaymentMethod: 'cash', CashAccountID: 1, PaymentMethodID: 1, TransferCost: 5 });
    t('a machine-funded service is booked', pm?.success === true, JSON.stringify(pm).slice(0, 100));
    machL -= 1025; cashL += 1025; sync('machine service');
    const pmId = q('SELECT ServiceSaleID v FROM service_sales WHERE ServiceNumber = ?', pm.serviceNumber).v;

    // An advance, and a salary that swallows it.
    const adv = await call('advances:create', { EmployeeID: 1, Amount: 300, Reason: 'سلفة', CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('an advance leaves the drawer', adv?.success === true && cash() === cashL - 300, JSON.stringify(adv).slice(0, 100));
    cashL -= 300; const advId = q('SELECT AdvanceID v FROM employee_advances ORDER BY AdvanceID DESC').v;
    const iss = await call('salaries:issue', { EmployeeID: 1, Month: '2026-08', userId: 1, fiscalYearId: 1 });
    t('the salary is issued against the advanced money', iss?.success === true, JSON.stringify(iss).slice(0, 100));
    const salId = q('SELECT SalaryID v FROM salaries ORDER BY SalaryID DESC').v;
    const pay = await call('salaries:pay', { SalaryID: salId, CashAccountID: 1, userId: 1 });
    t('the net pay leaves the drawer once', pay?.success === true && cash() === cashL - 700,
      `${pay?.success}, cash ${cash()} vs ${cashL - 700}`);
    cashL -= 700; sync('salary');

    // A repair delivered and later returned — both legs on the drawer statement.
    const tech = q("SELECT EmployeeID v FROM employees WHERE Name = 'سعيد الفني'").v;
    const rec = await call('maintenance:receive', { CustomerID: 2, CustomerName: 'وليد', DeviceModel: 'iPhone 12', ProblemDesc: 'واجهة', TechnicianID: tech, userId: 1, fiscalYearId: 1 });
    t('a repair ticket is opened', rec?.success === true, JSON.stringify(rec).slice(0, 100));
    const T = rec.ticketId;
    const ip = await call('maintenance:issuePart', { TicketID: T, ItemID: 1, Quantity: 1, WarehouseID: 1, userId: 1 });
    t('a part is consumed', ip?.success === true, JSON.stringify(ip).slice(0, 100));
    const dl = await call('maintenance:deliver', { TicketID: T, LaborCost: 25, FinalPrice: 65, PaymentMethod: 'cash', PaidAmount: 65, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('the repair is delivered against the drawer', dl?.success === true, JSON.stringify(dl).slice(0, 100));
    cashL += 65; sync('delivery');
    const delId = q('SELECT DeliveryID v FROM maintenance_deliveries ORDER BY DeliveryID DESC').v;
    const rn = await call('maintenance:return', { TicketID: T, DeliveryID: delId, Reason: 'عيب', TotalRefund: 65, CashAccountID: 1, PartsRestored: 1, userId: 1, fiscalYearId: 1 });
    t('the rejected repair is refunded from the drawer', rn?.success === true, JSON.stringify(rn).slice(0, 100));
    cashL -= 65; sync('maintenance return');

    // A rent payment received.
    const rent = await call('rents:create', { RentName: 'محل', RentType: 'income', Amount: 600, Period: 'yearly', StartDate: '2026-01-01' });
    t('a rent contract exists', rent?.success === true, JSON.stringify(rent).slice(0, 100));
    const gp = await call('rents:generatePayments', rent.id, 12, 1, 1);
    t('its schedule is generated', gp?.success === true || (gp && gp.created), JSON.stringify(gp).slice(0, 100));
    const rentPayId = q('SELECT RentPaymentID v FROM rent_payments LIMIT 1').v;
    const rp = await call('rentPayments:pay', { RentPaymentID: rentPayId, CashAccountID: 1, Amount: 50, userId: 1, fiscalYearId: 1 });
    t('the first rent is received', rp?.success === true, JSON.stringify(rp).slice(0, 100));
    cashL += 50; sync('rent');

    // A transfer out of the drawer into the machine.
    const tr = await call('transfers:create', { FromType: 'cash_account', FromID: 1, ToType: 'payment_method', ToID: 1,
      Amount: 100, TransferCost: 2, TransferCostSource: 'separate', Notes: 'تحويل', userId: 1, fiscalYearId: 1 });
    t('the transfer is booked with its fee', tr?.success === true, JSON.stringify(tr).slice(0, 100));
    cashL -= 102; machL += 100; sync('transfer');

    t('the stock returned to its starting level after the return', tot() === 104, `${tot()}`);

    const cs = await call('cashAccount:statement', 1, {});
    const cashOps = cs.operations || [];
    const byType = (type) => cashOps.filter(o => o.OpType === type);
    t('the drawer statement shows every kind of operation',
      ['purchase', 'voucher_receipt', 'voucher_payment', 'service_sale', 'advance', 'salary',
        'maintenance_delivery', 'maintenance_return', 'rent', 'transfer_out']
        .every(k => byType(k).length > 0),
      [...new Set(cashOps.map(o => o.OpType))].join(','));
    const partSvc = byType('service_sale').find(o => o.RefID === spId);
    const machSvc = byType('service_sale').find(o => o.RefID === pmId);
    t('the partial service shows the payment IN and the drawdown OUT',
      partSvc && near(partSvc.InAmount, 100) && near(partSvc.OutAmount, 300), JSON.stringify(partSvc).slice(0, 140));
    t('the machine-funded service shows only its payment IN',
      machSvc && near(machSvc.InAmount, 1025) && near(machSvc.OutAmount, 0), JSON.stringify(machSvc).slice(0, 140));
    t('the salary and the advance each show their outflow',
      byType('salary')[0] && near(byType('salary')[0].OutAmount, 700) && byType('advance')[0] && near(byType('advance')[0].OutAmount, 300),
      `${byType('salary')[0]?.OutAmount}/${byType('advance')[0]?.OutAmount}`);
    t('the whole drawer statement foots to the tracked drawer',
      near((cs.totalIn ?? 0) - (cs.totalOut ?? 0), cashL - 100000),
      `net ${(cs.totalIn ?? 0) - (cs.totalOut ?? 0)} vs change ${cashL - 100000}`);

    const ms = await call('paymentMethod:statement', 1, {});
    const machOps = ms.operations || [];
    const mByType = (type) => machOps.filter(o => o.OpType === type);
    t('the machine statement shows every kind of movement',
      ['sale', 'return', 'purchase_return', 'service_sale', 'transfer_in'].every(k => mByType(k).length > 0),
      [...new Set(machOps.map(o => o.OpType))].join(','));
    t('the machine statement nets the provider fee on the way in and out',
      near(mByType('sale')[0].InAmount, 125) && near(mByType('return')[0].OutAmount, 135) && near(mByType('purchase_return')[0].InAmount, 80),
      JSON.stringify(machOps.map(o => [o.OpType, o.InAmount, o.OutAmount])).slice(0, 200));
    t('the machine-funded service shows its whole outflow',
      mByType('service_sale')[0] && near(mByType('service_sale')[0].OutAmount, 1025), JSON.stringify(mByType('service_sale')[0]).slice(0, 140));
    t('the whole machine statement foots to the tracked machine',
      near((ms.totalIn ?? 0) - (ms.totalOut ?? 0), machL - 5000),
      `net ${(ms.totalIn ?? 0) - (ms.totalOut ?? 0)} vs change ${machL - 5000}`);
  }

  // ---------------------------------------------------------------- 8
  console.log('\n[8] the customer statement foots to the customer');
  {
    const s1 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 1, UnitPrice: 65 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 65, PaymentMethod: 'cash', CashAccountID: 1 });
    t('a paid-in-full sale is booked', s1?.success === true, JSON.stringify(s1).slice(0, 100));
    cashL += 65; sync('cash sale');

    const s2 = await sell({ CustomerID: 1, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 65 }],
      Discount: 0, TaxRate: 0, TaxAmount: 0, PaidAmount: 50, PaymentMethod: 'cash', CashAccountID: 1 });
    t('a partly-paid sale is booked', s2?.success === true, JSON.stringify(s2).slice(0, 100));
    cashL += 50; cust1L += 80; sync('credit sale');

    const vr = await receipt({ VoucherType: 'receipt', Amount: 100, Date: '2026-08-12', PartyType: 'customer', PartyID: 1, PartyName: 'عميل أحمد', Description: 'دفعة', CashAccountID: 1 });
    t('the customer settles part of the debt', vr?.success === true, JSON.stringify(vr).slice(0, 100));
    cashL += 100; cust1L -= 100; sync('settlement');

    const tech = q("SELECT EmployeeID v FROM employees WHERE Name = 'سعيد الفني'").v;
    const rec = await call('maintenance:receive', { CustomerID: 1, CustomerName: 'عميل أحمد', DeviceModel: 'Samsung A52', ProblemDesc: 'شاشة', TechnicianID: tech, userId: 1, fiscalYearId: 1 });
    const T = rec.ticketId;
    await call('maintenance:issuePart', { TicketID: T, ItemID: 1, Quantity: 1, WarehouseID: 1, userId: 1 });
    const dl = await call('maintenance:deliver', { TicketID: T, LaborCost: 25, FinalPrice: 65, PaymentMethod: 'credit', PaidAmount: 0, userId: 1, fiscalYearId: 1 });
    t('a repair delivered on credit', dl?.success === true, JSON.stringify(dl).slice(0, 100));
    cust1L += 65; sync('repair on credit');

    const st = await call('customerStatement:get', 1, {});
    const ops = st.operations || [];
    const row = (type) => ops.find(o => o.OpType === type);
    // The customer's full history: the card sale returned through the machine
    // and the partial counter service carry over from [7], then the three
    // documents created here plus the repair delivered on credit.
    t('every one of the seven documents is on the statement', ops.length === 7,
      ops.map(o => `${o.OpType}:${o.Debit}/${o.Credit}`).join(' | '));
    t('each document carries its own debits and credits',
      row('sale') && row('service_sale') && row('voucher_receipt') && row('maintenance_delivery')
      && near((ops.filter(o => o.OpType === 'sale').reduce((s, x) => s + (x.Debit || 0), 0)), 325)
      && near((ops.filter(o => o.OpType === 'sale').reduce((s, x) => s + (x.Credit || 0), 0)), 245)
      && near(row('service_sale').Debit, 300) && near(row('service_sale').Credit, 100)
      && near(row('voucher_receipt').Credit, 100)
      && near(row('maintenance_delivery').Debit, 65) && near(row('maintenance_delivery').Credit, 0),
      ops.map(o => `${o.OpType}:${o.Debit}/${o.Credit}`).join(' | '));
    t('the running balance lands on the real closing figure',
      ops.length > 0 && near(ops[ops.length - 1].Balance, cust1L), `${ops[ops.length - 1]?.Balance} vs ${cust1L}`);
    t('the statement foots to the customer balance',
      near(st.totals?.netBalance, cust1L) && near(st.totals?.currentBalance, cust(1)),
      `net ${st.totals?.netBalance}, current ${st.totals?.currentBalance} vs ledger ${cust(1)}`);
  }

  // ---------------------------------------------------------------- 9
  console.log('\n[9] the supplier statement foots to the supplier');
  {
    const pv = await receipt({ VoucherType: 'payment', Amount: 120, Date: '2026-08-12', PartyType: 'supplier', PartyID: 1, PartyName: 'مورد تور', Description: 'دفعة', CashAccountID: 1 });
    t('the shop settles part of what it owes', pv?.success === true, JSON.stringify(pv).slice(0, 100));
    cashL -= 120; supL -= 120; sync('supplier settlement');

    const st = await call('supplierStatement:get', 1, {});
    const ops = st.operations || [];
    const row = (type) => ops.find(o => o.OpType === type);
    t('purchase, return and settlement all appear', ops.length === 3,
      ops.map(o => `${o.OpType}:${o.Debit}/${o.Credit}`).join(' | '));
    t('the credit legs are the debt, the debits are the payments',
      row('purchase') && near(row('purchase').Debit, 100) && near(row('purchase').Credit, 400)
      && row('purchase_return') && near(row('purchase_return').Debit, 80) && near(row('purchase_return').Credit, 80)
      && near(row('voucher_payment').Debit, 120),
      ops.map(o => `${o.OpType}:${o.Debit}/${o.Credit}`).join(' | '));
    t('the statement foots to what the shop really owes',
      near(st.totals?.netBalance, supL) && near(st.totals?.currentBalance, sup()),
      `net ${st.totals?.netBalance}, current ${st.totals?.currentBalance} vs ledger ${sup()}`);
  }

  // ---------------------------------------------------------------- 10
  console.log('\n[10] the operation detail answers for every real operation');
  {
    const tech = q("SELECT EmployeeID v FROM employees WHERE Name = 'سعيد الفني'").v;
    const rec = await call('maintenance:receive', { CustomerID: 2, CustomerName: 'وليد', DeviceModel: 'iPhone 12', ProblemDesc: 'واجهة', TechnicianID: tech, userId: 1, fiscalYearId: 1 });
    const T = rec.ticketId;
    await call('maintenance:issuePart', { TicketID: T, ItemID: 1, Quantity: 1, WarehouseID: 1, userId: 1 });
    const dl = await call('maintenance:deliver', { TicketID: T, LaborCost: 25, FinalPrice: 65, PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    cashL += 100; sync('detail delivery');

    const saleId = q("SELECT SaleID v FROM sales WHERE Source = 'maintenance' ORDER BY SaleID DESC LIMIT 1").v;
    const delId = q('SELECT DeliveryID v FROM maintenance_deliveries ORDER BY DeliveryID DESC LIMIT 1').v;
    const comId = q('SELECT CommissionID v FROM commissions ORDER BY CommissionID DESC LIMIT 1').v;
    const retId = q('SELECT ReturnID v FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').v;
    const purId = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v;
    const vrId = q("SELECT VoucherID v FROM vouchers WHERE VoucherType = 'receipt' ORDER BY VoucherID DESC LIMIT 1").v;
    const vpId = q("SELECT VoucherID v FROM vouchers WHERE VoucherType = 'payment' ORDER BY VoucherID DESC LIMIT 1").v;
    const advId = q('SELECT AdvanceID v FROM employee_advances ORDER BY AdvanceID DESC LIMIT 1').v;
    const salId = q('SELECT SalaryID v FROM salaries ORDER BY SalaryID DESC LIMIT 1').v;

    const cases = [
      ['sale', saleId, 'فاتورة بيع'],
      ['sale_return', retId, 'مرتجع مبيعات'],
      ['maintenance_delivery', delId, 'تسليم صيانة'],
      ['purchase', purId, 'فاتورة شراء'],
      ['purchase_return', purId, 'مرتجع مشتريات'],
      ['voucher_receipt', vrId, 'سند قبض'],
      ['voucher_payment', vpId, 'سند صرف'],
      ['salary', salId, 'راتب'],
      ['advance', advId, 'سلفية'],
      ['commission', comId, 'عمولة'],
    ];
    for (const [op, id, title] of cases) {
      const d = await call('statement:getOperationDetail', op, id);
      t(`detail answers for ${op}`, d && d.title === title, JSON.stringify(d).slice(0, 100));
    }

    const svcId = q('SELECT ServiceSaleID v FROM service_sales ORDER BY ServiceSaleID DESC LIMIT 1').v;
    const sd = await call('statement:getOperationDetail', 'service_sale', svcId);
    t('detail answers for a service operation too', sd && sd.title === 'خدمة', JSON.stringify(sd).slice(0, 100));

    const alien = await call('statement:getOperationDetail', 'space_alien', 1);
    t('an unknown operation type answers nothing', alien === null, JSON.stringify(alien));
  }

  // ---------------------------------------------------------------- 11
  console.log('\n[11] closing — the books still balance');
  {
    const fp = await call('reports:financialPosition');
    const p = await call('reports:profitLoss', { fromDate: '2026-08-01', toDate: '2026-08-31' });
    t('the balance sheet cash equals the tracked drawer', near(fp?.assets?.totalCash, cashL),
      `${fp?.assets?.totalCash} vs ${cashL}`);
    t('the balance sheet machine equals the tracked machine', near(fp?.assets?.totalPaymentMethods, machL),
      `${fp?.assets?.totalPaymentMethods} vs ${machL}`);
    t('the balance sheet customers equal the tracked debts',
      near(fp?.assets?.totalCustomers, Math.max(0, cust(1)) + Math.max(0, cust(2)))
      && near(fp?.liabilities?.totalCustomerCredits, Math.max(0, -cust(1)) + Math.max(0, -cust(2))),
      `assets ${fp?.assets?.totalCustomers}, credits ${fp?.liabilities?.totalCustomerCredits} vs ${cust(1)}, ${cust(2)}`);
    t('the inventory is valued at the cost layers',
      near(fp?.assets?.totalInventory, tot() * (q('SELECT CostPrice v FROM stock_quantities WHERE ItemID = 1')?.v || 0)),
      `${fp?.assets?.totalInventory} vs ${tot() * (q('SELECT CostPrice v FROM stock_quantities WHERE ItemID = 1')?.v || 0)}`);
    t('assets = liabilities + equity exactly',
      Math.abs((fp?.capital?.difference ?? 1) - 0) < 0.01,
      JSON.stringify({ a: fp?.assets?.totalAssets, l: fp?.liabilities?.totalLiabilities, c: fp?.capital }).slice(0, 220));
    t('P&L and the balance sheet compute the SAME profit',
      near(p?.netProfit ?? NaN, fp?.capital?.netProfit ?? NaN), `${p?.netProfit} vs ${fp?.capital?.netProfit}`);
    t('the service profit is netted honestly (revenue minus principal minus costs)',
      near(p?.revenue?.services, 25) && near(p?.costs?.serviceCosts, 25),
      `revenue ${p?.revenue?.services}, costs ${p?.costs?.serviceCosts}`);
  }

  console.log(`\nSECTION 7 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  if (userData) { try { rmSync(userData, { recursive: true, force: true }); } catch { /* db still open */ } }
}