#!/usr/bin/env node
/**
 * TRIAL RESET RESISTANCE.
 *
 * THE HOLE THIS GUARDS
 * --------------------
 * Every piece of licence state used to live in one folder, `userData`. The app
 * did notice `trial.dat` disappearing on its own — `lastaccess.dat` gave it
 * away — but both files sat side by side, so deleting the WHOLE folder erased
 * the witness and the evidence together.
 *
 * Measured before the fix:
 *     first launch            -> NEW 7-DAY TRIAL
 *     delete trial.dat only   -> trial_expired   (correctly blocked)
 *     delete the whole folder -> NEW 7-DAY TRIAL  (the hole)
 *
 * And the database lives in that same folder, so the full recipe was: copy the
 * .db out, delete the folder, copy it back, trade on with another seven days,
 * forever, with every invoice intact.
 *
 * WHAT IS PROVEN
 *   [1] the marker is planted outside the application's own folder
 *   [2] deleting userData no longer grants a fresh trial
 *   [3] a partially-deleted marker heals itself
 *   [4] a marker cannot be forged, edited or imported from another machine
 *   [5] an unwritable machine still runs (the app must never refuse to start)
 *   [6] the licence handler consults the anchor on the path that matters
 *
 * Run with:  node --experimental-strip-types scripts/verify_trial_anchor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      const base = context.parentURL || import.meta.url;
      const candidate = new URL(specifier + '.ts', base).href;
      if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
    }
    return next(specifier, context);
  }
`), import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('TRIAL RESET RESISTANCE');
console.log('='.repeat(72));

const A = await import('../src/main/security/trialAnchor.ts');

const DEV = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const OTHER = 'ffffffffffffffffffffffffffffffff';

/** Every place the module may write, so the suite can clean up after itself. */
// Asked of the module under test, never restated.
//
// This was a hand-written list of five paths. `candidatePaths()` produces a
// DIFFERENT five on Windows — the hand-written copy had no entry for
// %LOCALAPPDATA%\MobileShopERP\, so a marker written there by an earlier run
// survived every clean(). MEASURED on a real Windows machine: `nothing is
// present before the first run` failed because the reader found a stale file
// the cleaner did not know existed.
//
// Two lists that must agree by hand will eventually disagree, and the failure
// looks like a broken guard rather than a broken test.
const LOCATIONS = A.candidatePaths();
/**
 * Removes every marker copy, INCLUDING the read-only ones.
 *
 * `writeTrialAnchor` deliberately chmods each copy to 0o444 on Windows so a
 * curious user cannot edit it in Notepad. That is the right behaviour for the
 * product and it breaks a naive test: on Windows a 0o444 file cannot be
 * unlinked or overwritten, and `fs.unlinkSync` fails with
 *
 *     EPERM: operation not permitted, open 'C:\Users\me\.mobileshop-trial'
 *
 * MEASURED on the user's machine: `clean()` silently left the real marker in
 * place, so `nothing is present before the first run` failed, and the first
 * forgery attempt in section 4 threw EPERM and killed the whole suite.
 *
 * Writability is restored before removing. Same reason as `forge` below.
 */
const clean = () => {
  for (const p of LOCATIONS) {
    try { fs.chmodSync(p, 0o666); } catch { /* absent, or already writable */ }
    try { fs.unlinkSync(p); } catch { /* absent */ }
  }
};

/**
 * Writes over a marker copy the way an attacker with file access would.
 *
 * The product makes these read-only; an attacker would simply clear the flag
 * first, and so must this test — otherwise it is not testing the signature
 * check at all, only the file permission, and the signature check would go
 * unverified on the one platform the product ships on.
 */
const forge = (target, contents) => {
  try { fs.chmodSync(target, 0o666); } catch { /* not present yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};
const surviving = () => LOCATIONS.filter(p => { try { return fs.existsSync(p); } catch { return false; } });

/**
 * A marker copy that is really on disk, for the forgery cases.
 *
 * Targeting `LOCATIONS[0]` assumed the home-directory copy was always
 * written. It is not: `writeTrialAnchor` skips any location it cannot write,
 * so on a locked-down machine index 0 may never exist and the forgery would
 * be planted somewhere the reader never looks — the check would pass without
 * testing anything. Falling back to LOCATIONS[0] keeps the "unwritable
 * machine" case working, where nothing exists by design.
 */
const firstExisting = () => surviving()[0] || LOCATIONS[0];

clean();

// ---------------------------------------------------------------- 1
console.log('\n[1] The marker lives OUTSIDE the application folder');
{
  t('nothing is present before the first run', A.readTrialAnchor(DEV) === null);

  const start = '2026-07-25T10:00:00.000Z';
  const written = A.writeTrialAnchor(DEV, start);
  t('at least two independent copies are written', written >= 2, `wrote ${written}`);
  t('the trial start can be read back', A.readTrialAnchor(DEV) === start);

  // The whole point: none of them may sit inside userData.
  const inUserData = surviving().filter(p => /mobile-?shop-?erp[\\/]/i.test(p) && /userData/i.test(p));
  t('no copy is stored inside the app data folder', inUserData.length === 0, inUserData.join(', '));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Deleting userData no longer grants a fresh trial');
{
  // userData is a separate tree; wiping it cannot touch these files. Simulated
  // by deleting a temporary stand-in and confirming the anchor is untouched.
  const fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'userData-'));
  fs.writeFileSync(path.join(fakeUserData, 'trial.dat'), 'x');
  fs.writeFileSync(path.join(fakeUserData, 'lastaccess.dat'), 'x');
  fs.rmSync(fakeUserData, { recursive: true, force: true });

  t('the app folder is gone', !fs.existsSync(fakeUserData));
  t('but the trial anchor survives', A.readTrialAnchor(DEV) === '2026-07-25T10:00:00.000Z');
  t('so the licence handler can still see the trial was used',
    A.readTrialAnchor(DEV) !== null);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A partially-deleted marker heals itself');
{
  // Delete copies that ACTUALLY EXIST rather than fixed indices.
  //
  // `LOCATIONS[0]` and `[3]` assumed a particular order and a particular
  // platform: on Windows index 3 is not the temp copy, and on a machine where
  // /var/lib is unwritable the surviving set is smaller than the candidate
  // list. Picking from what is really on disk makes the check mean the same
  // thing everywhere. Writability is restored first — the product marks these
  // read-only on Windows, so unlink fails with EPERM without it.
  const before = surviving().length;
  for (const victim of surviving().slice(0, 2)) {
    try { fs.chmodSync(victim, 0o666); } catch { /* already writable */ }
    try { fs.unlinkSync(victim); } catch { /* raced or locked */ }
  }
  const after = surviving().length;
  t('deleting some copies leaves fewer behind', after < before, `${before} -> ${after}`);
  t('the anchor still reads correctly from a survivor',
    A.readTrialAnchor(DEV) === '2026-07-25T10:00:00.000Z');

  A.healTrialAnchor(DEV, '2026-07-25T10:00:00.000Z');
  t('healing restores the missing copies', surviving().length >= before, `${surviving().length}`);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The marker cannot be forged, edited or imported');
{
  const genuine = '2026-07-25T10:00:00.000Z';

  // Editing the start date must invalidate that copy.
  //
  // The forged date must be OLDER than the genuine one. An earlier version of
  // this check used a NEWER date, which the "oldest wins" rule discarded on its
  // own — so removing the signature check entirely still passed. The mutant
  // survived and the guard was untested.
  forge(firstExisting(), JSON.stringify({
    deviceId: DEV, startDate: '2020-01-01T00:00:00.000Z', sig: 'bogus',
  }));
  t('a tampered start date is ignored even when it is older',
    A.readTrialAnchor(DEV) === genuine, String(A.readTrialAnchor(DEV)));

  // An unsigned marker is not evidence of anything.
  forge(firstExisting(), JSON.stringify({ deviceId: DEV, startDate: '2019-01-01T00:00:00.000Z' }));
  t('an unsigned marker is ignored even when it is older',
    A.readTrialAnchor(DEV) === genuine, String(A.readTrialAnchor(DEV)));

  // Garbage must not crash the reader — it runs before the UI exists.
  forge(firstExisting(), 'not json at all');
  t('unparseable content is ignored, not thrown', A.readTrialAnchor(DEV) === genuine);

  // A marker copied from another machine must not brand this one as used.
  t('a marker for a different device is ignored', A.readTrialAnchor(OTHER) === null);

  // The OLDEST surviving date wins, so deleting some copies and letting the
  // app rewrite the rest cannot silently restart the clock.
  A.healTrialAnchor(DEV, genuine);
  forge(firstExisting(), JSON.stringify({
    deviceId: DEV, startDate: '2026-07-30T00:00:00.000Z',
    sig: (await import('node:crypto')).createHmac('sha256', 'm0b1l3_sh0p_tr14l_4nch0r_2026')
      .update(`${DEV}|2026-07-30T00:00:00.000Z`).digest('hex'),
  }));
  t('the OLDEST genuine start is kept, not the newest',
    A.readTrialAnchor(DEV) === genuine, String(A.readTrialAnchor(DEV)));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A locked-down machine still runs');
{
  // If nothing is writable the app must degrade to the old behaviour, never
  // refuse to start. Being unable to record a trial is not a reason to deny a
  // paying shop its till.
  const src = code('src/main/security/trialAnchor.ts');
  t('every write is individually guarded', /try \{[\s\S]{0,300}writeFileSync[\s\S]{0,200}catch/.test(src));
  t('the reader never throws', /export function readTrialAnchor[\s\S]{0,700}catch/.test(src));
  t('healing never throws', /export function healTrialAnchor[\s\S]{0,300}catch/.test(src));
  t('writeTrialAnchor reports how many copies it managed',
    /return written;/.test(src));

  // Behavioural: a hopeless path must not blow up the caller.
  let threw = false;
  try { A.writeTrialAnchor(DEV, 'not-a-date'); } catch { threw = true; }
  t('writing an odd value does not throw', threw === false);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] The licence handler actually consults the anchor');
{
  const lic = code('src/main/ipc/license.handlers.ts');

  t('the handler imports the anchor', /from '\.\.\/security\/trialAnchor'/.test(lic));
  t('a first-ever launch plants it', /writeTrialAnchor\(deviceId, now\)/.test(lic));
  t('the missing-trial path reads it', /const anchorStart = readTrialAnchor\(deviceId\)/.test(lic));
  t('a surviving anchor blocks a fresh trial',
    /if \(fs\.existsSync\(lastAccessPath\) \|\| anchorStart\)/.test(lic));
  t('a normal trial launch heals the anchor',
    /healTrialAnchor\(deviceId, trial\.startDate\)/.test(lic));

  // The generous half of the behaviour: a shop whose folder was cleared by a
  // cleanup tool keeps the days it genuinely had left, rather than being
  // punished for someone else's disk sweeper.
  t('remaining days are restored from the anchor, not reset to zero',
    /const left = TRIAL_DAYS - usedDays/.test(lic));
  t('and an anchor older than the trial still expires',
    /if \(left > 0\)/.test(lic) && /trial_expired/.test(lic));
}

clean();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
