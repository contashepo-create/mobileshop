/**
 * Copies native modules (better-sqlite3) into the packaged app's
 * app.asar.unpacked directory.
 *
 * The VitePlugin only includes Vite build output + package.json in the
 * asar — externalized modules are missing entirely. This script runs
 * AFTER `electron-forge package` and copies the pre-built native module
 * to where Electron expects it: resources/app.asar.unpacked/node_modules/.
 */
import fs from 'node:fs';
import path from 'node:path';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const outDir = path.join(process.cwd(), 'out');
if (!fs.existsSync(outDir)) {
  console.error('[copy-natives] out/ directory not found — run electron-forge package first');
  process.exit(1);
}

// Find the platform-specific output directory (e.g. MobileShopERP-win32-x64)
const dirs = fs.readdirSync(outDir).filter(d =>
  fs.statSync(path.join(outDir, d)).isDirectory() &&
  fs.existsSync(path.join(outDir, d, 'resources'))
);

if (dirs.length === 0) {
  console.error('[copy-natives] no packaged app found in out/');
  process.exit(1);
}

for (const dir of dirs) {
  const resourcesDir = path.join(outDir, dir, 'resources');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const srcDir = path.join(process.cwd(), 'node_modules', 'better-sqlite3');

  if (!fs.existsSync(srcDir)) {
    console.error('[copy-natives] better-sqlite3 not found in node_modules');
    process.exit(1);
  }

  // Remove stale copy if present
  if (fs.existsSync(unpackedDir)) {
    fs.rmSync(unpackedDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(unpackedDir), { recursive: true });
  copyDir(srcDir, unpackedDir);

  const nodeFile = path.join(unpackedDir, 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(nodeFile)) {
    console.log(`[copy-natives] ✓ ${dir}: better-sqlite3 copied (${(fs.statSync(nodeFile).size / 1024).toFixed(0)} KB binary)`);
  } else {
    console.error(`[copy-natives] ✗ ${dir}: .node binary missing after copy!`);
    process.exit(1);
  }
}

console.log('[copy-natives] done');
