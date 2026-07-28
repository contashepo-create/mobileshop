#!/usr/bin/env node
/**
 * Runs the trade fuzzer across MANY seeds.
 *
 * WHY A SWEEP AND NOT ONE RUN
 * ---------------------------
 * The fuzzer was previously run on a single seed. It passed, and the small
 * leftover variance was written off as "accumulated IEEE-754 error". That
 * conclusion was wrong, and one seed was the reason it survived: every other
 * seed failed immediately, and the failures were real money — 0.48 destroyed by
 * rounding a per-unit cost, 632 invented by an asymmetric reversal, 283.89 lost
 * when a warehouse emptied.
 *
 * A single random path exercises a single ordering of operations. Defects in
 * this system live in the ORDER things happen: a return after a re-averaging
 * purchase, a deletion after a partial sale, a reversal after the pool emptied.
 * Sweeping many seeds is what makes those orderings appear.
 *
 * Each seed is deterministic, so any failure reported here can be replayed
 * exactly with the command printed alongside it.
 *
 * Run with:  node --experimental-strip-types scripts/verify_fuzz_sweep.mjs [seeds] [ops]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FUZZER = join(HERE, 'fuzz_trade.mjs');

const SEEDS = Number(process.argv[2]) || 40;
const OPS = Number(process.argv[3]) || 400;

console.log('='.repeat(74));
console.log(`FUZZ SWEEP — ${SEEDS} seeds x ${OPS} operations`);
console.log('='.repeat(74));

let passed = 0;
const failures = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', FUZZER, String(OPS), String(seed)],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (err) {
    out = String(err.stdout || '') + String(err.message || '');
  }

  if (out.includes('all 14 invariants held')) {
    passed++;
    continue;
  }

  const breach = (out.match(/INVARIANT BREACH at step \d+: .*/) || ['(no detail)'])[0];
  const reason = (out.match(/\[(?:value conservation|identity|[a-zA-Z]+)\]\n\s+(.*)/) || [null, ''])[1];
  failures.push({ seed, breach, reason: reason.trim() });
  console.log(`  FAIL  seed ${seed}: ${breach}`);
  if (reason) console.log(`        ${reason.trim()}`);
  console.log(`        replay: node --experimental-strip-types scripts/fuzz_trade.mjs ${OPS} ${seed}`);
}

console.log();
console.log('='.repeat(74));
console.log(`RESULT: ${passed}/${SEEDS} seeds clean, ${failures.length} failed `
  + `(${(passed * OPS).toLocaleString()} operations verified)`);
console.log('='.repeat(74));
process.exit(failures.length ? 1 : 0);
