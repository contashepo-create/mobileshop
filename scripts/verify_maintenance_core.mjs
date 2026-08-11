// SECTION 6 — MAINTENANCE: the workshop ledger on the real stack.
// Behavioural suite over the real handlers, real database, real bundle
// (esbuild from actual TS + electron stub + throwaway userData).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const ENTRY = `
export { getDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerMaintenanceHandlers } from './src/main/ipc/maintenance.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
export { registerPayrollHandlers } from './src/main/ipc/payroll.handlers.ts';
export { registerHrHandlers } from './src/main/ipc/hr.handlers.ts';
export { registerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerTransfersHandlers } from './src/main/ipc/transfers.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_maint_entry.ts');
writeFileSync(entryFile, ENTRY);

const electronStub = `
const path = require('path');
const { EventEmitter } = require('events');
const emitter = new EventEmitter();
emitter.getPath = (k) => process.env.PAYROOT + '/data';
emitter.dirname = require('path').dirname;
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

const paths = {
  userData: mkdtempSync(join(tmpdir(), 'mnt-user-')),
};
process.env.PAYROOT = paths.userData;

console.log('Building the real maintenance bundle…');
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
const bundleFile = join(PROJECT_ROOT, '_maint_bundle.cjs');
writeFileSync(bundleFile, out.outputFiles[0].text);
const mod = require(bundleFile);
rmSync(bundleFile, { force: true });
rmSync(entryFile, { force: true });

const db = mod.getDb();
mod.runMigrations(db);
mod.registerMaintenanceHandlers();
mod.registerReportsHandlers();
mod.registerDeleteHandlers();
mod.registerPayrollHandlers();
mod.registerHrHandlers();
mod.registerStatementHandlers();
mod.registerVouchersHandlers();
mod.registerTransfersHandlers();

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

try {
  // ------------------------------------------------------------ setup
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
      VALUES (1, 'شاشة', 'accessory', 0, 40, 65, 1),
             (2, 'كابل', 'accessory', 0, 10, 15, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 100, 40), (2, 1, 50, 10);
    INSERT INTO stock_lots (ItemID, WarehouseID, UnitCost, QtyReceived, QtyRemaining)
      VALUES (1, 1, 40, 100, 100), (2, 1, 10, 50, 50);
    INSERT INTO customers (CustomerID, Name, Phone, Status, Balance)
      VALUES (1, 'عميل أحمد', '01111111111', 'active', 0);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '109500');
  `);

  const cash = () => q('SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const mach = () => q('SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const tot = (itemId) => q('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ?', itemId).v;
  const lots = (itemId) => q('SELECT COALESCE(SUM(QtyRemaining * UnitCost),0) v FROM stock_lots WHERE ItemID = ?', itemId).v;
  const cust = (id) => q('SELECT Balance v FROM customers WHERE CustomerID = ?', id).v;
  const tkt = (id) => q('SELECT * FROM maintenance_tickets WHERE TicketID = ?', id);
  const partRows = (ticketId) => qa('SELECT * FROM maintenance_parts WHERE TicketID = ?', ticketId);
  const empCom = (empid) => q('SELECT COALESCE(SUM(Amount),0) v FROM commissions WHERE EmployeeID = ? AND IsPaid = 0', empid).v;

  const receive = (p) => call('maintenance:receive', { userId: 1, fiscalYearId: 1, ...p });
  const issuePart = (p) => call('maintenance:issuePart', { userId: 1, ...p });
  const deliver = (p) => call('maintenance:deliver', { userId: 1, fiscalYearId: 1, ...p });
  const retn = (p) => call('maintenance:return', { userId: 1, fiscalYearId: 1, ...p });

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
  const emptyDrawer = () => run('UPDATE cash_accounts SET Balance = 0 WHERE CashAccountID = 1');
  const restoreDrawer = () => run('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = 1', cashL);
  const emptyShelf = () => {
    run('UPDATE stock_quantities SET Quantity = 0 WHERE ItemID = 1 AND WarehouseID = 1');
    run('UPDATE stock_lots SET QtyRemaining = 0 WHERE ItemID = 1 AND WarehouseID = 1');
  };
  const restoreShelf = () => {
    run('UPDATE stock_quantities SET Quantity = 98 WHERE ItemID = 1 AND WarehouseID = 1');
    run('UPDATE stock_lots SET QtyRemaining = 98 WHERE ItemID = 1 AND WarehouseID = 1');
  };

  let cashL = 100000;
  let machL = 5000;

  console.log('SECTION 6 — MAINTENANCE: the workshop ledger on the real stack\n');

  // ---------------------------------------------------------------- 1
  console.log('[1] receive — tickets, auto-customers, and the door checks');
  let T1, T2, T3, T4, T5, T6, T8, R7; // ticket ids, filled as we go
  let CUST; // auto-created walk-in customer id
  {
    const tech = await call('employees:create', { Name: 'سعيد الفني', Position: 'فني', Department: 'صيانة', BaseSalary: 0 });
    t('a technician exists for commissions', tech?.success === true, JSON.stringify(tech));
    globalThis.__TECH__ = tech.id;

    const r1 = await receive({ CustomerName: 'وليد', CustomerPhone: '62', DeviceModel: 'Samsung A52', DeviceIMEI: '356030010000001', ProblemDesc: 'شاشة مكسورة', AgreedCost: 700, TechnicianID: globalThis.__TECH__ });
    t('a walk-in ticket is received', r1?.success === true && typeof r1?.ticketId === 'number', JSON.stringify(r1));
    T1 = r1.ticketId;
    t('the ticket number follows the counter', /^MNT-2026\d{4}-\d{4}$/.test(r1.ticketNumber ?? ''), r1.ticketNumber);
    CUST = q('SELECT CustomerID v FROM customers WHERE Name = ?', 'وليد').v;
    t('the walk-in customer is auto-registered', !!CUST, `id ${CUST}`);
    t('the ticket starts received with a log entry',
      tkt(T1).Status === 'received' && q('SELECT COUNT(*) n FROM maintenance_status_log WHERE TicketID = ?', T1).n === 1, 'log');

    const r1b = await receive({ CustomerName: 'وليد', CustomerPhone: '62', DeviceModel: 'Xiaomi', ProblemDesc: 'بطارية' });
    t('re-receiving the same name+phone REUSES the customer',
      r1b?.success === true && q('SELECT CustomerID v FROM maintenance_tickets WHERE TicketID = ?', r1b.ticketId).v === CUST, 'customer reuse');

    const r2 = await receive({ CustomerID: 1, CustomerName: 'عميل أحمد', DeviceModel: 'iPhone 12', ProblemDesc: 'واجهة' });
    t('a registered customer can be named directly', r2?.success === true, JSON.stringify(r2));
    T2 = r2.ticketId;

    const noName = await receive({ DeviceModel: 'X', ProblemDesc: 'Y' });
    t('a missing customer name is refused', noName?.success === false && noName?.message === 'اسم العميل مطلوب', noName?.message ?? JSON.stringify(noName));
    const noModel = await receive({ CustomerName: 'أ', ProblemDesc: 'Y' });
    t('a missing device model is refused', noModel?.success === false && noModel?.message === 'موديل الجهاز مطلوب', noModel?.message ?? JSON.stringify(noModel));
    const noProblem = await receive({ CustomerName: 'أ', DeviceModel: 'X' });
    t('a missing problem description is refused', noProblem?.success === false && noProblem?.message === 'وصف العطل مطلوب', noProblem?.message ?? JSON.stringify(noProblem));
    const badCust = await receive({ CustomerID: 99999, CustomerName: 'أ', DeviceModel: 'X', ProblemDesc: 'Y' });
    t('a non-existent customer is refused', badCust?.success === false && badCust?.message === 'العميل غير موجود', badCust?.message ?? JSON.stringify(badCust));
    const junkId = await receive({ CustomerID: {}, CustomerName: 'أ', DeviceModel: 'X', ProblemDesc: 'Y' });
    t('a junk customer id is refused, not crashed over', junkId?.success === false, junkId?.message ?? JSON.stringify(junkId));
    const negAgreed = await receive({ CustomerName: 'أ', DeviceModel: 'X', ProblemDesc: 'Y', AgreedCost: -500 });
    t('a negative agreed cost is refused', negAgreed?.success === false && negAgreed?.message === 'التكلفة المتفق عليها يجب أن يكون رقماً غير سالب', negAgreed?.message ?? JSON.stringify(negAgreed));
    const nanAgreed = await receive({ CustomerName: 'أ', DeviceModel: 'X', ProblemDesc: 'Y', AgreedCost: NaN });
    t('a NaN agreed cost is refused', nanAgreed?.success === false, nanAgreed?.message ?? JSON.stringify(nanAgreed));
    t('the refusals created no tickets', q('SELECT COUNT(*) n FROM maintenance_tickets').n === 3, '3 tickets');

    const list = await call('maintenance:list');
    t('maintenance:list joins the technician name', list?.some(x => x.TicketID === T1 && x.TechnicianName === 'سعيد الفني'), JSON.stringify(list?.map(x => x.TechnicianName)));
    const open = await call('maintenance:openTickets');
    t('openTickets shows the open tickets', open?.length === 3, String(open?.length));
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] status — a workflow with notes, and terminal states locked');
  {
    const upd = (id, status, notes) => call('maintenance:updateStatus', id, status, notes, 1);
    const st1 = await upd(T1, 'inspecting', 'الفحص جارٍ');
    t('received -> inspecting is accepted', st1?.success === true, JSON.stringify(st1));
    const st2 = await upd(T1, 'in_progress', 'بدأ الإصلاح');
    const st3 = await upd(T1, 'ready', 'جاهز للتسليم');
    t('the workshop chain in_progress -> ready works',
      st2?.success === true && st3?.success === true && q('SELECT COUNT(*) n FROM maintenance_status_log WHERE TicketID = ?', T1).n === 4, 'log 4');
    const noNotes = await upd(T1, 'inspecting', '');
    t('a status change without notes is refused', noNotes?.success === false && noNotes?.message === 'الملاحظات إجبارية عند تغيير الحالة', noNotes?.message ?? JSON.stringify(noNotes));
    const bad = await upd(T1, 'ANYTHING', 'ملاحظة');
    t('an unknown status is refused with the workflow message',
      bad?.success === false && bad?.message.includes('أزرارها الخاصة'), bad?.message ?? JSON.stringify(bad));
    const jump = await upd(T1, 'delivered', 'تسليم سريع');
    t('delivering through updateStatus is refused', jump?.success === false && jump?.message.includes('أزرارها الخاصة'), jump?.message ?? JSON.stringify(jump));
    const missing = await upd(99999, 'ready', 'x');
    t('a missing ticket is refused', missing?.success === false && missing?.message === 'التذكرة غير موجودة', missing?.message ?? JSON.stringify(missing));
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] parts — stock leaves the exact warehouse at the exact cost');
  {
    const p1 = await issuePart({ TicketID: T1, ItemID: 1, Quantity: 2, UnitCost: 999, WarehouseID: 1 });
    t('issuePart succeeds', p1?.success === true, JSON.stringify(p1));
    t('the caller UnitCost override is IGNORED — the stock cost is booked',
      q('SELECT UnitCost v, TotalCost c FROM maintenance_parts WHERE TicketID = ? AND ItemID = 1', T1).v === 40, 'unit cost');
    t('the warehouse pool fell by 2', tot(1) === 98, `${tot(1)}`);
    t('the cost layers fell by the value of the units',
      lots(1) === 3920, `${lots(1)} vs 3920`);
    t('the ticket books PARTS at cost and TOTAL at sale value',
      tkt(T1).PartsCost === 80 && tkt(T1).TotalCost === 130, `${tkt(T1).PartsCost}/${tkt(T1).TotalCost}`);
    t('a missing sale price falls back to the item price', q('SELECT SalePrice v FROM maintenance_parts WHERE TicketID = ? AND ItemID = 1', T1).v === 65, 'sale price');

    const p2 = await issuePart({ TicketID: T1, ItemID: 2, Quantity: 3, WarehouseID: 1 });
    t('cables join the repair', p2?.success === true && tot(2) === 47 && lots(2) === 470, JSON.stringify(p2));

    const dry = await issuePart({ TicketID: T1, ItemID: 2, Quantity: 48, WarehouseID: 1 });
    t('issuing more than the shelf holds is refused',
      dry?.success === false && dry?.message === 'الكمية غير متوفرة في المخزن: المطلوب 48، المتاح 47', dry?.message ?? JSON.stringify(dry));
    const zero = await issuePart({ TicketID: T1, ItemID: 1, Quantity: 0, WarehouseID: 1 });
    t('a zero quantity is refused', zero?.success === false && zero?.message === 'الكمية يجب أن يكون أكبر من صفر', zero?.message ?? JSON.stringify(zero));
    const neg = await issuePart({ TicketID: T1, ItemID: 1, Quantity: -2, WarehouseID: 1 });
    t('a negative quantity is refused — it would REFILL the shelf',
      neg?.success === false && neg?.message === 'الكمية يجب أن يكون رقماً غير سالب' && tot(1) === 98, `${neg?.message ?? ''} pool ${tot(1)}`);
    const nan = await issuePart({ TicketID: T1, ItemID: 1, Quantity: NaN, WarehouseID: 1 });
    t('a NaN quantity is refused', nan?.success === false && nan?.message === 'الكمية يجب أن يكون رقماً صحيحاً', nan?.message ?? JSON.stringify(nan));
    const badItem = await issuePart({ TicketID: T1, ItemID: 99999, Quantity: 1, WarehouseID: 1 });
    t('a non-existent item is refused, not crashed over', badItem?.success === false && badItem?.message === 'الصنف غير موجود', badItem?.message ?? JSON.stringify(badItem));
    const badWh = await issuePart({ TicketID: T1, ItemID: 1, Quantity: 1, WarehouseID: 99999 });
    t('a non-existent warehouse is refused', badWh?.success === false && badWh?.message === 'المخزن المختار غير موجود', badWh?.message ?? JSON.stringify(badWh));
    const badTkt = await issuePart({ TicketID: 99999, ItemID: 1, Quantity: 1, WarehouseID: 1 });
    t('a non-existent ticket is refused', badTkt?.success === false && badTkt?.message === 'التذكرة غير موجودة', badTkt?.message ?? JSON.stringify(badTkt));

    // Race: the availability check runs before the transaction, so a rival
    // flow emptying the shelf in between must still be caught under the lock.
    raceProbe(emptyShelf, restoreShelf);
    const raced = await issuePart({ TicketID: T1, ItemID: 1, Quantity: 2, WarehouseID: 1 });
    t('a part raced against an emptying shelf is refused cleanly',
      raced?.success === false && raced?.message?.startsWith('الكمية غير متوفرة في المخزن'), raced?.message ?? JSON.stringify(raced));
    t('the raced issue left no part and no negative stock',
      partRows(T1).length === 2 && tot(1) >= 0 && lots(1) >= 0, `parts ${partRows(T1).length}`);

    const part1 = q('SELECT * FROM maintenance_parts WHERE TicketID = ? AND ItemID = 1', T1);
    const rm = await call('maintenance:removePart', part1.PartID, T1, 1);
    t('removePart returns the units to stock',
      rm?.success === true && tot(1) === 100 && lots(1) === 4000, `${tot(1)}/${lots(1)}`);
    t('removePart reverses BOTH cost legs on the ticket',
      tkt(T1).PartsCost === 30 && tkt(T1).TotalCost === 45, `${tkt(T1).PartsCost}/${tkt(T1).TotalCost}`);
    const rmMissing = await call('maintenance:removePart', 99999, T1, 1);
    t('removePart on a missing part is refused', rmMissing?.success === false && rmMissing?.message === 'القطعة غير موجودة', rmMissing?.message ?? JSON.stringify(rmMissing));

    const p1b = await issuePart({ TicketID: T1, ItemID: 1, Quantity: 2, WarehouseID: 1 });
    t('the screen part is re-issued for the delivery', p1b?.success === true && tot(1) === 98, JSON.stringify(p1b));
  }

  // ---------------------------------------------------------------- 4
  console.log('\n[4] services — manual costs and prices, with the summary');
  {
    const asc = (p) => call('maintenance:addServiceCost', { userId: 1, ...p });
    const asu = (p) => call('maintenance:addServiceUsage', { userId: 1, ...p });
    const s1 = await asc({ TicketID: T1, Description: 'رفع برنامج', CostOnUs: 50, PriceToClient: 150 });
    const u1 = await asu({ TicketID: T1, Description: 'فحص كامل', CostOnUs: 20, PriceToClient: 60, Quantity: 2 });
    t('service cost and usage are recorded', s1?.success === true && u1?.success === true, JSON.stringify([s1, u1]));

    const sum = await call('maintenance:getFinancialSummary', T1);
    t('the financial summary foots exactly',
      sum?.partsCostOnUs === 110 && sum?.partsSalePrice === 175 && sum?.servicePriceToClient === 150
      && sum?.usagePriceToClient === 120 && sum?.totalCostOnUs === 200
      && sum?.totalPriceToClient === 700 && sum?.expectedProfit === 500,
      JSON.stringify(sum));
    const sumMissing = await call('maintenance:getFinancialSummary', 99999);
    t('the summary on a missing ticket is refused', sumMissing?.success === false && sumMissing?.message === 'التذكرة غير موجودة', sumMissing?.message ?? JSON.stringify(sumMissing));

    const negP = await asc({ TicketID: T1, Description: 'س', CostOnUs: 10, PriceToClient: -100 });
    t('a negative client price is refused — it would REDUCE the bill', negP?.success === false && negP?.message === 'سعر الخدمة للعميل يجب أن يكون رقماً غير سالب', negP?.message ?? JSON.stringify(negP));
    const negC = await asc({ TicketID: T1, Description: 'س', CostOnUs: -10, PriceToClient: 100 });
    t('a negative cost on us is refused — it would INFLATE profit', negC?.success === false && negC?.message === 'تكلفة الخدمة علينا يجب أن يكون رقماً غير سالب', negC?.message ?? JSON.stringify(negC));
    const nanS = await asc({ TicketID: T1, Description: 'س', CostOnUs: NaN, PriceToClient: 100 });
    t('a NaN cost is refused', nanS?.success === false, nanS?.message ?? JSON.stringify(nanS));
    const noTkt = await asc({ TicketID: 99999, Description: 'س', CostOnUs: 10, PriceToClient: 100 });
    t('a service on a missing ticket is refused', noTkt?.success === false && noTkt?.message === 'التذكرة غير موجودة', noTkt?.message ?? JSON.stringify(noTkt));
    const negU = await asu({ TicketID: T1, Description: 'س', CostOnUs: 10, PriceToClient: 100, Quantity: -3 });
    t('a negative usage quantity is refused', negU?.success === false && negU?.message === 'الكمية يجب أن يكون رقماً غير سالب', negU?.message ?? JSON.stringify(negU));

    t('the refusals added no rows', q('SELECT COUNT(*) n FROM maintenance_service_costs WHERE TicketID = ?', T1).n === 1 && q('SELECT COUNT(*) n FROM maintenance_service_usage WHERE TicketID = ?', T1).n === 1, 'rows');

    const costId = q('SELECT CostID v FROM maintenance_service_costs WHERE TicketID = ?', T1).v;
    const rmS = await call('maintenance:removeServiceCost', costId);
    const sum2 = await call('maintenance:getFinancialSummary', T1);
    t('removing a service keeps the summary consistent',
      rmS?.success === true && sum2?.servicePriceToClient === 0 && sum2?.totalCostOnUs === 150 && sum2?.totalPriceToClient === 700, JSON.stringify(sum2));
    await asc({ TicketID: T1, Description: 'رفع برنامج', CostOnUs: 50, PriceToClient: 150 });

    const note = await call('maintenance:addNote', { TicketID: T1, Content: 'العميل يريد الاستلام اليوم', userId: 1 });
    const got = await call('maintenance:get', T1);
    t('notes ride on the ticket', note?.success === true && got?.notes?.length === 1, JSON.stringify(got?.notes?.length));
  }

  // ---------------------------------------------------------------- 5
  console.log('\n[5] deliver — one invoice, one payment, one commission');
  {
    // gross: parts 175 + svc 150 + usage 120 + labor 300 = 745; paid 300.
    const d1 = await deliver({ TicketID: T1, LaborCost: 300, PaymentMethod: 'cash', PaidAmount: 300, CashAccountID: 1 });
    t('the delivery is accepted', d1?.success === true && d1?.totalCost === 745 && d1?.remaining === 445, JSON.stringify(d1));
    t('the ticket is delivered with the labour stored', tkt(T1).Status === 'delivered' && tkt(T1).LaborCost === 300, 'status');
    const delRec = q('SELECT * FROM maintenance_deliveries WHERE TicketID = ?', T1);
    t('the delivery record foots every leg',
      delRec.PartsCost === 110 && delRec.ServiceCostTotal === 270 && delRec.TotalCostOnUs === 200
      && delRec.TotalProfit === 545 && delRec.PaidAmount === 300 && delRec.RemainingAmount === 445,
      JSON.stringify(delRec));
    cashL += 300;
    t('cash received 300', cash() === cashL, `${cash()} vs ${cashL}`);
    t('the customer owes exactly the unpaid part', cust(CUST) === 445, `${cust(CUST)}`);

    const dId = delRec.DeliveryID;
    const sale = q('SELECT * FROM sales WHERE SourceID = ?', dId);
    t('a mirror sale invoice exists for printing',
      sale?.Source === 'maintenance' && sale?.IsWarranty === 0 && sale?.Status === 'completed', JSON.stringify(sale));
    t('the mirror invoice is internally consistent',
      sale.Subtotal === 745 && sale.Discount === 0 && sale.TotalAmount === 745 && sale.PaidAmount === 300 && sale.RemainingAmount === 445,
      JSON.stringify({ s: sale.Subtotal, d: sale.Discount, t: sale.TotalAmount, p: sale.PaidAmount, r: sale.RemainingAmount }));
    const lines = qa('SELECT * FROM sale_details WHERE SaleID = ?', sale.SaleID);
    t('the mirror lines sum to the Subtotal — header and lines cannot disagree',
      near(lines.reduce((a, l) => a + l.Total, 0), sale.Subtotal), `${lines.reduce((a, l) => a + l.Total, 0)} vs ${sale.Subtotal}`);
    t('the part line charges the ITEM price, not the cost',
      lines.some(l => l.ItemID === 1 && l.UnitPrice === 65), JSON.stringify(lines.map(l => ({ i: l.ItemID, p: l.UnitPrice }))));
    t('labour is a service line', lines.some(l => l.Description === 'أجرة صيانة' && l.Total === 300), JSON.stringify(lines.map(l => l.Description)));
    const com = q('SELECT * FROM commissions WHERE ReferenceType = ? AND ReferenceID = ?', 'maintenance_delivery', dId);
    t('the technician commission is booked unpaid', com?.Amount === 300 && com?.IsPaid === 0, JSON.stringify(com));

    // Guards (against a FRESH ticket — the delivered one refuses for a
    // different reason and would mask these checks).
    const r8 = await receive({ CustomerName: 'فهد', DeviceModel: 'Oppo', ProblemDesc: 'سماعة' });
    T8 = r8.ticketId;
    const negLabor = await deliver({ TicketID: T8, LaborCost: -50, PaymentMethod: 'cash', PaidAmount: 0 });
    t('a negative labour is refused', negLabor?.success === false && negLabor?.message === 'أجرة الصيانة يجب أن يكون رقماً غير سالب', negLabor?.message ?? JSON.stringify(negLabor));
    const negPaid = await deliver({ TicketID: T8, LaborCost: 10, PaymentMethod: 'cash', PaidAmount: -1 });
    t('a negative payment is refused', negPaid?.success === false && negPaid?.message === 'المدفوع يجب أن يكون رقماً غير سالب', negPaid?.message ?? JSON.stringify(negPaid));
    const negDisc = await deliver({ TicketID: T8, LaborCost: 10, PaymentMethod: 'cash', PaidAmount: 0, Discount: -5 });
    t('a negative discount is refused', negDisc?.success === false && negDisc?.message === 'الخصم يجب أن يكون رقماً غير سالب', negDisc?.message ?? JSON.stringify(negDisc));

    const bigDisc = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'cash', PaidAmount: 0, Discount: 800 });
    t('a discount beyond the gross is refused — the invoice would go NEGATIVE',
      bigDisc?.success === false && bigDisc?.message.includes('أكبر من إجمالي الأصناف'), bigDisc?.message ?? JSON.stringify(bigDisc));
    const noDest = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'cash', PaidAmount: 100 });
    t('a payment with NO destination is refused — it would vanish', noDest?.success === false && noDest?.message.includes('اختر مصدر'), noDest?.message ?? JSON.stringify(noDest));
    const badDrawer = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 9999 });
    t('a payment into a NON-EXISTENT drawer is refused — money would vanish', badDrawer?.success === false && badDrawer?.message === 'الخزنة المختارة غير موجودة', badDrawer?.message ?? JSON.stringify(badDrawer));
    const deadDrawer = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'cash', PaidAmount: 100, CashAccountID: 2 });
    t('a payment into a DEACTIVATED drawer is refused', deadDrawer?.success === false && deadDrawer?.message === 'الخزنة المختارة غير مفعّلة', deadDrawer?.message ?? JSON.stringify(deadDrawer));
    const badMach = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'card', PaidAmount: 100, PaymentMethodID: 9999 });
    t('a payment into a non-existent machine is refused', badMach?.success === false && badMach?.message === 'ماكينة الدفع المختارة غير موجودة', badMach?.message ?? JSON.stringify(badMach));
    const deadMach = await deliver({ TicketID: T8, LaborCost: 100, PaymentMethod: 'card', PaidAmount: 100, PaymentMethodID: 2 });
    t('a payment into a DEACTIVATED machine is refused', deadMach?.success === false && deadMach?.message === 'ماكينة الدفع المختارة غير مفعّلة', deadMach?.message ?? JSON.stringify(deadMach));
    t('all refused deliveries moved nothing', cash() === cashL && mach() === machL, `${cash()} / ${mach()}`);
    t('the refusals created no deliveries', q('SELECT COUNT(*) n FROM maintenance_deliveries').n === 1 && tkt(T8).Status === 'received', '1 delivery');

    // FinalPrice 0 must be honoured, not swallowed by `||`.
    const dZero = await deliver({ TicketID: T8, LaborCost: 50, PaymentMethod: 'cash', PaidAmount: 0, FinalPrice: 0 });
    t('an explicit FinalPrice of zero is honoured — a free override', dZero?.success === true && dZero?.totalCost === 0, JSON.stringify(dZero));
    t('the free delivery is delivered with a zero bill', tkt(T8).Status === 'delivered' && tkt(T8).TotalCost === 0, 'status');

    // One account or the other, never both.
    const r7 = await receive({ CustomerName: 'جهاد', DeviceModel: 'Nokia', ProblemDesc: 'شاشة' });
    const ticket7 = r7.ticketId;
    await issuePart({ TicketID: ticket7, ItemID: 2, Quantity: 2, WarehouseID: 1 });
    const both = await deliver({ TicketID: ticket7, LaborCost: 60, PaymentMethod: 'cash', PaidAmount: 90, CashAccountID: 1, PaymentMethodID: 1 });
    t('listing BOTH a drawer and a machine credits only ONE', both?.success === true && cash() === cashL && mach() === machL + 90, `${cash()} vs ${cashL}, mach ${mach()}`);
    machL += 90;

    const again = await deliver({ TicketID: T1, LaborCost: 300, PaymentMethod: 'cash', PaidAmount: 300, CashAccountID: 1 });
    t('a delivered ticket cannot be delivered twice', again?.success === false && again?.message === 'تم تسليم هذه التذكرة بالفعل - لا يمكن تسليمها مرة أخرى', again?.message ?? JSON.stringify(again));
    const missingT = await deliver({ TicketID: 99999, LaborCost: 10, PaymentMethod: 'cash', PaidAmount: 0 });
    t('delivering a missing ticket is refused', missingT?.success === false && missingT?.message === 'التذكرة غير موجودة', missingT?.message ?? JSON.stringify(missingT));
    const partsOnDelivered = await issuePart({ TicketID: T1, ItemID: 2, Quantity: 1, WarehouseID: 1 });
    t('issuing parts on a DELIVERED ticket is refused — stock would leave with no bill',
      partsOnDelivered?.success === false && partsOnDelivered?.message.includes('منتهية'), partsOnDelivered?.message ?? JSON.stringify(partsOnDelivered));
  }

  // ---------------------------------------------------------------- 6
  console.log('\n[6] warranty — a repair with a zero bill and a real cost');
  {
    const rw = await receive({ CustomerID: CUST, CustomerName: 'وليد', DeviceModel: 'Samsung A52', ProblemDesc: 'وديعة ضمان', TechnicianID: globalThis.__TECH__, MaintenanceType: 'warranty', ReferenceTicketID: T1 });
    t('a warranty ticket is received', rw?.success === true, JSON.stringify(rw));
    const W = rw.ticketId;
    await issuePart({ TicketID: W, ItemID: 1, Quantity: 1, WarehouseID: 1 });
    const dw = await deliver({ TicketID: W, LaborCost: 0, PaymentMethod: 'warranty', PaidAmount: 0, CustomerName: 'وليد' });
    t('a warranty delivery bills ZERO', dw?.success === true && dw?.totalCost === 0 && dw?.isWarranty === true, JSON.stringify(dw));
    t('the warranty parts consumed real stock', tot(1) === 97, `${tot(1)}`);
    const saleW = q('SELECT * FROM sales WHERE SourceID = (SELECT DeliveryID FROM maintenance_deliveries WHERE TicketID = ?)', W);
    t('the warranty invoice is flagged, not cash', saleW?.IsWarranty === 1 && saleW?.TotalAmount === 0 && saleW?.PaidAmount === 0, JSON.stringify(saleW));
    t('no money moved for the warranty', cash() === cashL && mach() === machL, `${cash()} / ${mach()}`);
    t('the customer was not charged', cust(CUST) === 445, `${cust(CUST)}`);
    t('no commission for a free repair', empCom(globalThis.__TECH__) === 300, `${empCom(globalThis.__TECH__)}`);
    const hist = await call('maintenance:getWarrantyHistory', T1);
    t('the warranty history groups root + reference', hist?.length === 2 && hist.some(x => x.MaintenanceType === 'warranty'), JSON.stringify(hist?.length));
  }

  // ---------------------------------------------------------------- 7
  console.log('\n[7] cancel and delete — the reversal legs');
  {
    const r3 = await receive({ CustomerName: 'مروان', DeviceModel: 'Honor', ProblemDesc: 'زر' });
    T3 = r3.ticketId;
    await issuePart({ TicketID: T3, ItemID: 1, Quantity: 1, WarehouseID: 1 });
    const pre = { pool: tot(1), lot: lots(1) };
    const cn = await call('maintenance:cancel', { TicketID: T3, Reason: 'العميل تراجع', userId: 1 });
    t('cancelling an open ticket restores its parts exactly', cn?.success === true && tot(1) === pre.pool + 1 && lots(1) === pre.lot + 40, `${tot(1)}/${lots(1)}`);
    t('the cancelled ticket is terminal with a log', tkt(T3).Status === 'cancelled' && q('SELECT COUNT(*) n FROM maintenance_status_log WHERE TicketID = ?', T3).n === 2, 'log');
    const noReason = await call('maintenance:cancel', { TicketID: T1, userId: 1 });
    t('cancel without a reason is refused', noReason?.success === false && noReason?.message === 'سبب الإلغاء مطلوب', noReason?.message ?? JSON.stringify(noReason));
    const cnDelivered = await call('maintenance:cancel', { TicketID: T1, Reason: 'x', userId: 1 });
    t('cancelling a DELIVERED ticket is refused', cnDelivered?.success === false && cnDelivered?.message.includes('استخدم المرتجع'), cnDelivered?.message ?? JSON.stringify(cnDelivered));
    const partsOnCancelled = await issuePart({ TicketID: T3, ItemID: 2, Quantity: 1, WarehouseID: 1 });
    t('issuing parts on a CANCELLED ticket is refused', partsOnCancelled?.success === false && partsOnCancelled?.message.includes('منتهية'), partsOnCancelled?.message ?? JSON.stringify(partsOnCancelled));

    // A delivered + returned ticket must not be cancellable: its parts were
    // already restored by the return, and cancel would restore them AGAIN.
    const r4 = await receive({ CustomerName: 'رنا', DeviceModel: 'LG', ProblemDesc: 'صوت', TechnicianID: globalThis.__TECH__ });
    T4 = r4.ticketId;
    await issuePart({ TicketID: T4, ItemID: 1, Quantity: 1, WarehouseID: 1 });
    const d4 = await deliver({ TicketID: T4, LaborCost: 400, PaymentMethod: 'cash', PaidAmount: 465, CashAccountID: 1 });
    cashL += 465;
    t('ticket 4 delivers in full', d4?.success === true && d4?.totalCost === 465 && d4?.remaining === 0, JSON.stringify(d4));
    const d4id = q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', T4).v;
    const ret4 = await retn({ DeliveryID: d4id, TicketID: T4, Reason: 'لا يصلح', TotalRefund: 465, CashAccountID: 1, PartsRestored: 1 });
    cashL -= 465;
    t('the return goes through', ret4?.success === true, JSON.stringify(ret4));
    t('the returned parts are back on the shelf', tot(1) === 97, `pool ${tot(1)}`);    t('a returned ticket\'s commission is gone — a refunded job earns nothing', !q('SELECT 1 v FROM commissions WHERE ReferenceType = ? AND ReferenceID = ?', 'maintenance_delivery', d4id), 'no commission');
    const cnRet = await call('maintenance:cancel', { TicketID: T4, Reason: 'x', userId: 1 });
    t('cancelling a RETURNED ticket is refused — its parts are already back', cnRet?.success === false, cnRet?.message ?? JSON.stringify(cnRet));
    t('the returned ticket stayed returned', tkt(T4).Status === 'returned', tkt(T4).Status);
    t('the refused cancel restored nothing twice', tot(1) === 97, `${tot(1)}`);
    const partsOnReturned = await issuePart({ TicketID: T4, ItemID: 2, Quantity: 1, WarehouseID: 1 });
    t('issuing parts on a RETURNED ticket is refused', partsOnReturned?.success === false && partsOnReturned?.message.includes('منتهية'), partsOnReturned?.message ?? JSON.stringify(partsOnReturned));

    // delete:maintenanceDelivery — the full reversal of a delivered ticket.
    const preCash = cashL;
    const d1id = q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', T1).v;
    const dlDel = await call('delete:maintenanceDelivery', d1id);
    t('deleting a delivery reverses it', dlDel?.success === true, JSON.stringify(dlDel));
    cashL -= 300;
    t('the drawer gave the payment back', cash() === cashL, `${cash()} vs ${cashL}`);
    t('the customer debt was cancelled', cust(CUST) === 0, `${cust(CUST)}`);
    t('the ticket returns to ready', tkt(T1).Status === 'ready' && tkt(T1).TotalCost === 0, JSON.stringify({ s: tkt(T1).Status, t: tkt(T1).TotalCost }));
    t('the commission is gone', !q('SELECT 1 v FROM commissions WHERE ReferenceType = ? AND ReferenceID = ?', 'maintenance_delivery', d1id), 'no commission');
    t('the mirror invoice is gone with its lines', !q('SELECT 1 v FROM sales WHERE SourceID = ?', d1id) && q('SELECT COUNT(*) n FROM sale_details WHERE SaleID = (SELECT SaleID FROM maintenance_deliveries WHERE DeliveryID = ?)', d1id).n === 0, 'mirror');
    t('the money is conserved across the delete', cash() === preCash - 300, `${cash()} vs ${preCash - 300}`);
    const delMissing = await call('delete:maintenanceDelivery', 99999);
    t('deleting a missing delivery is refused', delMissing?.success === false && delMissing?.message === 'التسليم غير موجود', delMissing?.message ?? JSON.stringify(delMissing));
    const delReturned = await call('delete:maintenanceDelivery', d4id);
    t('deleting a RETURNED delivery is refused', delReturned?.success === false && delReturned?.message.includes('مرتجع صيانة مرتبط'), delReturned?.message ?? JSON.stringify(delReturned));

    // Re-issue: the same repair delivered again (parts stay consumed once).
    const d1b = await deliver({ TicketID: T1, LaborCost: 300, PaymentMethod: 'cash', PaidAmount: 300, CashAccountID: 1 });
    t('the repaired device can be re-delivered once', d1b?.success === true && d1b?.totalCost === 745, JSON.stringify(d1b));
    cashL += 300;
    t('the re-delivery banks once more', cash() === cashL, `${cash()}`);
    t('one commission per delivery', empCom(globalThis.__TECH__) === 300, `${empCom(globalThis.__TECH__)}`);

    // And deleted again — then the file can finally be cancelled.
    const d1bid = q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', T1).v;
    const dlDel2 = await call('delete:maintenanceDelivery', d1bid);
    cashL -= 300;
    t('the second delivery reverses the same way', dlDel2?.success === true && cust(CUST) === 0 && cash() === cashL, JSON.stringify(dlDel2));
    t('the drawer returns the second payment', cash() === cashL, `${cash()}`);

    // The re-issued ticket can finally be cancelled — parts come home.
    const preL = lots(1);
    const cn1 = await call('maintenance:cancel', { TicketID: T1, Reason: 'غلق الملف', userId: 1 });
    t('cancelling the re-issued ticket returns everything', cn1?.success === true && tot(1) === 99 && lots(1) === preL + 80 && lots(2) === 480, `${tot(1)}/${lots(1)}/${lots(2)}`);
  }

  // ---------------------------------------------------------------- 8
  console.log('\n[8] return — each leg reversed independently, and the guards');
  {
    const r5 = await receive({ CustomerName: 'فاطمة', DeviceModel: 'Vivo', ProblemDesc: 'بطارية', TechnicianID: globalThis.__TECH__ });
    T5 = r5.ticketId;
    await issuePart({ TicketID: T5, ItemID: 1, Quantity: 1, WarehouseID: 1 });
    await call('maintenance:addServiceCost', { TicketID: T5, Description: 'صيانة برمجية', CostOnUs: 10, PriceToClient: 90, userId: 1 });
    const d5 = await deliver({ TicketID: T5, LaborCost: 100, PaymentMethod: 'cash', PaidAmount: 255, CashAccountID: 1 });
    cashL += 255;
    t('ticket 5 delivers fully paid', d5?.success === true && d5?.totalCost === 255 && d5?.remaining === 0, JSON.stringify(d5));
    const d5id = q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', T5).v;
    const fCust = q('SELECT CustomerID v FROM customers WHERE Name = ?', 'فاطمة').v;

    // Guards first, against the FRESH delivery — a returned one refuses with
    // its own message and would mask these checks.
    const mismatch = await retn({ DeliveryID: d5id, TicketID: T1, Reason: 'x', TotalRefund: 255, CashAccountID: 1, PartsRestored: 1 });
    t('a return whose delivery belongs to another ticket is refused', mismatch?.success === false && mismatch?.message.includes('لا يتبع'), mismatch?.message ?? JSON.stringify(mismatch));
    const negRefund = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: -50, CashAccountID: 1, PartsRestored: 1 });
    t('a negative refund is refused — reverses into the till', negRefund?.success === false && negRefund?.message === 'قيمة المرتجع يجب أن يكون رقماً غير سالب', negRefund?.message ?? JSON.stringify(negRefund));
    const over = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: 999999, CashAccountID: 1, PartsRestored: 1 });
    t('a refund beyond what was paid is refused — the till never saw it', over?.success === false && over?.message.includes('أكبر من المدفوع'), over?.message ?? JSON.stringify(over));
    const noDrawer = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: 255, PartsRestored: 1 });
    t('a refund with no drawer is refused', noDrawer?.success === false && noDrawer?.message === 'اختر الخزينة التي تخرج منها قيمة المرتجع', noDrawer?.message ?? JSON.stringify(noDrawer));
    const badDrawer = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: 255, CashAccountID: 9999, PartsRestored: 1 });
    t('a refund from a non-existent drawer is refused — it would book without paying', badDrawer?.success === false && badDrawer?.message === 'الخزنة المختارة غير موجودة', badDrawer?.message ?? JSON.stringify(badDrawer));
    const deadDrawer = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: 255, CashAccountID: 2, PartsRestored: 1 });
    t('a refund from a DEACTIVATED drawer is refused', deadDrawer?.success === false && deadDrawer?.message === 'الخزنة المختارة غير مفعّلة', deadDrawer?.message ?? JSON.stringify(deadDrawer));
    const noReason = await retn({ DeliveryID: d5id, TicketID: T5, TotalRefund: 255, CashAccountID: 1, PartsRestored: 1 });
    t('a return without a reason is refused', noReason?.success === false && noReason?.message === 'سبب المرتجع مطلوب', noReason?.message ?? JSON.stringify(noReason));
    t('all refused redos left no return and unchanged cash', q('SELECT COUNT(*) n FROM maintenance_returns').n === 1 && cash() === cashL, 'state');

    const ret = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'العميل غير راضٍ', TotalRefund: 255, CashAccountID: 1, PartsRestored: 1 });
    t('the return is accepted with a number', ret?.success === true && /^MRT-/.test(ret?.returnNumber ?? ''), JSON.stringify(ret));
    cashL -= 255;
    t('the drawer gave back exactly what it received', cash() === cashL, `${cash()}`);
    t('the customer was never debited (paid in full) and stays zero', cust(fCust) === 0, `${cust(fCust)}`);
    t('the parts came back to the shelf', tot(1) === 99, `${tot(1)}`);
    t('the commission is gone — a refunded job earns nothing', !q('SELECT 1 v FROM commissions WHERE ReferenceType = ? AND ReferenceID = ?', 'maintenance_delivery', d5id), 'no commission');
    t('the ticket is returned with a log', tkt(T5).Status === 'returned' && q('SELECT COUNT(*) n FROM maintenance_status_log WHERE TicketID = ?', T5).n === 3, tkt(T5).Status);

    // Double return of the same delivery.
    const again = await retn({ DeliveryID: d5id, TicketID: T5, Reason: 'x', TotalRefund: 255, CashAccountID: 1, PartsRestored: 1 });
    t('a second return of the same delivery is refused', again?.success === false && again?.message.includes('مرتجع بالفعل'), again?.message ?? JSON.stringify(again));

    // The machine leg: repay through the same door that received.
    const r6 = await receive({ CustomerName: 'حسن', DeviceModel: 'Techno', ProblemDesc: 'مقبس', TechnicianID: globalThis.__TECH__ });
    T6 = r6.ticketId;
    await issuePart({ TicketID: T6, ItemID: 2, Quantity: 2, WarehouseID: 1 });
    const d6 = await deliver({ TicketID: T6, LaborCost: 200, PaymentMethod: 'card', PaidAmount: 230, PaymentMethodID: 1 });
    machL += 230;
    t('ticket 6 is paid through the machine', d6?.success === true && mach() === machL, `${mach()} vs ${machL}`);
    const d6id = q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', T6).v;
    const ret6 = await retn({ DeliveryID: d6id, TicketID: T6, Reason: 'استبدال', TotalRefund: 230, PartsRestored: 1 });
    machL -= 230;
    t('the machine refunds through the machine', ret6?.success === true && mach() === machL, `${mach()} vs ${machL}`);
    t('the drawer was never touched by the machine leg', cash() === cashL, `${cash()}`);

    // The race: a rival till drains the drawer between check and payment.
    const r7 = await receive({ CustomerName: 'سلمى', DeviceModel: 'Realme', ProblemDesc: 'كاميرا' });
    R7 = r7.ticketId;
    const d7 = await deliver({ TicketID: R7, LaborCost: 60, PaymentMethod: 'cash', PaidAmount: 60, CashAccountID: 1 });
    t('ticket racing later delivers', d7?.success === true, JSON.stringify(d7));
    cashL += 60;
    raceProbe(emptyDrawer, restoreDrawer);
    const raced = await retn({ DeliveryID: q('SELECT DeliveryID v FROM maintenance_deliveries WHERE TicketID = ?', R7).v, TicketID: R7, Reason: 'x', TotalRefund: 60, CashAccountID: 1, PartsRestored: 0 });
    t('a refund raced against an emptying till is refused cleanly', raced?.success === false && raced?.message?.startsWith('الرصيد غير كافٍ في الخزينة'), raced?.message ?? JSON.stringify(raced));
    t('the raced refund left no trace', q('SELECT COUNT(*) n FROM maintenance_returns WHERE TicketID = ?', R7).n === 0 && q('SELECT Status v FROM maintenance_tickets WHERE TicketID = ?', R7).v === 'delivered', 'state');
    t('the raced refusal moved nothing', cash() === cashL, `${cash()} vs ${cashL}`);
  }

  // ---------------------------------------------------------------- 9
  console.log('\n[9] close — the reports agree with the live ledger');
  {
    const rep = await call('reports:maintenance', { fromDate: '2026-08-01', toDate: '2026-08-31' });
    const liveTot = q('SELECT COALESCE(SUM(TotalCost),0) tc, COALESCE(SUM(PartsCost),0) pc, COALESCE(SUM(LaborCost),0) lc FROM maintenance_tickets');
    t('reports:maintenance foots to the tickets', rep?.rows?.length === q('SELECT COUNT(*) n FROM maintenance_tickets').n
      && near(rep?.totals?.totalCost, liveTot.tc) && near(rep?.totals?.partsCost, liveTot.pc) && near(rep?.totals?.laborCost, liveTot.lc),
      JSON.stringify({ r: rep?.totals, l: liveTot }));

    const p = await call('reports:profitLoss', { fromDate: '2026-08-01', toDate: '2026-08-31' });
    const delivered = q('SELECT COALESCE(SUM(TotalCost),0) v FROM maintenance_deliveries WHERE VoidedSaleID IS NULL').v;
    const refunded = q('SELECT COALESCE(SUM(TotalRefund),0) v FROM maintenance_returns').v;
    t('P&L maintenance revenue is deliveries minus returns',
      near(p?.revenue?.maintenance, delivered) && near(p?.revenue?.maintenanceReturns, refunded), `${p?.revenue?.maintenance} / ${p?.revenue?.maintenanceReturns}`);

    const f = await call('reports:financialPosition');
    t('the balance sheet cash equals the tracked cash', near(f?.assets?.totalCash, cashL), `${f?.assets?.totalCash} vs ${cashL}`);
    t('the balance sheet machine equals the tracked machine', near(f?.assets?.totalPaymentMethods, machL), `${f?.assets?.totalPaymentMethods} vs ${machL}`);
    t('inventory value equals the cost layers', near(f?.assets?.totalInventory, lots(1) + lots(2)), `${f?.assets?.totalInventory} vs ${lots(1) + lots(2)}`);
    t('assets = liabilities + equity exactly', Math.abs((f?.capital?.difference ?? 1) - 0) < 0.01,
      JSON.stringify({ a: f?.assets, l: f?.liabilities, c: f?.capital, p: { r: p?.revenue, c: p?.costs, e: p?.expenses, n: p?.netProfit } }));
    t('P&L and balance sheet compute the SAME profit', near(p?.netProfit ?? NaN, f?.capital?.netProfit ?? NaN), `${p?.netProfit} vs ${f?.capital?.netProfit}`);

    const empRep = await call('reports:employees');
    const techRow = empRep?.rows?.find(r => r.Name === 'سعيد الفني');
    t('the clinic\'s unpaid commissions sit on the employees report', near(techRow?.UnpaidCommissions, empCom(globalThis.__TECH__)), JSON.stringify(techRow));
  }

  console.log(`\nSECTION 6 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
}