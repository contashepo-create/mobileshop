/**
 * Developer authentication (main process only).
 *
 * SECURITY NOTES
 * --------------
 * Previously the developer credentials were compared in the RENDERER
 * (`DevConsolePage.tsx`) against a base64+reverse "encryption", and a short
 * numeric password was compared as a plain string inside several main-process
 * handlers. That original password is in the git history and must never be
 * reused, even with a suffix — `scripts/dev-password.js` refuses it.
 * That meant:
 *   - `sessionStorage.setItem('dev_unlocked','true')` unlocked the dev console;
 *   - `grep` on the packaged .asar revealed the password instantly.
 *
 * This module moves verification into the main process, stores only a bcrypt
 * hash, rate-limits attempts, and issues a short-lived random token that the
 * privileged `license:*` / `users:resetByDev` channels require.
 *
 * REMAINING RISK (documented, not solvable with a shared secret):
 * a single static developer password is shipped to every customer. Anyone who
 * extracts the hash can brute-force a 6-digit numeric password offline. The
 * only real fix is asymmetric crypto: the developer signs an activation/reset
 * challenge with a PRIVATE key that never ships, and the app verifies it with
 * an embedded PUBLIC key. See SECURITY_AUDIT_AR.md.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const DEV_USERNAME = 'zerocold';

/**
 * bcrypt(cost 12) of the developer password. Never store the plaintext.
 *
 * SECURITY: this hash SHIPS in every build, so its strength is entirely the
 * strength of the password behind it. The original was six digits — a keyspace
 * of one million, which bcrypt at cost 12 grinds through offline in minutes on
 * an ordinary laptop. Rate limiting protects the LIVE dialog; it does nothing
 * once the hash has been extracted from app.asar.
 *
 * Replace it with a long passphrase:
 *     node scripts/dev-password.js "your new long passphrase"
 * and paste the printed line here. Aim for four or more unrelated words; the
 * generator refuses anything under twelve characters or purely numeric.
 */
const DEV_PASSWORD_HASH = '$2a$12$roA4Cm.0DuiKYwPtxUNfSuX/Ao1ZKH2ofhjtHX3qJw83WjMBmoTK2';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface DevToken {
  expiresAt: number;
}

const tokens = new Map<string, DevToken>();

let failedAttempts = 0;
let lockedUntil = 0;

function purgeExpired() {
  const now = Date.now();
  for (const [t, meta] of tokens) {
    if (meta.expiresAt <= now) tokens.delete(t);
  }
}

export function isLockedOut(): number {
  return Date.now() < lockedUntil ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0;
}

/** Verify developer credentials and mint a short-lived token. */
export function devLogin(username: string, password: string): { success: boolean; token?: string; message?: string } {
  const lockRemaining = isLockedOut();
  if (lockRemaining > 0) {
    return { success: false, message: `تم قفل الدخول مؤقتاً - حاول بعد ${lockRemaining} ثانية` };
  }

  const userOk = typeof username === 'string'
    && crypto.timingSafeEqual(
      Buffer.from((username || '').padEnd(32).slice(0, 32)),
      Buffer.from(DEV_USERNAME.padEnd(32).slice(0, 32)),
    );
  const passOk = typeof password === 'string' && bcrypt.compareSync(password || '', DEV_PASSWORD_HASH);

  if (!userOk || !passOk) {
    failedAttempts++;
    if (failedAttempts >= MAX_ATTEMPTS) {
      lockedUntil = Date.now() + LOCKOUT_MS;
      failedAttempts = 0;
      return { success: false, message: 'تم تجاوز عدد المحاولات - تم القفل 15 دقيقة' };
    }
    return { success: false, message: 'بيانات المطور غير صحيحة' };
  }

  failedAttempts = 0;
  purgeExpired();
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { expiresAt: Date.now() + TOKEN_TTL_MS });
  return { success: true, token };
}

/** Returns true when the supplied token is currently valid. */
export function verifyDevToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 64) return false;
  purgeExpired();
  const meta = tokens.get(token);
  if (!meta) return false;
  if (meta.expiresAt <= Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function revokeDevToken(token: unknown) {
  if (typeof token === 'string') tokens.delete(token);
}
