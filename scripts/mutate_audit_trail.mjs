#!/usr/bin/env node
/**
 * MUTATION TEST for verify_audit_trail.mjs.
 *
 * Both directions. Removing a guard must fail the suite; so must over-reaching
 * with one — a trigger that also blocks INSERT would leave the shop with no
 * audit trail at all, and one that breaks `settings:resetDatabase` would stop
 * the shop resetting.
 *
 * Run:  node scripts/mutate_audit_trail.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIG = join(ROOT, 'src/main/database/migrations/index.ts');
const SET = join(ROOT, 'src/main/ipc/settings.handlers.ts');

const MUTANTS = [
  ['the UPDATE guard is removed', MIG, [
    `    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_update
    BEFORE UPDATE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be altered'); END;`,
    '',
  ]],
  ['the DELETE guard is removed', MIG, [
    `    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_delete
    BEFORE DELETE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be deleted'); END;`,
    '',
  ]],
  ['the UPDATE guard only fires for one column', MIG, [
    `    BEFORE UPDATE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be altered'); END;`,
    `    BEFORE UPDATE OF Detail ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be altered'); END;`,
  ]],
  ['the DELETE guard spares single-row deletes', MIG, [
    `    BEFORE DELETE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be deleted'); END;`,
    `    BEFORE DELETE ON security_events
    WHEN (SELECT COUNT(*) FROM security_events) > 1000
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be deleted'); END;`,
  ]],
  ['the guard over-reaches and blocks INSERT too', MIG, [
    `    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_update
    BEFORE UPDATE ON security_events`,
    `    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_insert
    BEFORE INSERT ON security_events
    BEGIN SELECT RAISE(ABORT, 'no'); END;
    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_update
    BEFORE UPDATE ON security_events`,
  ]],
  ['the reset stops preserving the audit trail (reset breaks)', SET, [
    `      'fiscal_years', 'security_events',`,
    `      'fiscal_years',`,
  ]],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_audit_trail.mjs'],
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
