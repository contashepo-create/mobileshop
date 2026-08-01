#!/usr/bin/env node
/**
 * PHONE VERIFICATION VIA TELEGRAM — audit point 15.
 *
 * The bot asks the owner to tap a `request_contact` button, and TELEGRAM
 * supplies the number attached to their account. The user never types it, so
 * this inherits the SMS verification Telegram performed when the account was
 * created — at no cost.
 *
 * THE TRAP THIS SUITE EXISTS FOR
 * ------------------------------
 * A user can share ANY contact from their address book. The bot receives an
 * identical-looking `contact` object either way. The only difference is
 * `contact.user_id`, which equals `from.id` only when the contact IS the
 * sender.
 *
 * Omit that comparison and the feature verifies NOTHING: a shop could confirm
 * any number belonging to anyone in their contacts. Section [1] is therefore
 * the heart of this file.
 *
 * Run with:  node --experimental-strip-types scripts/verify_phone_verify.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  export async function resolve(s, c, n) {
    if (s.startsWith('.') && !/\\.[a-z]+$/.test(s)) {
      const u = new URL(s + '.ts', c.parentURL || import.meta.url).href;
      if (existsSync(fileURLToPath(u))) return { url: u, shortCircuit: true };
    }
    return n(s, c);
  }
`), import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

function code(file) {
  return readFileSync(join(ROOT, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('='.repeat(72));
console.log('PHONE VERIFICATION VIA TELEGRAM');
console.log('='.repeat(72));

const P = await import('../src/main/security/phoneVerify.ts');

const BOT = { botToken: '8877684899:AAHTZfkM_MPlD2ZiR1CJ8qiKRXzFrHnRmdo', chatId: '7232305465' };

// ---------------------------------------------------------------- 1
console.log('\n[1] Only the sender OWN contact is accepted');
{
  const me = { id: 7232305465 };

  t('my own contact is accepted',
    P.matchesSender({ phone_number: '+201012345678', user_id: 7232305465 }, me) === true);

  // THE attack: share a friend's contact card instead of your own.
  t('somebody else Telegram contact is REFUSED',
    P.matchesSender({ phone_number: '+201099999999', user_id: 111222333 }, me) === false);

  // A manually-typed address-book entry has no user_id at all. It proves
  // nothing — anyone can type any number into their own contacts.
  t('a contact with no user_id is REFUSED',
    P.matchesSender({ phone_number: '+201012345678' }, me) === false);
  t('an explicitly null user_id is REFUSED',
    P.matchesSender({ phone_number: '+201012345678', user_id: null }, me) === false);

  t('a contact with no phone number is refused',
    P.matchesSender({ user_id: 7232305465 }, me) === false);
  for (const junk of [null, undefined, {}, 'string', 42]) {
    if (P.matchesSender(junk, me) !== false) t(`junk ${JSON.stringify(junk)} refused`, false);
    if (P.matchesSender({ phone_number: '+2010', user_id: 1 }, junk) !== false) {
      t(`junk sender ${JSON.stringify(junk)} refused`, false);
    }
  }
  t('every malformed shape is refused without throwing', true);

  // Telegram sends numeric ids; a string must still compare correctly rather
  // than failing a strict equality and rejecting a legitimate owner.
  t('a string user_id still matches the same numeric sender',
    P.matchesSender({ phone_number: '+201012345678', user_id: '7232305465' }, me) === true);
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Numbers are compared by value, not by spelling');
{
  // Telegram may return any of these depending on how the account was
  // registered, and the shop may have typed any of them. Comparing raw strings
  // would reject a correct match and look like a bug to the owner.
  const forms = ['+201012345678', '201012345678', '01012345678', '010 1234 5678', '0101-234-5678'];
  const normalised = forms.map(P.normalisePhone);
  t('every Egyptian form normalises to the same value',
    new Set(normalised).size === 1, normalised.join(' | '));
  t('and that value is the international form', normalised[0] === '201012345678');

  t('a different number does NOT collide',
    P.normalisePhone('01099999999') !== P.normalisePhone('01012345678'));
  t('empty input yields empty, not a false match', P.normalisePhone('') === '');
  t('junk yields empty', P.normalisePhone(null) === '' && P.normalisePhone(undefined) === '');
}

// ---------------------------------------------------------------- 3
console.log('\n[3] The flow refuses to run unconfigured, and cannot hang');
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be touched'); };
  try {
    const r = await P.verifyPhoneViaTelegram(null, '01012345678');
    t('an unconfigured bot is refused', r.success === false);
    t('and it points at the settings screen', /الإعدادات/.test(r.message), r.message);
    t('without touching the network', calls === 0);

    const noPhone = await P.verifyPhoneViaTelegram(BOT, '');
    t('an empty phone number is refused before any request', noPhone.success === false);
  } finally {
    globalThis.fetch = realFetch;
  }

  const src = code('src/main/security/phoneVerify.ts');
  t('the wait is bounded by a deadline', /VERIFY_WINDOW_MS/.test(src) && /deadline/.test(src));
  t('the window is five minutes', P.VERIFY_WINDOW_MS === 5 * 60 * 1000);
  t('every network call has its own timeout', /AbortController/.test(src) && /timeoutMs/.test(src));
  t('the keyboard is removed when the flow ends',
    (src.match(/remove_keyboard/g) || []).length >= 3);
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Only a fresh tap counts, and only from the shop chat');
{
  const src = code('src/main/security/phoneVerify.ts');

  // A contact already sitting in the update queue must not satisfy a request
  // made afterwards, or the verification could be replayed from history.
  t('polling starts after the current update id',
    /offset = Number\(seed\.result\[seed\.result\.length - 1\]\.update_id\) \+ 1/.test(src));
  t('the offset advances so an update is consumed once',
    /offset = Number\(u\.update_id\) \+ 1/.test(src));
  t('a reply from a different chat is ignored',
    /msg\.chat\?\.id.*!== target\.chatId/.test(src.replace(/\s+/g, ' ')));

  t('the shared number must match what the shop typed',
    /if \(got !== want\)/.test(src));
  t('a mismatch is reported rather than silently accepted',
    /لا يطابق/.test(src));
}

// ---------------------------------------------------------------- 4b
console.log('\n[4b] The polling loop really applies the sender check');
{
  // Testing matchesSender() directly proves the RULE. It does not prove the
  // loop CALLS it — and deleting that call is the whole attack. A mutant that
  // replaced `if (!matchesSender(...))` with `if (false)` survived until this
  // section existed, leaving a build that would confirm any contact shared
  // from the address book.
  //
  // So the real flow is driven against a stubbed Telegram that shares somebody
  // else's card.
  const realFetch = globalThis.fetch;

  const runFlow = (contact, from) => {
    let updateServed = false;
    globalThis.fetch = async (url, opts) => {
      const method = String(url).split('/').pop();
      const body = JSON.parse(opts?.body || '{}');
      if (method === 'getUpdates') {
        // First call seeds the offset; the next serves the shared contact once.
        if (body.limit === 1) return { json: async () => ({ ok: true, result: [] }) };
        if (updateServed) return { json: async () => ({ ok: true, result: [] }) };
        updateServed = true;
        return {
          json: async () => ({
            ok: true,
            result: [{ update_id: 10, message: { chat: { id: 7232305465 }, from, contact } }],
          }),
        };
      }
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };
    return P.verifyPhoneViaTelegram(BOT, '01012345678');
  };

  try {
    const mine = { phone_number: '+201012345678', user_id: 7232305465 };
    const theirs = { phone_number: '+201012345678', user_id: 111222333 };
    const sender = { id: 7232305465 };

    const ok = await runFlow(mine, sender);
    t('sharing my OWN contact verifies the number',
      ok.success === true && ok.phone === '201012345678', JSON.stringify(ok));

    const bad = await runFlow(theirs, sender);
    t('sharing SOMEBODY ELSE contact is refused by the flow itself',
      bad.success === false, JSON.stringify(bad));
    t('and the refusal says why', /رقمك أنت/.test(bad.message), bad.message);

    // Same number, but pasted as a plain address-book entry with no Telegram
    // account behind it. It proves nothing and must not pass.
    const typed = await runFlow({ phone_number: '+201012345678' }, sender);
    t('a contact with no Telegram account behind it is refused',
      typed.success === false, JSON.stringify(typed));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Wired in, honest, and optional');
{
  const s = code('src/main/ipc/settings.handlers.ts');
  const guard = code('src/main/security/ipcGuard.ts');
  const wiz = code('src/renderer/src/pages/setup/FirstRunWizard.tsx');

  t('a phone:verify channel exists', /phone:verify/.test(s));
  t('it is reachable during first-run setup', /PUBLIC_CHANNELS[\s\S]{0,2400}'phone:verify'/.test(guard));
  t('it uses the SHOP bot, never the developer one', /shopTelegram\(\)/.test(s));
  t('a confirmed number is recorded', /'phone_verified'/.test(s) && /'phone_verified_at'/.test(s));
  t('nothing is recorded when verification fails',
    /if \(result\.success\) \{[\s\S]{0,400}phone_verified/.test(s));

  t('the wizard offers the button', /phone:verify/.test(wiz));
  t('it is marked optional, so a shop with no bot can still finish',
    /اختياري/.test(wiz));
  t('editing the number clears the confirmation',
    /setPhoneVerified\(false\)/.test(wiz));

  // Honesty: this proves control of a Telegram account registered to the
  // number, not that the SIM is in the owner hand today.
  t('the limitation is documented rather than overstated',
    /does NOT prove the SIM/.test(readFileSync(join(ROOT, 'src/main/security/phoneVerify.ts'), 'utf-8')));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
