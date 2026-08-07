#!/usr/bin/env node
/**
 * Publishes an NSIS build to the developer's own Cloudflare Worker / R2.
 *
 * VS the Squirrel `publish-release.js`, this uploads the actual artifacts
 * electron-updater needs:
 *
 *   MobileShopERP-Setup-<version>.exe                the installer
 *   MobileShopERP-Setup-<version>.exe.blockmap       differential-update map
 *   latest.yml                                       the electron-updater manifest
 *
 * Uploading the `.blockmap` is what makes updates SMALL (5-10 MB): on the next
 * check the client downloads the new manifest, compares it against the version
 * it has installed, and fetches only the 256 KB blocks that changed. Without
 * the blockmap every customer downloads the full ~130 MB installer every time.
 *
 * USAGE
 *   npm run installer      # builds the NSIS installer + block-map + latest.yml
 *   npm run release:nsis    # uploads them and tells the Worker
 *
 * Reads MOBILESHOP_API_BASE and MOBILESHOP_ADMIN_KEY from the environment or
 * .env. Refuses to run unless a build already exists and both keys are set.
 */
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

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!API_BASE) die('MOBILESHOP_API_BASE غير مضبوط — ضعه في ملف .env');
if (!ADMIN_KEY) die('MOBILESHOP_ADMIN_KEY غير مضبوط — ضعه في ملف .env');

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkgJson.version;
if (!/^\d+\.\d+\.\d+/.test(version)) die(`رقم إصدار غير صالح في package.json: ${version}`);

const outDir = path.join(ROOT, 'dist-installer');
if (!fs.existsSync(outDir)) {
  die(`لم يتم العثور على مجلد البناء:\n   ${outDir}\n\nشغّل أولاً:  npm run installer`);
}

const exeName = `MobileShopERP-Setup-${version}.exe`;
const blockName = `${exeName}.blockmap`;
const manifestName = 'latest.yml';

const exe = path.join(outDir, exeName);
const blockmap = path.join(outDir, blockName);
const manifest = path.join(outDir, manifestName);

for (const [label, file] of [
  ['الملف التنفيذي', exe],
  ['الخريطة التفريقية', blockmap],
  ['بيان الإصدارات', manifest],
]) {
  if (!fs.existsSync(file)) {
    die(`مفقود: ${label}\n   ${file}\n\nقبل النشر شغّل:  npm run installer`);
  }
}

const exeBuf = fs.readFileSync(exe);
const sha1 = crypto.createHash('sha1').update(exeBuf).digest('hex');
const sha512 = crypto.createHash('sha512').update(exeBuf).digest('hex');
const size = exeBuf.length;

console.log('');
console.log('══════════════════════════════════════════════');
console.log('  نشر إصدار NSIS جديد');
console.log('══════════════════════════════════════════════');
console.log(`  الإصدار : ${version}`);
console.log(`  الملف   : ${exeName}`);
console.log(`  الحجم   : ${(size / 1048576).toFixed(1)} MB`);
console.log(`  sha512  : ${sha512.slice(0, 16)}…`);
console.log(`  الخادم  : ${API_BASE}`);
console.log('');

/**
 * Runs wrangler WITHOUT a shell (an npx.cmd cannot be launched directly, and a
 * quoted shell command breaks paths containing spaces — same rationale as
 * publish-release.js).
 *
 * `stdinFile` feeds a file to wrangler's `--pipe` on standard input. The
 * handle is opened rather than read into memory: streaming is the whole point.
 */
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
    // Stream on stdin first: a single non-resumable PUT can die part-way on a
    // multi-minute ~110 MB upload (the same failure reporter for the Squirrel
    // package). `--pipe` streams the file instead. Fall back to `--file`.
    return runWrangler([...args, '--pipe'], dir, file);
  } catch (pipeErr) {
    console.log('      (التدفّق تعذّر، تجربة الرفع المباشر …)');
    return runWrangler([...args, '--file', file], dir);
  }
}

console.log('⬆️   رفع الملفات إلى R2 …');
console.log(`   (${(size / 1048576).toFixed(1)} MB — قد يستغرق عدة دقائق)`);
const manifests = [
  [`nsis/${PLATFORM}/${exeName}`, exe, 'application/octet-stream'],
  [`nsis/${PLATFORM}/${blockName}`, blockmap, 'application/octet-stream'],
  [`nsis/${PLATFORM}/${manifestName}`, manifest, 'text/yaml'],
];
for (const [key, file, ct] of manifests) {
  try {
    putObject(key, file, ct);
    console.log(`   ✓ ${key}`);
  } catch (err) {
    die(`تعشّر رفع ${key} إلى R2:\n   ${String((err && err.message) || err).split('\n')[0]}`);
  }
}

console.log('\n📢   إبلاغ الخادم بالإصدار الجديد …');
(async () => {
  let res;
  try {
    res = await fetch(`${API_BASE}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        platform: PLATFORM,
        version,
        filename: exeName,
        sha1,
        sha512,
        size,
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
  console.log('\n🔍 تحقّق سريع — يجب أن يجيب هذا الرابط بـ 204 (لا تحديث):');
  console.log(`   ${API_BASE}/update-nsis/${PLATFORM}/0.0.1/latest.yml`);
  console.log('   ومع `X-Client-Key` الصحيح يخدم latest.yml للمستخدم المحال إليه.');
})();