#!/usr/bin/env node
/**
 * MUTATION TEST for verify_money_precision.mjs.
 *
 * Both directions: reverting the rounding must fail the suite, and so must
 * widening it to rewrite arithmetic it has no business touching.
 *
 * Run:  node scripts/mutate_money_precision.mjs
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
const CONN = join(ROOT, 'src/main/database/connection.ts');
const STUB = join(ROOT, 'scripts/lib/stubs/betterSqlite.mjs');

const MUTANTS = [
  ['the rewrite is disabled in the shipped driver', CONN, [
    '    const sql = roundBalanceArithmetic(rawSql);',
    '    const sql = rawSql;',
  ]],
  ['the rewrite is disabled in the test stub', STUB, [
    '    const sql = /\\bSET\\s+Balance\\s*=\\s*Balance\\s*[+-]\\s*\\?/i.test(rawSql)',
    '    const sql = false',
  ]],
  ['rounding goes to whole pounds instead of piastres', CONN, [
    '    (_m, op: string) => `SET Balance = ROUND(Balance ${op} ?, 2)`,',
    '    (_m, op: string) => `SET Balance = ROUND(Balance ${op} ?, 0)`,',
  ]],
  ['only addition is rounded, subtraction still drifts', CONN, [
    "    /\\bSET\\s+Balance\\s*=\\s*Balance\\s*([+-])\\s*\\?/gi,",
    "    /\\bSET\\s+Balance\\s*=\\s*Balance\\s*([+])\\s*\\?/gi,",
  ]],
  ['the rewrite over-reaches onto every column', CONN, [
    "  if (!/\\bSET\\s+Balance\\s*=\\s*Balance\\s*[+-]\\s*\\?/i.test(sql)) return sql;\n  return sql.replace(\n    /\\bSET\\s+Balance\\s*=\\s*Balance\\s*([+-])\\s*\\?/gi,\n    (_m, op: string) => `SET Balance = ROUND(Balance ${op} ?, 2)`,\n  );",
    "  return sql.replace(\n    /\\bSET\\s+(\\w+)\\s*=\\s*(\\w+)\\s*([+-])\\s*\\?/gi,\n    (_m, a: string, b: string, op: string) => `SET ${a} = ROUND(${b} ${op} ?, 2)`,\n  );",
  ]],
  ['the shipped rewrite and the stub drift apart', STUB, [
    '          (_m, op) => `SET Balance = ROUND(Balance ${op} ?, 2)`)',
    '          (_m, op) => `SET Balance = ROUND(Balance ${op} ?, 4)`)',
  ]],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_money_precision.mjs'],
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

console.log('\n' + '='.repeat(64));
console.log(`${caught} of ${MUTANTS.length} mutants caught`);
if (survived.length) {
  console.log('\nSURVIVED — the suite does not actually test these:');
  for (const s of survived) console.log('  • ' + s);
  process.exit(1);
}
console.log('every mutant was caught');
