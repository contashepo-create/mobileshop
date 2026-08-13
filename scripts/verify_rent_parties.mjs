#!/usr/bin/env node
/**
 * RENT: PARTIAL PAYMENTS, ADVANCES, VOUCHER LINKING AND PARTY STATEMENTS.
 *
 * WHAT WAS ASKED, AND WHAT WAS FOUND
 * ----------------------------------
 * Five questions were put to the rent section. Measured answers before this
 * change:
 *
 *   "can rent be paid from anywhere but the rent page?"  — no, one call site
 *   "can I pay half now and half later?"                 — no, all or nothing
 *   "can I choose the payment source?"                   — cash box only, no
 *                                                          wallet, while
 *                                                          vouchers had both
 *   "can a voucher settle a month, without double-paying?" — no link at all
 *   "is there a landlord/tenant account?"                — no, the other party
 *                                                          was two free-text
 *                                                          columns
 *
 * The voucher gap was the dangerous one. `PartyType='rent'` is EXCLUDED from
 * the general expense line (rent is supposed to arrive from rent_payments), so
 * a voucher written for rent moved money out of the till and appeared in NO
 * expense figure anywhere — and left the month unpaid, so it could be settled
 * again from the rent screen.
 *
 * WHAT IS PROVEN HERE
 *   [1] an instalment accepts part payments and totals them correctly
 *   [2] it can never receive more than it owes, from EITHER door
 *   [3] a voucher settles a real month, and is rolled back if it cannot
 *   [4] wallets work as a payment source, not just cash boxes
 *   [5] an advance is held, not expensed, until it is applied
 *   [6] reversing returns money to the accounts it came from
 *   [7] a party statement adds up
 *
 * Run with:  node --experimental-strip-types scripts/verify_rent_parties.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');
const near = (a, b) => Math.abs(a - b) < 0.005;

console.log('='.repeat(72));
console.log('RENT — PARTIALS, ADVANCES, VOUCHERS, PARTIES');
console.log('='.repeat(72));

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE rents (
      RentID INTEGER PRIMARY KEY AUTOINCREMENT, RentName TEXT, RentType TEXT,
      Amount REAL, Period TEXT, StartDate TEXT, EndDate TEXT,
      IsActive INTEGER DEFAULT 1, Status TEXT DEFAULT 'active',
      CancelledAt TEXT, CancelReason TEXT, PartyName TEXT, PartyPhone TEXT,
      Notes TEXT, RentPartyID INTEGER, AdvanceBalance REAL DEFAULT 0);
    CREATE TABLE rent_payments (
      RentPaymentID INTEGER PRIMARY KEY AUTOINCREMENT, RentID INTEGER, PeriodLabel TEXT,
      Amount REAL, DueDate TEXT, PaidDate TEXT, Status TEXT DEFAULT 'pending',
      CashAccountID INTEGER, FiscalYearID INTEGER, UserID INTEGER, CancelledAt TEXT,
      PaidAmount REAL DEFAULT 0, PaymentMethodID INTEGER);
    CREATE TABLE rent_parties (
      RentPartyID INTEGER PRIMARY KEY AUTOINCREMENT, PartyKind TEXT, Name TEXT,
      Phone TEXT, NationalID TEXT, Address TEXT, Notes TEXT, IsActive INTEGER DEFAULT 1,
      CreatedAt TEXT);
    CREATE TABLE rent_transactions (
      RentTxnID INTEGER PRIMARY KEY AUTOINCREMENT, RentID INTEGER, RentPaymentID INTEGER,
      RentPartyID INTEGER, Kind TEXT DEFAULT 'instalment', Amount REAL, TxnDate TEXT,
      CashAccountID INTEGER, PaymentMethodID INTEGER, SourceType TEXT DEFAULT 'rent',
      SourceID INTEGER, Notes TEXT, ReversedAt TEXT, FiscalYearID INTEGER,
      UserID INTEGER, CreatedAt TEXT);
    CREATE TABLE cash_accounts (CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL, IsActive INTEGER DEFAULT 1);
    CREATE TABLE payment_methods (PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL, IsActive INTEGER DEFAULT 1);
    CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT);
    CREATE TABLE vouchers (
      VoucherID INTEGER PRIMARY KEY AUTOINCREMENT, VoucherNumber TEXT, VoucherType TEXT,
      FiscalYearID INTEGER, Date TEXT, Amount REAL, PartyType TEXT, PartyID INTEGER,
      PartyName TEXT, Description TEXT, CashAccountID INTEGER, PaymentMethodID INTEGER,
      ReferenceType TEXT, ReferenceID INTEGER, UserID INTEGER);
  `);
  db.exec(`INSERT INTO rent_parties (RentPartyID,PartyKind,Name,Phone)
           VALUES (1,'landlord','الحاج محمود','01000000000')`);
  db.exec(`INSERT INTO rents (RentID,RentName,RentType,Amount,Period,StartDate,RentPartyID)
           VALUES (1,'المحل','expense',5000,'monthly','2026-08-01',1)`);
  db.exec(`INSERT INTO cash_accounts (CashAccountID, AccountName, Balance) VALUES (1,'الخزنة',100000)`);
  db.exec(`INSERT INTO payment_methods (PaymentMethodID, MethodName, Balance) VALUES (1,'فودافون كاش',20000)`);
  db.exec(`INSERT INTO rent_payments (RentID,PeriodLabel,Amount,DueDate,Status,FiscalYearID,UserID)
           VALUES (1,'أغسطس 2026',5000,'2026-08-01','pending',1,1),
                  (1,'سبتمبر 2026',5000,'2026-09-01','pending',1,1)`);
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
  };
  return db;
}

/** Bundles and runs the REAL handlers — not a transcription of them. */
async function loadHandlers(db, entry, registrar) {
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /database\/connection$/ }, () => ({ path: 'conn', namespace: 'st' }));
        b.onResolve({ filter: /security\/ipcGuard$/ }, () => ({ path: 'guard', namespace: 'st' }));
        b.onResolve({ filter: /database\/docNumber$/ }, () => ({ path: 'doc', namespace: 'st' }));
        b.onLoad({ filter: /.*/, namespace: 'st' }, (a) => ({
          contents: a.path === 'conn'
            ? 'export const getDb = () => globalThis.__RP_DB;'
            : a.path === 'doc'
              ? 'export const nextDocNumber = () => "PAY-1";'
              : 'export const getCallerUserId = (_e, f) => f || 1;',
          loader: 'ts',
        }));
      },
    }],
  });
  const dir = join(ROOT, 'node_modules', '.rentparty-probe');
  mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules', 'electron', 'index.js'),
    'const h=new Map();module.exports={ipcMain:{handle:(c,fn)=>h.set(c,fn)},__handlers:h};');
  const file = `m${Math.random().toString(36).slice(2)}.cjs`;
  writeFileSync(join(dir, file), out.outputFiles[0].text);
  globalThis.__RP_DB = db;
  const req = createRequire(join(dir, '/'));
  const electron = req('electron');
  req(join(dir, file))[registrar]();
  return electron.__handlers;
}

const EV = { sender: { id: 1 } };
const cash = (db) => db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;
const wallet = (db) => db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID=1').get().Balance;
const inst = (db, id) => db.prepare('SELECT * FROM rent_payments WHERE RentPaymentID=?').get(id);

// ---------------------------------------------------------------- 1
console.log('\n[1] An instalment accepts part payments');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  const pay = (o) => H.get('rentPayments:pay')(EV, { userId: 1, fiscalYearId: 1, ...o });

  const a = await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 2000 });
  t('half of the rent is accepted', a?.success === true, JSON.stringify(a));
  t('the instalment is marked partial', inst(db, 1).Status === 'partial', inst(db, 1).Status);
  t('it records 2,000 received', near(inst(db, 1).PaidAmount, 2000), String(inst(db, 1).PaidAmount));
  t('it reports 3,000 still owing', near(a.remaining, 3000), String(a.remaining));
  t('the till moved by exactly 2,000', near(cash(db), 98000), String(cash(db)));

  const b = await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 3000 });
  t('the rest is accepted later', b?.success === true, JSON.stringify(b));
  t('the instalment is now fully paid', inst(db, 1).Status === 'paid');
  t('the total received equals the rent', near(inst(db, 1).PaidAmount, 5000));
  t('the till fell by 5,000 in total, not more', near(cash(db), 95000), String(cash(db)));
  t('a paid date is stamped only at the end', !!inst(db, 1).PaidDate);
  t('both movements are recorded separately',
    db.prepare('SELECT COUNT(*) c FROM rent_transactions WHERE RentPaymentID=1').get().c === 2);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] An instalment can never take more than it owes');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  const pay = (o) => H.get('rentPayments:pay')(EV, { userId: 1, fiscalYearId: 1, ...o });

  const over = await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 6000 });
  t('more than the whole rent is refused', over?.success === false, JSON.stringify(over));
  t('and nothing left the till', near(cash(db), 100000), String(cash(db)));

  await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 4000 });
  const overRest = await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 2000 });
  t('more than the REMAINDER is refused', overRest?.success === false, JSON.stringify(overRest));
  t('the till still shows only the 4,000', near(cash(db), 96000), String(cash(db)));

  await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 1000 });
  const after = await pay({ RentPaymentID: 1, CashAccountID: 1, Amount: 100 });
  t('a settled month refuses any further money', after?.success === false, JSON.stringify(after));
  t('the till is exactly one rent lighter', near(cash(db), 95000), String(cash(db)));

  const zero = await pay({ RentPaymentID: 2, CashAccountID: 1, Amount: 0 });
  t('a zero payment is refused', zero?.success === false);
  const neg = await pay({ RentPaymentID: 2, CashAccountID: 1, Amount: -500 });
  t('a negative payment is refused', neg?.success === false);
  t('neither moved money', near(cash(db), 95000), String(cash(db)));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A voucher settles a real month, or is rolled back');
{
  const db = makeDb();
  const V = await loadHandlers(db, 'src/main/ipc/vouchers.handlers.ts', 'registerVouchersHandlers');
  const mk = (o) => V.get('vouchers:create')(EV, {
    VoucherType: 'payment', Amount: 2000, Description: 'إيجار',
    CashAccountID: 1, userId: 1, fiscalYearId: 1, ...o });

  const v = await mk({ RentPaymentID: 1 });
  t('a voucher linked to a month succeeds', v?.success === true, JSON.stringify(v));
  t('the instalment actually received it', near(inst(db, 1).PaidAmount, 2000),
    String(inst(db, 1).PaidAmount));
  t('the month is partial, not paid', inst(db, 1).Status === 'partial');
  t('the till moved ONCE, not twice', near(cash(db), 98000), String(cash(db)));
  t('the movement is tagged as coming from a voucher',
    db.prepare("SELECT SourceType FROM rent_transactions WHERE RentPaymentID=1").get().SourceType === 'voucher');

  // The anti-double-payment rule, across two different screens.
  const tooMuch = await mk({ RentPaymentID: 1, Amount: 4000 });
  t('a voucher exceeding the remainder is refused', tooMuch?.success === false, JSON.stringify(tooMuch));
  t('and the voucher itself was rolled back',
    db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 1,
    String(db.prepare('SELECT COUNT(*) c FROM vouchers').get().c));
  t('no money moved for the refused voucher', near(cash(db), 98000), String(cash(db)));

  const receipt = await mk({ RentPaymentID: 2, VoucherType: 'receipt' });
  t('a RECEIPT cannot settle a rent the shop owes', receipt?.success === false, JSON.stringify(receipt));

  const missing = await mk({ RentPaymentID: 999 });
  t('a voucher naming a non-existent instalment is refused', missing?.success === false);

  // An ordinary voucher with no rent link must still work exactly as before.
  const plain = await mk({ RentPaymentID: undefined, PartyType: 'general' });
  t('an unlinked voucher still works', plain?.success === true, JSON.stringify(plain));

  // The ROLLBACK, exercised on its own.
  //
  // The pre-flight check above rejects every bad link before the transaction
  // opens, so it masks the rollback entirely — deleting the `throw` left this
  // section green. The one case pre-flight cannot see is a contract that is
  // cancelled: the instalment itself is valid and has a remaining balance, so
  // the checks pass, and only `applyToInstalment` refuses it once the
  // transaction is already writing.
  {
    const db2 = makeDb();
    const V2 = await loadHandlers(db2, 'src/main/ipc/vouchers.handlers.ts', 'registerVouchersHandlers');
    db2.exec("UPDATE rents SET Status='cancelled' WHERE RentID=1");
    const before = cash(db2);
    const r = await V2.get('vouchers:create')(EV, {
      VoucherType: 'payment', Amount: 1000, Description: 'إيجار',
      CashAccountID: 1, RentPaymentID: 1, userId: 1, fiscalYearId: 1 });
    t('a voucher against a CANCELLED contract is refused', r?.success === false, JSON.stringify(r));
    t('the voucher row was rolled back',
      db2.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 0,
      String(db2.prepare('SELECT COUNT(*) c FROM vouchers').get().c));
    t('and the till was restored by the rollback', near(cash(db2), before), String(cash(db2)));
    t('the instalment received nothing', near(inst(db2, 1).PaidAmount, 0));
  }
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A wallet is a valid source, not just a cash box');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  const r = await H.get('rentPayments:pay')(EV, {
    RentPaymentID: 1, PaymentMethodID: 1, Amount: 5000, userId: 1, fiscalYearId: 1 });
  t('rent can be paid from a wallet', r?.success === true, JSON.stringify(r));
  t('the wallet was debited', near(wallet(db), 15000), String(wallet(db)));
  t('and the cash box was NOT', near(cash(db), 100000), String(cash(db)));

  const none = await H.get('rentPayments:pay')(EV, {
    RentPaymentID: 2, Amount: 100, userId: 1, fiscalYearId: 1 });
  t('a payment with no source at all is refused', none?.success === false, JSON.stringify(none));

  // Funds are checked against the source actually named.
  const db2 = makeDb();
  const H2 = await loadHandlers(db2, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  db2.exec('UPDATE payment_methods SET Balance = 100 WHERE PaymentMethodID=1');
  const broke = await H2.get('rentPayments:pay')(EV, {
    RentPaymentID: 1, PaymentMethodID: 1, Amount: 5000, userId: 1, fiscalYearId: 1 });
  t('an underfunded wallet is refused', broke?.success === false, JSON.stringify(broke));
  t('and the cash box was not raided instead', near(cash(db2), 100000), String(cash(db2)));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] An advance is held, not expensed, until applied');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');

  const adv = await H.get('rents:addAdvance')(EV, {
    RentID: 1, Amount: 10000, CashAccountID: 1, userId: 1, fiscalYearId: 1 });
  t('a deposit is accepted', adv?.success === true, JSON.stringify(adv));
  t('the money left the till', near(cash(db), 90000), String(cash(db)));
  t('it is held against the contract',
    near(db.prepare('SELECT AdvanceBalance FROM rents WHERE RentID=1').get().AdvanceBalance, 10000));

  // The accounting claim: an advance is NOT rent paid.
  const charged = db.prepare(`SELECT COALESCE(SUM(rp.PaidAmount),0) t FROM rent_payments rp
    JOIN rents r ON r.RentID=rp.RentID WHERE r.RentType='expense'`).get();
  t('no month has been charged by it', near(charged.t, 0), String(charged.t));

  const use = await H.get('rents:applyAdvance')(EV, { RentPaymentID: 1, userId: 1, fiscalYearId: 1 });
  t('the advance settles a month', use?.success === true, JSON.stringify(use));
  t('the month is now paid', inst(db, 1).Status === 'paid');
  t('the held balance fell by the rent',
    near(db.prepare('SELECT AdvanceBalance FROM rents WHERE RentID=1').get().AdvanceBalance, 5000));
  // The cash left when the deposit was taken; applying it must not take it again.
  t('applying it moved NO further cash', near(cash(db), 90000), String(cash(db)));

  await H.get('rents:applyAdvance')(EV, { RentPaymentID: 2, userId: 1, fiscalYearId: 1 });
  const exhausted = await H.get('rents:applyAdvance')(EV, { RentPaymentID: 2, userId: 1, fiscalYearId: 1 });
  t('an exhausted advance cannot be applied again', exhausted?.success === false,
    JSON.stringify(exhausted));
  t('the held balance is zero', near(db.prepare('SELECT AdvanceBalance FROM rents WHERE RentID=1').get().AdvanceBalance, 0));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Reversing returns money to the accounts it came from');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  // Half from the till, half from the wallet — the case a single-account
  // reversal would get wrong.
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, Amount: 2000, userId: 1, fiscalYearId: 1 });
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, PaymentMethodID: 1, Amount: 3000, userId: 1, fiscalYearId: 1 });
  t('the month is settled from two sources', inst(db, 1).Status === 'paid');
  t('the till gave 2,000', near(cash(db), 98000), String(cash(db)));
  t('the wallet gave 3,000', near(wallet(db), 17000), String(wallet(db)));

  const undo = await H.get('rentPayments:unpay')(EV, { RentPaymentID: 1 });
  t('the reversal succeeds', undo?.success === true, JSON.stringify(undo));
  t('the till got its 2,000 back', near(cash(db), 100000), String(cash(db)));
  t('the wallet got its 3,000 back', near(wallet(db), 20000), String(wallet(db)));
  t('the month is payable again', inst(db, 1).Status === 'pending');
  t('and shows nothing received', near(inst(db, 1).PaidAmount, 0));
  t('the movements are marked reversed, not deleted',
    db.prepare('SELECT COUNT(*) c FROM rent_transactions WHERE ReversedAt IS NOT NULL').get().c === 2);
}

// ---------------------------------------------------------------- 6b
console.log('\n[6b] An INCOME contract moves money the other way');
{
  // Every fixture above is an expense contract, so a mutant that made income
  // rent debit the till instead of crediting it survived unnoticed. A shop
  // that sublets a unit takes money IN, and the direction must follow the
  // contract type rather than being assumed.
  const db = makeDb();
  db.exec(`INSERT INTO rent_parties (RentPartyID,PartyKind,Name) VALUES (2,'tenant','مستأجر')`);
  db.exec(`INSERT INTO rents (RentID,RentName,RentType,Amount,Period,StartDate,RentPartyID)
           VALUES (2,'الشقة','income',3000,'monthly','2026-08-01',2)`);
  db.exec(`INSERT INTO rent_payments (RentPaymentID,RentID,PeriodLabel,Amount,DueDate,Status,FiscalYearID,UserID)
           VALUES (50,2,'أغسطس 2026',3000,'2026-08-01','pending',1,1)`);
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');

  const before = cash(db);
  const r = await H.get('rentPayments:pay')(EV, {
    RentPaymentID: 50, CashAccountID: 1, Amount: 3000, userId: 1, fiscalYearId: 1 });
  t('rent owed TO the shop is collected', r?.success === true, JSON.stringify(r));
  t('and the till goes UP, not down', near(cash(db), before + 3000), String(cash(db)));

  const undo = await H.get('rentPayments:unpay')(EV, { RentPaymentID: 50 });
  t('reversing a collection succeeds', undo?.success === true, JSON.stringify(undo));
  t('and takes the money back out', near(cash(db), before), String(cash(db)));

  // Collecting rent never needs the till to be funded first.
  db.exec('UPDATE cash_accounts SET Balance = 0 WHERE CashAccountID=1');
  const poor = await H.get('rentPayments:pay')(EV, {
    RentPaymentID: 50, CashAccountID: 1, Amount: 3000, userId: 1, fiscalYearId: 1 });
  t('an empty till does not block a collection', poor?.success === true, JSON.stringify(poor));
  t('the collection still credits it', near(cash(db), 3000), String(cash(db)));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] A party statement adds up');
{
  const db = makeDb();
  const H = await loadHandlers(db, 'src/main/ipc/rent.handlers.ts', 'registerRentHandlers');
  const P = await loadHandlers(db, 'src/main/ipc/rentParty.handlers.ts', 'registerRentPartyHandlers');

  await H.get('rentPayments:pay')(EV, { RentPaymentID: 1, CashAccountID: 1, Amount: 5000, userId: 1, fiscalYearId: 1 });
  await H.get('rentPayments:pay')(EV, { RentPaymentID: 2, CashAccountID: 1, Amount: 1500, userId: 1, fiscalYearId: 1 });

  const st = await P.get('rentParty:statement')(EV, 1);
  t('the statement is produced', st?.success === true, JSON.stringify(st).slice(0, 90));
  t('it names the landlord', st.party?.Name === 'الحاج محمود');
  t('it lists the contract', st.contracts?.length === 1);
  t('it lists both months', st.instalments?.length === 2);
  t('total due is both months', near(st.totals.totalDue, 10000), String(st.totals.totalDue));
  t('total paid is what actually moved', near(st.totals.totalPaid, 6500), String(st.totals.totalPaid));
  t('outstanding is the difference', near(st.totals.outstanding, 3500), String(st.totals.outstanding));
  t('due minus paid equals outstanding',
    near(st.totals.totalDue - st.totals.totalPaid, st.totals.outstanding));
  t('one month is counted as settled', st.totals.paidCount === 1, String(st.totals.paidCount));
  t('the next due date is reported', st.totals.nextDue === '2026-09-01', String(st.totals.nextDue));
  t('every movement is listed', st.transactions?.length === 2, String(st.transactions?.length));

  const list = await P.get('rentParties:list')(EV, 'landlord');
  t('the party list reports the same paid total', near(list[0].TotalPaid, 6500), String(list[0].TotalPaid));
  t('and the same outstanding', near(list[0].Outstanding, 3500), String(list[0].Outstanding));

  const dup = await P.get('rentParties:create')(EV, { PartyKind: 'landlord', Name: 'الحاج محمود' });
  t('a duplicate party is refused', dup?.success === false, JSON.stringify(dup));
  const noKind = await P.get('rentParties:create')(EV, { PartyKind: 'x', Name: 'فلان' });
  t('an unknown party kind is refused', noKind?.success === false);
  const gone = await P.get('rentParties:delete')(EV, 1);
  t('a party with a live contract cannot be hidden', gone?.success === false, JSON.stringify(gone));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] One implementation, shared by both doors');
{
  const rs = raw('src/main/ipc/rentSettle.ts');
  const rh = raw('src/main/ipc/rent.handlers.ts');
  const vh = raw('src/main/ipc/vouchers.handlers.ts');
  t('the rent screen uses the shared settler', /applyToInstalment\(/.test(rh));
  t('the voucher path uses the same one', /applyToInstalment\(/.test(vh));
  t('the voucher does not move the cash twice', /skipCashMove: true/.test(vh));
  t('the remaining-balance rule lives in one place',
    /wanted > remaining/.test(rs) && !/wanted > remaining/.test(vh));
  t('money is compared in whole piastres', /Math\.round\(\(Number\(n\) \|\| 0\) \* 100\)/.test(rs));
  t('the new channels are permission-gated',
    /'rentParties:create': 'rent\.create'/.test(raw('src/main/security/ipcGuard.ts')));
  t('and covered by the book guard',
    /'rentParties:'/.test(raw('src/main/security/bookGuard.ts')));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
