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
 *   [4] the forgeable HMAC path is GONE — old codes are refused outright
 *   [5] no private key is present anywhere in the shipped source
 *   [6] the generator and the worker agree with the app
 *
 * Run with:  node --experimental-strip-types scripts/verify_license_ed25519.mjs
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    forged === null || L.verifyCode('', DEV_A, forged) === null,
    forged ? 'a code was produced AND accepted' : '');

  // And the retired secret must not open the v2 door either.
  const viaLegacySecret = L.signLegacyCodeForTests(
    'w/Y8yrd9F9WSt1OMZWdM9Hx88g0tj1c6XRQEQbt+DI0=', DEV_A, { expiryDays: 0, serial: 5 });
  const asV2 = L.verifyCodeV2(L.LICENSE_PUBLIC_KEY, DEV_A, viaLegacySecret);
  t('the retired symmetric secret cannot produce a v2 code', asV2 === null);
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
console.log('\\n[4] The forgeable HMAC path is GONE');
{
  // This section used to assert the OPPOSITE: that old HMAC codes were still
  // honoured so existing customers were not locked out. There are no
  // customers — the product has not shipped — so the compatibility that
  // justified keeping a forgeable path no longer exists.
  //
  // The original attack, reproduced: the symmetric secret shipped in every
  // build, and HMAC verifies with the same key it signs with. That constant
  // alone minted a PERPETUAL licence for an arbitrary device id, and the
  // router accepted it because a 10-byte code went down the weak path.
  const RETIRED = 'w/Y8yrd9F9WSt1OMZWdM9Hx88g0tj1c6XRQEQbt+DI0=';
  const forgedPerpetual = L.signLegacyCodeForTests(RETIRED, 'ANY-DEVICE-I-LIKE', { expiryDays: 0, serial: 1 });
  t('the old attack still PRODUCES a code (the maths has not changed)',
    typeof forgedPerpetual === 'string' && forgedPerpetual.length > 0, forgedPerpetual);
  t('but the application now REFUSES it',
    L.verifyCode('', 'ANY-DEVICE-I-LIKE', forgedPerpetual) === null);

  const legacy = L.signLegacyCodeForTests(RETIRED, DEV_A, { expiryDays: 2000, serial: 11 });
  t('a dated legacy code is refused too', L.verifyCode('', DEV_A, legacy) === null);
  t('and refused on every device', L.verifyCode('', DEV_B, legacy) === null);

  // The exports that made the weak path reachable are gone, not merely unused.
  t('verifyLegacyCode is no longer exported', typeof L.verifyLegacyCode === 'undefined');
  t('the shipped symmetric secret is no longer exported', typeof L.VERIFIER_SECRET === 'undefined');
  t('the production HMAC signer is gone', typeof L.signCode === 'undefined');

  const v2 = L.signCodeV2(PRIV, DEV_A, { expiryDays: 0, serial: 2 });

  // Nothing a caller passes can influence verification any more.
  const good = L.signCodeV2(PRIV, DEV_A, { expiryDays: 2000, serial: 3 });
  t('a caller-supplied secret changes nothing',
    String(L.verifyCode('nonsense', DEV_A, good)) === String(L.verifyCode(RETIRED, DEV_A, good)));

  // `verifyCode` is the production router and ALWAYS verifies against the
  // key embedded in the app, never a caller-supplied one — that is precisely
  // the property that kills forgery. So it must reject this code, which was
  // signed with a throwaway key, and accept one signed by the real key only.
  t('the router refuses a v2 code signed by an unknown key',
    L.verifyCode('', DEV_A, v2) === null);
  t('the router routes by length, reaching the v2 path for a 69-byte code',
    L.decodeBase32(v2).length === 69);

  // A code of the wrong length is nobody's business.
  t('a truncated v2 code is rejected',
    L.verifyCode('', DEV_A, v2.slice(0, 40)) === null);
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

    const activated = L.verifyCode('', DEV_A, real);
    t('a genuine v2 code activates through the production router',
      activated !== null && activated.serial === 77, JSON.stringify(activated));
    t('and it is still refused on another device',
      L.verifyCode('', DEV_B, real) === null);

    // The router must use the EMBEDDED key, never one handed in by the caller.
    // Passing the legacy secret as the "secret" argument must change nothing.
    t('the router ignores the caller-supplied secret for v2 codes',
      JSON.stringify(L.verifyCode('any-other-value', DEV_A, real)) === JSON.stringify(activated));

    // A legacy code must NOT work alongside it any more.
    const legacy10 = L.signLegacyCodeForTests('w/Y8yrd9F9WSt1OMZWdM9Hx88g0tj1c6XRQEQbt+DI0=', DEV_A, { expiryDays: 5, serial: 1 });
    t('a legacy code is refused by the router',
      L.verifyCode('', DEV_A, legacy10) === null);
    t('it really is a 10-byte code, and a real one is 69',
      L.decodeBase32(legacy10).length === 10 && L.decodeBase32(real).length === 69);

    // The padding attack, retested against the new rule. Previously the
    // concern was that a loosened legacy verifier might accept a 10-byte code
    // padded out to 69 bytes. There is no legacy verifier now, so the padded
    // code reaches the Ed25519 path — where it fails, because zeros are not a
    // signature. Kept because it exercises the ONE surviving door with input
    // shaped to look legitimate.
    const padded = L.encodeBase32(
      Buffer.concat([L.decodeBase32(legacy10), Buffer.alloc(59)]),
    ).match(/.{1,4}/g).join('-');
    t('a legacy code padded to v2 length is still refused',
      L.decodeBase32(padded).length === 69 && L.verifyCode('', DEV_A, padded) === null);

    // Tampering must still fail through the router, not just the direct call.
    const raw = L.decodeBase32(real);
    raw.writeUInt16BE(60000, 0);
    const extended = L.encodeBase32(raw).match(/.{1,4}/g).join('-');
    t('extending the expiry is refused by the router too',
      L.verifyCode('', DEV_A, extended) === null);
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

  // A bcrypt hash cannot survive .env in its raw form: Vite loads the file
  // through dotenv-expand, which reads `$12$abc` as a variable reference and
  // truncates `$2a$12$hUAAv...` to `$2a$12`. bcrypt then rejects every
  // password with no error anywhere — reported as "the developer console
  // refuses my password". Base64 has no `$` to expand.
  t('the hash is accepted in a base64 form that .env cannot mangle',
    /MOBILESHOP_DEV_PASSWORD_HASH_B64/.test(da));
  t('a truncated raw hash is refused rather than used',
    /\^\\\$2\[aby\]\\\$\\d\{2\}\\\$\.\{53\}\$/.test(da));
  t('and the refusal explains why', /truncated/.test(da) && /expanded/.test(da));
  t('the generator prints the base64 form',
    /HASH_B64=/.test(code('scripts/dev-password.js')));
  t('the build inlines the base64 form',
    /MOBILESHOP_DEV_PASSWORD_HASH_B64/.test(vite));

  // Behavioural, against the REAL module rather than its source text.
  //
  // A structural check here was not enough: the file contains the same shape
  // test twice (once for the base64 branch, once for the raw one), so deleting
  // the RAW guard — which is what actually lets a mangled hash through — left
  // the regex still present and every check green. The mutant survived.
  //
  // Loading devAuth with a deliberately truncated value settles it: if the
  // guard is gone, the module adopts the broken hash and stops reporting the
  // development fallback.
  {
    const loader = 'data:text/javascript,' + encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      export async function resolve(s, c, n) {
        if (s === 'bcryptjs') {
          return { url: 'data:text/javascript,export default {compareSync:()=>false,hashSync:()=>"x"};', shortCircuit: true };
        }
        if (s.startsWith('.') && !/\\.[a-z]+$/.test(s)) {
          const u = new URL(s + '.ts', c.parentURL || import.meta.url).href;
          if (existsSync(fileURLToPath(u))) return { url: u, shortCircuit: true };
        }
        return n(s, c);
      }
    `);
    const probe = `
      import { register } from 'node:module';
      register(${JSON.stringify(loader)}, import.meta.url);
      const D = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/main/security/devAuth.ts')).href)});
      process.stdout.write(String(D.isDevelopmentDevPassword()));
    `;
    // The child must NOT inherit this machine's environment.
    //
    // `{ ...process.env, ...env }` looked harmless and was not. On a developer
    // machine with a real `.env`, dotenv has already put
    // MOBILESHOP_DEV_PASSWORD_HASH_B64 into `process.env` before this suite
    // runs, so the child saw a VALID hash no matter which case was being set
    // up. All four checks in this block failed — on a correctly configured
    // machine, and only there. MEASURED: the same four pass on a clean
    // environment and fail as soon as a real .env exists, while the guard
    // being tested behaves identically in both.
    //
    // A test that fails BECAUSE the product is configured properly is worse
    // than no test: it trains the reader to ignore a red line.
    //
    // Only the few variables Node itself needs are forwarded. Everything the
    // case under test cares about is set explicitly, so the child's state is
    // exactly what the case describes.
    let lastProbeError = '';
    const run = (env) => {
      // SUBTRACT the polluting variables; do not try to LIST the needed ones.
      //
      // The first attempt built a minimal allow-list (PATH, SystemRoot, TEMP,
      // HOME, ...). It worked on Linux and broke every check on Windows,
      // including the probe-runs guard — Windows needs a set of variables that
      // is longer and less predictable than it looks, and their NAMES are
      // case-insensitive there, so `SystemRoot` may be stored as `SYSTEMROOT`
      // and an exact-key copy silently misses it.
      //
      // Guessing what an OS needs to start a process is the wrong problem to
      // solve. The only variables that must not survive are the two this suite
      // sets up itself, so those are deleted and everything else is inherited.
      const child = { ...process.env };
      for (const key of Object.keys(child)) {
        const k = key.toUpperCase();
        if (k === 'MOBILESHOP_DEV_PASSWORD_HASH' || k === 'MOBILESHOP_DEV_PASSWORD_HASH_B64') {
          delete child[key];   // case-insensitive on Windows, exact on POSIX
        }
      }
      try {
        return execFileSync(process.execPath,
          ['--experimental-strip-types', '--input-type=module', '--eval', probe],
          { env: { ...child, ...env }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch (err) {
        // The reason is KEPT, not swallowed.
        //
        // `catch { return 'error' }` made every environment or path problem
        // look identical to a security failure, and cost two rounds of guessing
        // at a Windows-only fault that could not be reproduced on Linux. The
        // first line of stderr names it immediately.
        lastProbeError = String(err && err.stderr ? err.stderr : (err && err.message) || err)
          .split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 400);
        return 'error';
      }
    };

    const cleanEnv = { MOBILESHOP_DEV_PASSWORD_HASH: '', MOBILESHOP_DEV_PASSWORD_HASH_B64: '' };

    // Prove the harness itself works before trusting its verdicts. If the child
    // cannot start at all, every check below would report 'error' and read as a
    // security failure.
    const probeVerdict = run({ ...cleanEnv });
    t('the probe process runs (its verdicts are meaningful)',
      probeVerdict !== 'error',
      probeVerdict === 'error' ? lastProbeError : '');
    t('a truncated raw hash is refused, falling back rather than breaking login',
      run({ ...cleanEnv, MOBILESHOP_DEV_PASSWORD_HASH: '$2a$12' }) === 'true');
    t('a truncated base64 hash is refused too',
      run({ ...cleanEnv, MOBILESHOP_DEV_PASSWORD_HASH_B64: Buffer.from('$2a$12').toString('base64') }) === 'true');

    const realHash = '$2a$12$' + 'x'.repeat(53);
    t('a complete base64 hash IS adopted',
      run({ ...cleanEnv, MOBILESHOP_DEV_PASSWORD_HASH_B64: Buffer.from(realHash).toString('base64') }) === 'false');
    t('a complete raw hash is still accepted for anyone who escaped the dollars',
      run({ ...cleanEnv, MOBILESHOP_DEV_PASSWORD_HASH: realHash }) === 'false');
  }
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
  // The guard must not short-circuit before it inspects anything. Checked by
  // ORDER rather than by looking for a bare `return`: the development branch
  // legitimately returns early, and a naive text search cannot tell that apart
  // from a return that disables the whole thing.
  {
    const iPackagedCheck = guardBody.indexOf('app.isPackaged');
    const iFirstInspect = Math.min(
      ...['isDevelopmentLicenseKey()', 'isDevelopmentDevPassword()']
        .map(k => guardBody.indexOf(k)).filter(i => i >= 0),
    );
    const iExit = guardBody.indexOf('app.exit(1)');
    t('the packaged path inspects the keys before it can exit',
      iPackagedCheck >= 0 && iFirstInspect > iPackagedCheck && iExit > iFirstInspect,
      `isPackaged@${iPackagedCheck} inspect@${iFirstInspect} exit@${iExit}`);

    // The exit must be REACHABLE. Turning the early return that skips a clean
    // build into an unconditional one leaves every check above green — the
    // keys are still inspected, app.exit(1) is still present further down —
    // while a development-key build ships anyway. So the only `return` allowed
    // between the inspection and the exit is the guarded one.
    // Measure from where the PACKAGED path begins collecting problems, not
    // from the first inspection: the development branch above it inspects the
    // same keys and then legitimately returns, and including that would
    // condemn correct code.
    //
    // Inside that region the single allowed early exit is "no problems, carry
    // on"; strip it, and anything still returning on its own line makes
    // app.exit(1) unreachable while every other check stays green.
    const iCollect = guardBody.indexOf('const problems');
    const between = guardBody.slice(iCollect >= 0 ? iCollect : iFirstInspect, iExit)
      .replace(/if \(problems\.length === 0\) return;/g, '');
    const bareReturns = (between.match(/^\s*return;\s*$/gm) || []).length;
    t('nothing unconditionally returns before the exit is reached',
      bareReturns === 0,
      `${bareReturns} bare return(s) would make app.exit(1) unreachable`);
    t('the only early exit is the one taken when there are no problems',
      /if \(problems\.length === 0\) return;/.test(guardBody));
  }
  t('the check only applies to a packaged build',
    /if \(!app\.isPackaged\)/.test(guardBody) && /return;/.test(guardBody));

  // Development is allowed to use the fallbacks — but not silently. Without a
  // startup line, "my .env is loaded" and "no .env, quietly using the test
  // key" look identical, and the only way to tell was to package a build and
  // watch it refuse to start.
  t('development startup says WHICH keys are in use',
    /development \$\{which\} in use/.test(guardBody));
  t('and confirms when the real ones are loaded',
    /production keys loaded from \.env/.test(guardBody));

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
