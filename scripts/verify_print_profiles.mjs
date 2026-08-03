#!/usr/bin/env node
/**
 * PER-DOCUMENT PRINT PROFILES — audit points 19 and 20.
 *
 * WHAT WAS WRONG
 * --------------
 * Every print setting was GLOBAL. One template, one paper size, one set of
 * visible columns, shared by every document the shop produces. In a real shop
 * those documents have nothing in common:
 *
 *   - a sales invoice goes to the customer on an 80mm thermal roll
 *   - a purchase invoice is an internal record and belongs on A4
 *   - a receipt voucher has no line items, so a quantity column is noise
 *   - a maintenance ticket needs the IMEI a grocery-style sale does not
 *
 * Column ORDER could not be changed at all — only visibility — because the
 * header and the body were two separately hand-written lists of `if` blocks.
 *
 * Separately, `generateInvoiceHTML` advertised six document types in its
 * `titles` map but built a body for only three. Printing a PURCHASE produced a
 * header, an empty table and no totals; the same for a STATEMENT. Measured, not
 * assumed — see section [5].
 *
 * WHAT IS PROVEN HERE
 *   [1] resolution order: per-document -> global -> default
 *   [2] a shop that changes nothing keeps the document it had (no silent restyle)
 *   [3] hostile and malformed stored values cannot reach the page
 *   [4] column order is honoured, and header and body agree
 *   [5] every advertised document type actually renders
 *   [6] per-document free text is isolated to its type, and escaped
 *   [7] the window, the page size and the HTML all use ONE resolved profile
 *
 * Run with:  node --experimental-strip-types scripts/verify_print_profiles.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('PER-DOCUMENT PRINT PROFILES');
console.log('='.repeat(72));

const P = await import('../src/shared/printProfile.ts');

// ---------------------------------------------------------------- 1
console.log('\n[1] Resolution order: per-document, then global, then default');
{
  let p = P.resolveProfile({}, 'sale');
  t('an unconfigured shop gets the built-in defaults',
    p.template === '1' && p.paper === '80mm' && p.copies === 1);

  p = P.resolveProfile({ default_invoice_template: '3', paper_size: 'A4' }, 'purchase');
  t('the GLOBAL value is used when there is no per-document one',
    p.template === '3' && p.paper === 'A4');

  p = P.resolveProfile({
    default_invoice_template: '3', paper_size: 'A4',
    print_doc_purchase_template: '2', print_doc_purchase_paper: 'A5',
  }, 'purchase');
  t('a per-document value overrides the global one',
    p.template === '2' && p.paper === 'A5');

  // The whole point of the feature: one type differing must not move another.
  const other = P.resolveProfile({ paper_size: 'A4', print_doc_purchase_paper: 'A5' }, 'sale');
  t('and it does not leak into a different document type', other.paper === 'A4');
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A shop that changes nothing keeps the document it had');
{
  // This is the compatibility contract. The old keys must still steer the
  // output, or upgrading silently restyles every invoice a shop prints.
  const legacy = { default_invoice_template: '4', paper_size: 'A5', print_col_qty: '0' };
  const p = P.resolveProfile(legacy, 'sale');
  t('the old global template key still applies', p.template === '4');
  t('the old global paper key still applies', p.paper === 'A5');
  t('a column hidden under the old key is still hidden', p.columns.qty === false);
  t('columns never switched off are shown',
    p.columns.price && p.columns.total && p.columns.name);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Malformed stored values cannot reach the page');
{
  t('an unknown template falls back',
    P.resolveProfile({ print_doc_sale_template: '99' }, 'sale').template === '1');
  t('an unknown paper size falls back',
    P.resolveProfile({ print_doc_sale_paper: 'A0' }, 'sale').paper === '80mm');
  t('an injected template value cannot reach the CSS',
    P.resolveProfile({ print_doc_sale_template: '1;}</style><script>' }, 'sale').template === '1');
  t('copies clamped at the top', P.resolveProfile({ print_doc_sale_copies: '9999' }, 'sale').copies === 5);
  t('copies cannot be zero', P.resolveProfile({ print_doc_sale_copies: '0' }, 'sale').copies === 1);
  t('copies cannot be negative', P.resolveProfile({ print_doc_sale_copies: '-3' }, 'sale').copies === 1);
  t('non-numeric copies fall back to one',
    P.resolveProfile({ print_doc_sale_copies: 'abc' }, 'sale').copies === 1);

  // An order string is a hint, never trusted. Whatever is stored, the result
  // must be a complete permutation, or the printer gets a table with a
  // missing or duplicated column.
  const isPermutation = (o) =>
    o.length === P.COLUMN_KEYS.length &&
    new Set(o).size === o.length &&
    P.COLUMN_KEYS.every((k) => o.includes(k));
  t('an empty order yields the canonical one', isPermutation(P.parseOrder('')));
  t('a partial order is completed', isPermutation(P.parseOrder('total,qty')));
  t('duplicates are collapsed', isPermutation(P.parseOrder('qty,qty,qty')));
  t('unknown column names are dropped', isPermutation(P.parseOrder('qty,DROP TABLE,price')));
  t('garbage still yields a usable order', isPermutation(P.parseOrder('%%%,,,')));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The item name can never be removed');
{
  // A line reading "2 x 150.00" with no indication of WHAT was sold is not a
  // commercial record. The column is orderable but not hideable.
  const p = P.resolveProfile({ print_doc_sale_col_name: '0' }, 'sale');
  t('hiding the name column is refused', P.visibleColumns(p).includes('name'));

  // Presence alone is too weak an assertion. Keeping the column but MOVING it
  // is also a defect, and a mutant that dropped the mandatory clause from the
  // filter survived this section until the position was checked too: the
  // fallback loop put the name back at the FRONT, silently discarding the
  // order the shop configured.
  const placed = P.resolveProfile({
    print_doc_sale_order: 'index,qty,name,total', print_doc_sale_col_name: '0',
  }, 'sale');
  t('and it stays where the shop put it, not forced to the front',
    P.visibleColumns(placed).join(',') === 'index,qty,name,total,price,imei',
    P.visibleColumns(placed).join(','));
  const q = P.resolveProfile({ print_doc_sale_col_qty: '0', print_doc_sale_col_price: '0' }, 'sale');
  t('but other columns really can be hidden',
    !P.visibleColumns(q).includes('qty') && !P.visibleColumns(q).includes('price'));
  t('visible columns come back in the configured order',
    P.visibleColumns(P.resolveProfile({ print_doc_sale_order: 'total,name' }, 'sale'))
      .slice(0, 2).join() === 'total,name');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Every advertised document type actually renders');
{
  // Bundle and RUN the real generator. A structural check on the source would
  // only show that a branch exists, not that it produces a document.
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/print.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
  });
  const stub = join(ROOT, 'node_modules', '.print-probe');
  mkdirSync(join(stub, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(stub, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(stub, 'node_modules', 'electron', 'index.js'),
    'module.exports={ipcMain:{handle(){}},BrowserWindow:class{},app:{getPath:()=>"/tmp"}};');
  writeFileSync(join(stub, 'pr.cjs'),
    out.outputFiles[0].text + '\nmodule.exports.__gen = generateInvoiceHTML;\n');
  const gen = createRequire(join(stub, '/'))(join(stub, 'pr.cjs')).__gen;

  const items = [
    { ItemName: 'شاشة', Quantity: 2, UnitPrice: 150, IMEI: '358001' },
    { ItemName: 'بطارية', Quantity: 1, UnitPrice: 80 },
  ];
  const money = { subtotal: 380, totalAmount: 380, paidAmount: 380 };
  const doc = (type, companyInfo = {}, invoiceData = {}) => gen({
    type, paperSize: '80mm', template: '1', companyInfo,
    invoiceData: { saleNumber: 'S1', purchaseNumber: 'P1', date: '2026-08-02',
      items, ...money, ...invoiceData },
  }, false);

  for (const [type, marker] of [
    ['sale', 'فاتورة مبيعات'],
    ['purchase', 'فاتورة مشتريات'],
    ['maintenance', 'فاتورة صيانة'],
  ]) {
    const html = doc(type);
    t(`${type}: the line items are printed`, /شاشة/.test(html) && /بطارية/.test(html));
    t(`${type}: the totals are printed`, /الإجمالي الفرعي/.test(html));
    t(`${type}: the title is right`, html.includes(marker));
  }

  const st = gen({ type: 'statement', companyInfo: {}, invoiceData: {
    date: '2026-08-02',
    items: [{ Date: '2026-08-01', Description: 'فاتورة مبيعات', Debit: 100, Credit: 0, Balance: 100 }],
    totalDebit: 100, totalCredit: 0, netBalance: 100 } }, false);
  t('statement: the ledger rows are printed', /2026-08-01/.test(st));
  t('statement: the closing balance is printed', /الرصيد/.test(st));

  const v = gen({ type: 'voucher_receipt', companyInfo: {}, invoiceData: {
    amount: 500, description: 'دفعة', partyName: 'محمد', date: '2026-08-02' } }, false);
  t('voucher: the amount and party are printed', /500\.00/.test(v) && /محمد/.test(v));

  // ------------------------------------------------------------- 4b
  console.log('\n[4b] Column order reaches the HTML, header AND body together');
  {
    const html = doc('sale', {
      print_doc_sale_order: 'total,name,qty',
      print_doc_sale_col_index: '0', print_doc_sale_col_price: '0',
      print_doc_sale_col_imei: '0',
    });
    const heads = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
    t('the header row follows the configured order',
      heads.join(',') === 'إجمالي,الصنف,كمية', heads.join(','));

    // The real risk is a header and a body that disagree — every figure would
    // then print under the wrong heading, which is worse than an ugly table.
    const body = /<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/.exec(html)[1];
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
    t('and the body cells are in the SAME order',
      cells[0] === '300.00' && cells[1].startsWith('شاشة') && cells[2] === '2',
      cells.join(' | '));
    t('hidden columns are absent from both',
      !heads.includes('#') && !heads.includes('سعر') && cells.length === heads.length);
  }

  // ------------------------------------------------------------- 6
  console.log('\n[6] Per-document free text is isolated, and escaped');
  {
    const html = doc('sale', {
      print_doc_sale_header: 'سياسة الاسترجاع خلال ١٤ يوماً',
      print_doc_sale_footer: 'نشكر تعاملكم',
    });
    t('the header text is printed', /سياسة الاسترجاع/.test(html));
    t('the footer text is printed', /doc-footer-text[^>]*>نشكر تعاملكم/.test(html));
    t('it does not appear on a different document type',
      !/سياسة الاسترجاع/.test(doc('purchase', {
        print_doc_sale_header: 'سياسة الاسترجاع خلال ١٤ يوماً' })));

    // This text is shop-controlled and lands in a data: URL that does not
    // inherit the CSP. It has to be escaped like any other input.
    const evil = doc('sale', { print_doc_sale_header: '<img src=x onerror=alert(1)>' });
    t('a script payload in the header text is neutralised',
      !/<img/.test(evil) && /&lt;img/.test(evil));
  }

  // ------------------------------------------------------------- 7
  console.log('\n[7] Paper is decided once, and the whole document agrees');
  {
    const thermal = doc('sale', { paper_size: '80mm', print_doc_purchase_paper: 'A4' });
    const a4 = doc('purchase', { paper_size: '80mm', print_doc_purchase_paper: 'A4' });
    t('the sale stays on the thermal roll', /max-width: 80mm/.test(thermal));
    t('the purchase moves to A4 on its own', /max-width: 210mm/.test(a4));

    // The handler used to size the physical page from the PAYLOAD while the
    // HTML was built from the profile, so an 80mm document could be sent to an
    // A4 sheet whenever the two disagreed.
    const src = raw('src/main/ipc/print.handlers.ts');
    t('the printer takes its page size from the resolved profile',
      /pageSize: getPageSize\(profile\.paper\)/.test(src));
    t('and the copy count too', /copies: profile\.copies/.test(src));
    t('the window size comes from the profile as well',
      /profile\.paper === 'A4'/.test(src) && !/data\.paperSize === 'A4'/.test(src));
  }
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The settings screen and the printer share one implementation');
{
  const ui = raw('src/renderer/src/pages/settings/PrintSettings.tsx');
  const ph = raw('src/main/ipc/print.handlers.ts');
  t('the screen imports the shared resolver',
    /from '[^']*shared\/printProfile'/.test(ui));
  t('the printer imports the same module',
    /from '[^']*shared\/printProfile'/.test(ph));
  t('the screen offers every document type', /DOCUMENT_TYPES\.map/.test(ui));
  t('the screen can reorder columns', /moveColumn/.test(ui));
  t('the mandatory column is not editable in the screen either',
    /MANDATORY_COLUMNS\.includes\(key\)/.test(ui) && /disabled=\{required\}/.test(ui));
  t('the screen writes only known keys',
    /profileKeys\(docType\)/.test(ui) && !/\.\.\.rawSettings/.test(ui));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Each document type has a PROFESSIONAL default');
{
  // Every type used to fall back to the same answer: 80mm thermal, a thanks
  // note, and an items table with quantity and price. Right for a receipt
  // handed to a customer; wrong for everything else.
  const P2 = await import('../src/shared/printProfile.ts');

  const sale = P2.resolveProfile({}, 'sale');
  const purchase = P2.resolveProfile({}, 'purchase');
  const receipt = P2.resolveProfile({}, 'voucher_receipt');
  const statement = P2.resolveProfile({}, 'statement');

  t('a sales receipt defaults to the thermal roll', sale.paper === '80mm', sale.paper);
  t('a purchase invoice is an internal A4 record', purchase.paper === 'A4', purchase.paper);
  t('a voucher is A5', receipt.paper === 'A5', receipt.paper);
  t('a statement is A4', statement.paper === 'A4', statement.paper);

  // Thanking yourself for your own purchase is nonsense; so is a courtesy
  // line on a ledger.
  t('only a customer document says thank you',
    sale.showThanks === true && purchase.showThanks === false
    && receipt.showThanks === false && statement.showThanks === false);
  // A voucher and a statement are evidence, and evidence is signed.
  t('evidence documents carry a signature line',
    purchase.showSignature === true && receipt.showSignature === true
    && statement.showSignature === true && sale.showSignature === false);

  // A voucher has no line items at all — one amount, one party, one reason.
  const vcols = P2.visibleColumns(receipt);
  t('a voucher prints no quantity or price columns',
    !vcols.includes('qty') && !vcols.includes('price'), vcols.join(','));
  t('but it still names what the money was for', vcols.includes('name'));
  t('a sale keeps its full item table',
    P2.visibleColumns(sale).includes('qty') && P2.visibleColumns(sale).includes('price'));

  // Two copies of a purchase: one filed, one signed by the supplier.
  t('a purchase prints two copies', purchase.copies === 2, String(purchase.copies));
  t('a sales receipt prints one', sale.copies === 1, String(sale.copies));
  t('a voucher carries its own acknowledgement line',
    /أقر باستلام/.test(receipt.footerText), receipt.footerText);

  // THE PRECEDENCE CONTRACT. These are defaults, not rules.
  t('a shop-wide paper choice still beats the type default',
    P2.resolveProfile({ paper_size: 'A4' }, 'sale').paper === 'A4');
  t('and a per-document setting beats everything',
    P2.resolveProfile({ paper_size: 'A4', print_doc_purchase_paper: '80mm' }, 'purchase').paper === '80mm');
  t('a column the shop hid globally stays hidden',
    P2.resolveProfile({ print_col_qty: '0' }, 'sale').columns.qty === false);
  t('and a column it explicitly SHOWS on a voucher is shown',
    P2.resolveProfile({ print_doc_voucher_receipt_col_qty: '1' }, 'voucher_receipt').columns.qty === true);
}

// ---------------------------------------------------------------- 10
console.log('\n[10] The rendered document matches the profile');
{
  // Structural agreement is not enough: the CSS has to carry it. A5 was
  // resolvable as a paper size while `@page` was hardcoded to A4, so a voucher
  // came out on the wrong sheet however it was configured.
  const { build } = await import('esbuild');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/print.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
  });
  const dir = join(ROOT, 'node_modules', '.pdef-probe');
  mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules', 'electron', 'index.js'),
    'module.exports={ipcMain:{handle(){}},BrowserWindow:class{},app:{getPath:()=>"/tmp"},dialog:{}};');
  const f = `pd${Date.now()}.cjs`;
  writeFileSync(join(dir, f), out.outputFiles[0].text + '\nmodule.exports.__gen = generateInvoiceHTML;\n');
  const gen = createRequire(join(dir, '/'))(join(dir, f)).__gen;

  const doc = (type, companyInfo = {}) => gen({
    type, companyInfo,
    invoiceData: {
      saleNumber: 'S1', purchaseNumber: 'P1', date: '2026-08-03',
      items: [{ ItemName: 'شاشة', Quantity: 2, UnitPrice: 150 }],
      subtotal: 300, totalAmount: 300, paidAmount: 300,
      amount: 500, description: 'دفعة', partyName: 'محمد',
      totalDebit: 100, totalCredit: 0, netBalance: 100,
    },
  }, false);
  const sheet = (html) => (/@page \{[^}]*size: ([^;}]+)/.exec(html) || [])[1];

  t('a sale really prints on the roll', sheet(doc('sale')) === '80mm auto', sheet(doc('sale')));
  t('a purchase really prints on A4', sheet(doc('purchase')) === 'A4', sheet(doc('purchase')));
  t('a voucher really prints on A5', sheet(doc('voucher_receipt')) === 'A5', sheet(doc('voucher_receipt')));
  t('a statement really prints on A4', sheet(doc('statement')) === 'A4');

  t('the thanks line appears only on the sale',
    /class="thank-you"/.test(doc('sale')) && !/class="thank-you"/.test(doc('purchase')));
  t('the signature line appears only where it belongs',
    /class="sig-line"/.test(doc('purchase')) && !/class="sig-line"/.test(doc('sale')));
  t('the purchase signature names the supplier', /المورد/.test(doc('purchase')));
  t('a voucher prints no quantity column', !/<th>كمية<\/th>/.test(doc('voucher_receipt')));
  t('a sale still prints one', /<th>كمية<\/th>/.test(doc('sale')));

  // And the precedence survives all the way to the page.
  t('a global A4 choice reaches the sheet', sheet(doc('sale', { paper_size: 'A4' })) === 'A4');
  t('a per-document choice reaches it too',
    sheet(doc('purchase', { print_doc_purchase_paper: '80mm' })) === '80mm auto');
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
