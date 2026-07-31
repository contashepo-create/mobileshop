/**
 * Evidence that this machine has already used its free trial.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * Every piece of licence state lived in one folder: `userData`. The code did
 * notice `trial.dat` being deleted on its own — `lastaccess.dat` betrayed it —
 * but both files sat side by side, so deleting the WHOLE folder erased the
 * evidence and the thing it testified about together.
 *
 * Measured before this module existed:
 *     first launch             -> NEW 7-DAY TRIAL
 *     delete trial.dat only    -> trial_expired  (correctly blocked)
 *     delete the whole folder  -> NEW 7-DAY TRIAL  (the hole)
 *
 * And because the database file lives in that same folder, the full recipe was
 * trivial: copy mobile_shop.db out, delete the folder, copy it back, and trade
 * on with another seven days — forever, with every invoice intact.
 *
 * THE APPROACH
 * ------------
 * Write a small marker in several places OUTSIDE the application's own folder,
 * and treat a trial as used if ANY of them survives. An attacker has to find
 * and remove all of them; the honest owner never touches any.
 *
 *   1. the OS user-profile root  (e.g. C:\Users\me\.mobileshop-trial)
 *   2. ProgramData / /var/lib    (survives deleting the user profile)
 *   3. the OS temp directory     (weakest, but a different tree again)
 *
 * Each marker is bound to the device id and signed, so copying one from
 * another machine does not import a fake "already used" state, and editing it
 * to change the start date invalidates it.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not unbreakable, and no client-side scheme can be. Someone determined
 * enough will find three files. The point is proportionality: it turns "delete
 * one folder" — which any AI assistant will happily suggest — into a
 * deliberate hunt that a normal shop owner will never stumble into by
 * accident. The durable protection remains the server-side device registry,
 * which this module feeds.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Deliberately dull, dot-prefixed names that do not advertise themselves. */
const MARKER_NAME = '.mobileshop-trial';

const SIGN_KEY = 'm0b1l3_sh0p_tr14l_4nch0r_2026';

/** Locations to try, best first. Unwritable ones are skipped silently. */
function candidatePaths(): string[] {
  const out: string[] = [];
  try { out.push(path.join(os.homedir(), MARKER_NAME)); } catch { /* no home */ }

  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    out.push(path.join(programData, 'MobileShopERP', MARKER_NAME));
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) out.push(path.join(localApp, 'MobileShopERP', MARKER_NAME));
  } else {
    out.push(path.join('/var/lib', 'mobileshop', MARKER_NAME));
    out.push(path.join(os.homedir(), '.config', 'mobileshop', MARKER_NAME));
  }

  try { out.push(path.join(os.tmpdir(), MARKER_NAME)); } catch { /* no temp */ }
  return out;
}

interface Marker {
  deviceId: string;
  startDate: string;
  sig: string;
}

function sign(deviceId: string, startDate: string): string {
  return crypto.createHmac('sha256', SIGN_KEY)
    .update(`${deviceId}|${startDate}`)
    .digest('hex');
}

function parse(text: string, deviceId: string): Marker | null {
  try {
    const m = JSON.parse(text) as Marker;
    if (!m || typeof m.deviceId !== 'string' || typeof m.startDate !== 'string') return null;
    // Bound to THIS device: a marker copied from another machine is ignored,
    // so nobody can plant a fake "trial already used" on someone else.
    if (m.deviceId !== deviceId) return null;
    // Signed: editing the start date to buy more days invalidates it.
    if (m.sig !== sign(m.deviceId, m.startDate)) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * The earliest trial start this machine can still prove, or null.
 *
 * Returns the OLDEST surviving marker: if an attacker deletes some copies and
 * the app later rewrites the rest, taking the oldest keeps the original clock
 * rather than silently restarting it.
 */
export function readTrialAnchor(deviceId: string): string | null {
  let oldest: string | null = null;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const m = parse(fs.readFileSync(p, 'utf-8'), deviceId);
      if (!m) continue;
      if (oldest === null || m.startDate < oldest) oldest = m.startDate;
    } catch { /* unreadable location — try the next */ }
  }
  return oldest;
}

/**
 * Records the trial start in every location that will accept it.
 *
 * Never throws: a locked-down machine where none of the paths are writable
 * must still run the program. It simply falls back to the old behaviour, which
 * is no worse than before this module existed.
 *
 * Returns how many copies were written, so a caller can log it.
 */
export function writeTrialAnchor(deviceId: string, startDate: string): number {
  const payload = JSON.stringify({ deviceId, startDate, sig: sign(deviceId, startDate) });
  let written = 0;
  for (const p of candidatePaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, payload, 'utf-8');
      // Hide it on Windows so it does not invite curiosity in Explorer.
      if (process.platform === 'win32') {
        try { fs.chmodSync(p, 0o444); } catch { /* best effort */ }
      }
      written++;
    } catch { /* unwritable location — try the next */ }
  }
  return written;
}

/**
 * Re-plants the marker everywhere it is missing.
 *
 * Called on every launch that finds at least one surviving copy, so removing
 * two of three achieves nothing beyond the next start-up.
 */
export function healTrialAnchor(deviceId: string, startDate: string): void {
  try { writeTrialAnchor(deviceId, startDate); } catch { /* never fatal */ }
}
