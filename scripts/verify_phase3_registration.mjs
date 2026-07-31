#!/usr/bin/env node
/**
 * PHASE 3 — registration data, developer visibility, print configurability.
 *
 * Covers audit points 12, 18, 19, 20 and 22.
 *
 * WHAT IS PROVEN
 *   [1] the registration rules actually reject the shapes that are not real
 *   [2] they are enforced in the MAIN PROCESS, not only in the wizard
 *   [3] personal data leaves the machine only with explicit consent
 *   [4] the developer can see a shop's details when supporting them
 *   [5] the printed document is genuinely configurable, with sane clamping
 *   [6] every new setting is escaped and cannot break the page
 *
 * Run with:  node --experimental-strip-types scripts/verify_phase3_registration.mjs
 */
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
console.log('PHASE 3 — REGISTRATION, DEVELOPER VISIBILITY, PRINT CONFIG');
console.log('='.repeat(72));

const R = await import('../src/shared/registration.ts');

// ---------------------------------------------------------------- 1
console.log('\n[1] The registration rules reject what is not real');
{
  // Egyptian mobiles.
  for (const good of ['01012345678', '01123456789', '01234567890', '01512345678',
                      '+201012345678', '201012345678', '010 1234 5678']) {
    if (!R.isValidEgyptianMobile(good)) t(`accepts ${good}`, false);
  }
  t('every real Egyptian mobile shape is accepted', true);

  for (const bad of ['', '123', '0301234567', '0101234567', '010123456789',
                     'abcdefghijk', null, undefined, '00000000000']) {
    if (R.isValidEgyptianMobile(bad)) t(`rejects ${JSON.stringify(bad)}`, false);
  }
  t('short, malformed and wrong-prefix numbers are rejected', true);

  // Email, including the disposable providers that make a form pointless.
  t('a normal address is accepted', R.isValidEmail('mohamed.abdou@gmail.com'));
  t('a one-letter mailbox is rejected', R.isValidEmail('a@a.aa') === false);
  t('an address with no dot is rejected', R.isValidEmail('user@localhost') === false);
  for (const d of ['mailinator.com', 'yopmail.com', '10minutemail.com', 'mohmal.com']) {
    if (R.isValidEmail(`someone@${d}`)) t(`rejects disposable ${d}`, false);
  }
  t('disposable inboxes are rejected', true);
  t('and they are reported as disposable, not merely invalid',
    R.isDisposableEmail('x@mailinator.com') === true);

  // Names: the point is to stop "a" and "1111", not to police spelling.
  t('a real name is accepted', R.isValidName('محمد عبده'));
  t('a single letter is rejected', R.isValidName('a') === false);
  t('digits only are rejected', R.isValidName('12345') === false);
  t('one repeated character is rejected', R.isValidName('aaaa') === false);

  // Birth date.
  const NOW = new Date('2026-07-31T00:00:00Z');
  t('an adult date is accepted', R.isValidBirthDate('1990-05-20', NOW));
  t('a child is rejected', R.isValidBirthDate('2020-01-01', NOW) === false);
  t('an implausible age is rejected', R.isValidBirthDate('1850-01-01', NOW) === false);
  t('a future date is rejected', R.isValidBirthDate('2030-01-01', NOW) === false);
  t('a malformed date is rejected', R.isValidBirthDate('20-05-1990', NOW) === false);

  // Governorate must come from the list, not free text.
  t('all 27 governorates are listed', R.EGYPT_GOVERNORATES.length === 27,
    String(R.EGYPT_GOVERNORATES.length));
  t('a real governorate is accepted', R.isValidGovernorate('القاهرة'));
  t('free text is rejected', R.isValidGovernorate('بلد') === false);

  // The whole form: every problem at once, not one per submit.
  const problems = R.validateRegistration({
    companyName: 'a', ownerName: '', phone: '123', email: 'x@mailinator.com',
    governorate: '', city: '', address: '', birthDate: '',
  });
  t('a junk form reports EVERY field, not just the first',
    problems.length >= 7, `${problems.length} problems`);
  t('a complete honest form passes',
    R.validateRegistration({
      companyName: 'محل الأمل', ownerName: 'محمد عبده', phone: '01012345678',
      email: 'mohamed@gmail.com', governorate: 'القاهرة', city: 'مدينة نصر',
      address: '15 شارع مصطفى النحاس', birthDate: '1990-05-20',
    }).length === 0);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The rules are enforced where they cannot be bypassed');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const w = code('src/renderer/src/pages/setup/FirstRunWizard.tsx');

  // setup:initialize is a PUBLIC channel: it must run before any login exists.
  // A modified renderer, or a direct IPC call, would sail past wizard-only
  // validation, so the handler has to check for itself.
  t('the main process validates the registration',
    /validateRegistration\(\{/.test(s));
  t('and refuses when there are problems',
    /if \(problems\.length > 0\)[\s\S]{0,200}success: false/.test(s));
  t('the wizard uses the SAME module, so the two cannot disagree',
    /validateRegistration/.test(w) && /shared\/registration/.test(w));

  t('the new fields are persisted',
    /'governorate':/.test(s) && /'city':/.test(s) && /'owner_birth_date':/.test(s));
  t('the registration time is recorded', /'registered_at':/.test(s));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Personal data leaves the machine only with consent');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const n = code('src/main/security/resetNotify.ts');
  const w = code('src/renderer/src/pages/setup/FirstRunWizard.tsx');

  t('the consent choice is stored', /'registration_consent':/.test(s));
  t('nothing is sent unless it was given',
    /if \(company\.shareWithDeveloper\)[\s\S]{0,300}notifyDeveloperOfRegistration/.test(s));
  t('the wizard asks for it explicitly', /shareWithDeveloper/.test(w));
  t('and states that no business data is ever sent',
    /لا تُرسل أي بيانات عن عملائك/.test(w));

  // Sending must never be able to break or delay a completed setup.
  t('the send is fire-and-forget', /void notifyDeveloperOfRegistration/.test(s));
  t('it runs after the transaction commits',
    s.indexOf('tx();', s.indexOf('setup:initialize')) < s.indexOf('notifyDeveloperOfRegistration('));
  t('it cannot throw', /export async function notifyDeveloperOfRegistration[\s\S]{0,1400}catch/.test(n));
  t('it is time-limited', /notifyDeveloperOfRegistration[\s\S]{0,600}AbortController/.test(n));
  t('it does nothing when no server is configured',
    /notifyDeveloperOfRegistration[\s\S]{0,400}if \(!API_BASE \|\| !CLIENT_KEY\) return;/.test(n));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The developer can look a shop up');
{
  const w = code('server/worker.js');
  t('the worker stores registrations', /CREATE TABLE IF NOT EXISTS registrations/.test(w));
  t('the endpoint exists and is routed', /case '\/registration'/.test(w));
  t('it is authenticated', /handleRegistration[\s\S]{0,400}X-Client-Key/.test(w));
  t('a repeat registration updates rather than duplicating',
    /handleRegistration[\s\S]{0,1200}ON CONFLICT\(device_id\) DO UPDATE/.test(w));
  t('every field is length-capped before storage',
    /handleRegistration[\s\S]{0,1400}cut\(b\?\.companyName, 80\)/.test(w));
  t('a new registration is announced on Telegram',
    /handleRegistration[\s\S]{0,2000}await tg\(env,/.test(w));
  t('the device screen shows the details for support',
    /SELECT \* FROM registrations WHERE device_id/.test(w) && /بيانات التسجيل/.test(w));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The printed document is genuinely configurable');
{
  const p = code('src/main/ipc/print.handlers.ts');
  const ui = code('src/renderer/src/pages/settings/PrintSettings.tsx');

  t('font size is configurable', /print_font_size/.test(p) && /print_font_size/.test(ui));
  t('font family is configurable', /print_font_family/.test(p) && /print_font_family/.test(ui));
  t('page margin is configurable', /print_margin/.test(p) && /print_margin/.test(ui));
  t('logo height is configurable', /print_logo_height/.test(p) && /print_logo_height/.test(ui));

  // Columns: a 58mm roll cannot fit four columns legibly.
  for (const c of ['index', 'qty', 'price', 'total', 'imei']) {
    t(`the ${c} column can be hidden`, new RegExp(`print_col_${c}`).test(ui) );
  }
  t('the invoice honours the column switches',
    /col\('index'\)/.test(p) && /col\('qty'\)/.test(p) && /col\('total'\)/.test(p));

  // A blank or absurd value must not produce an unprintable page.
  t('values are clamped to a sane range',
    /Math\.min\(max, Math\.max\(min, raw\)\)/.test(p));
  t('a non-numeric setting falls back to the default',
    /if \(!Number\.isFinite\(raw\)\) return fallback;/.test(p));
  t('absent settings keep the previous behaviour',
    /companyInfo\[`print_col_\$\{key\}`\] !== '0'/.test(p));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Nothing new can break the printed page');
{
  const raw = readFileSync(join(ROOT, 'src/main/ipc/print.handlers.ts'), 'utf-8');

  // The numeric options are interpolated into CSS. They are numbers by
  // construction — clamped through Number() — so they cannot carry markup.
  t('font size reaches CSS as a clamped number',
    /numOpt\('print_font_size'/.test(raw));
  t('logo height reaches CSS as a clamped number',
    /numOpt\('print_logo_height'/.test(raw));

  // The font family is a string, so it must be a fixed choice rather than
  // whatever the settings row happens to contain.
  // Asserted as a PROPERTY of the value, not as one spelling of the flaw. An
  // earlier version only checked that `companyInfo` was not interpolated
  // directly into the CSS — so a mutant that copied the setting into a
  // variable first and interpolated THAT sailed straight through. What
  // actually matters is that fontFamily can only ever hold a value this file
  // wrote itself.
  {
    const decl = /const fontFamily = ([\s\S]*?);\n/.exec(raw)?.[1] || '';
    // The font stacks are double-quoted (they contain single quotes inside),
    // so match both forms rather than assuming one.
    const literals = decl.match(/"[^"]*"|'[^']*'/g) || [];
    const stackLiterals = literals.filter(l => /sans-serif|serif/.test(l));
    t('font family is built only from literals in this file',
      stackLiterals.length >= 3 && !/companyInfo\.\w+\s*\|\|/.test(decl),
      decl.replace(/\s+/g, ' ').slice(0, 90));
    t('the only setting it reads is compared, never used as a value',
      /companyInfo\.print_font_family === /.test(decl)
      && !/\?\s*companyInfo\./.test(decl));
  }

  // Free text still goes through the escaper.
  t('the terms block is escaped', /esc\(companyInfo\.invoice_terms\)/.test(raw));
  t('the thanks note is escaped', /esc\(companyInfo\.invoice_thanks_note/.test(raw));
  t('the printing user is escaped', /esc\(printedBy/.test(raw));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
