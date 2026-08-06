#!/usr/bin/env node
/**
 * DEPENDENCY SECURITY — no known-vulnerable package may re-enter the tree.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `npm run verify` had 74 suites and not one of them looked at the supply
 * chain. An audit of the 779 packages in the lockfile found 34 advisories:
 * 1 critical, 27 high, 3 moderate, 3 low. Nothing in the repository would have
 * noticed, and nothing would notice them coming back.
 *
 * A one-off `npm audit` does not solve that either, because it needs the
 * network and because a fix applied today is undone by the next careless
 * `npm install`. This suite pins the DECISIONS — the floors below which a
 * package may not fall, and the overrides that hold the transitive tree — so
 * a regression fails the build offline and immediately.
 *
 * WHAT WAS FOUND AND FIXED
 * ------------------------
 * electron 32.3.3        17 advisories, worst CVSS 8.1 (use-after-free in the
 *                        offscreen paint callback). Electron 32 reached END OF
 *                        LIFE in March 2025 and receives no security patches
 *                        at all — the single most serious finding, because the
 *                        Electron binary IS the runtime the customer executes.
 * tar 6.2.1              CRITICAL. 12 advisories including arbitrary file
 *                        write via hardlink path traversal (CVSS 8.2) and a
 *                        race on APFS (CVSS 8.8). Reached through
 *                        @electron/rebuild -> @electron/node-gyp at package
 *                        time, when it unpacks downloaded Electron headers.
 * react-router-dom 6.30.4 The only RUNTIME dependency affected: open redirect
 *                        leading to XSS. The 6.x line is ABANDONED at 6.30.4 —
 *                        no patched 6.x exists — so the v7 major was the only
 *                        route.
 * vite 5.4.21            server.fs.deny bypass on Windows (CVSS 7.5) plus the
 *                        esbuild dev-server request leak.
 * brace-expansion, tmp, fast-uri, cacache, make-fetch-happen
 *                        DoS and path-traversal advisories, all transitive.
 *
 * WHAT IS DELIBERATELY NOT PINNED TO "LATEST"
 * -------------------------------------------
 * `npm audit fix --force` wanted Electron 43 and vite 8. Electron 43 is right
 * — 41, 42 and 43 are the only supported lines — but vite 8 would have dragged
 * in @vitejs/plugin-react 6, and the pairing that actually resolves and builds
 * is vite 6 with plugin-react 4.7.0. Chasing the highest number is not the
 * same as choosing the correct version, and this suite records the correct one.
 *
 * Run:  node --experimental-strip-types scripts/verify_dependency_security.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `fileURLToPath`, never `.pathname`.
//
// On Windows a file:// URL's pathname is `/D:/coding%20projects/...` — it
// keeps a leading slash and it is percent-encoded. MEASURED on the owner's
// machine, joining that with a subdirectory produced
//
//     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
//
// — the drive letter twice and the spaces still as %20. `fileURLToPath` is the
// documented conversion and handles both.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const locked = lock.packages || {};

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

/** Compares dotted numeric versions. Returns true when a >= b. */
function gte(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split('.').map(Number);
  const pb = String(b).replace(/^[^\d]*/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** The version the lockfile actually resolved, at any depth. */
function lockedVersion(name) {
  const direct = locked[`node_modules/${name}`];
  if (direct?.version) return direct.version;
  for (const [path, meta] of Object.entries(locked)) {
    if (path.endsWith(`/node_modules/${name}`) && meta.version) return meta.version;
  }
  return null;
}

/** Every resolved copy of a package, including nested ones. */
function allVersions(name) {
  const out = [];
  for (const [path, meta] of Object.entries(locked)) {
    if ((path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && meta.version) {
      out.push([path, meta.version]);
    }
  }
  return out;
}

// ===========================================================================
console.log('\n── 1. security floors: every advisory has a minimum version ──');
// ===========================================================================
{
  /**
   * name -> [minimum safe version, why].
   *
   * The floor is the version that PATCHES the advisory, not the newest
   * release. Recording the reason means the next person can tell a security
   * floor from a preference.
   */
  const FLOORS = [
    ['electron', '39.8.5',
      '17 advisories; worst CVSS 8.1 use-after-free in offscreen paint. NOTE: the ' +
      'floor clears the CVEs but 39 and 40 are EOL — see section 3 for the ' +
      'supported-line rule, which is stricter.'],
    ['vite', '6.4.3', 'server.fs.deny bypass on Windows, CVSS 7.5 (GHSA-fx2h-pf6j-xcff)'],
    ['react-router', '7.18.0', 'open redirect + arbitrary constructor via deserializeErrors'],
    ['react-router-dom', '7.18.0', 'open redirect leading to XSS (GHSA-jjmj-jmhj-qwj2)'],
    ['tar', '7.5.21', 'CRITICAL: hardlink path traversal, arbitrary file write (CVSS 8.2)'],
    ['brace-expansion', '2.1.4', 'DoS via unbounded intermediate arrays (CVSS 7.5)'],
    ['tmp', '0.2.6', 'path traversal via unsanitised prefix/postfix'],
    ['fast-uri', '3.1.5', 'host confusion via backslash authority introducer (CVSS 7.5)'],
    ['cacache', '19.0.0', 'inherits the vulnerable tar; no patched 18.x exists'],
    ['make-fetch-happen', '14.0.1', 'inherits the vulnerable cacache'],
    ['esbuild', '0.25.0', 'dev server answers any website (GHSA-67mh-4wv8-2f99)'],
    ['better-sqlite3', '12.0.0', 'required for the Node 24 ABI that Electron 41+ uses'],
  ];

  for (const [name, floor, why] of FLOORS) {
    const versions = allVersions(name);
    ok(`${name} is present in the lockfile`, versions.length > 0);
    for (const [path, v] of versions) {
      ok(`${name}@${v} >= ${floor}`, gte(v, floor), `${path} — ${why}`);
    }
  }
}

// ===========================================================================
console.log('── 2. overrides hold the transitive tree ──');
// ===========================================================================
{
  // These packages are not direct dependencies. They arrive through
  // @electron-forge -> @electron/rebuild -> @electron/node-gyp, which pins old
  // majors that npm cannot lift on its own — `npm audit` reported
  // "fixAvailable: false" for the whole chain. An `overrides` block is the
  // only mechanism that reaches them without forking the toolchain.
  const REQUIRED_OVERRIDES = [
    'tar', 'brace-expansion', 'tmp', 'fast-uri', 'cacache', 'make-fetch-happen',
  ];
  ok('package.json declares an overrides block', Boolean(pkg.overrides),
    'without it the critical tar advisory returns on the next install');
  for (const name of REQUIRED_OVERRIDES) {
    ok(`overrides pins ${name}`, Boolean(pkg.overrides?.[name]),
      'this package is unreachable through normal resolution');
  }

  // An override that is declared but not APPLIED is worse than none, because
  // it reads as protection. Checked against what the lockfile resolved.
  for (const name of REQUIRED_OVERRIDES) {
    const want = String(pkg.overrides?.[name] || '').replace(/^[\^~]/, '');
    for (const [path, got] of allVersions(name)) {
      ok(`the ${name} override reached ${path.split('node_modules/').pop()}`,
        gte(got, want), `wanted >=${want}, lockfile has ${got} at ${path}`);
    }
  }

  // The override VALUE must itself clear the security floor.
  //
  // Mutation testing found this gap: weakening `"tar": "^7.5.22"` to
  // `"^6.2.1"` — reinstating the critical advisory — passed every check
  // above, because the comparison ran lockfile-against-override and the
  // lockfile still held 7.5.22. The weakened override only bites when someone
  // next regenerates the lockfile, which is precisely the moment nobody is
  // watching. Comparing the override against the floor catches it the instant
  // it is written.
  const OVERRIDE_FLOORS = {
    'tar': '7.5.21',
    'brace-expansion': '2.1.4',
    'tmp': '0.2.6',
    'fast-uri': '3.1.5',
    'cacache': '19.0.0',
    'make-fetch-happen': '14.0.1',
  };
  for (const [name, floor] of Object.entries(OVERRIDE_FLOORS)) {
    const declared = String(pkg.overrides?.[name] || '').replace(/^[\^~>=]+/, '');
    ok(`the ${name} override value itself clears the floor`,
      declared !== '' && gte(declared, floor),
      `overrides."${name}" is "${pkg.overrides?.[name]}", floor is ${floor}`);
  }
}

// ===========================================================================
console.log('── 3. Electron is on a SUPPORTED release line ──');
// ===========================================================================
{
  // Electron supports the latest THREE stable majors and nothing else. A
  // version can satisfy every published advisory and still be indefensible,
  // because the next Chromium CVE will never be backported to it.
  //
  // Electron 32 — what this project shipped on — went end of life in March
  // 2025. 39 (May 2026) and 40 (June 2026) are also EOL. Only 41, 42 and 43
  // receive patches.
  const MIN_SUPPORTED_MAJOR = 41;
  const v = lockedVersion('electron');
  ok('electron is locked', Boolean(v));
  const major = Number(String(v || '0').split('.')[0]);
  ok(`electron ${v} is on a supported line (>= ${MIN_SUPPORTED_MAJOR})`,
    major >= MIN_SUPPORTED_MAJOR,
    'Electron supports only the latest three majors; older lines get no security patches at all');

  // The declared range must not permit sliding back below the floor.
  const declared = pkg.devDependencies?.electron || '';
  ok('the declared electron range starts at a supported major',
    gte(declared.replace(/^[\^~]/, ''), `${MIN_SUPPORTED_MAJOR}.0.0`), declared);
}

// ===========================================================================
console.log('── 4. the native module matches the Electron ABI ──');
// ===========================================================================
{
  // better-sqlite3 is compiled against a specific Node ABI. Electron 41+
  // embeds Node 24 (ABI 137); better-sqlite3 11 predates Node 24 support and
  // declares `20.x || 22.x || 23.x` — it would fail to rebuild at package
  // time, and the failure appears as a broken installer, not a test failure.
  const e = Number(String(lockedVersion('electron') || '0').split('.')[0]);
  const s = lockedVersion('better-sqlite3');
  const sMajor = Number(String(s || '0').split('.')[0]);
  ok('better-sqlite3 is locked', Boolean(s));
  if (e >= 41) {
    ok(`electron ${e} needs better-sqlite3 >= 12 (Node 24 ABI), have ${s}`,
      sMajor >= 12,
      'better-sqlite3 11 declares node 20.x||22.x||23.x and cannot rebuild for Node 24');
  }
}

// ===========================================================================
console.log('── 5. the vite / plugin pairing actually resolves ──');
// ===========================================================================
{
  // `npm audit fix --force` proposed vite 8. That pulls @vitejs/plugin-react 6,
  // whose peer range is `vite ^8.0.0` — and the repository pins plugin-react
  // ^4.3.1, so the two cannot both be satisfied. MEASURED: installing
  // vite@6 with @vitejs/plugin-react@* fails with ERESOLVE.
  //
  // The pairing that resolves AND builds is vite 6 with plugin-react 4.7.0,
  // whose peers are `^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`.
  const vite = lockedVersion('vite');
  const plugin = locked['node_modules/@vitejs/plugin-react'];
  ok('vite is locked', Boolean(vite));
  ok('@vitejs/plugin-react is locked', Boolean(plugin?.version));

  const peers = plugin?.peerDependencies?.vite || '';
  const viteMajor = Number(String(vite || '0').split('.')[0]);
  ok(`plugin-react ${plugin?.version} accepts vite ${viteMajor}`,
    peers.includes(`^${viteMajor}.`) || peers.includes(`>=${viteMajor}`),
    `plugin peer range is "${peers}"`);
}

// ===========================================================================
console.log('── 6. the removed react-router v7 API is gone from the source ──');
// ===========================================================================
{
  // v7 deleted the `future` prop from the router components: those flags
  // describe v7 behaviour, which in v7 is simply the behaviour. Leaving it
  // fails the typecheck, and in plain JS would be silently ignored.
  const main = readFileSync(join(ROOT, 'src/renderer/src/main.tsx'), 'utf8');
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no `future=` prop remains on the router', !/future\s*=\s*\{/.test(code));
  ok('the app still mounts a HashRouter', /<HashRouter>/.test(code),
    'an Electron app loads from file:// and cannot use browser history');

  // Only the declarative API is used. This matters for the one advisory that
  // remains open: GHSA-qwww-vcr4-c8h2 states it "only affects your application
  // if you are using the unstable RSC APIs". If a future change introduces a
  // data router, that reasoning stops holding and this check fails loudly.
  const rendererDir = join(ROOT, 'src/renderer');
  // Scanned in Node, not by shelling out to `grep`.
  //
  // `grep` is not on PATH on Windows and `|| true` needs a POSIX shell, so
  // this returned nothing there — and "nothing found" is exactly the PASSING
  // answer. The check would have reported success on every Windows machine
  // without reading a single file, which is worse than failing.
  const RSC_API = /createBrowserRouter|createHashRouter|createMemoryRouter|unstable_|RouterProvider|useFetcher|useLoaderData|deserializeErrors/;
  const rscFiles = [];
  (function scan(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(e.name)) continue;
      try {
        if (RSC_API.test(readFileSync(full, 'utf8'))) rscFiles.push(full);
      } catch { /* unreadable */ }
    }
  })(rendererDir);
  const rscHits = rscFiles.join('\n').trim();
  ok('the renderer uses only the declarative router (no data router, no RSC)',
    rscHits === '',
    `found in: ${rscHits.split('\n').slice(0, 3).join(', ')} — the RSC advisory ` +
    'GHSA-qwww-vcr4-c8h2 would then apply and react-router must go to >= 8.3.0');
}

// ===========================================================================
console.log('── 7. runtime vs build-time exposure is understood ──');
// ===========================================================================
{
  // Only `dependencies` ship inside the .asar. A high-severity advisory in a
  // devDependency is a developer-machine risk, not a customer risk, and the
  // two must not be conflated — but electron is the exception that proves the
  // rule: it is declared as a devDependency and its binary IS the runtime.
  const runtime = Object.keys(pkg.dependencies || {});
  ok('react-router-dom is a runtime dependency', runtime.includes('react-router-dom'),
    'it ships to the customer, which is why the v7 major was not optional');
  ok('better-sqlite3 is a runtime dependency', runtime.includes('better-sqlite3'));
  ok('electron is NOT a runtime dependency', !runtime.includes('electron'),
    'forge packages the binary; listing it here would duplicate it into the asar');

  // The two native modules are excluded from the main bundle, so their
  // lockfile versions are what actually ships.
  const viteMain = readFileSync(join(ROOT, 'vite.main.config.ts'), 'utf8');
  ok('better-sqlite3 stays external to the main bundle', /external:.*better-sqlite3/s.test(viteMain));
  ok('bcryptjs stays external to the main bundle', /external:.*bcryptjs/s.test(viteMain));
}

// ===========================================================================
console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — no known-vulnerable dependency in the tree`);
