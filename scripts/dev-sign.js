#!/usr/bin/env node
/**
 * Signs a developer-console challenge.
 *
 * WHY THIS EXISTS
 * ---------------
 * The console used to be opened by a password alone, and a bcrypt hash of that
 * password shipped inside every build. Rate limiting protects the live dialog
 * and nothing else: once the hash is pulled out of app.asar it is ground
 * offline, at the attacker's pace, on their hardware. That is not a weak
 * password, it is what a SHARED SECRET means — anything the app can check, the
 * app must contain.
 *
 * So the app no longer contains it. It issues a random challenge; this script
 * signs that challenge with the Ed25519 PRIVATE key that lives only on the
 * developer's machine; the app verifies with the PUBLIC key it already embeds
 * for licensing. Unpacking the build yields a verifier and no way to sign.
 *
 * USAGE
 *   1. Open the developer console in the app and press "اطلب تحدياً".
 *   2. Run, on YOUR machine:      npm run dev:sign -- <nonce>
 *   3. Paste the signature back, together with the password.
 *
 * The password is still required. Two independent factors: stealing the key
 * without the password opens nothing, and cracking the password without the
 * key opens nothing either.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_FILE = path.join(__dirname, '.license-key');

function fail(msg) {
  console.error(`\n\u274c ${msg}\n`);
  process.exit(1);
}

const nonce = (process.argv[2] || '').trim();
if (!nonce) {
  fail('Usage: npm run dev:sign -- <nonce>\n'
     + '   Get the nonce from the developer console in the app.');
}
// The nonce is 24 random bytes rendered as hex. Checking the shape here turns
// a paste error into a clear message rather than an "invalid signature" later,
// which would look like a key problem and send the search in the wrong place.
if (!/^[0-9a-f]{48}$/.test(nonce)) {
  fail(`That does not look like a challenge nonce.\n`
     + `   Expected 48 hex characters, received ${nonce.length}.`);
}

let privateKeyB64 = process.env.MOBILESHOP_LICENSE_PRIVATE_KEY || '';
if (!privateKeyB64) {
  try {
    // Same file the licence keygen uses, so there is one private key to guard
    // rather than two. The file holds plain base64 text (written by
    // license-keygen.js), not JSON.
    privateKeyB64 = fs.readFileSync(KEY_FILE, 'utf-8').trim();
  } catch { /* reported below */ }
}
if (!privateKeyB64) {
  fail('No signing key found.\n'
     + `   Expected ${KEY_FILE} (created by: npm run license:init)\n`
     + '   or the MOBILESHOP_LICENSE_PRIVATE_KEY environment variable.');
}

let signature;
try {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(privateKeyB64, 'base64'),
  ]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  // Domain-separated: this string is not a licence message, so a licence
  // signature can never be replayed as a console login and vice versa.
  const message = Buffer.from(`mobileshop-dev-console:v1:${nonce}`, 'utf8');
  signature = crypto.sign(null, message, key).toString('base64');
} catch (err) {
  fail(`Could not sign with that key: ${err.message}`);
}

console.log('');
console.log('='.repeat(64));
console.log('  \u062a\u0648\u0642\u064a\u0639 \u062a\u062d\u062f\u064a \u0644\u0648\u062d\u0629 \u0627\u0644\u0645\u0637\u0648\u0631');
console.log('='.repeat(64));
console.log('');
console.log('  Nonce      :', nonce);
console.log('');
console.log('  Signature  :');
console.log('');
console.log('    ' + signature);
console.log('');
console.log('  \u0627\u0646\u0633\u062e \u0627\u0644\u062a\u0648\u0642\u064a\u0639 \u0623\u0639\u0644\u0627\u0647 \u0648\u0627\u0644\u0635\u0642\u0647 \u0641\u064a \u0627\u0644\u0628\u0631\u0646\u0627\u0645\u062c \u0645\u0639 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631.');
console.log('  \u0635\u0627\u0644\u062d \u0644\u0645\u062f\u0629 \u0640 5 \u062f\u0642\u0627\u0626\u0642 \u0648\u0644\u0645\u0631\u0629 \u0648\u0627\u062d\u062f\u0629 \u0641\u0642\u0637.');
console.log('');
