#!/usr/bin/env node
/**
 * BUILD GATE — does the application actually compile?
 *
 * Why this suite exists
 * ---------------------
 * The app shipped a state in which `npm start` died instantly with
 *
 *     Transform failed with 1 error:
 *     src/main/database/migrations/index.ts:395:10:
 *     ERROR: Expected ")" but found "sale_details"
 *
 * ...while all 43 verify suites were green. That combination is the worst
 * possible outcome: a test run that says "everything passes" about a program
 * that cannot start.
 *
 * Two independent holes let it through, and this file closes both.
 *
 *   1. `npm run verify` never compiled anything. Every suite either read the
 *      source as TEXT (regex/structural assertions) or imported one small
 *      module at a time through Node's type stripper. Nothing ever asked the
 *      question the user asks by typing `npm start`: "does the whole program
 *      build?"
 *
 *   2. The harness reads the schema by regex-extracting every db.exec(`...`)
 *      block. A stray backtick inside one of those templates ENDS the template
 *      as far as a real JavaScript parser is concerned, but the lazy regex
 *      /db\.exec\(`([\s\S]*?)`\)/ happily skipped over it and captured the
 *      whole intended block. So the tests built a CORRECT database from a
 *      source file the compiler could not read. The tests and the app
 *      disagreed about what the code even said.
 *
 * The bug itself was a comment inside a template literal that quoted two
 * identifiers in backticks. Prose punctuation, invisible in review, fatal to
 * the build.
 *
 * What is asserted here
 * ---------------------
 *   [1] Every .ts/.tsx file under src/ parses.
 *   [2] The three real entry points BUNDLE the way electron-forge bundles
 *       them: main, preload, renderer. A file can parse alone and still break
 *       the build through a bad import, so parsing is not sufficient.
 *   [3] No db.exec template literal contains a raw backtick — the specific
 *       trap that caused this outage, checked directly so the failure message
 *       names the real problem instead of a parser's guess.
 *   [4] The regex the harness uses to read the schema sees EXACTLY the same
 *       blocks a real parser sees. If those two ever diverge again, the tests
 *       are lying about the schema and this fails loudly.
 *
 * esbuild is what Vite (and therefore electron-forge) uses to transform this
 * project, so a pass here is the same transform the real build performs.
 *
 * Run with:  node scripts/verify_build.mjs
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

console.log('='.repeat(72));
console.log('BUILD GATE — the program must compile, not just pass assertions');
console.log('='.repeat(72));

// ------------------------------------------------------------------ esbuild
/**
 * Locate an esbuild binary. It is the transformer Vite already uses, so it is
 * normally present via node_modules. We deliberately DO NOT invent a fallback
 * that silently skips: a build gate that quietly does nothing is exactly the
 * failure mode this file was written to prevent.
 */
// esbuild is not a direct dependency and does not need to be: `vite` depends
// on it (see package-lock.json -> node_modules/esbuild), so a normal
// `npm install` always provides both the binary and the JS API.
// MOBILESHOP_ESBUILD is an escape hatch for sandboxes where node_modules is
// not installed; it is never needed on a developer machine.
function findEsbuild() {
  const candidates = [
    join(ROOT, 'node_modules/.bin/esbuild'),
    join(ROOT, 'node_modules/esbuild/bin/esbuild'),
  ];
  if (process.env.MOBILESHOP_ESBUILD) candidates.push(process.env.MOBILESHOP_ESBUILD);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** The JS API, needed for the bundle checks (the CLI cannot take a plugin). */
function findEsbuildApi() {
  const candidates = [join(ROOT, 'node_modules/esbuild/lib/main.js')];
  if (process.env.MOBILESHOP_ESBUILD_API) candidates.push(process.env.MOBILESHOP_ESBUILD_API);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const ESBUILD = findEsbuild();
if (!ESBUILD) {
  // A missing toolchain must be LOUD. Skipping here would recreate the hole.
  console.log('\n  FAIL  esbuild is not installed — the build gate cannot run.');
  console.log('        Run `npm install` so this suite can compile the app.');
  console.log('\nRESULT: 0 passed, 1 failed');
  process.exit(1);
}
console.log(`\nusing esbuild: ${relative(ROOT, ESBUILD) || ESBUILD}\n`);

function esbuild(args) {
  try {
    execFileSync(ESBUILD, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, err: '' };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    return { ok: false, err: out };
  }
}

/** First meaningful line of an esbuild diagnostic, for a readable failure. */
const firstError = s =>
  (s.split('\n').find(l => l.includes('ERROR')) || s.split('\n')[0] || '').trim().slice(0, 160);

// ------------------------------------------------------------------ sources
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src')).sort();

// ---------------------------------------------------------------- 1
console.log(`[1] Every source file under src/ parses (${files.length} files)`);
{
  const broken = [];
  for (const f of files) {
    const r = esbuild([relative(ROOT, f), '--outfile=/dev/null', '--log-limit=1']);
    if (!r.ok) broken.push(`${relative(ROOT, f)}: ${firstError(r.err)}`);
  }
  t('every .ts/.tsx file compiles',
    broken.length === 0,
    broken.slice(0, 4).join(' | '));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] The real entry points bundle, the way electron-forge builds them');
{
  // Externalising with `--packages=external` was tried first and proved to be
  // a TRAP: it also externalises RELATIVE paths, so an import of a file that
  // does not exist still "bundles". A deliberately broken local import was not
  // caught. Only BARE specifiers (real npm packages) may be externalised, so
  // that every one of OUR OWN files must genuinely resolve.
  const apiPath = findEsbuildApi();
  if (!apiPath) {
    t('esbuild JS API available for bundle checks', false, 'esbuild/lib/main.js not found');
  } else {
    const { build } = await import(pathToFileURL(apiPath).href);

    /** Externalise npm packages only; our own files must resolve for real. */
    const externalBarePackages = {
      name: 'external-bare-packages',
      setup(b) {
        b.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return null;
          const p = args.path;
          const isOurs =
            p.startsWith('./') || p.startsWith('../') || p.startsWith('/') ||
            p.startsWith('@/') || p.startsWith('~');
          return isOurs ? null : { path: p, external: true };
        });
      },
    };

    async function bundles(entry, opts) {
      const tmp = mkdtempSync(join(tmpdir(), 'buildgate-'));
      try {
        await build({
          entryPoints: [entry],
          bundle: true,
          write: true,
          outfile: join(tmp, 'out.js'),
          loader: { '.css': 'css' },
          plugins: [externalBarePackages],
          logLevel: 'silent',
          ...opts,
        });
        return { ok: true, err: '' };
      } catch (e) {
        const msg = (e.errors || [])
          .map(x => `${x.text}${x.location ? ` @ ${x.location.file}:${x.location.line}` : ''}`)
          .join(' | ');
        return { ok: false, err: msg || String(e.message || e).slice(0, 160) };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    const main = await bundles('src/main/index.ts', { platform: 'node', format: 'esm' });
    t('the MAIN process bundles (src/main/index.ts)', main.ok, main.err.slice(0, 200));

    const preload = await bundles('src/preload/preload.ts', { platform: 'node', format: 'cjs' });
    t('the PRELOAD bundles (src/preload/preload.ts)', preload.ok, preload.err.slice(0, 200));

    const renderer = await bundles('src/renderer/src/main.tsx', { platform: 'browser', format: 'esm' });
    t('the RENDERER bundles (src/renderer/src/main.tsx)', renderer.ok, renderer.err.slice(0, 200));
  }
}

// ---------------------------------------------------------------- 3
console.log('\n[3] No db.exec template literal contains a raw backtick');
{
  // This is the exact trap that broke the build. A backtick inside the SQL
  // template closes the template early: the compiler then reads SQL as
  // JavaScript and dies on the first bare word. Scanning for it directly means
  // the failure message says what is wrong instead of "Expected )".
  const MIG = 'src/main/database/migrations/index.ts';
  const src = readFileSync(join(ROOT, MIG), 'utf-8');

  /** Walk templates the way a parser does: a raw ` ends the literal. */
  function parseTemplates(text) {
    const found = [];
    let i = 0;
    while (true) {
      const at = text.indexOf('db.exec(`', i);
      if (at < 0) break;
      let p = at + 'db.exec(`'.length;
      let buf = '';
      while (p < text.length) {
        const c = text[p];
        if (c === '\\') { buf += text[p] + text[p + 1]; p += 2; continue; }
        if (c === '`') break;
        buf += c; p++;
      }
      // Line number of the opening backtick, for a message a human can act on.
      const line = text.slice(0, at).split('\n').length;
      found.push({ line, content: buf, closed: text.slice(p, p + 2) === '`)' });
      i = p + 1;
    }
    return found;
  }

  const templates = parseTemplates(src);
  const unclosed = templates.filter(x => !x.closed);
  t('every db.exec(`...`) template closes with `)',
    unclosed.length === 0,
    unclosed.length
      ? `line ${unclosed[0].line} ends early — a stray backtick inside the SQL`
      : '');

  // Same rule stated as a content check across ALL source files, so a future
  // comment in any SQL template is caught wherever it is written.
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    for (const x of parseTemplates(text)) {
      if (!x.closed) offenders.push(`${relative(ROOT, f)}:${x.line}`);
    }
  }
  t('no SQL template anywhere in src/ is broken by a backtick',
    offenders.length === 0,
    offenders.slice(0, 4).join(', '));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The test harness reads the SAME schema the compiler does');
{
  // The harness extracts schema with a lazy regex. If a real parser and that
  // regex ever disagree, the suites are testing a database the app will never
  // build. That divergence is what hid the outage, so it is now a test.
  const MIG = 'src/main/database/migrations/index.ts';
  const src = readFileSync(join(ROOT, MIG), 'utf-8');

  const regexBlocks = [...src.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)].map(m => m[1]);

  const parserBlocks = [];
  {
    let i = 0;
    while (true) {
      const at = src.indexOf('db.exec(`', i);
      if (at < 0) break;
      let p = at + 'db.exec(`'.length;
      let buf = '';
      while (p < src.length) {
        const c = src[p];
        if (c === '\\') { buf += src[p] + src[p + 1]; p += 2; continue; }
        if (c === '`') break;
        buf += c; p++;
      }
      parserBlocks.push(buf);
      i = p + 1;
    }
  }

  t('the harness regex finds the same NUMBER of schema blocks as a parser',
    regexBlocks.length === parserBlocks.length,
    `regex ${regexBlocks.length} vs parser ${parserBlocks.length}`);

  const mismatch = regexBlocks.findIndex((b, idx) => b !== parserBlocks[idx]);
  t('every schema block is byte-identical between the two readers',
    mismatch === -1,
    mismatch === -1 ? '' : `block ${mismatch + 1} differs — tests would build a phantom schema`);

  t('the schema actually contains tables (the reader is not silently empty)',
    parserBlocks.join('\n').includes('CREATE TABLE IF NOT EXISTS sale_details'),
    'sale_details not found in the parsed schema');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
