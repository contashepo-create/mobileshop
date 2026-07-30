#!/usr/bin/env node
/**
 * USERS, ROLES AND THE FISCAL YEAR — the gate on everything else.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other suite in this project checks that money is calculated correctly.
 * This one checks that the shop can still get IN to its own books, and that
 * only the right people can.
 *
 * That is not a lesser concern. A wrong balance is discovered and corrected; a
 * shop locked out of its own system on a Friday afternoon cannot trade at all,
 * and the only route back is editing the database file by hand.
 *
 * MEASURED BEFORE THE FIXES IN THIS ROUND
 * ---------------------------------------
 *   users:delete on the ONLY administrator  -> { success: true }, zero
 *                                              administrators left
 *   users:update demoting that same account -> same result by another route
 *   users:create with an EMPTY password     -> accepted
 *
 * The empty password is not an authentication bypass — `auth:login` refuses a
 * blank password, so the account simply cannot be used. The real damage is
 * quieter: a user is created, appears in every dropdown, and can never sign
 * in, with nobody told why. The first-run wizard already demanded six
 * characters; the users screen demanded nothing. One rule, two enforcement
 * points, disagreeing.
 *
 * Run with:  node --experimental-strip-types scripts/verify_users_access.mjs
 */
import { buildDatabase, loadHandlers, currentDb, handlers } from './lib/handlerHarness.mjs';

await loadHandlers();

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log('        ' + detail);
};
const q = (sql, ...a) => currentDb().prepare(sql).get(...a);
/** These handlers take positional ids, so they are invoked directly. */
const raw = (channel, ...args) => handlers.get(channel)({ sender: { id: 1 } }, ...args);

const ADMIN_ROLE = 1;

function seed({ admins = 1 } = {}) {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'مدير عام',1)");
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(2,'بائع',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'admin','x',1,1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(2,'seller','y',2,1)");
  if (admins > 1) {
    db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(3,'admin2','z',1,1)");
  }
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'2026','2026-01-01','2026-12-31','open')");
  return db;
}
const activeAdmins = () =>
  q('SELECT COUNT(*) v FROM users WHERE RoleID = ? AND IsActive = 1', ADMIN_ROLE).v;

console.log('USERS AND ACCESS — the shop must never be locked out of its own books\n');

// ---------------------------------------------------------------- 1
console.log('[1] The last administrator cannot be removed');
{
  seed();
  const res = await raw('users:delete', 1);
  t('deactivating the only administrator is refused',
    res?.success === false && activeAdmins() === 1,
    `${activeAdmins()} left — ${JSON.stringify(res).slice(0, 70)}`);
}
{
  seed();
  const res = await raw('users:update', 1, { username: 'admin', roleId: 2, isActive: 1 });
  t('demoting the only administrator is refused by the same rule',
    res?.success === false && activeAdmins() === 1,
    `${activeAdmins()} left — the edit route must be guarded as well as the delete`);
}
{
  seed();
  const res = await raw('users:update', 1, { username: 'admin', roleId: 1, isActive: 0 });
  t('switching the only administrator inactive is refused',
    res?.success === false && activeAdmins() === 1, `${activeAdmins()} left`);
}
{
  // The guard must not over-reach: with a spare administrator this is a
  // perfectly normal thing to do.
  seed({ admins: 2 });
  const res = await raw('users:delete', 1);
  t('but with TWO administrators, removing one is allowed',
    res?.success === true && activeAdmins() === 1,
    `${activeAdmins()} left — refusing this would be its own bug`);
}
{
  seed({ admins: 2 });
  const res = await raw('users:delete', 2);   // a salesperson
  t('and an ordinary user can always be removed', res?.success === true);
}
{
  seed();
  const res = await raw('users:delete', 9999);
  t('removing a user who does not exist is refused, not silently ignored',
    res?.success === false, JSON.stringify(res).slice(0, 60));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] A password must be usable');
{
  seed();
  for (const [label, pw] of [
    ['empty', ''],
    ['whitespace only', '   '],
    ['too short', 'abc'],
    ['not a string', 12345],
  ]) {
    const res = await raw('users:create', { username: `u_${label}`, password: pw, roleId: 2 });
    t(`a password that is ${label} is refused`, res?.success === false,
      JSON.stringify(res).slice(0, 65));
  }
  t('and none of those users were created',
    q("SELECT COUNT(*) v FROM users WHERE Username LIKE 'u_%'").v === 0);
}
{
  seed();
  const res = await raw('users:create', { username: 'good', password: 'abc123', roleId: 2 });
  t('a six-character password IS accepted', res?.success === true,
    JSON.stringify(res).slice(0, 60));
  t('and the password is stored hashed, never in clear',
    !String(q("SELECT PasswordHash v FROM users WHERE Username='good'").v).includes('abc123'));
}
{
  seed();
  const res = await raw('users:update', 2, { username: 'seller', roleId: 2, isActive: 1 });
  t('editing a user WITHOUT changing the password is allowed',
    res?.success === true,
    'a blank password field on an edit means "keep the current one"');
}
{
  seed();
  const res = await raw('users:update', 2, { username: 'seller', password: 'ab', roleId: 2, isActive: 1 });
  t('but supplying a weak NEW password on an edit is refused',
    res?.success === false, JSON.stringify(res).slice(0, 65));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] Identity is unique and cannot be blank');
{
  seed();
  const res = await raw('users:create', { username: 'admin', password: 'abc123', roleId: 2 });
  t('a duplicate username is refused',
    res?.success === false && q("SELECT COUNT(*) v FROM users WHERE Username='admin'").v === 1,
    JSON.stringify(res).slice(0, 60));
}
{
  seed();
  for (const bad of ['', '   ', null]) {
    const res = await raw('users:create', { username: bad, password: 'abc123', roleId: 2 });
    t(`a username of ${JSON.stringify(bad)} is refused`, res?.success === false,
      JSON.stringify(res).slice(0, 60));
  }
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Deleting a role must not orphan the users who hold it');
{
  seed();
  await raw('roles:delete', 2);
  const orphans = q(
    'SELECT COUNT(*) v FROM users u WHERE u.RoleID IS NOT NULL '
    + 'AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.RoleID = u.RoleID)').v;
  t('no user is left pointing at a role that no longer exists', orphans === 0,
    `${orphans} orphaned users — they would have no permissions at all`);
}

// ---------------------------------------------------------------- 5
console.log('\n[5] The fiscal year gates what can be posted');
{
  seed();
  const active = await raw('fiscalYear:getActive');
  t('the open year is found', !!active && active.FiscalYearID === 1,
    JSON.stringify(active).slice(0, 70));
}
{
  seed();
  // Two years both marked open makes "which year does this sale belong to"
  // ambiguous: getActive picks by StartDate DESC LIMIT 1, so postings meant
  // for the old year silently land in the new one.
  const res = await raw('fiscalYear:create', {
    YearName: '2027', StartDate: '2027-01-01', EndDate: '2027-12-31',
  });
  t('opening a second year while one is still open is refused',
    res?.success === false, JSON.stringify(res).slice(0, 75));
  t('so exactly one year is ever active',
    q("SELECT COUNT(*) v FROM fiscal_years WHERE Status='open'").v === 1,
    `${q("SELECT COUNT(*) v FROM fiscal_years WHERE Status='open'").v} open years`);
}
{
  seed();
  currentDb().exec("UPDATE fiscal_years SET Status='closed' WHERE FiscalYearID=1");
  const res = await raw('fiscalYear:create', {
    YearName: '2027', StartDate: '2027-01-01', EndDate: '2027-12-31',
  });
  t('but once the old year is closed, the new one opens normally',
    res?.success === true, JSON.stringify(res).slice(0, 60));
}
{
  seed();
  currentDb().exec("UPDATE fiscal_years SET Status='closed' WHERE FiscalYearID=1");
  const bad = await raw('fiscalYear:create', {
    YearName: '2027', StartDate: '2027-12-31', EndDate: '2027-01-01',
  });
  t('a year that ends before it begins is refused', bad?.success === false,
    JSON.stringify(bad).slice(0, 65));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
