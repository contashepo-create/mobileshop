#!/usr/bin/env node
/**
 * PROVES THE PACKAGED APP CAN ACTUALLY START.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Version 1.0.0 was built, uploaded to R2, published, and verified end to end.
 * Every one of the 87 suites passed. The installer ran. Then the app died on
 * first launch, before any window appeared:
 *
 *     A JavaScript error occurred in the main process
 *     Error: Cannot find module 'better-sqlite3'
 *     Require stack: ...\app-1.0.0\resources\app.asar\...\index.js
 *
 * Nothing in the battery could have caught it, and the reason is worth stating
 * plainly: EVERY existing suite tests the SOURCE. `verify_build` type-checks
 * and bundles the entry points with esbuild, which proves the code compiles.
 * It does not prove that the files the compiled code needs were COPIED into
 * the installer. That is a packaging question, and packaging was unexamined.
 *
 * THE DEFECT
 * ----------
 * `@electron-forge/plugin-vite` installs its own packager filter:
 *
 *     forgeConfig.packagerConfig.ignore = (file) => !file.startsWith('/.vite')
 *
 * It keeps `.vite` and discards everything else, including all of
 * `node_modules`. For an app whose dependencies are bundled that is exactly
 * right. This app externalises two of them — better-sqlite3 must be external
 * because a native .node cannot be bundled — so the bundle keeps a literal
 * `require('better-sqlite3')` pointing at a folder that was never shipped.
 *
 * `asar.unpackDir: 'node_modules/better-sqlite3'` looked like it covered this
 * and did not: unpack decides whether a copied file sits inside the archive or
 * beside it. A file that was never copied cannot be unpacked. The setting was
 * a no-op on an empty set, which is why it read as protection.
 *
 * WHAT IS PROVEN — statically, so it runs on any machine with no build
 *   [1] every module marked `external` for the main process is packaged
 *   [2] the packaged list is the full RUNTIME closure, re-derived here
 *   [3] the filter keeps package.json and the built output
 *   [4] the filter still excludes the bulk (no accidental ship-everything)
 *   [5] a real .asar, when present, actually contains those modules
 *
 * [2] is the one that survives a dependency bump: it loads the modules and
 * traces what they really require, rather than trusting a hand-written list.
 *
 * Run:  node --experimental-strip-types scripts/verify_packaged_app.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
  return ok;
}
const raw = (f) => readFileSync(join(ROOT, f), 'utf-8');

console.log('='.repeat(72));
console.log('PACKAGED APP — can the built .exe actually start?');
console.log('='.repeat(72));

// ------------------------------------------------------------------ 0
// Read the two configs as text. Importing forge.config.ts would need the
// forge toolchain installed, and this suite must run anywhere.
const forge = raw('forge.config.ts');
const viteMain = raw('vite.main.config.ts');

/** The list forge.config.ts declares as needing to be copied. */
function declaredRuntimeModules() {
  const m = /const RUNTIME_MODULES\s*=\s*\[([\s\S]*?)\]/.exec(forge);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
}

/** What vite.main.config.ts refuses to bundle into the main process. */
function externalisedModules() {
  const m = /external:\s*\[([\s\S]*?)\]/.exec(viteMain);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
}

console.log('\n[1] Everything the main bundle refuses to inline is packaged');
const declared = declaredRuntimeModules();
const external = externalisedModules();
{
  if (!t('forge.config.ts declares a RUNTIME_MODULES list', declared !== null,
    'no RUNTIME_MODULES array found')) {
    console.log('\n  Without it the Vite plugin\'s default filter ships no node_modules');
    console.log('  at all, and the app cannot start.');
  }
  t('vite.main.config.ts marks native modules external', external.length > 0,
    JSON.stringify(external));

  // The actual defect, stated as an assertion: external but not packaged.
  const missing = external.filter(m => !(declared || []).includes(m));
  t('no module is externalised without being packaged', missing.length === 0,
    missing.length ? `${missing.join(', ')} would be required at runtime and absent` : '');
}

// ------------------------------------------------------------------ 2
console.log('\n[2] The packaged list is the full runtime closure');
{
  // Trace what the modules REALLY load. A hand-written list goes stale the
  // first time a dependency adds one of its own; better-sqlite3 -> bindings
  // -> file-uri-to-path is exactly that shape, and only the first was obvious.
  const req = createRequire(join(ROOT, 'node_modules', 'x.js'));
  let traced = null;
  try {
    const Module = req('node:module');
    const seen = new Set();
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      const result = orig.apply(this, arguments);
      try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        const parts = resolved.split(`${sep}node_modules${sep}`);
        if (parts.length > 1) {
          const tail = parts[parts.length - 1];
          seen.add(tail.startsWith('@')
            ? tail.split(sep).slice(0, 2).join('/')
            : tail.split(sep)[0]);
        }
      } catch { /* builtin or unresolvable: not a packaged module */ }
      return result;
    };
    try {
      for (const m of external) {
        let loaded;
        try { loaded = req(m); } catch { /* a missing native binary still reveals the JS graph */ }

        // Requiring is NOT enough, and this was measured. better-sqlite3 does
        // `require('bindings')` INSIDE the Database constructor, not at module
        // scope, so a plain require traces only better-sqlite3 itself — and an
        // earlier version of this suite happily passed a RUNTIME_MODULES list
        // with `bindings` and `file-uri-to-path` deleted, which is precisely
        // the crash it exists to prevent, one module further along.
        //
        // So the module is USED, not merely loaded. The call throws here
        // (there is no compiled binary in a source checkout) but only after
        // the lazy requires have already been traced, which is all this needs.
        try {
          if (typeof loaded === 'function') new loaded(':memory:');
        } catch { /* the require graph is captured before the throw */ }
      }
    } finally {
      Module._load = orig;
    }
    traced = [...seen].sort();
  } catch {
    traced = null;
  }

  if (!traced || traced.length === 0) {
    console.log('  SKIP  dependencies are not installed in this checkout');
  } else {
    const notPackaged = traced.filter(m => !(declared || []).includes(m));
    t('every module loaded at runtime is in RUNTIME_MODULES',
      notPackaged.length === 0,
      notPackaged.length ? `missing: ${notPackaged.join(', ')}` : `traced: ${traced.join(', ')}`);
  }
}

// ------------------------------------------------------------------ 3
console.log('\n[3] The filter keeps what Electron needs to boot');
{
  // Rebuild the filter from the file so the test exercises the shipped logic,
  // not a copy of it that can drift.
  const body = /ignore:\s*\(file:\s*string\)\s*=>\s*\{([\s\S]*?)\n    \},/.exec(forge);
  if (!t('forge.config.ts defines a packagerConfig.ignore filter', !!body)) {
    console.log('  Without an explicit filter the Vite plugin installs its own,');
    console.log('  which drops all of node_modules.');
  } else {
    const src = body[1]
      .replace(/RUNTIME_MODULES/g, JSON.stringify(declared || []));
    let ignore;
    try {
      ignore = new Function('file', src);
    } catch (e) {
      ignore = null;
      t('the filter is syntactically valid', false, e.message);
    }

    if (ignore) {
      const keep = (f) => ignore(f) === false;
      t('the built app is kept', keep('/.vite/build/index.js'));
      // Electron reads `main` out of package.json to find the entry point.
      t('package.json is kept (Electron reads `main` from it)', keep('/package.json'));
      t('the node_modules directory itself is kept', keep('/node_modules'),
        'a filter that rejects the directory is never asked about its contents');

      for (const m of declared || []) {
        t(`${m} is kept`, keep(`/node_modules/${m}/package.json`));
      }
      // The binary is the whole point for the native module.
      t('the compiled .node binary is kept',
        keep('/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
    }

    // ------------------------------------------------------------------ 4
    console.log('\n[4] …and still excludes everything else');
    if (ignore) {
      const drop = (f) => ignore(f) === true;
      t('the toolchain is not shipped', drop('/node_modules/typescript/lib/tsc.js'));
      t('electron itself is not shipped', drop('/node_modules/electron/dist/electron.exe'));
      t('bundled deps are not shipped twice', drop('/node_modules/react/index.js'));
      t('TypeScript source is not shipped', drop('/src/main/index.ts'));
      t('previous installers are not shipped', drop('/out/make/x/y.nupkg'));
      // Secrets. `.env` holds the admin key; shipping it inside the installer
      // would hand every customer the key that publishes updates to everyone.
      t('.env is NEVER shipped', drop('/.env'));
      t('the git directory is not shipped', drop('/.git/config'));
      t('the signing key is not shipped', drop('/scripts/.license-key'));
      // A name that merely starts with a packaged module's name must not slip
      // through on a prefix match.
      t('a look-alike package name is not shipped',
        drop('/node_modules/bindings-extra/index.js'));
    }
  }
}

// ------------------------------------------------------------------ 5
console.log('\n[5] A real packaged app, if one is present, contains the modules');
{
  const outDir = join(ROOT, 'out');
  let asar = null;
  if (existsSync(outDir)) {
    const stack = [outDir];
    while (stack.length && !asar) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === 'app.asar') { asar = full; break; }
      }
    }
  }

  if (!asar) {
    console.log('  SKIP  no packaged output in out/ — run `npm run package` first');
  } else {
    // The asar format is a JSON header describing the archive. It is read
    // directly rather than with the `asar` package, which is not a dependency:
    //   <8 bytes of picking> <header JSON> <payload>
    const fd = readFileSync(asar);
    const headerSize = fd.readUInt32LE(12);
    const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'));
    const top = header.files || {};

    t('the archive has a node_modules folder', !!top.node_modules,
      `top level: ${Object.keys(top).join(', ')}`);
    const mods = top.node_modules?.files || {};
    for (const m of declared || []) {
      // An unpacked file is listed with `unpacked: true` and lives beside the
      // archive; either form counts as shipped.
      t(`${m} is inside the packaged app`, !!mods[m], `present: ${Object.keys(mods).join(', ')}`);
    }
    t('package.json is inside the packaged app', !!top['package.json']);

    // The unpacked native binary must exist on disk next to the archive.
    const unpackedDir = `${asar}.unpacked`;
    if (existsSync(unpackedDir)) {
      const found = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.node')) found.push(full);
        }
      };
      walk(unpackedDir);
      t('the native .node binary is unpacked beside the archive', found.length > 0,
        'no .node found in app.asar.unpacked');
      if (found.length) {
        t('the binary is not empty', found.every(f => statSync(f).size > 1024));
      }
    } else {
      t('app.asar.unpacked exists (native modules must be unpacked)', false,
        'asar.unpackDir did not produce an unpacked folder');
    }
  }
}

console.log(`\n${'='.repeat(72)}`);
if (failures.length) {
  console.error(`RESULT: ${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.error('  x ' + f);
  console.error('');
  process.exit(1);
}
console.log(`RESULT: ${pass} passed, 0 failed`);
console.log('='.repeat(72));
