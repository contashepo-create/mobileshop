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

// Step 1: Package with electron-forge.
//
// WHY rebuild unless we can PROVE the existing asar matches this release:
// electron-builder stamps the installer filename/latest.yml from package.json,
// but the code INSIDE the exe comes from `out/MobileShopERP-win32-x64/...asar`,
// which electron-forge must have repacked AFTER the version bump. Reusing a
// stale `out/` produced an installer named 1.0.4 that was really still running
// 1.3 code — the About page said 1.3 while the installer claimed 1.4, and the
// old code had no update UI. So: extract the packaged app's own version and
// rebuild on ANY mismatch.
const pkgDir = path.join(root, 'out', 'MobileShopERP-win32-x64');
const embeddedVersion = (() => {
  try {
    const asar = require('@electron/asar');
    const pkgPath = path.join(pkgDir, 'resources', 'app.asar');
    if (!fs.existsSync(pkgPath)) return null;
    const buf = asar.extractFile(pkgPath, 'package.json');
    const pkg = JSON.parse(buf.toString('utf-8'));
    return String(pkg.version || '').trim();
  } catch {
    return null;
  }
})();

if (embeddedVersion !== version) {
  console.log(`[installer] asar version ${embeddedVersion || '(غير موجود)'} != target ${version} — إعادة تصنيع`);
  // NODE_INSTALLER=npm skips yarn-or-npm's binary detection, which resolves the
  // detected package manager to a PowerShell shim under nvm4w and makes forge's
  // "checking package manager version" step return undefined and abort.
  const env = { ...process.env, NODE_ENV: 'development', NODE_INSTALLER: 'npm' };
  execSync('npx electron-forge package', { stdio: 'inherit', env });
} else {
  console.log(`[installer] asar version ${version} — reuse package`);
}

// Step 1.5: Inject app-update.yml.
//
// electron-updater reads `process.resourcesPath/app-update.yml` on the DOWNLOAD
// step (`getOrCreateDownloadHelper` → `loadUpdateConfig` → readFile), and
// `electron-builder --prepackaged` NEVER generates it: that file is normally
// written only when electron-builder builds the app from source, which our
// flow (forge package → electron-builder --prepackaged) skips. An installer
// without it fails with "ENOENT ... resources/app-update.yml" the moment a
// shop clicks update, so every build ships it explicitly. The content must
// match `electron-builder.yml`'s `publish` (electron-updater uses its url for
// latest.yml) and the updaterCacheDirName that `appInfo.updaterCacheDirName`
// computes (`<sanitized-name>-updater`).
const resourcesDir = path.join(pkgDir, 'resources');
fs.mkdirSync(resourcesDir, { recursive: true });
const updaterYaml = `provider: generic\n`
  + `updaterCacheDirName: mobile-shop-erp-updater\n`
  + `url: https://mobileshop-licensing.mobileshop2026.workers.dev/update-nsis/win32-x64\n`;
fs.writeFileSync(path.join(resourcesDir, 'app-update.yml'), updaterYaml, 'utf-8');
console.log('[installer] injected resources/app-update.yml into the packaged app');

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
