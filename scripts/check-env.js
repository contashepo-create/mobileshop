#!/usr/bin/env node
/**
 * Reports whether .env is present and complete — and what a build made NOW
 * would actually contain.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run verify` cannot answer this. The suites import the source directly,
 * where the licence key falls back to a development value so that local work
 * needs no setup. That fallback is deliberate, but it means every check passes
 * whether or not .env exists — so a developer can be entirely confident and
 * still be one `npm run make` away from shipping a build that any customer
 * could forge a licence for.
 *
 * The packaged app refuses to start on the development keys
 * (assertProductionKeys), so the mistake cannot reach a customer. This script
 * exists so it is caught before the build, not after.
 *
 * Usage:  npm run check:env
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

/** The values that ship in the repository. Using one is not a configuration. */
const DEV_DEFAULTS = {
  MOBILESHOP_LICENSE_PUBLIC_KEY: 'o3+4sp7nJmjnATFF5q5NXnLYn75kLTjKSxCYu4xfKfs=',
  MOBILESHOP_DEV_PASSWORD_HASH: '$2a$12$roA4Cm.0DuiKYwPtxUNfSuX/Ao1ZKH2ofhjtHX3qJw83WjMBmoTK2',
};

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

console.log('\n=== .env STATUS ===\n');

if (!fs.existsSync(ENV_FILE)) {
  console.log('  .env does not exist.\n');
  console.log('  Development still works — the app falls back to test keys.');
  console.log('  But a PACKAGED build will refuse to start on them.\n');
  console.log('  Create it:  copy .env.example .env\n');
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(ENV_FILE, 'utf-8'));

const CHECKS = [
  ['MOBILESHOP_LICENSE_PUBLIC_KEY', true, 'licence verification key (npm run license:init)'],
  ['MOBILESHOP_DEV_PASSWORD_HASH', true, 'developer console password (npm run dev:password)'],
  ['MOBILESHOP_API_BASE', false, 'Cloudflare Worker URL — licensing and remote notices'],
  ['MOBILESHOP_CLIENT_KEY', false, 'Worker client key'],
];

let blocking = 0;
let warnings = 0;

for (const [key, required, what] of CHECKS) {
  const value = (env[key] || '').trim();

  if (!value) {
    if (required) { blocking++; console.log(`  MISSING   ${key}`); }
    else { warnings++; console.log(`  empty     ${key}`); }
    console.log(`            ${what}\n`);
    continue;
  }

  if (DEV_DEFAULTS[key] === value) {
    blocking++;
    console.log(`  DEV KEY   ${key}`);
    console.log('            still the value from the repository — a packaged');
    console.log('            build will refuse to start.\n');
    continue;
  }

  const shown = value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
  console.log(`  ok        ${key}  =  ${shown}\n`);
}

// The private key is what actually issues licences; losing it is unrecoverable.
const keyFile = path.join(ROOT, 'scripts/.license-key');
if (fs.existsSync(keyFile)) {
  console.log('  ok        scripts/.license-key present (the signing key)');
  console.log('            back this up — losing it means re-issuing every licence\n');
} else if (env.MOBILESHOP_LICENSE_PUBLIC_KEY) {
  console.log('  WARNING   scripts/.license-key is MISSING');
  console.log('            you have a public key configured but not the private');
  console.log('            half, so you cannot issue any new activation code.');
  console.log('            Restore it from your backup.\n');
  warnings++;
}

if (blocking > 0) {
  console.log(`RESULT: ${blocking} value(s) must be set before packaging.\n`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`RESULT: usable, with ${warnings} warning(s).\n`);
  process.exit(0);
}
console.log('RESULT: .env is complete — this build is ready to package.\n');
