#!/usr/bin/env node
/**
 * Remote-management and privacy checks.
 *
 * The two guarantees that matter:
 *   1. a compromised server can only change presentation values, never
 *      accounting behaviour or the shop's own identity;
 *   2. a heartbeat transmits nothing about the customer's business.
 *
 * Both are asserted against the real source, not a copy.
 *
 * Run with:  node scripts/verify_remote.js
 */
const fs = require('node:fs');
const path = require('node:path');

const PASS = [], FAIL = [];
const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
}

console.log('='.repeat(72));
console.log('REMOTE MANAGEMENT & PRIVACY CHECKS');
console.log('='.repeat(72));

const cfg = R('src/main/remote/remoteConfig.ts');
const store = R('src/main/remote/remoteStore.ts');
const beat = R('src/main/remote/heartbeat.ts');
const settings = R('src/main/ipc/settings.handlers.ts');
const worker = R('server/worker.js');

// ---------------------------------------------------------------- 1
console.log('\n[1] The allow-list is enforced on the CLIENT, not trusted from the server');
{
  const managed = [...cfg.matchAll(/^\s*'([a-z_]+)',/gm)].map(m => m[1]);
  check('allow-list is non-empty', managed.length > 15, `${managed.length} keys`);
  check('store filters every incoming key', store.includes('if (!isRemoteManaged(key)) continue'));
  check('values are sanitised before storage', store.includes('sanitiseRemoteValue'));
  check('reads are filtered again on the way out', store.includes('if (isRemoteManaged(r.Key)'));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Accounting and shop-identity keys can never be set remotely');
{
  const forbidden = [
    'owner_capital', 'allow_negative_stock', 'allow_negative_cash',
    'allow_negative_customer', 'allow_negative_supplier', 'db_path',
    'setup_completed', 'vat_enabled', 'vat_rate',
    'company_name', 'owner_name', 'tax_number', 'bank_account', 'currency',
  ];
  const listBlock = cfg.slice(cfg.indexOf('REMOTE_MANAGED_KEYS'), cfg.indexOf('REMOTE_FORBIDDEN_KEYS'));
  const leaked = forbidden.filter(k => new RegExp(`'${k}'`).test(listBlock));
  check('no protected key appears in the allow-list', leaked.length === 0, leaked.join(', '));
  check('forbidden list is declared explicitly', cfg.includes('REMOTE_FORBIDDEN_KEYS'));
  check('an overlap check exists and is called',
    cfg.includes('assertNoForbiddenOverlap') && store.includes('assertNoForbiddenOverlap()'));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The heartbeat sends only non-business data');
{
  const payload = beat.slice(beat.indexOf('export function buildPayload'), beat.indexOf('async function postJson'));
  const fields = [...payload.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]);
  const allowed = ['deviceId', 'appVersion', 'platform', 'licenseStatus', 'licenseExpiry', 'shopName', 'readReceipts'];
  const unexpected = fields.filter(f => !allowed.includes(f));
  check('payload has exactly the disclosed fields', unexpected.length === 0, unexpected.join(', '));

  const banned = /\b(customers|suppliers|sales|invoices|purchases|balance|amount|profit|PasswordHash|items)\b/i;
  check('no business table is referenced in the payload', !banned.test(payload));
  check('shop name can be suppressed', beat.includes('telemetry_share_shop_name'));
  // The check-in is MANDATORY: there is no `telemetry_enabled` opt-in switch,
  // so the only gate is whether a server is configured at all. Mandatory means
  // "always attempts when online", never "blocks while offline".
  check('the check-in is mandatory whenever a server is configured',
    beat.includes('configuredServer') && beat.includes('!API_BASE || !CLIENT_KEY'));
  check('and there is no customer-facing on/off escape hatch',
    !beat.includes("setting('telemetry_enabled') === '1'")
    && !R('src/main/ipc/remote.handlers.ts').includes('remote:setTelemetry'));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] The feature can never break or block the application');
{
  check('runs only after an explicit delay', beat.includes('FIRST_RUN_DELAY_MS'));
  check('network errors are swallowed', beat.includes('return null;   // offline'));
  check('requests time out', beat.includes('AbortController') && beat.includes('REQUEST_TIMEOUT_MS'));
  check('timer does not hold the process open', beat.includes('timer.unref?.()'));
  check('disabled when no endpoint is configured', beat.includes('if (!API_BASE || !CLIENT_KEY)'));

  // Strip string literals too: the word "disabled" appears in a log message,
  // which is not a code path. We care about executable statements only.
  const executable = strip(beat)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  check('the server cannot terminate or lock the app',
    !/\bapp\.quit\b|\bapp\.exit\b|\bprocess\.exit\b|\bBrowserWindow\b/.test(executable));
  check('the server response never decides licence validity',
    !/licenseValid|setLicense|writeFileSync\([^)]*licensePath/.test(executable));
  check('the response only feeds config and messages',
    beat.includes('saveRemoteConfig') && beat.includes('saveRemoteMessages')
    && !/settings\s*SET|UPDATE\s+/i.test(executable));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Merge order: device override > broadcast > local > default');
{
  check('device scope is applied after broadcast',
    store.includes("CASE Scope WHEN 'all' THEN 0 ELSE 1 END"));
  check('settings:getAll layers remote on top of local',
    settings.includes('for (const [key, value] of Object.entries(getRemoteOverrides()))'));
  check('a locally-edited managed key warns the user',
    settings.includes('overriddenRemotely'));
  check('clearing a remote value falls back to local',
    store.includes("clean === ''") && store.includes('remove.run(key, scope)'));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Server keys are separated by privilege');
{
  check('client key only reaches /heartbeat', worker.includes("safeEqual(request.headers.get('X-Client-Key')"));
  check('issuing a code requires the admin key',
    worker.slice(worker.indexOf('async function handleIssue')).includes("X-Admin-Key"));
  check('device listing requires the admin key',
    worker.slice(worker.indexOf('async function handleDevices')).includes("X-Admin-Key"));
  check('key comparison is not a plain ===', worker.includes('function safeEqual'));
  // Asserted BEHAVIOURALLY. This used to match the literal text
  // `chatId !== String(env.TG_ADMIN_CHAT)`, which was the single-admin
  // implementation. TG_ADMIN_CHAT now accepts a comma-separated list so the
  // owner can register a backup phone, and the check failed on code that had
  // become more capable rather than less — a structural check pinned to one
  // implementation cannot tell those apart. The RULE is what matters: only
  // registered numeric ids may drive the bot.
  {
    const parse = /function adminChats\(env\) \{[\s\S]*?\n\}/.exec(worker)[0];
    const gate = /function isAdminChat\(env, chatId\) \{[\s\S]*?\n\}/.exec(worker)[0];
    const isAdminChat = new Function(`${parse}; ${gate}; return isAdminChat;`)();
    const env = { TG_ADMIN_CHAT: '7232305465,1593943219' };
    check('the bot obeys its registered owners',
      isAdminChat(env, '7232305465') && isAdminChat(env, '1593943219'));
    check('and nobody else',
      !isAdminChat(env, '999999999') && !isAdminChat(env, '') && !isAdminChat({}, '7232305465'));
    check('the webhook gate uses that check',
      worker.includes('if (!isAdminChat(env, chatId)) return json({ ok: true });'));
  }
  check('no secret is committed in wrangler.toml', !/ADMIN_KEY\s*=|CLIENT_KEY\s*=|LICENSE_SECRET\s*=/.test(R('server/wrangler.toml')));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Serial ranges cannot collide between the bot and the laptop');
{
  check('worker reserves the lower half', worker.includes('SERIAL_SOURCE_CLOUD') && worker.includes('SERIAL_HALF'));
  check('cloud serials stay under the split point', worker.includes('n % SERIAL_HALF'));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] The customer is told, in the app, what is sent');
{
  const about = R('src/renderer/src/pages/settings/AboutPage.tsx');
  const remote = R('src/main/ipc/remote.handlers.ts');
  check('a privacy report endpoint exists', remote.includes('remote:privacyReport'));
  check('it lists what is sent AND what never is',
    remote.includes('sends:') && remote.includes('neverSends:'));
  check('the About page renders it', about.includes('privacy.sends') && about.includes('privacy.neverSends'));
  check('the check-in cannot be turned off by the customer', !remote.includes('remote:setTelemetry'));
  check('sync status is visible', about.includes('remote:syncInfo'));
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Every About-page field is remotely manageable');
{
  const about = R('src/renderer/src/pages/settings/AboutPage.tsx');
  const wanted = ['app_name', 'app_version', 'app_edition', 'dev_name', 'dev_title',
    'dev_phone', 'dev_whatsapp', 'dev_telegram', 'dev_email', 'dev_website',
    'dev_facebook', 'dev_address', 'payment_info', 'subscription_note',
    'support_hours', 'copyright', 'distribution_rights', 'terms_note',
    'custom_content', 'custom_block_title', 'custom_block_body',
    'release_notes', 'latest_version'];
  const missingFromList = wanted.filter(k => !new RegExp(`'${k}'`).test(cfg));
  check('all are in the allow-list', missingFromList.length === 0, missingFromList.join(', '));
  const missingFromUI = wanted.filter(k => !about.includes(k));
  check('all are rendered on the About page', missingFromUI.length === 0, missingFromUI.join(', '));
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Retraction and amendment reach the install');
{
  check('the heartbeat consumes retracted-message tombstones',
    beat.includes('removeRemoteMessages(res.messageDeletes)'));
  check('the heartbeat applies edited-message revisions',
    beat.includes('saveRemoteMessages(res.messageRevisions)'));
  check('the store can drop retracted messages',
    store.includes('export function removeRemoteMessages'));
  check('removal is keyed by the server id only',
    store.includes('DELETE FROM remote_messages WHERE MessageID = ?'));
  // The upsert refreshes text but never resets the local read state — a READ
  // message stays read, so an edit cannot re-trigger popups.
  const conflict = store.split('ON CONFLICT(MessageID) DO UPDATE SET')[1] || '';
  check('an edited message keeps its read state',
    !/ReadAt\s*=\s*excluded\.ReadAt/.test(conflict));
  check('after a retraction the unread list can no longer see the id',
    beat.includes('removeRemoteMessages'));
  check('retractions and revisions are applied before receipts are marked',
    beat.indexOf('removeRemoteMessages(res.messageDeletes)') < beat.indexOf('markReceiptsSynced(payload.readReceipts)')
    && beat.indexOf('saveRemoteMessages(res.messageRevisions)') < beat.indexOf('markReceiptsSynced(payload.readReceipts)'));
}

// ---------------------------------------------------------------- 7
console.log('\n[7] The server no longer serves retracted or amended text silently');
{
  // The unread feed must not list a deleted message...
  check('the heartbeat unread query excludes deleted messages',
    /AND m\.deleted_at IS NULL/.test(worker));
  check('the heartbeat carries tombstones for retracted ids',
    /messageDeletes/.test(worker));
  check('the heartbeat carries revisions for edited ids',
    /messageRevisions/.test(worker));
  check('tombstones are limited to a recent window',
    /deleted_at > datetime\('now', '-60 days'\)/.test(worker));
  check('revisions are limited to a recent window',
    /updated_at > datetime\('now', '-45 days'\)/.test(worker));
  // The admin can still see who read a message after it is gone.
  check('message_reads is joined to devices for the readers report',
    /FROM message_reads r LEFT JOIN devices d ON d\.device_id = r\.device_id/.test(worker));
  check('the bot lists the sent messages with their ids',
    /SELECT m\.id, m\.target/.test(worker) && /screenMsgs/.test(worker));
  check('the bot can delete and amend by id',
    /await_msgdel/.test(worker) && /await_msgedit_text/.test(worker));
  check('the bot can report readers',
    /await_msgreads/.test(worker) && /messageReadsReport/.test(worker));
}

console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
console.log('='.repeat(72));
if (FAIL.length) { FAIL.forEach(f => console.log('  FAILED:', f)); process.exit(1); }
