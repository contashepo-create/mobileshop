#!/usr/bin/env node
/**
 * THE ACCOUNTING SECTION, SPLIT INTO FIVE.
 *
 * WHAT WAS WRONG
 * --------------
 * "الحسابات" held eleven unrelated screens in one list: sales next to fiscal
 * years next to stocktakes. That is a grouping by "these are all accounting",
 * which is true and useless — nothing in it tells the shop where to look.
 *
 * Returns were worse than misfiled: they were a TAB inside the sales and
 * purchases screens, so "مرتجعات المبيعات" could not be reached from the
 * sidebar at all. The shop had to already know it lived behind a tab on
 * another page.
 *
 * Receipt and payment vouchers were one screen with a filter, though a shop
 * thinks in terms of money in and money out — different daily tasks, often
 * done by different people.
 *
 * WHAT IS PROVEN HERE
 *   [1] the five sections exist, holding what was asked for
 *   [2] returns and voucher kinds are real destinations, not tabs
 *   [3] every listed path has a route behind it
 *   [4] a saved layout is UPGRADED, not discarded
 *   [5] one page serves two entries without duplicating itself
 *
 * Run with:  node --experimental-strip-types scripts/verify_sidebar_sections.mjs
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
console.log('SIDEBAR — THE FIVE ACCOUNTING SECTIONS');
console.log('='.repeat(72));

const store = raw('src/renderer/src/stores/sidebar.store.ts');
const app = raw('src/renderer/src/App.tsx');

/** The real defaults, lifted out of the module rather than restated here. */
function defaults() {
  const body = /const defaultChildrenOrder: Record<string, string\[\]> = \{([\s\S]*?)\n\};/.exec(store)[1];
  const out = {};
  // Strip comments first: the table carries explanatory prose that would
  // otherwise be parsed as configuration.
  const clean = body.replace(/\/\/[^\n]*/g, '');
  for (const m of clean.matchAll(/'([^']+)':\s*\[([\s\S]*?)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}
const children = defaults();
const mainOrder = [...(/const defaultMainOrder = \[([\s\S]*?)\];/.exec(store)[1])
  .matchAll(/'([^']+)'/g)].map((m) => m[1]);

// ---------------------------------------------------------------- 1
console.log('\n[1] The five sections exist, in order');
{
  const wanted = [
    'المبيعات',
    'المشتريات',
    'السندات والرواتب والإيجارات',
    'السنة المالية والأرصدة الافتتاحية',
    'المخازن والتسوية الجردية',
  ];
  for (const section of wanted) {
    t(`"${section}" is a top-level section`, mainOrder.includes(section));
  }
  t('the single catch-all "الحسابات" is gone', !mainOrder.includes('الحسابات'));
  t('the dashboard is still first', mainOrder[0] === 'لوحة التحكم');
  // Order matters: this is the sequence that was asked for.
  const idx = wanted.map((w) => mainOrder.indexOf(w));
  t('they appear in the requested order',
    idx.every((v, i) => i === 0 || v > idx[i - 1]), idx.join(','));

  t('sales holds sales, transfers, maintenance and its returns',
    ['/accounting/sales', '/accounting/services', '/accounting/maintenance',
     '/accounting/sale-returns'].every((x) => children['المبيعات'].includes(x)),
    (children['المبيعات'] || []).join(','));
  t('purchases holds purchases and its returns',
    ['/accounting/purchases', '/accounting/purchase-returns']
      .every((x) => children['المشتريات'].includes(x)));
  t('vouchers/payroll/rents are together',
    ['/accounting/vouchers-receipt', '/accounting/vouchers-payment', '/accounting/payroll',
     '/accounting/rents'].every((x) => children['السندات والرواتب والإيجارات'].includes(x)));
  t('the fiscal year sits with the opening balances',
    ['/accounting/fiscal-year', '/accounting/opening-balances']
      .every((x) => children['السنة المالية والأرصدة الافتتاحية'].includes(x)));
  t('the stocktake sits with the warehouses',
    ['/inventory', '/accounting/settlement']
      .every((x) => children['المخازن والتسوية الجردية'].includes(x)));

  // Inventory moved INTO a section, so it must not also stand alone or it
  // appears twice.
  t('inventory is no longer a duplicate standalone entry',
    !mainOrder.includes('المخازن والأصناف')
    && !/'المخازن والأصناف': '\/inventory'/.test(store));
}

// ---------------------------------------------------------------- 2 & 3
console.log('\n[2] Returns and voucher kinds are destinations, and every path routes');
{
  const NEW = [
    '/accounting/sale-returns',
    '/accounting/purchase-returns',
    '/accounting/vouchers-receipt',
    '/accounting/vouchers-payment',
  ];
  for (const path of NEW) {
    const route = path.replace(/^\//, '');
    t(`${path} has a route`, app.includes(`path="${route}"`), route);
    t(`${path} has a label`, new RegExp(`'${path}': '`).test(store));
  }

  // Every path the sidebar offers must lead somewhere. A menu entry that
  // renders nothing is worse than a missing one: it looks like a broken app.
  const listed = new Set(Object.values(children).flat());
  const missing = [];
  for (const path of listed) {
    if (path === '/' || path === '/inventory' || path === '/about'
        || path === '/settings' || path === '/reports' || path === '/assets') continue;
    const route = path.replace(/^\//, '');
    if (!app.includes(`path="${route}"`)) missing.push(path);
  }
  t('every listed child path has a matching route', missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] A saved layout is upgraded, not discarded');
{
  // A shop that has already arranged its sidebar has that arrangement in
  // localStorage, naming a section that no longer exists. Without a migration
  // the saved config wins and the new screens appear NOWHERE.
  const defsSrc = /const defaultChildrenOrder: Record<string, string\[\]> = \{[\s\S]*?\n\};/
    .exec(store)[0].replace(': Record<string, string[]>', '');
  const fnSrc = /function migrateAccountingSplit\(config: SidebarConfig\): SidebarConfig \{[\s\S]*?\n\}/
    .exec(store)[0].replace(/: SidebarConfig/g, '');
  const migrate = new Function(`${defsSrc}; ${fnSrc}; return migrateAccountingSplit;`)();

  const saved = {
    mainOrder: ['لوحة التحكم', 'الحسابات', 'المخازن والأصناف', 'التقارير'],
    childrenOrder: { 'الحسابات': ['/accounting/sales', '/accounting/purchases'] },
    hidden: [], customSections: {}, customLabels: {},
  };
  const out = migrate(saved);

  t('the retired section is removed', !out.mainOrder.includes('الحسابات'));
  t('the five replace it', ['المبيعات', 'المشتريات', 'السندات والرواتب والإيجارات',
    'السنة المالية والأرصدة الافتتاحية', 'المخازن والتسوية الجردية']
    .every((x) => out.mainOrder.includes(x)));
  t('they take the place it stood in, so nothing reshuffles',
    out.mainOrder.indexOf('المبيعات') === 1, out.mainOrder.join(' | '));
  t('sections the shop never touched are preserved', out.mainOrder.includes('التقارير'));
  t('inventory is not left duplicated', !out.mainOrder.includes('المخازن والأصناف'));
  t('the new screens are now reachable',
    out.childrenOrder['المبيعات'].includes('/accounting/sale-returns'));

  // A shop that already built its own section of that name must keep it.
  const custom = migrate({
    ...saved,
    childrenOrder: { ...saved.childrenOrder, 'المبيعات': ['/accounting/sales'] },
  });
  t('a section the shop already built is left untouched',
    JSON.stringify(custom.childrenOrder['المبيعات']) === '["/accounting/sales"]');

  // Running twice must not compound.
  t('the migration is idempotent',
    JSON.stringify(migrate(out)) === JSON.stringify(out));
  // And it must not fire on a layout that has already been upgraded.
  const fresh = { mainOrder: [...out.mainOrder], childrenOrder: { ...out.childrenOrder },
    hidden: [], customSections: {}, customLabels: {} };
  t('it leaves an already-new layout alone',
    JSON.stringify(migrate(fresh)) === JSON.stringify(fresh));

  t('it is actually wired into the loader',
    /migrateAccountingSplit\(migrateConfig\(config\)\)/.test(store));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] One page serves two entries, without a second copy');
{
  const sales = raw('src/renderer/src/pages/accounting/SalesPage.tsx');
  const purch = raw('src/renderer/src/pages/accounting/PurchasesPage.tsx');
  const vouch = raw('src/renderer/src/pages/accounting/VouchersPage.tsx');

  t('SalesPage takes a mode', /mode\?: 'sales' \| 'returns'/.test(sales));
  t('and opens on it', /useState<'sales' \| 'returns'>\(mode \?\? 'sales'\)/.test(sales));
  // A tab that navigates away from the section just opened is worse than none.
  t('its tab strip is hidden when the mode is fixed',
    /\$\{mode \? 'hidden' : ''\}/.test(sales));
  t('and the heading says which section this is', /مرتجعات المبيعات/.test(sales));

  t('PurchasesPage takes a mode', /mode\?: 'purchases' \| 'returns'/.test(purch));
  t('and its heading follows', /مرتجعات المشتريات/.test(purch));

  t('VouchersPage takes a mode', /mode\?: 'receipt' \| 'payment'/.test(vouch));
  t('the filter follows the mode', /useState\(mode \?\? 'all'\)/.test(vouch));
  t('a new voucher defaults to the section it was opened from',
    /VoucherType: mode \?\? 'receipt'/.test(vouch));
  // Opening سندات الصرف and being able to switch the form to a receipt is how
  // a payment gets filed as income.
  t('the type cannot be switched away from the section',
    /disabled=\{!!mode\}/.test(vouch));

  t('no duplicate page files were created',
    !app.includes('SaleReturnsPage') && !app.includes('PurchaseReturnsPage'));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
