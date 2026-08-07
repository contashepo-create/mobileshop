/**
 * Builds a traditional NSIS installer (.exe) that lets the user choose the
 * installation path, creates desktop/start-menu shortcuts, and runs after install.
 *
 * Flow:
 *   1. electron-forge package  → out/MobileShopERP-win32-x64/
 *   2. electron-builder (NSIS)  → dist-installer/MobileShopERP Setup 1.0.0.exe
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();

// Step 1: Package with electron-forge (if not already done)
const pkgDir = path.join(root, 'out', 'MobileShopERP-win32-x64');
if (!fs.existsSync(pkgDir)) {
  console.log('[installer] Running electron-forge package...');
  execSync('npx electron-forge package', {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
}

// Step 2: Build NSIS installer from the prepackaged app
console.log('[installer] Building NSIS installer...');
execSync('npx electron-builder --win nsis --config electron-builder.yml --prepackaged "out/MobileShopERP-win32-x64"', {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
});

console.log('\n[installer] Done!');
console.log('[installer] Installer: dist-installer/MobileShopERP Setup 1.0.0.exe');
