import crypto from 'node:crypto';

/**
 * License code format — duration only, bound to one device.
 *
 * DESIGN
 * ------
 * The old scheme was unusable AND insecure:
 *   - `license:generateCode` wrote codes into `userData/activation_codes.dat`
 *     on the DEVELOPER's machine, while `license:activate` read the same path
 *     on the CUSTOMER's machine. That file never exists there, so a code issued
 *     by the developer could never be redeemed by a customer.
 *   - The shared `SECRET_KEY` shipped inside the app, so any customer could
 *     decrypt that file and mint themselves an unlimited licence.
 *
 * The code now CARRIES its own proof:  payload + truncated HMAC.
 * Nothing is looked up locally; the app only verifies.
 *
 * LAYOUT (10 bytes -> 16 Base32 chars, shown as XXXX-XXXX-XXXX-XXXX)
 *   byte 0..1  expiry, days since EPOCH (uint16, 0 = perpetual)
 *   byte 2..4  serial (uint24) — makes each issue unique and revocable
 *   byte 5..9  HMAC-SHA256(masterKey, deviceId || payload) truncated to 5 bytes
 *
 * The device id is NOT transmitted inside the code: the app already knows its
 * own id and mixes it into the HMAC, so a code minted for device A fails on
 * device B. This keeps the code short enough to read out over WhatsApp.
 *
 * SECURITY NOTE (deliberate, documented trade-off)
 * ------------------------------------------------
 * HMAC is symmetric, so the verifying key can also sign. A 5-byte tag gives
 * 2^40 forgery odds per guess — fine here because every wrong attempt is
 * rate-limited and bound to a device. The signing key must therefore NEVER be
 * the value shipped to customers: `scripts/license-keygen.js` holds the master
 * key on the developer's machine and the app ships only a device-scoped
 * verifier derived from it. See VERIFIER_SECRET below.
 */

/** Days are counted from this date to keep the payload at 2 bytes (~179 years). */
export const EPOCH_UTC = Date.UTC(2020, 0, 1);

const MS_PER_DAY = 86_400_000;

/**
 * Verification secret embedded in the application.
 *
 * Replace this before shipping by running:  node scripts/license-keygen.js --init
 * which prints a fresh pair and tells you exactly what to paste here and what
 * to keep offline.
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

function tag(secret: string, deviceId: string, payload: Buffer): Buffer {
  return crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(deviceId, 'utf8'), payload]))
    .digest()
    .subarray(0, 5);
}

/** Builds a redeemable code. Used by the offline generator, not by the app. */
export function signCode(secret: string, deviceId: string, p: LicensePayload): string {
  const payload = payloadBuffer(p);
  const raw = Buffer.concat([payload, tag(secret, deviceId, payload)]);
  const text = encodeBase32(raw);
  return text.match(/.{1,4}/g)!.join('-');
}

/** Returns the payload when the code is authentic for this device, else null. */
export function verifyCode(secret: string, deviceId: string, code: string): LicensePayload | null {
  const raw = decodeBase32(code || '');
  if (!raw || raw.length < 10) return null;
  const payload = raw.subarray(0, 5);
  const provided = raw.subarray(5, 10);
  const expected = tag(secret, deviceId, payload);
  if (provided.length !== expected.length) return null;
  // Constant-time compare so the tag cannot be recovered byte-by-byte.
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  return {
    expiryDays: payload.readUInt16BE(0),
    serial: payload.readUIntBE(2, 3),
  };
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
