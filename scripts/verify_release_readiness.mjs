#!/usr/bin/env node
/**
 * RELEASE READINESS — the axes a "ready to ship" claim must actually cover.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A readiness report declared this product shippable. It measured six axes —
 * scale, corruption, backup, multi-terminal, licensing, injection — and every
 * one passed. The conclusion still did not follow, because "the things I tested
 * pass" is not "the product is ready", and the axes that were never examined
 * held a voucher type that emptied the till invisibly, a maintenance status
 * that made a repair unbillable, a Supabase service-role key handed to the
 * renderer, an Electron seventeen months out of support, and 103 of 250 IPC
 * channels that no test had ever executed.
 *
 * The lesson is not "test more". It is that a readiness claim needs a WRITTEN
 * LIST of what readiness means, checked mechanically, so the claim cannot
 * quietly narrow to whatever was convenient to measure. This file is that list.
 *
 * It does not duplicate the deep suites — each axis below is verified in detail
 * elsewhere. It asserts that the verification EXISTS and is WIRED IN, which is
 * the property that was actually missing.
 *
 * Run:  node --experimental-strip-types scripts/verify_release_readiness.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const verify = pkg.scripts.verify;

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

// ===========================================================================
console.log('\n── 1. every readiness axis has a suite, and it runs ──');
// ===========================================================================
{
  /**
   * axis -> the suite that covers it.
   *
   * A suite that exists but is not in `npm run verify` is not protection: it
   * is a file nobody executes. Both halves are asserted.
   */
  const AXES = [
    ['accounting: trading cycle end to end', 'verify_trade_behaviour.mjs'],
    ['accounting: the four views agree', 'verify_trade_reports_agree.mjs'],
    ['accounting: metamorphic (do and undo)', 'verify_trade_metamorphic.mjs'],
    ['accounting: cost layers and serials', 'verify_stock_lots.mjs'],
    ['accounting: serialised costing', 'verify_serial_costing.mjs'],
    ['accounting: reports equal the ledger', 'verify_reports_money.mjs'],
    ['accounting: statements', 'verify_statements.mjs'],
    ['accounting: back office (payroll, rent, services)', 'verify_back_office.mjs'],
    ['accounting: cross-section joins', 'verify_cross_section.mjs'],
    ['accounting: maintenance', 'verify_maintenance.mjs'],
    ['accounting: transfers and deletes', 'verify_transfers_deletes.mjs'],
    ['accounting: the books guard', 'verify_book_guard.mjs'],
    ['accounting: master data', 'verify_master_data.mjs'],
    ['security: authentication and sessions', 'verify_auth_audit.mjs'],
    ['security: IPC permission guard at runtime', 'verify_ipc_guard_runtime.mjs'],
    ['security: server-side input validation', 'verify_server_side_validation.mjs'],
    ['security: no committed or client-reachable secret', 'verify_no_secrets.mjs'],
    ['security: errors disclose nothing', 'verify_error_disclosure.mjs'],
    ['security: hostile input', 'verify_input_hostility.mjs'],
    ['security: print escaping (XSS)', 'verify_print_escaping.mjs'],
    ['security: licensing cannot be forged', 'verify_license_ed25519.mjs'],
    ['security: trial cannot be reset', 'verify_trial_anchor.mjs'],
    ['security: cloud tenant isolation', 'verify_tenant_isolation.mjs'],
    ['security: password recovery', 'verify_password_recovery.mjs'],
    ['data: every channel executed', 'verify_all_channels.mjs'],
    ['data: database-level value guards', 'verify_db_constraints.mjs'],
    // A refused write must never pass for a successful one. Added after a
    // probe measured `hardenBinding` answering a refused `run()` with
    // `{changes: 0}` and letting the enclosing transaction COMMIT — a document
    // written with one of its parts missing, and no error anywhere.
    ['data: a refused write is never silent', 'verify_write_integrity.mjs'],
    ['data: migrations are safe to re-run', 'verify_upgrade_safety.mjs'],
    ['data: concurrency across terminals', 'verify_trade_concurrency.mjs'],
    ['data: multi-terminal', 'verify_multi_terminal.mjs'],
    ['data: disaster recovery', 'verify_disaster_recovery.mjs'],
    ['data: backup integrity', 'verify_backup_integrity.mjs'],
    ['stability: the whole program compiles', 'verify_build.mjs'],
    ['stability: renderer crash recovery', 'verify_renderer_crash.mjs'],
    ['stability: scale', 'verify_scale_load.mjs'],
    ['supply chain: dependency advisories', 'verify_dependency_security.mjs'],
    ['ui: save feedback is never a false success', 'verify_save_feedback.mjs'],
    ['ui: navigation catalogue', 'verify_sidebar_nav.mjs'],
    ['regression: fuzz sweep', 'verify_fuzz_sweep.mjs'],
    ['regression: mutation testing of the trade suite', 'verify_trade_mutation.mjs'],
  ];

  for (const [axis, suite] of AXES) {
    ok(`[${axis}] suite exists`, existsSync(join(ROOT, 'scripts', suite)), suite);
    ok(`[${axis}] suite runs in npm run verify`, verify.includes(suite), suite);
  }
}

// ===========================================================================
console.log('── 2. the verify script is complete and ordered ──');
// ===========================================================================
{
  // Every verify_* file on disk must be wired in. A suite written and then
  // forgotten is the same blind spot as one never written.
  const onDisk = readdirSync(join(ROOT, 'scripts'))
    .filter(f => /^(verify|audit)_.*\.(mjs|js|py)$/.test(f))
    .filter(f => f !== 'verify_release_readiness.mjs');
  const missing = onDisk.filter(f => !verify.includes(f));
  ok('no verification file is left out of npm run verify', missing.length === 0,
    missing.join(', '));

  // The fuzz sweep is the regression gate over the TRADING code and must run
  // after every suite that could regress it.
  //
  // This readiness file runs after the sweep, which is correct: it is a
  // meta-check over the whole battery, not a trading test. So the assertion is
  // that the sweep is last among the BEHAVIOURAL suites, not last overall.
  // Caught by this very check failing the moment this file was appended —
  // a character-offset heuristic that broke as soon as the string grew.
  const behavioural = verify.split(' && ')
    .filter((c) => !c.includes('verify_release_readiness'));
  const sweepIdx = behavioural.findIndex((c) => c.includes('verify_fuzz_sweep.mjs'));
  ok('the fuzz sweep runs last among the behavioural suites',
    sweepIdx === behavioural.length - 1,
    `position ${sweepIdx + 1} of ${behavioural.length}`);
  ok('the readiness meta-check runs after everything',
    verify.trim().endsWith('scripts/verify_release_readiness.mjs'));
}

// ===========================================================================
console.log('── 3. the defects this review found cannot come back ──');
// ===========================================================================
{
  // EXECUTED, not grepped.
  //
  // A first version of this section asserted that an identifier appeared in a
  // file — `/hardenBinding/`, `/TRANSFER_COST_SOURCES/`, and so on. Mutation
  // testing killed it immediately: renaming `hardenBinding` to
  // `hardenBindingX` disables the guard AND still matches the substring, so
  // eight mutants survived. A name is not a behaviour.
  //
  // Each defect below is therefore re-created against the real handlers and
  // the real database, exactly as it was originally measured.
  const { buildDatabase, loadHandlers, handlers } =
    await import(join(ROOT, 'scripts/lib/handlerHarness.mjs'));
  const db = buildDatabase();
  await loadHandlers();
  const H = (c, ...a) => handlers.get(c)({ sender: { id: 1 } }, ...a);

  db.prepare("INSERT INTO roles VALUES (1,'مدير',1)").run();
  db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','x',1,1)").run();
  db.prepare("INSERT INTO fiscal_years (FiscalYearID,YearName,StartDate,EndDate,Status) VALUES (1,'2026','2026-01-01','2026-12-31','open')").run();
  const quiet = console.error; console.error = () => {};
  try {
    await H('cashAccounts:create', { AccountName: 'خ', AccountType: 'safe', Balance: 10000, BankName: null, AccountNumber: null });
    await H('paymentMethods:create', { MethodName: 'و', MethodType: 'digital_wallet', Provider: 'v', PhoneNumber: '0' });
    await H('warehouses:create', { WarehouseName: 'م', WarehouseType: 'main' });
    await H('customers:create', { Name: 'عميل', Phone: '0', Email: '', Address: '', CreditLimit: null });

    // 1. A voucher type outside the allow-list emptied the till invisibly.
    const cash0 = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;
    const v = await H('vouchers:create', {
      VoucherType: 'RECEIPT', PartyType: 'general', Description: 'x',
      CashAccountID: 1, Amount: 5000, userId: 1, fiscalYearId: 1,
    });
    ok('a mis-cased voucher type is refused', v && v.success === false, JSON.stringify(v).slice(0, 80));
    ok('…and the till did not move',
      db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance === cash0);

    // 2. A terminal maintenance status made the repair unbillable for ever.
    const t = await H('maintenance:receive', {
      CustomerID: 1, CustomerName: 'عميل', CustomerPhone: '0',
      DeviceModel: 'X', ProblemDesc: 'y', AgreedCost: 800, userId: 1, fiscalYearId: 1,
    });
    const st = await H('maintenance:updateStatus', t.ticketId, 'delivered', 'ملاحظة', 1);
    ok('a terminal status is refused by updateStatus', st && st.success === false, JSON.stringify(st).slice(0, 80));
    ok('…and the ticket is still open',
      db.prepare('SELECT Status FROM maintenance_tickets WHERE TicketID=?').get(t.ticketId).Status === 'received');

    // 3. The transfer fee vanished when the bearer was unrecognised.
    const before = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance;
    const tr = await H('transfers:create', {
      FromType: 'cash_account', FromID: 1, ToType: 'payment_method', ToID: 1,
      Amount: 1000, TransferCost: 50, TransferCostSource: 'ALIEN', userId: 1, fiscalYearId: 1,
    });
    ok('an unknown transfer fee-bearer is refused', tr && tr.success === false, JSON.stringify(tr).slice(0, 80));
    ok('…and no money moved',
      db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID=1').get().Balance === before);

    // 4. A malformed id crashed the handler instead of returning a reply.
    for (const bad of [undefined, {}, [], 'abc']) {
      let threw = false, reply;
      try { reply = await H('items:get', bad); } catch { threw = true; }
      ok(`items:get survives ${JSON.stringify(bad)}`, !threw, 'it threw across the IPC boundary');
      ok(`…and answers empty for ${JSON.stringify(bad)}`, reply === undefined || reply === null,
        String(JSON.stringify(reply)).slice(0, 60));
    }

    // 5. The database itself must refuse what no handler should have allowed.
    for (const [label, sql] of [
      ['a negative cash balance', "INSERT INTO cash_accounts (AccountName,AccountType,Balance,IsActive) VALUES ('n','safe',-1,1)"],
      ['an unknown item type', "INSERT INTO items (ItemName,ItemType,SalePrice,CostPrice,IsActive) VALUES ('w','WEAPON',1,0,1)"],
      ['an unknown voucher type', "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('VX','MAGIC',1,'2026-01-01',10,'d',1)"],
      ['a sale line of zero quantity', "INSERT INTO sale_details (SaleID,ItemID,Quantity,UnitPrice,Total) VALUES (1,1,0,10,0)"],
      ['a date that is not a date', "INSERT INTO vouchers (VoucherNumber,VoucherType,FiscalYearID,Date,Amount,Description,UserID) VALUES ('VD','receipt',1,'BANANA',10,'d',1)"],
    ]) {
      checks += 1;
      try { db.prepare(sql).run(); failures.push(`the database accepted ${label}`); }
      catch { /* refused, as required */ }
    }

    // 6. The cloud credential must never leave the main process.
    //
    // `database.handlers` is not among the modules the shared harness loads,
    // so this is only asserted when it happens to be registered. The full
    // behavioural check lives in verify_no_secrets.mjs, which bundles that
    // module itself; section 1 pins that suite into `npm run verify`.
    if (handlers.has('db:getCloudSettings')) {
      db.prepare("INSERT OR REPLACE INTO settings (Key,Value) VALUES ('cloud_api_key','sbp_LIVE_CANARY_0123456789')").run();
      const cloud = await H('db:getCloudSettings');
      ok('the cloud API key is not returned to the renderer',
        !JSON.stringify(cloud ?? {}).includes('sbp_LIVE_CANARY_0123456789'),
        String(JSON.stringify(cloud)).slice(0, 90));
    }
  } finally {
    console.error = quiet;
  }

  /** How many database-level value guards the migration must declare. */
  const EXPECTED_GUARDS = 44;

  // The PRODUCTION source must carry the hardening, not merely the test stub.
  //
  // Mutation testing exposed the gap: deleting `hardenBinding(db)` from
  // connection.ts left every behavioural check above passing, because the
  // harness replaces the driver with its own stub which hardens independently.
  // The stub proves the TESTS behave like production; this proves PRODUCTION
  // behaves that way. Both are needed, and neither substitutes for the other.
  {
    const conn = readFileSync(join(ROOT, 'src/main/database/connection.ts'), 'utf8');
    const called = /^\s*hardenBinding\(db\);/m.test(conn);
    ok('production calls hardenBinding on the live connection', called,
      'the harness stub hardens on its own, so the behavioural checks above '
      + 'cannot see this missing');
    ok('production calls hardenTransactions on the live connection',
      /^\s*hardenTransactions\(db\);/m.test(conn));

    // Same reasoning for the schema guards: the harness builds its schema from
    // this file, so a rename would show up above — but only if the harness
    // still extracts the block. Counting them in the SOURCE is independent.
    const mig = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf8');
    const declared = (mig.match(/CREATE TRIGGER IF NOT EXISTS /g) || []).length;
    ok(`the migration declares all ${EXPECTED_GUARDS} value guards`, declared === EXPECTED_GUARDS,
      `${declared} declared in source`);
  }

  // The dependency floor: Electron on a supported line.
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const eMajor = Number(String(lock.packages['node_modules/electron']?.version || '0').split('.')[0]);
  ok('Electron is on a supported major', eMajor >= 41,
    `${eMajor} — 32 was seventeen months out of support when this shipped as "ready"`);

  // The Worker is a separate runtime, so it is driven separately.
  const mod = await import(join(ROOT, 'server/worker.js'));
  const boom = { CLIENT_KEY: 'ck', ADMIN_KEY: 'ak',
    DB: { prepare() { throw new Error('D1_ERROR: no such table: devices at /worker/db.js:412'); },
          batch() { throw new Error('D1_ERROR'); }, exec() { throw new Error('D1_ERROR'); } } };
  const q2 = console.error; console.error = () => {};
  try {
    const res = await mod.default.fetch(new Request('https://x.dev/health'), boom,
      { waitUntil() {}, passThroughOnException() {} });
    const body = await res.text();
    ok('the Worker tells an anonymous caller nothing',
      !/D1_ERROR|no such table|\/worker\//.test(body), body.slice(0, 90));
  } finally { console.error = q2; }
}

// ===========================================================================
console.log('── 4. the harness cannot silently diverge from production ──');
// ===========================================================================
{
  // Every long-lived defect in this review hid because the TEST environment
  // differed from the shipped one. Both are proven by BEHAVIOUR here, for the
  // same reason as section 3.
  const { buildDatabase } = await import(join(ROOT, 'scripts/lib/handlerHarness.mjs'));
  const probe = buildDatabase();

  // If the harness still split on the semicolons inside `BEGIN ... END`, the
  // triggers would be absent from the test schema while live in the app.
  // Counted by EXISTENCE, not by name. Renaming `ck_` to anything else does
  // not disable a trigger — measured: all 44 still fired and still refused a
  // negative balance — so a name-based count would report a phantom failure
  // and, worse, would pass if the guards were renamed while being gutted.
  const trigCount = probe.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'").get().c;
  // The EXACT count, not a floor.
  //
  // A `>= 40` threshold tolerated losing a guard: mutation testing deleted one
  // of the 44 and the check still passed. A guard removed on purpose should be
  // a deliberate edit to this number, which makes the removal visible in the
  // diff rather than silent.
  const EXPECTED_GUARDS = 44;   // must match the constant in section 3
  ok(`the test schema carries all ${EXPECTED_GUARDS} guards`, trigCount === EXPECTED_GUARDS,
    `${trigCount} found — the harness must not cut trigger bodies at their `
    + 'internal semicolons, and no guard may be dropped without changing this number');

  // If the stub lacked bind hardening, this would throw instead of returning.
  checks += 1;
  try {
    const r = probe.prepare('SELECT * FROM items WHERE ItemID = ?').get(undefined);
    if (r !== undefined) failures.push('the test driver returned a row for an unbindable id');
  } catch {
    failures.push('the test driver THREW on an unbindable id — production does not');
  }
}

// ===========================================================================
console.log('── 5. nothing is left half-finished ──');
// ===========================================================================
{
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  })(join(ROOT, 'src'));

  // A marker left in shipped code is a promise nobody kept.
  const markers = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/\b(FIXME|XXX|HACK)\b/.test(l) && !l.trim().startsWith('*')) {
        markers.push(`${f.replace(ROOT + '/', '')}:${i + 1}`);
      }
    });
  }
  ok('no FIXME/XXX/HACK marker in shipped source', markers.length === 0,
    markers.slice(0, 5).join(', '));

  // `debugger` reaching a customer freezes the renderer against a closed
  // DevTools.
  const dbg = files.filter(f => /^\s*debugger\s*;?\s*$/m.test(readFileSync(f, 'utf8')))
    .map(f => f.replace(ROOT + '/', ''));
  ok('no debugger statement', dbg.length === 0, dbg.join(', '));
}

console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — every readiness axis is covered and wired in`);
