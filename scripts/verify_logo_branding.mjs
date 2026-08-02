#!/usr/bin/env node
/**
 * THE SHOP LOGO AND LETTERHEAD — end to end.
 *
 * WHAT WAS WRONG
 * --------------
 * The logo worked on invoices and NOWHERE else. `logo_path` is in the settings
 * map every screen can load, and the main-process invoice printer had rendered
 * it correctly all along — but the four documents built in the RENDERER
 * carried none of it:
 *
 *   reports/CustomerStatementPage.tsx   no logo
 *   reports/SupplierStatementPage.tsx   no logo, and no shop name either
 *   reports/EmployeeStatementPage.tsx   no logo, and no shop name either
 *   assets/AssetsPage.tsx               no logo, generic name in the footer
 *
 * The missing name was the sharper defect. Those three read
 * `(window as any).__settings?.company_name`, and `window.__settings` is
 * ASSIGNED NOWHERE IN THE CODEBASE. Measured, not inferred: the supplier and
 * employee statements printed an empty shop name, and the assets register
 * silently fell back to the generic "نظام المحمول" instead of the shop's own
 * name. Two of the three never called `settings:getAll` at all.
 *
 * None of them printed a tax number, which a statement handed to a customer or
 * a supplier is expected to carry.
 *
 * WHAT IS PROVEN HERE
 *   [1] the picker accepts real images and refuses anything else
 *   [2] the invoice still renders the logo, at a clamped height
 *   [3] the shared letterhead carries logo, name, contact and tax number
 *   [4] a logo source that could execute is refused on every surface
 *   [5] all four renderer documents use the shared builder
 *   [6] the phantom `window.__settings` global is gone
 *
 * Run with:  node --experimental-strip-types scripts/verify_logo_branding.mjs
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
console.log('SHOP LOGO AND LETTERHEAD');
console.log('='.repeat(72));

const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// ---------------------------------------------------------------- 1
console.log('\n[1] The picker accepts real images and refuses everything else');
{
  const s = raw('src/main/ipc/settings.handlers.ts');

  // The type is decided by the file's own bytes, not its extension, so a
  // renamed file cannot be embedded with a mime type that lies about it.
  const sniff = (bytes) => {
    const sig = bytes.subarray(0, 12);
    if (sig[0] === 0x89 && sig[1] === 0x50) return 'image/png';
    if (sig[0] === 0xff && sig[1] === 0xd8) return 'image/jpeg';
    if (sig.subarray(0, 4).toString('ascii') === 'RIFF'
        && sig.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (sig.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    return '';
  };
  t('a PNG is accepted', sniff(Buffer.from('89504e470d0a1a0a', 'hex')) === 'image/png');
  t('a JPEG is accepted', sniff(Buffer.from('ffd8ffe000104a464946', 'hex')) === 'image/jpeg');
  t('a GIF is accepted', sniff(Buffer.from('474946383961', 'hex')) === 'image/gif');
  t('a WEBP is accepted',
    sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])) === 'image/webp');
  t('an executable renamed .png is refused',
    sniff(Buffer.from('4d5a90000300000004', 'hex')) === '');
  t('an HTML file renamed .png is refused',
    sniff(Buffer.from('<html><script>alert(1)</script>', 'utf8')) === '');

  t('the handler sniffs the bytes rather than trusting the extension',
    /sig\[0\] === 0x89/.test(s) && /not its extension/.test(s));
  t('a size cap exists', /MAX_BYTES = 512 \* 1024;/.test(s));
  // Checking the size AFTER reading would defeat the point of the cap.
  t('the cap is checked before the file is read into memory',
    s.indexOf('stat.size > MAX_BYTES') < s.indexOf('fs.readFileSync(file)'));
  t('the logo is stored inline, so a restored backup keeps it',
    /data:\$\{mime\};base64/.test(s));

  // The checks above re-implement the sniffing to exercise the RULE. That
  // proves the rule is right, not that the handler still applies it — a
  // mutant that deleted the rejection branch survived until this was added.
  t('the handler REFUSES a file whose bytes match no image type',
    /if \(!mime\) return \{ success: false/.test(s));
  t('and the refusal comes before any data URL is built',
    s.indexOf('if (!mime) return') < s.indexOf('return { success: true, dataUrl:'));
  // 512 KiB, not 512 MiB: a cap that admits a photograph is not a cap. This
  // value lands in every settings read, including the pre-login one.
  {
    const m = /const MAX_BYTES = ([^;]+);/.exec(s);
    // eslint-disable-next-line no-eval
    const bytes = m ? eval(m[1]) : NaN;
    t('the cap is a sane size for a logo', bytes === 512 * 1024, String(bytes));
  }
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The invoice renders the logo, at a clamped height');
{
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, 'src/main/ipc/print.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron'], logLevel: 'silent',
  });
  const stub = join(ROOT, 'node_modules', '.logo-probe');
  mkdirSync(join(stub, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(join(stub, 'node_modules', 'electron', 'package.json'),
    '{"name":"electron","version":"0.0.0","main":"index.js"}');
  writeFileSync(join(stub, 'node_modules', 'electron', 'index.js'),
    'module.exports={ipcMain:{handle(){}},BrowserWindow:class{},app:{getPath:()=>"/tmp"},dialog:{}};');
  writeFileSync(join(stub, 'pr.cjs'),
    out.outputFiles[0].text + '\nmodule.exports.__gen = generateInvoiceHTML;\n');
  const gen = createRequire(join(stub, '/'))(join(stub, 'pr.cjs')).__gen;

  const doc = (companyInfo) => gen({
    type: 'sale', paperSize: '80mm', template: '1', companyInfo,
    invoiceData: { saleNumber: 'S1', date: '2026-08-02',
      items: [{ ItemName: 'شاشة', Quantity: 1, UnitPrice: 10 }],
      subtotal: 10, totalAmount: 10, paidAmount: 10 },
  }, false);

  t('an <img> is emitted when a logo is set', /<img src="data:image\/png;base64/.test(doc({ logo_path: PNG_URL })));
  t('no <img> when none is set', !/<img/.test(doc({ company_name: 'x' })));
  t('the invoice still renders without a logo', /محل|x/.test(doc({ company_name: 'x' })));
  t('the default height is applied', /max-height: 50px/.test(doc({ logo_path: PNG_URL })));
  t('a configured height is honoured',
    /max-height: 120px/.test(doc({ logo_path: PNG_URL, print_logo_height: '120' })));
  t('an absurd height is clamped',
    /max-height: 200px/.test(doc({ logo_path: PNG_URL, print_logo_height: '9999' })));
  t('the logo is hidden when the shop block is switched off',
    !/<img/.test(doc({ logo_path: PNG_URL, invoice_show_shop: '0' })));
  for (const [label, value] of [
    ['javascript:', 'javascript:alert(1)'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
  ]) t(`the invoice refuses a ${label} logo`, !/<img/.test(doc({ logo_path: value })));
}

// ---------------------------------------------------------------- 3 & 4
console.log('\n[3] The shared letterhead carries the full shop identity');
{
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: [join(ROOT, 'src/renderer/src/lib/printHeader.ts')],
    bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent',
  });
  const file = join(ROOT, 'node_modules', '.logo-probe', 'ph.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  const H = await import(`file://${file}?${Date.now()}`);

  const S = {
    company_name: 'محل محمد عبده', logo_path: PNG_URL,
    address: 'المنصورة', phone: '01000000000', tax_number: '123-456',
  };
  const h = H.printHeaderHtml(S, 'كشف حساب عميل');
  t('the logo is rendered', /<img src="data:image\/png;base64/.test(h));
  t('the SHOP NAME is rendered — it printed empty before', /محل محمد عبده/.test(h));
  t('the address is rendered', /المنصورة/.test(h));
  t('the phone is rendered', /01000000000/.test(h));
  t('the TAX NUMBER is rendered — no statement carried one', /رقم ضريبي: 123-456/.test(h));
  t("the document's own title is preserved", /كشف حساب عميل/.test(h));

  const empty = H.printHeaderHtml({}, 'كشف حساب مورد');
  t('an unconfigured shop prints no logo tag', !/<img/.test(empty));
  t('and never prints the word "undefined"', !/undefined/.test(empty));
  t('null settings do not throw', /كشف/.test(H.printHeaderHtml(null, 'كشف حساب')));

  t('the height matches the invoice default', H.logoHeight({}) === 50);
  t('and is clamped the same way',
    H.logoHeight({ print_logo_height: '9999' }) === 200 && H.logoHeight({ print_logo_height: '1' }) === 20);

  console.log('\n[4] A logo that could execute is refused here too');
  for (const [label, value] of [
    ['javascript:', 'javascript:alert(1)'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
    ['a bare word', 'nonsense'],
  ]) t(`refuses ${label}`, !/<img/.test(H.printHeaderHtml({ logo_path: value }, 't')));

  // These documents are written into a window.open child, which inherits the
  // opener's preload — script there reaches the whole IPC surface.
  t('the shop name is escaped',
    !/<img src=x/.test(H.printHeaderHtml({ company_name: '<img src=x onerror=alert(1)>' }, 't')));
  t('the tax number is escaped',
    !/<script>/.test(H.printHeaderHtml({ tax_number: '"><script>alert(1)</script>' }, 't')));
  t('the footer carries the shop name', /محل محمد عبده/.test(H.printFooterHtml(S, 'معتمد')));
  t('and omits the separator when there is no name',
    H.printFooterHtml({}, 'معتمد') === '<div class="footer">معتمد</div>');
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Every renderer-printed document uses the shared letterhead');
{
  const SCREENS = [
    'src/renderer/src/pages/reports/CustomerStatementPage.tsx',
    'src/renderer/src/pages/reports/SupplierStatementPage.tsx',
    'src/renderer/src/pages/reports/EmployeeStatementPage.tsx',
    'src/renderer/src/pages/assets/AssetsPage.tsx',
  ];
  for (const file of SCREENS) {
    const s = raw(file);
    const name = file.split('/').pop();
    t(`${name} imports the shared letterhead`,
      /import \{[^}]*printHeaderHtml[^}]*\} from '[^']*lib\/printHeader'/.test(s));
    t(`${name} calls it`, /printHeaderHtml\(/.test(s));
    // Importing is worthless if the screen never loads the settings to pass in.
    t(`${name} actually loads the settings`, /settings:getAll/.test(s));
    t(`${name} injects the letterhead CSS`, /printHeaderCss\(/.test(s));
    // ...and worthless again if it loads them but passes something else. A
    // mutant that changed the argument to `{}` printed a blank letterhead and
    // survived every check above.
    t(`${name} passes the LOADED settings, not a literal`,
      /printHeaderHtml\(\s*settings\s*,/.test(s)
      && !/printHeaderHtml\(\s*\{\s*\}/.test(s));
  }
}

// ---------------------------------------------------------------- 6
console.log('\n[6] The phantom global is gone');
{
  // `window.__settings` was read in four places and assigned in none. Any
  // reappearance means a document is silently printing a blank shop name
  // again, which is invisible until a customer receives one.
  const offenders = [];
  const walk = (dir) => {
    const { readdirSync, statSync } = require('node:fs');
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const body = readFileSync(p, 'utf-8');
      // Ignore the explanatory comment in printHeader.ts.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/__settings/.test(code)) offenders.push(p.replace(ROOT + '/', ''));
    }
  };
  const require = createRequire(import.meta.url);
  walk(join(ROOT, 'src'));
  t('no source file reads window.__settings', offenders.length === 0, offenders.join(', '));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
