#!/usr/bin/env node
/**
 * PRINTED DOCUMENTS — output-encoding suite.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * The application prints from two unrelated places, and only one of them was
 * safe:
 *
 *   - `src/main/ipc/print.handlers.ts` builds invoices and vouchers in the
 *     main process. It has always escaped every interpolation.
 *
 *   - Four RENDERER screens build their own HTML and hand it straight to
 *     `window.open(...).document.write(...)`:
 *         reports/CustomerStatementPage.tsx
 *         reports/SupplierStatementPage.tsx
 *         reports/EmployeeStatementPage.tsx
 *         assets/AssetsPage.tsx
 *     These escaped NOTHING. `${customer.Name}` and `${op.Description}` went
 *     into the markup verbatim.
 *
 * `customers:create` applies no validation to the name, so a customer saved as
 * `<img src=x onerror=...>` became live markup the moment anyone printed that
 * customer's statement. Stored XSS, triggered by an ordinary accounting task.
 *
 * WHY IT MATTERED MORE THAN A NORMAL XSS
 * --------------------------------------
 * Windows opened with `window.open` inherit the opener's webPreferences, and
 * no `setWindowOpenHandler` overrides them. The main window attaches the
 * preload bundle, so `window.api.invoke` — the entire 238-channel IPC surface —
 * is reachable from script running in the print window. The `data:` URL used
 * by the main-process printer does not inherit the CSP from index.html either,
 * so the policy protects neither path. Escaping at the point of interpolation
 * is the only real defence.
 *
 * WHAT IS PROVEN HERE
 *   [1] the escape helper neutralises real payloads, and is not merely present
 *   [2] it escapes, rather than deletes — the shop still reads the name
 *   [3] every one of the four screens actually calls it
 *   [4] no raw interpolation is left in any HTML-building template
 *   [5] money on a printed page can never be a passthrough for stored text
 *
 * Run with:  node --experimental-strip-types scripts/verify_print_escaping.mjs
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
console.log('PRINTED DOCUMENTS — OUTPUT ENCODING');
console.log('='.repeat(72));

// The four screens that build HTML in the renderer and print it themselves.
const PRINT_SCREENS = [
  'src/renderer/src/pages/reports/CustomerStatementPage.tsx',
  'src/renderer/src/pages/reports/SupplierStatementPage.tsx',
  'src/renderer/src/pages/reports/EmployeeStatementPage.tsx',
  'src/renderer/src/pages/assets/AssetsPage.tsx',
];

// ---------------------------------------------------------------- 1
console.log('\n[1] The escape helper neutralises real payloads');
{
  // Imported and EXECUTED, not pattern-matched. A helper that exists but is
  // wrong is worse than none, because it looks like the problem is solved.
  const { escapeHtml: esc, safeNumber } =
    await import('../src/shared/escapeHtml.ts');

  const ATTACKS = [
    '<img src=x onerror="window.__pwned=1">',
    '<script>window.__pwned=1<\/script>',
    '"><svg onload="window.__pwned=1">',
    "'><iframe src=javascript:1>",
    '</td></tr><script>alert(1)<\/script>',
    '<body onload=alert(1)>',
  ];

  // If the output contains no angle bracket, no parser can build an element.
  // Asserted this way rather than by regex-matching for "<script": a regex
  // that looks for dangerous SUBSTRINGS also matches the harmless text inside
  // an escaped entity, which produces false alarms and hides real ones.
  for (const payload of ATTACKS) {
    const out = esc(payload);
    t(`no element can form from  ${payload.slice(0, 34)}`,
      !out.includes('<') && !out.includes('>'), JSON.stringify(out.slice(0, 50)));
  }

  t('a quote cannot break out of a double-quoted attribute',
    esc('" onmouseover="evil()') === '&quot; onmouseover=&quot;evil()');
  t('nor out of a single-quoted one',
    esc("' onfocus='evil()") === '&#39; onfocus=&#39;evil()');
  t('the ampersand is escaped FIRST, so entities are not double-encoded',
    esc('&lt;') === '&amp;lt;');

  // ------------------------------------------------------------- 2
  console.log('\n[2] It escapes rather than deletes — the document stays readable');
  t('an Arabic name survives intact', esc('محمد عبده') === 'محمد عبده');
  t('markup becomes visible text, not nothing',
    esc('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;');
  t('null and undefined print as empty, not as the words',
    esc(null) === '' && esc(undefined) === '');

  // ------------------------------------------------------------- 5
  console.log('\n[5] Money is never a passthrough for stored text');
  t('a non-numeric value prints 0.00, it does not leak',
    safeNumber('<script>x<\/script>') === '0.00');
  t('a real number is formatted normally', safeNumber(1234.5) === '1234.50');
  t('a numeric string is accepted', safeNumber('12.3') === '12.30');
  t('null becomes 0.00', safeNumber(null) === '0.00');
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Every printing screen actually imports and uses the helper');
for (const file of PRINT_SCREENS) {
  const s = raw(file);
  const short = file.split('/').pop();
  t(`${short} imports the shared helper`,
    /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*'[^']*shared\/escapeHtml'/.test(s));
  // Importing proves nothing if it is never called.
  t(`${short} calls it`, /\besc\(/.test(s));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] No raw interpolation is left in any printed template');
{
  // Scans the HTML-building code for `${...}` that is neither escaped nor a
  // pure literal/arithmetic expression. This is the check that would have
  // caught the original defect, and it is the one that keeps catching it.
  // An expression is SAFE when every branch that can emit a value is either a
  // call to one of the encoders or a string literal. Checking only the start
  // of the expression is not enough: `op.Debit ? safeNumber(op.Debit) : '—'`
  // is perfectly safe but does not begin with `safeNumber(`, and reporting it
  // trains the reader to ignore this check — which is how the real defect
  // would slip back in.
  const isSafeExpression = (expr) => {
    const e = expr.trim();
    if (!e) return true;
    if (/^(esc|escapeHtml|safeNumber)\(/.test(e)) return true;
    // Pure arithmetic / numeric literals emit no stored text.
    if (/^[\d\s+\-*/().]+$/.test(e)) return true;
    // Date formatting produces machine text.
    if (/^new Date\([^)]*\)[.\w()'\-,\s]*$/.test(e)) return true;
    // Nested template built by .map(...) — its own interpolations are visited
    // as part of the same line scan.
    if (/\.map\(/.test(e)) return true;
    // A ternary is safe when BOTH branches are safe. Split on the top-level
    // `?` / `:` only.
    const q = e.indexOf('?');
    if (q > 0) {
      let depth = 0, colon = -1;
      for (let i = q + 1; i < e.length; i++) {
        const c = e[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === '?' ) depth++;
        else if (c === ':' && depth === 0) { colon = i; break; }
        else if (c === ':') depth--;
      }
      if (colon > 0) {
        return isSafeExpression(e.slice(q + 1, colon))
            && isSafeExpression(e.slice(colon + 1));
      }
    }
    // A bare string literal.
    if (/^'[^']*'$/.test(e) || /^"[^"]*"$/.test(e)) return true;
    return false;
  };

  for (const file of PRINT_SCREENS) {
    const src = raw(file);
    const lines = src.split(/\r?\n/);
    // Restrict the scan to the functions that BUILD PRINT HTML. JSX elsewhere
    // in the file is escaped by React itself, so flagging it is noise.
    const offenders = [];
    lines.forEach((line, i) => {
      // A markup-building line: contains a literal HTML tag inside a string.
      if (!/<\/?[a-z][a-z0-9]*[\s>/]/i.test(line)) return;
      // JSX lines start with a bare `<` after indentation, or contain
      // className=/onClick= — those are React, not string concatenation.
      if (/className=|onClick=|onChange=|<\/?[A-Z]/.test(line)) return;
      if (!/['"`]/.test(line)) return;
      for (const m of line.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
        if (!isSafeExpression(m[1])) {
          offenders.push(`line ${i + 1}: ${m[1].trim().slice(0, 60)}`);
        }
      }
    });
    t(`${file.split('/').pop()} has no unescaped interpolation`,
      offenders.length === 0, offenders.slice(0, 3).join(' | '));

    // AssetsPage builds its document by CONCATENATION rather than with
    // template literals:  '<div>' + statementAccount.AccountName + '</div>'.
    // A scanner that only understands `${...}` reports that file as clean
    // while it is fully vulnerable — a mutant proved exactly that. Any value
    // joined onto an HTML string fragment must be encoded too.
    const concatOffenders = [];
    lines.forEach((line, i) => {
      if (!/['"]\s*<\/?[a-z]/i.test(line)) return;      // an HTML string piece
      // Pull out every `+ expr +` / `+ expr,` between string literals.
      for (const m of line.matchAll(/\+\s*([^+'"][^+]*?)\s*\+/g)) {
        const e = m[1].trim();
        if (!e || isSafeExpression(e)) continue;
        // A ternary picking between two literals is inert whatever the
        // condition is — e.g. a colour chosen from the sign of a balance:
        //   ((x || 0) >= 0 ? '#16a34a' : '#dc2626')
        // The condition may contain brackets and comparison operators, so
        // match on the BRANCHES rather than trying to parse the test.
        if (/\?\s*'[^']*'\s*:\s*'[^']*'\s*\)?$/.test(e)) continue;
        concatOffenders.push(`line ${i + 1}: ${e.slice(0, 60)}`);
      }
    });
    t(`${file.split('/').pop()} has no unescaped string concatenation`,
      concatOffenders.length === 0, concatOffenders.slice(0, 3).join(' | '));
  }

  // The main-process printer must keep escaping too — it is the one path that
  // was already correct, and a regression there is just as serious.
  const ph = raw('src/main/ipc/print.handlers.ts');
  t('print.handlers.ts still defines an escaper', /function esc\(/.test(ph));
  t('and still escapes the item name',
    /esc\(item\.ItemName/.test(ph));
  t('and the customer name', /esc\(invoiceData\.customerName/.test(ph));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
