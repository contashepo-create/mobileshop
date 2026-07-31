/**
 * The stable identity of this installation.
 *
 * WHY THE OLD RECIPE WAS A PROBLEM
 * --------------------------------
 * The id used to be sha256(MAC + CPU model + hostname). Measured:
 *
 *     baseline            e38d56fc93009047d35ed59fb38d2daf
 *     rename the PC       CHANGED
 *     plug in a USB wifi  CHANGED
 *
 * Both of those take seconds and neither is a new computer. That cuts two
 * ways. A customer who wants a second free trial can flip a MAC address in
 * Device Manager — but far more often it happens by ACCIDENT: someone plugs in
 * a wifi dongle, or IT renames the machine, and a paying shop is suddenly told
 * its licence belongs to another device. The support call is the real cost,
 * and the honest customer pays it while the dishonest one is barely slowed.
 *
 * WHAT IS USED NOW
 * ----------------
 * Stable hardware serials, read once and cached:
 *   - the motherboard serial (survives a Windows reinstall, a new disk, a new
 *     network card — it changes only when the machine really is another one)
 *   - the machine GUID, which Windows keeps across hardware changes
 *   - the CPU model as a weak third component
 *
 * Each is optional. A machine that reports none of them falls back to the old
 * recipe rather than refusing to run: an unidentifiable PC is a support
 * problem, not a reason to deny a shop its till.
 *
 * MIGRATION — the part that must not break anything
 * -------------------------------------------------
 * `device.id` is written once and then treated as authoritative FOREVER. Every
 * licence already issued is bound to whatever value that file holds, so
 * recomputing it on an existing install would invalidate real, paid licences.
 * The new recipe therefore applies ONLY to machines that have never generated
 * an id. Existing installs keep theirs untouched, and that is deliberate.
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SECRET_KEY = 'm0b1l3_sh0p_3rp_s3cr3t_k3y_2026_z3r0c0ld';
const DEVICE_FILE = 'device.id';

/**
 * Runs a short command and returns its trimmed output, or ''.
 *
 * Every call is wrapped: these are diagnostic utilities that may be absent,
 * disabled by policy, or slow. A missing serial must degrade the fingerprint,
 * never crash start-up, so the timeout is short and failure is silent.
 */
function tryCommand(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/** Motherboard serial — the most stable identifier a PC exposes. */
function motherboardSerial(): string {
  if (process.platform === 'win32') {
    // PowerShell first: wmic is removed from recent Windows builds.
    const ps = tryCommand('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_BaseBoard).SerialNumber',
    ]);
    if (ps) return ps;
    const out = tryCommand('wmic', ['baseboard', 'get', 'serialnumber']);
    return out.split('\n').slice(1).join('').trim();
  }
  if (process.platform === 'darwin') {
    const out = tryCommand('ioreg', ['-l']);
    return (/"IOPlatformSerialNumber" = "([^"]+)"/.exec(out) || [])[1] || '';
  }
  // Linux: readable without root on most distributions.
  try {
    return fs.readFileSync('/sys/class/dmi/id/board_serial', 'utf-8').trim();
  } catch {
    return '';
  }
}

/** A machine GUID that survives hardware changes. */
function machineGuid(): string {
  if (process.platform === 'win32') {
    const out = tryCommand('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
    ]);
    return (/MachineGuid\s+REG_SZ\s+(\S+)/.exec(out) || [])[1] || '';
  }
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { return fs.readFileSync(p, 'utf-8').trim(); } catch { /* try the next */ }
  }
  return '';
}

/**
 * Values that are meaningless as identifiers.
 *
 * Many consumer boards report a placeholder rather than a real serial, and
 * every machine of that model reports the SAME placeholder. Treating one as
 * unique would collapse thousands of shops onto one device id, so they are
 * discarded and the fingerprint falls back to something else.
 */
const USELESS = new Set([
  '', 'none', 'default string', 'to be filled by o.e.m.', 'system serial number',
  'not specified', 'not applicable', 'unknown', '0', '00000000', 'n/a',
  'to be filled by o.e.m',
]);

const usable = (v: string): boolean => !USELESS.has(v.trim().toLowerCase()) && v.trim().length >= 4;

/** Builds the raw fingerprint string from whatever this machine will report. */
export function collectFingerprint(): { raw: string; sources: string[] } {
  const sources: string[] = [];
  const parts: string[] = [];

  const board = motherboardSerial();
  if (usable(board)) { parts.push(`BOARD:${board}`); sources.push('board'); }

  const guid = machineGuid();
  if (usable(guid)) { parts.push(`GUID:${guid}`); sources.push('guid'); }

  const cpu = os.cpus()[0]?.model || '';
  if (usable(cpu)) { parts.push(`CPU:${cpu}`); sources.push('cpu'); }

  // Last resort only. These are the volatile values the old recipe relied on,
  // kept so a locked-down machine still gets SOME identity rather than none.
  if (parts.length === 0) {
    const mac = Object.values(os.networkInterfaces()).flat()
      .find(i => i && !i.internal && i.mac !== '00:00:00:00:00:00')?.mac || 'unknown';
    parts.push(`MAC:${mac}`, `HOST:${os.hostname()}`);
    sources.push('legacy-mac', 'legacy-hostname');
  }

  return { raw: parts.join('_'), sources };
}

/**
 * Returns the device id, creating it on first run.
 *
 * The file is written once and never recomputed: licences are bound to it, so
 * changing the recipe must not move the identity of a machine that already
 * holds a valid licence.
 */
export function getDeviceId(): string {
  const devicePath = path.join(app.getPath('userData'), DEVICE_FILE);
  if (fs.existsSync(devicePath)) {
    const existing = fs.readFileSync(devicePath, 'utf-8').trim();
    if (existing) return existing;
  }

  const { raw, sources } = collectFingerprint();
  const deviceId = crypto.createHash('sha256').update(raw + SECRET_KEY).digest('hex').substring(0, 32);

  try {
    fs.writeFileSync(devicePath, deviceId, 'utf-8');
    fs.chmodSync(devicePath, 0o444); // Read-only: it must not drift.
  } catch {
    // A read-only profile still gets a usable id for this session; it is
    // derived deterministically, so the next launch computes the same value.
  }
  console.log(`[Device] identity derived from: ${sources.join(', ')}`);
  return deviceId;
}
