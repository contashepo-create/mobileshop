#!/usr/bin/env node
/**
 * SERVER-SIDE VALIDATION — does the backend refuse what the screens refuse?
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * An audit compared the guards in the React pages against the guards in the
 * IPC handlers. 106 client-side checks were counted across the screens; the
 * matching check in the main process was usually missing entirely. The
 * renderer is not a security boundary — everything it can call is reachable
 * from the DevTools console on the shop's own machine, and, because
 * `window.open` children inherit the preload bundle, from injected markup in a
 * printed statement.
 *
 * Every case below was MEASURED against the real handlers before it was fixed.
 * These are not hypotheses:
 *
 *   vouchers:create        VoucherType 'RECEIPT' (capitals) took 5,000 OUT of
 *                          the safe while the document read as money coming
 *                          in, and matched neither `= 'receipt'` nor
 *                          `= 'payment'`, so no report could see it.
 *   maintenance:updateStatus
 *                          accepted 'delivered', which permanently blocked
 *                          `maintenance:deliver` — the only handler that
 *                          bills. 800 EGP of completed work, unbillable.
 *   customers:create       stored '', '        ' and a 5,000,000-character
 *                          name.
 *   customers:updateStatus stored 'GOD_MODE'; the credit block tests for
 *                          'suspended', so an unknown status is never blocked.
 *   settings:set           wrote db_path, cloud_api_key, telegram_bot_token,
 *                          setup_completed and owner_capital — all of which
 *                          `settings:get` already refuses to READ.
 *   users:create           'kareem', 'kareem ' and 'KAREEM' coexisted as three
 *                          accounts a human cannot tell apart.
 *   employees:create       stored BaseSalary -99999 and HireDate 'not-a-date'.
 *   items:list search      '%' returned the whole catalogue past every filter;
 *                          60,000 characters made SQLite itself throw.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT
 * --------------------------------
 * It calls the REAL handlers through the shared harness and asserts on what
 * lands in the DATABASE, never on the text of the source. A suite that greps
 * for `requireText(` proves a line exists; only executing the handler proves
 * the value is refused. Every negative case is paired with a positive one, so
 * a fix that simply rejects everything fails here too — a validator that
 * breaks the shop is not a fix.
 *
 * Run:  node --experimental-strip-types scripts/verify_server_side_validation.mjs
 */
import { buildDatabase, loadHandlers, call } from './lib/handlerHarness.mjs';

let checks = 0;
const failures = [];

function ok(label, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
}

/** The handler refused, and nothing was written. */
function refused(label, reply, detail = '') {
  ok(label, reply && reply.success === false, `${detail} got ${JSON.stringify(reply).slice(0, 120)}`);
}

/** The handler accepted — used to prove the validator did not break the shop. */
function accepted(label, reply, detail = '') {
  ok(label, reply && reply.success !== false, `${detail} got ${JSON.stringify(reply).slice(0, 120)}`);
}

const db = buildDatabase();
await loadHandlers();

// Seed the rows the money handlers need. Written directly rather than through
// the handlers so a validation bug in one section cannot make another section
// look clean by never getting off the ground.
db.prepare("INSERT INTO roles (RoleID, RoleName, IsSystem) VALUES (1, 'مدير', 1)").run();
db.prepare("INSERT INTO users (UserID, Username, PasswordHash, RoleID, IsActive) VALUES (1, 'admin', 'x', 1, 1)").run();
db.prepare("INSERT INTO fiscal_years (FiscalYearID, YearName, StartDate, EndDate, Status) VALUES (1, '2026', '2026-01-01', '2026-12-31', 'open')").run();
db.prepare("INSERT INTO permissions (PermissionID, PermissionKey, PermissionName, Module) VALUES (1, 'sales.create', 'بيع', 'sales')").run();

await call('cashAccounts:create', {
  AccountName: 'الخزينة', AccountType: 'safe', Balance: 100000,
  BankName: null, AccountNumber: null,
});

// ===========================================================================
console.log('\n── 1. vouchers:create — the type decides which way money moves ──');
// ===========================================================================
{
  await call('customers:create', { Name: 'عميل الاختبار', Phone: '0100', Email: '', Address: '', CreditLimit: null });

  const cashBefore = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;

  // The exact payload that emptied the till.
  const r = await call('vouchers:create', {
    VoucherType: 'RECEIPT', PartyType: 'general', Description: 'سند',
    CashAccountID: 1, Amount: 5000, userId: 1, fiscalYearId: 1,
  });
  refused('VoucherType "RECEIPT" (wrong case) is refused', r);

  const cashAfter = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  ok('…and the till did not move', cashBefore === cashAfter, `${cashBefore} -> ${cashAfter}`);
  ok('…and no voucher row was written',
    db.prepare('SELECT COUNT(*) c FROM vouchers').get().c === 0);

  refused('VoucherType "MAGIC" is refused', await call('vouchers:create', {
    VoucherType: 'MAGIC', PartyType: 'general', Description: 'x',
    CashAccountID: 1, Amount: 10, userId: 1, fiscalYearId: 1,
  }));
  refused('VoucherType "" is refused', await call('vouchers:create', {
    VoucherType: '', PartyType: 'general', Description: 'x',
    CashAccountID: 1, Amount: 10, userId: 1, fiscalYearId: 1,
  }));
  refused('PartyType "ALIEN" is refused', await call('vouchers:create', {
    VoucherType: 'receipt', PartyType: 'ALIEN', Description: 'x',
    CashAccountID: 1, Amount: 10, userId: 1, fiscalYearId: 1,
  }));
  refused('Description of 1,000,000 chars is refused', await call('vouchers:create', {
    VoucherType: 'receipt', PartyType: 'general', Description: 'D'.repeat(1000000),
    CashAccountID: 1, Amount: 10, userId: 1, fiscalYearId: 1,
  }));
  refused('Empty Description is refused', await call('vouchers:create', {
    VoucherType: 'receipt', PartyType: 'general', Description: '',
    CashAccountID: 1, Amount: 10, userId: 1, fiscalYearId: 1,
  }));

  // THE OTHER HALF: a real voucher must still work, and must move the money
  // in the direction the type names.
  accepted('a real receipt is accepted', await call('vouchers:create', {
    VoucherType: 'receipt', PartyType: 'customer', PartyID: 1, Description: 'دفعة من العميل',
    CashAccountID: 1, Amount: 500, userId: 1, fiscalYearId: 1,
  }));
  const afterReceipt = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  ok('…and a receipt ADDS to the till', afterReceipt === cashBefore + 500, `${cashBefore} -> ${afterReceipt}`);

  accepted('a real payment is accepted', await call('vouchers:create', {
    VoucherType: 'payment', PartyType: 'general', Description: 'فاتورة كهرباء',
    CashAccountID: 1, Amount: 200, userId: 1, fiscalYearId: 1,
  }));
  const afterPayment = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  ok('…and a payment SUBTRACTS from the till', afterPayment === afterReceipt - 200, `${afterReceipt} -> ${afterPayment}`);

  // The whole point of the allow-list: every stored voucher is visible to the
  // reports, which filter on these two exact strings.
  const total = db.prepare('SELECT COUNT(*) c FROM vouchers').get().c;
  const visible = db.prepare(
    "SELECT COUNT(*) c FROM vouchers WHERE VoucherType IN ('receipt','payment')").get().c;
  ok('every stored voucher is visible to the reports', total === visible, `${visible} of ${total}`);
}

// ===========================================================================
console.log('── 2. maintenance:updateStatus — terminal states need their own handler ──');
// ===========================================================================
{
  const t = await call('maintenance:receive', {
    CustomerID: 1, CustomerName: 'عميل الاختبار', CustomerPhone: '0100',
    DeviceModel: 'iPhone 13', ProblemDesc: 'الشاشة مكسورة',
    AgreedCost: 800, userId: 1, fiscalYearId: 1,
  });
  ok('maintenance:receive works', t && t.success !== false, JSON.stringify(t).slice(0, 80));

  refused('status "delivered" is refused here', await call('maintenance:updateStatus', t.ticketId, 'delivered', 'ملاحظة', 1));
  refused('status "cancelled" is refused here', await call('maintenance:updateStatus', t.ticketId, 'cancelled', 'ملاحظة', 1));
  refused('status "returned" is refused here', await call('maintenance:updateStatus', t.ticketId, 'returned', 'ملاحظة', 1));
  refused('status "ANYTHING" is refused', await call('maintenance:updateStatus', t.ticketId, 'ANYTHING', 'ملاحظة', 1));
  refused('status "" is refused', await call('maintenance:updateStatus', t.ticketId, '', 'ملاحظة', 1));
  refused('empty notes still refused', await call('maintenance:updateStatus', t.ticketId, 'ready', '', 1));

  ok('the ticket is still in its original state',
    db.prepare('SELECT Status FROM maintenance_tickets WHERE TicketID = ?').get(t.ticketId).Status === 'received');

  // The workshop states must all still work — this is the technician's daily
  // path and breaking it would be worse than the bug.
  for (const s of ['inspecting', 'in_progress', 'ready']) {
    accepted(`workflow status "${s}" is accepted`, await call('maintenance:updateStatus', t.ticketId, s, 'تقدم العمل', 1));
  }

  // And the real delivery — the one that bills — must succeed.
  const cashBefore = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  const d = await call('maintenance:deliver', {
    TicketID: t.ticketId, CustomerID: 1, CustomerName: 'عميل الاختبار',
    LaborCost: 800, PaymentMethod: 'cash', PaidAmount: 800,
    CashAccountID: 1, userId: 1, fiscalYearId: 1,
  });
  accepted('maintenance:deliver still bills the customer', d);
  const cashAfter = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = 1').get().Balance;
  ok('…and the 800 reached the till', cashAfter === cashBefore + 800, `${cashBefore} -> ${cashAfter}`);
  ok('…and a delivery was recorded',
    db.prepare('SELECT COUNT(*) c FROM maintenance_deliveries').get().c === 1);

  // A delivered ticket may not be dragged back into the workshop, or it could
  // be delivered — and billed — a second time.
  refused('a delivered ticket cannot be reopened',
    await call('maintenance:updateStatus', t.ticketId, 'in_progress', 'محاولة', 1));
}

// ===========================================================================
console.log('── 3. party master data — names, statuses, limits ──');
// ===========================================================================
{
  refused('customers:create with empty name', await call('customers:create', { Name: '', Phone: '', Email: '', Address: '', CreditLimit: null }));
  refused('customers:create with whitespace-only name', await call('customers:create', { Name: '        ', Phone: '', Email: '', Address: '', CreditLimit: null }));
  refused('customers:create with a 5,000,000-char name', await call('customers:create', { Name: 'ح'.repeat(5000000), Phone: '', Email: '', Address: '', CreditLimit: null }));
  refused('customers:create with a negative credit limit', await call('customers:create', { Name: 'x', Phone: '', Email: '', Address: '', CreditLimit: -1 }));
  refused('customers:create with an object as the name', await call('customers:create', { Name: { toString: () => 'x' }, Phone: '', Email: '', Address: '', CreditLimit: null }));

  const good = await call('customers:create', {
    Name: '  محمد   عبده  ', Phone: '01001234567', Email: 'a@b.c',
    Address: 'المنصورة، الدقهلية', CreditLimit: 5000,
  });
  accepted('a real customer is still accepted', good);
  const stored = db.prepare('SELECT Name FROM customers WHERE CustomerID = ?').get(good.id).Name;
  ok('…and the name is trimmed and space-collapsed', stored === 'محمد عبده', JSON.stringify(stored));

  refused('customers:updateStatus "GOD_MODE"', await call('customers:updateStatus', good.id, 'GOD_MODE'));
  accepted('customers:updateStatus "suspended"', await call('customers:updateStatus', good.id, 'suspended'));
  refused('customers:updateStatus on a customer that does not exist', await call('customers:updateStatus', 999999, 'active'));

  // Forged identifiers. Every one of these coerces to 1 in plain JavaScript,
  // and two of them MEASURABLY renamed customer 1 before `requireId` stopped
  // coercing. Checked through the real handler, and the real row is compared
  // afterwards — a rejection that still wrote would pass a message-only check.
  const realName = db.prepare('SELECT Name FROM customers WHERE CustomerID = ?').get(good.id).Name;
  for (const forged of ['1 OR 1=1', '1; DELETE FROM customers', { toString: () => String(good.id) },
    [good.id], `${good.id}.0`, ` ${good.id} `, true, 1e20, -1]) {
    let reply;
    try {
      reply = await call('customers:update', forged, {
        Name: 'مُخترق', Phone: '', Email: '', Address: '', Status: 'active', CreditLimit: null,
      });
    } catch { reply = { success: false }; }
    ok(`a forged id ${JSON.stringify(forged)} is refused`, reply && reply.success === false,
      JSON.stringify(reply).slice(0, 60));
  }
  ok('…and the real customer was never renamed',
    db.prepare('SELECT Name FROM customers WHERE CustomerID = ?').get(good.id).Name === realName);
  ok('…and no customer was deleted',
    db.prepare('SELECT COUNT(*) c FROM customers').get().c > 0);
  refused('customers:update on a customer that does not exist', await call('customers:update', 999999, { Name: 'x', Phone: '', Email: '', Address: '', Status: 'active', CreditLimit: null }));

  refused('suppliers:create with empty name', await call('suppliers:create', { Name: '', Phone: '', Email: '', Address: '', CreditLimit: null }));
  refused('suppliers:updateStatus "HACKED"', await call('suppliers:updateStatus', 1, 'HACKED'));
  accepted('a real supplier is still accepted', await call('suppliers:create', { Name: 'مورد الأجهزة', Phone: '0111', Email: '', Address: '', CreditLimit: null }));

  refused('employees:create with a negative salary', await call('employees:create', { Name: 'م', Phone: '', Position: '', Department: '', BaseSalary: -99999, Allowances: 0, HireDate: '2026-01-01', Notes: '' }));
  refused('employees:create with negative allowances', await call('employees:create', { Name: 'م', Phone: '', Position: '', Department: '', BaseSalary: 3000, Allowances: -500, HireDate: '2026-01-01', Notes: '' }));
  refused('employees:create with HireDate "not-a-date"', await call('employees:create', { Name: 'م', Phone: '', Position: '', Department: '', BaseSalary: 3000, Allowances: 0, HireDate: 'not-a-date', Notes: '' }));
  refused('employees:create with HireDate "2026-02-31"', await call('employees:create', { Name: 'م', Phone: '', Position: '', Department: '', BaseSalary: 3000, Allowances: 0, HireDate: '2026-02-31', Notes: '' }));
  refused('employees:create with HireDate "1899-01-01"', await call('employees:create', { Name: 'م', Phone: '', Position: '', Department: '', BaseSalary: 3000, Allowances: 0, HireDate: '1899-01-01', Notes: '' }));
  accepted('a real employee is still accepted', await call('employees:create', { Name: 'أحمد الفني', Phone: '0122', Position: 'فني صيانة', Department: 'الصيانة', BaseSalary: 4000, Allowances: 300, HireDate: '2026-01-15', Notes: 'ملاحظة' }));
}

// ===========================================================================
console.log('── 4. inventory master data — names, enums, flags ──');
// ===========================================================================
{
  refused('warehouses:create with empty name', await call('warehouses:create', { WarehouseName: '', WarehouseType: 'main' }));
  refused('warehouses:create with type "ANY_STRING"', await call('warehouses:create', { WarehouseName: 'م', WarehouseType: 'ANY_STRING' }));
  accepted('a real warehouse is still accepted', await call('warehouses:create', { WarehouseName: 'المخزن الرئيسي', WarehouseType: 'main' }));

  refused('categories:create with empty name', await call('categories:create', '', null));
  refused('categories:create with 200,000 chars', await call('categories:create', 'Z'.repeat(200000), null));
  refused('categories:create with a parent that does not exist', await call('categories:create', 'فرعية', 99999));
  const cat = await call('categories:create', 'إكسسوارات', null);
  accepted('a real category is still accepted', cat);

  refused('items:create with empty name', await call('items:create', { ItemName: '', CategoryID: null, SalePrice: 10, ItemType: 'accessory' }));
  refused('items:create with ItemType "WEAPON"', await call('items:create', { ItemName: 'x', CategoryID: null, SalePrice: 10, ItemType: 'WEAPON' }));
  refused('items:create with IsSerialized 99', await call('items:create', { ItemName: 'x', CategoryID: null, SalePrice: 10, ItemType: 'phone', IsSerialized: 99 }));
  // A foreign key also rejects this, but with "FOREIGN KEY constraint failed"
  // wrapped in `خطأ: ...` — a message the shopkeeper cannot act on. Mutation
  // testing showed the plain `refused(...)` check passing with the explicit
  // guard removed, because the FK caught it either way. The MESSAGE is the
  // thing this check adds, so the message is what is asserted.
  const badCat = await call('items:create', { ItemName: 'x', CategoryID: 99999, SalePrice: 10, ItemType: 'accessory' });
  refused('items:create with a category that does not exist', badCat);
  ok('…and says so in Arabic rather than leaking the SQL error',
    typeof badCat.message === 'string'
    && badCat.message.includes('الفئة غير موجودة')
    && !/FOREIGN KEY|constraint/i.test(badCat.message),
    JSON.stringify(badCat.message));
  refused('items:create with a negative sale price', await call('items:create', { ItemName: 'x', CategoryID: null, SalePrice: -900, ItemType: 'accessory' }));

  const item = await call('items:create', {
    ItemName: 'شاحن سريع', CategoryID: cat.id, SalePrice: 150,
    ItemType: 'accessory', Barcode: '6221031492015', MinStock: 5, Unit: 'قطعة',
  });
  accepted('a real item is still accepted', item);
  const row = db.prepare('SELECT ItemType, IsSerialized, Unit FROM items WHERE ItemID = ?').get(item.id);
  ok('…with a 0/1 serial flag', row.IsSerialized === 0, JSON.stringify(row));

  refused('items:update cannot blank the name', await call('items:update', item.id, { ItemName: '', SalePrice: 150 }));
  refused('items:update on an item that does not exist', await call('items:update', 999999, { ItemName: 'x', SalePrice: 1 }));
  accepted('items:update with a real change', await call('items:update', item.id, { ItemName: 'شاحن سريع 25W', SalePrice: 175, ItemType: 'accessory', MinStock: 5, Unit: 'قطعة' }));

  refused('items:quickCreate with no barcode', await call('items:quickCreate', { Barcode: '' }));
  refused('items:quickCreate with ItemType "WEAPON"', await call('items:quickCreate', { Barcode: '111', ItemType: 'WEAPON' }));
  accepted('items:quickCreate from a scan is still accepted', await call('items:quickCreate', { Barcode: '6221031492022', SalePrice: 50 }));

  refused('cashAccounts:create with empty name', await call('cashAccounts:create', { AccountName: '', AccountType: 'safe', Balance: 0 }));
  refused('cashAccounts:create with type "BITCOIN"', await call('cashAccounts:create', { AccountName: 'x', AccountType: 'BITCOIN', Balance: 0 }));
  // 'cash' is NOT a valid type — the dropdown offers 'safe' and 'bank'. Pinned
  // because a first draft of the allow-list used 'cash' and would have refused
  // every safe the shop creates.
  refused('cashAccounts:create with type "cash" (not what the form sends)', await call('cashAccounts:create', { AccountName: 'x', AccountType: 'cash', Balance: 0 }));
  accepted('a real safe is still accepted', await call('cashAccounts:create', { AccountName: 'الخزنة الثانية', AccountType: 'safe', Balance: 0 }));
  accepted('a real bank account is still accepted', await call('cashAccounts:create', { AccountName: 'حساب البنك', AccountType: 'bank', Balance: 5000, BankName: 'CIB', AccountNumber: '123' }));

  refused('paymentMethods:create with empty name', await call('paymentMethods:create', { MethodName: '', MethodType: 'digital_wallet' }));
  refused('paymentMethods:create with type "ANYTHING"', await call('paymentMethods:create', { MethodName: 'x', MethodType: 'ANYTHING' }));
  accepted('a real wallet is still accepted', await call('paymentMethods:create', { MethodName: 'فودافون كاش', MethodType: 'digital_wallet', Provider: 'Vodafone', PhoneNumber: '0100' }));
  accepted('a real POS machine is still accepted', await call('paymentMethods:create', { MethodName: 'ماكينة CIB', MethodType: 'pos_machine', Provider: 'CIB', PhoneNumber: '' }));

  // The three warehouse types the form offers, all of which must pass.
  for (const wt of ['main', 'maintenance', 'other']) {
    accepted(`warehouse type "${wt}" is accepted`, await call('warehouses:create', { WarehouseName: `مخزن ${wt}`, WarehouseType: wt }));
  }
}

// ===========================================================================
console.log('── 5. users and roles — one account per identity ──');
// ===========================================================================
{
  accepted('users:create "kareem"', await call('users:create', { username: 'kareem', password: 'Str0ngPass!', roleId: 1 }));
  refused('users:create "kareem " (trailing space) is the SAME account', await call('users:create', { username: 'kareem ', password: 'Str0ngPass!', roleId: 1 }));
  refused('users:create "KAREEM" (different case) is the SAME account', await call('users:create', { username: 'KAREEM', password: 'Str0ngPass!', roleId: 1 }));
  refused('users:create with a 100,000-char username', await call('users:create', { username: 'U'.repeat(100000), password: 'Str0ngPass!', roleId: 1 }));
  refused('users:create with a username containing a space', await call('users:create', { username: 'ahmed ali', password: 'Str0ngPass!', roleId: 1 }) );
  refused('users:create with a role that does not exist', await call('users:create', { username: 'ghost', password: 'Str0ngPass!', roleId: 99999 }));
  refused('users:create with a 200-character password (bcrypt truncates at 72 bytes)', await call('users:create', { username: 'longpw', password: 'p'.repeat(200), roleId: 1 }));

  const usernames = db.prepare('SELECT Username FROM users').all().map(u => u.Username);
  ok('only one "kareem" exists', usernames.filter(u => u.toLowerCase().trim() === 'kareem').length === 1, JSON.stringify(usernames));

  // The two checks below exist because mutation testing showed the ones above
  // passing for the WRONG REASON.
  //
  // Removing the `.toLowerCase()` from `normaliseUsername` still made
  // `users:create('KAREEM')` fail — but only because the character allow-list
  // `/^[a-z0-9._@-]+$/` rejects capitals outright. The suite could not tell
  // "normalised to kareem" from "refused for containing a capital letter", so
  // it would not have noticed the normalisation disappearing.
  const mixed = await call('users:create', { username: 'Sara.Ali', password: 'Str0ngPass!', roleId: 1 });
  accepted('a mixed-case username is accepted…', mixed);
  const mixedStored = db.prepare('SELECT Username FROM users WHERE UserID = ?').get(mixed.id).Username;
  ok('…and STORED lower-cased', mixedStored === 'sara.ali', JSON.stringify(mixedStored));

  // And the duplicate lookup must be `LOWER(TRIM(Username))`, not `Username`.
  // An exact-match lookup passes every test above, because everything created
  // THROUGH the handler is already normalised — so nothing collides. It fails
  // only against a row that predates the normalisation, which is exactly the
  // situation in a database seeded before this fix. Inserted directly to
  // reproduce that state.
  // 'LegacyUser ' has both a capital and a trailing space, so an exact-match
  // lookup misses it and `LOWER(TRIM(...))` finds it.
  db.prepare("INSERT INTO users (UserID, Username, PasswordHash, RoleID, IsActive) VALUES (900, 'LegacyUser ', 'x', 1, 1)").run();
  refused('a name colliding with an un-normalised legacy row is refused',
    await call('users:create', { username: 'legacyuser', password: 'Str0ngPass!', roleId: 1 }));
  ok('…and no second account was created',
    db.prepare("SELECT COUNT(*) c FROM users WHERE LOWER(TRIM(Username)) = 'legacyuser'").get().c === 1);

  refused('roles:create with empty name', await call('roles:create', ''));
  refused('roles:create with 50,000 chars', await call('roles:create', 'R'.repeat(50000)));
  const role = await call('roles:create', 'كاشير');
  accepted('a real role is still accepted', role);
  refused('roles:create rejects a duplicate name', await call('roles:create', 'كاشير'));
  refused('roles:update cannot blank a role name', await call('roles:update', role.id, ''));

  // Permission overrides: the Type column is read as
  // `if grant … else if deny …`, so a third value is a silent no-op.
  refused('permissions:setOverride with type "sudo"', await call('permissions:setOverride', 1, 1, 'sudo'));
  refused('permissions:setOverride with a permission that does not exist', await call('permissions:setOverride', 1, 99999, 'grant'));
  accepted('permissions:setOverride with "deny"', await call('permissions:setOverride', 1, 1, 'deny'));

  // setForRole DELETES the whole set first. A non-array payload must not be
  // able to leave the role stripped of every permission.
  await call('permissions:setForRole', role.id, [1]);
  const before = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE RoleID = ?').get(role.id).c;
  ok('the role has its permission', before === 1, String(before));
  refused('permissions:setForRole with a non-array payload', await call('permissions:setForRole', role.id, undefined));
  refused('permissions:setForRole with an unknown permission id', await call('permissions:setForRole', role.id, [1, 99999]));
  const after = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE RoleID = ?').get(role.id).c;
  ok('…and the role still has its permission', after === 1, `${before} -> ${after}`);

  // The DELETE was moved INSIDE the transaction, and the de-duplication below
  // is what made that move a belt-and-braces measure rather than the fix.
  //
  // Mutation testing found the original ordering bug and then, usefully,
  // refused to die for it a second time. Moving the delete back OUTSIDE the
  // transaction is now an EQUIVALENT MUTANT — no test can distinguish the two
  // programs, because after de-duplication and pre-validation every failure
  // path returns before a single row is written:
  //
  //   duplicates      removed before the loop
  //   unknown ids     rejected before the loop (checked against `permissions`)
  //   non-integers    rejected before the loop
  //   missing role    rejected before the loop
  //
  // and the only remaining way to make the loop throw — deleting a permission
  // concurrently — is blocked by the foreign key on
  // `role_permissions.PermissionID`. The delete stays inside the transaction
  // anyway, because the next person to add a branch to this handler should
  // not have to rediscover why it matters.
  //
  // MEASURED before the de-duplication: `[1, 2, 1]` threw "UNIQUE constraint
  // failed: role_permissions.RoleID, role_permissions.PermissionID" from
  // inside the loop, and with the delete outside the role was left with
  // NOTHING — every user holding it silently lost all access.
  db.prepare("INSERT INTO permissions (PermissionID, PermissionKey, PermissionName, Module) VALUES (2, 'sales.delete', 'حذف', 'sales')").run();
  const dupReply = await call('permissions:setForRole', role.id, [1, 2, 1]);
  accepted('permissions:setForRole tolerates a duplicated id', dupReply);
  const dupRows = db.prepare('SELECT PermissionID FROM role_permissions WHERE RoleID = ? ORDER BY PermissionID').all(role.id).map(r => r.PermissionID);
  ok('…and stores each permission exactly once', JSON.stringify(dupRows) === '[1,2]', JSON.stringify(dupRows));
  ok('…and the role is never left with nothing', dupRows.length > 0, JSON.stringify(dupRows));

  // An unbounded list is an unbounded loop of INSERTs inside one transaction.
  // There are far fewer than 500 permissions in this product, so a payload
  // larger than that is not a screen doing its job.
  //
  // The ids must be REAL ones, or the existence check rejects the payload
  // first and the cap is never reached — mutation testing caught exactly that:
  // a list of 600 non-existent ids failed for the wrong reason, so deleting
  // the cap changed nothing. 600 real permissions are inserted here so the
  // size limit is the only thing left that can refuse them.
  const capTx = db.transaction(() => {
    for (let i = 1000; i < 1600; i++) {
      db.prepare('INSERT INTO permissions (PermissionID, PermissionKey, PermissionName, Module) VALUES (?, ?, ?, ?)')
        .run(i, `bulk.${i}`, `صلاحية ${i}`, 'bulk');
    }
  });
  capTx();
  const huge = Array.from({ length: 600 }, (_, i) => 1000 + i);
  refused('permissions:setForRole with 600 REAL ids is refused by the size cap',
    await call('permissions:setForRole', role.id, huge));
  const stillThere = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE RoleID = ?').get(role.id).c;
  ok('…and the role kept its real permissions', stillThere === 2, String(stillThere));
  // A list just under the cap must still be accepted, so the limit is a limit
  // and not a blanket refusal.
  accepted('a 400-permission list is still accepted',
    await call('permissions:setForRole', role.id, Array.from({ length: 400 }, (_, i) => 1000 + i)));
  ok('…and all 400 were stored',
    db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE RoleID = ?').get(role.id).c === 400);
  // Restore the role to its real set for anything that follows.
  await call('permissions:setForRole', role.id, [1, 2]);
}

// ===========================================================================
console.log('── 5b. services and payroll — the party must exist ──');
// ===========================================================================
{
  const svcBase = {
    Provider: 'vodafone', TargetPhone: '01000000000', PaidToProvider: 50,
    ChargeAmount: 55, PaymentMethod: 'cash', PaidAmount: 55, CashAccountID: 1,
    ReceiveAccountType: 'cash_account', ReceiveAccountID: 1,
    userId: 1, fiscalYearId: 1,
  };
  // The type is printed on the list screen through `typeLabels[type] || type`
  // and used as the description on the customer statement, so an unrecognised
  // one is shown to the user verbatim.
  refused('serviceSales:create with ServiceType "ALIEN"', await call('serviceSales:create', { ...svcBase, ServiceType: 'ALIEN' }));
  refused('serviceSales:create with Provider "ALIEN"', await call('serviceSales:create', { ...svcBase, ServiceType: 'balance_transfer', Provider: 'ALIEN' }));
  refused('serviceSales:create with an empty destination number', await call('serviceSales:create', { ...svcBase, ServiceType: 'balance_transfer', TargetPhone: '' }));
  refused('serviceSales:create for a customer that does not exist', await call('serviceSales:create', { ...svcBase, ServiceType: 'balance_transfer', CustomerID: 999999 }));
  accepted('a real balance transfer is still accepted', await call('serviceSales:create', { ...svcBase, ServiceType: 'balance_transfer' }));
  accepted('a real bill payment is still accepted', await call('serviceSales:create', { ...svcBase, ServiceType: 'bill_payment', Provider: 'fawry' }));

  // MEASURED before the fix: an employee id of 99999 threw
  // "FOREIGN KEY constraint failed" out of the transaction, which the IPC
  // guard turned into a generic "operation failed" with no field named.
  const advBase = { Amount: 500, CashAccountID: 1, userId: 1, fiscalYearId: 1 };
  const badAdv = await call('advances:create', { ...advBase, EmployeeID: 999999 });
  refused('advances:create for an employee that does not exist', badAdv);
  ok('…and names the field rather than leaking the SQL error',
    typeof badAdv.message === 'string' && !/FOREIGN KEY|constraint/i.test(badAdv.message),
    JSON.stringify(badAdv.message));
  // Without the explicit check, the pre-existing "insufficient balance" branch
  // also refuses this — but it tells the shopkeeper the safe holds 0.00, which
  // is a lie about a safe that does not exist. Mutation testing showed a plain
  // `refused(...)` passing either way, so the MESSAGE is what is asserted.
  const badCash = await call('advances:create', { ...advBase, EmployeeID: 1, CashAccountID: 999999 });
  refused('advances:create against a cash box that does not exist', badCash);
  ok('…and says the box is missing, not that it is empty',
    typeof badCash.message === 'string'
    && badCash.message.includes('الخزينة غير موجودة')
    && !badCash.message.includes('الرصيد غير كافٍ'),
    JSON.stringify(badCash.message));
  accepted('a real advance is still accepted', await call('advances:create', { ...advBase, EmployeeID: 1, Reason: 'سلفة شهر' }));

  const dedBase = { Amount: 100, userId: 1, fiscalYearId: 1 };
  refused('deductions:create for an employee that does not exist', await call('deductions:create', { ...dedBase, EmployeeID: 999999, Reason: 'absence' }));
  refused('deductions:create with reason "ANYTHING"', await call('deductions:create', { ...dedBase, EmployeeID: 1, Reason: 'ANYTHING' }));
  // All four reasons the dropdown offers must pass — a validator that refuses
  // the shop's own form is worse than none.
  for (const reason of ['absence', 'negligence', 'damage', 'other']) {
    accepted(`deduction reason "${reason}" is accepted`, await call('deductions:create', { ...dedBase, EmployeeID: 1, Reason: reason }));
  }
}

// ===========================================================================
console.log('── 6. search terms — LIKE wildcards and length ──');
// ===========================================================================
{
  // `%` is a LIKE wildcard: it used to match every row past every other
  // filter the user had set.
  const all = await call('customers:list', {});
  const pct = await call('customers:list', { search: '%' });
  ok('a search for "%" no longer returns the whole table', pct.length < all.length, `${pct.length} of ${all.length}`);

  const under = await call('customers:list', { search: '_' });
  ok('a search for "_" no longer matches any single character', under.length < all.length, `${under.length} of ${all.length}`);

  // A 60,000-character term made SQLite throw "LIKE or GLOB pattern too
  // complex", which reached the screen as an unexplained empty list.
  let threw = false;
  try { await call('customers:list', { search: 'x'.repeat(60000) }); } catch { threw = true; }
  ok('a 60,000-character search does not throw', !threw);
  try { await call('items:list', { search: 'x'.repeat(60000) }); } catch { threw = true; }
  ok('…on the items list either', !threw);
  try { await call('suppliers:list', { search: 'x'.repeat(60000) }); } catch { threw = true; }
  ok('…on the suppliers list either', !threw);

  // The other half: an ordinary search must still find things.
  const real = await call('customers:list', { search: 'محمد' });
  ok('an ordinary Arabic search still works', real.length >= 1, `${real.length} rows`);
  const byItem = await call('items:list', { search: 'شاحن' });
  ok('an ordinary item search still works', byItem.length >= 1, `${byItem.length} rows`);
}

// ===========================================================================
console.log('── 7. control characters never reach storage ──');
// ===========================================================================
{
  // U+202E RIGHT-TO-LEFT OVERRIDE reverses the display of everything after
  // it. In an application that is already RTL this is invisible to the reader
  // and can make a printed figure render as a different number.
  const r = await call('customers:create', {
    Name: 'اسم\u0000\u202Eمقلوب\u200B', Phone: '', Email: '', Address: '', CreditLimit: null,
  });
  accepted('a name containing control characters is accepted', r);
  const stored = db.prepare('SELECT Name FROM customers WHERE CustomerID = ?').get(r.id).Name;
  ok('…with the NUL removed', !stored.includes('\u0000'), JSON.stringify(stored));
  ok('…with the RTL override removed', !stored.includes('\u202E'), JSON.stringify(stored));
  ok('…with the zero-width space removed', !stored.includes('\u200B'), JSON.stringify(stored));
  ok('…and the real letters kept', stored.includes('اسم') && stored.includes('مقلوب'), JSON.stringify(stored));

  // Ampersands and quotes are NOT escaped on the way in. Escaping belongs at
  // output (see src/shared/escapeHtml.ts); doing it here would store
  // `&amp;` and show it to the customer that way for ever.
  const amp = await call('customers:create', { Name: 'محل الأخوة & أولاده', Phone: '', Email: '', Address: '', CreditLimit: null });
  const ampStored = db.prepare('SELECT Name FROM customers WHERE CustomerID = ?').get(amp.id).Name;
  ok('an ampersand in a real shop name is stored as itself', ampStored === 'محل الأخوة & أولاده', JSON.stringify(ampStored));
}

// ===========================================================================
console.log('── 8. the validators themselves ──');
// ===========================================================================
{
  const v = await import('../src/shared/validate.ts');

  ok('requireText rejects null', !v.requireText(null, 'x', 10).ok);
  ok('requireText rejects an array', !v.requireText([1, 2], 'x', 10).ok);
  ok('requireText rejects an object', !v.requireText({}, 'x', 10).ok);
  ok('requireText accepts a number', v.requireText(42, 'x', 10).ok);
  ok('requireText rejects NaN', !v.requireText(NaN, 'x', 10).ok);
  ok('requireText rejects Infinity', !v.requireText(Infinity, 'x', 10).ok);
  ok('requireText rejects over the limit', !v.requireText('abcdefghijk', 'x', 10).ok);
  ok('requireText accepts exactly the limit', v.requireText('abcdefghij', 'x', 10).ok);

  ok('requireId rejects "12abc"', !v.requireId('12abc', 'x').ok);
  ok('requireId rejects 0', !v.requireId(0, 'x').ok);
  ok('requireId rejects -1', !v.requireId(-1, 'x').ok);
  ok('requireId rejects 1.5', !v.requireId(1.5, 'x').ok);
  ok('requireId accepts "12"', v.requireId('12', 'x').ok);
  // Type confusion. MEASURED against `customers:update`: an array of one and
  // an object with a `toString` both coerced to id 1 and renamed the customer.
  ok('requireId rejects an array', !v.requireId([1], 'x').ok);
  ok('requireId rejects an object with toString', !v.requireId({ toString: () => '1' }, 'x').ok);
  ok('requireId rejects true', !v.requireId(true, 'x').ok);
  ok('requireId rejects " 1 " (padded)', !v.requireId(' 1 ', 'x').ok);
  ok('requireId rejects "1.0"', !v.requireId('1.0', 'x').ok);
  ok('requireId rejects 1e20 (beyond safe integers)', !v.requireId(1e20, 'x').ok);
  ok('requireId rejects "1 OR 1=1"', !v.requireId('1 OR 1=1', 'x').ok);

  ok('requireDate rejects 2026-02-31', !v.requireDate('2026-02-31', 'x').ok);
  ok('requireDate rejects 2026-13-01', !v.requireDate('2026-13-01', 'x').ok);
  ok('requireDate rejects 1899-01-01', !v.requireDate('1899-01-01', 'x').ok);
  ok('requireDate rejects 3026-01-01', !v.requireDate('3026-01-01', 'x').ok);
  ok('requireDate accepts a real leap day', v.requireDate('2028-02-29', 'x').ok);
  ok('requireDate rejects a fake leap day', !v.requireDate('2027-02-29', 'x').ok);

  ok('oneOf is case-sensitive', !v.oneOf('RECEIPT', 'x', ['receipt']).ok);
  ok('oneOf accepts the exact value', v.oneOf('receipt', 'x', ['receipt']).ok);

  ok('requireFlag rejects 99', !v.requireFlag(99, 'x').ok);
  ok('requireFlag accepts true', v.requireFlag(true, 'x').value === 1);
  ok('requireFlag accepts "0"', v.requireFlag('0', 'x').value === 0);

  // The escape must handle the backslash FIRST, or it escapes its own escapes.
  ok('searchTerm escapes a percent', v.searchTerm('50%') === '50\\%');
  ok('searchTerm escapes an underscore', v.searchTerm('a_b') === 'a\\_b');
  ok('searchTerm escapes a backslash once', v.searchTerm('a\\b') === 'a\\\\b');
  ok('searchTerm caps the length', (v.searchTerm('x'.repeat(1000)) || '').length <= 100);
  ok('searchTerm returns null for blank', v.searchTerm('   ') === null);

  ok('stripControlChars keeps newlines', v.stripControlChars('a\nb') === 'a\nb');
  ok('stripControlChars keeps tabs', v.stripControlChars('a\tb') === 'a\tb');
  ok('stripControlChars removes NUL', v.stripControlChars('a\u0000b') === 'ab');
  ok('collapseSpaces keeps newlines', v.collapseSpaces('a\nb') === 'a\nb');
}

// ===========================================================================
console.log(`\n${'═'.repeat(64)}`);
if (failures.length) {
  console.error(`FAILED  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASSED  all ${checks} checks — the backend refuses what the screens refuse`);
