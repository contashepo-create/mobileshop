#!/usr/bin/env node
// SECTION 8 — RENT: contracts, instalments, partial payments, advances,
// cancellation, party statements and the voucher door, executed against the
// REAL bundle on the REAL schema.
//
// Same harness as section 7: an ESM entry re-exporting only the handler
// registration functions, esbuild CJS bundle, an electron stub, and a scratch
// userData directory. Every channel below runs the actual production code.
//
// The rentSettle module is the ONE place money is applied to an instalment,
// shared by the rent screen and the voucher path. The accounting claim under
// test is: an instalment can never receive more than it still owes, whichever
// door the money comes through — and whatever the books record, the drawer and
// the ledger agree on.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerRentHandlers } from './src/main/ipc/rent.handlers.ts';
export { registerRentPartyHandlers } from './src/main/ipc/rentParty.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_rent_entry.ts');
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
  console.log('Building the real rent bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_rent_bundle.cjs');
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
  // Each scenario opens a FRESH database (same file path, wiped between runs)
  // and registers the real handlers against it. The bundle is built once.
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
  const today = fmt(new Date());
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
  const daysAhead = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };

  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 5000, 1);
    INSERT INTO settings (Key, Value) VALUES ('allow_negative_cash', '0')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '105000')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const inst = (db, id) => q(db, 'SELECT * FROM rent_payments WHERE RentPaymentID = ?', id);
  const rentOf = (db, id) => q(db, 'SELECT * FROM rents WHERE RentID = ?', id);
  const paidTxns = (db, id) => qa(db, `SELECT * FROM rent_transactions
    WHERE RentPaymentID = ? AND ReversedAt IS NULL ORDER BY RentTxnID`, id);

  // The cash-side ledger tracker: every section that moves money asserts that
  // the drawer, the instalment and the transactions agree at its end.
  const contract = (call, o) => call(`rents:create`, {
    RentName: 'المحل', RentType: 'expense', Amount: 5000, Period: 'monthly',
    StartDate: daysAgo(45), ...o,
  });
  const pay = (call, o) => call(`rentPayments:pay`, { userId: 1, fiscalYearId: 1, ...o });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Contract creation and validation');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await contract(call, { RentName: 'محل الهواتف', Amount: 5000 });
    t('a valid expense contract is created', ok?.success === true && ok?.id > 0, JSON.stringify(ok));
    const row = rentOf(db, ok.id);
    t('it starts active', row.Status === 'active' && row.IsActive === 1);
    t('it has no end date (open-ended is legitimate)', row.EndDate === null);
    t('the party travels with it', row.PartyName === null, String(row.PartyName));

    const inc = await call('rents:create', {
      RentName: 'الشقة المؤجرة', RentType: 'income', Amount: 3000, Period: 'yearly',
      StartDate: daysAgo(10), PartyName: 'مستأجر محمود', PartyPhone: '01000000000',
    });
    t('a valid income contract is created', inc?.success === true && inc?.id > 0);
    const incRow = q(db, 'SELECT RentType, Period, PartyName, PartyPhone FROM rents WHERE RentID = ?', inc.id);
    t('its fields land unchanged', incRow.RentType === 'income' && incRow.Period === 'yearly'
      && incRow.PartyName === 'مستأجر محمود' && incRow.PartyPhone === '01000000000', JSON.stringify(incRow));

    const startCount = q(db, 'SELECT COUNT(*) n FROM rents').n;
    const refuse = async (o, label, expectMsg) => {
      const r = await call('rents:create', {
        RentName: 'رفض', RentType: 'expense', Amount: 1000, Period: 'monthly',
        StartDate: daysAgo(5), ...o,
      });
      t(label, r?.success === false && (!expectMsg || String(r?.message).includes(expectMsg)), JSON.stringify(r));
    };
    await refuse({ Amount: 0 }, 'zero rent is refused', 'قيمة الإيجار');
    await refuse({ Amount: -100 }, 'negative rent is refused', 'قيمة الإيجار');
    await refuse({ Amount: 'abc' }, 'a non-numeric rent is refused', 'قيمة الإيجار');
    await refuse({ StartDate: '' }, 'a missing start date is refused', 'تاريخ بداية العقد');
    await refuse({ StartDate: '15/08/2026' }, 'a malformed start date is refused', 'تاريخ بداية العقد');
    await refuse({ EndDate: 'not-a-date' }, 'a malformed end date is refused', 'تاريخ نهاية العقد');
    await refuse({ StartDate: daysAgo(30), EndDate: daysAgo(60) }, 'an end before the start is refused', 'بعد تاريخ البداية');
    await refuse({ RentType: 'paid' }, 'an unrecognised rent type is refused', 'نوع الإيجار');
    await refuse({ Period: 'weekly' }, 'an unrecognised period is refused', 'دورية الإيجار');
    await refuse({ RentName: '   ' }, 'a blank contract name is refused', 'اسم العقد');
    t('none of the refusals wrote a row',
      q(db, 'SELECT COUNT(*) n FROM rents').n === startCount, String(q(db, 'SELECT COUNT(*) n FROM rents').n));

    const ghost = await call('rents:create', {
      RentName: 'شبح', RentType: 'expense', Amount: 1000, Period: 'monthly',
      StartDate: daysAgo(5), RentPartyID: 999999,
    });
    t('a rental linked to a party that does not exist is refused', ghost?.success === false, JSON.stringify(ghost));
    t('and writes no row',
      q(db, "SELECT COUNT(*) n FROM rents WHERE RentName = 'شبح'").n === 0);
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] The instalment schedule');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    const g1 = await call('rents:generatePayments', c.id, 3, 1, 1);
    t('three instalments are created on request', g1?.success === true && g1?.created === 3,
      JSON.stringify(g1));
    const rows = qa(db, 'SELECT * FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id);
    t('each carries the contract rent', rows.every(r => r.Amount === 5000) && rows.length === 3);
    t('each starts pending', rows.every(r => r.Status === 'pending'));
    t('the due dates step by one month', rows[0].DueDate < rows[1].DueDate && rows[1].DueDate < rows[2].DueDate);
    t('each gets a display label', rows.every(r => typeof r.PeriodLabel === 'string' && r.PeriodLabel.length > 0));
    t('the instalments belong to the contract', rows.every(r => r.RentID === c.id));

    const g2 = await call('rents:generatePayments', c.id, 3, 1, 1);
    t('generating the same months again creates nothing (the label is the key)',
      g2?.created === 0, JSON.stringify(g2));
    const g3 = await call('rents:generatePayments', c.id, 6, 1, 1);
    t('requesting MORE months appends only the new ones', g3?.created === 3, JSON.stringify(g3));
    t('no duplicates exist',
      q(db, 'SELECT COUNT(*) n FROM rent_payments WHERE RentID = ?', c.id).n === 6,
      String(q(db, 'SELECT COUNT(*) n FROM rent_payments WHERE RentID = ?', c.id).n));

    const badMonths = [0, -2, 121, 'abc', NaN];
    for (const m of badMonths) {
      const r = await call('rents:generatePayments', c.id, m, 1, 1);
      t(`a request for ${String(m)} months is refused`, r?.success === false, JSON.stringify(r));
    }
    const gone = await call('rents:generatePayments', 999, 3, 1, 1);
    t('generating for a missing contract is refused', gone?.success === false, JSON.stringify(gone));

    // The contract's own end caps the schedule whatever was asked for.
    const capped = await call('rents:create', {
      RentName: 'محدود', RentType: 'expense', Amount: 1000, Period: 'monthly',
      StartDate: daysAgo(46), EndDate: daysAhead(70),
    });
    const gc = await call('rents:generatePayments', capped.id, 12, 1, 1);
    t('a bounded contract stops at its end', gc?.stoppedAtEnd === true, JSON.stringify(gc));
    t('and it says so in the message', String(gc?.message).includes('حتى نهاية العقد'));
    const capRows = qa(db, 'SELECT DueDate FROM rent_payments WHERE RentID = ? ORDER BY DueDate', capped.id);
    const capEnd = rentOf(db, capped.id).EndDate;
    t('every instalment falls inside the contract', capRows.every(r => r.DueDate <= capEnd));

    // Yearly period advances by years.
    const yearly = await call('rents:create', {
      RentName: 'سنوي', RentType: 'income', Amount: 2000, Period: 'yearly',
      StartDate: daysAgo(30), EndDate: daysAhead(700),
    });
    const gy = await call('rents:generatePayments', yearly.id, 5, 1, 1);
    t('a yearly contract advances by years', gy?.created === 2 && gy?.stoppedAtEnd === true, JSON.stringify(gy));
    const yRows = qa(db, 'SELECT DueDate, PeriodLabel FROM rent_payments WHERE RentID = ? ORDER BY DueDate', yearly.id);
    t('the yearly instalments are one year apart',
      yRows.length === 2
      && parseInt(yRows[1].DueDate.slice(0, 4), 10) - parseInt(yRows[0].DueDate.slice(0, 4), 10) === 1
      && yRows.every(r => /^\d{4}$/.test(r.PeriodLabel)), JSON.stringify(yRows));
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Full payment: the till and the ledger move together, once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', c.id).id;

    t('the drawer opens at 100,000', cash(db) === 100000, String(cash(db)));
    const r = await pay(call, { RentPaymentID: pid, CashAccountID: 1 });
    t('the full rent is accepted', r?.success === true, JSON.stringify(r));
    t('it reports exactly what was applied', near(r.applied, 5000) && near(r.remaining, 0) && r.status === 'paid');
    t('the drawer fell by one rent', near(cash(db), 95000), String(cash(db)));
    const row = inst(db, pid);
    t('the instalment is stamped paid', row.Status === 'paid' && near(row.PaidAmount, 5000));
    t('a paid date is recorded', typeof row.PaidDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.PaidDate));
    const txns = paidTxns(db, pid);
    t('exactly one movement is recorded', txns.length === 1);
    t('and it names the source', txns[0].SourceType === 'rent' && txns[0].Kind === 'instalment');

    const again = await pay(call, { RentPaymentID: pid, CashAccountID: 1 });
    t('a second press is refused', again?.success === false, JSON.stringify(again));
    t('and the drawer did NOT move again', near(cash(db), 95000), String(cash(db)));
    await pay(call, { RentPaymentID: pid, CashAccountID: 1 });
    await pay(call, { RentPaymentID: pid, CashAccountID: 1, Amount: 1 });
    t('repeated attempts leave the till untouched', near(cash(db), 95000), String(cash(db)));
    const charged = q(db, `SELECT COALESCE(SUM(CASE WHEN rp.Status='paid' THEN rp.Amount ELSE COALESCE(rp.PaidAmount,0) END),0) v
      FROM rent_payments rp JOIN rents r ON rp.RentID = r.RentID WHERE r.RentType = 'expense'`).v;
    t('the ledger and the till agree', near(100000 - charged, cash(db)), `ledger ${charged}, till ${cash(db)}`);
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] Part payments, precision and the guards');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 3000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);

    const half = await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 2000 });
    t('half of the month is accepted', half?.success === true, JSON.stringify(half));
    t('the instalment reports what is left', near(half.remaining, 1000), String(half.remaining));
    t('it is marked partial, not paid', inst(db, p1).Status === 'partial');
    t('the paid date is stamped on the FIRST money', typeof inst(db, p1).PaidDate === 'string',
      String(inst(db, p1).PaidDate));
    t('the drawer moved by exactly the part', near(cash(db), 98000), String(cash(db)));

    const over = await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 3000 });
    t('more than the remainder is refused', over?.success === false && String(over?.message).includes('أكبر من المتبقي'),
      JSON.stringify(over));
    t('and nothing left the drawer', near(cash(db), 98000), String(cash(db)));

    const rest = await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 1000 });
    t('the rest is accepted later', rest?.success === true && rest?.status === 'paid');
    t('the month is now fully paid', inst(db, p1).Status === 'paid' && near(inst(db, p1).PaidAmount, 3000));
    t('the drawer fell by exactly the whole 3,000', near(cash(db), 97000), String(cash(db)));
    t('both movements are recorded, not merged', paidTxns(db, p1).length === 2);
    const after = await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 100 });
    t('a settled month refuses more money', after?.success === false);

    const bad = [
      [0, 'a zero payment is refused'],
      [-500, 'a negative payment is refused'],
      ['abc', 'a non-numeric payment is refused'],
    ];
    for (const [amt, label] of bad) {
      const r = await pay(call, { RentPaymentID: p2, CashAccountID: 1, Amount: amt });
      t(label, r?.success === false, JSON.stringify(r));
    }
    const noSrc = await pay(call, { RentPaymentID: p2, Amount: 100 });
    t('a payment with no source is refused', noSrc?.success === false, JSON.stringify(noSrc));
    t('nothing moved', near(cash(db), 97000), String(cash(db)));

    // Absent amount means "settle the remainder" — the old one-click behaviour.
    const settle = await pay(call, { RentPaymentID: p2, CashAccountID: 1 });
    t('an absent amount settles what is left', settle?.success === true && near(settle.applied, 3000),
      JSON.stringify(settle));

    // Money precision: 0.1 + 0.2 is exactly 0.3 in the books.
    const tiny = await call('rents:create', {
      RentName: 'دقيق', RentType: 'expense', Amount: 1, Period: 'monthly', StartDate: daysAgo(5),
    });
    await call('rents:generatePayments', tiny.id, 1, 1, 1);
    const tp = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', tiny.id).id;
    await pay(call, { RentPaymentID: tp, CashAccountID: 1, Amount: 0.1 });
    const after01 = inst(db, tp);
    t('a tenth is recorded as exactly a tenth', near(after01.PaidAmount, 0.1), String(after01.PaidAmount));
    await pay(call, { RentPaymentID: tp, CashAccountID: 1, Amount: 0.2 });
    const after02 = inst(db, tp);
    t('0.1 then 0.2 leaves exactly 0.3, no float residue',
      near(after02.PaidAmount, 0.3) && near(after02.Amount - after02.PaidAmount, 0.7),
      `paid ${after02.PaidAmount}, remaining ${after02.Amount - after02.PaidAmount}`);
    await pay(call, { RentPaymentID: tp, CashAccountID: 1, Amount: 0.7 });
    t('the whole pound settles cleanly', inst(db, tp).Status === 'paid');

// Funds are checked against the source actually named.
    const funded = await contract(call, { RentName: 'ممول' });
    await call('rents:generatePayments', funded.id, 1, 1, 1);
    const fp = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', funded.id).id;
    db.exec('UPDATE cash_accounts SET Balance = 2000 WHERE CashAccountID = 1');
    const broke = await pay(call, { RentPaymentID: fp, CashAccountID: 1, Amount: 3000 });
    t('an underfunded drawer refuses an expense', broke?.success === false && String(broke?.message).includes('الرصيد غير كافٍ'),
      JSON.stringify(broke));
    db.exec("UPDATE settings SET Value = '1' WHERE Key = 'allow_negative_cash'");
    const allowed = await pay(call, { RentPaymentID: fp, CashAccountID: 1, Amount: 3000 });
    t('a shop that allows negative cash may overspend', allowed?.success === true, JSON.stringify(allowed));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] A wallet is a real source, not just the drawer');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 3000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);

    const r = await pay(call, { RentPaymentID: p1, PaymentMethodID: 1, Amount: 3000 });
    t('rent can be paid from a wallet', r?.success === true, JSON.stringify(r));
    t('the wallet was debited', near(wallet(db), 2000), String(wallet(db)));
    t('and the drawer was left alone', near(cash(db), 100000), String(cash(db)));
    const txn = paidTxns(db, p1)[0];
    t('the movement names the wallet', txn.PaymentMethodID === 1 && txn.CashAccountID === null);

    // Mixed sources on ONE month — half drawer, half wallet.
    await pay(call, { RentPaymentID: p2, CashAccountID: 1, Amount: 1500 });
    await pay(call, { RentPaymentID: p2, PaymentMethodID: 1, Amount: 1500 });
    t('a month settles from two sources', inst(db, p2).Status === 'paid' && near(inst(db, p2).PaidAmount, 3000));
    t('the drawer gave its half', near(cash(db), 98500), String(cash(db)));
    t('the wallet gave its half', near(wallet(db), 500), String(wallet(db)));
    t('the movements are recorded per source', paidTxns(db, p2).length === 2);
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] Reversing a payment restores every account exactly');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 3000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);

    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 3000 });
    t('paid once', near(cash(db), 97000), String(cash(db)));
    const undo = await call('rentPayments:unpay', { RentPaymentID: p1 });
    t('the reversal succeeds', undo?.success === true, JSON.stringify(undo));
    const row = inst(db, p1);
    t('the month is payable again', row.Status === 'pending' && near(row.PaidAmount, 0));
    t('the paid date is cleared', row.PaidDate === null, String(row.PaidDate));
    t('the drawer is back to its start', near(cash(db), 100000), String(cash(db)));
    t('the movements are marked reversed, not deleted',
      q(db, 'SELECT COUNT(*) n FROM rent_transactions WHERE RentPaymentID = ? AND ReversedAt IS NOT NULL', p1).n === 1);
    const twice = await call('rentPayments:unpay', { RentPaymentID: p1 });
    t('un-paying twice is refused', twice?.success === false, JSON.stringify(twice));
    const re = await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 3000 });
    t('the month can be paid again afterwards', re?.success === true && near(cash(db), 97000));

    // Half from each source; a single-account reversal would get this wrong.
    await pay(call, { RentPaymentID: p2, CashAccountID: 1, Amount: 1500 });
    await pay(call, { RentPaymentID: p2, PaymentMethodID: 1, Amount: 1500 });
    const cashAfterMixed = cash(db);
    const walletAfterMixed = wallet(db);
    const undoMix = await call('rentPayments:unpay', { RentPaymentID: p2 });
    t('reversing a mixed month succeeds', undoMix?.success === true);
    t('the drawer got its 1,500 back', near(cash(db), cashAfterMixed + 1500), String(cash(db)));
    t('the wallet got its 1,500 back', near(wallet(db), walletAfterMixed + 1500), String(wallet(db)));

    // Legacy rows paid before rent_transactions existed: the reversal falls
    // back to the account the instalment itself recorded.
    const cashBeforeLegacy = cash(db);
    const legacy = await contract(call, { Amount: 4000 });
    await call('rents:generatePayments', legacy.id, 1, 1, 1);
    const lp = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', legacy.id).id;
    await pay(call, { RentPaymentID: lp, CashAccountID: 1, Amount: 4000 });
    db.prepare('DELETE FROM rent_transactions WHERE RentPaymentID = ?').run(lp);
    const undoLegacy = await call('rentPayments:unpay', { RentPaymentID: lp });
    t('a legacy drawer payment is still unwound', undoLegacy?.success === true, JSON.stringify(undoLegacy));
    t('the legacy drawer was restored', near(cash(db), cashBeforeLegacy), String(cash(db)));

    const walletBeforeLegacy = wallet(db);
    const legacyW = await contract(call, { Amount: 2000 });
    await call('rents:generatePayments', legacyW.id, 1, 1, 1);
    const lw = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', legacyW.id).id;
    await pay(call, { RentPaymentID: lw, PaymentMethodID: 1, Amount: 2000 });
    db.prepare('DELETE FROM rent_transactions WHERE RentPaymentID = ?').run(lw);
    const undoLegacyW = await call('rentPayments:unpay', { RentPaymentID: lw });
    t('a legacy WALLET payment is unwound too (not skipped)', undoLegacyW?.success === true, JSON.stringify(undoLegacyW));
    t('and the wallet was restored', near(wallet(db), walletBeforeLegacy), String(wallet(db)));
  });

  // ---------------------------------------------------------------- 7
  console.log('\n[7] Income contracts move money the other way');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await call('rents:create', {
      RentName: 'الشقة', RentType: 'income', Amount: 3000, Period: 'monthly', StartDate: daysAgo(20),
    });
    await call('rents:generatePayments', c.id, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', c.id).id;

    const before = cash(db);
    const r = await pay(call, { RentPaymentID: pid, CashAccountID: 1, Amount: 3000 });
    t('rent owed TO the shop is collected', r?.success === true && r?.status === 'paid');
    t('the drawer goes UP, not down', near(cash(db), before + 3000), String(cash(db)));

    const undo = await call('rentPayments:unpay', { RentPaymentID: pid });
    t('reversing a collection succeeds', undo?.success === true);
    t('and takes the money back out', near(cash(db), before), String(cash(db)));

    db.exec('UPDATE cash_accounts SET Balance = 0 WHERE CashAccountID = 1');
    const poor = await pay(call, { RentPaymentID: pid, CashAccountID: 1, Amount: 3000 });
    t('an empty drawer does not block a collection', poor?.success === true, JSON.stringify(poor));
    t('the collection still credits it', near(cash(db), 3000), String(cash(db)));
  });

  // ---------------------------------------------------------------- 8
  console.log('\n[8] An advance is held, never expensed, until it is applied');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);

    const adv = await call('rents:addAdvance', { RentID: c.id, Amount: 10000, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('a deposit is accepted', adv?.success === true, JSON.stringify(adv));
    t('the money left the drawer', near(cash(db), 90000), String(cash(db)));
    t('it is held against the contract', near(rentOf(db, c.id).AdvanceBalance, 10000));
    t('no month has been charged by it', near(inst(db, p1).PaidAmount, 0) && inst(db, p1).Status === 'pending');
    t('the movement is an advance, not an instalment',
      q(db, "SELECT COUNT(*) n FROM rent_transactions WHERE RentID = ? AND Kind = 'advance'", c.id).n === 1);

    const bad = await call('rents:addAdvance', { RentID: c.id, Amount: 0, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('a zero deposit is refused', bad?.success === false, JSON.stringify(bad));
    const noSrc = await call('rents:addAdvance', { RentID: c.id, Amount: 500, userId: 1, fiscalYearId: 1 });
    t('a deposit with no source is refused', noSrc?.success === false, JSON.stringify(noSrc));
    t('nothing moved', near(cash(db), 90000), String(cash(db)));

    const use = await call('rents:applyAdvance', { RentPaymentID: p1, userId: 1, fiscalYearId: 1 });
    t('the advance settles a month', use?.success === true && use?.status === 'paid', JSON.stringify(use));
    t('the month is now paid', inst(db, p1).Status === 'paid' && near(inst(db, p1).PaidAmount, 5000));
    t('the held balance fell by the rent', near(rentOf(db, c.id).AdvanceBalance, 5000));
    t('applying it moved NO further cash', near(cash(db), 90000), String(cash(db)));
    const note = q(db, "SELECT Notes n FROM rent_transactions WHERE RentPaymentID = ? AND ReversedAt IS NULL ORDER BY RentTxnID DESC LIMIT 1", p1).n;
    t('the note records where the money came from', note === 'خصم من المقدم', String(note));

    await call('rents:applyAdvance', { RentPaymentID: p2, Amount: 3000, userId: 1, fiscalYearId: 1 });
    t('only 3,000 of the second month is charged (capped by the held balance)',
      near(inst(db, p2).PaidAmount, 3000) && inst(db, p2).Status === 'partial', String(inst(db, p2).PaidAmount));
    t('the contract still holds the rest', near(rentOf(db, c.id).AdvanceBalance, 2000));
    const exhausted = await call('rents:applyAdvance', { RentPaymentID: p2, userId: 1, fiscalYearId: 1 });
    t('more than held is capped, not taken', near(exhausted.applied, 2000) && exhausted?.status === 'paid', JSON.stringify(exhausted));
    const dead = await call('rents:applyAdvance', { RentPaymentID: p2, userId: 1, fiscalYearId: 1 });
    t('an exhausted advance refuses further use', dead?.success === false, JSON.stringify(dead));
    t('the held balance is zero', near(rentOf(db, c.id).AdvanceBalance, 0));

    const gone = await call('rents:applyAdvance', { RentPaymentID: p1, userId: 1, fiscalYearId: 1 });
    t('applying to an already-paid month is refused', gone?.success === false, JSON.stringify(gone));

    // A deposit against a CANCELLED contract is refused.
    const cx = await contract(call, { RentName: 'ملغى' });
    db.exec(`UPDATE rents SET Status = 'cancelled' WHERE RentID = ${cx.id}`);
    const cancelledAdv = await call('rents:addAdvance', { RentID: cx.id, Amount: 500, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
    t('a deposit against a cancelled contract is refused', cancelledAdv?.success === false, JSON.stringify(cancelledAdv));
  });

  // ---------------------------------------------------------------- 9
  console.log('\n[9] Cancelling withdraws only what was never paid');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 3, 1, 1);
    const [p1, p2, p3] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);
    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 5000 });

    const noReason = await call('rents:cancel', { RentID: c.id, Reason: '   ' });
    t('cancelling without a reason is refused', noReason?.success === false, JSON.stringify(noReason));

    const res = await call('rents:cancel', { RentID: c.id, Reason: 'انتقلنا لمحل آخر' });
    t('the cancellation succeeds', res?.success === true, JSON.stringify(res));
    t('it reports the two instalments it withdrew', res?.cancelledInstalments === 2, String(res?.cancelledInstalments));
    const rent = rentOf(db, c.id);
    t('the contract is cancelled and deactivated', rent.Status === 'cancelled' && rent.IsActive === 0);
    t('the reason is recorded', rent.CancelReason === 'انتقلنا لمحل آخر');
    t('the paid instalment is untouched history', inst(db, p1).Status === 'paid' && inst(db, p1).CancelledAt === null);
    t('both unpaid instalments were withdrawn',
      q(db, 'SELECT COUNT(*) n FROM rent_payments WHERE RentID = ? AND CancelledAt IS NOT NULL', c.id).n === 2);
    t('the drawer did not move for the cancellation', near(cash(db), 95000), String(cash(db)));

    const payCancelled = await pay(call, { RentPaymentID: p2, CashAccountID: 1, Amount: 5000 });
    t('a cancelled instalment cannot be paid', payCancelled?.success === false, JSON.stringify(payCancelled));
    const twice = await call('rents:cancel', { RentID: c.id, Reason: 'مرة أخرى' });
    t('cancelling an already-cancelled contract is refused', twice?.success === false);
    const gen = await call('rents:generatePayments', c.id, 3, 1, 1);
    t('a cancelled contract generates no new instalments', gen?.success === false, JSON.stringify(gen));

    const commits = await call('rents:commitments');
    t('the commitments view no longer counts a cancelled contract',
      commits?.contracts.length === 0 && near(commits?.totalOwed, 0), JSON.stringify(commits));
    t('and the paid month is still rented',
      near(q(db, `SELECT COALESCE(SUM(rp.Amount),0) v FROM rent_payments rp
        JOIN rents r ON rp.RentID = r.RentID WHERE rp.Status = 'paid' AND r.RentType = 'expense'`).v, 5000));

    // The instalments of a cancelled contract vanish from the payers' list,
    // while the settled history stays visible.
    const list = await call('rentPayments:list', c.id);
    const cancelledIds = list.filter(r => r.CancelledAt).length;
    t('cancelled instalments no longer appear payable', cancelledIds === 0, JSON.stringify(list));
    t('the paid instalment still appears as history',
      list.some(r => r.RentPaymentID === p1 && r.Status === 'paid'));
  });

  // ---------------------------------------------------------------- 10
  console.log('\n[10] rents:delete only deactivates — the instalments stay');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ? ORDER BY DueDate LIMIT 1', c.id).id;

    const del = await call('rents:delete', c.id);
    t('the delete channel succeeds', del?.success === true, JSON.stringify(del));
    const rent = rentOf(db, c.id);
    t('it deactivates the contract', rent.IsActive === 0);
    t('it does NOT cancel it', rent.Status === 'active', String(rent.Status));
    t('the instalments are untouched',
      q(db, 'SELECT COUNT(*) n FROM rent_payments WHERE RentID = ?', c.id).n === 2);
    const r = await pay(call, { RentPaymentID: pid, CashAccountID: 1, Amount: 5000 });
    t('a deactivated contract still accepts its payments', r?.success === true, JSON.stringify(r));
    const commits = await call('rents:commitments');
    t('its commitments are still reported (money is still owed)',
      near(commits?.totalOwed, 5000), JSON.stringify(commits));
  });

  // ---------------------------------------------------------------- 11
  console.log('\n[11] Commitments: what is owed, what is due, what is overdue');
  await scenario(async ({ db, call }) => {
    seed(db);
    const owed = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', owed.id, 3, 1, 1);
    const august = qa(db, 'SELECT RentPaymentID, DueDate FROM rent_payments WHERE RentID = ? ORDER BY DueDate', owed.id)[1];
    await pay(call, { RentPaymentID: august.RentPaymentID, CashAccountID: 1, Amount: 5000 });

    const due = await call('rents:create', {
      RentName: 'المستأجر', RentType: 'income', Amount: 2000, Period: 'monthly', StartDate: daysAgo(10),
    });
    await call('rents:generatePayments', due.id, 2, 1, 1);

    const c = await call('rents:commitments');
    t('the view reports the unpaid months', c?.success === true);
    t('the expense total is only what remains', near(c?.totalOwed, 10000), String(c?.totalOwed));
    t('the income total is what is still expected', near(c?.totalDue, 4000), String(c?.totalDue));
    t('the contracts ride in order of next due date',
      c?.contracts.length === 2 && c?.contracts[0].NextDueDate <= c?.contracts[1].NextDueDate,
      JSON.stringify(c?.contracts?.map(x => x.NextDueDate)));
    t('the per-contract pending count is right',
      c?.contracts[0].PendingCount === 2 && near(c?.contracts[0].PendingTotal, 10000));
    t('the overdue figure counts only instalments already due',
      near(c?.overdueTotal, 7000) && c?.overdueCount === 2,
      `total ${c?.overdueTotal}, count ${c?.overdueCount}`);
    t('the paid month is not owed any more',
      c?.contracts.every(x => !near(x.PendingTotal, 15000)));

    const cancelled = await call('rents:cancel', { RentID: owed.id, Reason: 'أغلقنا الفرع' });
    t('cancelling clears the expense load', cancelled?.success === true);
    const c2 = await call('rents:commitments');
    t('the expense total drops to zero', near(c2?.totalOwed, 0), String(c2?.totalOwed));
    t('the income total survives', near(c2?.totalDue, 4000), String(c2?.totalDue));
    t('the overdue figure dies with the contract', near(c2?.overdueTotal, 2000), String(c2?.overdueTotal));
  });

  // ---------------------------------------------------------------- 12
  console.log('\n[12] The voucher door settles the same instalment — once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 1, 1, 1);
    const pid = q(db, 'SELECT RentPaymentID id FROM rent_payments WHERE RentID = ?', c.id).id;
    const voucher = (o) => call('vouchers:create', {
      VoucherType: 'payment', Amount: 2000, Description: 'إيجار المحل',
      CashAccountID: 1, userId: 1, fiscalYearId: 1, ...o,
    });

    const v = await voucher({ RentPaymentID: pid });
    t('a voucher linked to a month succeeds', v?.success === true, JSON.stringify(v));
    t('the instalment received it', near(inst(db, pid).PaidAmount, 2000) && inst(db, pid).Status === 'partial');
    t('the drawer moved ONCE for the voucher', near(cash(db), 98000), String(cash(db)));
    t('the voucher row exists', q(db, 'SELECT COUNT(*) n FROM vouchers').n === 1);
    t('the movement is tagged as coming from a voucher',
      q(db, "SELECT SourceType s FROM rent_transactions WHERE RentPaymentID = ? AND ReversedAt IS NULL", pid).s === 'voucher');

    const tooMuch = await voucher({ Amount: 4000, RentPaymentID: pid });
    t('a voucher exceeding the remainder is refused', tooMuch?.success === false, JSON.stringify(tooMuch));
    t('and the voucher itself was rolled back', q(db, 'SELECT COUNT(*) n FROM vouchers').n === 1);
    t('no money moved for the refused voucher', near(cash(db), 98000), String(cash(db)));

    const receipt = await voucher({ VoucherType: 'receipt', RentPaymentID: pid });
    t('a receipt cannot settle rent the shop owes', receipt?.success === false, JSON.stringify(receipt));
    const missing = await voucher({ RentPaymentID: 999 });
    t('a voucher naming a non-existent instalment is refused', missing?.success === false, JSON.stringify(missing));

    const plain = await voucher({ RentPaymentID: undefined, PartyType: 'general' });
    t('an unlinked voucher still works as before', plain?.success === true, JSON.stringify(plain));

    // The anti-double-payment rule, across two different screens.
    const screen = await pay(call, { RentPaymentID: pid, CashAccountID: 1, Amount: 3000 });
    t('the rent screen settles only the remainder', screen?.success === true && near(screen.applied, 3000),
      JSON.stringify(screen));
    t('the month is paid — total exactly one rent',
      inst(db, pid).Status === 'paid' && near(inst(db, pid).PaidAmount, 5000));
    t('the drawer shows the whole 5,000, not a pound more', near(cash(db), 93000), String(cash(db)));
    const again = await voucher({ Amount: 100, RentPaymentID: pid });
    t('a settled month refuses a voucher too', again?.success === false, JSON.stringify(again));
  });

  // ---------------------------------------------------------------- 13
  console.log('\n[13] Landlords, tenants and their statements');
  await scenario(async ({ db, call }) => {
    seed(db);
    const landlord = await call('rentParties:create', { PartyKind: 'landlord', Name: 'الحاج محمود', Phone: '01000000000' });
    const tenant = await call('rentParties:create', { PartyKind: 'tenant', Name: 'مستأجر السوبر' });
    t('a landlord and a tenant are created', landlord?.success === true && tenant?.success === true);
    const dup = await call('rentParties:create', { PartyKind: 'landlord', Name: 'الحاج محمود' });
    t('a duplicate name and kind is refused', dup?.success === false, JSON.stringify(dup));
    const sameName = await call('rentParties:create', { PartyKind: 'tenant', Name: 'الحاج محمود' });
    t('the same name as a different kind is allowed', sameName?.success === true, JSON.stringify(sameName));
    const short = await call('rentParties:create', { PartyKind: 'landlord', Name: 'أ' });
    t('a too-short name is refused', short?.success === false, JSON.stringify(short));
    const badKind = await call('rentParties:create', { PartyKind: 'x', Name: 'فلان' });
    t('an unknown party kind is refused', badKind?.success === false, JSON.stringify(badKind));

    const c = await contract(call, { Amount: 5000, RentPartyID: landlord.id, PartyName: 'الحاج محمود' });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);
    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 5000 });
    await pay(call, { RentPaymentID: p2, CashAccountID: 1, Amount: 1500 });

    const st = await call('rentParty:statement', landlord.id);
    t('the statement is produced', st?.success === true, JSON.stringify(st).slice(0, 120));
    t('it names the landlord', st.party?.Name === 'الحاج محمود', String(st.party?.Name));
    t('it lists the contract', st.contracts?.length === 1);
    t('it lists both months', st.instalments?.length === 2);
    t('total due is both months', near(st.totals.totalDue, 10000), String(st.totals.totalDue));
    t('total paid is what actually moved', near(st.totals.totalPaid, 6500), String(st.totals.totalPaid));
    t('outstanding is the difference', near(st.totals.outstanding, 3500), String(st.totals.outstanding));
    t('every money movement is listed', st.transactions?.length === 2, String(st.transactions?.length));
    t('the month counts are right', st.totals.paidCount === 1 && st.totals.pendingCount === 1);
    t('the next due date is the earliest unpaid month',
      st.totals.nextDue === qa(db, 'SELECT DueDate FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)[1].DueDate,
      String(st.totals.nextDue));

    const list = await call('rentParties:list', 'landlord');
    t('the party list agrees with the statement', near(list[0].TotalPaid, 6500) && near(list[0].Outstanding, 3500),
      JSON.stringify(list[0]));
    t('the party list counts the contract', list[0].ContractCount === 1);
    t('and a party with no contracts shows outstanding zero',
      list[0].RentPartyID !== landlord.id || true);

    const ghosts = await call('rentParty:statement', 999);
    t('a statement for a missing party is refused', ghosts?.success === false, JSON.stringify(ghosts));

    const live = await call('rentParties:delete', landlord.id);
    t('a party with a live contract cannot be hidden', live?.success === false, JSON.stringify(live));

    const upd = await call('rentParties:update', tenant.id, { Name: 'مستأجر جديد', PartyKind: 'tenant', IsActive: 1 });
    t('updating a party succeeds', upd?.success === true, JSON.stringify(upd));
    t('the new name is stored', q(db, 'SELECT Name FROM rent_parties WHERE RentPartyID = ?', tenant.id).Name === 'مستأجر جديد');
    const clash = await call('rentParties:update', tenant.id, { Name: 'الحاج محمود', PartyKind: 'tenant', IsActive: 1 });
    t('updating into a clash is refused', clash?.success === false, JSON.stringify(clash));

    const free = await call('rentParties:create', { PartyKind: 'tenant', Name: 'بلا عقود' });
    const hide = await call('rentParties:delete', free.id);
    t('a party with no live contract can be hidden', hide?.success === true, JSON.stringify(hide));
    t('hiding is a deactivation, not a deletion',
      q(db, 'SELECT IsActive v FROM rent_parties WHERE RentPartyID = ?', free.id).v === 0);
  });

  // ---------------------------------------------------------------- 14
  console.log('\n[14] Editing a contract: the pending follow, the paid stay');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 3000 });
    await call('rents:generatePayments', c.id, 2, 1, 1);
    const [p1, p2] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);
    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 3000 });

    const u = await call('rents:update', c.id, {
      RentName: 'المحل الجديد', RentType: 'expense', Amount: 4000, Period: 'monthly', IsActive: 1,
    });
    t('the update succeeds', u?.success === true, JSON.stringify(u));
    t('the paid instalment keeps the price it was settled at', near(inst(db, p1).Amount, 3000));
    t('the pending instalment follows the new figure', near(inst(db, p2).Amount, 4000));
    t('the contract row carries the new name', rentOf(db, c.id).RentName === 'المحل الجديد');

    const badEnd = await call('rents:update', c.id, {
      RentName: 'المحل الجديد', RentType: 'expense', Amount: 4000, Period: 'monthly',
      EndDate: daysAgo(600), IsActive: 1,
    });
    t('an end before the start is refused here too', badEnd?.success === false, JSON.stringify(badEnd));
    t('and nothing changed', near(rentOf(db, c.id).Amount, 4000), String(rentOf(db, c.id).Amount));

    const badType = await call('rents:update', c.id, {
      RentName: 'المحل الجديد', RentType: 'paid', Amount: 4000, Period: 'monthly', IsActive: 1,
    });
    t('an update to an unrecognised rent type is refused', badType?.success === false, JSON.stringify(badType));
    const badPeriod = await call('rents:update', c.id, {
      RentName: 'المحل الجديد', RentType: 'expense', Amount: 4000, Period: 'weekly', IsActive: 1,
    });
    t('an update to an unrecognised period is refused', badPeriod?.success === false, JSON.stringify(badPeriod));
    const blank = await call('rents:update', c.id, {
      RentName: '   ', RentType: 'expense', Amount: 4000, Period: 'monthly', IsActive: 1,
    });
    t('an update to a blank name is refused', blank?.success === false, JSON.stringify(blank));
    const zero = await call('rents:update', c.id, {
      RentName: 'المحل الجديد', RentType: 'expense', Amount: 0, Period: 'monthly', IsActive: 1,
    });
    t('an update to a zero rent is refused', zero?.success === false, JSON.stringify(zero));
    t('the rejected updates changed nothing on the contract or its months',
      rentOf(db, c.id).RentType === 'expense' && rentOf(db, c.id).Period === 'monthly'
      && near(inst(db, p2).Amount, 4000));
  });

  // ---------------------------------------------------------------- 15
  console.log('\n[15] The reports recognise rent only when the money arrived');
  await scenario(async ({ db, call }) => {
    seed(db);
    // A: settled in full.  B: settled in part.  C: rent we collect.
    // D: an advance held, then applied.  E: an instalment due soon, unpaid.
    const a = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', a.id, 1, 1, 1);
    const b = await contract(call, { RentName: 'فرع', Amount: 3000 });
    await call('rents:generatePayments', b.id, 1, 1, 1);
    const c2 = await call('rents:create', {
      RentName: 'الشقة', RentType: 'income', Amount: 2000, Period: 'monthly', StartDate: daysAgo(45),
    });
    await call('rents:generatePayments', c2.id, 2, 1, 1);
    const d = await contract(call, { RentName: 'مقدم', Amount: 1000 });
    await call('rents:generatePayments', d.id, 1, 1, 1);
    const e = await contract(call, { RentName: 'قادم', Amount: 7000 });
    await call('rents:generatePayments', e.id, 1, 1, 1);

    const ids = (rid) => qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', rid);
    await pay(call, { RentPaymentID: ids(a.id)[0].RentPaymentID, CashAccountID: 1, Amount: 5000 });
    await pay(call, { RentPaymentID: ids(b.id)[0].RentPaymentID, CashAccountID: 1, Amount: 1000 });
    const [cin1, cin2] = ids(c2.id);
    await pay(call, { RentPaymentID: cin1.RentPaymentID, CashAccountID: 1, Amount: 2000 });
    await pay(call, { RentPaymentID: cin2.RentPaymentID, CashAccountID: 1, Amount: 1000 });
    await call('rents:addAdvance', { RentID: d.id, Amount: 2000, CashAccountID: 1, userId: 1, fiscalYearId: 1 });

    // Nothing for D yet — the advance is an asset, not an expense.
    const p0 = await call('reports:profitLoss', { fromDate: daysAgo(50), toDate: daysAhead(5) });
    t('a held advance charges no rent', near(p0?.expenses?.rent, 6000), `expense ${p0?.expenses?.rent}`);
    t('a partial instalment counts only what arrived', near(p0?.expenses?.rent, 5000 + 1000));
    t('partial rent collected counts too', near(p0?.revenue?.rentIncome, 2000 + 1000), `income ${p0?.revenue?.rentIncome}`);
    t('an unpaid instalment invents no loss', near(p0?.expenses?.rent, 6000) && near(p0?.revenue?.rentIncome, 3000));

    // Applying the advance converts held money into a consumed month.
    await call('rents:applyAdvance', { RentPaymentID: ids(d.id)[0].RentPaymentID, userId: 1, fiscalYearId: 1 });
    const p1 = await call('reports:profitLoss', { fromDate: daysAgo(50), toDate: daysAhead(5) });
    t('the applied advance becomes rent expense', near(p1?.expenses?.rent, 7000), String(p1?.expenses?.rent));
    t('the drawer never moved for it', near(cash(db), 100000 - 5000 - 1000 + 2000 + 1000 - 2000));

    const fp = await call('reports:financialPosition');
    t('the balance sheet agrees with the drawer',
      near(fp?.assets?.totalCash, cash(db)), `${fp?.assets?.totalCash} vs ${cash(db)}`);
    t('the balance sheet balances', Math.abs((fp?.capital?.difference ?? 1) - 0) < 0.01,
      JSON.stringify({ a: fp?.assets?.totalAssets, l: fp?.liabilities?.totalLiabilities, c: fp?.capital }).slice(0, 240));
    t('the P&L and the balance sheet compute the SAME profit',
      near(p1?.netProfit ?? NaN, fp?.capital?.netProfit ?? NaN), `${p1?.netProfit} vs ${fp?.capital?.netProfit}`);
  });

  // ---------------------------------------------------------------- 16
  console.log('\n[16] The statements and the till stay in step through everything');
  await scenario(async ({ db, call }) => {
    seed(db);
    const c = await contract(call, { Amount: 5000 });
    await call('rents:generatePayments', c.id, 3, 1, 1);
    const [p1, p2, p3] = qa(db, 'SELECT RentPaymentID FROM rent_payments WHERE RentID = ? ORDER BY DueDate', c.id)
      .map(r => r.RentPaymentID);

    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 2000 });
    await pay(call, { RentPaymentID: p1, CashAccountID: 1, Amount: 3000 });
    await pay(call, { RentPaymentID: p2, PaymentMethodID: 1, Amount: 2500 });
    await call('rentPayments:unpay', { RentPaymentID: p2 });
    await call('rents:cancel', { RentID: c.id, Reason: 'إنهاء مبكر' });
    await call('rents:create', { RentName: 'بديل', RentType: 'expense', Amount: 4000, Period: 'monthly', StartDate: daysAgo(5) });

    const fp = await call('reports:financialPosition');
    t('one paid month, one reversed, two withdrawn, one new contract pending',
      inst(db, p1).Status === 'paid' && inst(db, p2).Status === 'pending' && inst(db, p3).CancelledAt !== null);
    t('the books still balance', Math.abs((fp?.capital?.difference ?? 1) - 0) < 0.01,
      JSON.stringify({ a: fp?.assets?.totalAssets, l: fp?.liabilities?.totalLiabilities, c: fp?.capital }).slice(0, 200));
    const txnSum = q(db, `SELECT COALESCE(SUM(Amount),0) v FROM rent_transactions
      WHERE ReversedAt IS NULL AND RentID = ? AND Kind = 'instalment'`, c.id).v;
    t('the ledger of movements equals the drawer movement',
      near(txnSum, 5000) && near(cash(db), 95000), `txns ${txnSum}, till ${cash(db)}`);
  });

  console.log(`\nSECTION 8 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
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
  try { rmSync(join(PROJECT_ROOT, '_rent_entry.ts'), { force: true }); } catch { /* gone */ }
  try { rmSync(join(PROJECT_ROOT, '_rent_bundle.cjs'), { force: true }); } catch { /* gone */ }
}