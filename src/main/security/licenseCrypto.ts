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
 * for minting a licence.
 *
 * READ FROM .env, NOT EDITED IN PLACE.
 * -----------------------------------
 * The first version told the developer to paste their key over this line. That
 * turns a tracked source file into a place where production values live, and
 * every `git pull` then either conflicts with the edit or quietly reverts it —
 * which would silently invalidate every licence already issued.
 *
 * `.env` is already git-ignored and already read at build time by
 * vite.main.config.ts, so the key survives updates and never appears in a
 * commit. The fallback below is the DEVELOPMENT key: usable for testing, and
 * the shipped build refuses to start on it (see assertProductionKeys).
 *
 * Generate a pair with:  npm run license:init
 */
const DEV_FALLBACK_PUBLIC_KEY = 'o3+4sp7nJmjnATFF5q5NXnLYn75kLTjKSxCYu4xfKfs=';

export let LICENSE_PUBLIC_KEY =
  (process.env.MOBILESHOP_LICENSE_PUBLIC_KEY || '').trim() || DEV_FALLBACK_PUBLIC_KEY;

/**
 * True when the build is still running on the development key.
 *
 * Shipping on it would mean every customer's licence is verifiable by a key
 * whose private half is published in this repository's history — anyone could
 * mint themselves a perpetual licence. Checked at start-up rather than trusted
 * to be remembered.
 */
export function isDevelopmentLicenseKey(): boolean {
  return LICENSE_PUBLIC_KEY === DEV_FALLBACK_PUBLIC_KEY;
}

/**
 * REMOVED: the legacy symmetric secret and the HMAC verifier that used it.
 *
 * HMAC is symmetric — the key that verifies is the key that signs — and that
 * key shipped inside every build. Demonstrated before deleting it: the
 * constant alone minted `0000-0001-54RJ-HRND`, a PERPETUAL licence for an
 * arbitrary device id, and the router accepted it because a 10-byte code was
 * routed to the weak path.
 *
 * It was retained only so existing customers were not locked out. There are
 * none — the product has not shipped — so the compatibility that justified
 * keeping a forgeable path no longer exists, and keeping it would mean
 * releasing with a known master key.
 *
 * Only Ed25519 (v2) codes are accepted now. The private key never leaves the
 * developer's machine; the build embeds the public key, which can verify and
 * nothing else.
 */

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

/**
 * LEGACY signer, kept ONLY so a suite can mint an old-format code and prove
 * the application now REFUSES it.
 *
 * It is exported for that reason alone. Nothing in the application calls it,
 * and the router no longer has a path that would accept what it produces —
 * `verifyCode` requires 69 bytes, and this emits 10.
 */
export function signLegacyCodeForTests(secret: string, deviceId: string, p: LicensePayload): string {
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

/**
 * The ONLY accepted format: Ed25519 v2.
 *
 * The `secret` parameter is retained so the many call sites did not all have
 * to change, and is deliberately IGNORED. Nothing about a caller-supplied
 * secret can make a code valid any more — verification depends solely on the
 * embedded public key, so there is no value an attacker could supply here to
 * influence the result.
 *
 * A short code is not "an old code" to be tried on a weaker path; it is simply
 * not a licence.
 */
export function verifyCode(_secret: string, deviceId: string, code: string): LicensePayload | null {
  const raw = decodeBase32(code || '');
  // Defence in depth, and deliberately redundant: a short code sliced for a
  // signature yields fewer than 64 bytes, which `crypto.verify` rejects on its
  // own. Mutation testing confirms removing this line changes no outcome. It
  // stays because it states the rule — 69 bytes or it is not a licence —
  // rather than leaving that to a downstream side effect.
  if (!raw || raw.length < 69) return null;
  return verifyCodeV2(LICENSE_PUBLIC_KEY, deviceId, code);
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
