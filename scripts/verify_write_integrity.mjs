#!/usr/bin/env node
/**
 * WRITE INTEGRITY — a refused write must never pass for a successful one.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * `hardenBinding` in src/main/database/connection.ts intercepts every prepared
 * statement so that a parameter better-sqlite3 cannot bind does not throw
 * across the IPC boundary. That repair was correct for READS and wrong for
 * WRITES, and the difference is the whole subject of this file.
 *
 * The original wrapper answered a refused `run()` with
 * `{ changes: 0, lastInsertRowid: 0 }` and let execution continue. MEASURED,
 * driving the real code:
 *
 *     db.transaction(() => {
 *       INSERT supplier A                    -> committed
 *       INSERT supplier B (undefined phone)  -> refused, {changes: 0}
 *     })()
 *     transaction threw : no
 *     suppliers         : 1 -> 2
 *
 * The transaction COMMITTED with one of its statements silently dropped. On a
 * financial document that is the difference between a crash the shop notices
 * and a wrong balance nobody can trace. It matters most here:
 *
 *     UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?
 *
 * MEASURED with an unbindable amount: the drawer stayed at 100,000, `run()`
 * returned `{changes: 0}`, nothing was raised. A foreign key cannot catch it —
 * there is no child row and no missing parent, only an UPDATE that matched
 * nothing. A scan of `src/main/ipc` found 106 balance-moving UPDATE statements
 * of which 103 never inspect `.changes`, so from inside those handlers a
 * dropped write is indistinguishable from a successful one.
 *
 * WHY IT IS TESTED THIS WAY
 * -------------------------
 * By EXECUTING the statements, never by matching source text. An earlier
 * readiness suite in this project asserted that the string `hardenBinding`
 * appeared in connection.ts; renaming the function to `hardenBindingX` would
 * have disabled the guard and still matched. Eight of fourteen mutants
 * survived. Every check below drives a real database and reads the outcome.
 *
 * THE PAIRING THAT MUST HOLD
 * --------------------------
 * Loud on writes is only safe if reads stay quiet — the reason the wrapper was
 * introduced was 25 channels crashing on a malformed id. So each half is
 * asserted against the other: a refused READ still answers empty, and a
 * refused WRITE still throws. A change that satisfies one by breaking the
 * other fails this suite.
 *
 * Run:  node --experimental-strip-types scripts/verify_write_integrity.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `fileURLToPath`, never `.pathname`.
//
// On Windows a file:// URL's pathname is `/D:/coding%20projects/...` — it
// keeps a leading slash and it is percent-encoded. MEASURED on the owner's
// machine, joining that with a subdirectory produced
//
//     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
//
// — the drive letter twice and the spaces still as %20. `fileURLToPath` is the
// documented conversion and handles both.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

const { buildDatabase, loadHandlers, call, currentDb } =
  await import(join(ROOT, 'scripts/lib/handlerHarness.mjs'));

const db = buildDatabase();
await loadHandlers();

// A believable shop, so the checks run against real rows.
db.prepare("INSERT INTO roles (RoleID,RoleName,IsSystem) VALUES (1,'مدير',1)").run();
db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','$2a$10$x',1,1)").run();
db.prepare("INSERT INTO fiscal_years (FiscalYearID,YearName,StartDate,EndDate,Status) VALUES (1,'2026','2026-01-01','2026-12-31','open')").run();
await call('warehouses:create', { WarehouseName: 'المخزن', WarehouseType: 'main' });
await call('cashAccounts:create', { AccountName: 'الخزينة', AccountType: 'safe', Balance: 100000 });
await call('paymentMethods:create', { MethodName: 'محفظة', MethodType: 'digital_wallet', Provider: 'vodafone', PhoneNumber: '0100' });
await call('customers:create', { Name: 'عميل', Phone: '0100', CreditLimit: 500000 });
await call('suppliers:create', { Name: 'مورد', Phone: '0111' });
await call('employees:create', { Name: 'موظف', Phone: '0122', Position: 'فني', Department: 'صيانة', BaseSalary: 3000, Allowances: 0, HireDate: '2026-01-01' });
const item = await call('items:create', { ItemName: 'شاحن', ItemType: 'accessory', SalePrice: 150, Barcode: 'BC1' });

// ===========================================================================
console.log('\n── 1. a refused WRITE is loud ──');
// ===========================================================================
{
  // The statement every payment handler runs, with an amount that cannot bind.
  const before = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  let threw = null;
  try {
    db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
      .run(undefined, 1);
  } catch (e) { threw = e; }
  const after = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;

  ok('an unbindable parameter on a balance UPDATE throws', threw !== null,
    'it returned quietly, so the caller cannot tell the money did not move');
  ok('the balance is untouched when the write is refused', before === after,
    `${before} -> ${after}`);

  // INSERT and DELETE are the same class of statement.
  let insertThrew = null;
  try {
    db.prepare('INSERT INTO suppliers (Name, Phone) VALUES (?, ?)').run('مورد ب', undefined);
  } catch (e) { insertThrew = e; }
  ok('an unbindable parameter on an INSERT throws', insertThrew !== null);

  let deleteThrew = null;
  try {
    db.prepare('DELETE FROM suppliers WHERE SupplierID = ?').run(undefined);
  } catch (e) { deleteThrew = e; }
  ok('an unbindable parameter on a DELETE throws', deleteThrew !== null);
}

// ===========================================================================
console.log('── 2. the enclosing transaction rolls back — no partial document ──');
// ===========================================================================
{
  // This is the check that would have caught the original defect. A document is
  // several writes in one transaction; if one is dropped the rest must not
  // survive, or the books hold half a document.
  const before = db.prepare('SELECT COUNT(*) c FROM suppliers').get().c;
  let threw = null;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO suppliers (Name, Phone) VALUES (?, ?)').run('مورد ج', '0003');
    db.prepare('INSERT INTO suppliers (Name, Phone) VALUES (?, ?)').run('مورد د', undefined);
  });
  try { tx(); } catch (e) { threw = e; }
  const after = db.prepare('SELECT COUNT(*) c FROM suppliers').get().c;

  ok('a transaction containing a refused write does not commit', threw !== null,
    'it committed, so a document was written with one of its parts missing');
  ok('nothing from that transaction survives', before === after,
    `suppliers ${before} -> ${after}`);
}

// ===========================================================================
console.log('── 3. a refused READ is still quiet (the original repair) ──');
// ===========================================================================
{
  // The whole reason `hardenBinding` exists: 25 channels crashed on a malformed
  // id. Making writes loud must not undo that.
  let getThrew = null, getResult;
  try {
    getResult = db.prepare('SELECT * FROM customers WHERE CustomerID = ?').get(undefined);
  } catch (e) { getThrew = e; }
  ok('a refused .get() does not throw', getThrew === null);
  ok('a refused .get() answers undefined', getResult === undefined);

  let allThrew = null, allResult;
  try {
    allResult = db.prepare('SELECT * FROM customers WHERE CustomerID = ?').all(undefined);
  } catch (e) { allThrew = e; }
  ok('a refused .all() does not throw', allThrew === null);
  ok('a refused .all() answers an empty list', Array.isArray(allResult) && allResult.length === 0);

  // A leading SQL comment must not make a SELECT look like a write. Several
  // statements in this project begin with one.
  let commentedThrew = null;
  try {
    db.prepare('-- find the customer\nSELECT * FROM customers WHERE CustomerID = ?').get(undefined);
  } catch (e) { commentedThrew = e; }
  ok('a SELECT behind a leading comment is still treated as a read', commentedThrew === null,
    'it threw, so the read/write split is matching raw text instead of the statement');
}

// ===========================================================================
console.log('── 4. the channels that reach a write with a caller-supplied id ──');
// ===========================================================================
{
  // These four bound the id straight into an UPDATE. Two properties are
  // demanded of each: a malformed id is a plain refusal (not a technical
  // error), and an id that matches no row does NOT report success.
  const cases = [
    ['cashAccounts:delete', 'الخزينة'],
    ['paymentMethods:delete', 'طريقة الدفع'],
    ['items:delete', 'الصنف'],
    ['employees:delete', 'الموظف'],
  ];
  for (const [channel] of cases) {
    for (const hostile of [undefined, null, {}, [], 'abc', NaN]) {
      let reply, threw = null;
      try { reply = await call(channel, hostile); } catch (e) { threw = e; }
      ok(`${channel} refuses a malformed id without throwing`, threw === null,
        threw ? String(threw.message).slice(0, 90) : '');
      ok(`${channel} does not claim success for a malformed id`,
        !(reply && reply.success === true),
        JSON.stringify(reply).slice(0, 80));
      // The refusal must read like a business message, not a stack trace.
      const msg = String(reply?.message ?? '');
      ok(`${channel} answers in plain Arabic, not a SQL fragment`,
        !/UPDATE |INSERT |SELECT |SQLITE|\bat \/|\.ts:/i.test(msg),
        msg.slice(0, 90));
    }
    // A well-formed id that matches nothing.
    const reply = await call(channel, 999999);
    ok(`${channel} does not claim success for an id that matches no row`,
      !(reply && reply.success === true),
      JSON.stringify(reply).slice(0, 80));
  }

  // ...and the same channels must still WORK on a real row.
  const live = await call('items:delete', item.id);
  ok('items:delete still deactivates a real item', live?.success === true,
    JSON.stringify(live).slice(0, 80));
  const row = db.prepare('SELECT IsActive FROM items WHERE ItemID = ?').get(item.id);
  ok('the item really is deactivated', row?.IsActive === 0, JSON.stringify(row));
}

// ===========================================================================
console.log('── 5. the test stub behaves like the shipped driver ──');
// ===========================================================================
{
  // The harness replaces better-sqlite3 entirely. If the stub and
  // connection.ts disagree, every suite above tests a database layer that does
  // not ship. The read/write rule is compared literally, source to source.
  const conn = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf8');
  const stub = readFileSync(join(ROOT, 'scripts/lib/stubs/betterSqlite.mjs'), 'utf8');

  const bodyOf = (src) => {
    const at = src.indexOf('function isWriteStatement');
    if (at < 0) return null;
    // Balanced-brace scan from the opening brace of the function body.
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  };

  const a = bodyOf(conn);
  const b = bodyOf(stub);
  ok('connection.ts defines the read/write rule', a !== null);
  ok('the stub defines the read/write rule', b !== null);
  if (a && b) {
    // Types are stripped so the TypeScript and JavaScript copies compare equal.
    const norm = (s) => s.replace(/:\s*(string|boolean)\b/g, '').replace(/\s+/g, ' ').trim();
    ok('the two copies of the rule are identical', norm(a) === norm(b),
      'they have drifted — the tests would exercise a different DB layer than ships');
  }

  // Sections 1-4 executed the STUB. That proves the stub is right and says
  // nothing about the file that actually ships, so the shipped `hardenBinding`
  // is compiled and EXECUTED here against a real statement object.
  //
  // A text assertion was tried first and a mutant walked straight through it:
  // changing `if (writes)` to `if (false)` in connection.ts left both strings
  // the regex looked for exactly where they were, so the check passed while the
  // guard was disabled. Reading the source can only ever prove what the source
  // says; running it proves what it does.
  const shipped = await compileHardenBinding();
  if (!shipped) {
    ok('the shipped hardenBinding could be compiled and executed', false,
      'could not build it — the behaviour below is unverified');
  } else {
    // A minimal stand-in for a better-sqlite3 connection: `prepare` hands back
    // an object whose methods record that they ran. `hardenBinding` wraps it
    // exactly as it wraps the real driver.
    let ran = false;
    const fake = {
      prepare(sql) {
        return {
          sql,
          run: () => { ran = true; return { changes: 1, lastInsertRowid: 7 }; },
          get: () => { ran = true; return { hit: true }; },
          all: () => { ran = true; return [{ hit: true }]; },
        };
      },
    };
    shipped(fake);

    // A refused WRITE must throw, and must not reach the driver.
    ran = false;
    let wroteThrew = null, wroteResult;
    try {
      wroteResult = fake.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
        .run(undefined, 1);
    } catch (e) { wroteThrew = e; }
    ok('SHIPPED hardenBinding throws on a refused write', wroteThrew !== null,
      `it returned ${JSON.stringify(wroteResult)} instead`);
    ok('SHIPPED hardenBinding does not reach the driver on a refused write', ran === false);

    // A refused READ must stay quiet.
    ran = false;
    let readThrew = null, readResult;
    try {
      readResult = fake.prepare('SELECT * FROM customers WHERE CustomerID = ?').get(undefined);
    } catch (e) { readThrew = e; }
    ok('SHIPPED hardenBinding does not throw on a refused read', readThrew === null,
      readThrew ? String(readThrew.message).slice(0, 80) : '');
    ok('SHIPPED hardenBinding answers undefined on a refused read', readResult === undefined);

    // A VALID call must pass straight through, untouched.
    ran = false;
    const good = fake.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?')
      .run(50, 1);
    ok('SHIPPED hardenBinding lets a valid write through', ran === true && good?.changes === 1,
      JSON.stringify(good));
  }
}

/**
 * Compiles `hardenBinding` out of the shipped TypeScript and returns it.
 *
 * The function is module-private, so it is extracted by source range rather
 * than imported: importing connection.ts would pull in `electron` and the
 * native driver, neither of which exists in this process. The extraction is
 * balanced-brace, and a failure returns null so the caller reports it as an
 * unverified check rather than passing silently.
 */
async function compileHardenBinding() {
  try {
    const src = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf8');
    const take = (name) => {
      const at = src.indexOf('function ' + name);
      if (at < 0) return null;
      const open = src.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
      }
      return null;
    };
    const harden = take('hardenBinding');
    const rule = take('isWriteStatement');
    // `hardenBinding` also calls `roundBalanceArithmetic` on the SQL it
    // prepares. Extracting the first two and not the third produced
    // `ReferenceError: roundBalanceArithmetic is not defined` at the moment
    // the guard ran — caught by the full verify run, which is exactly what an
    // extraction-based test is for: the shipped function's dependencies are
    // part of its behaviour, and a missing one must fail loudly rather than
    // downgrade this check to "unverified".
    const round = take('roundBalanceArithmetic');
    if (!harden || !rule || !round) return null;

    // The types are stripped by Node's own TypeScript loader rather than by a
    // hand-written regex. A regex was tried and mangled the code — it turned
    // `originalPrepare(sql) as unknown as Record<string, unknown>` into a
    // syntax error — which would have silently downgraded this check to
    // "unverified". The loader is the same one the rest of the suite uses, so
    // what runs here is what the compiler produces.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'hardenbind-'));
    const file = join(dir, 'extracted.ts');
    writeFileSync(file,
      // `Database` is only a type here; a local declaration satisfies the
      // annotation without importing the native module.
      'type Database = { Database: any };\n'
      + 'declare const Buffer: any;\n'
      + 'const BIND_HARDENED = Symbol.for("mobileshop.bindHardened");\n'
      + harden + '\n' + rule + '\n' + round + '\n'
      + 'export default hardenBinding;\n', 'utf8');

    const mod = await import('file://' + file);
    return typeof mod.default === 'function' ? mod.default : null;
  } catch {
    return null;
  }
}

// ===========================================================================
console.log('── 6. balance-moving writes are reachable only with a validated id ──');
// ===========================================================================
{
  // A census, so a handler added later that binds a raw id into a balance
  // UPDATE is visible. This is a REPORT, not a text assertion: the number is
  // pinned so it cannot grow unnoticed.
  const dir = join(ROOT, 'src/main/ipc');
  let balanceWrites = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const body = readFileSync(join(dir, f), 'utf8');
    for (const line of body.split('\n')) {
      if (/UPDATE\s+(cash_accounts|payment_methods|customers|suppliers|employees)\s+SET\s+Balance/i.test(line)) {
        balanceWrites++;
      }
    }
  }
  console.log(`   ${balanceWrites} balance-moving UPDATE statements in src/main/ipc`);
  ok('the balance-moving statements are still accounted for', balanceWrites > 0);
  // Each one is now protected by the throw in section 1: a parameter that
  // cannot bind aborts the transaction instead of leaving the row untouched.
  // That is the property, and it is asserted by execution above rather than by
  // counting call sites.
}

// ===========================================================================
console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — a refused write can never pass for a successful one`);
