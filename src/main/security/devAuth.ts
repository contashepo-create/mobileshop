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
const DEV_FALLBACK_HASH = '$2a$12$roA4Cm.0DuiKYwPtxUNfSuX/Ao1ZKH2ofhjtHX3qJw83WjMBmoTK2';

/**
 * Read from .env so a real password never becomes a tracked file edit that
 * `git pull` fights with — or worse, a commit. Generate one with:
 *     npm run dev:password -- "several unrelated words"
 */
/**
 * Reads the hash, preferring the base64 form.
 *
 * THE TRAP THIS AVOIDS
 * --------------------
 * A bcrypt hash looks like `$2a$12$abc...`. Vite loads .env through
 * dotenv-expand, which treats `$12$abc` as a variable reference and silently
 * substitutes it — turning the hash into the four characters `$2a$12`.
 *
 * Measured with the project's own Vite:
 *     .env value  $2a$12$hUAAv...Q9AZsC
 *     loadEnv()   "$2a$12"
 *
 * bcrypt then compares against a malformed hash and every password is wrong,
 * with no error anywhere — exactly the "I enter my password and it is
 * rejected" report this fixes. The licence key is unaffected because base64
 * contains no `$`, which is why activation worked while this did not.
 *
 * Base64 has no `$`, so it survives expansion intact and cannot be silently
 * corrupted. The raw form is still accepted for anyone who escaped the
 * dollars by hand, and a value that arrives truncated is rejected rather than
 * used, so the failure is loud instead of mysterious.
 */
function readDevHash(): string {
  const b64 = (process.env.MOBILESHOP_DEV_PASSWORD_HASH_B64 || '').trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8').trim();
      if (/^\$2[aby]\$\d{2}\$.{53}$/.test(decoded)) return decoded;
      console.error('[Auth] MOBILESHOP_DEV_PASSWORD_HASH_B64 did not decode to a bcrypt hash');
    } catch {
      console.error('[Auth] MOBILESHOP_DEV_PASSWORD_HASH_B64 is not valid base64');
    }
  }

  const raw = (process.env.MOBILESHOP_DEV_PASSWORD_HASH || '').trim();
  if (raw) {
    // A complete bcrypt hash is exactly 60 characters. Anything shorter has
    // been eaten by variable expansion; using it would reject every password.
    if (/^\$2[aby]\$\d{2}\$.{53}$/.test(raw)) return raw;
    console.error(
      '[Auth] MOBILESHOP_DEV_PASSWORD_HASH is truncated — the $ signs were '
      + 'expanded by the .env loader. Use MOBILESHOP_DEV_PASSWORD_HASH_B64 instead '
      + '(npm run dev:password prints it).',
    );
  }

  return DEV_FALLBACK_HASH;
}

const DEV_PASSWORD_HASH = readDevHash();

/** True when the build still carries the original, publicly-known password. */
export function isDevelopmentDevPassword(): boolean {
  return DEV_PASSWORD_HASH === DEV_FALLBACK_HASH;
}

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
