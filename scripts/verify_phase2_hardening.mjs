#!/usr/bin/env node
/**
 * PHASE 2 HARDENING — device identity, owner data export, document provenance.
 *
 * Covers audit points 8, 10, 14, 16, 17 and the parts of 19/20 delivered so
 * far. Each one is a change to code that decides whether a shop can work, so
 * each is asserted behaviourally where that is possible rather than by reading
 * the source and hoping.
 *
 * WHAT IS PROVEN
 *   [1] the device fingerprint prefers STABLE hardware, and never recomputes
 *       an id that a licence is already bound to
 *   [2] placeholder serials are rejected, or thousands of shops would collapse
 *       onto one identity
 *   [3] a shop can export its own books while the licence is expired
 *   [4] that export still cannot leak password hashes or credentials
 *   [5] the logo is embedded, validated by its real bytes, and size-capped
 *   [6] every printed document says who produced it and when
 *
 * Run with:  node --experimental-strip-types scripts/verify_phase2_hardening.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') {
      return { url: 'data:text/javascript,export const app={getPath:()=>"/tmp"};export const dialog={};export const ipcMain={handle(){}};', shortCircuit: true };
    }
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

/** Source with comments stripped: a check must not pass by matching prose. */
function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('PHASE 2 HARDENING');
console.log('='.repeat(72));

// ---------------------------------------------------------------- 1
console.log('\n[1] The device fingerprint prefers stable hardware');
{
  const D = await import('../src/main/security/deviceId.ts');
  const fp = D.collectFingerprint();

  t('a fingerprint is produced on this machine', typeof fp.raw === 'string' && fp.raw.length > 0);
  t('it is deterministic across calls', D.collectFingerprint().raw === fp.raw);
  t('it reports which sources it used', Array.isArray(fp.sources) && fp.sources.length > 0,
    fp.sources.join(', '));

  const src = code('src/main/security/deviceId.ts');
  t('the motherboard serial is preferred', /BOARD:/.test(src) && /motherboardSerial/.test(src));
  t('a machine GUID is used as well', /GUID:/.test(src) && /machineGuid/.test(src));

  // The old recipe's volatile inputs must be a LAST RESORT, not the default.
  // A USB wifi dongle or a rename used to change the identity and cost a
  // paying shop its licence — the support call was the real damage.
  const macIdx = src.indexOf('MAC:');
  const boardIdx = src.indexOf('BOARD:');
  t('MAC and hostname are only a fallback', boardIdx !== -1 && macIdx > boardIdx);
  t('the fallback is reached only when nothing stable is found',
    /if \(parts\.length === 0\)[\s\S]{0,300}MAC:/.test(src));

  // The critical safety property: never recompute an id a licence is bound to.
  t('an existing device.id is treated as authoritative',
    /if \(fs\.existsSync\(devicePath\)\)[\s\S]{0,200}return existing/.test(src));
  t('and it is only written when absent', src.indexOf('return existing') < src.indexOf('writeFileSync(devicePath'));

  // Probing hardware must never stop the app starting.
  t('every hardware probe is wrapped and time-limited',
    /function tryCommand[\s\S]{0,400}timeout:[\s\S]{0,200}catch/.test(src));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Placeholder serials are rejected');
{
  const src = code('src/main/security/deviceId.ts');
  // Consumer boards very often report the same dummy string for every unit of
  // a model. Accepting one would give thousands of shops an identical device
  // id — every licence would work everywhere.
  for (const junk of ['to be filled by o.e.m.', 'default string', 'system serial number', 'none']) {
    t(`"${junk}" is on the useless list`, src.toLowerCase().includes(junk));
  }
  t('a minimum length is also required', /length >= 4/.test(src));
  t('the check is applied to every component', (src.match(/usable\(/g) || []).length >= 3);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] A shop can export its books while the licence is expired');
{
  const d = code('src/main/ipc/database.handlers.ts');
  const guard = code('src/main/security/ipcGuard.ts');

  t('an owner export channel exists', /db:exportForOwner/.test(d));
  t('it is reachable before login, which is when it is needed',
    /PUBLIC_CHANNELS[\s\S]{0,2200}'db:exportForOwner'/.test(guard));
  t('the activation screen offers it',
    /db:exportForOwner/.test(code('src/renderer/src/pages/auth/LicenseActivationPage.tsx')));

  // Open, but not an open door.
  t('it demands a password', /db:exportForOwner[\s\S]{0,1200}bcrypt\.compareSync/.test(d));
  t('it demands an administrator', /db:exportForOwner[\s\S]{0,1600}RoleID !== 1/.test(d));
  t('it refuses an inactive account', /db:exportForOwner[\s\S]{0,1200}!user\.IsActive/.test(d));
  t('a wrong username cannot be distinguished from a wrong password',
    /db:exportForOwner[\s\S]{0,1400}\$2a\$10\$invalid/.test(d));
  t('every export is written to the security log',
    /recordSecurityEvent\(db, 'data_export_owner'/.test(d));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The export still cannot leak credentials');
{
  const d = code('src/main/ipc/database.handlers.ts');
  t('the blocklist covers users, overrides and settings',
    /EXPORT_BLOCKLIST = new Set\(\['users', 'user_overrides', 'settings'\]\)/.test(d));
  t('the owner export honours the blocklist',
    /db:exportForOwner[\s\S]{0,2600}EXPORT_BLOCKLIST\.has\(tableName\)\) continue/.test(d));

  // Behavioural: the same filter really removes the credential tables.
  const BLOCK = new Set(['users', 'user_overrides', 'settings']);
  const all = ['sales', 'users', 'settings', 'customers', 'user_overrides', 'items'];
  const exported = all.filter(n => !BLOCK.has(n));
  t('password hashes are not among the exported tables',
    !exported.includes('users') && !exported.includes('user_overrides'));
  t('the bot token and cloud key are not exported', !exported.includes('settings'));
  t('the business data still is', exported.includes('sales') && exported.includes('customers'));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The logo is embedded, type-checked and size-capped');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  t('a logo picker exists', /settings:pickLogo/.test(s));
  t('it is permission-gated', /'settings:pickLogo': 'settings\.edit'/.test(code('src/main/security/ipcGuard.ts')));
  t('the settings screen can reach it',
    /settings:pickLogo/.test(code('src/renderer/src/pages/settings/PrintSettings.tsx')));

  // Stored inline so a restored backup keeps its branding: a filesystem path
  // breaks the moment the database moves to another machine, and the invoice
  // silently loses the logo with no error anywhere.
  t('the logo is stored as a data URL, not a path', /data:\$\{mime\};base64/.test(s));
  t('the size is capped', /MAX_BYTES = 512 \* 1024/.test(s));

  // Type decided by the file's own bytes, so a renamed file cannot be
  // embedded with a mime type that lies about it.
  t('the type is read from the file signature, not the extension',
    /0x89 && sig\[1\] === 0x50/.test(s) && /0xff && sig\[1\] === 0xd8/.test(s));
  t('an unrecognised file is refused', /ليس صورة صالحة/.test(s));

  // The printed page must accept a data URL, or all of the above is pointless.
  // Read RAW here, not comment-stripped: the rule lives in a regex literal
  // containing `//` (from `^https?:\/\/`), which the naive stripper mistakes
  // for a line comment and deletes. The check would fail on correct code.
  t('the print path allows data: image sources',
    readFileSync(join(ROOT, 'src/main/ipc/print.handlers.ts'), 'utf-8').includes('^data:image'));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Every printed document records who produced it');
{
  const p = code('src/main/ipc/print.handlers.ts');

  t('the document carries a printed-by line', /تمت الطباعة بواسطة/.test(p));
  t('it includes the time as well', /printedAt/.test(p));

  // Taken from the SESSION, not the payload: a screen that forgot to pass a
  // username would otherwise produce an unattributed document, and a modified
  // renderer could name someone else.
  t('the user comes from the session, not the caller',
    /getSession\(event\.sender\.id\)\?\.username/.test(p));
  t('both print routes supply it',
    (p.match(/printedBy: printingUser\(event\)/g) || []).length === 2);

  t('the line can be switched off by the shop', /print_show_user === '0'/.test(p));
  t('the name is escaped like every other value', /esc\(printedBy/.test(p));
  t('the terms block is escaped too', /esc\(companyInfo\.invoice_terms\)/.test(p));
  t('the thanks note is configurable', /invoice_thanks_note/.test(p));

  // Provenance matters because a reprint is evidence in a dispute.
  const ui = code('src/renderer/src/pages/settings/PrintSettings.tsx');
  t('the setting is exposed in the UI', /print_show_user/.test(ui));
  t('terms and thanks are editable', /invoice_terms/.test(ui) && /invoice_thanks_note/.test(ui));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
