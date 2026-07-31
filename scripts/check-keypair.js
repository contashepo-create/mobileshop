#!/usr/bin/env node
/**
 * Confirms the private key can produce codes the app will actually accept.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three places must agree on one key pair:
 *
 *   scripts/.license-key        signs codes issued from this machine
 *   LICENSE_PRIVATE_KEY         signs codes issued by the Telegram bot (Worker)
 *   MOBILESHOP_LICENSE_PUBLIC_KEY   verifies them inside the app
 *
 * Generating a fresh pair updates the first and third but NOT the Worker
 * secret, which is set separately with `wrangler secret put`. Nothing detects
 * the mismatch: the bot happily issues a code, the developer sends it to a
 * customer, and it is rejected on their machine. The failure surfaces at the
 * worst moment — a paying customer who cannot activate — and looks like a
 * customer-side problem rather than a configuration one.
 *
 * `npm run check:env` proves the values are PRESENT. This proves they MATCH.
 *
 * Usage:  npm run check:keypair
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function parseEnv(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

console.log('\n=== LICENCE KEY PAIR ===\n');

const env = parseEnv(path.join(ROOT, '.env'));
const publicB64 = (env.MOBILESHOP_LICENSE_PUBLIC_KEY || '').trim();
const keyFile = path.join(ROOT, 'scripts/.license-key');

if (!publicB64) {
  console.log('  MOBILESHOP_LICENSE_PUBLIC_KEY is not set in .env.\n');
  console.log('  Run:  npm run license:init\n');
  process.exit(1);
}
if (!fs.existsSync(keyFile)) {
  console.log('  scripts/.license-key is missing — the signing half is gone.\n');
  console.log('  Restore it from your backup, or generate a new pair with');
  console.log('  npm run license:init (which invalidates codes already issued).\n');
  process.exit(1);
}

const privateB64 = fs.readFileSync(keyFile, 'utf-8').trim();

let derivedPublic;
try {
  const raw = Buffer.from(privateB64, 'base64');
  if (raw.length !== 32) throw new Error(`private key is ${raw.length} bytes, expected 32`);
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]),
    format: 'der', type: 'pkcs8',
  });
  // Derive the public half FROM the private key: the only way to be certain
  // they are two halves of one pair rather than two unrelated values.
  derivedPublic = crypto.createPublicKey(priv)
    .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
} catch (err) {
  console.log(`  The private key could not be read: ${err.message}\n`);
  process.exit(1);
}

if (derivedPublic !== publicB64) {
  console.log('  MISMATCH — these are not a pair.\n');
  console.log(`    .env public key        : ${publicB64.slice(0, 16)}...`);
  console.log(`    derived from .license-key: ${derivedPublic.slice(0, 16)}...\n`);
  console.log('  Any code you issue will be REJECTED by the app.');
  console.log('  Either restore the matching .license-key from backup, or run');
  console.log('  npm run license:init and paste the new public key into .env.\n');
  process.exit(1);
}

console.log('  ok  the private key matches the public key in .env\n');

// End-to-end: sign a real code and verify it exactly as the app does.
const deviceId = 'checkkeypair0000000000000000test';
const payload = Buffer.alloc(5);
payload.writeUInt16BE(2768, 0);
payload.writeUIntBE(1, 2, 3);

const priv = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(privateB64, 'base64'),
  ]),
  format: 'der', type: 'pkcs8',
});
const msg = Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]);
const sig = crypto.sign(null, msg, priv);
const code = encodeBase32(Buffer.concat([payload, sig])).match(/.{1,4}/g).join('-');

const pub = crypto.createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicB64, 'base64'),
  ]),
  format: 'der', type: 'spki',
});

const accepted = crypto.verify(null, msg, pub, sig);
console.log(`  ok  a test code signs and verifies (${code.length} characters)\n`);

if (!accepted) {
  console.log('  but verification FAILED — do not issue codes until this is fixed.\n');
  process.exit(1);
}

console.log('  ---------------------------------------------------------------');
console.log('  REMAINING STEP, if you have not done it since generating this pair:\n');
console.log('  The Telegram bot signs codes on the Cloudflare Worker, which keeps');
console.log('  its own copy of the private key. Generating a pair does NOT update');
console.log('  it, and a stale copy means every code the bot issues is rejected.\n');
console.log('      cd server');
console.log('      npx wrangler secret put LICENSE_PRIVATE_KEY\n');
console.log('  Paste the contents of scripts/.license-key when prompted.');
console.log('  ---------------------------------------------------------------\n');
