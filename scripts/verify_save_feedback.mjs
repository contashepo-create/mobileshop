#!/usr/bin/env node
/**
 * A SAVE THAT FAILS MUST NOT SAY IT SUCCEEDED.
 *
 * THE DEFECT
 * ----------
 * The shop reported that the logo would not save. It was not the picker, the
 * data URL, the settings table or the invoice — all of those were measured and
 * all of them work. It was the reply:
 *
 *     await window.api.invoke('settings:setMany', { ... });
 *     showToast('success', 'تم حفظ إعدادات الطباعة');
 *
 * `settings:setMany` is permission-gated behind `settings.edit`, and the IPC
 * guard does NOT throw when it refuses a call. It returns
 * `{ success: false, message, code }`. A `try/catch` never fires, the reply is
 * discarded, and the success toast is shown unconditionally. The shop presses
 * حفظ, is told the settings were saved, and nothing was written — with no
 * error anywhere to explain it.
 *
 * WHY THE EARLIER SUITE MISSED IT
 * -------------------------------
 * verify_logo_branding tested that the logo RENDERS: the picker sniffs bytes
 * correctly, the invoice emits an <img>, the letterhead carries it. Every one
 * of those checks passes on a build where saving is completely broken, because
 * they all start from a settings object handed to them by the test. Nothing
 * exercised the write path, and no suite in the project referenced
 * `settings:setMany` at all.
 *
 * Rendering and persistence are different claims. Proving one says nothing
 * about the other.
 *
 * WHAT IS PROVEN HERE
 *   [1] the guard's refusal really is a returned value, not a throw
 *   [2] no screen reports success without inspecting the reply
 *   [3] the settings screens verify the logo actually landed
 *   [4] a screen that inspects a reply also imports the helper it uses
 *   [5] a tab writes only the keys it owns
 *
 * Run with:  node --experimental-strip-types scripts/verify_save_feedback.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('SAVE FEEDBACK — A FAILED WRITE MUST NOT REPORT SUCCESS');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] The guard refuses by RETURNING, so try/catch cannot see it');
{
  const g = raw('src/main/security/ipcGuard.ts');
  t('a refusal is returned as a value, not thrown',
    /return \{ success: false, message: err\.message, code: err\.code \}/.test(g));
  t('an unauthenticated caller is refused',
    /UNAUTHENTICATED/.test(g) && /throw new IpcAuthError/.test(g));
  t('settings:setMany is permission-gated',
    /'settings:setMany': 'settings\.edit'/.test(raw('src/main/security/ipcGuard.ts')));

  // The renderer's own contract helper already knew this shape existed.
  const ipc = raw('src/renderer/src/lib/ipc.ts');
  t('the renderer has a helper for exactly this shape',
    /export function isFailure/.test(ipc) && /success === false/.test(ipc));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] No screen reports success without inspecting the reply');
{
  // Walk every page and find `await window.api.invoke(...)` whose result is
  // discarded but which is followed by a success toast. Read-only channels are
  // excluded: nothing is being persisted, so there is nothing to confirm.
  const READ_ONLY = /:(list|get|getAll|getActive|status|session|search|report)$/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!entry.endsWith('.tsx')) continue;
      const lines = readFileSync(p, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const m = /^\s*await window\.api\.invoke\(\s*['"]([^'"]+)['"]/.exec(line);
        if (!m || READ_ONLY.test(m[1])) return;

        // The check must be BETWEEN this call and the success toast, not
        // merely somewhere nearby. A fixed lookahead window is not enough:
        // in an if/else where each branch saves, removing the guard from one
        // branch still left the sibling branch's `reply` inside the window,
        // and a mutant doing exactly that survived. So: find the first
        // success toast that follows, and require an inspection strictly
        // before it.
        let toastAt = -1;
        for (let j = i; j < Math.min(lines.length, i + 20); j++) {
          if (/showToast\(\s*['"]success/.test(lines[j])) { toastAt = j; break; }
          // A new await into a different call ends this statement's scope.
          if (j > i && /^\s*(const \w+ = )?await window\.api\.invoke\(/.test(lines[j])) break;
        }
        if (toastAt === -1) return;
        const between = lines.slice(i, toastAt).join('\n');
        if (!/\b(isFailure|failureMessage)\s*\(/.test(between)) {
          offenders.push(`${relative(ROOT, p).replace('src/renderer/src/', '')}:${i + 1} ${m[1]}`);
        }
      });
    }
  };
  walk(join(ROOT, 'src/renderer/src/pages'));
  t('every persisting write checks its reply before claiming success',
    offenders.length === 0, offenders.slice(0, 5).join(' | '));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The settings screens confirm the write landed');
{
  const ps = raw('src/renderer/src/pages/settings/PrintSettings.tsx');
  t('PrintSettings inspects the setMany reply',
    /const reply = await window\.api\.invoke\('settings:setMany'/.test(ps)
    && /if \(isFailure\(reply\)\)/.test(ps));
  t('it reports the failure instead of a success toast',
    /showToast\('error', failureMessage\(reply, 'تعذّر حفظ إعدادات الطباعة'\)\)/.test(ps));

  // A logo is the one setting large enough that "accepted" and "stored" can
  // diverge, and the shop would otherwise discover it on a printed invoice.
  t('it reads the settings back and confirms the logo is there',
    /const after = await window\.api\.invoke\('settings:getAll'\)/.test(ps)
    && /after\?\.logo_path \|\| ''\) !== logoPath/.test(ps));
  t('and says so plainly when it is not',
    /لم يُحفظ الشعار/.test(ps));

  const gs = raw('src/renderer/src/pages/settings/GeneralSettings.tsx');
  t('GeneralSettings inspects its reply too',
    /const reply = await window\.api\.invoke\('settings:setMany'/.test(gs)
    && /if \(isFailure\(reply\)\)/.test(gs));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Every screen that uses the helpers imports them');
{
  // Calling isFailure without importing it is a ReferenceError at runtime, and
  // the screen dies the moment the user presses Save. This happened while
  // fixing the above: four files were patched to call the helper and the
  // import was not added, because the edit script matched on a condition that
  // silently skipped them.
  const missing = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!entry.endsWith('.tsx')) continue;
      const s = readFileSync(p, 'utf-8');
      const uses = /\bisFailure\(|\bfailureMessage\(/.test(s);
      const imports = /from '[^']*lib\/ipc'/.test(s);
      if (uses && !imports) missing.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'src/renderer/src'));
  t('no screen calls isFailure/failureMessage without importing them',
    missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] A settings tab writes only the keys it owns');
{
  const gs = raw('src/renderer/src/pages/settings/GeneralSettings.tsx');
  // It used to post back the whole object from `settings:getAll`. That object
  // is not just the shop's rows — the handler layers the developer's REMOTE
  // overrides on top before returning — so saving it burned those overrides
  // into the shop's own table and rewrote keys owned by other tabs.
  t('GeneralSettings sends an explicit key list',
    /const OWNED = \[/.test(gs) && /for \(const key of OWNED\)/.test(gs));
  t('it no longer posts the whole settings object back',
    !/invoke\('settings:setMany', settings\)/.test(gs));
  t('the list covers the fields the form actually edits', (() => {
    const owned = /const OWNED = \[([\s\S]*?)\];/.exec(gs)?.[1] || '';
    const edited = [...gs.matchAll(/handleChange\('([a-z_]+)'/g)].map((m) => m[1]);
    return [...new Set(edited)].every((k) => owned.includes(`'${k}'`));
  })());

  const ps = raw('src/renderer/src/pages/settings/PrintSettings.tsx');
  t('PrintSettings writes only known per-document keys',
    /profileKeys\(docType\)/.test(ps) && !/\.\.\.rawSettings/.test(ps));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
