#!/usr/bin/env node
/**
 * Offline activation-code generator — DEVELOPER MACHINE ONLY.
 *
 * This file must NEVER be shipped to customers. It holds (or reads) the master
 * secret used to mint codes. The application itself only verifies.
 *
 * Setup, once:
 *   node scripts/license-keygen.js --init
 *     Prints a fresh master secret. Paste the VERIFIER line into
 *     src/main/security/licenseCrypto.ts and store the secret somewhere safe
 *     (password manager). Anyone holding it can mint licences.
 *
 * Daily use:
 *   node scripts/license-keygen.js --device <ID> --days 365
 *   node scripts/license-keygen.js --device <ID> --days 0        # perpetual
 *   node scripts/license-keygen.js --device <ID> --until 2027-01-31
 *
 * The secret is read from the LICENSE_SECRET environment variable, or from
 * `.license-secret` next to this script (git-ignored), so it never has to be
 * typed on the command line.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EPOCH_UTC = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_FILE = path.join(__dirname, '.license-secret');   // LEGACY (HMAC)
const KEY_FILE = path.join(__dirname, '.license-key');         // Ed25519 private key
const LEDGER_FILE = path.join(__dirname, 'issued-licenses.json');

function encodeBase32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Signs a v2 code with the Ed25519 PRIVATE key.
 *
 * The key is wrapped in the PKCS8 DER header Node requires, so only the raw
 * 32 bytes need storing.
 */
function signCodeV2(privateKeyB64, deviceId, expiryDays, serial) {
  const payload = Buffer.alloc(5);
  payload.writeUInt16BE(expiryDays & 0xffff, 0);
  payload.writeUIntBE(serial & 0xffffff, 2, 3);
  const raw = Buffer.from(privateKeyB64, 'base64');
  if (raw.length !== 32) {
    console.error('Private key must be 32 raw bytes. Run --init to make one.');
    process.exit(1);
  }
  const key = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]),
    format: 'der', type: 'pkcs8',
  });
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]), key);
  return encodeBase32(Buffer.concat([payload, sig])).match(/.{1,4}/g).join('-');
}

function loadPrivateKey() {
  if (process.env.LICENSE_PRIVATE_KEY) return process.env.LICENSE_PRIVATE_KEY.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf-8').trim();
  console.error('No private key found.\n' +
    '  Run:  node scripts/license-keygen.js --init\n' +
    '  Or set the LICENSE_PRIVATE_KEY environment variable.');
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function nextSerial() {
  let ledger = [];
  if (fs.existsSync(LEDGER_FILE)) {
    try { ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8')); } catch { ledger = []; }
  }
  const max = ledger.reduce((m, r) => Math.max(m, r.serial || 0), 0);
  return { serial: max + 1, ledger };
}

function record(ledger, entry) {
  ledger.push(entry);
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), 'utf-8');
}

// ---------------------------------------------------------------- --init
if (process.argv.includes('--init')) {
  // Ed25519, not a shared secret.
  //
  // The old --init printed ONE value to be used both for signing here and for
  // verifying inside the app. That is what made every shipped build capable of
  // minting its own perpetual licence. The private key below never leaves this
  // machine; only the public key is pasted into the source.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const prv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');

  fs.writeFileSync(KEY_FILE, prv, 'utf-8');
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* windows */ }

  console.log('\n=== Ed25519 LICENCE KEY PAIR GENERATED ===\n');
  console.log('PRIVATE key saved to:', KEY_FILE);
  console.log('(git-ignored — back it up in a password manager, it is the only');
  console.log(' thing that can issue licences. Losing it means re-issuing all.)\n');
  console.log('Paste this line into src/main/security/licenseCrypto.ts:\n');
  console.log(`export const LICENSE_PUBLIC_KEY = '${pub}';\n`);
  console.log('The public key is safe to ship: it can verify, never sign.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- --list
if (process.argv.includes('--list')) {
  if (!fs.existsSync(LEDGER_FILE)) { console.log('No codes issued yet.'); process.exit(0); }
  const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
  console.log(`\n${ledger.length} code(s) issued:\n`);
  for (const r of ledger) {
    const exp = r.expiryDays === 0 ? 'perpetual' : new Date(EPOCH_UTC + r.expiryDays * MS_PER_DAY).toISOString().slice(0, 10);
    console.log(`  #${String(r.serial).padStart(4, '0')}  ${r.code}  device=${r.device.slice(0, 12)}…  expires=${exp}  issued=${r.issuedAt.slice(0, 10)}${r.note ? '  note=' + r.note : ''}`);
  }
  console.log();
  process.exit(0);
}

// ---------------------------------------------------------------- generate
const device = (arg('--device') || '').trim().toLowerCase();
if (!device || device.length < 8) {
  console.error('Usage: node scripts/license-keygen.js --device <DEVICE_ID> [--days 365 | --until YYYY-MM-DD] [--note "customer"]');
  console.error('       node scripts/license-keygen.js --init');
  console.error('       node scripts/license-keygen.js --list');
  process.exit(1);
}

let expiryDays;
const until = arg('--until');
const daysArg = arg('--days');
if (until) {
  const d = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) { console.error('Bad --until date, expected YYYY-MM-DD'); process.exit(1); }
  expiryDays = Math.floor((d.getTime() - EPOCH_UTC) / MS_PER_DAY);
} else if (daysArg !== undefined) {
  const n = parseInt(daysArg, 10);
  if (Number.isNaN(n) || n < 0) { console.error('Bad --days value'); process.exit(1); }
  expiryDays = n === 0 ? 0 : Math.floor((Date.now() - EPOCH_UTC) / MS_PER_DAY) + n;
} else {
  console.error('Specify --days N (0 = perpetual) or --until YYYY-MM-DD');
  process.exit(1);
}

if (expiryDays > 0xffff) { console.error('Expiry too far in the future (max ~179 years).'); process.exit(1); }

const privateKey = loadPrivateKey();
const { serial, ledger } = nextSerial();
const code = signCodeV2(privateKey, device, expiryDays, serial);
const expLabel = expiryDays === 0 ? 'غير محدود' : new Date(EPOCH_UTC + expiryDays * MS_PER_DAY).toISOString().slice(0, 10);

record(ledger, {
  serial, code, device, expiryDays,
  issuedAt: new Date().toISOString(),
  note: arg('--note') || '',
});

console.log('\n=== ACTIVATION CODE ===\n');
console.log(`  Device : ${device}`);
console.log(`  Expires: ${expLabel}`);
console.log(`  Serial : #${serial}\n`);
console.log(`  CODE   : ${code}\n`);
console.log('--- Ready-to-send reply (Arabic) ---\n');
console.log(`كود التفعيل الخاص بك:\n\n${code}\n\nصالح حتى: ${expLabel}\nانسخ الكود والصقه في شاشة التفعيل ثم اضغط "تفعيل".`);
console.log();
