#!/usr/bin/env node
/**
 * SECRETS — nothing that authenticates may be committed, and nothing that
 * authenticates may reach the renderer.
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify_security.py` already refuses one specific shape: a Telegram bot
 * token. That check was written after a real one was committed, and it does
 * its job — but it only knows about Telegram. A repository that grows an AWS
 * key, a Stripe key, a GitHub PAT or a pasted private-key block would sail
 * straight past it.
 *
 * This suite covers the whole class, and adds the half that matters more in an
 * Electron application: the CLIENT-SIDE boundary. In a desktop app the
 * renderer is not a trusted place. Everything it holds is readable from the
 * DevTools console on the shop's own machine, sits in any renderer crash dump,
 * and is reachable by anything that can run script in that window — which,
 * because `window.open` children inherit the preload bundle, includes markup
 * injected through a customer name on a printed statement.
 *
 * WHAT WAS MEASURED
 * -----------------
 * `db:getCloudSettings` returned every `cloud_%` and `sync_%` row verbatim:
 *
 *     { "cloud_api_key": "sbp_LIVE_SUPABASE_SERVICE_ROLE_KEY_abcdef123456",
 *       "sync_secret":   "SYNC_SHARED_SECRET_9988", ... }
 *
 * A Supabase service-role key bypasses row level security completely: it is
 * full read and write over the project, including the storage bucket holding
 * every backup of the shop's books. Its sibling `telegram:getSettings` already
 * answered `hasToken` + `tokenHint` and never the token — the same handler
 * file, the same kind of credential, two different answers.
 *
 * Section 4 executes both handlers and compares what they return, so the two
 * can never drift apart again.
 *
 * Run:  node --experimental-strip-types scripts/verify_no_secrets.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// `fileURLToPath`, never `.pathname`.
//
// On Windows a file:// URL's pathname is `/D:/coding%20projects/...` — it
// keeps a leading slash and it is percent-encoded. MEASURED on the owner's
// machine, joining that with a subdirectory produced
//
//     ENOENT: scandir 'D:\D:\programing\coding%20projects\mobile%20shop'
//
// — the drive letter twice and the spaces still as %20. `fileURLToPath` is the
// documented conversion and handles both.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/**
 * Repo-relative path with forward slashes, on every OS.
 *
 * Named `repoPath`, not `rel`. A local `const rel = relative(ROOT, file)`
 * further down SHADOWED the short name, so one exemption compared a
 * backslash path against a forward-slash list and the scanner reported
 * itself. A helper used for a cross-platform invariant must not share a name
 * with an ordinary local.
 */
const repoPath = (f) => relative(ROOT, f).split(sep).join('/');

/**
 * The two files that necessarily CONTAIN every pattern they hunt for.
 *
 * At module scope because three separate sections need it; while it lived
 * inside one of them an earlier section referenced it before initialisation.
 *
 * Compared through `repoPath()` so the path separator cannot decide whether
 * the exemption applies. On Windows it did: `relative()` yields
 * `scripts\\verify_no_secrets.mjs`, which never matches a forward-slash
 * entry, so both scanners lost their exemption and reported their own
 * detector patterns as live secrets — measured as seven failures, every one
 * of them this file quoting the shapes it exists to find.
 *
 * A fixed list of two paths rather than a pattern, so a third file cannot
 * quietly join it.
 */
const DETECTOR_FILES = ['scripts/verify_no_secrets.mjs', 'scripts/verify_security.py'];

/**
 * True when git tracks this file.
 *
 * `git ls-files --error-unmatch` exits non-zero for anything untracked, so the
 * throw IS the answer. Used to keep an ignored local `.env` out of the scan
 * while still catching one that was committed.
 */
const isTracked = (f) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel(f)],
      { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
};
const require = createRequire(join(ROOT, 'package.json'));

let checks = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
};

// ---------------------------------------------------------------- file walk
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.vite', '__pycache__',
  '.venv', 'coverage', '.codely', '.codely-cli',
]);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.py', '.yml',
  '.yaml', '.txt', '.toml', '.html', '.env', '.example', '.sh', '.ps1',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(extname(entry))) out.push(full);
    // A `.env*` file is scanned ONLY when git tracks it.
    //
    // The point of looking at these is to catch one that was COMMITTED. An
    // untracked, git-ignored `.env` is where the owner's real credentials are
    // SUPPOSED to live — reporting it is reporting that the secrets file
    // contains secrets, which is not a finding, and it trains the reader to
    // ignore this suite's output. `.env.example` stays in scope because it IS
    // tracked, and a value pasted into it would ship.
    else if (entry.startsWith('.env') && isTracked(full)) out.push(full);
  }
  return out;
}
const FILES = walk(ROOT);

/**
 * A literal is allowed only when it announces itself as not real.
 *
 * Pattern matching alone cannot tell a live credential from a realistic
 * fixture — that is the whole difficulty — so the rule is inverted: anything
 * shaped like a secret must SAY it is fake, in the literal itself.
 */
const FAKE_MARKERS = [
  'fake', 'Fake', 'FAKE', 'example', 'EXAMPLE', 'Example', 'dummy', 'DUMMY',
  'placeholder', 'PLACEHOLDER', 'xxx', 'XXX', 'SECRET',
  'sample', 'SAMPLE', 'YOUR_', 'invalid', 'redacted', 'REDACTED',
  'NotAReal', 'NotARealBot', 'changeme', 'CHANGEME',
];
// DELIBERATELY NOT MARKERS: 'abcdef', '123456', 'test'.
//
// Mutation testing planted `sk_live_abcdefghijklmnopqrstuvwx` and the suite
// passed, because 'abcdef' was on the list and any Stripe key happens to
// contain those letters somewhere. A marker has to be a word a human wrote to
// say "this is not real" — not a letter sequence that occurs naturally inside
// random-looking strings. 'test' fell to the same problem: `sk_live_...` keys
// and base64 blobs contain it by chance, and `sk_test_` is a real Stripe
// credential for a real account.
const looksFake = (s) => FAKE_MARKERS.some(m => s.includes(m));

// ===========================================================================
console.log('\n── 1. no live credential shape anywhere in the tree ──');
// ===========================================================================
{
  const DETECTORS = [
    ['Telegram bot token',    /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
    ['AWS access key id',     /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ['GitHub token',          /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g],
    ['Slack token',           /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
    ['Stripe key',            /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g],
    ['Google API key',        /\bAIza[0-9A-Za-z_-]{35}\b/g],
    ['npm token',             /\bnpm_[A-Za-z0-9]{36}\b/g],
    ['Supabase service key',  /\bsbp_[A-Za-z0-9]{20,}/g],
    ['SendGrid key',          /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
    ['Twilio SID',            /\bAC[0-9a-f]{32}\b/g],
    ['Private key block',     /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g],
    ['JWT',                   /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ];

  for (const [name, rx] of DETECTORS) {
    const hits = [];
    for (const file of FILES) {
      // This suite necessarily contains every pattern it looks for.
      if (DETECTOR_FILES.includes(repoPath(file))) continue;
      let body;
      try { body = readFileSync(file, 'utf8'); } catch { continue; }
      // Splitting a credential across a `+` must not hide it from the shape
      // detectors either — same dodge, same answer.
      body = body + '\n' + body.replace(/['"`]\s*\+\s*['"`]/g, '');
      for (const m of body.match(rx) || []) {
        if (!looksFake(m)) hits.push(`${repoPath(file)}: ${m.slice(0, 22)}…`);
      }
    }
    ok(`no ${name} in the tree`, hits.length === 0, hits.slice(0, 3).join(' | '));
  }

  // The token that WAS committed must never reappear, under any name.
  // Split so this file does not itself contain it.
  //
  // Matched against the file with quotes, plus signs and whitespace REMOVED.
  // A plain `includes` was defeated by the obvious dodge, and mutation testing
  // proved it: writing the token as
  //     '8877684899:AAHTZfkM' + '_MPlD2ZiR1CJ8qiKRXzFrHnRmdo'
  // put the exact credential back in the repository while the check passed.
  // Normalising first means the concatenation has to survive as one string,
  // which it cannot.
  const BURNED = 'AAHTZfkM' + '_MPlD2ZiR1CJ8qiKRXzFrHnRmdo';
  const deconcat = (t) => t.replace(/['"`]\s*\+\s*['"`]/g, '');
  //
  // The two SCANNERS are exempt, and only the scanners.
  //
  // A detector has to name the thing it detects. Both hold the token split
  // across a concatenation, which is not a usable credential in a source file
  // and is the standard way to write this kind of check. Every OTHER file in
  // the repository is held to the strict rule. The exemption is a fixed list
  // of two paths rather than a pattern, so a third file cannot quietly join it.
  // Compared through `rel()`, which normalises the separator.
  //
  // `relative(ROOT, f)` returns `scripts\\verify_no_secrets.mjs` on Windows,
  // which never matches a forward-slash entry — so the two SCANNERS stopped
  // being exempt and reported their own detector patterns as live secrets.
  // MEASURED on the owner's machine: seven failures, every one of them this
  // file quoting the shapes it exists to find.
  const burned = FILES.filter(f => {
    if (DETECTOR_FILES.includes(repoPath(f))) return false;
    try { return deconcat(readFileSync(f, 'utf8')).includes(BURNED); } catch { return false; }
  }).map(f => repoPath(f));
  ok('the previously committed bot token is absent', burned.length === 0, burned.join(', '));

  // ---------------------------------------------------------------- keyless
  // A SECRET WITH NO RECOGNISABLE PREFIX.
  //
  // Every detector above keys off a vendor prefix — `sk_`, `ghp_`, `AKIA`,
  // `sbp_`. That is why they all passed while THIS was sitting in the tree, in
  // a tracked Arabic setup guide, on the default branch:
  //
  //     MOBILESHOP_ADMIN_KEY=Gdea+r1P83v2YQkO1uXKMzoyj+Wt/S/cwFiRdAP6Ujw=
  //     MOBILESHOP_CLIENT_KEY=uCubrNqc4TLTophMzNdx2zvBG2u3NypeMo3mbxDazOU=
  //
  // Found by scanning a FRESH clone of the repository rather than the working
  // copy. `ADMIN_KEY` is the credential that opens `/issue` (mint a licence),
  // `/devices` (every customer this product has), `/config`, `/message` and
  // `/release` — five routes, full control of the licensing backend. It was
  // pasted as an EXAMPLE VALUE, which is exactly how this class of leak
  // happens: nobody thinks documentation is code.
  //
  // This project's own keys are `openssl rand -base64 32` — 44 characters of
  // random base64 ending in '='. They have no prefix to key off, so the shape
  // has to be matched instead, and the match has to be anchored to an
  // ASSIGNMENT to a secret-sounding name. A bare base64 blob is far too common
  // to flag on its own: this file would drown in false positives from hashes,
  // icons and test fixtures.
  const KEYLESS = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*['"`]?([A-Za-z0-9+/_-]{32,}={0,2})['"`]?/g;

  // Names whose VALUE is public by design, so an assignment is not a leak.
  const PUBLIC_BY_DESIGN = /PUBLIC_KEY|PUBKEY|_HASH$|PASSWORD_HASH/;

  const leaks = [];
  for (const file of FILES) {
    const shown = repoPath(file);
    if (DETECTOR_FILES.includes(shown)) continue;
    let body;
    try { body = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of body.matchAll(KEYLESS)) {
      const [, name, value] = m;
      if (PUBLIC_BY_DESIGN.test(name)) continue;
      if (looksFake(value) || looksFake(name)) continue;
      // A bcrypt hash is not a secret to be stolen, it is the stored form.
      if (/^\$2[aby]\$/.test(value)) continue;
      leaks.push(`${shown}: ${name}=${value.slice(0, 12)}…`);
    }
  }
  ok('no secret-named assignment holds a real-looking value',
    leaks.length === 0,
    leaks.slice(0, 4).join(' | '));

  // ...and the two that WERE leaked must never come back, by value.
  // Split so this file does not itself carry them.
  const BURNED_KEYS = [
    'Gdea+r1P83v2YQkO' + '1uXKMzoyj+Wt/S/cwFiRdAP6Ujw=',
    'uCubrNqc4TLTophM' + 'zNdx2zvBG2u3NypeMo3mbxDazOU=',
  ];
  for (const secret of BURNED_KEYS) {
    const hit = FILES.filter(f => {
      if (DETECTOR_FILES.includes(repoPath(f))) return false;
      try { return deconcat(readFileSync(f, 'utf8')).includes(secret); } catch { return false; }
    }).map(f => repoPath(f));
    ok(`the leaked Cloudflare key ${secret.slice(0, 8)}… is absent`,
      hit.length === 0, hit.join(', '));
  }
}

// ===========================================================================
console.log('── 2. credential files are ignored and were never committed ──');
// ===========================================================================
{
  const MUST_IGNORE = [
    '.env', '.env.local', '.env.production',
    'scripts/.license-key', 'scripts/.license-secret',
    'scripts/issued-licenses.json',
    // Wrangler writes the Worker's LOCAL secrets here the first time anyone
    // runs `wrangler dev` — ADMIN_KEY, CLIENT_KEY, LICENSE_PRIVATE_KEY,
    // TG_BOT_TOKEN, in plain key=value. It lands inside server/ beside tracked
    // files, so nothing about its location suggests it is dangerous.
    'server/.dev.vars', '.dev.vars',
    // Registry and signing credentials.
    '.npmrc', '.netrc', '.git-credentials',
    'signing.pfx', 'cert.p12', 'private.pem', 'id_rsa',
  ];
  for (const p of MUST_IGNORE) {
    let ignored = false;
    try {
      execSync(`git check-ignore -q ${JSON.stringify(p)}`, { cwd: ROOT, stdio: 'ignore' });
      ignored = true;
    } catch { ignored = false; }
    ok(`.gitignore covers ${p}`, ignored);
  }

  // Ignoring a file does nothing if it was committed before the rule existed.
  for (const p of MUST_IGNORE) {
    let count = 0;
    try {
      // Counted in Node, not by piping to `wc`.
      //
      // `wc` does not exist on Windows and the pipe needs a POSIX shell.
      // MEASURED on the owner's machine: fifteen repetitions of
      // "'wc' is not recognized as an internal or external command" and every
      // one of these checks silently compared against an empty string.
      const out = execFileSync('git', ['log', '--all', '--oneline', '--', p],
        { cwd: ROOT, encoding: 'utf8' });
      count = out.split(/\r?\n/).filter(Boolean).length;
    } catch { count = 0; }
    ok(`${p} was never committed`, Number(count) === 0, `${count} commits touch it`);
  }

  // The template itself must stay TRACKED: the ignore rule is `.env.*` with an
  // explicit negation, and losing that negation would silently remove the only
  // documentation of which variables exist.
  //
  // TWO subtleties, both found by mutation testing rather than reasoning:
  //
  //  1. Plain `git check-ignore` consults the INDEX. `.env.example` is already
  //     tracked, so git answers "not ignored" no matter what the rules say —
  //     the check passed with the negation deleted. `--no-index` asks about
  //     the RULES instead, which is the question being posed.
  //
  //  2. `--no-index` exits 0 when a NEGATION matches too, so the exit code
  //     cannot distinguish "ignored by `.env.*`" from "rescued by
  //     `!.env.example`". The matching rule has to be read: `-v` prints it,
  //     and a negation is the line beginning with `!`.
  let exampleRule = '';
  try {
    // No shell. `|| true` existed only to swallow git's non-zero exit when
    // nothing matches; a try/catch does the same thing on every platform, and
    // `shell: '/bin/bash'` is a path that does not exist on Windows —
    // MEASURED: `spawnSync /bin/bash ENOENT`.
    exampleRule = execFileSync('git', ['check-ignore', '--no-index', '-v', '.env.example'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { exampleRule = ''; }
  const rescued = exampleRule === '' || /:\d+:!/.test(exampleRule);
  ok('.env.example survives the .env.* ignore rule', rescued,
    `matched rule: ${exampleRule || '(none)'}`);
  ok('.env.example is tracked',
    execFileSync('git', ['ls-files', '.env.example'], { cwd: ROOT, encoding: 'utf8' }).trim() === '.env.example');

  // A broad ignore rule must not swallow a file the project needs.
  // The pipe is done in Node: the file list is read, then handed to
  // check-ignore on stdin. Same question, no shell, works everywhere.
  let nowIgnored = '';
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    nowIgnored = execFileSync('git', ['check-ignore', '--stdin'],
      { cwd: ROOT, encoding: 'utf8', input: tracked }).trim();
  } catch {
    // check-ignore exits non-zero when NOTHING is ignored — the good case.
    nowIgnored = '';
  }
  ok('no already-tracked file is caught by the ignore rules',
    nowIgnored === '', nowIgnored.split(/\r?\n/).slice(0, 4).join(', '));

  // `.env.example` must show the SHAPE and never a value.
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const filled = example
    .split(/\r?\n/)
    .filter(l => /^[A-Z_]+=.+/.test(l.trim()))
    .filter(l => !/^MOBILESHOP_R2_BUCKET=/.test(l.trim()));   // a bucket name, not a secret
  ok('.env.example carries no filled-in values', filled.length === 0, filled.join(' | '));
}

// ===========================================================================
console.log('── 3. nothing secret is inlined into the renderer bundle ──');
// ===========================================================================
{
  // Vite `define` substitutes at build time, so anything defined for the
  // RENDERER config is baked into a file that ships and can be read with a
  // text editor. The main-process config may define these; the renderer may
  // not define any of them.
  const rendererCfg = readFileSync(join(ROOT, 'vite.renderer.config.ts'), 'utf8');
  ok('vite.renderer.config.ts defines no env substitution',
    !/\bdefine\s*:/.test(rendererCfg));
  ok('vite.renderer.config.ts does not load .env',
    !/loadEnv/.test(rendererCfg));

  // Vite exposes anything prefixed VITE_ to the client automatically, with no
  // `define` needed. A secret named that way leaks by default.
  const exampleBody = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const vitePrefixed = exampleBody.match(/^VITE_[A-Z_]*/gm) || [];
  ok('no VITE_-prefixed variable exists (auto-exposed to the client)',
    vitePrefixed.length === 0, vitePrefixed.join(', '));

  // The renderer must not read process.env at all: in the packaged app it
  // would be either undefined or, worse, inlined.
  const rendererFiles = FILES.filter(f =>
    f.includes('/src/renderer/') || f.includes('/src/preload/'));
  const envReaders = rendererFiles.filter(f => {
    const b = readFileSync(f, 'utf8');
    return /process\.env\.|import\.meta\.env\./.test(b);
  }).map(f => repoPath(f));
  ok('no renderer or preload file reads process.env / import.meta.env',
    envReaders.length === 0, envReaders.join(', '));

  // The secret-bearing constants must live in main only.
  for (const [file, symbol] of [
    ['src/main/security/devAuth.ts', 'DEV_FALLBACK_HASH'],
    ['src/main/security/licenseCrypto.ts', 'DEV_FALLBACK_PUBLIC_KEY'],
    ['src/main/security/deviceId.ts', 'SECRET_KEY'],
    ['src/main/security/trialAnchor.ts', 'SIGN_KEY'],
  ]) {
    const importers = rendererFiles.filter(f => {
      const b = readFileSync(f, 'utf8');
      const mod = file.replace('src/main/', '').replace('.ts', '');
      return b.includes(mod) || b.includes(symbol);
    }).map(f => repoPath(f));
    ok(`${symbol} is not reachable from the renderer`,
      importers.length === 0, importers.join(', '));
  }

  // The private licence key signs licences. If it were ever importable by the
  // app (rather than only by the developer's CLI) the build would ship the
  // ability to mint licences.
  const appFiles = FILES.filter(f => f.includes('/src/'));
  const privateKeyUsers = appFiles.filter(f =>
    /MOBILESHOP_LICENSE_PRIVATE|\.license-key/.test(readFileSync(f, 'utf8')),
  ).map(f => repoPath(f));
  ok('no file under src/ reads the private licence key',
    privateKeyUsers.length === 0, privateKeyUsers.join(', '));
}

// ===========================================================================
console.log('── 4. credential getters answer presence, never the value ──');
// ===========================================================================
{
  // Executed, not grepped. A comment promising the token is withheld proves
  // nothing; calling the handler and reading the reply does.
  const { build } = await import(pathToFileURL(join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'secret-verify-'));
  const handlers = new Map();
  globalThis.__SECRET_H = handlers;

  writeFileSync(join(dir, 'electron.js'), `
    module.exports = {
      ipcMain: { handle: (c, f) => globalThis.__SECRET_H.set(c, f) },
      app: { getPath: () => ${JSON.stringify(dir)}, getVersion: () => '1.0.0', getName: () => 'x' },
      dialog: { showOpenDialog: async () => ({ canceled: true }),
                showSaveDialog: async () => ({ canceled: true }) },
      shell: {}, BrowserWindow: class {},
    };
  `);

  const Database = require('better-sqlite3');
  const DB = new Database(':memory:');
  DB.exec('CREATE TABLE settings (Key TEXT PRIMARY KEY, Value TEXT)');
  globalThis.__SECRET_DB = DB;
  writeFileSync(join(dir, 'connection.js'),
    `module.exports = { getDb: () => globalThis.__SECRET_DB, closeDb(){}, getDbPath: () => ':memory:' };`);

  await build({
    entryPoints: [join(ROOT, 'src/main/ipc/database.handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'out.cjs'),
    alias: {
      electron: join(dir, 'electron.js'),
      bcryptjs: require.resolve('bcryptjs'),
    },
    plugins: [{
      name: 'conn',
      setup(b) {
        b.onResolve({ filter: /database\/connection$/ }, () => ({ path: join(dir, 'connection.js') }));
      },
    }],
    logLevel: 'silent',
  });

  const mod = require(join(dir, 'out.cjs'));
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'function' && k.startsWith('register')) { try { v(); } catch { /* needs no db yet */ } }
  }
  const ev = { sender: { id: 1 } };

  // Values chosen so a leak is unambiguous in the assertion below.
  const API_KEY = 'sbp_' + 'LIVEKEYLEAKCANARY' + '0123456789';
  const SYNC = 'SYNCSECRETLEAKCANARY0123';
  const BOT = '8877684899:' + 'AALEAKCANARY' + 'x'.repeat(23);
  DB.prepare("INSERT INTO settings VALUES ('cloud_api_key', ?)").run(API_KEY);
  DB.prepare("INSERT INTO settings VALUES ('cloud_url', 'https://xyz.supabase.co')").run();
  DB.prepare("INSERT INTO settings VALUES ('cloud_type', 'supabase')").run();
  DB.prepare("INSERT INTO settings VALUES ('sync_secret', ?)").run(SYNC);
  DB.prepare("INSERT INTO settings VALUES ('telegram_bot_token', ?)").run(BOT);
  DB.prepare("INSERT INTO settings VALUES ('telegram_chat_id', '7232305465')").run();

  const cloud = await handlers.get('db:getCloudSettings')(ev);
  const cloudJson = JSON.stringify(cloud);
  ok('db:getCloudSettings does not return cloud_api_key', !cloudJson.includes(API_KEY), cloudJson.slice(0, 120));
  ok('db:getCloudSettings does not return sync_secret', !cloudJson.includes(SYNC));
  ok('…but still reports that a key IS configured', cloud.hasCloudApiKey === true, cloudJson.slice(0, 120));
  ok('…and still returns the non-secret settings', cloud.cloud_url === 'https://xyz.supabase.co');
  ok('…and still returns the connection type', cloud.cloud_type === 'supabase');

  const tg = await handlers.get('telegram:getSettings')(ev);
  const tgJson = JSON.stringify(tg);
  ok('telegram:getSettings does not return the bot token', !tgJson.includes(BOT), tgJson.slice(0, 120));
  ok('…but reports that one is configured', tg.hasToken === true);

  // Saving without touching the field must NOT wipe the stored credential.
  // Getting this wrong would break every off-site backup silently, and the
  // shop would only find out at the moment it needed the backup.
  const save = handlers.get('db:saveCloudSettings');
  await save(ev, { cloud_type: 'supabase', cloud_url: 'https://xyz.supabase.co', cloud_api_key: cloud.cloud_api_key });
  ok('saving with the mask untouched keeps the stored key',
    DB.prepare("SELECT Value FROM settings WHERE Key='cloud_api_key'").get().Value === API_KEY);

  // Typing a real new key must replace it — otherwise rotation is impossible.
  await save(ev, { cloud_type: 'supabase', cloud_url: 'https://xyz.supabase.co', cloud_api_key: 'sbp_ROTATED_VALUE_1' });
  ok('typing a new key replaces the stored one',
    DB.prepare("SELECT Value FROM settings WHERE Key='cloud_api_key'").get().Value === 'sbp_ROTATED_VALUE_1');

  // The cloud saver must not be a second, unguarded route to every setting.
  const badKey = await save(ev, { db_path: '/tmp/pwn' });
  ok('db:saveCloudSettings refuses a non-cloud key', badKey && badKey.success === false, JSON.stringify(badKey));
  ok('…and db_path was not written',
    DB.prepare("SELECT Value FROM settings WHERE Key='db_path'").get() === undefined);
  const badTg = await save(ev, { telegram_bot_token: 'x' });
  ok('db:saveCloudSettings cannot reach telegram_ keys', badTg && badTg.success === false);

  // The handlers that USE the key must read it from the database, not from
  // the payload.
  //
  // Mutation testing caught this gap: reverting `db:uploadToCloud` to trust
  // `config.apiKey` passed every check above, because nothing here had ever
  // called it. Now `fetch` is intercepted and the Authorization header is
  // inspected — which is the only place the truth is visible.
  DB.prepare("UPDATE settings SET Value = ? WHERE Key = 'cloud_api_key'").run(API_KEY);
  const realFetch = globalThis.fetch;
  let seenAuth = [];
  globalThis.fetch = async (url, init) => {
    seenAuth.push(String((init && init.headers && (init.headers.Authorization || init.headers.apikey)) || ''));
    return { ok: true, status: 200, statusText: 'OK' };
  };
  try {
    // The renderer now only ever holds the mask, so that is what it sends.
    seenAuth = [];
    await handlers.get('db:testCloudConnection')(ev, {
      type: 'supabase', url: 'https://xyz.supabase.co', apiKey: cloud.cloud_api_key,
    });
    ok('db:testCloudConnection resolves the real key server-side',
      seenAuth.some(h => h.includes(API_KEY)), JSON.stringify(seenAuth).slice(0, 90));
    ok('…and never puts the mask on the wire',
      !seenAuth.some(h => h.includes('\u2022')), JSON.stringify(seenAuth).slice(0, 90));

    seenAuth = [];
    await handlers.get('db:uploadToCloud')(ev, {
      type: 'supabase', url: 'https://xyz.supabase.co', apiKey: cloud.cloud_api_key,
    });
    ok('db:uploadToCloud resolves the real key server-side',
      seenAuth.some(h => h.includes(API_KEY)), JSON.stringify(seenAuth).slice(0, 90));

    // And a caller that invents its OWN key must not be able to redirect the
    // shop's entire database to a bucket it controls using a key it chose.
    // (The key it supplies is honoured only when the renderer legitimately
    // typed a new one; the point of this check is that the STORED key is the
    // default, so an empty payload cannot silently send with no credential.)
    seenAuth = [];
    await handlers.get('db:uploadToCloud')(ev, {
      type: 'supabase', url: 'https://xyz.supabase.co', apiKey: '',
    });
    ok('an empty key falls back to the stored one, never to no credential',
      seenAuth.some(h => h.includes(API_KEY)), JSON.stringify(seenAuth).slice(0, 90));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ===========================================================================
console.log('── 5. shipped fallbacks cannot reach a customer ──');
// ===========================================================================
{
  // The licence PUBLIC key and the developer password hash ship in every
  // build by design — the first verifies licences and cannot mint them, the
  // second gates a console that also demands a password. What must never
  // happen is a PACKAGED build still running on the development values, which
  // are published in this repository's history.
  const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
  //
  // `assertProductionKeys` appears TWICE in this file: once as the declaration
  // and once as the call. Mutation testing deleted the CALL and the suite
  // passed, because a bare `/assertProductionKeys/` still matched the
  // declaration — the function existed and was never run, which is exactly the
  // shape of a guard that has quietly stopped guarding.
  //
  // Counted instead: a declaration with no call site is one occurrence.
  const guardMentions = (index.match(/assertProductionKeys/g) || []).length;
  ok('assertProductionKeys is defined', /function assertProductionKeys/.test(index));
  ok('…and actually CALLED, not merely declared', guardMentions >= 2,
    `${guardMentions} occurrence(s) — a lone declaration means it never runs`);
  ok('…and the check is keyed on app.isPackaged', /app\.isPackaged/.test(index));

  const crypto = readFileSync(join(ROOT, 'src/main/security/licenseCrypto.ts'), 'utf8');
  ok('the licence fallback is named as the DEV key', /DEV_FALLBACK_PUBLIC_KEY/.test(crypto));
  ok('the licence key is read from .env first',
    /process\.env\.MOBILESHOP_LICENSE_PUBLIC_KEY/.test(crypto));
  ok('the symmetric (forgeable) licence path is gone',
    !/createHmac\([^)]*LICENSE/i.test(crypto));

  const devAuth = readFileSync(join(ROOT, 'src/main/security/devAuth.ts'), 'utf8');
  ok('the dev password is read from .env first',
    /process\.env\.MOBILESHOP_DEV_PASSWORD_HASH/.test(devAuth));
  ok('the dev fallback is named as a fallback', /DEV_FALLBACK_HASH/.test(devAuth));

  // The Worker holds the keys that matter — the admin key and the licence
  // signing key. None may be literal in a tracked file.
  const worker = readFileSync(join(ROOT, 'server/worker.js'), 'utf8');
  for (const name of ['ADMIN_KEY', 'CLIENT_KEY', 'LICENSE_PRIVATE_KEY', 'TG_BOT_TOKEN']) {
    const assigned = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*['"\`][^'"\`]{8,}`);
    ok(`worker.js reads ${name} from env, never a literal`, !assigned.test(worker));
    ok(`…and does read env.${name}`, new RegExp(`env\\.${name}`).test(worker));
  }
  const wrangler = readFileSync(join(ROOT, 'server/wrangler.toml'), 'utf8');
  ok('wrangler.toml declares no secrets',
    !/^\s*(ADMIN_KEY|CLIENT_KEY|LICENSE_PRIVATE_KEY|TG_BOT_TOKEN|TG_ADMIN_CHAT)\s*=/m.test(wrangler));
}

// ===========================================================================
console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — no credential is committed or client-reachable`);
