#!/usr/bin/env node
/**
 * THE PAGE-WIDE SAVE BUTTON BELONGS AT THE TOP.
 *
 * THE PROBLEM
 * -----------
 * Three settings pages commit their entire contents with a single button, and
 * every one of them put that button at the very bottom of the page:
 *
 *     PrintSettings         line 539 of 544   (99% down)
 *     NotificationSettings  line 478 of 485   (98% down)
 *     GeneralSettings       line 234 of 371   (63% down)
 *
 * PrintSettings is the clearest case. It carries the logo picker, the layout
 * controls, the column list and a per-document panel covering six document
 * types. Changing the paper size for a purchase invoice means scrolling past
 * every other section to reach the button, and while the work is being done
 * the control is off-screen entirely — so nothing on the page indicates that
 * anything is still unsaved.
 *
 * WHAT WAS DONE
 * -------------
 * One shared `SettingsHeader`, placed as the first element of each page and
 * made sticky, so it stays reachable from any scroll position. It also shows
 * an explicit "تغييرات غير محفوظة" marker, which a bottom button cannot do:
 * the state and the control now sit in the same place.
 *
 * The bottom bar is REMOVED, not duplicated. Two buttons doing the same thing
 * raise the question of whether they really do.
 *
 * WHAT IS NOT MOVED, AND WHY
 *   - `GeneralSettings` "تصفير قاعدة البيانات" stays at the foot. It is
 *     destructive and used once in the life of a shop; putting it next to a
 *     button pressed constantly is how a misclick wipes a database.
 *   - `DatabaseManagementPage` and `BackupPage` have SECTION-scoped buttons
 *     sitting beside the fields they commit. Those are already in the right
 *     place and are deliberately left alone.
 *
 * WHAT IS PROVEN HERE
 *   [1] the shared header exists and behaves
 *   [2] each page renders it as the FIRST element of its tree
 *   [3] no page-wide save button is left at the bottom
 *   [4] the dirty marker is wired to real state, and cleared only on success
 *   [5] the destructive action did NOT move next to save
 *   [6] no page imports an icon it no longer uses
 *
 * Run with:  node --experimental-strip-types scripts/verify_settings_header.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('SETTINGS PAGES — SAVE ACTION AT THE TOP');
console.log('='.repeat(72));

/** The pages whose single button commits the WHOLE page. */
const PAGES = [
  ['GeneralSettings', 'src/renderer/src/pages/settings/GeneralSettings.tsx'],
  ['PrintSettings', 'src/renderer/src/pages/settings/PrintSettings.tsx'],
  ['NotificationSettings', 'src/renderer/src/pages/settings/NotificationSettings.tsx'],
];

// ---------------------------------------------------------------- 1
console.log('\n[1] The shared header exists and behaves');
{
  const h = raw('src/renderer/src/components/shared/SettingsHeader.tsx');
  t('it is sticky, so it stays reachable on a long page', /sticky top-0/.test(h));
  t('it renders the save button', /onClick=\{onSave\}/.test(h));
  t('it shows a spinner while saving', /loading=\{saving\}/.test(h));
  t('it shows an unsaved-changes marker', /تغييرات غير محفوظة/.test(h));

  // `dirty` is optional. A page that cannot cheaply tell leaves it undefined
  // and the button must stay usable — disabling it would make the page
  // unsavable, which is far worse than an always-enabled button.
  t('only an explicit false disables the button',
    /const nothingToSave = dirty === false;/.test(h));
  t('the marker appears only on an explicit true',
    /\{dirty === true &&/.test(h));
  t('it accepts extra actions beside save', /\{children\}/.test(h));
}

// ---------------------------------------------------------------- 2 & 3
console.log('\n[2] Each page renders it FIRST, and nothing is left at the bottom');
for (const [name, file] of PAGES) {
  const s = raw(file);
  const lines = s.split(/\r?\n/);

  t(`${name} imports the shared header`,
    /import \{ SettingsHeader \} from '[^']*shared\/SettingsHeader'/.test(s));
  // Importing is not rendering. Matched as an exact element so a renamed or
  // mistyped component (<SettingsHeaderX>) fails instead of slipping through
  // a substring test — a mutant doing exactly that survived.
  t(`${name} actually renders <SettingsHeader>`, /<SettingsHeader(?![A-Za-z0-9_])/.test(s));

  // The header must be the first child of the page's own returned tree. Found
  // by locating the LAST `return (` in the file — sub-components defined above
  // the page component have their own, and matching the first one reports a
  // false position.
  const returns = lines
    .map((l, i) => (/^\s{2}return \($/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  const pageReturn = returns[returns.length - 1];
  const headerAt = lines.findIndex((l) => /<SettingsHeader(?![A-Za-z0-9_])/.test(l));
  t(`${name} puts the header at the top of its own tree`,
    headerAt > pageReturn && headerAt - pageReturn <= 3,
    `return@${pageReturn + 1} header@${headerAt + 1}`);

  // No page-wide save button may remain anywhere else.
  const strays = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /onClick=\{(handleSave|save)\}/.test(l));
  t(`${name} has no leftover page-wide save button`,
    strays.length === 0, strays.map(([n]) => `line ${n}`).join(', '));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The unsaved marker reflects real state');
for (const [name, file] of PAGES) {
  const s = raw(file);
  t(`${name} computes a dirty flag`, /const dirty = /.test(s));
  t(`${name} passes it to the header`, /dirty=\{dirty\}/.test(s));
  // A baseline captured before the data arrives makes the page open already
  // claiming changes; one that is never refreshed leaves the marker stuck on
  // after a successful save.
  t(`${name} takes a baseline when the data loads`, /setBaseline\(/.test(s));
  // The re-baseline must sit immediately before the success toast: doing it
  // earlier (or unconditionally) would tell the shop its changes are stored
  // while the write was still in flight or had already been refused.
  //
  // Matched by LINE POSITION rather than by a whitespace-sensitive pattern —
  // the three pages indent this differently, and an over-strict regex failed
  // on code that was correct.
  const ls = s.split(/\r?\n/);
  const toastLines = ls
    .map((l, i) => (/showToast\(\s*'success'/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  const rebaselined = toastLines.some((ti) =>
    ls.slice(Math.max(0, ti - 3), ti).some((l) => /setBaseline\(/.test(l)));
  t(`${name} clears the marker only after a successful save`, rebaselined);

  // And never on the failure path.
  const failureBlocks = [...s.matchAll(/isFailure\([^)]*\)\)\s*\{([\s\S]{0,220}?)\}/g)];
  t(`${name} does not clear it when the save is refused`,
    failureBlocks.every((m) => !/setBaseline\(/.test(m[1])));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The destructive action did not move next to save');
{
  const g = raw('src/renderer/src/pages/settings/GeneralSettings.tsx');
  const lines = g.split(/\r?\n/);
  const resetAt = lines.findIndex((l) => l.includes('تصفير قاعدة البيانات'));
  const headerAt = lines.findIndex((l) => /<SettingsHeader(?![A-Za-z0-9_])/.test(l));
  t('the database reset is still far below the header',
    resetAt > headerAt + 50, `header@${headerAt + 1} reset@${resetAt + 1}`);
  t('and it is not passed into the header as a child action',
    !/<SettingsHeader[\s\S]{0,400}تصفير قاعدة البيانات/.test(g));

  // The notifications page DOES belong beside save: restoring defaults is
  // routine and non-destructive to the shop's books.
  const n = raw('src/renderer/src/pages/settings/NotificationSettings.tsx');
  t('restoring notification defaults sits beside save, which is correct',
    /<SettingsHeader[\s\S]{0,400}استعادة الافتراضي[\s\S]{0,200}<\/SettingsHeader>/.test(n));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] No page imports an icon it no longer uses');
for (const [name, file] of PAGES) {
  const s = raw(file);
  const importsSave = /import \{[^}]*\bSave\b[^}]*\} from 'lucide-react'/.test(s)
    || /^\s*Save,/m.test(s);
  // `<Save ... />` as JSX, not the word inside `handleSave` or `onSave`.
  const usesSave = /<Save[\s/>]/.test(s);
  t(`${name} has no dead Save icon import`, !importsSave || usesSave,
    importsSave ? 'imported but never rendered' : '');
}

// Pages that were correctly left alone.
console.log('\n[7] Section-scoped buttons were left where they belong');
{
  const db = raw('src/renderer/src/pages/settings/DatabaseManagementPage.tsx');
  t('DatabaseManagementPage keeps its cloud button beside the cloud fields',
    /handleSaveCloud/.test(db) && !/SettingsHeader/.test(db));
  const bp = raw('src/renderer/src/pages/settings/BackupPage.tsx');
  t('BackupPage keeps its Telegram button beside the Telegram fields',
    /handleTgSave/.test(bp) && !/SettingsHeader/.test(bp));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
