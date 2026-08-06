#!/usr/bin/env node
/**
 * ERROR DISCLOSURE — a failure may say WHAT went wrong, never HOW.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Roughly two dozen handlers ended their `try` with
 *
 *     catch (err: any) { return { success: false, message: err.message }; }
 *
 * and the renderer puts `result.message` straight into a toast. So whatever
 * the runtime produced was shown to whoever was standing at the till. What
 * that actually is was MEASURED against real failures, not imagined:
 *
 *     ENOENT: no such file or directory, open '/home/user/.../mobile_shop.db'
 *     EACCES: permission denied, open '/proc/1/mem'
 *     UNIQUE constraint failed: customers.Phone
 *     NOT NULL constraint failed: customers.Name
 *     no such table: secret_table
 *     near "SELEC": syntax error
 *     Unknown named parameter 'saleId'
 *     file is not a database
 *
 * And on the Cloudflare Worker, driving the real exported `fetch` with a D1
 * that throws, EVERY public endpoint — including `/health`, which needs no
 * credential — answered an anonymous caller with
 *
 *     {"ok":false,"error":"D1_ERROR: no such table: devices at /worker/db.js:412"}
 *
 * That is a free schema probe: send a malformed request, read the table names
 * out of the reply.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED
 * ----------------------------------
 * Two things, and the distinction is the whole design.
 *
 *   1. Messages written FOR the user. "لا يمكن حذف فاتورة الشراء - الصنف لم
 *      يعد بالمخزن" is the only explanation the shop gets for a refusal it has
 *      to understand. Those are marked `userRefusal` and pass through — but
 *      they are still screened, because several are built by interpolation and
 *      could pick up a path without anyone noticing.
 *
 *   2. Paths the owner ASKED for. `backup:create` returns the file it just
 *      wrote to the folder the owner chose in a save dialog, on their own
 *      machine. Telling them where it went is the feature, not a leak.
 *
 * Run:  node --experimental-strip-types scripts/verify_error_disclosure.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

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
const require = createRequire(join(ROOT, 'package.json'));

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

// ===========================================================================
console.log('\n── 1. the detector recognises every leak shape ──');
// ===========================================================================
const er = await import(pathToFileURL(join(ROOT, 'src/main/security/errorResponse.ts')).href);
{
  // Every string below came out of a REAL failure captured while auditing.
  const MUST_FLAG = [
    "ENOENT: no such file or directory, open '/home/user/mobileshop/x.db'",
    "EACCES: permission denied, open '/proc/1/mem'",
    'EPERM: operation not permitted',
    'UNIQUE constraint failed: customers.Phone',
    'NOT NULL constraint failed: customers.Name',
    'FOREIGN KEY constraint failed',
    'no such table: secret_table',
    'no such column: NoSuchCol',
    'near "SELEC": syntax error',
    "Unknown named parameter 'saleId'",
    'Missing named parameter "Name"',
    'Provided value cannot be bound to SQLite parameter 3.',
    'file is not a database',
    'unable to open database file',
    'database disk image is malformed',
    'SQLITE_CONSTRAINT_UNIQUE',
    'SQLITE_BUSY_SNAPSHOT',
    'D1_ERROR: no such table: devices',
    'C:\\Users\\mohamed\\AppData\\mobile_shop.db',
    '\\\\SERVER\\share\\mobile_shop.db',
    'at Object.run (/home/user/mobileshop/scripts/lib/stubs/betterSqlite.mjs:25:25)',
    'TypeError: Cannot read properties of undefined',
    'ReferenceError: x is not defined',
    'src/main/ipc/sales.handlers.ts:1158',
    'node_modules/better-sqlite3/lib/index.js',
    'node:internal/modules/cjs/loader',
    // Each of the three below is caught by EXACTLY ONE pattern.
    //
    // Mutation testing showed why that matters: the samples above are caught
    // by two or three patterns at once, so deleting any single one left them
    // still flagged and the suite passed. A detector is only tested when every
    // rule has a case that fails without it.
    'تعذّر الوصول إلى /home/user/mobileshop/backups',   // POSIX path, no errno, no extension
    'at Database.prepare (native)',                      // stack frame, no path, no extension
    'حدث خطأ في C:\\Users\\mohamed\\AppData',            // Windows path alone
  ];
  for (const s of MUST_FLAG) {
    ok(`flags: ${s.slice(0, 52)}`, er.looksTechnical(s), 'detector missed it');
  }

  // The other half. A detector that flags everything forces every message to
  // be generic, which destroys the Arabic explanations the shop relies on.
  const MUST_PASS = [
    'الباركود موجود بالفعل - استخدم باركود آخر أو اتركه فارغاً',
    'لا يمكن حذف فاتورة الشراء - الصنف لم يعد بالمخزن',
    'الرصيد غير كافٍ. الرصيد المتاح: 500.00 والمطلوب: 900.00',
    'العميل غير موجود',
    'اسم العميل مطلوب',
    'تم تسليم هذه التذكرة بالفعل - لا يمكن تسليمها مرة أخرى',
    'حالة التذكرة غير صالحة',
    'كلمة المرور يجب أن تكون 6 أحرف على الأقل',
    'تم إيقاف المحاولات مؤقتاً بعد عدة محاولات خاطئة',
    'لا يمكن التحويل إلى نفس الحساب',
    'مبلغ السند يجب أن يكون أكبر من صفر',
    'تاريخ التعيين تاريخ غير موجود',
    'محل الأخوة & أولاده',
    'تعذّر إتمام العملية. لم يتم حفظ أي تغيير.',
  ];
  for (const s of MUST_PASS) {
    ok(`allows: ${s.slice(0, 46)}`, !er.looksTechnical(s), 'detector over-reached');
  }
}

// ===========================================================================
console.log('── 2. safeFailure() converts a fault into a safe reply ──');
// ===========================================================================
{
  const quiet = console.error;
  console.error = () => {};                 // the suite proves logging separately
  try {
    const r = er.safeFailure('test:channel',
      new Error("ENOENT: no such file or directory, open '/home/user/secret.db'"));
    ok('the reply carries no path', !JSON.stringify(r).includes('/home/user/secret.db'));
    ok('the reply carries no errno', !JSON.stringify(r).includes('ENOENT'));
    ok('it reports failure', r.success === false);
    ok('it carries a machine code', r.code === 'HANDLER_ERROR');
    ok('it carries a support reference', typeof r.ref === 'string' && r.ref.length >= 4, r.ref);
    ok('the reference appears in the message so support can match it',
      r.message.includes(r.ref), r.message);
    ok('the message is Arabic, not English', /[\u0600-\u06FF]/.test(r.message));

    // A caller-supplied fallback must survive, because "تعذّرت استعادة النسخة
    // الاحتياطية" tells the owner which operation failed.
    const withFallback = er.safeFailure('x', new Error('SQLITE_BUSY'), 'تعذّرت استعادة النسخة الاحتياطية');
    ok('a clean Arabic fallback is used', withFallback.message.includes('تعذّرت استعادة'));
    ok('…and still carries the reference', withFallback.message.includes(withFallback.ref));

    // A fallback that is itself leaky must NOT be trusted.
    const leakyFallback = er.safeFailure('x', new Error('boom'), "failed at /home/user/app.ts:12");
    ok('a leaky fallback is discarded', !leakyFallback.message.includes('/home/user'));

    // A message written for the user passes through untouched.
    const refusal = er.userRefusal('لا يمكن حذف الفاتورة - الصنف لم يعد بالمخزن');
    const rr = er.safeFailure('x', refusal);
    ok('a user refusal keeps its text', rr.message === 'لا يمكن حذف الفاتورة - الصنف لم يعد بالمخزن');
    ok('…and is not labelled a handler error', rr.code === 'REFUSED');
    ok('…and carries no reference (nothing went wrong)', rr.ref === undefined);

    // …unless it has picked up something technical by interpolation.
    const poisoned = er.userRefusal("لا يمكن الحذف: ENOENT open '/home/user/x.db'");
    const pr = er.safeFailure('x', poisoned);
    ok('a refusal containing a path is replaced', !pr.message.includes('/home/user/x.db'), pr.message);

    // Non-Error throws must not crash the converter.
    for (const weird of ['plain string', 42, null, undefined, { a: 1 }, Symbol('s')]) {
      let out;
      try { out = er.safeFailure('x', weird); } catch (e) { out = { THREW: e.message }; }
      ok(`survives a thrown ${String(typeof weird)}`, out && out.success === false, JSON.stringify(out));
    }

    // safeMessage() screens a message a handler built itself. Mutation
    // testing found it completely untested: removing its check passed.
    const cleanMsg = er.safeMessage('x', 'لا يمكن حذف الفاتورة - الصنف لم يعد بالمخزن');
    ok('safeMessage passes a clean Arabic message', cleanMsg.message.includes('لا يمكن حذف'));
    ok('…and marks it a refusal', cleanMsg.code === 'REFUSED');
    const dirtyMsg = er.safeMessage('x', "تعذّر الحذف: ENOENT open '/home/user/x.db'");
    ok('safeMessage replaces a message carrying a path',
      !dirtyMsg.message.includes('/home/user/x.db'), dirtyMsg.message);
    ok('…and labels it a handler error', dirtyMsg.code === 'HANDLER_ERROR');
    const dirtySql = er.safeMessage('x', 'فشل: UNIQUE constraint failed: customers.Phone');
    ok('safeMessage replaces a message naming a column',
      !dirtySql.message.includes('customers.Phone'), dirtySql.message);

    // References must not collide within one run, or the log is unmatchable.
    const refs = new Set();
    for (let i = 0; i < 200; i++) refs.add(er.newReference());
    ok('200 references are distinct', refs.size === 200, `got ${refs.size}`);
  } finally {
    console.error = quiet;
  }
}

// ===========================================================================
console.log('── 3. the full detail still reaches the server log ──');
// ===========================================================================
{
  // Hiding the error from the user is only acceptable because the developer
  // can still read it. If this ever stops being true the fix has become a
  // cover-up, so it is asserted rather than assumed.
  const captured = [];
  const quiet = console.error;
  console.error = (...a) => captured.push(a.map(String).join(' '));
  let r;
  try {
    r = er.safeFailure('sales:create',
      new Error("UNIQUE constraint failed: customers.Phone"));
  } finally {
    console.error = quiet;
  }
  const logged = captured.join('\n');
  ok('something was logged', captured.length > 0);
  ok('the log holds the REAL error', logged.includes('UNIQUE constraint failed: customers.Phone'));
  ok('the log names the channel', logged.includes('sales:create'));
  ok('the log carries the same reference the user was given', logged.includes(r.ref), r.ref);
  ok('…and the user reply does NOT hold the real error',
    !r.message.includes('UNIQUE constraint failed'));
}

// ===========================================================================
console.log('── 4. no handler returns a raw runtime error any more ──');
// ===========================================================================
{
  const dir = join(ROOT, 'src/main');
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(e) === '.ts') files.push(full);
    }
  })(dir);

  // `message: err.message` and friends, in any spelling.
  const RAW_RETURN = /message:\s*(err|error|e)\s*\??\.\s*message/;
  const offenders = [];
  for (const f of files) {
    if (f.endsWith('errorResponse.ts')) continue;   // the module that fixes it
    // `ipcGuard.ts` returns `err.message` for an `IpcAuthError` — an error
    // WE construct, carrying an Arabic sentence written for the user
    // ("انتهت الجلسة", "ليس لديك صلاحية"). It is a refusal, not a runtime
    // fault, and the branch is guarded by `err instanceof IpcAuthError`.
    // Section 6 asserts the guard's OTHER path — the one that catches real
    // throws — stays generic.
    if (f.endsWith('ipcGuard.ts')) continue;
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
      if (RAW_RETURN.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  ok('no `message: err.message` remains in src/main', offenders.length === 0,
    offenders.slice(0, 6).join(', '));

  // Raw errors spliced into a template string are the same leak wearing a
  // prefix: `خطأ: ${err.message}` still ships the path.
  // `err`/`error` only, and only when `.message` is actually read.
  //
  // A first draft also matched a bare `e`, which flagged five INNOCENT lines:
  // `${exported} ملف`, `${expiryLabel}`, `${e.Balance.toFixed(2)}`. Those are
  // business values in success messages, not errors. A detector that cries
  // wolf on real code gets switched off, so it is narrowed to the shape that
  // actually leaks.
  const RAW_TEMPLATE = /message:\s*`[^`]*\$\{[^}]*\b(err|error)\b\s*\??\.\s*message[^}]*\}/;
  const spliced = [];
  for (const f of files) {
    if (f.endsWith('errorResponse.ts')) continue;
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
      if (RAW_TEMPLATE.test(line)) spliced.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  ok('no raw error is spliced into a message template', spliced.length === 0,
    spliced.slice(0, 6).join(', '));

  // Nothing may ever send a stack across the IPC boundary.
  const stacks = [];
  for (const f of [...files, ...(function () {
    const out = [];
    (function walk(d) {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (['.ts', '.tsx'].includes(extname(e))) out.push(full);
      }
    })(join(ROOT, 'src/renderer'));
    return out;
  })()]) {
    const body = readFileSync(f, 'utf8');
    if (/message:\s*[^,;\r\n]*\.stack|return[^;\r\n]*\.stack/.test(body)) {
      stacks.push(relative(ROOT, f));
    }
  }
  ok('no stack trace is returned anywhere', stacks.length === 0, stacks.join(', '));
}

// ===========================================================================
console.log('── 5. real handlers, driven to failure ──');
// ===========================================================================
{
  // Executed, not grepped. A source scan proves a line is absent; only calling
  // the handler proves the reply is clean.
  const { buildDatabase, loadHandlers, call } = await import(pathToFileURL(join(ROOT, 'scripts/lib/handlerHarness.mjs')).href);
  const db = buildDatabase();
  await loadHandlers();
  db.prepare("INSERT INTO roles (RoleID,RoleName,IsSystem) VALUES (1,'مدير',1)").run();
  db.prepare("INSERT INTO users (UserID,Username,PasswordHash,RoleID,IsActive) VALUES (1,'admin','x',1,1)").run();
  db.prepare("INSERT INTO fiscal_years (FiscalYearID,YearName,StartDate,EndDate,Status) VALUES (1,'26','2026-01-01','2026-12-31','open')").run();
  await call('cashAccounts:create', { AccountName: 'خ', AccountType: 'safe', Balance: 100000, BankName: null, AccountNumber: null });
  await call('warehouses:create', { WarehouseName: 'م', WarehouseType: 'main' });
  await call('customers:create', { Name: 'ع', Phone: '', Email: '', Address: '', CreditLimit: null });
  const cat = await call('categories:create', 'ف', null);
  await call('items:create', { ItemName: 'ص', CategoryID: cat.id, SalePrice: 100, ItemType: 'accessory', Barcode: 'B1' });

  const quiet = console.error;
  console.error = () => {};
  const HOSTILE = [
    ['items:create duplicate barcode', () => call('items:create',
      { ItemName: 'x', CategoryID: null, SalePrice: 1, ItemType: 'accessory', Barcode: 'B1' })],
    ['delete:sale wrong payload shape', () => call('delete:sale', { saleId: 999999, userId: 1 })],
    ['delete:purchase wrong shape', () => call('delete:purchase', { purchaseId: 999999, userId: 1 })],
    ['sales:create bogus item id', () => call('sales:create',
      { CustomerID: 1, WarehouseID: 1, items: [{ ItemID: {}, Quantity: 1, UnitPrice: 1 }], PaidAmount: 0, PaymentMethod: 'cash', CashAccountID: 1, userId: 1, fiscalYearId: 1 })],
    ['sales:create items not an array', () => call('sales:create',
      { CustomerID: 1, WarehouseID: 1, items: 'nope', PaidAmount: 0, PaymentMethod: 'cash', CashAccountID: 1, userId: 1, fiscalYearId: 1 })],
    ['purchases:create bogus item', () => call('purchases:create',
      { SupplierID: 1, WarehouseID: 1, items: [{ ItemID: {}, Quantity: 1, UnitCost: 1 }], PaidAmount: 0, userId: 1, fiscalYearId: 1 })],
    ['transfers:create bogus type', () => call('transfers:create',
      { FromType: {}, FromID: 1, ToType: 'cash_account', ToID: 2, Amount: 10, TransferCost: 0, TransferCostSource: 'separate', userId: 1, fiscalYearId: 1 })],
    ['serviceSales:create bogus amount', () => call('serviceSales:create',
      { ServiceType: 'balance_transfer', Provider: 'vodafone', TargetPhone: '0100', Amount: {}, ServiceCost: 0, ChargeAmount: 1, PaymentMethod: 'cash', PaidAmount: 1, CashAccountID: 1, userId: 1, fiscalYearId: 1 })],
    ['vouchers:create bogus party', () => call('vouchers:create',
      { VoucherType: 'receipt', PartyType: 'customer', PartyID: {}, Description: 'x', CashAccountID: 1, Amount: 1, userId: 1, fiscalYearId: 1 })],
    ['maintenance:receive bogus customer', () => call('maintenance:receive',
      { CustomerID: {}, CustomerName: 'ع', CustomerPhone: '0', DeviceModel: 'x', ProblemDesc: 'y', userId: 1, fiscalYearId: 1 })],
  ];

  try {
    for (const [label, fn] of HOSTILE) {
      let reply;
      try { reply = await fn(); } catch (e) { reply = { UNCAUGHT: String(e && e.message) }; }
      const s = JSON.stringify(reply ?? null);
      ok(`${label} does not throw across IPC`, !('UNCAUGHT' in (reply || {})), s.slice(0, 110));
      ok(`${label} reply is clean`, !er.looksTechnical(s), s.slice(0, 150));
    }
  } finally {
    console.error = quiet;
  }
}

// ===========================================================================
console.log('── 6. the IPC guard is the last line, and it is generic ──');
// ===========================================================================
{
  const guard = readFileSync(join(ROOT, 'src/main/security/ipcGuard.ts'), 'utf8');
  ok('the guard catches everything a handler throws', /runSafely/.test(guard));
  ok('…and answers with a fixed Arabic message',
    /code:\s*'HANDLER_ERROR'/.test(guard) && /message:\s*'تعذّر/.test(guard));
  // The guard must LOG what it refuses to tell the user. Mutation testing
  // caught this: deleting the console.error left the suite green, which is a
  // fix that has quietly become a cover-up — the shopkeeper is told nothing
  // and so is the developer.
  ok('…and logs the reason server-side', /console\.error\(`\[IPC\]/.test(guard));
  const runSafelyBlock = guard.slice(guard.indexOf('const runSafely'),
    guard.indexOf('const runSafely') + 700);
  ok('the guard logs INSIDE the catch, not merely somewhere in the file',
    /catch[\s\S]{0,200}console\.error/.test(runSafelyBlock),
    'a generic reply with no log discards the fault entirely');
  ok('…and the log carries the channel name', /console\.error\(`\[IPC\] "\$\{channel\}"/.test(guard));
  // The guard must not interpolate the error into the reply.
  const replyBlock = guard.slice(guard.indexOf('runSafely'), guard.indexOf('runSafely') + 900);
  ok('the guard reply contains no interpolated error',
    !/message:\s*`[^`]*\$\{[^}]*err/.test(replyBlock));
}

// ===========================================================================
console.log('── 7. the Cloudflare Worker tells anonymous callers nothing ──');
// ===========================================================================
{
  const worker = readFileSync(join(ROOT, 'server/worker.js'), 'utf8');
  ok('the catch-all no longer stringifies the error',
    !/error:\s*String\(\s*err\s*\?\.\s*message/.test(worker),
    'every public endpoint answered with the D1 error and an internal file path');
  ok('the catch-all returns a fixed string', /error:\s*'internal error'/.test(worker));
  ok('…with a reference for support', /ref\b/.test(worker.slice(worker.lastIndexOf('catch (err)'))));
  ok('…and logs the stack server-side',
    /console\.error\(`\[worker\] ref=/.test(worker));

  // Driven for real: the exported fetch, with a D1 that throws the way an
  // outage or a missing migration would.
  const mod = await import(pathToFileURL(join(ROOT, 'server/worker.js')).href);
  const boom = {
    CLIENT_KEY: 'ck', ADMIN_KEY: 'ak',
    DB: {
      prepare() { throw new Error('D1_ERROR: no such table: devices at /worker/db.js:412'); },
      batch() { throw new Error('D1_ERROR: no such table: devices'); },
      exec() { throw new Error('D1_ERROR: no such table: devices'); },
    },
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [label, path, init] of [
      ['GET /health', '/health', {}],
      ['GET /devices', '/devices', {}],
      ['POST /heartbeat', '/heartbeat', { method: 'POST', headers: { 'X-Client-Key': 'ck', 'content-type': 'application/json' }, body: `{"deviceId":"${'a'.repeat(32)}"}` }],
      ['POST /registration', '/registration', { method: 'POST', headers: { 'X-Client-Key': 'ck', 'content-type': 'application/json' }, body: `{"deviceId":"${'b'.repeat(32)}"}` }],
      ['GET /update RELEASES', '/update/win32-x64/1.0.0/RELEASES', {}],
      ['POST /issue', '/issue', { method: 'POST', headers: { 'X-Admin-Key': 'ak', 'content-type': 'application/json' }, body: '{}' }],
    ]) {
      const res = await mod.default.fetch(
        new Request('https://x.workers.dev' + path, init), boom,
        { waitUntil() {}, passThroughOnException() {} },
      );
      const body = await res.text();
      ok(`${label} leaks nothing`, !er.looksTechnical(body), `${res.status} ${body.slice(0, 130)}`);
      ok(`${label} names no D1 table`, !/devices|D1_ERROR/.test(body), body.slice(0, 130));
    }
  } finally {
    console.error = quiet;
  }
}

// ===========================================================================
console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — no failure describes the system to the caller`);
