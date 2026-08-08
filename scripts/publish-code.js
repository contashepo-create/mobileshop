#!/usr/bin/env node
/**
 * Publishes a CODE-ONLY (fast-lane) update to the developer's own Worker / R2.
 *
 * ONE COMMAND, EVERYTHING
 * -----------------------
 *   npm run code:push
 *
 * does, in this order:
 *   1. BUMPS the patch version in package.json (1.0.4 -> 1.0.5). The server and
 *      the client both refuse to deliver a push whose version equals the one
 *      already running (204 / the manifest never lists the same version), so a
 *      forgotten manual bump silently ships "nothing". Automating it removes
 *      the single most common failure of a code-only release.
 *   2. REBUILDS app.asar from the current source. A stale asar would "publish"
 *      a fix that is not actually in the archive.
 *   3. UPLOADS the ~2.5 MB asar to R2, records the natives baseline, and tells
 *      the Worker to start serving it.
 *
 * WHAT MAKES IT FAST
 * ------------------
 * A normal `npm run release:nsis` uploads the full 110 MB installer. But the
 * product's native bound is small and stable: `app.asar` (the JavaScript) is
 * ~2.5 MB and `app.asar.unpacked` (better-sqlite3's .node) sits NEXT to it,
 * never inside it. So a change that touches only the code is delivered as the
 * ~2.5 MB asar alone. The client verifies its sha256 against the manifest and
 * swaps its `app.asar` for it on restart.
 *
 * THE TWO HARD RULES
 * ------------------
 * 1. NEVER ship an asar whose NATIVE bundle differs from the baseline. Clients
 *    do not replace `app.asar.unpacked` (it only arrives with a full installer),
 *    so an asar built against new natives would crash every shop when
 *    better-sqlite3 loads. A fingerprint of `app.asar.unpacked` is recorded in
 *    R2 on every push; if today's build differs, this script REFUSES and tells
 *    you to do a full NSIS release.
 *
 * 2. Every push names a `min_app_version`. The client drops any code whose
 *    floor is above its own shell. The default floor is the last FULL build
 *    (read from `code/<platform>/shell.version`, written by publish-nsis.js),
 *    so a code push applies to every machine that already took a full release.
 *    An explicit MOBILESHOP_CODE_MIN_APP overrides the floor for the rare push
 *    whose code genuinely needs a newer shell.
 *
 * FLAGS (all optional)
 *   --no-bump        use the version already in package.json
 *   --minor          bump the minor instead of the patch (a feature push)
 *   --major         bump the major version
 *   --no-build   skip `electron-forge package` (the asar must be fresh)
 *   --allow-native-drift   ship despite a changed natives folder
 *   --min=1.0.4     override the mandatory min_app_version floor
 *
 * Reads MOBILESHOP_API_BASE, MOBILESHOP_ADMIN_KEY and MOBILESHOP_R2_BUCKET
 * from the environment or .env, exactly like publish-nsis.js.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

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
const PLATFORM = 'win32-x64';

const args = process.argv.slice(2);
const AUTO_BUMP = !args.includes('--no-bump');
const NO_BUILD = args.includes('--no-build');
const BUMP_KIND = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';
const ALLOW_DRIFT = args.includes('--allow-native-drift');
const FROM_MIN = args.find((a) => a.startsWith('--min='));
const MIN_APP_VERSION = (FROM_MIN && FROM_MIN.slice('--min='.length).trim())
  || (process.env.MOBILESHOP_CODE_MIN_APP || '').trim();

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!API_BASE) die('MOBILESHOP_API_BASE غير مضبوط — ضعه في ملف .env');
if (!ADMIN_KEY) die('MOBILESHOP_ADMIN_KEY غير مضبوط — ضعه في ملف .env');

const pkgFile = path.join(ROOT, 'package.json');
const pkgRaw = fs.readFileSync(pkgFile, 'utf-8');
const pkgJson = JSON.parse(pkgRaw);

const bump = (v) => {
  const [ma, mi, pa] = String(v).split('.').map(Number);
  if (BUMP_KIND === 'major') return `${ma + 1}.0.0`;
  if (BUMP_KIND === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
};

// ---------------------------------------------------------------- 1. version
let version = pkgJson.version;
if (!/^\d+\.\d+\.\d+/.test(version)) die(`رقم إصدار غير صالح في package.json: ${version}`);

if (AUTO_BUMP) {
  const bumped = bump(version);
  console.log(`🔢  رفع الإصدار: ${version} -> ${bumped} (${BUMP_KIND})`);
  version = bumped;
  pkgJson.version = bumped;
  fs.writeFileSync(pkgFile, JSON.stringify(pkgJson, null, 2) + '\n');
}

// ---------------------------------------------------------------- 2. build
const pkgDir = path.join(ROOT, 'out', 'MobileShopERP-win32-x64');
const asarFile = path.join(pkgDir, 'resources', 'app.asar');
const asarUnpacked = path.join(pkgDir, 'resources', 'app.asar.unpacked');

if (!NO_BUILD) {
  console.log('\n🏗️   إعادة بناء app.asar من المصدر الحالي (electron-builder package)…');
  console.log('     (قد تأخذ بضع عشرات من الثواني — التحميل للعميل هو الذي أصبح سريعاً، لا البناء)');
  const env = { ...process.env, NODE_ENV: 'development', NODE_INSTALLER: 'npm' };
  execSync('npx electron-forge package', { stdio: 'inherit', cwd: ROOT, env, maxBuffer: 1024 * 1024 * 1024 });
} else if (!fs.existsSync(asarFile)) {
  die(`لا يوجد app.asar (اخترت --no-build):\n   ${asarFile}\n\nارفع الحاجز or شغّل:  npm run package`);
}

if (!fs.existsSync(asarFile)) {
  die(`البناء لم يُنتج app.asar:\n   ${asarFile}`);
}
if (!fs.existsSync(asarUnpacked)) {
  die(`البناء غير مكتمل — مفقود مجلد الوحدات الأصلية:\n   ${asarUnpacked}`);
}

const asarBuf = fs.readFileSync(asarFile);
const sha256 = crypto.createHash('sha256').update(asarBuf).digest('hex');
const size = asarBuf.length;

// ---------------------------------------------------------------- native gate
/** Fingerprint of the EXTERNAL natives that a client never replaces. */
function nativeFingerprint() {
  const entries = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else entries.push([r, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
    }
  };
  walk(asarUnpacked, '');
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256')
    .update(entries.map(([r, h]) => `${r}\u0000${h}\n`).join(''))
    .digest('hex');
}

const fp = nativeFingerprint();
const NATIVE_MARKER = `code/${PLATFORM}/natives.sha256`;

console.log('\n══════════════════════════════════════════════');
console.log('  نشر تحديث سريع (كود فقط)');
console.log('══════════════════════════════════════════════');
console.log(`  الإصدار     : ${version}`);
console.log(`  الملف       : app.asar (${(size / 1048576).toFixed(2)} MB)`);
console.log(`  sha256      : ${sha256.slice(0, 16)}…`);
console.log(`  natives-fp  : ${fp.slice(0, 16)}…`);
console.log('');

/** Runs wrangler without a shell (same rationale as publish-nsis.js). */
function runWrangler(args, cwd, stdinFile) {
  const { execFileSync } = require('node:child_process');
  const stdio = stdinFile
    ? [fs.openSync(stdinFile, 'r'), 'inherit', 'inherit']
    : 'inherit';
  const candidates = [
    path.join(ROOT, 'server', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ];
  const local = candidates.find(c => fs.existsSync(c));
  if (local) {
    return execFileSync(process.execPath, [local, ...args], { stdio, cwd, maxBuffer: 1024 * 1024 * 1024 });
  }
  const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return execFileSync(`npx wrangler ${quoted.join(' ')}`, { stdio, cwd, shell: true, maxBuffer: 1024 * 1024 * 1024 });
}

function putObject(key, file, contentType) {
  const args = [
    'r2', 'object', 'put', `${BUCKET}/${key}`,
    '--content-type', contentType,
    '--remote',
  ];
  const dir = path.join(ROOT, 'server');
  try {
    return runWrangler([...args, '--pipe'], dir, file);
  } catch (pipeErr) {
    console.log('      (التدفّق تعذّر، تجربة الرفع المباشر …)');
    return runWrangler([...args, '--file', file], dir);
  }
}

// The code floor. `publish-nsis.js` records the version of the last full shell;
// an explicit floor (--min= / env) overrides it for the rare push whose code
// genuinely can only run on a newer shell.
let shellFloor = '';
try {
  const out = runWrangler(
    ['r2', 'object', 'get', `${BUCKET}/code/${PLATFORM}/shell.version`, '--file', '-', '--remote'],
    path.join(ROOT, 'server'),
  );
  shellFloor = String(out ?? '').trim();
} catch {
  shellFloor = '';
}
const min = MIN_APP_VERSION || shellFloor || '0.0.1';

let baseline = null;
try {
  const out = runWrangler(
    ['r2', 'object', 'get', `${BUCKET}/${NATIVE_MARKER}`, '--file', '-', '--remote'],
    path.join(ROOT, 'server'),
  );
  baseline = String(out ?? '').trim();
} catch {
  baseline = null;   // never published before — this push establishes the baseline
}

if (baseline && baseline !== fp && !ALLOW_DRIFT) {
  die(
    'رفض النشر: تغيّرت الوحدات الأصلية عن آخر إصدار منشور.\n'
    + `التوقيع المعتمد : ${baseline.slice(0, 16)}…\n`
    + `المطلوب الآن    : ${fp.slice(0, 16)}…\n\n`
    + 'العميل لا يستبدل app.asar.unpacked عبر القناة السريعة، فإرسال كود جديد '
    + 'مبني على natives مختلفة سيُعطّل كل المحلات عند تحميل better-sqlite3.\n'
    + 'انشر إصداراً كاملاً بدلاً من ذلك:  npm run release:nsis\n'
    + 'إن كنت تعرف ما تفعل:  --allow-native-drift',
  );
}
console.log(`  min shell   : ${min}`
  + (MIN_APP_VERSION ? ' (بضبط يدوي)' : shellFloor ? ' (من آخر إصدار كامل)' : ' (افتراضي 0.0.1)'));
console.log(' ✓   الوحدات الأصلية متطابقة مع القاعدة'
  + (baseline ? ' المنشورة' : ' — لم تُنشر من قبل، ستُسجَّل هذه القاعدة'));

// ---------------------------------------------------------------- upload asar
const asarKey = `code/${PLATFORM}/${version}.asar`;
console.log('\n⬆️   رفع app.asar إلى R2 …');
try {
  putObject(asarKey, asarFile, 'application/octet-stream');
  console.log(`   ✓ ${asarKey}`);
} catch (err) {
  die(`تعذّر رفع ${asarKey} إلى R2:\n   ${String((err && err.message) || err).split('\n')[0]}`);
}

// Record the baseline BEFORE announcing: advertise only a push whose object
// actually made it to R2.
try {
  const markerTmp = path.join(ROOT, '.natives.sha256.tmp');
  fs.writeFileSync(markerTmp, fp);
  putObject(NATIVE_MARKER, markerTmp, 'text/plain');
  fs.unlinkSync(markerTmp);
  console.log(`   ✓ ${NATIVE_MARKER} (baseline updated)`);
} catch (err) {
  die(`تعذّر تحديث قاعدة الوحدات الأصلية على R2:\n   ${String((err && err.message) || err).split('\n')[0]}`);
}

// ---------------------------------------------------------------- announce
console.log('\n📢   إبلاغ الخادم بالتحديث السريع …');
(async () => {
  let res;
  try {
    res = await fetch(`${API_BASE}/release-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        platform: PLATFORM,
        version,
        sha256,
        size,
        min_app_version: min,
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
  console.log('   ✅ سُجِّل على الخادم.');
  console.log('\n🔍 تحقّق سريع — من جهاز أقدم النسخة يجب أن يُجيب مانيfest JSON:');
  console.log(`   ${API_BASE}/code-update/${PLATFORM}/0.0.1/manifest.json`);
})();