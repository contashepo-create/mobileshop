#!/usr/bin/env node
/**
 * THE SIDEBAR: EVERY SCREEN IS REACHABLE, AND STAYS REACHABLE.
 *
 * WHAT WENT WRONG
 * ---------------
 * The menu was described in FOUR places that each had to agree with the other
 * three, and nothing checked that they did:
 *
 *   1. `sidebar.store.ts` `defaultMainOrder` / `defaultChildrenOrder`
 *   2. `Sidebar.tsx` `defaultItems`          — the icons and labels DRAWN
 *   3. `SidebarSettings.tsx` `defaultSections` — what the user may reorder
 *   4. `sidebar.store.ts` `getDisplayLabel`  — a fourth copy of the names
 *
 * When the accounting section was split into five, only (1) was updated. (2)
 * still described one "الحسابات", recognised none of the five, and its
 * `if (!item) continue;` skipped every one of them. Result: ELEVEN screens
 * left the program in a single commit, in silence, while the settings page
 * still listed them as present. `/accounting/rent-parties` had shipped two
 * commits earlier with the same fault and had never once been reachable.
 *
 * WHY THE OLD SUITE MISSED IT
 * ---------------------------
 * `verify_sidebar_sections.mjs` read `defaultChildrenOrder` out of the store
 * with a regular expression and asserted the five were in it. They were. It
 * never executed `buildOrderedMenu`, so it proved the CONFIGURATION and not
 * the SIDEBAR — the exact difference the bug lived in. A test that reads the
 * input and never runs the code cannot see the code.
 *
 * So this suite BUILDS the real modules with esbuild and CALLS them. Every
 * claim below is the shipped function's own output.
 *
 * WHAT IS PROVEN
 *   [1] one catalogue: no file restates the menu
 *   [2] every route in App.tsx is accounted for, and every menu path routes
 *     [3] the default layout is the order that was asked for, and it DRAWS
 *   [4] a saved layout is upgraded and completed, never truncated
 *   [5] a screen can never go missing again — including deleting its folder
 *   [6] hostile or corrupt localStorage cannot empty the sidebar
 *   [7] the shop can still reorder, rename, move and reset
 *
 * Run:  node --experimental-strip-types scripts/verify_sidebar_nav.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require_ = createRequire(join(ROOT, 'package.json'));

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('SIDEBAR — EVERY SCREEN REACHABLE');
console.log('='.repeat(72));

// ---------------------------------------------------------------------------
// Build the real modules. Only third-party libraries are stubbed; every line
// of navCatalog.ts, sidebar.store.ts and Sidebar.tsx below is the shipped one.
// ---------------------------------------------------------------------------
const PROBE = join(ROOT, 'node_modules', '.nav-probe');

/**
 * The icon names come from the REAL lucide-react when it is installed.
 * Inventing the list here would let the suite accept an icon the library does
 * not have — the build would then fail on a name this file had blessed.
 */
let LUCIDE_NAMES = null;
try {
  LUCIDE_NAMES = Object.keys(require_('lucide-react')).filter((k) => /^[A-Z]/.test(k));
} catch { /* not installed in this checkout; fall back below */ }

async function buildBundle() {
  const { build } = await import('esbuild');
  const iconNames = LUCIDE_NAMES;
  const stub = {
    name: 'stub',
    setup(b) {
      b.onResolve(
        { filter: /^(react|react\/jsx-runtime|react-dom|react-router-dom|lucide-react|zustand)$/ },
        (a) => ({ path: a.path, namespace: 'navstub' }),
      );
      b.onLoad({ filter: /.*/, namespace: 'navstub' }, (a) => {
        if (a.path === 'lucide-react') {
          // A Proxy is NOT good enough: esbuild's __toESM copies own
          // enumerable keys, and a Proxy over {} reports none, so every icon
          // becomes undefined and the suite silently stops checking icons.
          return {
            contents: iconNames
              ? `const names = ${JSON.stringify(iconNames)};
                 const out = { __esModule: true };
                 for (const n of names) { const f = () => null; f.iconName = n; out[n] = f; }
                 module.exports = out;`
              : `module.exports = new Proxy({ __esModule: true }, {
                   get: (t, p) => t[p] ?? Object.assign(() => null, { iconName: String(p) }),
                   has: () => true,
                   ownKeys: () => ['__esModule'],
                 });`,
            loader: 'js',
          };
        }
        if (a.path === 'react') {
          return { contents: `module.exports = { __esModule: true,
            useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
            useEffect: () => {} };`, loader: 'js' };
        }
        if (a.path === 'react/jsx-runtime') {
          return { contents: `module.exports = { __esModule: true,
            jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }), Fragment: 'F' };`, loader: 'js' };
        }
        if (a.path === 'react-router-dom') {
          return { contents: `module.exports = { __esModule: true, NavLink: () => null };`, loader: 'js' };
        }
        if (a.path === 'zustand') {
          return { contents: `function create(fn) {
              let state;
              const set = (p) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; };
              const get = () => state;
              state = fn(set, get);
              const hook = () => state;
              hook.getState = get; hook.setState = set;
              return hook;
            }
            module.exports = { create, __esModule: true };`, loader: 'js' };
        }
        return { contents: 'module.exports = {};', loader: 'js' };
      });
    },
  };

  const entry = `
    export * from './src/renderer/src/components/layout/Sidebar.tsx';
    export * as store from './src/renderer/src/stores/sidebar.store.ts';
    export * as cat from './src/renderer/src/lib/navCatalog.ts';
  `;
  const out = await build({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'nav-entry.ts', loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [stub], logLevel: 'silent',
  });
  mkdirSync(PROBE, { recursive: true });
  const file = join(PROBE, 'nav.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  return file;
}

const BUNDLE = await buildBundle();

/** Loads the modules fresh against a given localStorage. */
function load(seed) {
  globalThis.localStorage = {
    store: seed ? { ...seed } : {},
    getItem(k) { return this.store[k] ?? null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; },
  };
  delete require_.cache?.[BUNDLE];
  const req = createRequire(join(PROBE, 'x.cjs'));
  delete req.cache[BUNDLE];
  return req(BUNDLE);
}

/** Everything the shop can actually click, as drawn. */
function drawn(m, config) {
  const { menu } = m.buildOrderedMenu(config);
  return new Set([
    ...menu.filter((x) => x.path).map((x) => x.path),
    ...menu.flatMap((s) => (s.children || []).map((c) => c.path)),
  ]);
}

// ------------------------------------------------------------------ 1
console.log('\n[1] One catalogue — nothing restates the menu');
{
  const store = raw('src/renderer/src/stores/sidebar.store.ts');
  const side = raw('src/renderer/src/components/layout/Sidebar.tsx');
  const set = raw('src/renderer/src/pages/settings/SidebarSettings.tsx');

  for (const [file, src] of [
    ['sidebar.store.ts', store],
    ['Sidebar.tsx', side],
    ['SidebarSettings.tsx', set],
  ]) {
    t(`${file} reads navCatalog`, /from '.*navCatalog'/.test(src));
  }

  // The duplicated tables, by the names they had. Any of them coming back
  // re-creates the exact failure: two lists, one updated.
  t('Sidebar.tsx no longer keeps its own defaultItems',
    !/const defaultItems\s*:/.test(side));
  t('Sidebar.tsx no longer keeps its own standaloneMeta',
    !/const standaloneMeta\s*:/.test(side));
  t('SidebarSettings.tsx no longer hardcodes its section list',
    !/const defaultSections[^=]*=\s*\[/.test(set));
  t('getDisplayLabel no longer keeps a fourth copy of the names',
    !/const childCatalog\s*:/.test(store));

  // The section labels must exist in exactly ONE source file.
  const marker = 'السندات والرواتب والإيجارات';
  const holders = [
    ['navCatalog.ts', raw('src/renderer/src/lib/navCatalog.ts')],
    ['Sidebar.tsx', side],
    ['SidebarSettings.tsx', set],
  ].filter(([, src]) => src.includes(marker)).map(([f]) => f);
  t('a section name is written in one file only', holders.length === 1, holders.join(', '));
}

// ------------------------------------------------------------------ 2
console.log('\n[2] Routes and menu agree, in both directions');
{
  const m = load();
  const app = raw('src/renderer/src/App.tsx');
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((x) => x[1]).filter((p) => p !== '*');
  const norm = (p) => (p.startsWith('/') ? p : '/' + p);

  const known = new Set([
    ...m.cat.NAV_DESTINATIONS.map((d) => d.path),
    ...m.cat.NAV_ALIASES.map((a) => a.path),
    ...m.cat.NAV_OUTSIDE_SHELL,
  ]);

  // A route nobody lists is a screen that was built and then lost. The whole
  // point of this file is that the loss cannot be quiet.
  const orphanRoutes = routes.map(norm).filter((p) => p !== '/' && !known.has(p));
  t('every route is accounted for in the catalogue',
    orphanRoutes.length === 0,
    orphanRoutes.join(', ') + '  — add it to NAV_DESTINATIONS or NAV_ALIASES');

  // And the reverse: a menu entry with no route renders a blank page, which
  // looks more broken than a missing entry.
  const routeSet = new Set(routes.map(norm));
  const deadLinks = m.cat.NAV_DESTINATIONS
    .filter((d) => d.path !== '/' && !routeSet.has(d.path)).map((d) => d.path);
  t('every menu destination has a route', deadLinks.length === 0, deadLinks.join(', '));

  const deadAliases = m.cat.NAV_ALIASES.filter((a) => !routeSet.has(a.path)).map((a) => a.path);
  t('every alias still refers to a real route', deadAliases.length === 0, deadAliases.join(', '));

  // The migration needs somewhere to put each retired screen. A new alias with
  // no home would be dropped during the split — quietly, which is the fault
  // this whole file exists to prevent.
  const store = raw('src/renderer/src/stores/sidebar.store.ts');
  const homesBlock = /const RETIRED_SCREEN_HOMES: Record<string, string> = \{([\s\S]*?)\r?\n\};/.exec(store);
  const homes = homesBlock
    ? [...homesBlock[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)':\s*'([^']+)'/g)]
        .map((x) => [x[1], x[2]])
    : [];
  const homeMap = Object.fromEntries(homes);
  const unhoused = m.cat.NAV_ALIASES.filter((a) => !homeMap[a.path]).map((a) => a.path);
  t('every retired screen has somewhere to go when its section is split',
    unhoused.length === 0, unhoused.join(', ') + '  — add it to RETIRED_SCREEN_HOMES');
  const sectionNames = new Set(m.cat.NAV_SECTIONS.map((s) => s.label));
  const badHomes = homes.filter(([, dest]) => !sectionNames.has(dest)).map(([p, d]) => `${p}→${d}`);
  t('and that destination is a section that exists', badHomes.length === 0, badHomes.join(', '));

  // Each screen once. Listed twice, it draws twice and one copy is dead.
  const seen = new Set(); const dupes = [];
  for (const d of m.cat.NAV_DESTINATIONS) {
    if (seen.has(d.path)) dupes.push(d.path);
    seen.add(d.path);
  }
  t('no destination is listed twice', dupes.length === 0, dupes.join(', '));

  // Every icon must be a real component, or the screen crashes on render.
  const badIcons = m.cat.NAV_DESTINATIONS
    .filter((d) => typeof d.icon !== 'function').map((d) => d.path);
  t('every destination has a usable icon', badIcons.length === 0, badIcons.join(', '));
  const badSectionIcons = m.cat.NAV_SECTIONS
    .filter((s) => typeof s.icon !== 'function').map((s) => s.label);
  t('every section has a usable icon', badSectionIcons.length === 0, badSectionIcons.join(', '));

  // A destination filed under a section that does not exist is unreachable.
  const sections = new Set(m.cat.NAV_SECTIONS.map((s) => s.label));
  const homeless = m.cat.NAV_DESTINATIONS
    .filter((d) => d.section !== null && !sections.has(d.section)).map((d) => d.path);
  t('every destination belongs to a section that exists', homeless.length === 0, homeless.join(', '));
}

// ------------------------------------------------------------------ 3
console.log('\n[3] The default layout is the one asked for — and it DRAWS');
{
  const m = load();
  const cfg = m.store.useSidebarStore.getState().config;
  const { menu, unplaceable } = m.buildOrderedMenu(cfg);
  const labels = menu.map((x) => x.label);

  const wanted = [
    'لوحة التحكم',
    'المبيعات',
    'المشتريات',
    'السندات والرواتب والإيجارات',
    'السنة المالية والأرصدة الافتتاحية',
    'المخازن والتسوية الجردية',
    'الموارد البشرية',
    'الأصول',
    'التقارير',
    'الإعدادات',
  ];
  // This is the assertion the old suite could not make: not "the config says
  // so" but "the sidebar drew it".
  t('the sidebar draws exactly the requested order',
    JSON.stringify(labels) === JSON.stringify(wanted), labels.join(' | '));
  t('nothing in the default layout is unplaceable',
    unplaceable.length === 0, unplaceable.join(', '));
  t('the retired catch-all is gone', !labels.includes('الحسابات'));

  const contents = Object.fromEntries(
    menu.filter((x) => x.children).map((x) => [x.label, x.children.map((c) => c.path)]),
  );
  const expect = {
    'المبيعات': ['/accounting/sales', '/accounting/services', '/accounting/maintenance'],
    'المشتريات': ['/accounting/purchases'],
    'السندات والرواتب والإيجارات': ['/accounting/vouchers-receipt', '/accounting/vouchers-payment',
      '/accounting/payroll', '/accounting/rents', '/accounting/rent-parties'],
    'السنة المالية والأرصدة الافتتاحية': ['/accounting/fiscal-year', '/accounting/opening-balances'],
    'المخازن والتسوية الجردية': ['/inventory', '/accounting/settlement'],
    'الموارد البشرية': ['/hr/employees', '/hr/customers', '/hr/suppliers'],
    'الأصول': ['/assets', '/assets/payment-methods', '/assets/transfers'],
    'التقارير': ['/reports', '/reports/customer-statement', '/reports/supplier-statement',
      '/reports/employee-statement'],
    'الإعدادات': ['/settings', '/settings/database', '/settings/license', '/settings/backup', '/about'],
  };
  for (const [section, paths] of Object.entries(expect)) {
    t(`"${section}" is drawn with exactly its screens, in order`,
      JSON.stringify(contents[section]) === JSON.stringify(paths),
      (contents[section] || []).join(', '));
  }

  // Every screen in the program appears somewhere, on a fresh install.
  const shown = drawn(m, cfg);
  const lost = m.cat.NAV_DESTINATIONS.filter((d) => !shown.has(d.path)).map((d) => d.path);
  t('a fresh install can reach every screen', lost.length === 0, lost.join(', '));

  // Labels come out named, not as raw paths.
  const unnamed = menu.flatMap((s) => (s.children || []))
    .filter((c) => !c.label || c.label === c.path).map((c) => c.path);
  t('every drawn child has a real name', unnamed.length === 0, unnamed.join(', '));

  // The component does NOT print `child.label`; it prints
  // `getDisplayLabel(child.path)`, because the shop may have renamed it. So
  // the menu having a name proves nothing on its own — the store has to
  // return one too, or the sidebar shows "/hr/customers" to the shop.
  const st = m.store.useSidebarStore.getState();
  const rawLabels = [...menu.flatMap((s) => (s.children || []).map((c) => c.path)),
    ...menu.filter((x) => x.path).map((x) => x.label)]
    .filter((key) => st.getDisplayLabel(key) === key && key.startsWith('/'));
  t('the store names every drawn path, as the component asks it to',
    rawLabels.length === 0, rawLabels.join(', '));
  t('a section keeps its own name', st.getDisplayLabel('المبيعات') === 'المبيعات');
}

// ------------------------------------------------------------------ 4
console.log('\n[4] A saved layout is upgraded and COMPLETED, never truncated');
{
  // The layout a shop running the previous version actually has on disk.
  const v1 = {
    mainOrder: ['لوحة التحكم', 'الحسابات', 'المخازن والأصناف', 'الموارد البشرية',
      'الأصول', 'التقارير', 'الإعدادات'],
    childrenOrder: {
      'الحسابات': ['/accounting/sales', '/accounting/purchases', '/accounting/maintenance',
        '/accounting/vouchers', '/accounting/payroll', '/accounting/rents', '/accounting/services',
        '/accounting/fiscal-year', '/accounting/settlement', '/accounting/opening-balances'],
    },
    hidden: [], customSections: {}, customLabels: {},
  };
  const m = load({ sidebarConfig: JSON.stringify(v1) });
  const cfg = m.store.useSidebarStore.getState().config;
  const shown = drawn(m, cfg);

  t('the retired section is gone', !cfg.mainOrder.includes('الحسابات'));
  t('inventory is not left duplicated', !cfg.mainOrder.includes('المخازن والأصناف'));

  // The shop's ordering INSIDE the retired section has to survive the split
  // too. Re-filing each screen under its new owner and dropping the sequence
  // looks correct — everything is still reachable — but the shop opens the
  // menu and finds its arrangement silently rearranged.
  const reordered = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['لوحة التحكم', 'الحسابات'],
    childrenOrder: { 'الحسابات': ['/accounting/maintenance', '/accounting/sales', '/accounting/services'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const rc = reordered.store.useSidebarStore.getState().config;
  t('the order the shop had inside الحسابات is carried over',
    rc.childrenOrder['المبيعات'][0] === '/accounting/maintenance',
    (rc.childrenOrder['المبيعات'] || []).join(','));
  t('and the rest of that section follows it',
    rc.childrenOrder['المبيعات'][1] === '/accounting/sales',
    (rc.childrenOrder['المبيعات'] || []).join(','));

  // This is the failure the user reported, stated as a test.
  const everyScreen = m.cat.NAV_DESTINATIONS.map((d) => d.path);
  const lost = everyScreen.filter((p) => !shown.has(p));
  t('an upgrading shop loses NOTHING', lost.length === 0, lost.join(', '));

  // ...including screens that did not exist when it saved its layout.
  for (const p of ['/accounting/vouchers-receipt', '/accounting/vouchers-payment',
    '/accounting/rent-parties']) {
    t(`the new screen ${p} arrives`, shown.has(p));
  }

  // A retired screen sitting in the section being split has nowhere to be
  // re-filed. Dropping it deletes a row the shop can see, along with any name
  // it gave it — the same silent loss, in a corner.
  const retired = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['لوحة التحكم', 'الحسابات'],
    childrenOrder: { 'الحسابات': ['/accounting/vouchers', '/accounting/sales'] },
    hidden: [], customSections: {}, customLabels: { '/accounting/vouchers': 'سنداتي' },
  }) });
  const rcfg = retired.store.useSidebarStore.getState().config;
  const rShown = drawn(retired, rcfg);
  t('a retired screen inside the split section is not deleted',
    rShown.has('/accounting/vouchers'));
  t('and the name the shop gave it survives',
    retired.store.useSidebarStore.getState().getDisplayLabel('/accounting/vouchers') === 'سنداتي');
  t('the migration still loses nothing else',
    retired.cat.NAV_DESTINATIONS.every((d) => rShown.has(d.path)),
    retired.cat.NAV_DESTINATIONS.filter((d) => !rShown.has(d.path)).map((d) => d.path).join(', '));

  // A screen the shop had is not moved out from under it: the old combined
  // vouchers screen is kept wherever it was filed.
  const parked = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['لوحة التحكم', 'التقارير'],
    childrenOrder: { 'التقارير': ['/accounting/vouchers'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const pc = parked.store.useSidebarStore.getState().config;
  const pd = parked.buildOrderedMenu(pc);
  const kept = pd.menu.find((x) => x.label === 'التقارير')
    ?.children.find((c) => c.path === '/accounting/vouchers');
  t('a retired screen the shop still lists keeps its place and its name',
    !!kept && kept.label === 'سندات', kept ? kept.label : 'dropped');
  t('and it is not reported as a fault', !pd.unplaceable.includes('/accounting/vouchers'));

  // The shop's own arrangement survives.
  const own = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير', 'لوحة التحكم', 'المبيعات'],
    childrenOrder: { 'المبيعات': ['/accounting/maintenance', '/accounting/sales'] },
    hidden: [], customSections: {}, customLabels: { 'المبيعات': 'البيع' },
  }) });
  const oc = own.store.useSidebarStore.getState().config;
  t('the shop keeps its own top-level order', oc.mainOrder[0] === 'التقارير', oc.mainOrder.join(' | '));
  t('the shop keeps its own order inside a section',
    oc.childrenOrder['المبيعات'].slice(0, 2).join(',') === '/accounting/maintenance,/accounting/sales',
    oc.childrenOrder['المبيعات'].join(','));
  t('a screen added later is appended, not inserted over the shop',
    oc.childrenOrder['المبيعات'].includes('/accounting/services'));
  t('a rename by the shop survives', oc.customLabels['المبيعات'] === 'البيع');
  const od = own.buildOrderedMenu(oc);
  t('and the renamed section still draws', od.menu.some((x) => x.label === 'المبيعات'));
}

// ------------------------------------------------------------------ 5
console.log('\n[5] A screen can never go missing again');
{
  // Deleting a folder used to delete the screens parked in it, permanently.
  const m = load();
  const st = m.store.useSidebarStore;
  st.getState().addCustomSection('مؤقت');
  st.getState().moveChildToSection('/hr/customers', 'الموارد البشرية', 'مؤقت');
  st.getState().moveChildToSection('/reports', 'التقارير', 'مؤقت');
  t('screens can be parked in a custom section',
    (st.getState().config.childrenOrder['مؤقت'] || []).length === 2);

  st.getState().removeCustomSection('مؤقت');
  const after = drawn(m, st.getState().config);
  t('deleting the folder does not delete العملاء', after.has('/hr/customers'));
  t('deleting the folder does not delete التقارير العامة', after.has('/reports'));
  t('the folder itself is gone', !st.getState().config.mainOrder.includes('مؤقت'));

  // An empty custom section must still be visible or it cannot be filled.
  const m2 = load();
  m2.store.useSidebarStore.getState().addCustomSection('قسمي');
  const d2 = m2.buildOrderedMenu(m2.store.useSidebarStore.getState().config);
  t('an empty custom section is still drawn', d2.menu.some((x) => x.label === 'قسمي'));

  // Emptying a default section must not silently swallow its screens.
  const m3 = load();
  const st3 = m3.store.useSidebarStore;
  for (const p of ['/hr/employees', '/hr/customers', '/hr/suppliers']) {
    st3.getState().moveChildToSection(p, 'الموارد البشرية', 'التقارير');
  }
  const d3 = drawn(m3, st3.getState().config);
  t('screens moved out of a section are still reachable',
    ['/hr/employees', '/hr/customers', '/hr/suppliers'].every((p) => d3.has(p)));

  // A path this build has never heard of is REPORTED, not skipped in silence.
  const m4 = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير'], childrenOrder: { 'التقارير': ['/made/up'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const d4 = m4.buildOrderedMenu(m4.store.useSidebarStore.getState().config);
  t('an unknown entry is reported rather than dropped quietly',
    d4.unplaceable.includes('/made/up'), d4.unplaceable.join(', '));
  t('and the rest of the menu is unaffected',
    d4.menu.find((x) => x.label === 'التقارير').children.length >= 4);
}

// ------------------------------------------------------------------ 6
console.log('\n[6] Corrupt or hostile localStorage cannot empty the sidebar');
{
  // localStorage is editable by anyone at the keyboard and survives every
  // upgrade, so it is the one input guaranteed to be wrong eventually.
  const cases = [
    ['not json at all', '{{{'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['childrenOrder is a string', '{"mainOrder":["المبيعات"],"childrenOrder":"boom"}'],
    ['a section maps to a number', '{"mainOrder":["المبيعات"],"childrenOrder":{"المبيعات":5}}'],
    ['children are objects and nulls', '{"mainOrder":["المبيعات"],"childrenOrder":{"المبيعات":[{"a":1},null,7]}}'],
    ['mainOrder holds numbers', '{"mainOrder":[1,2,"المبيعات"],"childrenOrder":{}}'],
    ['mainOrder is empty', '{"mainOrder":[],"childrenOrder":{}}'],
    ['mainOrder is not an array', '{"mainOrder":"x","childrenOrder":{}}'],
    ['a section nobody has heard of', '{"mainOrder":["قسم وهمي"],"childrenOrder":{"قسم وهمي":["/nope"]}}'],
    ['the same section twice', '{"mainOrder":["التقارير","التقارير"],"childrenOrder":{"التقارير":["/reports"]}}'],
  ];
  for (const [name, payload] of cases) {
    let ok = false, detail = '';
    try {
      const m = load({ sidebarConfig: payload });
      const cfg = m.store.useSidebarStore.getState().config;
      const { menu } = m.buildOrderedMenu(cfg);
      const shown = drawn(m, cfg);
      // Not merely "it did not throw": the shop must still be able to work.
      const core = ['/', '/accounting/sales', '/hr/customers', '/settings', '/reports'];
      ok = menu.length > 0 && core.every((p) => shown.has(p));
      detail = `${menu.length} sections drawn`;
    } catch (e) { detail = 'threw: ' + e.message; }
    t(`${name} — the sidebar still works`, ok, detail);
  }

  // Surviving corruption is not enough on its own. Throwing away the whole
  // saved layout also "survives" — the sidebar comes back full of defaults —
  // and the shop finds every arrangement it ever made silently gone. One bad
  // key must cost the shop that key and nothing else.
  const partly = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير', 'لوحة التحكم', 'المبيعات'],
    childrenOrder: {
      'المبيعات': ['/accounting/maintenance', '/accounting/sales'],
      'زائف': 5, // the corrupt one
    },
    hidden: [], customSections: {}, customLabels: { 'المبيعات': 'البيع' },
  }) });
  const pc = partly.store.useSidebarStore.getState().config;
  t('one bad key does not discard the top-level order',
    pc.mainOrder[0] === 'التقارير', pc.mainOrder.join(' | '));
  t('one bad key does not discard the order inside a section',
    pc.childrenOrder['المبيعات'][0] === '/accounting/maintenance',
    (pc.childrenOrder['المبيعات'] || []).join(','));
  t('one bad key does not discard the shop\'s renames',
    pc.customLabels['المبيعات'] === 'البيع');
  t('and the corrupt key itself is dropped',
    !Array.isArray(pc.childrenOrder['زائف']) || pc.childrenOrder['زائف'].length === 0);

  // Junk must be cleaned out of what is SAVED, not merely skipped while
  // drawing. Left in the config it is written back to localStorage on the next
  // change and listed as a row on the settings page, where it cannot be named,
  // moved or deleted.
  const junk = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير'],
    childrenOrder: { 'التقارير': [{ a: 1 }, null, 7, '', '/reports'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const jc = junk.store.useSidebarStore.getState().config;
  t('non-string children are removed from the saved layout',
    jc.childrenOrder['التقارير'].every((x) => typeof x === 'string' && x.length > 0),
    JSON.stringify(jc.childrenOrder['التقارير']));
  junk.store.useSidebarStore.getState().updateMainOrder(jc.mainOrder);
  const written = globalThis.localStorage.getItem('sidebarConfig');
  t('and junk is never written back to storage',
    !written.includes('null') && !written.includes('{"a":1'), written.slice(0, 120));

  // Duplicates must be cleaned out of what is SAVED, not merely skipped while
  // drawing. Left in the config they show twice on the settings page, where
  // "move up" then swaps a row with its own twin and appears to do nothing.
  const dup = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير'],
    childrenOrder: { 'التقارير': ['/reports', '/reports', '/reports'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const dc = dup.store.useSidebarStore.getState().config;
  t('duplicates are removed from the saved layout, not just hidden',
    dc.childrenOrder['التقارير'].filter((p) => p === '/reports').length === 1,
    dc.childrenOrder['التقارير'].join(','));

  // An empty mainOrder with content elsewhere: the layout is unusable as
  // saved, so the defaults have to take over — but a section the SHOP made
  // must not be thrown away with them.
  const empty = load({ sidebarConfig: JSON.stringify({
    mainOrder: [],
    childrenOrder: { 'مخصص': ['/reports'] },
    customSections: { 'مخصص': { label: 'مخصص' } },
    hidden: [], customLabels: {},
  }) });
  const ec = empty.store.useSidebarStore.getState().config;
  const eShown = drawn(empty, ec);
  t('an unusable mainOrder falls back to the defaults',
    ec.mainOrder.length >= empty.cat.NAV_TOP_ORDER.length, ec.mainOrder.join(' | '));
  t('and no screen is lost in the process',
    empty.cat.NAV_DESTINATIONS.every((d) => eShown.has(d.path)),
    empty.cat.NAV_DESTINATIONS.filter((d) => !eShown.has(d.path)).map((d) => d.path).join(', '));

  // A duplicated top-level name must not draw twice.
  const m = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير', 'التقارير'], childrenOrder: { 'التقارير': ['/reports'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const { menu } = m.buildOrderedMenu(m.store.useSidebarStore.getState().config);
  t('a section named twice is drawn once',
    menu.filter((x) => x.label === 'التقارير').length === 1);

  // A path repeated inside one section must not draw twice: React keys on the
  // path, so the duplicate warns and one copy is unclickable.
  const m2 = load();
  const st2 = m2.store.useSidebarStore;
  st2.getState().updateChildrenOrder('التقارير', ['/reports', '/reports', '/reports']);
  const d2 = m2.buildOrderedMenu(st2.getState().config);
  t('a path repeated in one section is drawn once',
    d2.menu.find((x) => x.label === 'التقارير').children.filter((c) => c.path === '/reports').length === 1);
}

// ------------------------------------------------------------------ 7
console.log('\n[7] The shop can still arrange it however it likes');
{
  // The default is a DEFAULT. If it cannot be changed, it is a cage.
  const m = load();
  const st = m.store.useSidebarStore;

  const before = [...st.getState().config.mainOrder];
  const moved = [before[2], before[1], ...before.slice(2).filter((_, i) => i !== 0)];
  st.getState().updateMainOrder([before[0], before[2], before[1], ...before.slice(3)]);
  const afterOrder = m.buildOrderedMenu(st.getState().config).menu.map((x) => x.label);
  t('sections can be reordered, and the sidebar follows',
    afterOrder[1] === before[2] && afterOrder[2] === before[1], afterOrder.slice(0, 4).join(' | '));

  st.getState().updateChildrenOrder('المبيعات',
    ['/accounting/maintenance', '/accounting/sales', '/accounting/services']);
  const kids = m.buildOrderedMenu(st.getState().config).menu
    .find((x) => x.label === 'المبيعات').children.map((c) => c.path);
  t('screens can be reordered inside a section', kids[0] === '/accounting/maintenance', kids.join(','));

  st.getState().renameItem('المبيعات', 'قسم البيع');
  t('a default section can be renamed',
    st.getState().getDisplayLabel('المبيعات') === 'قسم البيع');
  st.getState().renameItem('/accounting/sales', 'فاتورة بيع');
  t('a screen can be renamed', st.getState().getDisplayLabel('/accounting/sales') === 'فاتورة بيع');

  // Renaming must work for a screen the shop has MOVED — the old test looked
  // the key up in the default section lists, so moving it removed the ability.
  st.getState().moveChildToSection('/accounting/sales', 'المبيعات', 'التقارير');
  st.getState().renameItem('/accounting/sales', 'البيع');
  t('a moved screen can still be renamed',
    st.getState().getDisplayLabel('/accounting/sales') === 'البيع');

  // Anything the menu can NAME it must also be able to rename, including the
  // retired screens in NAV_ALIASES. A shop still keeping the old combined
  // سندات in a section could see it and not rename it, for no reason it could
  // work out — the two lists disagreed about what counted as "a screen".
  const parked = load({ sidebarConfig: JSON.stringify({
    mainOrder: ['التقارير'],
    childrenOrder: { 'التقارير': ['/accounting/vouchers'] },
    hidden: [], customSections: {}, customLabels: {},
  }) });
  const pst = parked.store.useSidebarStore;
  for (const alias of parked.cat.NAV_ALIASES) {
    pst.getState().renameItem(alias.path, 'اسمي');
    t(`a retired screen (${alias.path}) can be renamed too`,
      pst.getState().getDisplayLabel(alias.path) === 'اسمي',
      pst.getState().getDisplayLabel(alias.path));
  }

  st.getState().promoteChildToMain('/accounting/maintenance', 'المبيعات');
  const promoted = m.buildOrderedMenu(st.getState().config).menu;
  t('a screen can be promoted to the top level',
    promoted.some((x) => x.path === '/accounting/maintenance'));

  // A promoted screen is stored in mainOrder as its own path, not inside any
  // section. Repair must recognise that as "already placed" — otherwise the
  // next start decides it is missing, files a second copy in its old section,
  // and the shop now has the same screen in two places, growing by one every
  // restart.
  const promotedSaved = globalThis.localStorage.getItem('sidebarConfig');
  const reopened = load({ sidebarConfig: promotedSaved });
  const rmenu = reopened.buildOrderedMenu(reopened.store.useSidebarStore.getState().config).menu;
  const copies = rmenu.filter((x) => x.path === '/accounting/maintenance').length
    + rmenu.flatMap((s) => s.children || []).filter((c) => c.path === '/accounting/maintenance').length;
  t('a promoted screen is not duplicated on the next start', copies === 1, `${copies} copies`);

  st.getState().addCustomSection('قسم جديد');
  st.getState().moveChildToSection('/reports', 'التقارير', 'قسم جديد');
  const withCustom = m.buildOrderedMenu(st.getState().config).menu;
  const cs = withCustom.find((x) => x.label === 'قسم جديد');
  t('a custom section holds what is moved into it',
    !!cs && cs.children.some((c) => c.path === '/reports'));

  // Reset must genuinely return to the factory layout.
  st.getState().resetConfig();
  const reset = m.buildOrderedMenu(st.getState().config).menu.map((x) => x.label);
  t('reset restores the default order',
    JSON.stringify(reset) === JSON.stringify(m.cat.NAV_TOP_ORDER), reset.join(' | '));
  t('reset clears renames', st.getState().getDisplayLabel('المبيعات') === 'المبيعات');
  const resetShown = drawn(m, st.getState().config);
  t('reset restores every screen',
    m.cat.NAV_DESTINATIONS.every((d) => resetShown.has(d.path)));

  // Reset twice must not drift: a shallow copy of the defaults would let the
  // first reorder mutate the defaults themselves.
  const st2 = load().store.useSidebarStore;
  st2.getState().resetConfig();
  const first = JSON.stringify(st2.getState().config.childrenOrder);
  st2.getState().updateChildrenOrder('المبيعات', ['/accounting/sales']);
  st2.getState().resetConfig();
  t('reset is repeatable — the defaults are never mutated',
    JSON.stringify(st2.getState().config.childrenOrder) === first);

  // Handing out the default ARRAYS rather than copies of them is the subtle
  // version: every store action rebuilds the outer object, so nothing looks
  // wrong, but the live config and the module defaults are the same arrays.
  // One in-place push — from any future code, or a stale reference — and the
  // factory layout is permanently altered, so "reset" never resets again.
  const m5 = load();
  const st5 = m5.store.useSidebarStore;
  const pristine = JSON.stringify(m5.cat.DEFAULT_CHILDREN);
  st5.getState().resetConfig();
  const live = st5.getState().config;
  live.childrenOrder['المبيعات'].push('/poison');
  st5.getState().resetConfig();
  t('the config never shares arrays with the catalogue',
    JSON.stringify(m5.cat.DEFAULT_CHILDREN) === pristine);
  t('so a reset after in-place edits still gives the factory layout',
    !st5.getState().config.childrenOrder['المبيعات'].includes('/poison'),
    st5.getState().config.childrenOrder['المبيعات'].join(','));

  // The arrangement must persist across a restart.
  const m3 = load();
  const st3 = m3.store.useSidebarStore;
  st3.getState().updateMainOrder(['التقارير', ...st3.getState().config.mainOrder.filter((x) => x !== 'التقارير')]);
  const saved = globalThis.localStorage.getItem('sidebarConfig');
  const m4 = load({ sidebarConfig: saved });
  t('the arrangement survives a restart',
    m4.buildOrderedMenu(m4.store.useSidebarStore.getState().config).menu[0].label === 'التقارير');
}

try { rmSync(PROBE, { recursive: true, force: true }); } catch {}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
