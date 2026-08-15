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
  ['the guard never refuses a closed year (no date)', GUARD, [
    `  if (row.Status === 'closed') return refuseClosed(row, id);`,
    `  if (row.Status === 'closed') return null;`,
  ]],
  ['the guard never refuses a closed year (explicit date)', GUARD, [
    `    if (row.Status === 'closed') return refuseClosed(row, row.FiscalYearID ?? 0);`,
    `    if (row.Status === 'closed') return null;`,
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
  ['the guard stops rewriting the payload to the date\'s year', GUARD, [
    `    payload.fiscalYearId = row.FiscalYearID;
    payload.FiscalYearID = row.FiscalYearID;`,
    `    void row;`,
  ]],
  ['the guard stops refusing future dates', GUARD, [
    `  if (effectiveDate > limitStr) {`,
    `  if (false) {`,
  ]],
  ['the guard stops refusing dates no year covers', GUARD, [
    `    if (!row) {
      return {
        success: false,
        code: 'FISCAL_YEAR_MISSING',
        message: \`لا توجد سنة مالية تغطي تاريخ`,
    `    if (false) {
      return {
        success: false,
        code: 'FISCAL_YEAR_MISSING',
        message: \`لا توجد سنة مالية تغطي تاريخ`,
  ]],
  ['the guard stops checking that today lies inside the addressed year', GUARD, [
    `  if (today < (row.StartDate ?? '') || today > (row.EndDate ?? '')) {`,
    `  if (false) {`,
  ]],
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
  // Windows checkouts hold CRLF line endings; the find/replace pairs below are
  // written with LF. A multi-line mutant silently went stale ("target text
  // absent") on a CRLF file while the same text matched on an LF file — so
  // the patterns are adapted to the file's own ending before matching.
  const adapt = (text) =>
    src.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r?\n/g, '\n');
  const findText = adapt(find);
  if (!src.includes(findText)) {
    console.log(`SKIP     ${label}\n         (target text absent — the mutant is stale)`);
    unlinkSync(backup);
    survived.push(label + '  [STALE MUTANT]');
    continue;
  }
  writeFileSync(file, src.replace(findText, adapt(replace)), 'utf8');
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
