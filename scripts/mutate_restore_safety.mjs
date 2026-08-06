#!/usr/bin/env node
/**
 * MUTATION TEST for verify_restore_safety.mjs.
 *
 * Both directions are mutated. Weakening the guard must fail the suite, and so
 * must over-reaching with it: a restore that refuses a good backup leaves the
 * owner holding the only copy of their books and no way to load it.
 *
 * Run:  node scripts/mutate_restore_safety.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const F = join(ROOT, 'src/main/ipc/backup.handlers.ts');

const MUTANTS = [
  ['the guard is never called', [
    `      const probe = await verifyDatabaseFile(backupPath);
      if (!probe.ok) {`,
    `      const probe = { ok: true, reason: '' };
      if (!probe.ok) {`,
  ]],
  ['the guard runs but its answer is ignored', [
    `      if (!probe.ok) {
        return {
          success: false,
          message: \`النسخة الاحتياطية تالفة ولم يتم استخدامها - قاعدة البيانات الحالية سليمة (\${probe.reason})\`,
        };
      }`,
    '',
  ]],
  ['integrity_check is skipped', [
    `    const result = probe.pragma('integrity_check');`,
    `    const result = [{ integrity_check: 'ok' }];`,
  ]],
  ['a failing integrity_check is accepted anyway', [
    `    if (verdict !== 'ok') {
      return { ok: false, reason: String(verdict ?? 'فحص السلامة فشل').slice(0, 120) };
    }`,
    '',
  ]],
  ['the application-tables check is dropped (an alien db restores)', [
    `    if ((row?.n ?? 0) < 4) {
      return { ok: false, reason: 'الملف قاعدة بيانات سليمة لكنها ليست قاعدة بيانات هذا البرنامج' };
    }`,
    '',
  ]],
  ['the tables check accepts a partial match', [
    `    if ((row?.n ?? 0) < 4) {`,
    `    if ((row?.n ?? 0) < 1) {`,
  ]],
  ['the guard reverts to pragma() for the SELECT (refuses GOOD backups)', [
    `    const row = probe.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sales','purchases','customers','items')",
    ).get() as { n?: number } | undefined;`,
    `    const row = probe.pragma(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sales','purchases','customers','items')",
    ) as { n?: number } | undefined;`,
  ]],
  ['a thrown error is treated as success', [
    `    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message.slice(0, 120) };`,
    `    return { ok: true, reason: '' };`,
  ]],
  ['the candidate is opened READ-WRITE', [
    `    probe = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Probe;`,
    `    probe = new Database(file, { fileMustExist: false }) as unknown as Probe;`,
  ]],
  ['the guard runs AFTER the live database is overwritten', [
    `      const probe = await verifyDatabaseFile(backupPath);
      if (!probe.ok) {
        return {
          success: false,
          message: \`النسخة الاحتياطية تالفة ولم يتم استخدامها - قاعدة البيانات الحالية سليمة (\${probe.reason})\`,
        };
      }

      closeDb();`,
    `      closeDb();
      const probe = await verifyDatabaseFile(backupPath);
      if (!probe.ok) {
        return {
          success: false,
          message: \`النسخة الاحتياطية تالفة ولم يتم استخدامها - قاعدة البيانات الحالية سليمة (\${probe.reason})\`,
        };
      }`,
  ]],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_restore_safety.mjs'],
      { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
};

console.log('baseline (no mutation):');
if (!runSuite()) { console.log('  the suite FAILS on the clean tree — fix that first'); process.exit(1); }
console.log('  passes\n');

let caught = 0;
const survived = [];

for (const [label, [find, replace]] of MUTANTS) {
  const backup = F + '.mutbak';
  copyFileSync(F, backup);
  const src = readFileSync(F, 'utf8');
  if (!src.includes(find)) {
    console.log(`SKIP     ${label}\n         (target text absent — the mutant is stale)`);
    unlinkSync(backup);
    survived.push(label + '  [STALE MUTANT]');
    continue;
  }
  writeFileSync(F, src.replace(find, replace), 'utf8');
  const passed = runSuite();
  copyFileSync(backup, F);
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
