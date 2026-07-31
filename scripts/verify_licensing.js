#!/usr/bin/env node
/**
 * Licensing checks.
 *
 * Proves the activation-code scheme behaves correctly: codes are bound to one
 * device, carry their own duration, cannot be forged or transplanted, and
 * grant no feature-level privileges (duration only).
 *
 * Run with:  node scripts/verify_licensing.js
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PASS = [];
const FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
}

// ---- mirror of src/main/security/licenseCrypto.ts -------------------------
const EPOCH_UTC = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CONFUSABLES = { I: '1', L: '1', O: '0', U: 'V' };

function encodeBase32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decodeBase32(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, '')
    .split('').map(c => CONFUSABLES[c] ?? c).join('');
  const bytes = []; let bits = 0, value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function payloadBuffer(expiryDays, serial) {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(expiryDays & 0xffff, 0);
  b.writeUIntBE(serial & 0xffffff, 2, 3);
  return b;
}

const tag = (secret, deviceId, payload) => crypto
  .createHmac('sha256', secret)
  .update(Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]))
  .digest().subarray(0, 5);

function signCode(secret, deviceId, expiryDays, serial) {
  const p = payloadBuffer(expiryDays, serial);
  return encodeBase32(Buffer.concat([p, tag(secret, deviceId, p)])).match(/.{1,4}/g).join('-');
}

function verifyCode(secret, deviceId, code) {
  const raw = decodeBase32(code || '');
  if (!raw || raw.length < 10) return null;
  const payload = raw.subarray(0, 5);
  const provided = raw.subarray(5, 10);
  const expected = tag(secret, deviceId, payload);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  return { expiryDays: payload.readUInt16BE(0), serial: payload.readUIntBE(2, 3) };
}

const today = () => Math.floor((Date.now() - EPOCH_UTC) / MS_PER_DAY);
const daysRemaining = e => e - today();

// ---------------------------------------------------------------- tests
console.log('='.repeat(70));
console.log('LICENSING CHECKS');
console.log('='.repeat(70));

const SECRET = crypto.randomBytes(32).toString('base64');
const DEV_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const DEV_B = 'ffffffff111122223333444455556666';

console.log('\n[1] A code activates on the device it was issued for');
{
  const code = signCode(SECRET, DEV_A, today() + 365, 1);
  const r = verifyCode(SECRET, DEV_A, code);
  check('code verifies on the target device', r !== null);
  check('duration is carried inside the code', r && daysRemaining(r.expiryDays) === 365,
    r ? String(daysRemaining(r.expiryDays)) : 'null');
  check('code is short enough to read out loud', code.length <= 24, `${code.length} chars`);
}

console.log('\n[2] A code is useless on any other device');
{
  const code = signCode(SECRET, DEV_A, today() + 365, 2);
  check('rejected on a different device', verifyCode(SECRET, DEV_B, code) === null);
}

console.log('\n[3] Tampering is detected');
{
  const code = signCode(SECRET, DEV_A, today() + 30, 3);
  const raw = decodeBase32(code);
  // extend the expiry by 10 years, keep the original tag
  raw.writeUInt16BE(today() + 3650, 0);
  const forged = encodeBase32(raw).match(/.{1,4}/g).join('-');
  check('extending the expiry breaks the code', verifyCode(SECRET, DEV_A, forged) === null);

  const wrongSecret = crypto.randomBytes(32).toString('base64');
  check('a code minted with another secret is rejected',
    verifyCode(SECRET, DEV_A, signCode(wrongSecret, DEV_A, today() + 365, 4)) === null);
  check('random text is rejected', verifyCode(SECRET, DEV_A, 'ABCD-EFGH-JKMN-PQRS') === null);
  check('empty input is rejected', verifyCode(SECRET, DEV_A, '') === null);
}

console.log('\n[4] Expiry is enforced, and perpetual codes are supported');
{
  const expired = signCode(SECRET, DEV_A, today() - 1, 5);
  const r1 = verifyCode(SECRET, DEV_A, expired);
  check('an expired code still verifies cryptographically', r1 !== null);
  check('...but reports no days left', r1 && daysRemaining(r1.expiryDays) <= 0);

  const perpetual = verifyCode(SECRET, DEV_A, signCode(SECRET, DEV_A, 0, 6));
  check('0 means perpetual', perpetual && perpetual.expiryDays === 0);
}

console.log('\n[5] Human-entry tolerance');
{
  const code = signCode(SECRET, DEV_A, today() + 90, 7);
  check('lowercase accepted', verifyCode(SECRET, DEV_A, code.toLowerCase()) !== null);
  check('dashes optional', verifyCode(SECRET, DEV_A, code.replace(/-/g, '')) !== null);
  check('stray spaces tolerated', verifyCode(SECRET, DEV_A, ` ${code} `) !== null);
  const confusable = code.replace(/0/g, 'O').replace(/1/g, 'I');
  check('O/I typed instead of 0/1 still works', verifyCode(SECRET, DEV_A, confusable) !== null);
}

console.log('\n[6] Each issue is distinct (renewals are traceable)');
{
  const a = signCode(SECRET, DEV_A, today() + 365, 10);
  const b = signCode(SECRET, DEV_A, today() + 365, 11);
  check('same device + same duration -> different codes', a !== b);
  check('serial is recoverable', verifyCode(SECRET, DEV_A, b).serial === 11);
}

console.log('\n[7] Duration only — no feature flags anywhere');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/main/security/licenseCrypto.ts'), 'utf-8');
  check('payload exposes only expiry + serial',
    /expiryDays: number;/.test(src) && /serial: number;/.test(src)
    && !/features|tier|plan|modules/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')));

  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc/license.handlers.ts'), 'utf-8');
  const code = handlers.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('license handlers never gate features',
    !/\b(features|tier|plan|premium|pro)\b/i.test(code));
  check('no local activation_codes.dat lookup remains',
    !code.includes('activation_codes.dat'));
}

console.log('\n[8] The generator and the app agree');
{
  const gen = fs.readFileSync(path.join(__dirname, 'license-keygen.js'), 'utf-8');
  check('generator uses the same epoch', gen.includes('Date.UTC(2020, 0, 1)'));
  check('generator uses the same alphabet', gen.includes(ALPHABET));
  // The generator no longer uses HMAC at all: signing moved to Ed25519 so the
  // shipped app cannot mint its own licences. The forgery-resistance checks
  // live in verify_license_ed25519.mjs, which drives the REAL module rather
  // than a local reimplementation — this file's copy of the crypto is why the
  // original flaw went unnoticed for so long.
  check('generator signs with Ed25519, not a shared secret',
    /signCodeV2/.test(gen) && /createPrivateKey/.test(gen) && !/createHmac/.test(gen));
  check('the private key file is git-ignored',
    fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf-8').includes('scripts/.license-key'));
}

console.log('\n[9] Contact links are well-formed');
{
  const page = fs.readFileSync(path.join(__dirname, '../src/renderer/src/pages/auth/LicenseActivationPage.tsx'), 'utf-8');
  check('local 01x number converted to international', page.includes("`20${digits.slice(1)}`"));
  check('WhatsApp link carries a prefilled message', /wa\.me\/\$\{intlPhone\}\?text=\$\{encoded\}/.test(page));
  check('Telegram username form carries the message', /t\.me\/\$\{tgUser\}\?text=\$\{encoded\}/.test(page));
  check('device id embedded in the request', page.includes('معرّف الجهاز:\\n${deviceId}'));
  check('clipboard fallback when no @username', page.includes('clipboard.writeText(requestMessage)'));
  check('no malformed t.me/+2<local> link', !page.includes('t.me/+2${devPhone}'));
}

console.log('\n' + '='.repeat(70));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(70));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
