/**
 * Fast-lane code updates: swap `app.asar` without a new installer.
 *
 * WHY THIS EXISTS
 * ---------------
 * A full NSIS update is ~110 MB even for a one-character change: the client
 * downloads the whole installer, `electron-updater` applies it, and the app
 * restarts inside a new build. For day-to-day fixes the price is absurd, so
 * the server offers a second, tiny feed (`/code-update/...`): a ~2.5 MB
 * `app.asar` alone. The client verifies its sha256 against the manifest and
 * swaps it in on the next restart — the same trick VS Code's own updates use.
 *
 * THE BOUNDARY THAT MAKES IT SAFE
 * -------------------------------
 * `app.asar` is pure JavaScript + renderer assets. The native bound —
 * better-sqlite3's `.node` — lives NEXT to it in `app.asar.unpacked`, and the
 * fast lane NEVER replaces that folder. The publish tool refuses to ship an
 * asar whose natives changed (see scripts/publish-code.js), and the manifest
 * carries a `min_app_version` floor: a machine whose full build is older than
 * that floor drops the push, because a code change that needs a newer
 * better-sqlite3 must not run on an old shell.
 *
 * THE SWAP IS EXTERNAL, AND SELF-HEALING
 * --------------------------------------
 * Windows locks a running executable's asar; replacing `app.asar` while the
 * app runs fails with EBUSY. So the swap happens in a DETACHED PowerShell
 * helper that survives the app exiting:
 *
 *   1. we stage `app.asar.new` next to the current asar;
 *   2. on quit, the helper renames app.asar -> app.asar.bak, then
 *      app.asar.new -> app.asar;
 *   3. it relaunches the app and waits for a success flag `.code-ok`;
 *   4. if the new build fails to boot (a crash, a native that will not load),
 *      the helper restores app.asar.bak and relaunches the old build.
 *
 * That last step is the safety net that makes an EXTERNAL swap acceptable:
 * a broken push costs one restart, never a phone call, and the old code is
 * back without anyone touching the machine.
 *
 * FAILURE IS ALWAYS SILENT — the same rule as updater.ts. No internet, a
 * locked resources folder (per-machine install), a tampered manifest: none of
 * it may produce an error dialog in front of a shop mid-sale.
 */
import { app, webContents } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDeviceId } from './security/deviceId';

const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';
const PLATFORM = `win32-${process.arch}`;

const FIRST_CHECK_DELAY_MS = 90 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

let started = false;
let checkTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

/** State the About screen shows; broadcast on the same `updater:status` bus. */
let state: { state: string; percent?: number; version?: string; message?: string } = { state: 'idle' };

function broadcast(s: Record<string, unknown>): void {
  state = { ...state, ...s } as typeof state;
  for (const wc of webContents.getAllWebContents()) {
    wc.send('updater:status', state);
  }
}

/** The resources folder holding app.asar; writable only on per-user installs. */
function resourcesDir(): string {
  return path.join(path.dirname(app.getPath('exe')), 'resources');
}

function asarPath(): string {
  return path.join(resourcesDir(), 'app.asar');
}

function asarNewPath(): string {
  return path.join(resourcesDir(), 'app.asar.new');
}

function asarBakPath(): string {
  return path.join(resourcesDir(), 'app.asar.bak');
}

function okFlagPath(): string {
  return path.join(resourcesDir(), '.code-ok');
}

function canSwap(): boolean {
  try {
    const dir = resourcesDir();
    if (!fs.existsSync(dir)) return false;
    const probe = path.join(dir, `.code-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;   // Program Files, installed for all users — full installs only
  }
}

/** Minimal semver compare used ONLY to gate code pushes (0.0.0 == dev/build). */
function semverGte(a: string, b: string): boolean {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

interface CodeManifest {
  version: string;
  asar: string;           // relative path, e.g. /code/win32-x64/1.0.5.asar
  sha256: string;
  size: number;
  min_app_version: string;
  notes?: string;
}

/** Has this machine already applied THIS exact code? */
function alreadyApplied(version: string, sha256: string): boolean {
  try {
    // app.getVersion() reads package.json INSIDE app.asar — i.e. the code that
    // is actually running right now. A swap bumps that version, so a check
    // whose version matches means the push is already live.
    return app.getVersion() === version;
  } catch {
    return false;
  }
}

/**
 * Fetches the code-update manifest. Returns null on anything but a 200 JSON —
 * a 204 (nothing new), a timeout, a 401: all mean "leave me alone".
 */
async function fetchManifest(): Promise<CodeManifest | null> {
  let device = '';
  try { device = getDeviceId(); } catch { /* server allows unknown devices */ }
  const q = device ? `?device=${encodeURIComponent(device)}` : '';
  const url = `${API_BASE}/code-update/${PLATFORM}/${app.getVersion()}/manifest.json${q}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (res.status === 204) return null;          // up to date
    if (!res.ok) return null;                     // 401/404/500: quiet
    const m = await res.json() as Partial<CodeManifest>;
    if (!m || !m.version || !m.asar || !/^[a-fA-F0-9]{64}$/.test(m.sha256 || '') || !(m.size! > 0)) {
      return null;                                 // malformed: refuse, never trust
    }
    return m as CodeManifest;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Streams the asar to a temp file, hashing on the fly. Returns the sha256. */
async function downloadAsar(manifest: CodeManifest, dest: string): Promise<string> {
  const url = `${API_BASE}${manifest.asar}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(url, {
      headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    const total = Number(res.headers.get('content-length')) || manifest.size || 0;
    const hash = createHash('sha256');
    const tmp = dest + '.tmp';
    const out = fs.createWriteStream(tmp);
    let received = 0;

    // Stream manually so we can (a) hash bytes and (b) report progress. The
    // asar is ~2.5 MB so this is quick, but the progress bar keeps the About
    // screen honest instead of frozen.
    try {
      const reader = res.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { out.write(Buffer.from(value)); hash.update(Buffer.from(value)); }
          received += value?.length || 0;
          if (total) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            broadcast({ state: 'downloading', percent: pct });
          }
        }
      };
      await pump();
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      if (received !== manifest.size) throw new Error(`size mismatch: got ${received}, want ${manifest.size}`);
      fs.renameSync(tmp, dest);
      return hash.digest('hex');
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}

/** Stages a verified asar next to the running one, ready for the next restart. */
async function stagePush(manifest: CodeManifest): Promise<void> {
  // Refuse to touch a machine that cannot take the code.
  if (!canSwap()) {
    console.log('[CodeUpdater] resources not writable (per-machine?) — code push skipped');
    return;
  }
  // min_app_version floor: an old shell must not run code built for a newer
  // better-sqlite3. Compare against the version of the code we are RUNNING:
  // a machine already on this shell satisfies it, an older one does not.
  if (!semverGte(app.getVersion(), manifest.min_app_version)) {
    console.log(`[CodeUpdater] push ${manifest.version} needs shell >= ${manifest.min_app_version}`
      + ` — this machine is on ${app.getVersion()}; ignored`);
    return;
  }

  // A stale staging file from a crashed swap must not be trusted — always
  // re-verify the fresh download before it can ever be swapped in.
  const dest = asarNewPath();
  fs.mkdirSync(resourcesDir(), { recursive: true });
  const actual = await downloadAsar(manifest, dest);
  if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
    console.error('[CodeUpdater] sha256 mismatch — refusing to stage', manifest.version);
    try { fs.unlinkSync(dest); } catch { /* best effort */ }
    return;
  }

  broadcast({ state: 'downloaded', version: manifest.version });
  console.log(`[CodeUpdater] staged ${manifest.version} (${(manifest.size / 1048576).toFixed(2)} MB) — will swap on restart`);
}

/**
 * Spawns the detached swap helper. It outlives this process, so the swap and
 * the boot-verification keep running even though we are about to exit.
 */
function spawnSwapHelper(): boolean {
  const exe = app.getPath('exe');
  const resources = resourcesDir();
  const currentPid = process.pid;
  const helper = path.join(resources, 'code-swap.ps1');

  const script = `
param(
  [string] $Exe,
  [string] $Resources,
  [int]    $OldPid
)
$ErrorActionPreference = 'Stop'
$asar = Join-Path $Resources 'app.asar'
$new  = Join-Path $Resources 'app.asar.new'
$bak  = Join-Path $Resources 'app.asar.bak'
$ok   = Join-Path $Resources '.code-ok'

# 1. Wait for the app that just quit to actually release its files.
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $new)) { exit 0 }   # nothing staged; plain restart

# 2. Swap, keeping the old code as the rollback copy.
if (Test-Path $bak) { Remove-Item $bak -Force }
Move-Item $asar $bak
Move-Item $new $asar
Remove-Item $ok -Force -ErrorAction SilentlyContinue

# 3. Relaunch the app, then wait for the new build to prove itself.
Start-Process $Exe
$booted = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $ok) { $booted = $true; break }
}

# 4. Boot failed: put the old code back and start the shop on THAT.
if (-not $booted) {
  Remove-Item $asar -Force -ErrorAction SilentlyContinue
  Move-Item $bak $asar
  Start-Process $Exe
}
exit 0
`;

  try {
    fs.writeFileSync(helper, script, 'utf-8');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, exe, resources, String(currentPid),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch (err) {
    console.error('[CodeUpdater] could not start swap helper:', (err as Error).message);
    return false;
  }
}

/**
 * Replaces the running asar on quit, if a verified push is staged.
 * Returns true when a swap was scheduled — the caller prefers this path over
 * the full NSIS installer in `quitAndInstallNow`.
 *
 * Idempotent: the About-screen button calls this, then quits — and `before
 * quit` calls it again. Two helpers racing the same rename are a third
 * failure mode none of the rollback logic covers, so the second call is a
 * no-op for the lifetime of this process.
 */
let swapArmed = false;
export function applyStagedCode(): boolean {
  if (!fs.existsSync(asarNewPath()) || swapArmed) return false;
  swapArmed = true;
  return spawnSwapHelper();
}

/**
 * Marks this boot as healthy so a pending swap helper does not roll it back.
 * Called from the main process AFTER the database migration succeeded — the
 * last thing that can reasonably crash a new build. Deliberately synchronous
 * and fail-safe.
 */
export function markCodeBootOk(): void {
  try {
    fs.writeFileSync(okFlagPath(), String(Date.now()));
  } catch { /* per-machine installs cannot write here; swap is disabled there */ }
}

/** Manual check from the About screen. */
export async function checkForCodeUpdatesNow(): Promise<{ ok: boolean; message?: string }> {
  if (!started) return { ok: false, message: 'التحديث السريع غير مفعّل' };
  const m = await fetchManifest();
  if (!m) { broadcast({ state: 'uptodate' }); return { ok: true }; }
  await stagePush(m);
  return { ok: true };
}

/**
 * Starts the fast-lane updater. Runs AFTER the full updater, and only on
 * packaged, per-user Windows builds where `resources/` is writable. The first
 * check is deferred so start-up is never slowed by the network.
 */
export function startCodeUpdater(): void {
  if (started) return;
  if (!app.isPackaged) { console.log('[CodeUpdater] development build — disabled'); return; }
  if (process.platform !== 'win32') { console.log('[CodeUpdater] non-Windows — disabled'); return; }
  if (!API_BASE || !CLIENT_KEY) { console.log('[CodeUpdater] no server configured — disabled'); return; }
  if (!canSwap()) {
    console.log('[CodeUpdater] resources not writable (per-machine) — full-installer channel only');
    return;
  }
  started = true;

  const check = async () => {
    if (!fs.existsSync(asarNewPath())) {
      const m = await fetchManifest();
      if (m) await stagePush(m);
    } else {
      // A staged-but-not-swapped push survived a restart (helper was killed).
      // Leave it staged; it will apply on the next clean quit.
      broadcast({ state: 'downloaded' });
    }
  };

  checkTimer = setTimeout(() => { void check(); }, FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
  console.log('[CodeUpdater] scheduled (first check in 90 seconds)');
}

/** Stops timers (used in tests / teardown). */
export function stopCodeUpdater(): void {
  if (checkTimer) clearTimeout(checkTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  checkTimer = null;
  intervalTimer = null;
}
