#!/usr/bin/env node
/**
 * Proves a published release is REALLY downloadable and REALLY intact.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `npm run release`
 * --------------------------------------------------
 * `publish-nsis.js` computes the hashes from the LOCAL file, sends them to the
 * Worker, and then checks the MANIFEST. Every one of those three values comes
 * from the same source: the file on this machine. Nothing in that chain ever
 * reads back what actually landed in R2.
 *
 * That is exactly the wrong place to stop, and a real release proved why: the
 * 115 MB package failed to upload three times — twice on spawn, once with
 *
 *     ▲ [WARNING] A fetch request failed, likely due to a connectivity issue
 *     ✘ [ERROR] fetch failed
 *
 * mid-transfer. A single unresumable PUT that dies part-way can leave a SHORT
 * object in the bucket. The manifest would still advertise the full size and
 * the correct hash, because both were measured here, not there.
 *
 * So this reads the bytes BACK, over the network, exactly as a customer's
 * machine would, and hashes them. That is the only check that can distinguish
 * "published" from "published and actually works".
 *
 * WHAT IS PROVEN
 *   [1] the feed refuses an anonymous caller (the key is really enforced)
 *   [2] latest.yml is served and parses (version, files, sha512, size)
 *   [3] the manifest matches the build sitting in dist-installer/ (when it has
 *       the SAME version — a code-only push leaves the last full installer in
 *       place, so this comparison is skipped when versions differ)
 *   [4] the Setup .exe downloads through the Worker
 *   [5] the bytes in R2 hash to the sha512 latest.yml advertises
 *   [6] the blockmap exists (differential updates depend on it)
 *   [7] the code manifest (fast lane) is served and its asar hash verifies
 *
 * [5] and [7] are the ones that cannot be faked by a confident publisher.
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

// die() THROWS instead of process.exit(1): calling process.exit while a fetch
// response body is still streaming trips Node's UV_HANDLE_CLOSING assertion on
// Windows and the script dies mid-report. The wrapper at the bottom converts
// the throw into a clean exit code.
function die(msg) {
  throw new Error(msg);
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
// Feed path uses 0.0.1 so the server answers with the latest release no matter
// what a customer would be running. The newest release is what we verify.
const FEED = `${API_BASE}/update-nsis/${PLATFORM}/0.0.1`;

console.log('');
console.log('══════════════════════════════════════════════');
console.log('  التحقق من الإصدار المنشور — كما سيراه العميل');
console.log('══════════════════════════════════════════════');
console.log(`  الإصدار : ${version}`);
console.log(`  الخادم  : ${API_BASE}`);
console.log('');

/** SHA-512 (base64, the format latest.yml uses) + size of a local file. */
async function hashLocalFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const h = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha512: h.digest('base64'), size };
}

/**
 * Streams a response body through SHA-512 (base64).
 *
 * A stall detector is used instead of one overall deadline: a 115 MB download
 * on a slow line is not a fault, but a connection that has stopped delivering
 * bytes for two minutes is.
 */
async function hashStream(res, expectedSize) {
  const h = crypto.createHash('sha512');
  let got = 0;
  let lastShown = 0;
  let lastChunk = Date.now();
  let stalled = false;
  for await (const chunk of res.body) {
    h.update(chunk);
    got += chunk.length;
    if (Date.now() - lastChunk > 120000) { stalled = true; break; }
    lastChunk = Date.now();
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
  return { sha512: h.digest('base64'), size: got, stalled };
}

/** Parses the subset of YAML electron-builder writes in latest.yml. */
function parseLatestYml(text) {
  const out = { files: [] };
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const m = /^(\s*)(- )?([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, , key, value] = m;
    if (indent.length === 0) {
      current = null;
      if (key !== 'files') out[key] = value;
    } else if (key === 'url' || key === 'path') {
      current = { path: value };
      out.files.push(current);
    } else if (current && (key === 'sha512' || key === 'size')) {
      current[key] = key === 'size' ? Number(value) : value;
    }
  }
  return out;
}

(async () => {
  try {
    // ---------------------------------------------------------------- 1
    console.log('[1] المفتاح مطلوب فعلاً');
    {
      let status = 0;
      try {
        const r = await fetch(`${FEED}/latest.yml`, { signal: AbortSignal.timeout(30000) });
        status = r.status;
        // Consume (and discard) the body so no stream is left dangling when
        // the script exits — an unread 401 body is what crashed the old
        // version with the UV_HANDLE_CLOSING assertion.
        await r.arrayBuffer();
      } catch (err) {
        die(`تعذّر الوصول إلى الخادم: ${err.message}`);
      }
      t('طلب بلا مفتاح يُرفض بـ 401', status === 401, `جاء ${status}`);
    }

    // ---------------------------------------------------------------- 2
    console.log('\n[2] بيان التحديث (latest.yml) يُقدَّم ويُقرأ');
    let manifest = null;
    let manifestText = '';
    {
      let res;
      try {
        res = await fetch(`${FEED}/latest.yml`, {
          headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(30000),
        });
        manifestText = await res.text();
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
      if (!t('الحالة 200', res.status === 200, `جاء ${res.status}`)) {
        die(`المحتوى:\n${manifestText}`);
      }

      manifest = parseLatestYml(manifestText);
      const ymlVersion = manifest.version || '';
      const exeFile = manifest.files.find(f => /\.exe$/.test(f.path || ''));
      const blockFile = manifest.files.find(f => /\.blockmap$/.test(f.path || ''));
      // electron-updater derives the blockmap URL from the exe path + ".blockmap";
      // builder does not always list it in `files`, so existence is verified
      // separately in [6] when absent here.
      manifest.exeFile = exeFile || null;
      manifest.blockFile = blockFile || null;

      t('البيان يذكر إصداراً صالحاً', /^\d+\.\d+\.\d+/.test(ymlVersion), `"${ymlVersion}"`);
      t('يوجد ملف .exe في البيان', !!exeFile, exeFile ? exeFile.path : 'لا يوجد');
      if (exeFile) {
        t('للـ exe بصمة sha512 وطول صالحان',
          /^[A-Za-z0-9+/]{86}==$/.test(exeFile.sha512 || '') && exeFile.size > 0,
          exeFile.sha512 ? `طول ${exeFile.size}` : 'بلا بصمة');
      }
      t('البيان غير مُخزَّن مؤقتاً', /no-cache/.test(res.headers.get('cache-control') || ''));
      t('نوع المحتوى YAML', /yaml/.test(res.headers.get('content-type') || ''));
      console.log(`      الإصدار : ${ymlVersion}`);
      console.log(`      الملف   : ${exeFile ? exeFile.path : '(غير معروف)'}`);
      console.log(`      الحجم   : ${exeFile ? (exeFile.size / 1048576).toFixed(1) : '?'} MB`);
    }

    const exeFile = manifest.exeFile;
    if (!exeFile) die('لا يوجد ملف .exe في latest.yml — لا يمكن متابعة التحقق.');

    // ---------------------------------------------------------------- 3
    console.log('\n[3] البيان يطابق النسخة المبنية على هذا الجهاز');
    {
      const ymlVersion = manifest.version;
      const installerDir = path.join(ROOT, 'dist-installer');
      // A code-only push (code:push) keeps the last FULL installer unchanged,
      // so a local installer for a different version is irrelevant — only
      // compare when the local build matches the version latest.yml names.
      const localPath = path.join(installerDir, exeFile.path);
      if (!fs.existsSync(localPath)) {
        console.log(`  ⏭️   لا يوجد مثبّت محلي مطابق لهذا الإصدار (${ymlVersion}) — تخطّي`);
      } else {
        const local = await hashLocalFile(localPath);
        t('الحجم مطابق', local.size === exeFile.size,
          `محلي ${local.size} / معلَن ${exeFile.size}`);
        t('البصمة مطابقة', local.sha512 === exeFile.sha512,
          local.sha512 === exeFile.sha512 ? '' : `محلي ${local.sha512.slice(0, 24)}… / معلَن ${(exeFile.sha512 || '').slice(0, 24)}…`);
      }
    }

    // ---------------------------------------------------------------- 4 & 5
    console.log('\n[4] المثبّت يُحمَّل فعلاً من R2 عبر الخادم');
    console.log('    (تحميل كامل — هذه هي الخطوة الوحيدة التي تكشف رفعاً مبتوراً)');
    {
      const url = `${FEED}/${encodeURIComponent(exeFile.path)}`;
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
            `   يجب أن يكون المفتاح داخل الدلو بالضبط:\n      nsis/${PLATFORM}/${exeFile.path}`);
      }
      if (!t('الحالة 200', res.status === 200, `جاء ${res.status}`)) {
        die('لا يمكن متابعة التحقق من المحتوى.');
      }

      const declared = Number(res.headers.get('content-length') || 0);
      t('طول المحتوى المعلَن يساوي حجم البيان', declared === exeFile.size,
        `ترويسة ${declared} / بيان ${exeFile.size}`);

      const got = await hashStream(res, exeFile.size);

      console.log('\n[5] البايتات الموجودة في R2 تطابق البصمة المعلَنة');
      t('عدد البايتات المستلَمة مطابق', got.size === exeFile.size,
        `مستلَم ${got.size} / معلَن ${exeFile.size}`);
      const hashOk = got.sha512 === exeFile.sha512;
      t('بصمة المحتوى المستلَم مطابقة', hashOk && !got.stalled,
        hashOk ? '' : `مستلَم ${got.sha512.slice(0, 24)}… / معلَن ${(exeFile.sha512 || '').slice(0, 24)}…`);

      if (!hashOk) {
        console.log('');
        console.log('   ⚠️  هذا بالضبط العطل الصامت: electron-updater يتحقق من البصمة قبل');
        console.log('       التثبيت، فسيحمّل كل عميل الحزمة كاملة ثم يرفضها، في كل');
        console.log('       مرة، إلى الأبد — بلا رسالة خطأ لدى أحد.');
        console.log('       الحل: أعد الرفع (npm run release:nsis) حتى يمرّ هذا الفحص.');
      }
    }

    // ---------------------------------------------------------------- 6
    console.log('\n[6] الـ blockmap (التحديث التفاضلي) متاح');
    {
      const blockPath = `${exeFile.path}.blockmap`;
      const res = await fetch(`${FEED}/${encodeURIComponent(blockPath)}`, {
        method: 'HEAD',
        headers: { 'X-Client-Key': CLIENT_KEY },
        signal: AbortSignal.timeout(30000),
      }).catch(() => null);
      t('blockmap يُستجاب له (HEAD 200)', !!res && res.status === 200,
        res ? `جاء ${res.status}` : 'تعذّر الاتصال');
      if (res && res.status === 200) {
        console.log(`      ${blockPath} (${res.headers.get('content-length')} B)`);
      }
    }

    // ---------------------------------------------------------------- 7
    console.log('\n[7] المسار السريع (code push) — مانيfest الـ asar');
    {
      let res, text = '';
      try {
        res = await fetch(`${API_BASE}/code-update/${PLATFORM}/0.0.1/manifest.json`, {
          headers: { 'X-Client-Key': CLIENT_KEY, 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(30000),
        });
        text = await res.text();
      } catch (err) {
        die(`تعذّر قراءة مانيfest الكود: ${err.message}`);
      }
      if (res.status === 401) {
        die('الخادم ردّ 401 على مانيfest الكود — المفتاح مرفوض.');
      }
      if (res.status === 204 || res.status === 404) {
        console.log('  ⏭️   لا يوجد تحديث سريع معلَن (طبيعي بعد إصدار كامل جديد)');
      } else {
        let cm;
        try { cm = JSON.parse(text); } catch { cm = null; }
        t('المانيfest صالح JSON', !!cm, text.slice(0, 120));
        if (cm) {
          const asarName = String(cm.asar || '').split('/').pop();
          const asarUrl = `${API_BASE}/code/${PLATFORM}/${asarName}`;
          t('يتضمن إصداراً وحجماً وبصمة',
            /^\d+\.\d+\.\d+/.test(cm.version) && cm.size > 0 && /^[a-f0-9]{64}$/.test(cm.sha256 || ''),
            `${cm.version} / ${cm.size} B`);
          t('مجرّد asar يُحمَّل ويتطابق sha256', await (async () => {
            try {
              const r = await fetch(asarUrl, {
                headers: { 'X-Client-Key': CLIENT_KEY },
                signal: AbortSignal.timeout(120000),
              });
              if (r.status !== 200) return false;
              const buf = Buffer.from(await r.arrayBuffer());
              const h = crypto.createHash('sha256').update(buf).digest('hex');
              return buf.length === cm.size && h === cm.sha256;
            } catch { return false; }
          })());
        }
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
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
})();
