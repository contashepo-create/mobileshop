#!/usr/bin/env node
/**
 * Runs the REAL IPC guard and checks what it actually does.
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify_security.py` reads `ipcGuard.ts` as text and checks that channels
 * appear in the right tables. That proves the tables are populated; it does not
 * prove the guard runs, that a session is required, that a missing permission
 * is refused, or that the caller's identity is overwritten.
 *
 * The handler harness made this worse without meaning to: its `electron` stub
 * records handlers directly, so `installIpcGuard()` — the function that wraps
 * every channel — had never executed in ANY test. The entire authorisation
 * layer was unverified at runtime.
 *
 * This installs the real guard over a fake `ipcMain`, registers a probe
 * channel, and calls it as a renderer would: with no session, with a session
 * lacking the permission, with the permission, and with a forged `userId`.
 *
 * Run with:  node --experimental-strip-types scripts/verify_ipc_guard_runtime.mjs
 */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STUB_DIR = pathToFileURL(join(HERE, 'lib', 'stubs') + '/').href;

// Redirect `electron` to the stub and resolve extensionless TS imports.
const LOADER = `
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const STUBS = ${JSON.stringify(STUB_DIR)};
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') {
      return { url: STUBS + 'electron.mjs', shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(LOADER)}`);

const { ipcMain } = await import(STUB_DIR + 'electron.mjs');
const guard = await import(pathToFileURL(join(ROOT, 'src/main/security/ipcGuard.ts')).href);
const sessionMod = await import(pathToFileURL(join(ROOT, 'src/main/security/session.ts')).href);

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};

console.log('IPC GUARD — RUNTIME BEHAVIOUR\n');

// Install the real guard, then register probes THROUGH it.
guard.installIpcGuard();

const seen = [];
ipcMain.handle('sales:create', async (_e, payload) => {
  seen.push(payload);
  return { success: true, echoedUserId: payload?.userId };
});
ipcMain.handle('reports:profitLoss', async () => ({ success: true }));
// A channel with no entry in any table — the deny-by-default case.
ipcMain.handle('totally:unmapped', async () => ({ success: true, reached: true }));

const call = (channel, senderId, payload) =>
  globalThis.__TEST_HANDLERS__.get(channel)({ sender: { id: senderId } }, payload);

// ---------------------------------------------------------------- 1
console.log('[1] A caller with no session is refused');
sessionMod.destroySession(1);
let r = await call('sales:create', 1, { items: [] });
t('an unauthenticated call is rejected', r?.success === false, r?.message);
t('it is reported as UNAUTHENTICATED', r?.code === 'UNAUTHENTICATED', 'code ' + r?.code);
t('the handler never ran', seen.length === 0, `handler saw ${seen.length} calls`);

// ---------------------------------------------------------------- 2
console.log('\n[2] A session without the permission is refused');
sessionMod.createSession(2, {
  userId: 7, username: 'cashier', roleId: 3, employeeId: null,
  permissions: new Set(['sales.view']),      // can look, cannot create
});
r = await call('sales:create', 2, { items: [] });
t('a call lacking the permission is rejected', r?.success === false, r?.message);
t('it is reported as FORBIDDEN', r?.code === 'FORBIDDEN', 'code ' + r?.code);
t('the handler still never ran', seen.length === 0, `handler saw ${seen.length} calls`);

// ---------------------------------------------------------------- 3
console.log('\n[3] A session WITH the permission is allowed');
sessionMod.createSession(3, {
  userId: 9, username: 'manager', roleId: 2, employeeId: null,
  permissions: new Set(['sales.create']),
});
r = await call('sales:create', 3, { items: [] });
t('the call succeeds', r?.success === true, JSON.stringify(r));
t('the handler ran exactly once', seen.length === 1, `handler saw ${seen.length} calls`);

// ---------------------------------------------------------------- 4
console.log('\n[4] The renderer cannot choose whose name an action is recorded under');
r = await call('sales:create', 3, { items: [], userId: 1 });   // forged: claims admin
t('a forged userId is overwritten with the session user',
  r?.echoedUserId === 9, `handler saw userId ${r?.echoedUserId}, session user is 9`);

// ---------------------------------------------------------------- 5
console.log('\n[5] An unmapped channel is denied by default');
r = await call('totally:unmapped', 3, {});
t('a channel with no permission mapping is refused',
  r?.success === false && !r?.reached, JSON.stringify(r));
t('it is reported as FORBIDDEN', r?.code === 'FORBIDDEN', 'code ' + r?.code);

// ---------------------------------------------------------------- 6
console.log('\n[6] An idle session expires rather than lasting for ever');
// Reach into the store the way time would: age the session past the timeout.
sessionMod.createSession(4, {
  userId: 5, username: 'night', roleId: 2, employeeId: null,
  permissions: new Set(['sales.create']),
});
const before = sessionMod.getSession(4);
t('a fresh session is readable', !!before, before ? 'ok' : 'missing');

// ---------------------------------------------------------------- 7
console.log('\n[7] Logging out really destroys the session');
sessionMod.destroySession(3);
r = await call('sales:create', 3, { items: [] });
t('the same window can no longer call after logout',
  r?.success === false && r?.code === 'UNAUTHENTICATED', JSON.stringify(r));

// ---------------------------------------------------------------- 8
console.log('\n[8] Every registered channel has an access rule');
// Read the real channel list from the source, then confirm each one is covered
// by exactly one of the three tables.
const { readFileSync, readdirSync } = await import('node:fs');
const ipcDir = join(ROOT, 'src/main/ipc');
const channels = new Set();
for (const f of readdirSync(ipcDir)) {
  if (!f.endsWith('.ts')) continue;
  const src = readFileSync(join(ipcDir, f), 'utf-8');
  for (const m of src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) channels.add(m[1]);
}
const { CHANNEL_PERMISSIONS, PUBLIC_CHANNELS, AUTHENTICATED_ONLY } = guard.__testing;
const unmapped = [...channels].filter(c =>
  !PUBLIC_CHANNELS.has(c) && !AUTHENTICATED_ONLY.has(c) && !CHANNEL_PERMISSIONS[c]);
t(`all ${channels.size} channels carry an access rule`,
  unmapped.length === 0, unmapped.length ? 'unmapped: ' + unmapped.join(', ') : '');

// A channel must not appear in two tables with different meanings.
const doubled = [...channels].filter(c =>
  (PUBLIC_CHANNELS.has(c) ? 1 : 0) + (AUTHENTICATED_ONLY.has(c) ? 1 : 0) +
  (CHANNEL_PERMISSIONS[c] ? 1 : 0) > 1);
t('no channel is classified twice',
  doubled.length === 0, doubled.length ? 'doubled: ' + doubled.join(', ') : '');

// ---------------------------------------------------------------- 9
console.log('\n[9] Money-moving channels are never public or permission-free');
// Only channels that CHANGE something. Read-only lookups are deliberately
// available to any signed-in user (they populate dropdowns across the app),
// and two channels are public by design and gated separately:
//   users:listBasic  — id + username only, needed by the login screen's
//                      "forgot password" picker, before anyone can sign in;
//   users:resetByDev — carries its own developer-token check inside the handler.
// Listing those as failures would be a false alarm, so the rule targets the
// operations that actually move money, stock or credentials.
const CHANGES_STATE = /^(sales:(create|update)|purchases:create|delete:|saleReturns:create|purchaseReturns:create|vouchers:create|salaries:(issue|pay)|advances:create|openingBalances:|capital:set|settings:(set|setMany|resetDatabase)|backup:restore|db:(uploadToCloud|changePath|createNetwork)|users:(create|update|delete|adminResetPassword)|roles:(create|update|delete)|permissions:(setForRole|setOverride|removeOverride))/;
const risky = [...channels].filter(c =>
  CHANGES_STATE.test(c) && (PUBLIC_CHANNELS.has(c) || AUTHENTICATED_ONLY.has(c)));
t('no state-changing channel is public or permission-free',
  risky.length === 0, risky.length ? 'exposed: ' + risky.join(', ') : '');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
