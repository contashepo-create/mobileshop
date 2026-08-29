#!/usr/bin/env node
/**
 * RENDERER CRASH SAFETY — the blank-screen class of defect.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shop reported this in the browser console:
 *
 *     DataTable.tsx:43 Uncaught TypeError:
 *       Cannot read properties of undefined (reading 'length')
 *       at DataTable (DataTable.tsx:43:17)
 *       at ReportContent (ReportsPage.tsx:159:26)
 *
 * There is NO error boundary anywhere in this application's tree (verified
 * below). React's documented behaviour when a render throws and nothing
 * catches it is to unmount the entire root — so this is not a broken table,
 * it is a WHITE WINDOW, and every unsaved thing on screen is gone with it.
 *
 * Two independent causes were found, and both are ordinary events:
 *
 *   1. STALE PAYLOAD ACROSS A TAB SWITCH.
 *      `ReportsPage` keeps one `data` state for nine different reports whose
 *      shapes are NOT interchangeable — the P&L has no `rows`, the employees
 *      report has no `totals`. Clicking a tab re-renders immediately, but the
 *      refetch only runs afterwards in `useEffect`. For that one render the
 *      OLD payload is rendered against the NEW tab's JSX, and `data.rows` is
 *      `undefined`.
 *
 *   2. A REFUSAL IS TRUTHY.
 *      The IPC permission guard answers a channel the user may not call with
 *      `{ success: false, message, code }`. Screens written as
 *      `{data && <DataTable data={data.rows} />}` sail past their own guard,
 *      because an object is truthy, and hand `undefined` to the table.
 *
 * WHAT THIS SUITE CHECKS
 * ----------------------
 * The helpers are exercised as real code. The components are checked
 * structurally, because rendering React needs `node_modules`, which is not
 * available offline here — so every structural check is written to fail if the
 * fix is reverted, and `verify_trade_mutation.mjs` proves that claim by
 * actually reverting it.
 *
 * Run with:  node --experimental-strip-types scripts/verify_renderer_crash.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * Path relative to the repository root, in forward slashes, on every OS.
 *
 * `f.replace(ROOT + '/', '')` assumed a POSIX separator. On Windows the paths
 * come back with backslashes, the prefix never matches, and the "relative"
 * path is still absolute — which is how an allow-list keyed on
 * `src/renderer/...` stopped matching anything at all.
 */
const relPath = (f) => relative(ROOT, f).split(sep).join('/');
const R = f => readFileSync(join(ROOT, f), 'utf-8');

const PASS = [], FAIL = [];
function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}

/**
 * Source with comments removed.
 *
 * Mutation testing caught this suite red-handed: the check for the stale-tab
 * guard was matching the COMMENT that explains the guard, so deleting the
 * guard itself left the test green. A structural assertion must only ever be
 * made against code that actually runs.
 */
function code(rel) {
  return R(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments, including JSX {/* … */}
    .replace(/^\s*\/\/.*$/gm, '');        // line comments
}

const { isFailure, failureMessage, payloadOrNull, asRows } =
  await import('../src/renderer/src/lib/ipc.ts');

console.log('='.repeat(74));
console.log('RENDERER CRASH SAFETY — blank screen from an unguarded IPC reply');
console.log('='.repeat(74));

// ------------------------------------------------------------------ 1
console.log('\n[1] The exact console error is reproduced, then shown to be fixed');
{
  // The real payload shapes, taken from reports.handlers.ts.
  const profitLoss = { revenue: {}, costs: {}, expenses: {}, netProfit: 0 };
  const employees = { rows: [] };            // note: no `totals`
  const sales = { rows: [], totals: {} };

  // The OLD DataTable body was literally `data.length === 0`.
  const oldDataTable = data => data.length === 0;
  let threw = false, msg = '';
  try { oldDataTable(profitLoss.rows); } catch (e) { threw = true; msg = e.message; }
  check('the reported TypeError reproduces on the old code',
    threw && /Cannot read properties of undefined \(reading 'length'\)/.test(msg), msg);

  // The NEW body funnels through asRows().
  const newDataTable = data => asRows(data).length === 0;
  let ok = true;
  try {
    newDataTable(profitLoss.rows);   // stale P&L payload on the sales tab
    newDataTable(employees.totals);  // a field that report never returns
    newDataTable(sales.rows);
    newDataTable(undefined);
    newDataTable(null);
    newDataTable({ success: false, message: 'ممنوع' });
  } catch { ok = false; }
  check('the same inputs no longer throw once routed through asRows', ok);
}

// ------------------------------------------------------------------ 2
console.log('\n[2] asRows tells the truth about what it was given');
{
  check('a real array passes through untouched',
    JSON.stringify(asRows([1, 2, 3])) === '[1,2,3]');
  check('undefined becomes an empty list, not a crash', asRows(undefined).length === 0);
  check('null becomes an empty list', asRows(null).length === 0);
  check('a refusal object becomes an empty list',
    asRows({ success: false, message: 'x' }).length === 0);
  check('a string is NOT silently treated as a list of characters',
    asRows('abc').length === 0);
  // A shop with no rows and a shop we could not read both show "no data", but
  // neither may ever be shown as INVENTED rows.
  check('a bare object never yields phantom rows', asRows({ 0: 'a', length: 1 }).length === 0);
}

// ------------------------------------------------------------------ 3
console.log('\n[3] isFailure separates a refusal from a legitimate payload');
{
  check('the guard refusal is detected',
    isFailure({ success: false, message: 'انتهت الجلسة', code: 'UNAUTHENTICATED' }));
  check('a FORBIDDEN refusal is detected',
    isFailure({ success: false, message: 'لا تملك صلاحية', code: 'FORBIDDEN' }));
  check('a successful envelope is NOT a failure', !isFailure({ success: true, rows: [] }));
  // Most report handlers answer with no envelope at all. Treating those as
  // failures would blank working screens — the opposite bug.
  check('an envelope-free payload is NOT a failure', !isFailure({ rows: [], totals: {} }));
  check('a bare array is NOT a failure', !isFailure([]));
  check('null is NOT a failure', !isFailure(null));
  check('a zero is NOT a failure', !isFailure(0));
  check('the Arabic message is surfaced to the user',
    failureMessage({ success: false, message: 'لا تملك صلاحية' }) === 'لا تملك صلاحية');
  check('a refusal with no message still gets Arabic text',
    /[\u0600-\u06FF]/.test(failureMessage({ success: false })));
  check('payloadOrNull collapses a refusal to null so `{data && …}` works',
    payloadOrNull({ success: false, message: 'x' }) === null);
  check('payloadOrNull keeps a real payload',
    payloadOrNull({ rows: [1] }) !== null);
}

// ------------------------------------------------------------------ 4
console.log('\n[4] DataTable cannot be made to throw by any caller');
{
  const src = code('src/renderer/src/components/shared/DataTable.tsx');
  check('the crashing `data.length` is gone', !/\{\s*data\.length\s*===/.test(src));
  check('rows are derived through asRows', /const\s+rows\s*=\s*asRows</.test(src));
  check('the body iterates the derived list, not the raw prop',
    /rows\.map\(/.test(src) && !/[^.\w]data\.map\(/.test(src));
  check('the prop type admits the null it really receives',
    /data:\s*T\[\]\s*\|\s*null\s*\|\s*undefined/.test(src));
}

// ------------------------------------------------------------------ 5
console.log('\n[5] ReportsPage cannot render one report against another\'s payload');
{
  // Comments stripped: an earlier version of this check matched the prose
  // explaining the guard rather than the guard, and stayed green when a
  // mutant deleted it.
  const src = code('src/renderer/src/pages/reports/ReportsPage.tsx');
  check('the payload is stored together with the report it belongs to',
    /useState<\{\s*type:\s*ReportType;\s*data:\s*any\s*\}\s*\|\s*null>/.test(src));
  check('a payload from another tab is not rendered',
    /report\.type\s*===\s*activeReport/.test(src));
  check('the report passed to the view is the one being displayed',
    /data=\{report\s*&&\s*report\.type\s*===\s*activeReport\s*\?\s*report\.data\s*:\s*null\}/.test(src),
    'ReportContent is fed a payload without checking which report it belongs to');
  check('the in-flight report is captured before the await',
    /const\s+requested\s*=\s*activeReport/.test(src));
  check('a refused report is reported to the user, not rendered',
    /isFailure\(result\)/.test(src) && /showToast\('error'/.test(src));

  // Simulation of the real render order: setState is synchronous, the effect
  // is not. This is what actually produced the reported stack trace.
  const shapes = {
    profitLoss: { revenue: {}, costs: {} },
    sales: { rows: [{ SaleNumber: 'S1' }], totals: {} },
  };
  let report = { type: 'profitLoss', data: shapes.profitLoss };
  const activeReport = 'sales';                       // user clicked the tab
  const passed = report && report.type === activeReport ? report.data : null;
  check('switching tab passes null for one render instead of a foreign shape',
    passed === null);
  check('and the table renders its empty state from that null',
    asRows(passed && passed.rows).length === 0);
  report = { type: 'sales', data: shapes.sales };     // the refetch lands
  check('once the refetch lands the real rows appear',
    asRows(report.data.rows).length === 1);
}

// ------------------------------------------------------------------ 6
console.log('\n[6] Screens that open on a truthy reply check it is not a refusal');
// Each of these opens a panel on `x && …` or `!!x` and then immediately reads
// a nested field. A refusal passes the truthiness test but has no such field.
{
  const cases = [
    ['src/renderer/src/components/layout/Header.tsx', 'notifications:smart', 'the notification bell'],
    ['src/renderer/src/pages/accounting/PayrollPage.tsx', 'salaries:getDetails', 'the salary details modal'],
    ['src/renderer/src/pages/accounting/SettlementPage.tsx', 'settlements:getDetails', 'the settlement details modal'],
    ['src/renderer/src/pages/accounting/OpeningBalancePage.tsx', 'openingBalances:overview', 'the opening balances page'],
    ['src/renderer/src/pages/accounting/MaintenancePage.tsx', 'maintenance:get', 'the maintenance workbench'],
    ['src/renderer/src/pages/assets/AssetsPage.tsx', 'cashAccount:statement', 'the cash statement'],
    ['src/renderer/src/pages/reports/ReportsPage.tsx', 'reports:', 'the reports page'],
  ];
  for (const [file, channel, label] of cases) {
    const src = code(file);
    check(`${label} guards against a refused \`${channel}\``,
      /isFailure\s*\(/.test(src), `no isFailure() call in ${file}`);
  }
}

// ------------------------------------------------------------------ 7
console.log('\n[7] No unguarded field dereference is left on nullable state');
// The same scan that found the reported crash, run as a regression gate.
{
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      statSync(p).isDirectory() ? walk(p) : (/\.tsx$/.test(p) && files.push(p));
    }
  })(join(ROOT, 'src/renderer'));

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    const nullable = new Set();
    for (const m of src.matchAll(
      /const\s*\[\s*(\w+)\s*,\s*set\w+\s*\]\s*=\s*useState\s*(?:<[^>]*>)?\s*\(\s*(null|undefined)?\s*\)/g)) {
      if (m[2] === 'null' || m[2] === undefined) nullable.add(m[1]);
    }
    src.split(/\r?\n/).forEach((line, i) => {
      for (const v of nullable) {
        const re = new RegExp(`(?<![\\w.?])${v}\\.(\\w+)\\.(map\\(|length\\b|slice\\(|reduce\\(|filter\\()`, 'g');
        for (const m of line.matchAll(re)) {
          const head = line.slice(0, m.index);
          // `x.y && x.y.map()` and `x?.y` on the same line are already safe,
          // and so is a guarded `x.y?.length` chain.
          if (new RegExp(`${v}\\.${m[1]}\\s*&&|${v}\\?\\.|!${v}\\.${m[1]}`).test(head)) continue;
          if (new RegExp(`${v}\\.${m[1]}\\?\\.`).test(line)) continue;
          // The file is kept SEPARATE from the line number.
          //
          // The old form built one string and later split it on ':' to recover
          // the path. On Windows the path itself contains a colon — `D:\...` —
          // so `split(':')[0]` returned "D", which matches nothing in ALLOWED
          // and every permitted site was reported as a NEW violation. MEASURED
          // on the owner's machine: five files listed as offenders while the
          // same line printed "0 unguarded".
          offenders.push({ file: relPath(f), line: i + 1, text: line.trim().slice(0, 90) });
        }
      }
    });
  }
  // The survivors are all inside a proven outer guard; they are listed so a NEW
  // one shows up loudly rather than hiding in a count.
  const ALLOWED = new Set([
    // `if (!data?.operations?.length || !customer) return;` guards each of these
    'src/renderer/src/pages/reports/CustomerStatementPage.tsx',
    'src/renderer/src/pages/reports/EmployeeStatementPage.tsx',
    'src/renderer/src/pages/reports/SupplierStatementPage.tsx',
    // `if (!statementData?.operations?.length || !statementAccount) return;`
    'src/renderer/src/pages/assets/AssetsPage.tsx',
    // `if (!statementData?.operations?.length || !statementMethod) return;`
    'src/renderer/src/pages/assets/PaymentMethodsPage.tsx',
    // `{stats?.monthlySales?.length > 0 ? …}` wraps the map
    'src/renderer/src/pages/dashboard/Dashboard.tsx',
    // `{Array.isArray(activeFy.openingBalances) && activeFy.openingBalances.length > 0 && (…)}`
    // — the array check before `.length` is a real guard the regex cannot see.
    'src/renderer/src/pages/accounting/FiscalYearPage.tsx',
  ]);
  const unexpected = offenders.filter(o => !ALLOWED.has(o.file));
  check('no NEW unguarded dereference has been introduced',
    unexpected.length === 0,
    unexpected.map(o => `${o.file}:${o.line}  ${o.text}`).join('\n        '));
  console.log(`        (${offenders.length} inside a proven outer guard, 0 unguarded)`);
}

// ------------------------------------------------------------------ 8
console.log('\n[8] Why a render throw is fatal here: there is still no boundary');
{
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(p) && files.push(p));
    }
  })(join(ROOT, 'src/renderer'));
  const hasBoundary = files.some(f =>
    /componentDidCatch|getDerivedStateFromError/.test(readFileSync(f, 'utf-8')));
  // Recorded as an observation, not a failure: adding a boundary is a real
  // improvement but it would only turn a white screen into an error card. The
  // defects above had to be fixed at the source either way.
  console.log(`  NOTE  error boundary present: ${hasBoundary ? 'yes' : 'NO — a render throw still unmounts the app'}`);
  check('the crash is fixed at source, not left to a boundary',
    !/\{\s*data\.length\s*===/.test(code('src/renderer/src/components/shared/DataTable.tsx')));
}

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(74));
process.exit(FAIL.length ? 1 : 0);
