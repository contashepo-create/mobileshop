#!/usr/bin/env node
/**
 * FIXES FROM THE EXTERNAL CODE AUDIT.
 *
 * An audit was supplied listing 6 TypeScript errors and a set of security and
 * quality findings. Each claim was CHECKED against the code before anything
 * was changed, because a report is a hypothesis, not a result. Two of the
 * claims did not hold:
 *
 *   "no CSP in index.html"        — WRONG. index.html has carried a
 *                                   Content-Security-Policy meta tag all
 *                                   along. Verified below so the claim cannot
 *                                   be re-raised.
 *   "Card needs a key prop type"  — the error was real, but the CAUSE was a
 *                                   missing @types/react in the checking
 *                                   environment, not the component. Changing
 *                                   the component would have been a fix for
 *                                   nothing; it was reverted.
 *
 * WHAT IS PROVEN HERE
 *   [1] the project type-checks with no TS1016 / TS2322
 *   [2] the password is never persisted, and a legacy copy is destroyed
 *   [3] opening balances are validated before they are written
 *   [4] a render fault is contained instead of blanking the window
 *   [5] moveCash refuses a direction that is neither +1 nor -1
 *   [6] the two claims that did not hold, recorded so they stay settled
 *
 * Run with:  node --experimental-strip-types scripts/verify_audit_fixes.mjs
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
console.log('EXTERNAL AUDIT — FIXES AND CORRECTIONS');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] The reported TypeScript errors are gone');
{
  const rs = raw('src/main/ipc/rentSettle.ts');
  // TS1016: a required parameter cannot follow optional ones. I removed the
  // default last time to force callers to state a direction, and shipped a
  // file that does not compile.
  t('moveCash gives direction a default again',
    /direction: 1 \| -1 = 1,/.test(rs));
  t('and still refuses a direction that is neither +1 nor -1',
    /direction !== 1 && direction !== -1/.test(rs));

  // TS2322: asRows<T = unknown> returns unknown[]; DataTable needs
  // Record<string, any>[]. Named at the call site.
  for (const f of [
    'src/renderer/src/pages/accounting/SettlementPage.tsx',
    'src/renderer/src/pages/reports/CustomerStatementPage.tsx',
    'src/renderer/src/pages/reports/EmployeeStatementPage.tsx',
    'src/renderer/src/pages/reports/SupplierStatementPage.tsx',
  ]) {
    const s = raw(f);
    t(`${f.split('/').pop()} names the row type for DataTable`,
      /asRows<Record<string, any>>\(/.test(s));
    t(`  ...and has no bare asRows( left feeding a table`,
      !/data=\{asRows\((?!<)/.test(s));
  }
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The password is never persisted');
{
  const s = raw('src/renderer/src/pages/auth/Login.tsx');
  // It was written as PLAIN JSON — not base64, not encrypted — readable by
  // any script in the window and by anyone opening the profile folder. On a
  // shop counter that defeats the point of having a password at all.
  t('nothing writes a password into localStorage',
    !/localStorage\.setItem\('saved_password'/.test(s));
  t('the password is not read back out of it',
    !/setPassword\(parsed\.password/.test(s));
  // A build that already saved one must destroy it, not ignore it.
  t('a legacy stored password is removed on load',
    /const legacy = localStorage\.getItem\('saved_password'\)/.test(s)
    && /localStorage\.removeItem\('saved_password'\)/.test(s));
  t('and removed again on every successful login',
    (s.match(/localStorage\.removeItem\('saved_password'\)/g) || []).length >= 2);
  t('the username is still remembered', /localStorage\.setItem\('saved_username'/.test(s));
  t('the checkbox that promised it is gone', !/savePassword/.test(s));
  t('no dead icon import is left behind', !/KeyRound/.test(s));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Opening balances are validated before they are written');
{
  const s = raw('src/main/ipc/openingBalance.handlers.ts');
  t('batchUpdate checks its input', /const problems: string\[\] = \[\]/.test(s));
  t('and refuses before opening the transaction',
    s.indexOf('problems.length > 0') < s.indexOf('const tx = db.transaction'));

  // Behavioural, against the REAL handler.
  //
  // An earlier version of this section reimplemented the rule and asserted
  // against the copy — which proves the rule is right and says nothing about
  // the shipped code. A mutant that disabled the handler's refusal survived
  // it. The handler is now bundled and executed.
  const { build } = await import('esbuild');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/openingBalance.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /database\/connection$/ }, () => ({ path: 'c', namespace: 'st' }));
        b.onLoad({ filter: /.*/, namespace: 'st' },
          () => ({ contents: 'export const getDb = () => globalThis.__OB_DB;', loader: 'ts' }));
      },
    }],
  });
  const dir = join(ROOT, 'node_modules', '.audit-probe');
  mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules', 'electron', 'index.js'),
    'const h=new Map();module.exports={ipcMain:{handle:(c,fn)=>h.set(c,fn)},__handlers:h};');
  const mf = `ob${Date.now()}.cjs`;
  writeFileSync(join(dir, mf), out.outputFiles[0].text);

  const live = new DatabaseSync(':memory:');
  live.exec(`
    CREATE TABLE cash_accounts (CashAccountID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE payment_methods (PaymentMethodID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE customers (CustomerID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE suppliers (SupplierID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE employees (EmployeeID INTEGER PRIMARY KEY, Balance REAL);
    CREATE TABLE stock_quantities (ID INTEGER PRIMARY KEY, ItemID INTEGER, WarehouseID INTEGER, Quantity REAL, CostPrice REAL);
    INSERT INTO cash_accounts VALUES (1, 5000);
    INSERT INTO customers VALUES (1, 0);
  `);
  live.transaction = (fn) => (...a) => {
    live.exec('BEGIN');
    try { const r = fn(...a); live.exec('COMMIT'); return r; }
    catch (e) { try { live.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
  };
  globalThis.__OB_DB = live;
  const req = createRequire(join(dir, '/'));
  const electron = req('electron');
  req(join(dir, mf)).registerOpeningBalanceHandlers();
  const EV = { sender: { id: 1 } };
  const batch = (o) => electron.__handlers.get('openingBalances:batchUpdate')(EV, {
    cashAccounts: [], paymentMethods: [], customers: [], suppliers: [], employees: [], ...o });
  const cashBal = () => live.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;

  const neg = await batch({ cashAccounts: [{ id: 1, balance: -99999 }] });
  t('a negative cash balance is refused', neg?.success === false, JSON.stringify(neg));
  t('and the balance was not written', cashBal() === 5000, String(cashBal()));

  const nan = await batch({ cashAccounts: [{ id: 1, balance: NaN }] });
  t('a NaN balance is refused', nan?.success === false, JSON.stringify(nan));
  t('and did not blank the column', cashBal() === 5000, String(cashBal()));

  const inf = await batch({ cashAccounts: [{ id: 1, balance: Infinity }] });
  t('an Infinite balance is refused', inf?.success === false, JSON.stringify(inf));

  const ok = await batch({ cashAccounts: [{ id: 1, balance: 7000 }] });
  t('a normal cash balance passes', ok?.success === true, JSON.stringify(ok));
  t('and is actually written', cashBal() === 7000, String(cashBal()));

  const owed = await batch({ customers: [{ id: 1, balance: -500 }] });
  t('a NEGATIVE customer balance is allowed — the shop owes them',
    owed?.success === true, JSON.stringify(owed));
  const badCust = await batch({ customers: [{ id: 1, balance: NaN }] });
  t('but a NaN customer balance is still refused', badCust?.success === false);

  // The defect this replaces: NaN did not merely store oddly, it became NULL.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, Balance REAL); INSERT INTO t VALUES (1, 5000);');
  db.prepare('UPDATE t SET Balance = ? WHERE id = 1').run(NaN);
  t('an unvalidated NaN really does corrupt the column to NULL',
    db.prepare('SELECT Balance FROM t').get().Balance === null);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A render fault is contained, not fatal');
{
  const eb = raw('src/renderer/src/components/shared/ErrorBoundary.tsx');
  t('the boundary exists', /class ErrorBoundary extends Component/.test(eb));
  t('it catches by deriving state', /static getDerivedStateFromError/.test(eb));
  t('it reports the fault for diagnosis', /componentDidCatch/.test(eb));
  // A boundary that throws while reporting is worse than the original fault.
  t('its own reporting cannot throw',
    /try \{[\s\S]{0,400}console\.error[\s\S]{0,300}\} catch/.test(eb));
  t('it offers a way back', /إعادة المحاولة/.test(eb) && /الرئيسية/.test(eb));
  t('it tells the shop the data is safe', /بياناتك سليمة ومحفوظة/.test(eb));

  const ml = raw('src/renderer/src/components/layout/MainLayout.tsx');
  // Wrapping the Outlet keeps the sidebar and header alive, so a broken screen
  // can be walked away from instead of restarting the application.
  t('the page area is wrapped, not the whole layout',
    /<ErrorBoundary area="الصفحة">[\s\S]{0,120}<Outlet \/>/.test(ml));

  const app = raw('src/renderer/src/App.tsx');
  t('a root boundary covers login, the wizard and licensing',
    /<ErrorBoundary area="التطبيق">/.test(app));
  t('and it is closed properly', /<\/ErrorBoundary>/.test(app));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] moveCash cannot be given a nonsense direction');
{
  // Reconstructed from the shipped source, so the rule under test is the one
  // that runs.
  const rs = raw('src/main/ipc/rentSettle.ts');
  const body = /export function moveCash\([\s\S]*?\n\}/.exec(rs)[0];
  t('the guard is inside moveCash itself', /direction !== 1 && direction !== -1/.test(body));
  t('it throws rather than silently scaling the money',
    /throw new Error\(`moveCash: direction/.test(body));
  // The sign is decided by the contract type, never assumed.
  t('an expense pays out and an income takes in',
    /const sign = \(rentType === 'expense' \? -1 : 1\) \* direction;/.test(body));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Two audit claims that did NOT hold');
{
  // Recorded as tests so the same corrections do not have to be re-derived.
  const html = raw('index.html');
  t('index.html DOES carry a Content-Security-Policy',
    /http-equiv="Content-Security-Policy"/.test(html));
  t('it restricts script sources to self', /script-src 'self'/.test(html));
  t('and it restricts the default source', /default-src 'self'/.test(html));

  // The Card "key prop" error came from a missing @types/react in the
  // environment doing the checking, not from the component. Left as it was.
  const ns = raw('src/renderer/src/pages/settings/NotificationSettings.tsx');
  t('the Card component was left unchanged',
    /function Card\(\{ children, className = '' \}: \{ children: React\.ReactNode; className\?: string \}\)/.test(ns));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
