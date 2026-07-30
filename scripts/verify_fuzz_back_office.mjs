#!/usr/bin/env node
/**
 * BACK-OFFICE FUZZ SWEEP — many seeds, run as part of `npm run verify`.
 *
 * One seed proves nothing: the faults this found needed a specific ordering
 * (an advance recovered by a salary, then deleted; a stocktake on an item held
 * in two warehouses at different costs). Sweeping seeds is what turns a lucky
 * pass into evidence.
 *
 * Every seed here was failing before the fixes in this round. They are kept as
 * a regression gate: if any of them starts failing again, the operation named
 * in the breach is the one that changed.
 *
 * Run with:  node --experimental-strip-types scripts/verify_fuzz_back_office.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SEEDS = Number(process.env.BO_SEEDS) || 30;
const OPS = Number(process.env.BO_OPS) || 150;

console.log('='.repeat(74));
console.log(`BACK-OFFICE FUZZ SWEEP — ${SEEDS} seeds x ${OPS} operations`);
console.log('='.repeat(74));

let clean = 0;
const failures = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'scripts/fuzz_back_office.mjs'), String(OPS), String(seed)],
      { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 },
    );
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  if (/^OK/m.test(out)) {
    clean++;
    continue;
  }

  const breach = (out.match(/INVARIANT BREACH.*/m) || ['(no breach line)'])[0];
  const detail = (out.match(/^ {2}- .*/m) || [''])[0].trim();
  failures.push({ seed, breach, detail });
  console.log(`  FAIL  seed ${seed}: ${breach}`);
  if (detail) console.log(`        ${detail}`);
  console.log(`        replay: node --experimental-strip-types scripts/fuzz_back_office.mjs ${OPS} ${seed}`);
}

console.log();
console.log('='.repeat(74));
console.log(`RESULT: ${clean}/${SEEDS} seeds clean, ${failures.length} failed `
  + `(${(SEEDS * OPS).toLocaleString()} operations verified)`);
console.log('='.repeat(74));
process.exit(failures.length ? 1 : 0);
