#!/usr/bin/env node
/**
 * MUTATION TEST for verify_worker_auth.mjs.
 *
 * The worker is the only internet-facing part of this product, so its auth
 * suite has to be worth something. Each mutant below is a plausible mistake —
 * an admin route downgraded to the shipped client key, a comparison turned
 * into `===`, the error text handed back to the caller — and the suite must
 * FAIL on every one.
 *
 * Run:  node scripts/mutate_worker_auth.mjs
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
const W = join(ROOT, 'server/worker.js');

const MUTANTS = [
  ['/issue accepts the shipped CLIENT key instead of the admin key', [
    `  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY || '')) {`,
    `  if (!safeEqual(request.headers.get('X-Client-Key') || '', env.CLIENT_KEY || '')) {`,
  ], 1],
  ['the key comparison becomes a plain === (leaks length and prefix by timing)', [
    `function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}`,
    `function safeEqual(a, b) {
  for (let i = 0; i < String(a).length; i++) { if (a[i] !== b[i]) return false; }
  return a === b;
}`,
  ], 1],
  ['safeEqual stops rejecting a non-string', [
    `  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;`,
    `  if (a === undefined && b === undefined) return true;\n  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;`,
  ], 1],
  ['the catch-all hands the fault text back to the caller', [
    `      return json({ ok: false, error: 'internal error', ref }, 500);`,
    `      return json({ ok: false, error: String(err && err.message), ref }, 500);`,
  ], 1],
  ['the catch-all drops the support reference', [
    `      return json({ ok: false, error: 'internal error', ref }, 500);`,
    `      return json({ ok: false, error: 'internal error' }, 500);`,
  ], 1],
  ['the telegram webhook stops checking the chat id', [
    `  if (!isAdminChat(env, chatId)) return json({ ok: true });`,
    `  if (false) return json({ ok: true });`,
  ], 1],
  ['the telegram webhook answers a stranger with a distinct status', [
    `  if (!isAdminChat(env, chatId)) return json({ ok: true });`,
    `  if (!isAdminChat(env, chatId)) return json({ ok: false, error: 'unauthorized' }, 403);`,
  ], 1],
  ['adminChats accepts any string, not only a numeric id', [
    `    .filter(x => /^-?\\d{5,}$/.test(x));`,
    `    .filter(x => x.length > 0);`,
  ], 1],
  // The forgery defence. Without these the suite could pass while /telegram is
  // wide open, which is exactly the state a measured exploit found it in.
  ['the webhook secret is not checked at all', [
    `  const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !safeEqual(presented, env.TG_WEBHOOK_SECRET)) {`,
    `  const presented = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (false) {`,
  ], 1],
  ['the webhook FAILS OPEN when the secret is unconfigured', [
    `  if (!env.TG_WEBHOOK_SECRET || !safeEqual(presented, env.TG_WEBHOOK_SECRET)) {`,
    `  if (env.TG_WEBHOOK_SECRET && !safeEqual(presented, env.TG_WEBHOOK_SECRET)) {`,
  ], 1],
  ['the webhook compares the secret with a loose ==', [
    `  if (!env.TG_WEBHOOK_SECRET || !safeEqual(presented, env.TG_WEBHOOK_SECRET)) {`,
    `  if (!env.TG_WEBHOOK_SECRET || presented.slice(0, 4) != String(env.TG_WEBHOOK_SECRET).slice(0, 4)) {`,
  ], 1],
  ['a rejected webhook answers with a distinct status', [
    `    console.error('[worker] /telegram rejected: webhook secret missing or wrong');
    return json({ ok: true });`,
    `    return json({ ok: false, error: 'bad webhook secret' }, 403);`,
  ], 1],
  ['isAdminChat trims the caller-supplied chat id again', [
    `  const id = String(chatId ?? '');
  if (!/^-?\\d{5,}$/.test(id)) return false;`,
    `  const id = String(chatId ?? '').trim();
  if (!id) return false;`,
  ], 1],
];

const runSuite = () => {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify_worker_auth.mjs'],
      { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
};

console.log('baseline (no mutation):');
if (!runSuite()) { console.log('  the suite FAILS on the clean tree — fix that first'); process.exit(1); }
console.log('  passes\n');

let caught = 0;
const survived = [];

for (const [label, [find, replace], count] of MUTANTS) {
  const backup = W + '.mutbak';
  copyFileSync(W, backup);
  const src = readFileSync(W, 'utf8');
  if (!src.includes(find)) {
    console.log(`SKIP     ${label}\n         (target text absent — the mutant is stale)`);
    unlinkSync(backup);
    survived.push(label + '  [STALE MUTANT]');
    continue;
  }
  // Replace only the first `count` occurrences, so a mutant aimed at one route
  // does not accidentally rewrite every route and pass for the wrong reason.
  let out = src, done = 0;
  let idx = out.indexOf(find);
  while (idx >= 0 && done < count) {
    out = out.slice(0, idx) + replace + out.slice(idx + find.length);
    done++;
    idx = out.indexOf(find, idx + replace.length);
  }
  writeFileSync(W, out, 'utf8');
  const passed = runSuite();
  copyFileSync(backup, W);
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
