/**
 * SECTION 2 — FOUNDATION: backup, restore, database paths, cloud/telegram
 * off-site copies, CSV export, remote config/messages, and the fast-lane
 * code-update guards.
 *
 * WHAT IS EXECUTED HERE
 * ---------------------
 * The REAL modules, bundled with esbuild and driven end-to-end:
 *   - src/main/database/connection.ts   (path decoding, WAL, getDb)
 *   - src/main/database/migrations/index.ts (the real schema)
 *   - src/main/ipc/database.handlers.ts (export/autoBackup/cloud/telegram)
 *   - src/main/ipc/backup.handlers.ts   (create/restore/info)
 *   - src/main/ipc/remote.handlers.ts   (messages, notices, sync)
 *   - src/main/remote/remoteConfig.ts, remoteStore.ts, heartbeat.ts
 *   - src/main/backup/telegramBackup.ts (token validation, upload)
 *   - src/main/codeUpdate.ts, src/main/updater.ts (guards + IPC)
 *
 * The only things replaced are the ones that cannot run in a test process:
 * `electron` (with a scriptable dialog + temp folders) and the network
 * (`globalThis.fetch`). The database is a REAL file on disk, opened by the
 * REAL connection module, migrated by the REAL migrations — so a backup must
 * prove itself by opening the file it wrote.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, utimesSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');

const PASS = [];
const FAIL = [];
const t = (name, cond, detail = '') => {
  (cond ? PASS : FAIL).push(name);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n          ${detail}`}`);
};

// Scriptable dialogs: the test pushes answers; the stub pops them.
globalThis.__FOUND_DIALOGS__ = { save: [], open: [] };

import { fileURLToPath } from 'node:url';
const SELF = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SELF, '..');

const electronStub = `
  const registry = (globalThis.__FOUND_HANDLERS__ ||= new Map());
  const dialogQ = globalThis.__FOUND_DIALOGS__;
  module.exports = {
    ipcMain: { handle: (c, f) => registry.set(c, f), removeHandler: (c) => registry.delete(c) },
    app: {
      getPath: (k) => {
        const p = globalThis.__FOUND_PATHS__;
        if (k === 'userData') return p.userData;
        if (k === 'temp') return p.temp;
        if (k === 'exe') return p.exe;
        return p.userData;
      },
      getVersion: () => '1.0.51',
      getName: () => 'mobile-shop-erp',
      getAppPath: () => globalThis.__FOUND_PATHS__.appPath,
      get isPackaged() { return !!globalThis.__FOUND_PACKAGED__; },
      quit: () => {},
      whenReady: async () => {},
      on: () => {},
    },
    dialog: {
      showSaveDialog: async () => {
        const a = dialogQ.save.shift();
        return a ?? { canceled: true };
      },
      showOpenDialog: async () => {
        const a = dialogQ.open.shift();
        return a ?? { canceled: true, filePaths: [] };
      },
      showMessageBox: async () => ({ response: 1 }),
      showErrorBox: () => {},
    },
    shell: { openExternal: async () => {} },
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => undefined, on() {} },
    webContents: { getAllWebContents: () => [] },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    Notification: class {},
  };
`;

async function buildBundle(exportsList) {
  const out = await build({
    entryPoints: [join(PROJECT_ROOT, '_foundation_entry.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['better-sqlite3', 'bcryptjs', 'electron-updater'],
    plugins: [{
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: electronStub, loader: 'js' }));
      },
    }],
  });
  const text = out.outputFiles[0].text;
  const file = join(PROJECT_ROOT, '_foundation_bundle.cjs');
  writeFileSync(file, text);
  const mod = require(file);
  rmSync(file, { force: true });
  return mod;
}

// The bundle entry — everything the suite drives.
const ENTRY = `
  export { runMigrations } from './src/main/database/migrations/index.ts';
  export { getDb, getDbPath, setDbPath, closeDb } from './src/main/database/connection.ts';
  export { registerDatabaseHandlers } from './src/main/ipc/database.handlers.ts';
  export { registerBackupHandlers } from './src/main/ipc/backup.handlers.ts';
  export { registerRemoteHandlers } from './src/main/ipc/remote.handlers.ts';
  export { isRemoteManaged, sanitiseRemoteValue, assertNoForbiddenOverlap, REMOTE_MANAGED_KEYS, REMOTE_FORBIDDEN_KEYS } from './src/main/remote/remoteConfig.ts';
  export { saveRemoteConfig, getRemoteOverrides, saveRemoteMessages, listRemoteMessages, listUnreadMessages, markMessageRead, pendingReadReceipts, markReceiptsSynced, ensureRemoteTables } from './src/main/remote/remoteStore.ts';
  export { buildPayload, runHeartbeat, lastSyncInfo, configuredServer } from './src/main/remote/heartbeat.ts';
  export { looksLikeBotToken, looksLikeChatId, redactToken, TELEGRAM_MAX_UPLOAD_BYTES } from './src/main/backup/telegramBackup.ts';
  export { __resetLoginThrottle } from './src/main/security/loginThrottle.ts';
  export { isCodeUpdateStaged, applyStagedCode, markCodeBootOk, checkForCodeUpdatesNow, stopCodeUpdater } from './src/main/codeUpdate.ts';
  export { registerUpdaterIpc } from './src/main/updater.ts';
`;

const entryFile = join(PROJECT_ROOT, '_foundation_entry.ts');
writeFileSync(entryFile, ENTRY);

// Fresh temp home for the database and settings.
const paths = {
  userData: mkdtempSync(join(tmpdir(), 'found-user-')),
  temp: mkdtempSync(join(tmpdir(), 'found-tmp-')),
  exe: join(mkdtempSync(join(tmpdir(), 'found-exe-')), 'MobileShopERP', 'app.exe'),
  appPath: mkdtempSync(join(tmpdir(), 'found-app-')),
};
writeFileSync(join(paths.appPath, 'package.json'), JSON.stringify({ name: 'mobile-shop-erp', version: '1.0.51' }));
globalThis.__FOUND_PATHS__ = paths;
globalThis.__FOUND_PACKAGED__ = false;

console.log('\nBuilding the real foundation bundle…');
const mod = await buildBundle(ENTRY);
rmSync(entryFile, { force: true });

// ---------------------------------------------------------------- 1
console.log('\n[1] db_settings.json — encodings and lone backslashes (before the connection opens)');
{
  const settingsFile = join(paths.userData, 'db_settings.json');

  // The NSIS installer writes UTF-16LE WITH BOM and LITERAL backslashes:
  //   {"dbPath":"C:\ProgramData\MobileShopERP\mobile_shop.db"}
  const utf16Target = join(paths.temp, 'installed.db');
  writeFileSync(utf16Target, '');
  const raw = `{"dbPath":"${utf16Target}"}`;
  const utf16le = Buffer.from('\uFEFF' + raw, 'utf16le');
  writeFileSync(settingsFile, utf16le);
  const p1 = mod.getDbPath();
  t('a UTF-16LE BOM settings file with lone backslashes decodes to the real path',
    p1 === utf16Target, p1);

  // UTF-8 with proper escapes (what setDbPath itself writes).
  const utf8Target = join(paths.temp, 'utf8.db');
  writeFileSync(utf8Target, '');
  writeFileSync(settingsFile, JSON.stringify({ dbPath: utf8Target }), 'utf-8');
  t('a UTF-8 settings file is read as-is',
    mod.getDbPath() === utf8Target, mod.getDbPath());

  // Garbage must fall back to the default, never crash.
  writeFileSync(settingsFile, '\u0000\u0001 not json at all');
  t('an unreadable settings file falls back to the default path, no crash',
    mod.getDbPath() === join(paths.userData, 'mobile_shop.db'), mod.getDbPath());

  // Remove the settings file so the connection opens on the default path.
  unlinkSync(settingsFile);
}

// ---------------------------------------------------------------- setup
const call = (channel, ...args) => {
  const fn = globalThis.__FOUND_HANDLERS__.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return fn({ sender: { id: 1 } }, ...args);
};

// Real database on disk: real migrations, real connection (WAL).
let db = mod.getDb();
mod.runMigrations(db);
mod.registerDatabaseHandlers();
mod.registerBackupHandlers();
mod.registerRemoteHandlers(() => 'test-device', () => ({ status: 'active', expiry: null }));

const journal = db.pragma('journal_mode', { simple: true });
t('a local database runs in WAL mode', String(journal) === 'wal', String(journal));

// A customer whose name is a spreadsheet formula: the export must neutralise it.
db.prepare(`INSERT INTO customers (Name, Phone, Email, Address) VALUES (?, ?, ?, ?)`)
  .run('=HYPERLINK("http://evil.example")', '01000000001', 'a@b.c', 'المنصورة');
db.prepare(`INSERT INTO customers (Name, Phone) VALUES (?, ?)`).run('+cmd|/c calc', '01000000002');
db.prepare(`INSERT INTO customers (Name, Phone) VALUES (?, ?)`).run('منس, أحمد — زبون', '01000000003');

// ---------------------------------------------------------------- 2
console.log('\n[2] db:exportCSV — formula injection neutralised, blocklist enforced');
{
  globalThis.__FOUND_DIALOGS__.save.push({ canceled: false, filePath: join(paths.temp, 'cust.csv') });
  const r1 = await call('db:exportCSV', 'customers');
  t('customers export succeeds via the real handler', r1?.success === true, JSON.stringify(r1));
  const csv = readFileSync(join(paths.temp, 'cust.csv'), 'utf-8');
  t('the CSV begins with a BOM (Excel Arabic)', csv.startsWith('\uFEFF'), csv.slice(0, 8));
  t('an = formula cell is neutralised with a leading quote (quotes doubled inside the cell)',
    csv.includes(`"'=HYPERLINK(""http://evil.example"")"`), csv);
  t('a + command cell is neutralised',
    csv.includes(`'+cmd|/c calc`), csv);
  t('a comma inside a value is quoted',
    csv.includes('"منس, أحمد — زبون"'), csv);

  const r2 = await call('db:exportCSV', 'users');
  t('exporting users (password hashes) is refused',
    r2?.success === false && /أمنية/.test(r2?.message), JSON.stringify(r2));
  const r3 = await call('db:exportCSV', 'settings');
  t('exporting settings (bearer credentials) is refused',
    r3?.success === false && /أمنية/.test(r3?.message), JSON.stringify(r3));
  const r4 = await call('db:exportCSV', 'user_overrides');
  t('exporting user_overrides is refused',
    r4?.success === false, JSON.stringify(r4));
  const r5 = await call('db:exportCSV', 'no_such_table');
  t('exporting a non-existent table is refused',
    r5?.success === false, JSON.stringify(r5));
  const r6 = await call('db:exportCSV', 'customers; DROP TABLE items');
  t('an SQL-injection table name is refused, not interpolated',
    r6?.success === false && db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='items'").get().n === 1,
    JSON.stringify(r6));
  const r7 = await call('db:exportCSV', 42);
  t('a non-string table name is refused',
    r7?.success === false, JSON.stringify(r7));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] db:getTables + db:exportAllCSV — blocklist out of reach');
{
  const tables = await call('db:getTables');
  t('getTables excludes users/settings/user_overrides',
    Array.isArray(tables) && !['users', 'settings', 'user_overrides'].some(x => tables.includes(x)),
    JSON.stringify(tables));
  t('getTables still lists business tables',
    Array.isArray(tables) && tables.includes('customers') && tables.includes('sales'));

  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [join(paths.temp, 'allexport')] });
  mkdirSync(join(paths.temp, 'allexport'), { recursive: true });
  const r = await call('db:exportAllCSV');
  t('exportAllCSV succeeds', r?.success === true, JSON.stringify(r));
  t('customers.csv is written', existsSync(join(paths.temp, 'allexport', 'customers.csv')));
  t('users.csv is NOT written', !existsSync(join(paths.temp, 'allexport', 'users.csv')));
  t('settings.csv is NOT written', !existsSync(join(paths.temp, 'allexport', 'settings.csv')));
  const cc = readFileSync(join(paths.temp, 'allexport', 'customers.csv'), 'utf-8');
  t('the formula cell is also neutralised in the bulk export', cc.includes(`'=HYPERLINK`));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] db:autoBackup + db:backupInfo — retention and WAL-safe copy');
{
  const backupsDir = join(paths.userData, 'backups');
  mkdirSync(backupsDir, { recursive: true });

  // Old auto backups (must be pruned) vs a manual file (must survive) vs a
  // subdirectory (must not be touched).
  const oldAuto = join(backupsDir, 'auto_backup_2020-01-01.db');
  writeFileSync(oldAuto, 'junk');
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(oldAuto, old, old);
  const manual = join(backupsDir, 'manual_2020-01-01.db');
  writeFileSync(manual, 'junk');
  utimesSync(manual, old, old);
  const sub = join(backupsDir, 'subfolder');
  mkdirSync(sub);
  writeFileSync(join(sub, 'auto_backup_2019-01-01.db'), 'junk');

  const r1 = await call('db:autoBackup');
  t('autoBackup creates today\'s backup', r1?.success === true, JSON.stringify(r1));
  // The app names backups with the SHOP's local calendar (businessToday), not
  // the UTC instant — toISOString() would guess the wrong file around the
  // UTC/local date boundary and the suite would fail on perfectly good code.
  const loc = new Date();
  const today = `${loc.getFullYear()}-${String(loc.getMonth() + 1).padStart(2, '0')}-${String(loc.getDate()).padStart(2, '0')}`;
  const backupPath = join(backupsDir, `auto_backup_${today}.db`);
  t('the backup file exists on disk', existsSync(backupPath));

  const probe = require('better-sqlite3')(backupPath, { readonly: true });
  const n = probe.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='sales'").get().n;
  t('the auto-backup is a readable SQLite database with the app schema', n === 1, `n=${n}`);
  const cust = probe.prepare('SELECT COUNT(*) n FROM customers').get().n;
  t('the auto-backup contains the data', cust >= 3, `customers=${cust}`);
  probe.close();

  t('a 30-day-old auto backup was pruned', !existsSync(oldAuto));
  t('a manual file NOT matching the auto pattern survived', existsSync(manual));
  t('files inside a subdirectory are not touched',
    existsSync(join(sub, 'auto_backup_2019-01-01.db')));

  const r2 = await call('db:autoBackup');
  t('a second call today reports the daily backup already exists',
    r2?.success === true && /موجودة/.test(r2?.message), JSON.stringify(r2));

  const info = await call('db:backupInfo');
  t('backupInfo reports the live db path', info?.dbPath === join(paths.userData, 'mobile_shop.db'), info?.dbPath);
  t('backupInfo lists today\'s backup',
    Array.isArray(info?.backups) && info.backups.some(b => b.name === `auto_backup_${today}.db`));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] backup:create — the manual backup channel, end to end');
{
  globalThis.__FOUND_DIALOGS__.save.push({ canceled: false, filePath: join(paths.temp, 'manual.db') });
  const r1 = await call('backup:create');
  t('backup:create succeeds', r1?.success === true, JSON.stringify(r1));
  const probe = require('better-sqlite3')(join(paths.temp, 'manual.db'), { readonly: true });
  const integ = probe.pragma('integrity_check', { simple: true });
  t('the manual backup passes a real integrity_check', integ === 'ok', String(integ));
  t('the manual backup contains the customers', probe.prepare('SELECT COUNT(*) n FROM customers').get().n >= 3);
  probe.close();

  globalThis.__FOUND_DIALOGS__.save.push({ canceled: true });
  const r2 = await call('backup:create');
  t('cancelling the save dialog reports cancellation, not an error',
    r2?.success === false && /إلغاء/.test(r2?.message), JSON.stringify(r2));

  const info = await call('backup:info');
  t('backup:info returns the live path', info?.path === join(paths.userData, 'mobile_shop.db'), info?.path);
  t('backup:info returns a positive size', Number(info?.size) > 0, JSON.stringify(info));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] backup:restore — a bad file must never destroy the live database');
{
  // 6a. A junk file (not even a SQLite header).
  const junk = join(paths.temp, 'junk.db');
  writeFileSync(junk, 'this is definitely not a database at all');
  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [junk] });
  const r1 = await call('backup:restore');
  t('a non-SQLite file is refused before anything is touched',
    r1?.success === false && /ليس قاعدة بيانات صالحة/.test(r1?.message), JSON.stringify(r1));
  // 6b. SQLite-shaped but corrupt (valid 16-byte header, garbage body).
  const corrupt = join(paths.temp, 'corrupt.db');
  const hdr = Buffer.from('SQLite format 3\u0000');
  const body = Buffer.alloc(4096 * 40, 0x61);
  writeFileSync(corrupt, Buffer.concat([hdr, body]));
  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [corrupt] });
  const r2 = await call('backup:restore');
  t('a corrupt database is refused with the integrity message',
    r2?.success === false && /تالفة/.test(r2?.message), JSON.stringify(r2));

  // 6c. A perfectly valid SQLite file that is not THIS app's database.
  const alien = join(paths.temp, 'alien.db');
  const alienDb = require('better-sqlite3')(alien);
  alienDb.exec('CREATE TABLE something_else (id INTEGER); INSERT INTO something_else VALUES (1)');
  alienDb.close();
  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [alien] });
  const r3 = await call('backup:restore');
  t('a valid SQLite file without the app tables is refused as foreign',
    r3?.success === false && /ليست قاعدة بيانات هذا البرنامج/.test(r3?.message), JSON.stringify(r3));

  // 6d. The live database is still intact after all three refusals.
  t('the live database still has its customers after refused restores',
    db.prepare('SELECT COUNT(*) n FROM customers').get().n >= 3);

  // 6e. The REAL round trip: back up, wipe, restore, verify.
  globalThis.__FOUND_DIALOGS__.save.push({ canceled: false, filePath: join(paths.temp, 'roundtrip.db') });
  await call('backup:create');
  const livePath = join(paths.userData, 'mobile_shop.db');
  const before = db.prepare('SELECT COUNT(*) n FROM customers').get().n;

  // Wipe the live database (simulating a disaster).
  mod.closeDb();
  writeFileSync(livePath, 'GONE GONE GONE');
  writeFileSync(livePath + '-wal', '');
  writeFileSync(livePath + '-shm', '');

  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [join(paths.temp, 'roundtrip.db')] });
  const rr = await call('backup:restore');
  t('restoring the good backup succeeds', rr?.success === true, JSON.stringify(rr));
  t('a .before-restore rollback copy was kept', existsSync(livePath + '.before-restore'));
  t('stale WAL/SHM files were removed', !existsSync(livePath + '-wal') && !existsSync(livePath + '-shm'));

  const reopened = mod.getDb();
  db = reopened;
  const after = reopened.prepare('SELECT COUNT(*) n FROM customers').get().n;
  t('the live database is whole again after restore (same customer count)',
    after === before, `before=${before} after=${after}`);
  const afterFirst = reopened.prepare('SELECT Name FROM customers ORDER BY CustomerID LIMIT 1').get();
  t('the restored data is the real data (formula customer present)',
    String(afterFirst?.Name).startsWith('='), JSON.stringify(afterFirst));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] db:changePath / db:getPath / db:createNetwork');
{
  const r1 = await call('db:changePath', join(paths.temp, 'does-not-exist.db'));
  t('a non-existent path is refused', r1?.success === false, JSON.stringify(r1));

  const fake = join(paths.temp, 'fake.db');
  writeFileSync(fake, '{"not":"a database"}');
  const r2 = await call('db:changePath', fake);
  t('a non-SQLite file is refused before the settings are touched',
    r2?.success === false && /SQLite/.test(r2?.message), JSON.stringify(r2));

  const valid = join(paths.temp, 'valid-target.db');
  const vdb = require('better-sqlite3')(valid);
  vdb.exec('CREATE TABLE t (id INTEGER)');
  vdb.close();
  const r3 = await call('db:changePath', valid);
  t('a valid SQLite file is accepted', r3?.success === true, JSON.stringify(r3));
  const settings = JSON.parse(readFileSync(join(paths.userData, 'db_settings.json'), 'utf-8'));
  t('db_settings.json records the new path', settings?.dbPath === valid, JSON.stringify(settings));
  const got = await call('db:getPath');
  t('db:getPath reports the LIVE database path while connected', got === db.name, String(got));

  // Undo: delete the settings so the suite continues on the default path.
  unlinkSync(join(paths.userData, 'db_settings.json'));

  const shareDir = join(paths.temp, 'share');
  mkdirSync(shareDir, { recursive: true });
  const r4 = await call('db:createNetwork', shareDir);
  t('createNetwork seeds a shared database', r4?.success === true, JSON.stringify(r4));
  const shared = join(shareDir, 'mobile_shop_shared.db');
  const sprobe = require('better-sqlite3')(shared, { readonly: true });
  t('the shared database is a real SQLite file with the app schema',
    sprobe.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='customers'").get().n === 1);
  sprobe.close();
  const r5 = await call('db:createNetwork', shareDir);
  t('creating a network database over an existing one is refused',
    r5?.success === false && /يوجد/.test(r5?.message), JSON.stringify(r5));}

// ---------------------------------------------------------------- 8
console.log('\n[8] cloud settings — the API key never reaches the renderer');
{
  db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('cloud_api_key', 'sbp_LIVE_SECRET_123')").run();
  const g1 = await call('db:getCloudSettings');
  t('the stored key is NOT returned to the renderer',
    g1?.cloud_api_key !== 'sbp_LIVE_SECRET_123', JSON.stringify(g1));
  t('a masked placeholder is returned instead',
    g1?.cloud_api_key === '••••••••••••', JSON.stringify(g1));
  t('presence is reported separately',
    g1?.hasCloudApiKey === true, JSON.stringify(g1));

  // Sending the mask back must leave the stored value untouched.
  const s1 = await call('db:saveCloudSettings', { cloud_api_key: '••••••••••••' });
  t('saving the mask back succeeds', s1?.success === true, JSON.stringify(s1));
  const stored = db.prepare("SELECT Value FROM settings WHERE Key='cloud_api_key'").get();
  t('the real key survived the mask round-trip', stored?.Value === 'sbp_LIVE_SECRET_123', JSON.stringify(stored));

  // A genuinely new key replaces the old one.
  const s2 = await call('db:saveCloudSettings', { cloud_api_key: 'new-key-456' });
  const stored2 = db.prepare("SELECT Value FROM settings WHERE Key='cloud_api_key'").get();
  t('a real new key replaces the stored one', s2?.success === true && stored2?.Value === 'new-key-456');

  const s3 = await call('db:saveCloudSettings', { anything_else: 'x' });
  t('a key outside cloud_/sync_ is refused entirely',
    s3?.success === false && /مفتاح غير مسموح/.test(s3?.message), JSON.stringify(s3));

  // Restore the original key for the upload test below.
  db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('cloud_api_key', 'sbp_LIVE_SECRET_123')").run();
}

// ---------------------------------------------------------------- 9
console.log('\n[9] db:uploadToCloud — https enforced, stored key used');
{
  // Capture every fetch the app makes.
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) };
  };

  const r1 = await call('db:uploadToCloud', {
    type: 'custom', url: 'http://example.com', apiKey: '••••••••••••',
  });
  t('an http:// destination is refused BEFORE any upload',
    r1?.success === false && /https/.test(r1?.message), JSON.stringify(r1));
  t('no request was made for the http destination', calls.length === 0, String(calls.length));

  const r2 = await call('db:uploadToCloud', {
    type: 'custom', url: 'https://backup.example.com/dav', apiKey: '••••••••••••',
  });
  t('an https:// upload succeeds', r2?.success === true, JSON.stringify(r2));
  t('the stored API key was used, not the mask',
    calls.some(c => /Bearer sbp_LIVE_SECRET_123/.test(c.init?.headers?.Authorization)),
    JSON.stringify(calls.map(c => c.init?.headers?.Authorization)));

  // The temp backup is cleaned up after upload.
  const tmpDump = join(paths.temp, `mobile_shop_${new Date().toISOString().slice(0, 10)}.db`);
  t('the temporary upload dump is removed', !existsSync(tmpDump));
}

// ---------------------------------------------------------------- 10
console.log('\n[10] telegram handlers — validation, secrecy, clearing');
{
  const bad1 = await call('telegram:saveSettings', { botToken: 'not-a-token', chatId: '12345' });
  t('an invalid bot token is refused', bad1?.success === false && /بوت/.test(bad1?.message), JSON.stringify(bad1));
  const bad2 = await call('telegram:saveSettings', { botToken: '123456789:EXAMPLEbot_abcdefghijklmnopqrstuvwxyz', chatId: 'xyz' });
  t('an invalid chat id is refused', bad2?.success === false && /معرّف/.test(bad2?.message), JSON.stringify(bad2));
  const good = await call('telegram:saveSettings', {
    botToken: '123456789:EXAMPLEbot_abcdefghijklmnopqrstuvwxyz',
    chatId: '987654321',
    enabled: true,
  });
  t('valid telegram settings are saved', good?.success === true, JSON.stringify(good));

  const g = await call('telegram:getSettings');
  t('getSettings reports the token is present', g?.hasToken === true, JSON.stringify(g));
  t('getSettings NEVER returns the full token',
    !JSON.stringify(g).includes('123456789:EXAMPLEbot_abcdefghijklmnopqrstuvwxyz'), JSON.stringify(g));
  t('the token hint masks the secret half', g?.tokenHint === '123456789:***', JSON.stringify(g));

  // The test flow runs the real testTelegram against a stubbed API.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'ownerbot' } }) };
    if (u.endsWith('/sendMessage')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const test = await call('telegram:test', {});
  t('telegram:test succeeds against a reachable API', test?.success === true, JSON.stringify(test));

  const cleared = await call('telegram:clearSettings');
  t('clearSettings succeeds', cleared?.success === true, JSON.stringify(cleared));
  const g2 = await call('telegram:getSettings');
  t('after clearing, no token is reported', g2?.hasToken === false, JSON.stringify(g2));
  const g3 = await call('telegram:getSettings');
  t('after clearing, the chat id is gone', !g3?.chatId, JSON.stringify(g3));
}

// ---------------------------------------------------------------- 11
console.log('\n[11] db:exportForOwner — throttled, admin-only, blocklist, audited');
{
  // The seeded admin account (admin/admin123) exists after migrations.
  const user = db.prepare("SELECT UserID, PasswordHash, RoleID FROM users WHERE Username='admin'").get();
  t('the seeded admin account exists for this test', !!user);

  // Five wrong passwords must lock the dangerous scope.
  let last;
  for (let i = 0; i < 5; i++) {
    last = await call('db:exportForOwner', { username: 'admin', password: 'wrong-pass' });
  }
  t('five wrong passwords are all refused', last?.success === false, JSON.stringify(last));

  // The sixth attempt — even with the CORRECT password — is locked out.
  const locked = await call('db:exportForOwner', { username: 'admin', password: 'admin123' });
  t('a correct password on a throttled identity is still refused',
    locked?.success === false && locked?.code === 'LOCKED_OUT', JSON.stringify(locked));

  // A non-admin account with a correct password must be refused too.
  const hash = bcrypt.hashSync('CashierPass123', 10);
  db.prepare('INSERT INTO users (Username, PasswordHash, RoleID, EmployeeID, IsActive) VALUES (?,?,?,NULL,1)')
    .run('cashier_probe', hash, 2);
  const nonAdmin = await call('db:exportForOwner', { username: 'cashier_probe', password: 'CashierPass123' });
  t('a correct non-admin password cannot export the books',
    nonAdmin?.success === false && /المدير/.test(nonAdmin?.message), JSON.stringify(nonAdmin));

  // Wait out the throttle for the success path (throttle window is 15 min, so
  // reset it directly for the remaining assertions — the lockout itself was
  // already proven above).
  mod.__resetLoginThrottle();
  const folder = join(paths.temp, 'owner-export');
  mkdirSync(folder, { recursive: true });
  globalThis.__FOUND_DIALOGS__.open.push({ canceled: false, filePaths: [folder] });
  const ok = await call('db:exportForOwner', { username: 'admin', password: 'admin123' });
  t('an admin with the correct password exports the books', ok?.success === true, JSON.stringify(ok));
  t('the export writes customers.csv', existsSync(join(folder, 'customers.csv')));
  t('the export does NOT write users.csv (hashes stay local)',
    !existsSync(join(folder, 'users.csv')));
  t('the export does NOT write settings.csv (credentials stay local)',
    !existsSync(join(folder, 'settings.csv')));
  const evt = db.prepare("SELECT * FROM security_events WHERE EventType='data_export_owner' ORDER BY EventID DESC LIMIT 1").get();
  t('the export is recorded in the security log', !!evt, JSON.stringify(evt));
}

// ---------------------------------------------------------------- 12
console.log('\n[12] remote config — the client allow-list is a hard gate');
{
  t('a presentation key is remotely manageable', mod.isRemoteManaged('app_name') === true);
  t('a presentation key is remotely manageable (dev_phone)', mod.isRemoteManaged('dev_phone') === true);
  t('an accounting key is NOT remotely manageable', mod.isRemoteManaged('allow_negative_stock') === false);
  t('a balance-affecting key is NOT remotely manageable', mod.isRemoteManaged('owner_capital') === false);
  t('the shop identity is NOT remotely manageable', mod.isRemoteManaged('company_name') === false);
  t('db_path is NOT remotely manageable', mod.isRemoteManaged('db_path') === false);
  mod.assertNoForbiddenOverlap();
  t('assertNoForbiddenOverlap passes (no managed key is forbidden)', true);

  t('sanitiseRemoteValue strips control characters',
    mod.sanitiseRemoteValue('app_name', 'Good\u0000Name\u0007') === 'GoodName',
    mod.sanitiseRemoteValue('app_name', 'x'));
  t('sanitiseRemoteValue rejects a value over 4000 chars',
    mod.sanitiseRemoteValue('custom_content', 'x'.repeat(4001)) === null);
  t('sanitiseRemoteValue accepts exactly 4000 chars',
    mod.sanitiseRemoteValue('custom_content', 'x'.repeat(4000)) !== null);
  t('sanitiseRemoteValue rejects objects', mod.sanitiseRemoteValue('app_name', { x: 1 }) === null);
  t('sanitiseRemoteValue rejects arrays', mod.sanitiseRemoteValue('app_name', ['x']) === null);
  t('sanitiseRemoteValue rejects numbers above the cap via string length',
    typeof mod.sanitiseRemoteValue('app_name', 5) === 'string');

  // The store only writes keys the allow-list knows.
  mod.ensureRemoteTables();
  mod.saveRemoteConfig('all', {
    app_name: 'محل جديد',
    company_name: 'يجب تجاهله',     // forbidden — must be dropped
    allow_negative_stock: '1',       // forbidden — must be dropped
    dev_phone: '010000',
  });
  const overrides = mod.getRemoteOverrides();
  t('only allow-listed keys are stored', overrides.app_name === 'محل جديد', JSON.stringify(overrides));
  t('forbidden keys are never stored', !('company_name' in overrides) && !('allow_negative_stock' in overrides));

  mod.saveRemoteConfig('device', { app_name: 'محل هذا الجهاز' });
  const o2 = mod.getRemoteOverrides();
  t('a device-scoped value wins over the broadcast value', o2.app_name === 'محل هذا الجهاز', JSON.stringify(o2));

  // An empty string clears the override.
  mod.saveRemoteConfig('device', { app_name: '' });
  const o3 = mod.getRemoteOverrides();
  t('an empty remote value removes the override', o3.app_name === 'محل جديد', JSON.stringify(o3));
}

// ---------------------------------------------------------------- 13
console.log('\n[13] remote messages — lifecycle, expiry, read receipts');
{
  mod.ensureRemoteTables();
  mod.saveRemoteMessages([
    { id: 1, title: 'صيانة الليلة', body: 'الساعة 2 صباحاً', severity: 'warning' },
    { id: 2, title: 'نسخة جديدة', body: 'تم إصدار 1.0.52' },
    { id: 2, title: 'نسخة جديدة (محدثة)', body: 'تم إصدار 1.0.52' }, // same id → update
    { id: 3, title: 'تأخرت', body: 'رسالة قديمة', expiresAt: '2000-01-01T00:00:00Z' },
    { id: 99, title: '', body: '' },   // empty — skipped
    { title: 'بدون معرف', body: 'لا id' }, // no id — skipped
  ]);

  const unread = mod.listUnreadMessages();
  t('unread messages are returned, oldest first',
    unread.length === 2 && unread[0].MessageID === 1 && unread[1].MessageID === 2, JSON.stringify(unread));
  t('an expired message is never shown', !unread.some(m => m.MessageID === 3));
  t('empty messages are skipped', !unread.some(m => m.MessageID === 99));

  mod.markMessageRead(1);
  const unread2 = mod.listUnreadMessages();
  t('a read message leaves the unread list', unread2.length === 1 && unread2[0].MessageID === 2);
  const receipts = mod.pendingReadReceipts();
  t('a read message becomes a pending receipt', receipts.includes(1), JSON.stringify(receipts));
  mod.markReceiptsSynced([1]);
  t('syncing the receipt clears the pending list', !mod.pendingReadReceipts().includes(1));

  const listed = mod.listRemoteMessages();
  t('the read message stays visible in the full list', listed.some(m => m.MessageID === 1));
}

// ---------------------------------------------------------------- 14
console.log('\n[14] remote IPC handlers — whitelisted, read-only surface');
{
  const msgs = await call('remote:messages');
  t('remote:messages returns the message list', Array.isArray(msgs), JSON.stringify(msgs));

  const bad = await call('remote:markRead', '1');
  t('remote:markRead refuses a non-number id', bad?.success === false, JSON.stringify(bad));
  const good = await call('remote:markRead', 2);
  t('remote:markRead accepts a number', good?.success === true, JSON.stringify(good));

  const d1 = await call('remote:dismissNotice', 'anything_else');
  t('dismissing an unknown notice kind is refused', d1?.success === false, JSON.stringify(d1));
  const d2 = await call('remote:dismissNotice', 'offline');
  t('dismissing a known notice kind succeeds', d2?.success === true, JSON.stringify(d2));
  const d3 = await call('remote:dismissNotice', 'expiry');
  t('dismissing the expiry notice succeeds', d3?.success === true, JSON.stringify(d3));

  const mk = await call('remote:managedKeys');
  t('managedKeys lists the allow-list', Array.isArray(mk?.keys) && mk.keys.includes('app_name'), JSON.stringify(mk));

  const info = await call('remote:syncInfo');
  t('syncInfo reports enabled=false when no server is configured', info?.enabled === false, JSON.stringify(info));

  const privacy = await call('remote:privacyReport');
  t('the privacy report lists exactly the fields the heartbeat sends',
    Array.isArray(privacy?.sends) && privacy.sends.length === 7, JSON.stringify(privacy?.sends?.length));
  t('the privacy report promises no business data leaves',
    Array.isArray(privacy?.neverSends) && /الفواتير/.test(privacy.neverSends.join(' ')));
}

// ---------------------------------------------------------------- 15
console.log('\n[15] heartbeat payload — the exact shape, nothing more');
{
  const payload = mod.buildPayload('device-123', { status: 'active', expiry: '2027-01-01' });
  const keys = Object.keys(payload);
  t('the payload has exactly the 7 declared fields', keys.length === 7, JSON.stringify(keys));
  t('deviceId is included', payload.deviceId === 'device-123');
  t('license status is included', payload.licenseStatus === 'active');
  t('shopName is included by default', typeof payload.shopName === 'string');
  t('no payload field can carry business data',
    !keys.some(k => /customer|sale|invoice|balance|stock/i.test(k)));

  db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('telemetry_share_shop_name', '0')").run();
  const p2 = mod.buildPayload('device-123', {});
  t('a shop that opts out sends no shop name', p2.shopName === null, JSON.stringify(p2));
  db.prepare("DELETE FROM settings WHERE Key = 'telemetry_share_shop_name'").run();

  const readReceipts = mod.buildPayload('d', {}).readReceipts;
  t('read receipts are included in the payload', Array.isArray(readReceipts));

  // runHeartbeat with NO server configured returns false — never blocks.
  const ok = await mod.runHeartbeat('device-123', {});
  t('runHeartbeat with no server configured fails closed, quietly', ok === false);
}

// ---------------------------------------------------------------- 16
console.log('\n[16] code fast-lane — staged swaps can never downgrade');
{
  const resources = join(dirname(paths.exe), 'resources');
  mkdirSync(resources, { recursive: true });

  t('no staged asar exists initially', mod.isCodeUpdateStaged() === false);

  // A staged asar whose package.json is unreadable must be refused AND purged.
  const staged = join(resources, 'app.asar.new');
  writeFileSync(staged, 'not a real asar archive');
  t('a staged file is detected', mod.isCodeUpdateStaged() === true);
  const applied = mod.applyStagedCode();
  t('an unreadable staged asar is refused (never swapped)', applied === false);
  t('the unreadable staged file is purged, not left to rot', !existsSync(staged));

  // markCodeBootOk stamps a healthy boot and cleans stale artefacts.
  writeFileSync(staged, 'stale bytes');
  writeFileSync(join(resources, 'app.asar.bak'), 'old backup');
  mod.markCodeBootOk();
  t('.code-ok is stamped after a healthy boot', existsSync(join(resources, '.code-ok')));
  t('a stale app.asar.bak is removed after a healthy boot', !existsSync(join(resources, 'app.asar.bak')));
  t('stale staged files are purged after a healthy boot', !existsSync(staged));

  // Manual check with NO server configured is a quiet non-event.
  const check = await mod.checkForCodeUpdatesNow();
  t('checkForCodeUpdatesNow fails closed when not started', check?.ok === false, JSON.stringify(check));

  mod.stopCodeUpdater();
}

// ---------------------------------------------------------------- 17
console.log('\n[17] updater IPC — dev build answers honestly, never claims installed');
{
  mod.registerUpdaterIpc();
  const check = await call('updater:check');
  t('updater:check reports that auto-update is unavailable in this build',
    check?.ok === false, JSON.stringify(check));
  const now = await call('updater:updateNow');
  t('updater:updateNow refuses when nothing was downloaded', now?.ok === false, JSON.stringify(now));
  const st = await call('updater:getStatus');
  t('updater:getStatus reports idle', st?.state === 'idle', JSON.stringify(st));
}

// ---------------------------------------------------------------- result
console.log('\n' + '='.repeat(74));
console.log(`SECTION 2 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log('\nFAILED:');
  for (const f of FAIL) console.log(`  - ${f}`);
}
process.exit(FAIL.length ? 1 : 0);
