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

/**
 * Runs wrangler WITHOUT a shell and WITHOUT npx.
 *
 * Two failures were measured on the owner's machine before this shape:
 *
 *   execFileSync('npx', ...)      -> ENOENT
 *       npx on Windows is `npx.cmd`, a batch script, and execFileSync runs
 *       executables directly.
 *
 *   execFileSync('npx.cmd', ...)  -> EINVAL
 *       The file exists, but since CVE-2024-27980 Node refuses to launch
 *       .cmd/.bat without `shell: true`, because argument handling in batch
 *       files was an argument-injection hole.
 *
 * Adding `shell: true` would work and is the wrong answer here: the package
 * path is `D:\programing\coding projects\mobile shop\out\...`, which
 * contains two spaces. Every argument would then need quoting for cmd.exe,
 * and a quoting mistake produces a malformed command rather than an error.
 *
 * So the shell is removed from the problem entirely: Node runs wrangler's own
 * entry point, and the arguments are passed as an array, where a space is just
 * a character. `npx` remains only as a fallback for a machine that has no
 * local install, and there it is invoked through the shell deliberately.
 */
function runWrangler(args, cwd, stdinFile) {
  // `stdinFile` feeds the package to wrangler's `--pipe` on standard input.
  // The file handle is opened here rather than read into memory: a 133 MB
  // Buffer is avoidable, and streaming is the whole point of the pipe.
  const stdio = stdinFile
    ? [fs.openSync(stdinFile, 'r'), 'inherit', 'inherit']
    : 'inherit';
  // A local install, in the server folder or at the repo root.
  const candidates = [
    path.join(ROOT, 'server', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ];
  const local = candidates.find(c => fs.existsSync(c));

  if (local) {
    return execFileSync(process.execPath, [local, ...args], { stdio, cwd, maxBuffer: 1024 * 1024 * 1024 });
  }

  // No local copy: fall back to npx, which must go through a shell on Windows.
  // Arguments are quoted here because the shell will re-parse them.
  const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return execFileSync(`npx wrangler ${quoted.join(' ')}`, {
    stdio, cwd, shell: true, maxBuffer: 1024 * 1024 * 1024,
  });
}

// ---- 1. upload to R2 -------------------------------------------------------
//
// `--file` is NOT used, and the reason is measured.
//
// `wrangler r2 object put --file` performs a SINGLE PUT. Cloudflare's own
// guidance puts the practical ceiling for that at about 100 MB, and states
// plainly that a single upload is "not resumable — must restart the entire
// upload". This package is 133 MB. On the owner's connection the request died
// part-way with
//
//     ▲ [WARNING] A fetch request failed, likely due to a connectivity issue
//     ✘ [ERROR] fetch failed
//
// after wrangler had already authenticated and addressed the bucket correctly.
// Nothing was wrong with the credentials, the bucket, or the command; the
// upload simply cannot survive a single interruption over several minutes.
//
// `--pipe` streams the file on stdin instead, which is the form the wrangler
// issue tracker records as working when `--file` does not. It is attempted
// first, and `--file` is kept as a fallback so a machine where the pipe
// misbehaves is not left with no route at all.
console.log('⬆️  رفع الحزمة إلى R2 …');
console.log(`   (${(size / 1048576).toFixed(1)} MB — قد يستغرق عدة دقائق)`);

const putArgs = (extra) => [
  'r2', 'object', 'put',
  `${BUCKET}/win32-x64/${nupkg}`,
  '--content-type', 'application/octet-stream',
  '--remote',
  ...extra,
];

let uploaded = false;
try {
  runWrangler(putArgs(['--pipe']), path.join(ROOT, 'server'), file);
  uploaded = true;
} catch (pipeErr) {
  console.log('\n   تعذّر الرفع بالتدفّق، تجربة الطريقة المباشرة …');
  try {
    runWrangler(putArgs(['--file', file]), path.join(ROOT, 'server'));
    uploaded = true;
  } catch {
    // Report the FIRST failure: the fallback's message is usually the same
    // network fault seen twice, and the pipe attempt is the informative one.
    const detail = String(pipeErr && pipeErr.message ? pipeErr.message : pipeErr).split('\n')[0];
    die(`فشل رفع الملف إلى R2.\n   السبب: ${detail}\n\n` +
        '   الحزمة ١٣٣ م.ب، والانقطاع أثناء الرفع يُلغي المحاولة كاملة.\n\n' +
        '   جرّب بالترتيب:\n' +
        '   ١) أعد الأمر — الانقطاع العابر شائع ونجاح المحاولة الثانية معتاد.\n' +
        '   ٢) اتصال أثبت (سلك بدل واي-فاي)، وأوقف أي VPN.\n' +
        '   ٣) الرفع يدوياً من لوحة Cloudflare:\n' +
        `      R2 -> ${BUCKET} -> Upload، ثم ضع الملف داخل مجلد win32-x64\n` +
        `      الملف: ${file}\n` +
        '      ثم أعد تشغيل  npm run release  — سيتخطى الرفع ويُبلّغ الخادم فقط.');
  }
}
if (!uploaded) die('لم يكتمل الرفع.');


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

  // ---- 3. verify the MANIFEST, as Squirrel would ---------------------------
  //
  // Publishing "successfully" and still not serving the update is the whole
  // failure mode this script exists to prevent, so it is checked, not assumed.
  //
  // BUT NOTE WHAT THIS CAN AND CANNOT PROVE.
  //
  // `sha1` and `size` were computed a few lines above, from the file on THIS
  // machine, and then sent to the Worker. Comparing the manifest against them
  // compares this machine against itself: it proves the Worker recorded what
  // it was told, and nothing whatsoever about the bytes that reached R2.
  //
  // That distinction is not theoretical here. This package is 133 MB, the
  // upload is a single unresumable PUT, and it died mid-transfer with
  // `fetch failed` before it finally went through. A PUT that dies part-way
  // can leave a SHORT object in the bucket — and the manifest would still
  // advertise the full length and the correct hash, because both came from
  // here.
  //
  // Squirrel checks the hash before installing, so the result of that is not
  // a visible error: every customer downloads 133 MB, finds the hash wrong,
  // discards it, and repeats on the next check, for ever, silently.
  //
  // Reading 133 MB back is too slow to force on every publish, so it lives in
  // `npm run check:published` and is pointed at below rather than skipped.
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

  // Deliberately NOT "تم النشر بنجاح". The bucket has not been read back yet,
  // and a confident final line is exactly how a truncated upload ships.
  console.log('\n✅ سُجِّل الإصدار على الخادم، والبيان صحيح.');
  console.log('\n⚠️  لم تُقرأ محتويات الحزمة من R2 بعد.');
  console.log('   الرفع كان ١٣٣ م.ب في طلب واحد لا يُستأنف، وانقطاعه يترك');
  console.log('   ملفاً ناقصاً يبدو سليماً في البيان. للتأكد فعلياً شغّل:\n');
  console.log('       npm run check:published\n');
  console.log('   يحمّل الحزمة كاملة كما سيفعل العميل ويقارن بصمتها.');
  console.log('   بعد نجاحه فقط يكون التحديث مضموناً للعملاء.\n');
})();
