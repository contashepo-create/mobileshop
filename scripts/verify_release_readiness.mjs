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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
/**
 * Path relative to the repository root, in forward slashes, on every OS.
 *
 * `f.replace(ROOT + '/', '')` assumes a POSIX separator. On Windows the paths
 * carry backslashes, the prefix never matches, and the result stays absolute —
 * which silently breaks any comparison or allow-list keyed on `src/...`.
 */
const relPath = (f) => relative(ROOT, f).split(sep).join('/');
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
    // The log said "append-only in practice". Measured: six tampering attacks
    // all succeeded and DELETE FROM security_events emptied it.
    ['security: the audit trail cannot be rewritten or erased', 'verify_audit_trail.mjs'],
    // The database is NOT encrypted, and this suite keeps that statement
    // honest. Measured: PRAGMA key is silently accepted on this build and
    // writes cleartext, so a one-line "fix" would fake protection.
    ['security: nothing claims encryption the build cannot deliver', 'verify_db_encryption_claim.mjs'],
    // A refused write must never pass for a successful one. Added after a
    // probe measured `hardenBinding` answering a refused `run()` with
    // `{changes: 0}` and letting the enclosing transaction COMMIT — a document
    // written with one of its parts missing, and no error anywhere.
    ['data: a refused write is never silent', 'verify_write_integrity.mjs'],
    // Running balances accumulate inside SQLite, after money() has rounded.
    // Measured: 300 sales of 33.33 settled at 9998.999999999982, so a paid-up
    // customer never satisfied `Balance = 0`.
    ['accounting: running balances are exact to the piastre', 'verify_money_precision.mjs'],
    // Closing the year was a label on a button: measured, `sales:create` and
    // `purchases:create` both posted into a year stamped 'closed'.
    ['accounting: a closed fiscal year refuses new documents', 'verify_fiscal_year_close.mjs'],
    // The only internet-facing component. Added after a measured exploit:
    // an anonymous POST to /telegram, with no credential of any kind, minted a
    // signed ten-year licence — the chat id it authenticated on is part of the
    // payload the attacker writes.
    ['security: the worker refuses forged and unauthenticated calls', 'verify_worker_auth.mjs'],
    ['data: migrations are safe to re-run', 'verify_upgrade_safety.mjs'],
    ['data: concurrency across terminals', 'verify_trade_concurrency.mjs'],
    ['data: multi-terminal', 'verify_multi_terminal.mjs'],
    ['data: disaster recovery', 'verify_disaster_recovery.mjs'],
    ['data: backup integrity', 'verify_backup_integrity.mjs'],
    // A restore checked only the 16-byte SQLite header: measured, a database
    // with destroyed pages passed it and was copied over the live books.
    ['data: a bad backup cannot overwrite good books', 'verify_restore_safety.mjs'],
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
  // No npm script may use POSIX-only shell syntax.
  //
  // `npm run verify` contained `TZ=Africa/Cairo node ...`. That is a shell
  // assignment, understood by sh and NOT by cmd.exe. MEASURED on the owner's
  // Windows machine: the chain stopped at suite 19 of 87 with
  //
  //     'TZ' is not recognized as an internal or external command
  //
  // and the sixty-eight suites after it never ran — the run LOOKED like a
  // single small failure while most of the verification silently did not
  // happen. Anything a script needs from the environment must be set inside
  // the script it belongs to, where Node sets it portably.
  {
    const OFFENDERS = [];
    for (const [name, body] of Object.entries(pkg.scripts || {})) {
      for (const part of String(body).split(' && ')) {
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(part)) {
          OFFENDERS.push(`${name}: ${part.trim().slice(0, 60)}`);
        }
      }
    }
    ok('no npm script prefixes a command with VAR= (breaks cmd.exe)',
      OFFENDERS.length === 0, OFFENDERS.join(' | '));

    // The same class of fault, different spelling.
    const UNIX_ONLY = /(^|\s)(rm\s|cp\s|mv\s|chmod\s|touch\s|cat\s|sed\s|awk\s|\|\|\s*true|2>\/dev\/null)/;
    const shellUsers = Object.entries(pkg.scripts || {})
      .filter(([, body]) => UNIX_ONLY.test(String(body)))
      .map(([name]) => name);
    ok('no npm script calls a POSIX-only shell utility',
      shellUsers.length === 0, shellUsers.join(', '));
  }

  // No suite may shell out to a Unix-only utility.
  //
  // `verify_multi_terminal` called `execFileSync('mkdir', ['-p', ...])`. On
  // Windows `mkdir` is a cmd.exe builtin, not an executable on PATH, so the
  // spawn failed with `ENOENT` — after fourteen of that suite's checks had
  // already passed, taking the rest of the chain with it.
  //
  // Node does all of these directly. Leaving the process to ask the OS for
  // something the runtime already provides is how a suite becomes
  // platform-specific without anyone deciding that it should be.
  {
    const UNIX_BINS = /execFileSync\(\s*['"`](mkdir|rm|cp|mv|touch|ls|chmod|chown|cat|sed|awk|grep|which|find)['"`]/;
    const shellers = [];
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (!f.endsWith('.mjs')) continue;
      // This file necessarily contains the pattern it looks for.
      if (f === 'verify_release_readiness.mjs') continue;
      // Comments are stripped first. The very fix that prompted this guard
      // DOCUMENTS the old call in a comment, and a naive scan flagged the
      // repaired file — a check that cannot tell code from prose only teaches
      // people to ignore it.
      const body = readFileSync(join(ROOT, 'scripts', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      if (UNIX_BINS.test(body)) shellers.push(f);
    }
    ok('no suite spawns a Unix-only command line utility',
      shellers.length === 0, shellers.join(', '));
  }

  // No suite may derive a filesystem path from `.pathname`.
  //
  // On Windows a file:// URL's pathname keeps a leading slash and stays
  // percent-encoded: `/D:/coding%20projects/...`. Joining that with a
  // subdirectory produced, on the owner's machine,
  //
  //     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
  //
  // Nineteen suites shared the same line. `fileURLToPath` is the documented
  // conversion; `.pathname` is a URL component that only looks like a path.
  {
    const offenders = [];
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (!f.endsWith('.mjs')) continue;
      if (f === 'verify_release_readiness.mjs') continue;   // contains the pattern it seeks
      const body = readFileSync(join(ROOT, 'scripts', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      if (/import\.meta\.url\s*\)\s*\.pathname/.test(body)) offenders.push(f);
    }
    ok('no suite builds a path from import.meta.url .pathname',
      offenders.length === 0, offenders.join(', '));
  }

  // No suite may depend on a POSIX shell.
  //
  // `verify_no_secrets` used `| wc -l`, `|| true` and `shell: '/bin/bash'`.
  // On Windows that produced fifteen copies of "'wc' is not recognized" and
  // then `spawnSync /bin/bash ENOENT`. `verify_dependency_security` shelled
  // out to `grep -rlE ... || true`, which on Windows returns NOTHING — and
  // nothing found is that check's PASSING answer, so it reported success
  // without reading a file. A check that cannot fail is worse than no check.
  {
    const SHELLISMS = [
      [/shell:\s*['"`]\/bin\//, "shell: '/bin/...'"],
      [/\|\|\s*true/, '|| true'],
      [/\|\s*wc\b/, '| wc'],
      [/execSync\(\s*[`'"][^`'"]*\bgrep\s+-/, 'execSync grep'],
    ];
    const offenders = [];
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (!f.endsWith('.mjs')) continue;
      if (f === 'verify_release_readiness.mjs') continue;   // holds the patterns it seeks
      const body = readFileSync(join(ROOT, 'scripts', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const [rx, label] of SHELLISMS) {
        if (rx.test(body)) offenders.push(`${f} (${label})`);
      }
    }
    ok('no suite relies on POSIX shell syntax', offenders.length === 0,
      offenders.join(', '));
  }

  // A dynamic import must be given a file:// URL, never a bare path.
  //
  // On Windows `import('D:\\...')` makes Node read `d:` as a protocol:
  //
  //     ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'd:'
  //
  // and `'file://' + path` is no better — it leaves backslashes and unencoded
  // spaces. `pathToFileURL` is the documented conversion. Twenty-two sites
  // across eleven suites shared one of the two broken forms.
  {
    const offenders = [];
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (!f.endsWith('.mjs')) continue;
      if (f === 'verify_release_readiness.mjs') continue;   // holds the patterns it seeks
      const body = readFileSync(join(ROOT, 'scripts', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      if (/import\(\s*join\(/.test(body)) offenders.push(`${f} (import(join(...)))`);
      if (/'file:\/\/'\s*\+/.test(body)) offenders.push(`${f} ('file://' + path)`);
    }
    ok('every dynamic import uses pathToFileURL, not a raw path',
      offenders.length === 0, offenders.join(', '));
  }

  // No mutation may be left behind in the shipped source.
  //
  // The mutation tools rewrite real handlers and restore them in a `finally`.
  // That failed once: a blanket delete of `.mutbak` files ran while a long
  // mutation pass was still going, two backups vanished before they were used,
  // and `git add -A` committed the mutants. What reached the default branch
  // was:
  //
  //     delete.handlers.ts : if (advance.IsDeducted)  ->  if (false)
  //     stock.ts           : consumeLots(...) deleted
  //
  // The first disables the advance deduction when a payout is deleted; the
  // second stops sales drawing from the cost layers, so inventory valuation
  // and COGS both go wrong. Neither is visible in a passing test run, because
  // the suites that would catch them are the ones the mutation tool disables
  // while it works.
  //
  // This is cheap and it is checked on every run.
  {
    const MUTANT_MARKS = [
      [/\bif\s*\(\s*false\s*\)/, 'if (false)'],
      [/\bif\s*\(\s*true\s*\)\s*return\b/, 'if (true) return'],
      [/\/\/\s*MUTANT\b/i, '// MUTANT'],
    ];
    const found = [];
    const walkSrc = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walkSrc(full); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const body = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
        for (const [rx, label] of MUTANT_MARKS) {
          if (rx.test(body)) found.push(`${relative(ROOT, full)} (${label})`);
        }
      }
    };
    walkSrc(join(ROOT, 'src'));
    ok('no mutation marker was left in src/', found.length === 0, found.join(', '));

    // And no backup file from a mutation run may be sitting in the tree.
    const strays = [];
    const walkAny = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walkAny(full); continue; }
        if (e.name.endsWith('.mutbak')) strays.push(relative(ROOT, full));
      }
    };
    walkAny(ROOT);
    ok('no .mutbak backup was left behind', strays.length === 0, strays.join(', '));
  }

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
    await import(pathToFileURL(join(ROOT, 'scripts/lib/handlerHarness.mjs')).href);
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

  /**
   * How many database-level guards the migration must declare.
   *
   * 44 value guards (a price may not be negative, a status must be one of a
   * known set, and so on) plus 2 that protect the AUDIT TRAIL itself:
   * `ck_security_events_no_update` and `ck_security_events_no_delete`.
   *
   * The audit pair is a different KIND of guard — it constrains the operation
   * rather than the value — but it is counted here for the same reason as the
   * rest: this number is the tripwire that makes a removed guard show up in a
   * diff instead of vanishing quietly. Raising it was itself caught by this
   * check failing when the two triggers were added.
   */
  const EXPECTED_GUARDS = 46;

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
  const mod = await import(pathToFileURL(join(ROOT, 'server/worker.js')).href);
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
  const { buildDatabase } = await import(pathToFileURL(join(ROOT, 'scripts/lib/handlerHarness.mjs')).href);
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
  const EXPECTED_GUARDS = 46;   // must match the constant in section 3
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
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/\b(FIXME|XXX|HACK)\b/.test(l) && !l.trim().startsWith('*')) {
        markers.push(`${relPath(f)}:${i + 1}`);
      }
    });
  }
  ok('no FIXME/XXX/HACK marker in shipped source', markers.length === 0,
    markers.slice(0, 5).join(', '));

  // `debugger` reaching a customer freezes the renderer against a closed
  // DevTools.
  const dbg = files.filter(f => /^\s*debugger\s*;?\s*$/m.test(readFileSync(f, 'utf8')))
    .map(f => relPath(f));
  ok('no debugger statement', dbg.length === 0, dbg.join(', '));
}

console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — every readiness axis is covered and wired in`);
