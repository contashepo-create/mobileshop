#!/usr/bin/env node
/**
 * Publishes a build to the developer's own Cloudflare Worker.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Publishing an update is three steps that must all be right, and getting one
 * wrong is silent: the customer's app simply never updates, and nobody finds
 * out until somebody phones about a bug that was fixed months ago.
 *
 *   1. upload the .nupkg to R2
 *   2. tell the Worker its exact SHA-1 and byte length
 *   3. make sure package.json's version was actually bumped
 *
 * Squirrel verifies the hash before it installs anything. A mistyped hash
 * means every customer downloads the whole package and then discards it —
 * forever, on every check. So the hash is computed here, from the file, and
 * never typed by a human.
 *
 * USAGE
 *   npm run release
 *
 * It reads MOBILESHOP_API_BASE and MOBILESHOP_ADMIN_KEY from the environment
 * or from .env, and refuses to do anything if either is missing.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** Reads .env without a dependency. Same format the other scripts expect. */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.MOBILESHOP_ADMIN_KEY || '';
const BUCKET = process.env.MOBILESHOP_R2_BUCKET || 'mobileshop-updates';

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!API_BASE) die('MOBILESHOP_API_BASE غير مضبوط — ضعه في ملف .env');
if (!ADMIN_KEY) die('MOBILESHOP_ADMIN_KEY غير مضبوط — ضعه في ملف .env');

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkgJson.version;
if (!/^\d+\.\d+\.\d+/.test(version)) die(`رقم إصدار غير صالح في package.json: ${version}`);

// Squirrel names the package after the product, not the npm package name.
const outDir = path.join(ROOT, 'out', 'make', 'squirrel.windows', 'x64');
if (!fs.existsSync(outDir)) {
  die(`لم يتم العثور على مجلد البناء:\n   ${outDir}\n\nشغّل أولاً:  npm run make`);
}

const nupkg = fs.readdirSync(outDir).find(f => f.endsWith('-full.nupkg') && f.includes(version));
if (!nupkg) {
  const found = fs.readdirSync(outDir).filter(f => f.endsWith('.nupkg'));
  die(
    `لا يوجد ملف .nupkg للإصدار ${version} في:\n   ${outDir}\n` +
    (found.length ? `\nالموجود: ${found.join(', ')}\n\n` +
      'الأرجح أنك لم ترفع رقم الإصدار قبل البناء. ارفعه ثم أعد البناء:\n' +
      '   npm version 1.0.1 --no-git-tag-version\n   npm run make'
      : ''),
  );
}

const file = path.join(outDir, nupkg);
const buf = fs.readFileSync(file);
const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
const size = buf.length;

console.log('');
console.log('══════════════════════════════════════════════');
console.log('  نشر إصدار جديد');
console.log('══════════════════════════════════════════════');
console.log(`  الإصدار : ${version}`);
console.log(`  الملف   : ${nupkg}`);
console.log(`  الحجم   : ${(size / 1048576).toFixed(1)} MB`);
console.log(`  البصمة  : ${sha1}`);
console.log(`  الخادم  : ${API_BASE}`);
console.log('');

// ---- 1. upload to R2 -------------------------------------------------------
console.log('⬆️  رفع الحزمة إلى R2 …');
try {
  // `npx.cmd` on Windows, `npx` elsewhere.
  //
  // `execFileSync('npx', ...)` runs an EXECUTABLE directly, with no shell. On
  // Windows npx is `npx.cmd`, a batch script, so the spawn fails with ENOENT
  // before wrangler is ever reached. MEASURED on the owner's machine: the
  // upload failed instantly and the advice printed below sent them to check a
  // login and a bucket that were both already correct.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(npx, [
    'wrangler', 'r2', 'object', 'put',
    `${BUCKET}/win32-x64/${nupkg}`,
    '--file', file,
    '--content-type', 'application/octet-stream',
    '--remote',
  ], { stdio: 'inherit', cwd: path.join(ROOT, 'server') });
} catch (err) {
  // The REAL reason is printed. `catch { die(...) }` swallowed it and replaced
  // every possible fault — a missing npx, an expired token, a network drop, a
  // bucket that does not exist — with one guess. A publisher that cannot say
  // why it failed sends the operator to fix things that are not broken.
  const detail = String(err && err.message ? err.message : err).split('\n')[0];
  die(`فشل رفع الملف إلى R2.\n   السبب: ${detail}\n\n` +
      '   إن كان السبب انتهاء الجلسة:  npx wrangler login\n' +
      `   إن كان الدلو غير موجود:      npx wrangler r2 bucket create ${BUCKET}`);
}

// ---- 2. tell the Worker ----------------------------------------------------
console.log('\n📢 إبلاغ الخادم بالإصدار الجديد …');
(async () => {
  let res;
  try {
    res = await fetch(`${API_BASE}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        platform: 'win32-x64',
        version, filename: nupkg, sha1, size,
        notes: process.env.RELEASE_NOTES || '',
      }),
    });
  } catch (err) {
    die(`تعذّر الاتصال بالخادم: ${err.message}`);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    die(`رفض الخادم النشر (${res.status}): ${body.error || 'سبب غير معروف'}`);
  }

  // ---- 3. verify it end-to-end, as Squirrel would --------------------------
  // Publishing "successfully" and still not serving the update is the whole
  // failure mode this script exists to prevent, so it is checked, not assumed.
  console.log('\n🔍 التحقق كما يفعل البرنامج عند العميل …');
  const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';
  if (!CLIENT_KEY) {
    console.log('   ⚠️  MOBILESHOP_CLIENT_KEY غير مضبوط — تخطّي التحقق');
  } else {
    const older = '0.0.1';
    const check = await fetch(`${API_BASE}/update/win32-x64/${older}/RELEASES`, {
      headers: { 'X-Client-Key': CLIENT_KEY },
    });
    const text = await check.text();
    if (check.status !== 200 || !text.includes(nupkg)) {
      die(`الخادم لا يقدّم التحديث بعد (${check.status}). المحتوى:\n${text}`);
    }
    if (!text.startsWith(sha1.toUpperCase())) {
      die('البصمة التي يقدّمها الخادم لا تطابق الملف المرفوع.');
    }
    console.log(`   ✅ ${text.trim()}`);
  }

  console.log('\n✅ تم النشر. سيصل التحديث للعملاء خلال ٦ ساعات كحد أقصى.\n');
})();
