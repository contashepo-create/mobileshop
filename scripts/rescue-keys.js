#!/usr/bin/env node
/**
 * Recovers keys that were pasted into source files, and writes them to .env.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original instructions said to paste the licence public key and the
 * developer password hash directly into `licenseCrypto.ts` and `devAuth.ts`.
 * Both files are tracked by git, so the next `git pull` refused to merge:
 *
 *     error: Your local changes to the following files would be overwritten
 *
 * That is the good outcome — git noticed. The bad outcome was equally
 * available: `git checkout` those files to unblock the pull, and the real
 * licence key is gone. Every activation code already issued was signed against
 * its private half, so losing it silently breaks every paying customer.
 *
 * This script reads the values out of the working copy BEFORE anything is
 * discarded, and puts them where they belong.
 *
 * Usage:
 *     node scripts/rescue-keys.js            # show what was found
 *     node scripts/rescue-keys.js --write    # merge into .env
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

/**
 * Pulls the first single-quoted value assigned to any of `names`.
 *
 * Deliberately tolerant about the declaration keyword and whitespace: the file
 * may be the old shape (`const X = '...'`) or the new one (`let X =\n  ...`),
 * and the whole point is to work on a copy that is mid-migration.
 */
function findAssigned(file, names) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  for (const name of names) {
    const re = new RegExp(`${name}\\s*=\\s*'([^']+)'`);
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

// The values shipped in the repository. Finding one of these means the file
// was never edited, so there is nothing to rescue — reporting it as a recovered
// secret would be worse than saying nothing.
const KNOWN_DEFAULTS = new Set([
  'o3+4sp7nJmjnATFF5q5NXnLYn75kLTjKSxCYu4xfKfs=',
  '$2a$12$roA4Cm.0DuiKYwPtxUNfSuX/Ao1ZKH2ofhjtHX3qJw83WjMBmoTK2',
]);

const found = {};

const pub = findAssigned(
  path.join(ROOT, 'src/main/security/licenseCrypto.ts'),
  ['LICENSE_PUBLIC_KEY', 'DEV_FALLBACK_PUBLIC_KEY'],
);
if (pub && !KNOWN_DEFAULTS.has(pub)) found.MOBILESHOP_LICENSE_PUBLIC_KEY = pub;

const hash = findAssigned(
  path.join(ROOT, 'src/main/security/devAuth.ts'),
  ['DEV_PASSWORD_HASH', 'DEV_FALLBACK_HASH'],
);
if (hash && !KNOWN_DEFAULTS.has(hash)) found.MOBILESHOP_DEV_PASSWORD_HASH = hash;

console.log('\n=== KEYS FOUND IN YOUR SOURCE FILES ===\n');

if (Object.keys(found).length === 0) {
  console.log('None. Both files still hold the values from the repository,');
  console.log('so nothing was pasted in and nothing needs rescuing.\n');
  console.log('If you did paste a key and it is not showing, you may already');
  console.log('have discarded the edit. Generate a new pair:\n');
  console.log('    npm run license:init\n');
  process.exit(0);
}

for (const [k, v] of Object.entries(found)) {
  const shown = v.length > 20 ? `${v.slice(0, 14)}...${v.slice(-6)}` : v;
  console.log(`  ${k}`);
  console.log(`    ${shown}\n`);
}

if (!process.argv.includes('--write')) {
  console.log('Run again with --write to save these into .env:\n');
  console.log('    node scripts/rescue-keys.js --write\n');
  process.exit(0);
}

// Merge rather than overwrite: .env may already hold the API keys, and
// clobbering them to save these two would trade one loss for another.
let existing = '';
try { existing = fs.readFileSync(ENV_FILE, 'utf-8'); } catch { /* creating it */ }

const lines = existing ? existing.split(/\r?\n/) : [];
for (const [key, value] of Object.entries(found)) {
  const idx = lines.findIndex(l => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}

// Keep the file tidy: one trailing newline, no run of blanks at the end.
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
fs.writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, 'utf-8');

console.log(`Saved to ${ENV_FILE}\n`);
console.log('Now restore the source files and pull:\n');
console.log('    git checkout -- src/main/security/devAuth.ts src/main/security/licenseCrypto.ts');
console.log('    git pull origin master\n');
console.log('Your keys are safe in .env, which git ignores.\n');
