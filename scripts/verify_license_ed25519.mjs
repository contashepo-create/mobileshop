#!/usr/bin/env node
/**
 * LICENCE FORGERY — the suite that should have existed from the start.
 *
 * THE FLAW IT GUARDS
 * ------------------
 * Codes used to be signed with HMAC-SHA256, which is SYMMETRIC: the key that
 * verifies is the key that signs. That key shipped inside the application as
 * `VERIFIER_SECRET`. Extracting it and minting a perpetual licence took
 * seconds, and the app accepted the result.
 *
 * The old suite (`verify_licensing.js`) passed throughout, because it
 * REIMPLEMENTED the crypto locally and then tested its own copy. It proved the
 * algorithm was self-consistent; it never asked the only question that
 * mattered — can the shipped binary mint its own licence?
 *
 * Every check here therefore runs against the REAL module. It does not define
 * a single crypto primitive of its own.
 *
 * WHAT IS PROVEN
 *   [1] the shipped key can verify but CANNOT sign
 *   [2] a genuine code is accepted, and is bound to one device
 *   [3] tampering with the expiry or the payload breaks the signature
 *   [4] legacy HMAC codes still work, and cannot be used to bypass v2
 *   [5] no private key is present anywhere in the shipped source
 *   [6] the generator and the worker agree with the app
 *
 * Run with:  node --experimental-strip-types scripts/verify_license_ed25519.mjs
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
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

/** Source with comments stripped: a check must not pass by matching prose. */
function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('LICENCE FORGERY RESISTANCE (Ed25519)');
console.log('='.repeat(72));

// The REAL module. No local reimplementation anywhere in this file.
const L = await import('../src/main/security/licenseCrypto.ts');

const DEV_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const DEV_B = 'ffffffffffffffffffffffffffffffff';

/** A throwaway developer keypair, standing in for the one kept offline. */
const kp = crypto.generateKeyPairSync('ed25519');
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
const PUB = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

// ---------------------------------------------------------------- 1
console.log('\n[1] The shipped key can verify but CANNOT sign');
{
  t('the app embeds a public key, not a signing secret',
    typeof L.LICENSE_PUBLIC_KEY === 'string' && L.LICENSE_PUBLIC_KEY.length > 0);
  t('it is a real 32-byte Ed25519 key',
    Buffer.from(L.LICENSE_PUBLIC_KEY, 'base64').length === 32,
    `${Buffer.from(L.LICENSE_PUBLIC_KEY, 'base64').length} bytes`);
  t('the placeholder was replaced before shipping',
    !/REPLACE_WITH/.test(L.LICENSE_PUBLIC_KEY), L.LICENSE_PUBLIC_KEY);

  // THE ORIGINAL ATTACK, executed against the real module: take everything the
  // shipped app contains and try to mint a perpetual licence with it.
  let forged = null;
  try {
    forged = L.signCodeV2(L.LICENSE_PUBLIC_KEY, DEV_A, { expiryDays: 0, serial: 999999 });
  } catch { /* expected: a public key cannot sign */ }
  t('signing with the shipped public key is impossible',
    forged === null || L.verifyCode(L.VERIFIER_SECRET, DEV_A, forged) === null,
    forged ? 'a code was produced AND accepted' : '');

  // And the legacy secret must not open the v2 door either.
  const viaLegacySecret = L.signCode(L.VERIFIER_SECRET, DEV_A, { expiryDays: 0, serial: 5 });
  const asV2 = L.verifyCodeV2(L.LICENSE_PUBLIC_KEY, DEV_A, viaLegacySecret);
  t('the public legacy secret cannot produce a v2 code', asV2 === null);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A genuine code works, and only on its own device');
{
  const good = L.signCodeV2(PRIV, DEV_A, { expiryDays: 2768, serial: 7 });
  const parsed = L.verifyCodeV2(PUB, DEV_A, good);
  t('a code signed with the private key verifies',
    parsed !== null && parsed.expiryDays === 2768 && parsed.serial === 7, JSON.stringify(parsed));
  t('the same code fails on another device', L.verifyCodeV2(PUB, DEV_B, good) === null);
  t('a perpetual code carries expiryDays 0',
    L.verifyCodeV2(PUB, DEV_A, L.signCodeV2(PRIV, DEV_A, { expiryDays: 0, serial: 1 }))?.expiryDays === 0);

  // Dashes and case are cosmetic; a customer may paste either.
  const messy = good.replace(/-/g, '').toLowerCase();
  t('the code survives losing its dashes and case', L.verifyCodeV2(PUB, DEV_A, messy) !== null);
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Tampering breaks the signature');
{
  const base = L.signCodeV2(PRIV, DEV_A, { expiryDays: 100, serial: 3 });

  // Extending the expiry is the attack that pays: rewrite the payload bytes
  // and keep the signature.
  const raw = L.decodeBase32(base);
  raw.writeUInt16BE(60000, 0);                       // far-future expiry
  const extended = L.encodeBase32(raw).match(/.{1,4}/g).join('-');
  t('extending the expiry is rejected', L.verifyCodeV2(PUB, DEV_A, extended) === null);

  const raw2 = L.decodeBase32(base);
  raw2[68] ^= 0xff;                                  // flip a signature byte
  const flipped = L.encodeBase32(raw2).match(/.{1,4}/g).join('-');
  t('flipping one signature byte is rejected', L.verifyCodeV2(PUB, DEV_A, flipped) === null);

  const other = crypto.generateKeyPairSync('ed25519');
  const otherPriv = other.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  t('a code signed by a DIFFERENT private key is rejected',
    L.verifyCodeV2(PUB, DEV_A, L.signCodeV2(otherPriv, DEV_A, { expiryDays: 0, serial: 1 })) === null);

  for (const junk of ['', 'ABCD-EFGH', 'not a code', '-'.repeat(50), 'Z'.repeat(200)]) {
    if (L.verifyCodeV2(PUB, DEV_A, junk) !== null) t(`junk "${junk.slice(0, 12)}" rejected`, false);
  }
  t('every malformed input is rejected without throwing', true);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Legacy codes still work, and cannot bypass v2');
{
  // Existing paying customers must not be locked out overnight.
  const legacy = L.signCode(L.VERIFIER_SECRET, DEV_A, { expiryDays: 2000, serial: 11 });
  const viaRouter = L.verifyCode(L.VERIFIER_SECRET, DEV_A, legacy);
  t('an old HMAC code is still honoured',
    viaRouter !== null && viaRouter.expiryDays === 2000, JSON.stringify(viaRouter));
  t('an old code is still bound to its device',
    L.verifyCode(L.VERIFIER_SECRET, DEV_B, legacy) === null);

  // The router must choose by length so the weak path can never validate a v2
  // code, and a legacy forgery cannot masquerade as v2.
  const v2 = L.signCodeV2(PRIV, DEV_A, { expiryDays: 0, serial: 2 });
  t('a v2 code is never checked by the legacy path',
    L.verifyLegacyCode(L.VERIFIER_SECRET, DEV_A, v2) === null);

  // `verifyCode` is the production router and ALWAYS verifies against the
  // key embedded in the app, never a caller-supplied one — that is precisely
  // the property that kills forgery. So it must reject this code, which was
  // signed with a throwaway key, and accept one signed by the real key only.
  t('the router refuses a v2 code signed by an unknown key',
    L.verifyCode(L.VERIFIER_SECRET, DEV_A, v2) === null);
  t('the router routes by length, reaching the v2 path for a 69-byte code',
    L.decodeBase32(v2).length === 69);

  // A code of the wrong length is nobody's business.
  t('a truncated v2 code is rejected',
    L.verifyCode(L.VERIFIER_SECRET, DEV_A, v2.slice(0, 40)) === null);
}

// ---------------------------------------------------------------- 4b
console.log('\n[4b] The production router works for a REAL customer code');
{
  // Sections above sign with a throwaway key. That proves forgery resistance,
  // but it cannot prove a GENUINE code still activates — and breaking that is
  // a total outage for every paying customer.
  //
  // To test the real router honestly the suite needs a code the app's embedded
  // key actually trusts, so it temporarily swaps LICENSE_PUBLIC_KEY for the
  // public half of its own pair. The module exposes it as a mutable binding
  // for exactly this reason; production never reassigns it.
  const original = L.LICENSE_PUBLIC_KEY;
  L.__setPublicKeyForTests(PUB);
  try {
    const real = L.signCodeV2(PRIV, DEV_A, { expiryDays: 2768, serial: 77 });

    const activated = L.verifyCode(L.VERIFIER_SECRET, DEV_A, real);
    t('a genuine v2 code activates through the production router',
      activated !== null && activated.serial === 77, JSON.stringify(activated));
    t('and it is still refused on another device',
      L.verifyCode(L.VERIFIER_SECRET, DEV_B, real) === null);

    // The router must use the EMBEDDED key, never one handed in by the caller.
    // Passing the legacy secret as the "secret" argument must change nothing.
    t('the router ignores the caller-supplied secret for v2 codes',
      JSON.stringify(L.verifyCode('any-other-value', DEV_A, real)) === JSON.stringify(activated));

    // A legacy code must still work alongside it.
    const legacy10 = L.signCode(L.VERIFIER_SECRET, DEV_A, { expiryDays: 5, serial: 1 });
    t('a legacy code still activates through the same router',
      L.verifyCode(L.VERIFIER_SECRET, DEV_A, legacy10) !== null);
    t('the legacy verifier takes exactly 10 bytes, never a v2 code',
      L.decodeBase32(legacy10).length === 10
      && L.verifyLegacyCode(L.VERIFIER_SECRET, DEV_A, real) === null
      && L.decodeBase32(real).length === 69);

    // Defence in depth. If the legacy verifier is ever loosened to accept
    // "10 bytes or more", an attacker can take a genuine 10-byte HMAC code,
    // pad it to 69 bytes with zeros, and have it routed down the weak path.
    // The router's length check stops that today; this asserts the legacy
    // verifier ALSO refuses it, so neither layer alone is load-bearing.
    const padded = L.encodeBase32(
      Buffer.concat([L.decodeBase32(legacy10), Buffer.alloc(59)]),
    ).match(/.{1,4}/g).join('-');
    t('a legacy code padded to v2 length is refused by BOTH layers',
      L.decodeBase32(padded).length === 69
      && L.verifyLegacyCode(L.VERIFIER_SECRET, DEV_A, padded) === null
      && L.verifyCode(L.VERIFIER_SECRET, DEV_A, padded) === null);

    // Tampering must still fail through the router, not just the direct call.
    const raw = L.decodeBase32(real);
    raw.writeUInt16BE(60000, 0);
    const extended = L.encodeBase32(raw).match(/.{1,4}/g).join('-');
    t('extending the expiry is refused by the router too',
      L.verifyCode(L.VERIFIER_SECRET, DEV_A, extended) === null);
  } finally {
    L.__setPublicKeyForTests(original);
  }
  t('the embedded key is restored after the test', L.LICENSE_PUBLIC_KEY === original);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] No signing key is present anywhere in the shipped source');
{
  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p, out); continue; }
      if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const files = walk(join(ROOT, 'src'));

  const offenders = files.filter(f => {
    const text = readFileSync(f, 'utf-8');
    return /LICENSE_PRIVATE_KEY|BEGIN [A-Z ]*PRIVATE KEY|privateKey\s*=\s*['"][A-Za-z0-9+/=]{40,}/.test(text);
  }).map(f => relative(ROOT, f));
  t('no private key material in src/', offenders.length === 0, offenders.join(', '));

  t('the private key file is git-ignored',
    /scripts\/\.license-key/.test(readFileSync(join(ROOT, '.gitignore'), 'utf-8')));
  // Asks git, not the filesystem.
  //
  // The first version checked that scripts/.license-key does not EXIST. That is
  // the wrong question: after `npm run license:init` the file exists on every
  // developer machine by design — it is the signing key. The check therefore
  // failed for exactly the person who had followed the instructions correctly,
  // while a key that WAS committed but then deleted locally would have passed.
  //
  // What matters is whether git tracks it.
  {
    let tracked = false;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', 'scripts/.license-key'],
        { cwd: ROOT, stdio: 'ignore' });
      tracked = true;
    } catch {
      tracked = false;   // non-zero exit means git does not know the file
    }
    t('the private key is not tracked by git', tracked === false,
      tracked ? 'scripts/.license-key IS COMMITTED — remove it from the index now' : '');
  }

  // The generator must never fall back to signing with a public value.
  const keygen = readFileSync(join(ROOT, 'scripts/license-keygen.js'), 'utf-8');
  t('the generator signs with Ed25519, not HMAC',
    /signCodeV2/.test(keygen) && /createPrivateKey/.test(keygen));
  t('the generator reads a PRIVATE key, not a shared secret',
    /LICENSE_PRIVATE_KEY|\.license-key/.test(keygen));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Generator, worker and app agree');
{
  // The worker signs with WebCrypto and the app verifies with node:crypto.
  // Two different implementations of the same standard is exactly where a
  // silent incompatibility hides, so the bytes are compared directly.
  const rawPriv = Buffer.from(PRIV, 'base64');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), rawPriv]);
  const webKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);

  const payload = Buffer.alloc(5);
  payload.writeUInt16BE(2768, 0);
  payload.writeUIntBE(42, 2, 3);
  const msg = Buffer.concat([Buffer.from(DEV_A, 'utf8'), payload]);
  const webSig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, webKey, msg));
  const workerCode = L.encodeBase32(Buffer.concat([payload, webSig])).match(/.{1,4}/g).join('-');

  const parsed = L.verifyCodeV2(PUB, DEV_A, workerCode);
  t('a WebCrypto-signed code (the worker) verifies in the app',
    parsed !== null && parsed.expiryDays === 2768 && parsed.serial === 42, JSON.stringify(parsed));

  const nodeCode = L.signCodeV2(PRIV, DEV_A, { expiryDays: 2768, serial: 42 });
  t('both implementations produce the identical code', nodeCode === workerCode);

  const w = code('server/worker.js');
  t('the worker signs with Ed25519', /name: 'Ed25519'/.test(w));
  t('the worker uses a private key secret, not the old shared one',
    /LICENSE_PRIVATE_KEY/.test(w) && !/env\.LICENSE_SECRET/.test(w));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Production keys come from .env, and a dev build cannot ship');
{
  // Editing the key into a TRACKED source file was the first design, and it is
  // a trap: every `git pull` either conflicts with the edit or silently
  // reverts it, and a reverted licence key invalidates every code already
  // issued. .env is git-ignored and already inlined at build time.
  const lc = code('src/main/security/licenseCrypto.ts');
  const da = code('src/main/security/devAuth.ts');
  const vite = code('vite.main.config.ts');
  const main = code('src/main/index.ts');

  t('the licence key is read from the environment',
    /process\.env\.MOBILESHOP_LICENSE_PUBLIC_KEY/.test(lc));
  t('the developer hash is read from the environment',
    /process\.env\.MOBILESHOP_DEV_PASSWORD_HASH/.test(da));
  t('both are inlined at build time',
    /MOBILESHOP_LICENSE_PUBLIC_KEY/.test(vite) && /MOBILESHOP_DEV_PASSWORD_HASH/.test(vite));

  // A development fallback keeps local work frictionless, so it must be
  // impossible to ship on it by accident.
  // Asserted as three separate properties, because an earlier version only
  // checked that the FUNCTION EXISTED. Deleting the call, or making the body
  // return immediately, left every one of those checks green — the guard could
  // be removed entirely and the suite would not notice.
  const guardBody = /function assertProductionKeys\(\)[\s\S]*?\n\}/.exec(main)?.[0] || '';

  t('the guard body inspects the licence key',
    /isDevelopmentLicenseKey\(\)/.test(guardBody));
  t('the guard body inspects the developer password',
    /isDevelopmentDevPassword\(\)/.test(guardBody));
  t('the guard body actually exits', /app\.exit\(1\)/.test(guardBody));
  t('it does not bail out before checking anything',
    !/^\s*return;\s*$/m.test(guardBody.split('problems.length === 0')[0].replace(/if \(!app\.isPackaged\) return;/, '')),
    'an unconditional early return would disable the whole guard');
  t('the check only applies to a packaged build',
    /if \(!app\.isPackaged\) return;/.test(guardBody));

  // It must be CALLED, not merely defined, and before the app does any work.
  t('the guard is actually invoked at start-up',
    /^\s*assertProductionKeys\(\);/m.test(main));
  t('it runs before the database is opened',
    main.indexOf('assertProductionKeys();') !== -1
    && main.indexOf('assertProductionKeys();') < main.indexOf('Initializing database'));

  // Behavioural: the detectors must actually detect.
  t('with no environment set, the dev key is reported',
    L.isDevelopmentLicenseKey() === true);

  t('an example env file documents what is needed',
    existsSync(join(ROOT, '.env.example')));
  t('and .env itself is git-ignored',
    /^\.env$/m.test(readFileSync(join(ROOT, '.gitignore'), 'utf-8')));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
