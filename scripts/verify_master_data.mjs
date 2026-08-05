#!/usr/bin/env node
/**
 * MASTER DATA — the forms that create the things everything else is built on.
 *
 * WHY THIS EXISTS
 * ---------------
 * A sale can be deleted. A voucher can be reversed. But a cash box created
 * holding minus ninety-nine thousand, or an item saved with a selling price of
 * minus nine hundred, is not a transaction — it is a permanent distortion that
 * every later figure inherits. The balance sheet, the stock valuation, the
 * profit report and every invoice priced from that item are all wrong from
 * that moment, and nothing in the books says why.
 *
 * These handlers had NO amount validation at all. A coverage scan showed the
 * shared `checkAmount` guard was used in `services`, `payroll`, `vouchers`,
 * `settlement` and `openingBalance` — but not in `assets`, `inventory` or
 * `rent`, which is where the accounts, wallets and items are actually created.
 *
 * WHAT WAS MEASURED BEFORE THE FIX
 * --------------------------------
 *   cashAccounts:create with Balance -99999  -> accepted, safe created at -99,999
 *   items:create with SalePrice -900         -> accepted, item saved at -900
 *   rents:create with Amount -3000           -> accepted
 *
 * THE OPPOSITE MATTERS TOO
 * ------------------------
 * A guard that over-reaches is its own bug. Zero is a perfectly good opening
 * balance for a new cash box, and this suite pins that it is still accepted —
 * so a future tightening cannot quietly break the ordinary case.
 *
 * A NOTE ON HOW THESE ARE CALLED
 * ------------------------------
 * Several master-data handlers pass the WHOLE payload straight into SQL as
 * named parameters. The harness stamps `userId` onto object payloads to mimic
 * the real IPC guard, which then fails as an unknown named parameter. These
 * are therefore invoked directly rather than through `call`.
 *
 * Run with:  node --experimental-strip-types scripts/verify_master_data.mjs
 */
import { buildDatabase, loadHandlers, currentDb, handlers } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const q = (sql, ...a) => currentDb().prepare(sql).get(...a);
/** Direct invocation: see the note above about named SQL parameters. */
const raw = (channel, ...args) => handlers.get(channel)({ sender: { id: 1 } }, ...args);

function seed() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  return db;
}

const newAccount = o => raw('cashAccounts:create', {
  AccountName: 'Acc', AccountType: 'safe', Balance: 0,
  BankName: null, AccountNumber: null, ...o,
});
// ItemType is 'phone', 'accessory' or 'service' — the values the rest of the
// codebase compares against. This fixture said 'part', which matches NOTHING:
// `items:create` defaults an absent type to 'accessory', and the type decides
// whether an item is serial-tracked and how it is costed, so a row saved as
// 'part' was neither a phone nor an accessory to any reader.
//
// `items:create` now validates the value against that list, so the fixture has
// to state a real one. Found by running this suite after the validation was
// added — the fixture had been quietly wrong the whole time.
const newItem = o => raw('items:create', {
  ItemName: 'Item', ItemType: 'accessory', IsSerialized: 0, SalePrice: 100,
  MinStock: 0, Barcode: '', CategoryID: null, Unit: 'قطعة', ...o,
});
// RentType is 'expense' or 'income' — the two values every reader in the
// codebase compares against (reports, statements, the payment handler). This
// fixture said 'paid', which matched nothing: the row was accepted and then
// counted as neither an expense nor an income. `rents:create` now validates
// the value, so the fixture has to state a real one.
const newRent = o => raw('rents:create', {
  RentName: 'Rent', RentType: 'expense', Amount: 1000, Period: 'monthly',
  StartDate: '2026-01-01', ...o,
});

console.log('MASTER DATA — a bad value here is permanent, not a transaction\n');

// ---------------------------------------------------------------- 1
console.log('[1] A cash box cannot be created holding less than nothing');
{
  seed();
  const res = await newAccount({ AccountName: 'Neg', Balance: -99999 });
  t('an opening balance of -99,999 is refused',
    res?.success === false && !q("SELECT 1 v FROM cash_accounts WHERE AccountName='Neg'"),
    JSON.stringify(res).slice(0, 80));
}
{
  seed();
  for (const [label, bal] of [['not a number', 'abc'], ['infinite', Number.POSITIVE_INFINITY]]) {
    const res = await newAccount({ AccountName: `X${label}`, Balance: bal });
    t(`an opening balance that is ${label} is refused`, res?.success === false,
      JSON.stringify(res).slice(0, 70));
  }
}
{
  // The guard must not over-reach: these are ordinary, correct cases.
  seed();
  const a = await newAccount({ AccountName: 'Zero', Balance: 0 });
  t('zero IS a valid opening balance for a new box',
    a?.success === true && q("SELECT Balance v FROM cash_accounts WHERE AccountName='Zero'").v === 0);
  const b = await newAccount({ AccountName: 'Real', Balance: 5000 });
  t('and a real opening balance is stored exactly',
    b?.success === true && q("SELECT Balance v FROM cash_accounts WHERE AccountName='Real'").v === 5000);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] An item cannot be sold at a price below zero');
{
  seed();
  const res = await newItem({ ItemName: 'Neg', SalePrice: -900 });
  t('a selling price of -900 is refused',
    res?.success === false && !q("SELECT 1 v FROM items WHERE ItemName='Neg'"),
    `it would have paid the customer to take the goods — ${JSON.stringify(res).slice(0, 60)}`);
}
{
  seed();
  const res = await newItem({ ItemName: 'NegMin', MinStock: -5 });
  t('a negative low-stock threshold is refused', res?.success === false,
    JSON.stringify(res).slice(0, 70));
}
{
  seed();
  const a = await newItem({ ItemName: 'Free', SalePrice: 0 });
  t('a zero price IS allowed (a giveaway or a warranty part)', a?.success === true);
  const b = await newItem({ ItemName: 'Normal', SalePrice: 250, MinStock: 5, Barcode: 'B1' });
  t('and a normal item is stored exactly',
    b?.success === true && q("SELECT SalePrice v FROM items WHERE ItemName='Normal'").v === 250);
}
{
  // CostPrice is deliberately forced to zero on creation and derived from
  // purchases afterwards. Pinned so a future edit cannot start trusting a
  // caller-supplied cost, which is how stock valuation gets poisoned.
  seed();
  await newItem({ ItemName: 'CostTest', SalePrice: 100 });
  t('cost is NOT taken from the form — it comes from what was actually paid',
    q("SELECT CostPrice v FROM items WHERE ItemName='CostTest'").v === 0);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Rent is an amount of money, so it follows the same rule');
{
  seed();
  const res = await newRent({ RentName: 'Neg', Amount: -3000 });
  t('a negative rent is refused',
    res?.success === false && !q("SELECT 1 v FROM rents WHERE RentName='Neg'"),
    JSON.stringify(res).slice(0, 70));
}
{
  seed();
  const res = await newRent({ RentName: 'Zero', Amount: 0 });
  t('a rent of zero is refused — it is not an agreement', res?.success === false,
    JSON.stringify(res).slice(0, 70));
}
{
  seed();
  const res = await newRent({ RentName: 'Ok', Amount: 3000 });
  t('a real rent is accepted',
    res?.success === true && q("SELECT Amount v FROM rents WHERE RentName='Ok'").v === 3000);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A payment machine always starts empty');
{
  seed();
  // MethodType is 'pos_machine', 'digital_wallet' or 'transfer' — the three
  // `<option>` values in PaymentMethodsPage.tsx. This fixture said 'wallet',
  // which the form cannot produce and the list badge does not recognise.
  // `paymentMethods:create` now validates it, so the fixture has to be real.
  await raw('paymentMethods:create', {
    MethodName: 'Wallet', MethodType: 'digital_wallet', Provider: null, PhoneNumber: null,
  });
  // The INSERT hardcodes 0 rather than reading the payload, which is the
  // strongest possible guard. Pinned so it stays that way.
  t('a new wallet opens at zero regardless of what was sent',
    q("SELECT Balance v FROM payment_methods WHERE MethodName='Wallet'").v === 0,
    'the balance is not caller-supplied at all');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Duplicate barcodes are refused, not silently merged');
{
  seed();
  const a = await newItem({ ItemName: 'First', Barcode: 'DUP-1' });
  const b = await newItem({ ItemName: 'Second', Barcode: 'DUP-1' });
  t('the first item takes the barcode', a?.success === true);
  t('the second is refused rather than overwriting it',
    b?.success === false && q("SELECT COUNT(*) v FROM items WHERE Barcode='DUP-1'").v === 1,
    JSON.stringify(b).slice(0, 70));
}
{
  seed();
  const a = await newItem({ ItemName: 'NoCode1', Barcode: '' });
  const b = await newItem({ ItemName: 'NoCode2', Barcode: '' });
  t('but two items with NO barcode are both allowed',
    a?.success === true && b?.success === true,
    'an empty barcode is stored as NULL, and NULLs do not collide');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
