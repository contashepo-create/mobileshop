#!/usr/bin/env node
/**
 * Generates the developer password hash — DEVELOPER MACHINE ONLY.
 *
 * WHY THIS EXISTS
 * ---------------
 * `DEV_PASSWORD_HASH` ships inside every build. Anyone who unpacks app.asar
 * has it, so the only thing standing between them and developer access is how
 * hard the password is to guess offline. The original was six digits: one
 * million possibilities, which bcrypt at cost 12 exhausts in minutes on a
 * laptop. The in-app lockout does not apply to an attacker working offline.
 *
 * A long passphrase makes the same shipped hash useless.
 *
 * Usage:
 *   node scripts/dev-password.js "correct horse battery staple"
 *
 * Then paste the printed line into src/main/security/devAuth.ts.
 */
const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('\nUsage: node scripts/dev-password.js "your long passphrase"\n');
  process.exit(1);
}

// Refuse the two shapes that caused the problem in the first place.
if (password.length < 12) {
  console.error(`\nToo short (${password.length} characters). Use at least 12.`);
  console.error('A short password does not become safe by being hashed: the hash');
  console.error('ships to every customer and can be attacked offline.\n');
  process.exit(1);
}
if (/^\d+$/.test(password)) {
  console.error('\nDigits only. A numeric password of any practical length has a');
  console.error('keyspace small enough to exhaust offline. Use words.\n');
  process.exit(1);
}

/**
 * Refuse anything built around a password that is already public.
 *
 * The original developer password, '014253', is written in a comment in
 * devAuth.ts explaining the old flaw — and it is in the git history for ever.
 * Reusing it with a suffix is therefore not a new password at all: an attacker
 * who reads the source has a wordlist of one, and only has to try a handful of
 * endings.
 *
 * Measured against a real hash produced by this very script: '014253@Asdfg'
 * fell in 1.3 seconds on the fourth guess. The bcrypt cost is irrelevant when
 * the candidate list is that short.
 */
const BURNED = ['014253', 'zerocold', 'mobileshop', 'mobile shop', 'admin123'];
const lower = password.toLowerCase();
const burned = BURNED.find(b => lower.includes(b));
if (burned) {
  console.error(`\nThis contains "${burned}", which is already public.`);
  console.error('It appears in the source code and in the git history, so it is');
  console.error('the FIRST thing an attacker tries — with or without a suffix.');
  console.error('Measured: "014253@Asdfg" was cracked in 1.3s on the 4th guess.\n');
  console.error('Choose something unrelated to the old password.\n');
  process.exit(1);
}

/** Four or more unrelated words beats one word with symbols bolted on. */
const words = password.trim().split(/\s+/).filter(w => w.length >= 3);
if (words.length < 3 && password.length < 20) {
  console.error(`\nToo predictable (${password.length} characters, ${words.length} word(s)).`);
  console.error('Use either at least 3 separate words, or 20+ characters.');
  console.error('Example: "قطة زرقاء تشرب شاي بالنعناع"\n');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log('\n=== DEVELOPER PASSWORD HASH ===\n');
console.log('Paste this line into src/main/security/devAuth.ts:\n');
console.log(`const DEV_PASSWORD_HASH = '${hash}';\n`);
console.log('Store the passphrase itself in a password manager. It is not');
console.log('recoverable from the hash, and replacing it means rebuilding.\n');
