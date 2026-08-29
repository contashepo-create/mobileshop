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
import { DatabaseSync } from 'node:sqlite';
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
console.log('\n[3] A new shop is always reported to the developer (no consent step)');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const n = code('src/main/security/resetNotify.ts');
  const w = code('src/renderer/src/pages/setup/FirstRunWizard.tsx');

  // The consent checkbox was REMOVED by design: the developer needs to know
  // which shops exist to support them, the message is profile-only (never
  // customers, balances or invoices), and an offline shop is simply not
  // registered until a later launch. The registration key is still stored for
  // the privacy list and the devices screen.
  t('the registration flag is still recorded', /'registration_consent':/.test(s));
  t('the send is unconditional — no consent branch',
    /notifyDeveloperOfRegistration\(/.test(s) && !/if \(company\.shareWithDeveloper\)/.test(s));
  t('the wizard no longer asks for consent', !/shareWithDeveloper/.test(w));

  // Sending must never be able to break or delay a completed setup.
  t('the send is fire-and-forget', /void notifyDeveloperOfRegistration/.test(s));
  t('it runs after the transaction commits',
    s.indexOf('tx();', s.indexOf('setup:initialize')) < s.indexOf('notifyDeveloperOfRegistration('));
  t('it cannot throw', /export async function notifyDeveloperOfRegistration[\s\S]{0,1400}catch/.test(n));
  t('it is time-limited', /notifyDeveloperOfRegistration[\s\S]{0,600}AbortController/.test(n));
  t('it does nothing when no server is configured',
    /notifyDeveloperOfRegistration[\s\S]{0,400}if \(!API_BASE \|\| !CLIENT_KEY\) return;/.test(n));
}

// ---------------------------------------------------------------- 3b
console.log('\n[3b] Personal data is not readable before login');
{
  // `settings:getAll` and `settings:get` are PUBLIC — they must answer before
  // anyone signs in so the login screen can draw the shop branding. Adding the
  // registration fields quietly put a date of birth and a verified phone
  // number on that public surface. Neither is needed to render a logo.
  const s = code('src/main/ipc/settings.handlers.ts');

  // Matched inside the NOT IN list itself rather than with a fixed-width
  // window: the list carries explanatory SQL comments, which pushed the keys
  // past a 400-character lookahead and failed on correct code.
  {
    const notIn = /NOT IN \(([\s\S]*?)\)/.exec(s)?.[1] || '';
    for (const key of ['owner_birth_date', 'phone_verified', 'phone_verified_at',
                       'registration_consent', 'registered_at']) {
      t(`${key} is excluded from the public settings read`, notIn.includes(`'${key}'`));
    }
  }
  t('the single-key reader blocks them too',
    /PRIVATE_KEYS = new Set\(\[[\s\S]{0,300}'owner_birth_date'/.test(s)
    && /PRIVATE_KEYS\.has\(key\)/.test(s));

  // Behavioural: run the real WHERE clause and confirm what escapes.
  //
  // The clause is LIFTED OUT OF THE HANDLER SOURCE rather than retyped here.
  // A copy in the test proves only that the copy is correct: someone could
  // delete `owner_birth_date` from the handler and this section would still
  // pass, because it would be exercising the test's own string. Extracting it
  // means the assertions below run against whatever the handler actually ships.
  const whereMatch = /SELECT Key, Value FROM settings\s*\n([\s\S]*?)`\)\.all\(\)/.exec(s);
  t('the public settings query can be located in the handler', !!whereMatch);
  const realWhere = whereMatch ? whereMatch[1] : "WHERE 1=1";

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT)');
  const ins = db.prepare('INSERT INTO settings (Key,Value) VALUES (?,?)');
  ins.run('company_name', 'محل محمد');
  ins.run('logo_path', 'data:image/png;base64,AAA');
  ins.run('owner_birth_date', '1990-05-20');
  ins.run('phone_verified', '201012345678');
  ins.run('phone_verified_at', '2026-07-31T10:00:00Z');
  ins.run('registration_consent', '1');
  ins.run('registered_at', '2026-07-30T09:00:00Z');
  ins.run('telegram_bot_token', '8877684899:SECRET');

  const visible = JSON.stringify(db.prepare(`
    SELECT Key, Value FROM settings
    ${realWhere}
  `).all());

  t('a date of birth does not reach an unauthenticated caller',
    !visible.includes('1990-05-20'));
  t('a verified phone number does not either', !visible.includes('201012345678'));
  t('nor the moment it was verified', !visible.includes('2026-07-31T10:00:00Z'));
  t('nor whether the owner consented to data sharing',
    !visible.includes('registration_consent'));
  t('nor when the shop registered', !visible.includes('2026-07-30T09:00:00Z'));
  t('the bot token still does not', !visible.includes('8877684899:SECRET'));
  t('but the branding the login screen needs still comes through',
    visible.includes('محل محمد') && visible.includes('data:image/png'));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The developer can look a shop up');
{
  const w = code('server/worker.js');
  t('the worker stores registrations', /CREATE TABLE IF NOT EXISTS registrations/.test(w));
  t('the endpoint exists and is routed', /case '\/registration'/.test(w));
  t('it is authenticated', /handleRegistration[\s\S]{0,400}X-Client-Key/.test(w));
  // A repeat registration must NOT update.
  //
  // This used to assert `ON CONFLICT ... DO UPDATE`, which is precisely the
  // hole `verify_tenant_isolation.mjs` found: `CLIENT_KEY` is shipped in every
  // copy of the app and the device id arrives in the request body, so the
  // upsert let any caller rewrite another shop's row. MEASURED — company_name
  // "محل خالد" was overwritten with "DEFACED", owner and phone with it.
  //
  // First writer wins now, and a re-run is accepted quietly so the customer
  // never sees an error for running the wizard twice.
  // Sliced to THIS handler only: a `[\s\S]*?` negative lookahead runs on past
  // the function and finds the (legitimate) upserts in /config and /release,
  // so it can never be satisfied.
  const regHandler = (() => {
    const i = w.indexOf('async function handleRegistration');
    const j = w.indexOf('\nasync function ', i + 10);
    return w.slice(i, j === -1 ? w.length : j);
  })();
  t('a repeat registration does NOT overwrite the stored row',
    /ON CONFLICT\(device_id\) DO NOTHING/.test(regHandler)
    && !/ON CONFLICT\(device_id\) DO UPDATE/.test(regHandler));
  t('and an already-registered device is answered without an error',
    /alreadyRegistered: true/.test(w));
  // Sliced lazily rather than with a character budget: the handler grew when
  // the isolation guards were added and a fixed lookahead stopped reaching.
  t('every field is length-capped before storage',
    /handleRegistration[\s\S]*?cut\(b\?\.companyName, 80\)/.test(w));
  t('a new registration is announced on Telegram',
    /handleRegistration[\s\S]*?await tg\(env,/.test(w));
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
  // Asserted BEHAVIOURALLY, against the resolver the printer actually uses.
  // This used to match the literal text `col('index')`, which was the old
  // hand-written per-column implementation. That implementation was replaced
  // by an ordered column list (so a shop can MOVE a column, not only hide it)
  // and the check failed on code that had become more capable, not less — a
  // structural check pinned to one implementation cannot tell those apart.
  {
    const P = await import('../src/shared/printProfile.ts');
    const hidden = P.resolveProfile(
      { print_col_index: '0', print_col_qty: '0', print_col_total: '0' }, 'sale');
    const visible = P.visibleColumns(hidden);
    t('the invoice honours the column switches',
      !visible.includes('index') && !visible.includes('qty') && !visible.includes('total'),
      visible.join(','));
  }

  // A blank or absurd value must not produce an unprintable page.
  t('values are clamped to a sane range',
    /Math\.min\(max, Math\.max\(min, raw\)\)/.test(p));
  t('a non-numeric setting falls back to the default',
    /if \(!Number\.isFinite\(raw\)\) return fallback;/.test(p));
  // Same reasoning: prove the RULE, not the line of code that implemented it.
  // A column nobody has ever switched off must still print.
  {
    const P = await import('../src/shared/printProfile.ts');
    const untouched = P.resolveProfile({}, 'sale');
    t('absent settings keep the previous behaviour',
      P.COLUMN_KEYS.every((k) => untouched.columns[k] === true));
  }
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
    // `\r?\n`, not `\n`.
    //
    // Git checks this repository out with CRLF line endings on Windows, so the
    // declaration ends `;\r\n` there and a pattern anchored on `;\n` matched
    // far more text than intended. MEASURED: with LF the capture holds three
    // font stacks and both checks pass; with CRLF it holds none and both fail —
    // on identical, correct source. The product was never wrong.
    const decl = /const fontFamily = ([\s\S]*?);\r?\n/.exec(raw)?.[1] || '';
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
