#!/usr/bin/env node
/**
 * Proves a published release is REALLY downloadable and REALLY intact.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `npm run release`
 * --------------------------------------------------
 * `publish-release.js` computes the SHA-1 from the LOCAL file, sends it to the
 * Worker, and then checks the MANIFEST. Every one of those three values comes
 * from the same source: the file on this machine. Nothing in that chain ever
 * reads back what actually landed in R2.
 *
 * That is exactly the wrong place to stop, and this release proves why. The
 * 133 MB package failed to upload three times — twice on spawn, once with
 *
 *     ▲ [WARNING] A fetch request failed, likely due to a connectivity issue
 *     ✘ [ERROR] fetch failed
 *
 * mid-transfer. A single unresumable PUT that dies part-way can leave a SHORT
 * object in the bucket. The manifest would still advertise the full size and
 * the correct hash, because both were measured here, not there.
 *
 * Squirrel verifies the hash before it installs anything. So a truncated
 * upload does not fail loudly — every customer downloads 133 MB, computes a
 * hash that does not match, discards the lot, and tries again on the next
 * check. Forever. The shop simply never updates and nobody is told why.
 *
 * So this reads the bytes BACK, over the network, exactly as a customer's
 * machine would, and hashes them. That is the only check that can distinguish
 * "published" from "published and actually works".
 *
 * WHAT IS PROVEN
 *   [1] the feed refuses an anonymous caller (the key is really enforced)
 *   [2] the manifest is byte-exact NuGet format
 *   [3] the manifest matches the build sitting in out/ (when it is present)
 *   [4] the package downloads through the Worker
 *   [5] the bytes in R2 hash to the SHA-1 the manifest advertises
 *
 * [5] is the one that cannot be faked by a confident publisher.
 *
 * No secret is ever printed: keys are used, never echoed.
 *
 * Usage:  npm run check:published
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/** Reads .env without a dependency. Same loader the other scripts use. */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  // `.` never matches \r in JavaScript — it is a line terminator — so a CRLF
  // file yields a clean value here without any extra trimming.
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const API_BASE = (process.env.MOBILESHOP_API_BASE || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.MOBILESHOP_CLIENT_KEY || '';

let pass = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅  ${name}`); }
  else { failures.push(name + (detail ? ` -> ${detail}` : '')); console.log(`  ❌  ${name}${detail ? '  -> ' + detail : ''}`); }
  return ok;
}
function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!API_BASE) die('MOBILESHOP_API_BASE غير مضبوط في .env');
if (!CLIENT_KEY) {
  die('MOBILESHOP_CLIENT_KEY غير مضبوط في .env.\n' +
      '   هذا هو المفتاح المدموج داخل البرنامج عند البناء، وبدونه لا يمكن\n' +
      '   التحقق من أن العميل سيستطيع التحميل فعلاً.');
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkgJson.version;
const PLATFORM = 'win32-x64';

console.log('');
console.log('══════════════════════════════════════════════');
console.log('  التحقق من الإصدار المنشور — كما سيراه العميل');
console.log('══════════════════════════════════════════════');
console.log(`  الإصدار : ${version}`);
console.log(`  الخادم  : ${API_BASE}`);
console.log('');

/** SHA-1 + size of the local build, streamed so 133 MB never sits in memory. */
async function hashLocalBuild() {
  const outDir = path.join(ROOT, 'out', 'make', 'squirrel.windows', 'x64');
  if (!fs.existsSync(outDir)) return null;
  const name = fs.readdirSync(outDir)
    .find(f => f.endsWith('-full.nupkg') && f.includes(version));
  if (!name) return null;

  const full = path.join(outDir, name);
  const h = crypto.createHash('sha1');
  let size = 0;
  for await (const chunk of fs.createReadStream(full)) {
    h.update(chunk);
    size += chunk.length;
  }
  return { name, sha1: h.digest('hex'), size, full };
}

/**
 * Streams a response body through SHA-1.
 *
 * A stall detector is used instead of one overall deadline: a 133 MB download
 * on a slow line is not a fault, but a connection that has stopped delivering
 * bytes for two minutes is.
 */
async function hashStream(res, expectedSize) {
  const h = crypto.createHash('sha1');
  let got = 0;
  let lastShown = 0;
  for await (const chunk of res.body) {
    h.update(chunk);
    got += chunk.length;
    const pct = expectedSize ? Math.floor((got / expectedSize) * 100) : 0;
    if (pct >= lastShown + 5 || !expectedSize) {
      lastShown = pct;
      process.stdout.write(
        `\r      … ${(got / 1048576).toFixed(1)} MB` +
        (expectedSize ? ` من ${(expectedSize / 1048576).toFixed(1)} MB (${pct}%)` : ''),
      );
    }
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return { sha1: h.digest('hex'), size: got };
}

(async () => {
  // ---------------------------------------------------------------- 1
  console.log('[1] المفتاح مطلوب فعلاً');
  {
    let status = 0;
    try {
      const r = await fetch(`${API_BASE}/update/${PLATFORM}/0.0.1/RELEASES`,
        { signal: AbortSignal.timeout(30000) });
      status = r.status;
    } catch (err) {
      die(`تعذّر الوصول إلى الخادم: ${err.message}`);
    }
    t('طلب بلا مفتاح يُرفض بـ 401', status === 401, `جاء ${status}`);
  }

  // ---------------------------------------------------------------- 2
  console.log('\n[2] البيان (RELEASES) بالصيغة التي يفهمها Squirrel');
  let manifest = null;
  {
    let res, text = '';
    try {
      res = await fetch(`${API_BASE}/update/${PLATFORM}/0.0.1/RELEASES`, {
        headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(30000),
      });
      text = await res.text();
    } catch (err) {
      die(`تعذّر قراءة البيان: ${err.message}`);
    }

    if (res.status === 401) {
      die('الخادم ردّ 401 على المفتاح الموجود في .env.\n\n' +
          '   معنى ذلك أن MOBILESHOP_CLIENT_KEY في ملفك لا يطابق السرّ\n' +
          '   المرفوع إلى Cloudflare (CLIENT_KEY).\n\n' +
          '   وهذا خطير: نفس المفتاح مدموج داخل ملف .exe الذي بنيته، فلو\n' +
          '   كان قديماً فلن يستطيع أي عميل تحميل أي تحديث ولا إرسال نبضة.\n' +
          '   صحّح القيمة في .env ثم أعد البناء والنشر.');
    }
    if (res.status === 204) {
      die('الخادم يقول «لا يوجد تحديث» لنسخة 0.0.1.\n\n' +
          '   أي أن النشر لم يُسجَّل: الرفع تمّ لكن الخادم لم يُبلَّغ،\n' +
          '   أو سُجِّل غير منشور. أعد تشغيل  npm run release');
    }
    if (!t('الحالة 200', res.status === 200, `جاء ${res.status}`)) {
      die(`المحتوى:\n${text}`);
    }

    const m = /^([A-Fa-f0-9]{40})\s+(\S+\.nupkg)\s+(\d+)\s*$/m.exec(text.trim());
    if (!t('الصيغة «<بصمة> <ملف>.nupkg <حجم>»', !!m, JSON.stringify(text.slice(0, 120)))) {
      die('البيان غير صالح — Squirrel سيتجاهله بصمت.');
    }
    manifest = { sha1: m[1], file: m[2], size: Number(m[3]) };

    t('البصمة بأحرف كبيرة كما يكتبها Squirrel', manifest.sha1 === manifest.sha1.toUpperCase());
    t('نوع المحتوى نصّي', /text\/plain/.test(res.headers.get('content-type') || ''));
    t('البيان غير مُخزَّن مؤقتاً', /no-cache/.test(res.headers.get('cache-control') || ''));
    t('الملف المعلَن يخصّ هذا الإصدار', manifest.file.includes(version), manifest.file);
    console.log(`      الملف  : ${manifest.file}`);
    console.log(`      الحجم  : ${(manifest.size / 1048576).toFixed(1)} MB`);
    console.log(`      البصمة : ${manifest.sha1.toLowerCase()}`);
  }

  // ---------------------------------------------------------------- 3
  console.log('\n[3] البيان يطابق النسخة المبنية على هذا الجهاز');
  const local = await hashLocalBuild();
  if (!local) {
    console.log('  ⏭️   لا توجد نسخة مبنية في out/ — تخطّي هذه المقارنة');
  } else {
    t('اسم الملف مطابق', local.name === manifest.file, `محلي ${local.name}`);
    t('الحجم مطابق', local.size === manifest.size,
      `محلي ${local.size} / معلَن ${manifest.size}`);
    t('البصمة مطابقة', local.sha1.toLowerCase() === manifest.sha1.toLowerCase(),
      `محلي ${local.sha1}`);
  }

  // ---------------------------------------------------------------- 4 & 5
  console.log('\n[4] الحزمة تُحمَّل فعلاً من R2 عبر الخادم');
  console.log('    (تحميل كامل — هذه هي الخطوة الوحيدة التي تكشف رفعاً مبتوراً)');
  {
    const url = `${API_BASE}/update/${PLATFORM}/${version}/${manifest.file}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-Client-Key': CLIENT_KEY },
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    } catch (err) {
      die(`تعذّر بدء التحميل: ${err.message}`);
    }

    if (res.status === 404) {
      die('الخادم يعرف بالإصدار لكن الملف غير موجود في R2 (404).\n\n' +
          '   أي أن التسجيل تمّ والرفع لم يتم، أو رُفع باسم/مجلد مختلف.\n' +
          `   يجب أن يكون المفتاح داخل الدلو بالضبط:\n      ${PLATFORM}/${manifest.file}`);
    }
    if (!t('الحالة 200', res.status === 200, `جاء ${res.status}`)) {
      die('لا يمكن متابعة التحقق من المحتوى.');
    }

    const declared = Number(res.headers.get('content-length') || 0);
    t('طول المحتوى المعلَن يساوي حجم البيان', declared === manifest.size,
      `ترويسة ${declared} / بيان ${manifest.size}`);

    const got = await hashStream(res, manifest.size);

    console.log('\n[5] البايتات الموجودة في R2 تطابق البصمة المعلَنة');
    t('عدد البايتات المستلَمة مطابق', got.size === manifest.size,
      `مستلَم ${got.size} / معلَن ${manifest.size}`);
    const hashOk = got.sha1.toLowerCase() === manifest.sha1.toLowerCase();
    t('بصمة المحتوى المستلَم مطابقة', hashOk,
      hashOk ? '' : `مستلَم ${got.sha1} / معلَن ${manifest.sha1.toLowerCase()}`);

    if (!hashOk) {
      console.log('');
      console.log('   ⚠️  هذا بالضبط العطل الصامت: Squirrel يتحقق من البصمة قبل');
      console.log('       التثبيت، فسيحمّل كل عميل الحزمة كاملة ثم يرفضها، في كل');
      console.log('       مرة، إلى الأبد — بلا رسالة خطأ لدى أحد.');
      console.log('       الحل: أعد الرفع (npm run release) حتى يمرّ هذا الفحص.');
    }
  }

  console.log(`\n${'═'.repeat(46)}`);
  if (failures.length) {
    console.error(`❌ فشل ${failures.length} من ${failures.length + pass} فحصاً:\n`);
    for (const f of failures) console.error('   ✗ ' + f);
    console.error('');
    process.exit(1);
  }
  console.log(`✅ نجحت كل الفحوص (${pass}) — الإصدار منشور وسليم وقابل للتحميل.`);
  console.log('   سيصل التحديث للعملاء خلال ٦ ساعات كحد أقصى.\n');
})();
