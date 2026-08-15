#!/usr/bin/env node
/**
 * ONE ASSET FIELD, AND A SECOND TELEGRAM ADMIN.
 *
 * THE VOUCHER DEFECT
 * ------------------
 * Screens that move money asked TWO questions where there is only one: a
 * "الخزنة/البنك" select, and beside it "طريقة الدفع (اختياري)". Both name an
 * asset that carries a balance, and the money lands in exactly one of them.
 * Measured against the real handler:
 *
 *   chose a safe only     -> the safe moves                        correct
 *   chose a wallet only   -> the wallet moves, safe field ignored
 *   chose BOTH            -> the WALLET moves, the safe is silently
 *                            ignored; the document names an asset that
 *                            never moved
 *   chose NEITHER         -> ACCEPTED, and no asset changes at all.
 *                            The expense is recorded while the money
 *                            exists nowhere.
 *
 * All four were reachable from the ordinary form.
 *
 * WHAT IS PROVEN HERE
 *   [1] the value maps to exactly one id, never two
 *   [2] the handler REFUSES both-or-neither
 *   [3] the picker lists every asset and grows with new ones
 *   [4] the screens ask once
 *   [5] a second Telegram admin works, and only real ids are admitted
 *
 * Run with:  node --experimental-strip-types scripts/verify_asset_picker.mjs
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
console.log('UNIFIED ASSET PICKER + SECOND TELEGRAM ADMIN');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] One value maps to exactly one asset id');
{
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, 'src/renderer/src/components/shared/AssetPicker.tsx')],
    bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', '../ui/Input'],
  });
  const dir = join(ROOT, 'node_modules', '.asset-probe');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `p${Date.now()}.mjs`);
  // The component imports React; only the pure helpers are under test, so the
  // module is loaded with those imports stripped.
  writeFileSync(file, out.outputFiles[0].text
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/jsx\w*\(/g, 'null&&('));
  const A = await import(`file://${file}`);

  t('a safe becomes CashAccountID only',
    JSON.stringify(A.splitAssetValue('cash:3')) === '{"CashAccountID":3}',
    JSON.stringify(A.splitAssetValue('cash:3')));
  t('a wallet becomes PaymentMethodID only',
    JSON.stringify(A.splitAssetValue('method:7')) === '{"PaymentMethodID":7}',
    JSON.stringify(A.splitAssetValue('method:7')));
  // The whole point: the shape makes "both" unrepresentable.
  for (const v of ['cash:3', 'method:7']) {
    const r = A.splitAssetValue(v);
    t(`${v} yields exactly one key`, Object.keys(r).length === 1);
  }
  t('an empty value yields nothing', Object.keys(A.splitAssetValue('')).length === 0);
  t('rubbish yields nothing', Object.keys(A.splitAssetValue('nonsense')).length === 0);
  t('a non-numeric id yields nothing', Object.keys(A.splitAssetValue('cash:abc')).length === 0);

  t('a stored safe round-trips', A.toAssetValue(3, null) === 'cash:3');
  t('a stored wallet round-trips', A.toAssetValue(null, 7) === 'method:7');
  // Old rows can name both, because the old form allowed it. The wallet is the
  // one the handler actually moved, so that is what must be shown.
  t('a legacy row naming BOTH shows the one that really moved',
    A.toAssetValue(3, 7) === 'method:7');
  t('a row naming neither shows nothing', A.toAssetValue(null, null) === '');
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The handler refuses both, and refuses neither');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE vouchers (VoucherID INTEGER PRIMARY KEY AUTOINCREMENT, VoucherNumber TEXT,
      VoucherType TEXT, FiscalYearID INTEGER, Date TEXT, Amount REAL, PartyType TEXT,
      PartyID INTEGER, PartyName TEXT, Description TEXT, CashAccountID INTEGER,
      PaymentMethodID INTEGER, ReferenceType TEXT, ReferenceID INTEGER, UserID INTEGER);
    CREATE TABLE cash_accounts (CashAccountID INTEGER PRIMARY KEY, AccountName TEXT, Balance REAL, IsActive INTEGER DEFAULT 1);
    CREATE TABLE payment_methods (PaymentMethodID INTEGER PRIMARY KEY, MethodName TEXT, Balance REAL, IsActive INTEGER DEFAULT 1);
    CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT);
    CREATE TABLE customers (CustomerID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE suppliers (SupplierID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE employees (EmployeeID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE rent_payments (RentPaymentID INTEGER PRIMARY KEY, RentID INTEGER, Amount REAL,
      PaidAmount REAL DEFAULT 0, Status TEXT, CancelledAt TEXT, PeriodLabel TEXT, DueDate TEXT,
      CashAccountID INTEGER, PaymentMethodID INTEGER, PaidDate TEXT, FiscalYearID INTEGER, UserID INTEGER);
    CREATE TABLE rents (RentID INTEGER PRIMARY KEY, RentType TEXT, Status TEXT, RentPartyID INTEGER);
    CREATE TABLE rent_transactions (RentTxnID INTEGER PRIMARY KEY AUTOINCREMENT, RentID INTEGER,
      RentPaymentID INTEGER, RentPartyID INTEGER, Kind TEXT, Amount REAL, TxnDate TEXT,
      CashAccountID INTEGER, PaymentMethodID INTEGER, SourceType TEXT, SourceID INTEGER,
      Notes TEXT, ReversedAt TEXT, FiscalYearID INTEGER, UserID INTEGER);
  `);
  db.exec(`INSERT INTO cash_accounts (CashAccountID, AccountName, Balance, IsActive) VALUES (1,'الخزنة',50000,1)`);
  db.exec(`INSERT INTO payment_methods VALUES (1,'فودافون كاش',20000,1)`);
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
  };

  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/vouchers.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /database\/connection$/ }, () => ({ path: 'conn', namespace: 'st' }));
        b.onResolve({ filter: /database\/docNumber$/ }, () => ({ path: 'doc', namespace: 'st' }));
        b.onLoad({ filter: /.*/, namespace: 'st' }, (a) => ({
          contents: a.path === 'conn'
            ? 'export const getDb = () => globalThis.__AP_DB;'
            : 'export const nextDocNumber = () => "PAY-1";',
          loader: 'ts',
        }));
      },
    }],
  });
  const dir = join(ROOT, 'node_modules', '.asset-probe');
  mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules', 'electron', 'index.js'),
    'const h=new Map();module.exports={ipcMain:{handle:(c,fn)=>h.set(c,fn)},__handlers:h};');
  const vfile = `v${Date.now()}.cjs`;
  writeFileSync(join(dir, vfile), out.outputFiles[0].text);
  globalThis.__AP_DB = db;
  const req = createRequire(join(dir, '/'));
  const electron = req('electron');
  req(join(dir, vfile)).registerVouchersHandlers();
  const H = electron.__handlers;
  const EV = { sender: { id: 1 } };
  // Explicit nulls: node:sqlite refuses to bind `undefined`, where
  // better-sqlite3 (what ships) coerces it to NULL. Without these the probe
  // fails on a difference between the two drivers, not on the code.
  const mk = (o) => H.get('vouchers:create')(EV, {
    VoucherType: 'receipt', Amount: 1000, Description: 'x',
    PartyType: null, PartyID: null, PartyName: null,
    CashAccountID: null, PaymentMethodID: null,
    ReferenceType: null, ReferenceID: null,
    userId: 1, fiscalYearId: 1, ...o });

  const cash = () => db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;
  const wal = () => db.prepare('SELECT Balance FROM payment_methods WHERE PaymentMethodID=1').get().Balance;

  const none = await mk({});
  t('a voucher naming NO asset is refused', none?.success === false, JSON.stringify(none));
  t('and nothing was recorded', db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 0);

  const both = await mk({ CashAccountID: 1, PaymentMethodID: 1 });
  t('a voucher naming BOTH assets is refused', both?.success === false, JSON.stringify(both));
  t('and still nothing was recorded', db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 0);
  t('no balance moved for either refusal', near(cash(), 50000) && near(wal(), 20000));

  const okCash = await mk({ CashAccountID: 1 });
  t('a safe alone is accepted', okCash?.success === true, JSON.stringify(okCash));
  t('the safe received it', near(cash(), 51000), String(cash()));
  t('the wallet did not', near(wal(), 20000), String(wal()));

  const okWallet = await mk({ PaymentMethodID: 1 });
  t('a wallet alone is accepted', okWallet?.success === true, JSON.stringify(okWallet));
  t('the wallet received it', near(wal(), 21000), String(wal()));
  t('the safe was untouched', near(cash(), 51000), String(cash()));
}

// ---------------------------------------------------------------- 3 & 4
console.log('\n[3] The picker lists every asset, and the screens ask once');
{
  const ap = raw('src/renderer/src/components/shared/AssetPicker.tsx');
  // Built from the live tables, so a newly created safe or wallet appears with
  // no code change — which is what "extensible" has to mean here.
  t('it reads the cash accounts', /invoke\('cashAccounts:list'\)/.test(ap));
  t('it reads the payment methods', /invoke\('paymentMethods:list'\)/.test(ap));
  t('the two are grouped in one list', /optgroup/.test(ap));
  t('balances are shown so the choice is informed', /showBalance/.test(ap));
  // A retired wallet must not receive new money.
  t('inactive wallets are excluded', /m\.IsActive === 0\) continue/.test(ap));

  for (const [name, file] of [
    ['VouchersPage', 'src/renderer/src/pages/accounting/VouchersPage.tsx'],
    ['RentPage', 'src/renderer/src/pages/accounting/RentPage.tsx'],
  ]) {
    const s = raw(file);
    t(`${name} uses the shared picker`, /<AssetPicker/.test(s));
    t(`${name} converts it with splitAssetValue`, /splitAssetValue\(/.test(s));
    // The old pair must be gone, or the screen still offers two answers.
    t(`${name} no longer has a separate optional payment-method select`,
      !/طريقة الدفع \(اختياري\)/.test(s));
    t(`${name} no longer holds two ids in its form`,
      !/form\.CashAccountID/.test(s) && !/form\.PaymentMethodID/.test(s));
  }

  const vp = raw('src/renderer/src/pages/accounting/VouchersPage.tsx');
  t('the voucher label follows the direction of the money',
    /المبلغ يدخل إلى/.test(vp) && /المبلغ يخرج من/.test(vp));
  t('a refused voucher is reported instead of failing silently',
    /isFailure\(result\)/.test(vp));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A second Telegram admin, and only real ids');
{
  const w = raw('server/worker.js');
  // Load the REAL functions rather than restating the rule.
  const parse = /function adminChats\(env\) \{[\s\S]*?\n\}/.exec(w)[0];
  const gate = /function isAdminChat\(env, chatId\) \{[\s\S]*?\n\}/.exec(w)[0];
  const adminChats = new Function(`${parse}; return adminChats;`)();
  const isAdminChat = new Function(`${parse}; ${gate}; return isAdminChat;`)();

  const two = { TG_ADMIN_CHAT: '7232305465,1593943219' };
  t('both numbers are parsed', adminChats(two).length === 2, adminChats(two).join(','));
  t('the original number still commands the bot', isAdminChat(two, '7232305465'));
  t('the second number commands it too', isAdminChat(two, '1593943219'));
  t('a stranger is refused', !isAdminChat(two, '999999999'));
  t('an empty id is refused', !isAdminChat(two, ''));
  t('a non-numeric id is refused', !isAdminChat(two, 'admin'));
  // A crafted value must not slip through the split.
  t('an injected value is refused', !isAdminChat(two, "7232305465' OR '1"));
  t('a partial match is refused', !isAdminChat(two, '723230546'));
  t('spaces around the comma are tolerated',
    isAdminChat({ TG_ADMIN_CHAT: '7232305465 , 1593943219' }, '1593943219'));

  // One id must keep working exactly as before.
  const one = { TG_ADMIN_CHAT: '7232305465' };
  // A malformed config is the realistic risk: the owner is given a handle AND
  // a number together ("@Acc_Mohamedabdou  Id: 1593943219") and may paste the
  // wrong one, or leave a stray comma. Only well-formed numeric ids may become
  // admins — anything else is dropped rather than trusted.
  const messy = { TG_ADMIN_CHAT: '7232305465, , @Acc_Mohamedabdou' };
  t('a pasted @username is NOT treated as an admin id',
    !isAdminChat(messy, '@Acc_Mohamedabdou'));
  t('and it is dropped from the admin list entirely',
    adminChats(messy).length === 1, adminChats(messy).join(','));
  t('a stray empty entry is dropped too', !adminChats(messy).includes(''));
  t('the valid id in a messy config still works', isAdminChat(messy, '7232305465'));
  t('a too-short id is refused', !isAdminChat({ TG_ADMIN_CHAT: '123' }, '123'));

  t('a single configured id still works', isAdminChat(one, '7232305465'));
  t('and still refuses everyone else', !isAdminChat(one, '1593943219'));
  t('an unset variable admits nobody', !isAdminChat({}, '7232305465'));

  t('alerts are sent to every admin, not just the first',
    /for \(const chat_id of chats\)/.test(w));
  // Replying to TG_ADMIN_CHAT would answer the FIRST number whoever asked.
  t('replies go to whoever is acting', /function actingChat\(env\)/.test(w)
    && /chat_id: actingChat\(env\)/.test(w));
  t('the acting chat is recorded before anything replies',
    /env\.__actingChat = chatId;/.test(w));
  // Two admins must not share one conversation state.
  t('pending prompts are kept per admin',
    /bind\(String\(actingChat\(env\)\), action/.test(w));
  t('no raw TG_ADMIN_CHAT is used as a chat id any more',
    !/chat_id: env\.TG_ADMIN_CHAT/.test(w));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
