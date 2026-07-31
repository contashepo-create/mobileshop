import crypto from 'node:crypto';

/**
 * License code format — duration only, bound to one device.
 *
 * WHY THIS CHANGED (the flaw that forced it)
 * ------------------------------------------
 * The previous scheme signed codes with HMAC-SHA256. HMAC is SYMMETRIC: the
 * key that verifies is the key that signs. That key shipped inside the app as
 * `VERIFIER_SECRET`, so anyone who unpacked app.asar could mint themselves a
 * perpetual licence. Measured, not theorised: extracting the constant and
 * forging `0000-YGHZ-WVHH-KKT4` (expiryDays = 0, unlimited) took seconds, and
 * the application accepted it.
 *
 * The old header even warned "the signing key must NEVER be the value shipped
 * to customers" — but `--init` printed the same value for both roles, so the
 * intended design was never actually built.
 *
 * THE FIX: Ed25519 — asymmetric
 * -----------------------------
 * The PRIVATE key never leaves the developer's machine and is the only thing
 * that can sign. The app embeds the PUBLIC key, which can verify and nothing
 * else. Extracting it from the bundle gains an attacker nothing: there is no
 * longer a secret in the shipped binary that mints licences.
 *
 * LAYOUT v2 (69 bytes -> 111 Base32 chars, grouped in fours)
 *   byte 0..1   expiry, days since EPOCH (uint16, 0 = perpetual)
 *   byte 2..4   serial (uint24) — unique per issue, revocable
 *   byte 5..68  Ed25519 signature over (deviceId || payload)
 *
 * The code is long because an Ed25519 signature CANNOT be truncated — cutting
 * it to 5 bytes the way HMAC allowed makes verification fail outright (proven
 * before committing to this design). A 111-character code cannot be read aloud
 * over the phone, so it is delivered as text to copy and paste, and the
 * activation screen has a paste button. For shops that would rather not handle
 * a long string, `license:activateOnline` exchanges a short reference for a
 * signed grant over the network.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * `verifyCode` still accepts the old 10-byte HMAC codes so that licences
 * already issued to real shops keep working. That path is clearly marked
 * LEGACY and is the one to delete once every customer has been re-issued. It
 * is a deliberate, temporary compromise: refusing old codes would strand
 * paying customers, which is a worse outcome than a forgeable format that is
 * already public.
 */

/** Days are counted from this date to keep the payload at 2 bytes (~179 years). */
export const EPOCH_UTC = Date.UTC(2020, 0, 1);

const MS_PER_DAY = 86_400_000;

/**
 * Ed25519 PUBLIC key embedded in the application, base64 of the 32 raw bytes.
 *
 * This key can only VERIFY. It is safe to ship, safe to publish, and useless
 * for minting a licence. Generate a fresh pair with:
 *     node scripts/license-keygen.js --init
 * which writes the private key to `scripts/.license-key` (git-ignored) and
 * prints the line to paste here.
 */
export let LICENSE_PUBLIC_KEY = 'o3+4sp7nJmjnATFF5q5NXnLYn75kLTjKSxCYu4xfKfs=';

/**
 * LEGACY symmetric secret, kept ONLY to honour codes issued before the move to
 * Ed25519.
 *
 * This value is public — it shipped in every build — so it proves nothing
 * about who issued a code. It is accepted solely so existing customers are not
 * locked out overnight. Delete it, and `verifyLegacyCode`, once every live
 * licence has been re-issued in the v2 format.
 */
export const VERIFIER_SECRET = 'w/Y8yrd9F9WSt1OMZWdM9Hx88g0tj1c6XRQEQbt+DI0=';

/** Crockford Base32 — no I, L, O, U so codes cannot be misread over the phone. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters users commonly mistype, mapped to their intended symbol. */
const CONFUSABLES: Record<string, string> = {
  I: '1', L: '1', O: '0', U: 'V',
};

export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(text: string): Buffer | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .split('')
    .map(c => CONFUSABLES[c] ?? c)
    .join('');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface LicensePayload {
  /** Days since EPOCH_UTC when the licence stops working. 0 = perpetual. */
  expiryDays: number;
  /** Issue serial, unique per code. */
  serial: number;
}

function payloadBuffer(p: LicensePayload): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt16BE(p.expiryDays & 0xffff, 0);
  buf.writeUIntBE(p.serial & 0xffffff, 2, 3);
  return buf;
}

/** LEGACY: truncated HMAC tag. Only used to honour codes issued before v2. */
function tag(secret: string, deviceId: string, payload: Buffer): Buffer {
  return crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]))
    .digest()
    .subarray(0, 5);
}

/** The bytes that get signed: the device this code is for, plus its payload. */
function signedMessage(deviceId: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]);
}

/** Wraps a raw 32-byte Ed25519 public key in the DER header Node expects. */
function publicKeyFrom(base64Key: string): crypto.KeyObject {
  const raw = Buffer.from(base64Key, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),   // SPKI prefix for Ed25519
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Wraps a raw 32-byte Ed25519 private seed in the DER header Node expects. */
function privateKeyFrom(base64Key: string): crypto.KeyObject {
  const raw = Buffer.from(base64Key, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 private key must be 32 bytes');
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),  // PKCS8 prefix
    raw,
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Builds a redeemable v2 code. DEVELOPER MACHINE ONLY.
 *
 * `privateKeyB64` must be the private key that never ships. The application
 * never calls this — it has no key capable of producing a valid signature,
 * which is the entire point of the change.
 */
export function signCodeV2(privateKeyB64: string, deviceId: string, p: LicensePayload): string {
  const payload = payloadBuffer(p);
  const sig = crypto.sign(null, signedMessage(deviceId, payload), privateKeyFrom(privateKeyB64));
  const text = encodeBase32(Buffer.concat([payload, sig]));
  return text.match(/.{1,4}/g)!.join('-');
}

/** LEGACY signer, retained for the tests that prove old codes still verify. */
export function signCode(secret: string, deviceId: string, p: LicensePayload): string {
  const payload = payloadBuffer(p);
  const raw = Buffer.concat([payload, tag(secret, deviceId, payload)]);
  return encodeBase32(raw).match(/.{1,4}/g)!.join('-');
}

/** Reads the payload out of a decoded code, whatever its version. */
function readPayload(payload: Buffer): LicensePayload {
  return {
    expiryDays: payload.readUInt16BE(0),
    serial: payload.readUIntBE(2, 3),
  };
}

/**
 * Verifies a v2 (Ed25519) code. Returns the payload, or null.
 *
 * Any malformed input, wrong length or bad signature returns null rather than
 * throwing: this runs on user-typed text and must never crash the app.
 */
export function verifyCodeV2(publicKeyB64: string, deviceId: string, code: string): LicensePayload | null {
  try {
    const raw = decodeBase32(code || '');
    if (!raw || raw.length < 69) return null;
    const payload = raw.subarray(0, 5);
    const sig = raw.subarray(5, 69);
    const ok = crypto.verify(null, signedMessage(deviceId, payload), publicKeyFrom(publicKeyB64), sig);
    return ok ? readPayload(payload) : null;
  } catch {
    return null;
  }
}

/** LEGACY verifier for the 10-byte HMAC codes issued before v2. */
export function verifyLegacyCode(secret: string, deviceId: string, code: string): LicensePayload | null {
  const raw = decodeBase32(code || '');
  if (!raw || raw.length !== 10) return null;
  const payload = raw.subarray(0, 5);
  const provided = raw.subarray(5, 10);
  const expected = tag(secret, deviceId, payload);
  if (provided.length !== expected.length) return null;
  // Constant-time compare so the tag cannot be recovered byte-by-byte.
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  return readPayload(payload);
}

/**
 * Accepts either format, preferring the secure one.
 *
 * Length decides which path runs: 69 bytes is v2, exactly 10 is legacy. A v2
 * code can therefore never be validated by the weak legacy path, and vice
 * versa, so adding backward compatibility does not weaken the new format.
 */
export function verifyCode(secret: string, deviceId: string, code: string): LicensePayload | null {
  const raw = decodeBase32(code || '');
  if (!raw) return null;
  if (raw.length >= 69) return verifyCodeV2(LICENSE_PUBLIC_KEY, deviceId, code);
  if (raw.length === 10) return verifyLegacyCode(secret, deviceId, code);
  return null;
}

/** Converts a stored expiry (days since epoch) to a calendar date. */
export function expiryToDate(days: number): Date {
  return new Date(EPOCH_UTC + days * MS_PER_DAY);
}

/** Converts a calendar date to the compact day counter. */
export function dateToExpiry(date: Date): number {
  return Math.floor((date.getTime() - EPOCH_UTC) / MS_PER_DAY);
}

/** Whole days remaining; negative once expired. */
export function daysRemaining(expiryDays: number, now = new Date()): number {
  const todayDays = Math.floor((now.getTime() - EPOCH_UTC) / MS_PER_DAY);
  return expiryDays - todayDays;
}

/**
 * Test seam: swaps the embedded public key so a suite can mint a code the app
 * genuinely trusts and drive the REAL router with it.
 *
 * Without this, every test has to sign with a throwaway key, which proves
 * forgery resistance but cannot prove that a legitimate code still activates —
 * and a router change that rejects every real licence is a total outage.
 * Production never calls this.
 */
export function __setPublicKeyForTests(key: string): void {
  LICENSE_PUBLIC_KEY = key;
}
