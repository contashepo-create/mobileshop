/**
 * Builds a traditional NSIS installer (.exe) that lets the user choose the
 * installation path, whether to install for all users or the current user,
 * a separate data (database) folder, desktop/start-menu shortcuts, and shows
 * the licence page — everything a Squirrel installer cannot do.
 *
 * Flow:
 *   1. electron-forge package  → out/MobileShopERP-win32-x64/
 *   2. electron-builder (NSIS) → dist-installer/MobileShopERP Setup <version>.exe
 *                                + latest.yml + <exe>.blockmap
 *
 * The `.blockmap` next to the installer is what makes updates small: the
 * server serves it, and electron-updater downloads only the changed 256 KB
 * blocks of the full installer. A one-line source change ships as a few MB
 * instead of the full ~130 MB build.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();

const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkgJson.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`رقم إصدار غير صالح في package.json: ${version}`);
  process.exit(1);
}

// Step 1: Package with electron-forge (if not already done)
const pkgDir = path.join(root, 'out', 'MobileShopERP-win32-x64');
if (!fs.existsSync(pkgDir)) {
  console.log('[installer] Running electron-forge package...');
  // NODE_INSTALLER=npm skips yarn-or-npm's binary detection, which resolves the
  // detected package manager to a PowerShell shim under nvm4w and makes forge's
  // "checking package manager version" step return undefined and abort.
  const env = { ...process.env, NODE_ENV: 'development', NODE_INSTALLER: 'npm' };
  execSync('npx electron-forge package', { stdio: 'inherit', env });
}

// Step 2: Build NSIS installer from the prepackaged app.
// The artifact name is pinned so the publish script can find it without
// globbing and so latest.yml's `path` field matches the served filename.
console.log(`[installer] Building NSIS installer ${version}...`);
const outDir = path.join(root, 'dist-installer');
fs.mkdirSync(outDir, { recursive: true });
execSync(
  `npx electron-builder --win nsis --config electron-builder.yml --prepackaged "out/MobileShopERP-win32-x64"`,
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      // electron-builder derives these from the environment if present.
      ELECTRON_BUILDER_BINARY_NAME: 'MobileShopERP Setup',
    },
  },
);

// Step 3: Report the produced artifacts.
console.log('\n[installer] Done!');
for (const f of fs.readdirSync(outDir).filter(f => /\.(exe|yml|blockmap)$/.test(f))) {
  const size = (fs.statSync(path.join(outDir, f)).size / 1048576).toFixed(1);
  console.log(`  ${f}  (${size} MB)`);
}
