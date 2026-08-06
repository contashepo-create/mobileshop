#!/usr/bin/env node
/**
 * MUTATION TEST for verify_fiscal_year_close.mjs.
 *
 * Every mutant is a plausible way to weaken the closed-year control, or to
 * over-reach with it. Both directions matter: a guard that refuses a
 * legitimate read is worse than the hole it closes.
 *
 * Run:  node scripts/mutate_fiscal_year_close.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const GUARD = join(ROOT, 'src/main/security/ipcGuard.ts');
const FY = join(ROOT, 'src/main/ipc/fiscalYear.handlers.ts');

const MUTANTS = [
  ['the guard is never called from installIpcGuard', GUARD, [
    `      const closedYear = refuseClosedYear(channel, args);
      if (closedYear) return closedYear;`,
    `      const closedYear = refuseClosedYear(channel, args);
      void closedYear;`,
  ]],
  ['the guard runs AFTER the handler (too late)', GUARD, [
    `      // Refuse to post into a fiscal year that has been closed.
      const closedYear = refuseClosedYear(channel, args);
      if (closedYear) return closedYear;`,
    '',
  ]],
  ['the guard never refuses anything', GUARD, [
    `  if (!row || row.Status !== 'closed') return null;`,
    `  if (!row || row.Status !== 'closed') return null;
  return null;`,
  ]],
  ['the guard stops recognising the FiscalYearID spelling', GUARD, [
    `    if (o.FiscalYearID !== undefined) { yearId = o.FiscalYearID; break; }`,
    '',
  ]],
  ['the guard stops recognising the fiscalYearId spelling', GUARD, [
    `    if (o.fiscalYearId !== undefined) { yearId = o.fiscalYearId; break; }`,
    '',
  ]],
  ['the guard blocks READS as well as writes (over-reach)', GUARD, [
    `  if (!/:(create|update|delete|pay|unpay|issue|cancel|return|deliver|apply|settle|add)/i.test(channel)) {
    return null;
  }`,
    '',
  ]],
  ['the guard only covers :create, missing pay/issue/deliver', GUARD, [
    `  if (!/:(create|update|delete|pay|unpay|issue|cancel|return|deliver|apply|settle|add)/i.test(channel)) {`,
    `  if (!/:(create)/i.test(channel)) {`,
  ]],
  ['the guard refuses an unknown year id as well (over-reach)', GUARD, [
    `  if (!row || row.Status !== 'closed') return null;`,
    `  if (!row) return { success: false, code: 'FISCAL_YEAR_CLOSED', message: 'السنة المالية مغلقة' };
  if (row.Status !== 'closed') return null;`,
  ]],
  // NOT A MUTANT — removing the `Number.isInteger` line is EQUIVALENT.
  //
  // It was tried and it SURVIVED, and the reason is worth recording rather
  // than hiding behind a weakened assertion. Every value the line rejects is
  // one that `Number()` turns into NaN, a negative, a zero or a fraction, and
  // none of those can match a `FiscalYearID` — the lookup returns undefined
  // and the guard passes the call through on the next line anyway. Verified
  // for 'BANANA', {}, -1, 0 and 1.5.
  //
  // The line is therefore defence in depth, not behaviour: it keeps a hostile
  // value away from the database instead of relying on the query to be
  // harmless. Writing a test that fails when it is removed would mean
  // asserting something the program does not actually do differently, which is
  // the kind of check that makes a suite look strong and prove nothing.
  //
  //   ['the guard accepts a non-integer year id and refuses on it', GUARD, [
  //     `  if (!Number.isInteger(id) || id <= 0) return null;`, '' ]],
  ['the refusal loses its machine-readable code', GUARD, [
    `    code: 'FISCAL_YEAR_CLOSED',`,
    `    code: 'HANDLER_ERROR',`,
  ]],
  ['the refusal stops naming the year', GUARD, [
    "    message: `السنة المالية «${row.YearName || id}» مغلقة - لا يمكن تسجيل حركات فيها`,",
    "    message: `مغلقة`,",
  ]],
  ['the new year is named after its END again (off by one)', FY, [
    '      const newYearName = `السنة المالية ${startDate.getFullYear()}`;',
    '      const newYearName = `السنة المالية ${endDate.getFullYear()}`;',
  ]],
  ['the new year is 366 days again (a day in two years at once)', FY, [
    `      endDate.setFullYear(endDate.getFullYear() + 1);
      endDate.setDate(endDate.getDate() - 1);`,
    `      endDate.setFullYear(endDate.getFullYear() + 1);`,
  ]],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_fiscal_year_close.mjs'],
      { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
};

console.log('baseline (no mutation):');
if (!runSuite()) { console.log('  the suite FAILS on the clean tree — fix that first'); process.exit(1); }
console.log('  passes\n');

let caught = 0;
const survived = [];

for (const [label, file, [find, replace]] of MUTANTS) {
  const backup = file + '.mutbak';
  copyFileSync(file, backup);
  const src = readFileSync(file, 'utf8');
  if (!src.includes(find)) {
    console.log(`SKIP     ${label}\n         (target text absent — the mutant is stale)`);
    unlinkSync(backup);
    survived.push(label + '  [STALE MUTANT]');
    continue;
  }
  writeFileSync(file, src.replace(find, replace), 'utf8');
  const passed = runSuite();
  copyFileSync(backup, file);
  unlinkSync(backup);

  if (passed) { survived.push(label); console.log(`SURVIVED ${label}`); }
  else { caught++; console.log(`caught   ${label}`); }
}

console.log('\n' + '═'.repeat(64));
console.log(`${caught} of ${MUTANTS.length} mutants caught`);
if (survived.length) {
  console.log('\nSURVIVED — the suite does not actually test these:');
  for (const s of survived) console.log('  • ' + s);
  process.exit(1);
}
console.log('every mutant was caught');
