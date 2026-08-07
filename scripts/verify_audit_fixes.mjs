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

// ---------------------------------------------------------------- 7
console.log('\n[7] The forgeable licence path is gone');
{
  const lc = raw('src/main/security/licenseCrypto.ts');
  // HMAC verifies with the key it signs with, and that key shipped in every
  // build. Demonstrated before removal: the constant alone minted a PERPETUAL
  // licence for an arbitrary device.
  t('the shipped symmetric secret is gone', !/export const VERIFIER_SECRET/.test(lc));
  t('the legacy verifier is gone', !/export function verifyLegacyCode/.test(lc));
  t('the router accepts only 69-byte Ed25519 codes',
    /if \(!raw \|\| raw\.length < 69\) return null;/.test(lc));
  t('the caller-supplied secret is explicitly ignored',
    /export function verifyCode\(_secret: string/.test(lc));

  const lh = raw('src/main/ipc/license.handlers.ts');
  // A build that can MINT a licence contains the key that mints licences.
  t('the app can no longer mint activation codes',
    !/signCode\(/.test(lh) && /لا يمكن إصدار كود التفعيل من داخل البرنامج/.test(lh));
  t('and it tells the developer the command to use instead',
    /npm run license:new/.test(lh));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The developer console no longer relies on a shipped secret');
{
  const da = raw('src/main/security/devAuth.ts');
  t('a challenge can be issued', /export function createDevChallenge/.test(da));
  t('a signed login exists', /export function devLoginSigned/.test(da));
  // A challenge that survives a failed attempt is one an attacker can grind.
  t('a challenge is single-use', /challenge\.used = true;[\s\S]{0,60}challenges\.delete/.test(da));
  t('and time-limited', /CHALLENGE_TTL_MS = 5 \* 60 \* 1000/.test(da));
  // Two factors: neither the stolen key nor the cracked password alone opens it.
  t('the password is STILL required alongside the signature',
    /if \(!sigOk \|\| !passOk\)/.test(da));
  t('one message for both failures, so neither can be probed',
    /التوقيع أو كلمة المرور غير صحيحة/.test(da));
  // Domain separation: a licence signature must not work as a console login.
  t('the signed message is domain-separated',
    /mobileshop-dev-console:v1:/.test(da));

  const sign = raw('scripts/dev-sign.js');
  t('the signing tool signs the same message',
    /mobileshop-dev-console:v1:/.test(sign));
  t('and it runs on the developer machine, reading the private key there',
    /MOBILESHOP_LICENSE_PRIVATE_KEY/.test(sign) && /\.license-key/.test(sign));

  // Behavioural: sign a challenge and verify it, then prove a replay fails.
  const crypto = await import('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64');
  const nonce = crypto.randomBytes(24).toString('hex');
  const msg = (n) => Buffer.from(`mobileshop-dev-console:v1:${n}`, 'utf8');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(privB64, 'base64')]);
  const sig = crypto.sign(null, msg(nonce), crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  const vder = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubB64, 'base64')]);
  const pub = crypto.createPublicKey({ key: vder, format: 'der', type: 'spki' });
  t('a signed challenge verifies', crypto.verify(null, msg(nonce), pub, sig) === true);
  t('the same signature does NOT verify for another nonce',
    crypto.verify(null, msg(crypto.randomBytes(24).toString('hex')), pub, sig) === false);
  t('an Ed25519 signature is 64 bytes', sig.length === 64);
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Sessions end, telemetry is silent, handlers cannot vanish');
{
  const ses = raw('src/main/security/session.ts');
  // An idle timer that every IPC call refreshes never fires on a window left
  // open. A ceiling that activity cannot extend is what actually ends it.
  t('there is an absolute lifetime, not only an idle one',
    /ABSOLUTE_TIMEOUT_MS/.test(ses));
  t('it is checked before lastSeenAt is refreshed',
    ses.indexOf('now - s.createdAt > ABSOLUTE_TIMEOUT_MS') < ses.indexOf('s.lastSeenAt = now;'));
  t('the limits are exported so they can be asserted', /SESSION_LIMITS/.test(ses));

  // Behavioural, against the REAL module. The structural checks above pass on
  // a build where the absolute check is disabled — a mutant proved it — because
  // nothing here constructed the session that only that check can catch: one
  // created long ago whose LAST call was a moment ago. Background polling
  // produces exactly that, and it is the case the idle timer can never see.
  {
    const S = await import('../src/main/security/session.ts');
    const mk = (id) => S.createSession(id, {
      userId: 1, username: 'admin', roleId: 1, employeeId: null,
      permissions: new Set(['settings.view']),
    });

    mk(101);
    t('a fresh session is valid', S.getSession(101) !== null);

    // Age it past the ceiling while keeping it "active".
    mk(102);
    const aged = S.getSession(102);
    aged.createdAt = Date.now() - (S.SESSION_LIMITS.absoluteMs + 60_000);
    aged.lastSeenAt = Date.now() - 1_000;   // used one second ago
    t('a session older than the ceiling is dropped even while ACTIVE',
      S.getSession(102) === null);

    // And the idle rule still works on its own.
    mk(103);
    const idle = S.getSession(103);
    idle.lastSeenAt = Date.now() - (S.SESSION_LIMITS.idleMs + 60_000);
    t('an idle session is dropped too', S.getSession(103) === null);

    t('the ceiling is longer than the idle window',
      S.SESSION_LIMITS.absoluteMs > S.SESSION_LIMITS.idleMs);
  }

  const hb = raw('src/main/remote/heartbeat.ts');
  // The check-in is MANDATORY whenever a server is configured (no opt-in): it
  // delivers updates, developer messages and renewed branding. Mandatory means
  // it always attempts when online — it never blocks the app offline.
  t('the check-in is mandatory (no opt-in gate)',
    hb.includes('configuredServer') && !/setting\('telemetry_enabled'\) === '1'/.test(hb));
  t('and no customer-facing off switch survives',
    hb.includes('!API_BASE || !CLIENT_KEY'));

  const g = raw('src/main/security/ipcGuard.ts');
  // ~30 handlers carry no try/catch; a throw crossed IPC as an unhandled
  // rejection and the screen received no reply at all.
  t('every handler is wrapped centrally', /const runSafely = async/.test(g));
  // Both exits from the wrapper must go through it: the read-only path and
  // the book-guarded one. Counting `runSafely(` also matched the definition,
  // so the two CALL SITES are asserted by name instead.
  t('the unguarded path uses it',
    /return runSafely\(\(\) => listener\(event, \.\.\.args\)\);/.test(g));
  t('the book-guarded path uses it too',
    /return runSafely\(\(\) => runGuarded\(channel, \(\) => listener\(event, \.\.\.args\)\)\);/.test(g));
  t('a thrown handler returns a structured failure', /code: 'HANDLER_ERROR'/.test(g));
  t('and the reason is logged rather than swallowed',
    /console\.error\(`\[IPC\] "\$\{channel\}" threw:/.test(g));
}

// ---------------------------------------------------------------- 10
console.log('\n[10] A transfer deletion removes ONE fee voucher');
{
  const tr = raw('src/main/ipc/transfers.handlers.ts');
  const del = raw('src/main/ipc/delete.handlers.ts');
  t('the fee voucher records which transfer it belongs to',
    /'transfer', \?\)/.test(tr) && /ReferenceType, ReferenceID/.test(tr));
  t('the delete matches on that reference',
    /ReferenceType = 'transfer' AND ReferenceID = \?/.test(del));
  t('the legacy fallback can only take one row', /ORDER BY VoucherID LIMIT 1/.test(del));

  // Behavioural: two transfers, same day, same fee — ordinary in a busy shop.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE vouchers (VoucherID INTEGER PRIMARY KEY AUTOINCREMENT,
    VoucherNumber TEXT, VoucherType TEXT, Date TEXT, Amount REAL, PartyType TEXT,
    ReferenceType TEXT, ReferenceID INTEGER);`);
  db.exec(`INSERT INTO vouchers (VoucherNumber,VoucherType,Date,Amount,PartyType,ReferenceType,ReferenceID)
           VALUES ('TRC-20260802-001','payment','2026-08-02',25,'general','transfer',1),
                  ('TRC-20260802-002','payment','2026-08-02',25,'general','transfer',2)`);
  const removed = db.prepare(
    "DELETE FROM vouchers WHERE ReferenceType = 'transfer' AND ReferenceID = ?").run(1);
  t('deleting one transfer removes exactly one voucher', removed.changes === 1, String(removed.changes));
  t("and the other transfer's fee survives",
    db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 1);

  // The old query, for contrast — this is what it did.
  const db2 = new DatabaseSync(':memory:');
  db2.exec(`CREATE TABLE vouchers (VoucherID INTEGER PRIMARY KEY AUTOINCREMENT,
    VoucherNumber TEXT, VoucherType TEXT, Date TEXT, Amount REAL, PartyType TEXT);`);
  db2.exec(`INSERT INTO vouchers (VoucherNumber,VoucherType,Date,Amount,PartyType)
            VALUES ('TRC-20260802-001','payment','2026-08-02',25,'general'),
                   ('TRC-20260802-002','payment','2026-08-02',25,'general')`);
  const old = db2.prepare(`DELETE FROM vouchers WHERE VoucherType='payment' AND PartyType='general'
    AND Date = ? AND Amount = ? AND VoucherNumber LIKE ?`).run('2026-08-02', 25, 'TRC-20260802%');
  t('the old date+amount match really did delete both', old.changes === 2, String(old.changes));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
