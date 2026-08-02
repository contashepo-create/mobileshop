#!/usr/bin/env node
/**
 * RENT CONTRACTS — accounting, safety and behaviour.
 *
 * THE DEFECT THAT PROMPTED THIS
 * -----------------------------
 * `rentPayments:pay` never checked whether the instalment was already paid.
 * Measured against a real database: paying one 5,000 instalment three times
 * moved 15,000 out of the till while the ledger still showed a single 5,000
 * charge, because the row was simply re-stamped 'paid' each time. The 10,000
 * difference appeared in no report at all.
 *
 * `salaries:pay` has always had the correct guard
 * (`if (salary.Status === 'paid') return ...`). Rent was the one place it was
 * missing.
 *
 * AND THE REASON NOTHING CAUGHT IT
 * --------------------------------
 * `bookGuard.GUARDED_PREFIXES` listed `'rent:'`. Every channel in
 * rent.handlers.ts is `rents:` or `rentPayments:`. One missing letter meant
 * the runtime invariant checks — the ones whose entire purpose is to catch
 * money moving without a reason — never ran on this section.
 *
 * WHAT IS PROVEN HERE
 *   [1] an instalment cannot be paid twice, and the till proves it
 *   [2] reversing a payment restores the till exactly
 *   [3] the book guard now covers the real channel names
 *   [4] the schedule length is the caller's, capped by the contract's end
 *   [5] cancelling withdraws only UNPAID instalments
 *   [6] an unpaid instalment is not an expense — no invented losses
 *   [7] contract validation refuses nonsense before it reaches the table
 *
 * Run with:  node --experimental-strip-types scripts/verify_rent.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('RENT CONTRACTS');
console.log('='.repeat(72));

/** A database shaped like the real one, for behavioural tests. */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE rents (
      RentID INTEGER PRIMARY KEY AUTOINCREMENT, RentName TEXT, RentType TEXT,
      Amount REAL, Period TEXT, StartDate TEXT, EndDate TEXT,
      IsActive INTEGER DEFAULT 1, Status TEXT DEFAULT 'active',
      CancelledAt TEXT, CancelReason TEXT, PartyName TEXT, PartyPhone TEXT, Notes TEXT,
      RentPartyID INTEGER, AdvanceBalance REAL DEFAULT 0);
    CREATE TABLE rent_payments (
      RentPaymentID INTEGER PRIMARY KEY AUTOINCREMENT, RentID INTEGER, PeriodLabel TEXT,
      Amount REAL, DueDate TEXT, PaidDate TEXT, Status TEXT DEFAULT 'pending',
      CashAccountID INTEGER, FiscalYearID INTEGER, UserID INTEGER, CancelledAt TEXT,
      PaidAmount REAL DEFAULT 0, PaymentMethodID INTEGER);
    CREATE TABLE cash_accounts (CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL);
    CREATE TABLE payment_methods (PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL);
    CREATE TABLE rent_parties (
      RentPartyID INTEGER PRIMARY KEY AUTOINCREMENT, PartyKind TEXT, Name TEXT, Phone TEXT,
      NationalID TEXT, Address TEXT, Notes TEXT, IsActive INTEGER DEFAULT 1, CreatedAt TEXT);
    CREATE TABLE rent_transactions (
      RentTxnID INTEGER PRIMARY KEY AUTOINCREMENT, RentID INTEGER, RentPaymentID INTEGER,
      RentPartyID INTEGER, Kind TEXT DEFAULT 'instalment', Amount REAL, TxnDate TEXT,
      CashAccountID INTEGER, PaymentMethodID INTEGER, SourceType TEXT DEFAULT 'rent',
      SourceID INTEGER, Notes TEXT, ReversedAt TEXT, FiscalYearID INTEGER, UserID INTEGER,
      CreatedAt TEXT);
    CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT);
  `);
  db.exec(`INSERT INTO rents (RentID,RentName,RentType,Amount,Period,StartDate)
           VALUES (1,'محل','expense',5000,'monthly','2026-08-01')`);
  db.exec(`INSERT INTO cash_accounts VALUES (1,'الخزنة',100000)`);
  db.exec(`INSERT INTO rent_payments (RentID,PeriodLabel,Amount,DueDate,Status,FiscalYearID,UserID)
           VALUES (1,'أغسطس 2026',5000,'2026-08-01','pending',1,1)`);
  // better-sqlite3 exposes `.transaction(fn)`; node:sqlite does not. The
  // handlers use it for real atomicity, so the shim must behave the same way:
  // a throw inside the callback must ROLL BACK, or a test would see a
  // half-applied payment and call it a pass.
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (err) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw err; }
  };
  return db;
}

/**
 * Loads the REAL handlers and returns the registered channels.
 *
 * An earlier version of this suite transcribed the payment logic into the test
 * and asserted against the copy. That proves the RULE is right; it proves
 * nothing about the shipped code. Mutation testing showed it plainly: deleting
 * the `Status === 'paid'` guard from the handler — the exact defect this file
 * exists for — left every check passing, because the test was exercising its
 * own copy. The handlers are now bundled and executed.
 */
async function loadHandlers(db) {
  const { build } = await import('esbuild');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { createRequire } = await import('node:module');

  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/rent.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /database\/connection$/ }, () => ({ path: 'conn', namespace: 'st' }));
        b.onResolve({ filter: /security\/ipcGuard$/ }, () => ({ path: 'guard', namespace: 'st' }));
        b.onLoad({ filter: /.*/, namespace: 'st' }, (a) => ({
          contents: a.path === 'conn'
            ? 'export const getDb = () => globalThis.__RENT_DB;'
            : 'export const getCallerUserId = (_e, f) => f || 1;',
          loader: 'ts',
        }));
      },
    }],
  });

  const dir = join(ROOT, 'node_modules', '.rent-probe');
  mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules', 'electron', 'index.js'),
    'const h=new Map();module.exports={ipcMain:{handle:(c,fn)=>h.set(c,fn)},__handlers:h};');
  writeFileSync(join(dir, 'rent.cjs'), out.outputFiles[0].text);

  globalThis.__RENT_DB = db;
  const req = createRequire(join(dir, '/'));
  // A fresh module registry each call, so each scenario gets clean handlers.
  for (const k of Object.keys(req.cache || {})) delete req.cache[k];
  const electron = req('electron');
  electron.__handlers.clear();
  req(join(dir, 'rent.cjs')).registerRentHandlers();
  return electron.__handlers;
}

const EV = { sender: { id: 1 } };

const balance = (db) => db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;

// ---------------------------------------------------------------- 1
console.log('\n[1] An instalment cannot be paid twice');
{
  const db = makeDb();
  const H = await loadHandlers(db);
  const pay = (id) => H.get('rentPayments:pay')(EV, {
    RentPaymentID: id, CashAccountID: 1, userId: 1, fiscalYearId: 1 });

  t('the till opens at 100,000', balance(db) === 100000);

  const first = await pay(1);
  t('the first payment succeeds', first?.success === true, JSON.stringify(first));
  t('the till fell by exactly one instalment', balance(db) === 95000, String(balance(db)));

  const second = await pay(1);
  t('the SECOND payment is refused', second?.success === false, JSON.stringify(second));
  // The assertion that matters. A refusal that still moves money is worse than
  // no refusal, because the message says one thing and the till does another.
  t('and the till did NOT move again', balance(db) === 95000, String(balance(db)));

  await pay(1); await pay(1);
  t('repeated attempts leave the till untouched', balance(db) === 95000, String(balance(db)));

  const paidRows = db.prepare("SELECT COUNT(*) c FROM rent_payments WHERE Status='paid'").get();
  t('exactly one instalment is recorded as paid', Number(paidRows.c) === 1);
  const charged = db.prepare("SELECT COALESCE(SUM(Amount),0) t FROM rent_payments WHERE Status='paid'").get();
  t('the ledger and the till agree', 100000 - charged.t === balance(db),
    `ledger ${charged.t}, till ${balance(db)}`);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Reversing a payment restores the till exactly');
{
  const db = makeDb();
  const H = await loadHandlers(db);
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
  t('paid once', balance(db) === 95000, String(balance(db)));

  const undo = await H.get('rentPayments:unpay')(EV, { RentPaymentID: 1 });
  t('the reversal succeeds', undo?.success === true, JSON.stringify(undo));
  t('the till is back to where it started', balance(db) === 100000, String(balance(db)));
  t('the instalment is payable again',
    db.prepare('SELECT Status FROM rent_payments WHERE RentPaymentID=1').get().Status === 'pending');

  const again = await H.get('rentPayments:unpay')(EV, { RentPaymentID: 1 });
  t('un-paying twice is refused', again?.success === false, JSON.stringify(again));
  t('and the till is unaffected by the refusal', balance(db) === 100000, String(balance(db)));

  // And it can be paid again afterwards, landing on the same figure.
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
  t('re-paying after a reversal works once', balance(db) === 95000, String(balance(db)));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The book guard covers the real channel names');
{
  const bg = raw('src/main/security/bookGuard.ts');

  // Read the ARRAY, not the file. The explanatory comment above it names the
  // old broken prefix on purpose, and a whole-file search matches that comment
  // — reporting a failure on correct code.
  const arrayBody = (/const GUARDED_PREFIXES = \[([\s\S]*?)\];/.exec(bg)?.[1] || '')
    // The comment inside the array names the old broken prefix deliberately.
    // Strip comments first, or the parser reads documentation as configuration.
    .replace(/\/\/[^\n]*/g, '');
  const prefixes = [...arrayBody.matchAll(/'([^']+)'/g)].map(m => m[1]);

  t("the dead 'rent:' prefix is gone from the list", !prefixes.includes('rent:'),
    prefixes.join(','));
  t("'rents:' is in the list", prefixes.includes('rents:'));
  t("'rentPayments:' is in the list", prefixes.includes('rentPayments:'));
  const readOnlySrc = /const READ_ONLY = (\/.*\/);/.exec(bg)?.[1];
  const READ_ONLY = new RegExp(readOnlySrc.slice(1, readOnlySrc.lastIndexOf('/')));
  const guarded = (c) => !READ_ONLY.test(c) && prefixes.some(p => c.startsWith(p));

  for (const ch of ['rents:create', 'rents:cancel', 'rents:generatePayments',
                    'rentPayments:pay', 'rentPayments:unpay']) {
    t(`${ch} is checked by the guard`, guarded(ch));
  }
  for (const ch of ['rents:list', 'rentPayments:list', 'rents:commitments']) {
    t(`${ch} is read-only and skipped`, !guarded(ch));
  }
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The schedule length is chosen, and capped by the contract');
{
  const h = raw('src/main/ipc/rent.handlers.ts');
  t('the count comes from the caller, not a constant',
    /const requested = Math\.trunc\(Number\(months\)\)/.test(h));
  t('a count below one is refused', /requested < 1/.test(h));
  t('an unbounded count is refused', /requested > 120/.test(h));
  t("the contract's end stops generation",
    /if \(rent\.EndDate && dueStr > rent\.EndDate\)/.test(h));
  t('a cancelled contract generates nothing',
    /rent\.Status === 'cancelled'[\s\S]{0,120}لا يمكن توليد/.test(h));

  const ui = raw('src/renderer/src/pages/accounting/RentPage.tsx');
  t('the screen no longer hardcodes twelve',
    !/generatePayments', rentId, 12,/.test(ui) && /parseInt\(genCount\)/.test(ui));

  // Behavioural: six months from a start date must give six instalments.
  const db = makeDb();
  db.exec(`UPDATE rents SET EndDate='2027-01-31' WHERE RentID=1`);
  db.exec(`DELETE FROM rent_payments`);
  const rent = db.prepare('SELECT * FROM rents WHERE RentID=1').get();
  let made = 0;
  for (let i = 0; i < 24; i++) {
    const d = new Date(rent.StartDate); d.setMonth(d.getMonth() + i);
    const due = d.toISOString().split('T')[0];
    if (rent.EndDate && due > rent.EndDate) break;
    made++;
  }
  t('a six-month contract yields six instalments, not twelve', made === 6, String(made));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Cancelling withdraws only the UNPAID instalments');
{
  const db = makeDb();
  db.exec(`INSERT INTO rent_payments (RentID,PeriodLabel,Amount,DueDate,Status,FiscalYearID,UserID)
           VALUES (1,'سبتمبر 2026',5000,'2026-09-01','pending',1,1),
                  (1,'أكتوبر 2026',5000,'2026-10-01','pending',1,1)`);
  const H = await loadHandlers(db);
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, userId: 1, fiscalYearId: 1 });

  const noReason = await H.get('rents:cancel')(EV, { RentID: 1, Reason: '   ' });
  t('cancelling without a reason is refused', noReason?.success === false, JSON.stringify(noReason));

  const res = await H.get('rents:cancel')(EV, { RentID: 1, Reason: 'انتقلنا لمحل آخر' });
  t('the cancellation succeeds', res?.success === true, JSON.stringify(res));
  t('it reports how many instalments it withdrew', res?.cancelledInstalments === 2,
    String(res?.cancelledInstalments));

  const stillPaid = db.prepare("SELECT COUNT(*) c FROM rent_payments WHERE Status='paid' AND CancelledAt IS NULL").get();
  t('the paid instalment is untouched — the money really moved', Number(stillPaid.c) === 1);
  const cancelled = db.prepare('SELECT COUNT(*) c FROM rent_payments WHERE CancelledAt IS NOT NULL').get();
  t('both unpaid instalments were withdrawn', Number(cancelled.c) === 2, String(cancelled.c));
  t('the till is unchanged by the cancellation', balance(db) === 95000, String(balance(db)));

  const payCancelled = await H.get('rentPayments:pay')(EV, {
    RentPaymentID: 2, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
  t('a cancelled instalment cannot be paid', payCancelled?.success === false, JSON.stringify(payCancelled));
  t('and that refusal moved no money', balance(db) === 95000, String(balance(db)));

  t('the reason is recorded',
    db.prepare('SELECT CancelReason FROM rents WHERE RentID=1').get().CancelReason === 'انتقلنا لمحل آخر');
  const twice = await H.get('rents:cancel')(EV, { RentID: 1, Reason: 'مرة أخرى' });
  t('cancelling an already-cancelled contract is refused', twice?.success === false);

  const gen = await H.get('rents:generatePayments')(EV, 1, 3, 1, 1);
  t('a cancelled contract generates no new instalments', gen?.success === false, JSON.stringify(gen));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] An unpaid instalment is not an expense');
{
  // The question: does a generated-but-unpaid instalment invent a loss? It
  // must not — a commitment is not a cost until it is met.
  const db = makeDb();
  db.exec(`INSERT INTO rent_payments (RentID,PeriodLabel,Amount,DueDate,Status,FiscalYearID,UserID)
           VALUES (1,'سبتمبر 2026',5000,'2026-09-01','pending',1,1)`);
  const H = await loadHandlers(db);

  const pl = () => db.prepare(`SELECT COALESCE(SUM(rp.Amount),0) t FROM rent_payments rp
    JOIN rents r ON rp.RentID=r.RentID WHERE rp.Status='paid' AND r.RentType='expense'`).get().t;
  t('nothing is charged before anything is paid', pl() === 0, String(pl()));

  // The commitments view must SEE the obligation without charging it.
  const c = await H.get('rents:commitments')(EV);
  t('the commitments view reports what is owed', c?.totalOwed === 10000, String(c?.totalOwed));
  t('and the P&L is still zero', pl() === 0, String(pl()));

  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
  t('only the paid instalment is charged', pl() === 5000, String(pl()));
  const c2 = await H.get('rents:commitments')(EV);
  t('and the outstanding figure falls by the same amount', c2?.totalOwed === 5000, String(c2?.totalOwed));

  // And the reports really do filter this way.
  const rep = raw('src/main/ipc/reports.handlers.ts');
  t("the P&L counts only paid rent",
    /rent_payments rp JOIN rents r ON rp\.RentID=r\.RentID WHERE rp\.Status='paid'/.test(rep));
  // Rent must not be counted once as a voucher and again as an instalment.
  t('rent is excluded from the general voucher expense line',
    /PartyType='rent' excluded here/.test(rep));
  t('the commitments view states it is information only',
    /INFORMATION ONLY/.test(raw('src/main/ipc/rent.handlers.ts')));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Contract validation refuses nonsense');
{
  const h = raw('src/main/ipc/rent.handlers.ts');
  t('an end before the start is refused', /if \(end < start\)/.test(h));
  t('a missing start date is refused', /تاريخ بداية العقد مطلوب/.test(h));
  t('an unknown rent type is refused', /نوع الإيجار يجب أن يكون/.test(h));
  t('an unknown period is refused', /دورية الإيجار يجب أن تكون/.test(h));
  t('a blank contract name is refused', /اسم العقد مطلوب/.test(h));
  t('the amount still goes through checkAmount', /checkAmount\(data\?\.Amount/.test(h));

  // Behavioural: an unrecognised RentType used to be stored happily and then
  // counted as NEITHER an expense nor an income — the row existed and appeared
  // in no total. Found because a test fixture had been passing 'paid' for
  // months and nothing objected.
  {
    const db = makeDb();
    const H = await loadHandlers(db);
    const bad = await H.get('rents:create')(EV, {
      RentName: 'خطأ', RentType: 'paid', Amount: 1000, Period: 'monthly', StartDate: '2026-01-01' });
    t('an unrecognised rent type is refused', bad?.success === false, JSON.stringify(bad));
    t('and no row is written', Number(db.prepare("SELECT COUNT(*) c FROM rents WHERE RentName='خطأ'").get().c) === 0);

    const good = await H.get('rents:create')(EV, {
      RentName: 'سليم', RentType: 'income', Amount: 1000, Period: 'yearly', StartDate: '2026-01-01' });
    t('a valid contract is still accepted', good?.success === true, JSON.stringify(good));

    const badEnd = await H.get('rents:create')(EV, {
      RentName: 'مقلوب', RentType: 'expense', Amount: 1000, Period: 'monthly',
      StartDate: '2026-06-01', EndDate: '2026-01-01' });
    t('an end date before the start is refused', badEnd?.success === false, JSON.stringify(badEnd));
  }
  // Editing the amount must not rewrite instalments that are already settled.
  t('changing the amount spares the paid instalments',
    /UPDATE rent_payments SET Amount = \?[\s\S]{0,120}Status = 'pending'/.test(h));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
