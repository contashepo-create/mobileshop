/**
 * Central IPC authorisation layer.
 *
 * Every `ipcMain.handle` in this app now goes through `registerHandler`, which:
 *   1. rejects calls from windows that have not authenticated (except for the
 *      explicitly public channels below);
 *   2. checks the caller holds the permission required by the channel;
 *   3. injects the trusted `{ userId, username, roleId }` from the server-side
 *      session so handlers never read identity from renderer-supplied payloads.
 *
 * Channels are DENIED BY DEFAULT: a channel with no entry in CHANNEL_PERMISSIONS
 * requires authentication and is refused unless it is listed as public or
 * authenticated-only. This prevents a newly added handler from silently
 * shipping without an access rule.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getSession, type Session } from './session';
import { isGuardedChannel, checkBooks, netWorth } from './bookGuard';

export interface CallerContext {
  userId: number;
  username: string;
  roleId: number | null;
  employeeId: number | null;
  webContentsId: number;
}

/**
 * Channels callable without a session — startup, licensing, first-run setup and
 * the developer console (which has its own password + token gate).
 */
const PUBLIC_CHANNELS = new Set<string>([
  // These two verify a username and password THEMSELVES, with a uniform
  // failure message and a dummy compare, and exist precisely for the case
  // where the shop cannot log in — a forgotten password, or a licence that
  // has lapsed. Requiring a session would make them unreachable exactly when
  // they are needed. They are login-equivalent, not unauthenticated.
  'db:exportForOwner',
  'users:listRecoverable',
  'auth:login',
  'auth:logout',
  'auth:session',
  'license:status',
  'license:activate',
  'license:getDeviceId',
  'setup:isComplete',
  'setup:initialize',
  'setup:complete',
  'setup:importDatabase',
  'settings:getAll', // needed to render the login screen / branding
  'settings:get',
  'dev:login',
  'dev:logout',
  // Getting INTO the developer console cannot itself require being inside it.
  // A challenge is a random nonce — not a secret — and the signed login is
  // guarded by the signature and the password, not by the channel list.
  'dev:challenge',
  'dev:loginSigned',
  // Diagnosing a clock problem must work while the app is locked out — that is
  // precisely the state the owner needs explained. It only reports dates.
  'license:clockDiagnostics',
  // Developer-console channels: gated by devToken inside their own handlers.
  'license:generateCode',
  'license:deactivate',
  'license:repairClockState',
  'users:resetByDev',
  'users:listBasic',
  // Owner-driven admin password recovery. Necessarily reachable BEFORE login —
  // that is the whole point: nobody can sign in. Safe to expose because the
  // six-digit code is delivered only to the Telegram account of the shop owner
  // and never in the response, the handlers accept administrators only, and the
  // reset is authorised by an HMAC grant re-verified in the main process. See
  // src/main/security/passwordRecovery.ts.
  //
  // NOTE: no apostrophes in this comment. verify_ipc_coverage.py reads channel
  // names by matching single-quoted strings in this block, so a stray
  // apostrophe pairs with a real quote and hides the entries below it.
  // The books belong to the shop that entered them. This must be reachable
  // from the activation screen when a licence has lapsed, which is precisely
  // when there is no session. It proves an administrator password inside the
  // handler. (No apostrophes here: verify_ipc_coverage.py reads channel names
  // by matching single-quoted strings, so a stray one hides the entries below.)
  // Phone confirmation runs during first-run setup, before any user exists.
  // It only talks to the shop own bot and returns a yes or no.
  'phone:verify',
  'recovery:isAvailable',
  'recovery:requestCode',
  'recovery:resetPassword',
]);

/**
 * Channels that only need a logged-in user (no specific permission).
 * Mostly read-only lookups used to populate dropdowns across many screens.
 */
const AUTHENTICATED_ONLY = new Set<string>([
  'fiscalYear:getActive',
  'fiscalYear:list',
  'fiscalYear:forDate',
  'fiscalYear:openings',
  'notes:list',
  'notes:add',
  'notifications:smart',
  'notifications:dismiss',
  'notifications:dismissAll',
  'notifications:dismissed',
  'notifications:snooze',
  'notifications:clearExpired',
  // Reading the alert preferences is needed to render the bell for everyone;
  // changing them is a settings action and is permission-mapped below.
  'notifications:getPrefs',
  'warehouses:list',
  'categories:list',
  'cashAccounts:list',
  'paymentMethods:list',
  'items:list',
  'items:get',
  'items:listByWarehouse',
  'items:findByBarcode',
  'serials:list',
  'serials:getAvailable',
  'stock:list',
  'customers:list',
  'customers:get',
  'suppliers:list',
  'suppliers:get',
  'employees:list',
  'employees:get',
  'users:list',
  'roles:list',
  'permissions:list',
  'permissions:getByRole',
  'permissions:getOverrides',
  'print:preview',
  'print:invoice',
  // The About page shows the real installed build number.
  'app:getVersion',
  // The About page lets the owner check for / install an update manually.
  // Safe by construction: `updater:updateNow` only fires after electron-updater
  // has already downloaded the new build, and quitAndInstall is read-only on
  // the database.
  'updater:check',
  'updater:updateNow',
  'updater:getStatus',
  // Remote management: read-only for the customer.
  'remote:messages',
  'remote:markRead',
  'remote:syncInfo',
  'remote:privacyReport',
  'remote:managedKeys',
  // Popups the customer must be able to see and dismiss regardless of role:
  // a renewal warning that only an admin could read would be useless to the
  // cashier who is actually standing at the counter when it expires.
  'remote:pendingNotices',
  'remote:dismissNotice',
  'statement:getOperationDetail',
  'capital:get',
]);

/** channel -> required permission key */
const CHANNEL_PERMISSIONS: Record<string, string> = {
  // ---- Sales
  'sales:list': 'sales.view',
  'sales:get': 'sales.view',
  'sales:create': 'sales.create',
  // Editing rewrites balances and stock, so it carries the same authority as
  // deleting rather than merely creating.
  'sales:update': 'sales.delete',
  'delete:sale': 'sales.delete',
  'saleReturns:list': 'sales.returns',
  'saleReturns:create': 'sales.returns',
  'saleReturns:get': 'sales.returns',
  'saleReturns:returnable': 'sales.returns',
  // Reversing a credit note moves money and stock, so it is gated with the
  // same authority as deleting an invoice rather than merely viewing returns.
  'delete:saleReturn': 'sales.delete',

  // ---- Purchases
  'purchases:list': 'purchases.view',
  'purchases:get': 'purchases.view',
  'purchases:create': 'purchases.create',
  'delete:purchase': 'purchases.delete',
  'purchaseReturns:list': 'purchases.returns',
  'purchaseReturns:create': 'purchases.returns',
  'purchaseReturns:get': 'purchases.returns',
  'purchaseReturns:returnable': 'purchases.returns',
  // Reversing a debit note moves stock and money, so it carries the same
  // authority as deleting a purchase.
  'delete:purchaseReturn': 'purchases.delete',

  // ---- Maintenance
  'maintenance:list': 'maintenance.view',
  'maintenance:get': 'maintenance.view',
  'maintenance:getForEdit': 'maintenance.view',
  'maintenance:openTickets': 'maintenance.view',
  'maintenance:getWarrantyHistory': 'maintenance.view',
  'maintenance:getFinancialSummary': 'maintenance.view',
  'maintenance:listServiceCosts': 'maintenance.view',
  'maintenance:receive': 'maintenance.create',
  'maintenance:update': 'maintenance.edit',
  'maintenance:updateStatus': 'maintenance.edit',
  'maintenance:issuePart': 'maintenance.edit',
  'maintenance:removePart': 'maintenance.edit',
  'maintenance:addServiceCost': 'maintenance.edit',
  'maintenance:removeServiceCost': 'maintenance.edit',
  'maintenance:addServiceUsage': 'maintenance.edit',
  'maintenance:removeServiceUsage': 'maintenance.edit',
  'maintenance:addNote': 'maintenance.edit',
  'maintenance:cancel': 'maintenance.edit',
  'maintenance:deliver': 'maintenance.deliver',
  'maintenance:return': 'maintenance.returns',
  'delete:maintenanceDelivery': 'maintenance.returns',

  // ---- Services (sold like sales)
  'serviceSales:list': 'sales.view',
  'serviceSales:get': 'sales.view',
  'serviceSales:create': 'sales.create',
  'serviceSales:update': 'sales.delete',
  'serviceSales:return': 'sales.returns',
  'serviceReturns:list': 'sales.returns',
  'delete:serviceSale': 'sales.delete',
  'delete:serviceReturn': 'sales.delete',

  // ---- Vouchers
  'vouchers:list': 'vouchers.view',
  'vouchers:get': 'vouchers.view',
  'vouchers:create': 'vouchers.create',
  'delete:voucher': 'vouchers.delete',

  // ---- Payroll
  'salaries:list': 'payroll.view',
  'salaries:getDetails': 'payroll.view',
  'employeeStatement:get': 'payroll.view',
  'employees:statement': 'payroll.view',
  'salaries:issue': 'payroll.create',
  'salaries:pay': 'payroll.create',
  'advances:list': 'payroll.view',
  'advances:create': 'payroll.create',
  'delete:advance': 'payroll.edit',
  'commissions:list': 'payroll.view',
  'commissions:payImmediate': 'payroll.create',
  'deductions:list': 'deductions.view',
  'deductions:create': 'deductions.create',
  'delete:deduction': 'payroll.edit',

  // ---- Rent
  'rents:list': 'rent.view',
  'rentPayments:list': 'rent.view',
  'rents:create': 'rent.create',
  'rents:generatePayments': 'rent.create',
  'rents:update': 'rent.edit',
  'rents:delete': 'rent.edit',
  'rentPayments:pay': 'rent.create',
  // Reversing a payment moves money back out of the books, so it is an EDIT,
  // not a creation. Cancelling a contract withdraws future obligations and is
  // held to the same bar.
  'rentPayments:unpay': 'rent.edit',
  'rents:cancel': 'rent.edit',
  // Read-only: what the shop still owes. Same permission as viewing the list.
  'rents:commitments': 'rent.view',
  // Advances move money, so they are held to the same bar as a payment.
  'rents:addAdvance': 'rent.create',
  'rents:applyAdvance': 'rent.create',
  // Landlords and tenants.
  'rentParties:list': 'rent.view',
  'rentParty:statement': 'rent.view',
  'rentParties:create': 'rent.create',
  'rentParties:update': 'rent.edit',
  'rentParties:delete': 'rent.edit',

  // ---- Settlements
  'settlements:list': 'settlements.view',
  'settlements:getDetails': 'settlements.view',
  'settlements:apply': 'settlements.create',

  // ---- Fiscal year
  'fiscalYear:create': 'fiscal_year.manage',
  'fiscalYear:close': 'fiscal_year.manage',
  'fiscalYear:reopen': 'fiscal_year.manage',

  // ---- Inventory
  'items:create': 'inventory.create',
  'items:quickCreate': 'inventory.create',
  'items:update': 'inventory.edit',
  'items:delete': 'inventory.delete',
  'items:deleteSafe': 'inventory.delete',
  'serials:add': 'inventory.create',
  'categories:create': 'inventory.create',
  'categories:update': 'inventory.edit',
  'categories:delete': 'inventory.delete',
  'warehouses:create': 'inventory.create',
  'warehouses:update': 'inventory.edit',
  'warehouses:delete': 'inventory.delete',
  'warehouseTransfers:list': 'inventory.transfer',
  'warehouseTransfers:create': 'inventory.transfer',

  // ---- HR
  'customers:create': 'hr.customers.create',
  'customers:update': 'hr.customers.edit',
  'customers:updateStatus': 'hr.customers.edit',
  'suppliers:create': 'hr.suppliers.create',
  'suppliers:update': 'hr.suppliers.edit',
  'suppliers:updateStatus': 'hr.suppliers.edit',
  'employees:create': 'hr.employees.create',
  'employees:update': 'hr.employees.edit',
  'employees:delete': 'hr.employees.edit',

  // ---- Assets
  'cashAccounts:create': 'assets.create',
  'cashAccounts:update': 'assets.edit',
  'cashAccounts:delete': 'assets.edit',
  'paymentMethods:create': 'assets.create',
  'paymentMethods:update': 'assets.edit',
  'paymentMethods:delete': 'assets.edit',
  'transfers:list': 'assets.view',
  'transfers:create': 'assets.edit',
  'delete:transfer': 'assets.edit',

  // ---- Reports
  'reports:dashboard': 'dashboard.view',
  'reports:sales': 'reports.view',
  'reports:purchases': 'reports.view',
  'reports:maintenance': 'reports.view',
  'reports:customers': 'reports.view',
  'reports:suppliers': 'reports.view',
  'reports:employees': 'reports.view',
  'reports:inventory': 'reports.view',
  'reports:profitLoss': 'reports.view',
  'reports:financialPosition': 'reports.view',
  'operations:log': 'reports.view',
  'customerStatement:get': 'reports.view',
  'supplierStatement:get': 'reports.view',
  'cashAccount:statement': 'reports.view',
  'paymentMethod:statement': 'reports.view',

  // ---- Opening balances (they rewrite balances directly => treat as settlement)
  'openingBalances:overview': 'settlements.view',
  'openingBalances:updateCash': 'settlements.create',
  'openingBalances:updatePaymentMethod': 'settlements.create',
  'openingBalances:updateCustomer': 'settlements.create',
  'openingBalances:updateSupplier': 'settlements.create',
  'openingBalances:updateEmployee': 'settlements.create',
  'openingBalances:updateStock': 'settlements.create',
  'openingBalances:batchUpdate': 'settlements.create',
  'capital:set': 'settlements.create',

  // ---- Settings / admin
  'settings:set': 'settings.edit',
  'remote:syncNow': 'settings.edit',
  // Retuning the alert rules changes what every user of this install sees,
  // so it is an administrative action rather than a personal preference.
  'notifications:setPrefs': 'settings.edit',
  'notifications:resetPrefs': 'settings.edit',
  'settings:setMany': 'settings.edit',
  'settings:resetDatabase': 'settings.edit',
  // The two preparatory steps of the reset. Same permission as the reset
  // itself: asking whether it is possible, and asking for the confirmation
  // code, are both part of the destructive flow and must not be reachable by
  // an account that could not complete it.
  'settings:pickLogo': 'settings.edit',
  'settings:resetIsAvailable': 'settings.edit',
  'settings:resetRequestCode': 'settings.edit',
  'users:create': 'settings.users',
  'users:update': 'settings.users',
  'users:delete': 'settings.users',
  'users:adminResetPassword': 'settings.users',
  'roles:create': 'settings.users',
  'roles:update': 'settings.users',
  'roles:delete': 'settings.users',
  'permissions:setForRole': 'settings.users',
  'permissions:setOverride': 'settings.users',
  'permissions:removeOverride': 'settings.users',
  'backup:create': 'settings.edit',
  'backup:restore': 'settings.edit',
  'backup:info': 'settings.view',
  'db:exportCSV': 'settings.edit',
  'db:exportAllCSV': 'settings.edit',
  'db:autoBackup': 'settings.edit',
  'db:backupInfo': 'settings.view',
  'db:getPath': 'settings.view',
  'db:getTables': 'settings.view',
  'db:changePath': 'settings.edit',
  'db:browsePath': 'settings.edit',
  'db:browseFolder': 'settings.edit',
  'db:createNetwork': 'settings.edit',
  'db:getCloudSettings': 'settings.view',
  'db:saveCloudSettings': 'settings.edit',
  'db:testCloudConnection': 'settings.edit',
  'db:uploadToCloud': 'settings.edit',
  // Telegram off-site backup. Reading the configuration is a view right;
  // everything that touches the token, or ships the whole database off the
  // premises, requires edit.
  'telegram:getSettings': 'settings.view',
  'telegram:saveSettings': 'settings.edit',
  'telegram:clearSettings': 'settings.edit',
  'telegram:test': 'settings.edit',
  'telegram:sendBackup': 'settings.edit',
};

export class IpcAuthError extends Error {
  // Declared as an ordinary field rather than a constructor parameter property.
  //
  // Parameter properties are a TypeScript-only construct that has to be
  // COMPILED away; Node's type-stripping cannot handle them. That single line
  // made this file impossible to import in a test, which is why the entire
  // authorisation layer had never been executed by one. The behaviour is
  // identical and the file is now runnable directly.
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';

  constructor(message: string, code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
    super(message);
    this.name = 'IpcAuthError';
    this.code = code;
  }
}

/**
 * Test seam for `authorize`.
 *
 * Exposed so a suite can prove the DECISION rather than match the source. A
 * text check cannot tell `throw new IpcAuthError(...)` from `return null` in a
 * branch that merely looks defensive, and "an unmapped channel fails closed"
 * is the property the whole authorisation model rests on.
 */
export function __authorizeForTests(
  event: IpcMainInvokeEvent, channel: string,
): CallerContext | null {
  return authorize(event, channel);
}

function authorize(event: IpcMainInvokeEvent, channel: string): CallerContext | null {
  if (PUBLIC_CHANNELS.has(channel)) return null;

  const session: Session | null = getSession(event.sender.id);
  if (!session) {
    throw new IpcAuthError('انتهت الجلسة - يرجى تسجيل الدخول مرة أخرى', 'UNAUTHENTICATED');
  }

  if (!AUTHENTICATED_ONLY.has(channel)) {
    const required = CHANNEL_PERMISSIONS[channel];
    if (!required) {
      // Deny by default: an unmapped channel is a programming oversight.
      console.error(`[IPC] Channel "${channel}" has no permission mapping — denied.`);
      throw new IpcAuthError('هذه العملية غير مصرّح بها', 'FORBIDDEN');
    }
    if (!session.permissions.has(required)) {
      throw new IpcAuthError('ليس لديك صلاحية لتنفيذ هذه العملية', 'FORBIDDEN');
    }
  }

  return {
    userId: session.userId,
    username: session.username,
    roleId: session.roleId,
    employeeId: session.employeeId,
    webContentsId: event.sender.id,
  };
}

/**
 * Wraps `ipcMain.handle` globally so EVERY channel is guarded, including any
 * added later. Patching the shared API (rather than editing ~180 call sites)
 * makes it impossible to register an unguarded handler by accident.
 *
 * It also rewrites the caller-supplied `userId` field with the authenticated
 * user from the server-side session. Handlers keep reading `data.userId`, but
 * the renderer can no longer choose whose name an operation is recorded under
 * (every page used to hardcode `userId: 1`, destroying the audit trail).
 *
 * Call once, before any handler is registered.
 */
export function installIpcGuard() {
  const original = ipcMain.handle.bind(ipcMain);

  (ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = ((
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => any,
  ) => {
    return original(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      let ctx: CallerContext | null;
      try {
        ctx = authorize(event, channel);
      } catch (err) {
        if (err instanceof IpcAuthError) {
          // Structured failure: existing renderer code checks `result.success`
          // and will surface the Arabic message instead of an opaque throw.
          return { success: false, message: err.message, code: err.code };
        }
        throw err;
      }

      // Stamp the trusted identity onto object payloads.
      if (ctx) {
        for (const arg of args) {
          if (arg && typeof arg === 'object' && !Array.isArray(arg) && 'userId' in arg) {
            (arg as Record<string, unknown>).userId = ctx.userId;
          }
        }
      }

      // Refuse to post into a fiscal year that has been closed.
      const closedYear = refuseClosedYear(channel, args);
      if (closedYear) return closedYear;

      // Any handler that throws is turned into the structured failure the
      // renderer already understands.
      //
      // Roughly thirty handlers — assets, hr, fiscalYear, notes among them —
      // carry no try/catch of their own. An unexpected throw in one of those
      // crossed the IPC boundary as an unhandled rejection: the screen got no
      // reply at all, so a button appeared to do nothing and the failure was
      // invisible. Catching HERE covers every channel at once, including any
      // added later, which is the same reason the guard itself patches
      // `ipcMain.handle` rather than editing every call site.
      //
      // Deliberately NOT swallowed: the reason is logged, and the caller is
      // told the operation failed rather than being left to assume it worked.
      const runSafely = async (run: () => any) => {
        try {
          return await run();
        } catch (err: any) {
          console.error(`[IPC] "${channel}" threw:`, err?.message || err);
          return {
            success: false,
            code: 'HANDLER_ERROR',
            message: 'تعذّر تنفيذ العملية - راجع سجل الأخطاء',
          };
        }
      };

      // Read-only or non-financial channels run exactly as before.
      if (!isGuardedChannel(channel)) {
        return runSafely(() => listener(event, ...args));
      }
      return runSafely(() => runGuarded(channel, () => listener(event, ...args)));
    });
  }) as typeof ipcMain.handle;
}

/**
 * Refuses any document addressed to a CLOSED fiscal year — and refuses any
 * document whose DATE does not belong to the fiscal year it is being posted
 * into.
 *
 * WHY THE CLOSED-YEAR HALF EXISTS
 * -------------------------------
 * `fiscalYear:close` stamps `Status = 'closed'` and opens the next year. NO
 * handler read that column. Measured, driving the real code — close 2026, then
 * post into it:
 *
 *     sales:create      fiscalYearId 1 -> {"success":true,"totalAmount":750}
 *     purchases:create  fiscalYearId 1 -> {"success":true,"totalAmount":250}
 *
 * Both documents landed in the closed year. "Closing the year" was a label.
 *
 * In accounting this is not a small thing. Once a year is closed its profit,
 * its stock valuation and its balances are FINAL: they have been shown to the
 * owner, they may have been filed, and they are the opening position of the
 * year that follows. A sale backdated into a closed year silently changes a
 * figure somebody already relied on, and the two years stop adding up to the
 * whole. It is also the single easiest way to hide a theft — post the
 * correction into a period nobody is looking at any more.
 *
 * WHY THE DATE HALF EXISTS
 * ------------------------
 * Every document is stamped with a fiscal year id the renderer chose. Until
 * this check existed the id was taken on trust: a screen that still pointed at
 * a year whose range did not contain today's date (a year closed early, a
 * year that starts in the future) wrote the document into a period it did not
 * belong to, and because reports filter by DATE, the figures of the wrong
 * year moved while the right ones stayed silent. The year a document belongs
 * to is a fact of its date, so the guard enforces the date against the year
 * before the handler writes anything.
 *
 * WHEN THE CALLER SUPPLIES A DATE, THE DATE DECIDES THE YEAR. A backdated
 * document (an old invoice recorded later) must land in the year that
 * contains its date, no matter what id a stale screen sent — so the guard
 * overrides the id with the year that contains the date. When no date is
 * supplied the document is dated today, and the addressed year must contain
 * today.
 *
 * WHY HERE RATHER THAN IN EACH HANDLER
 * ------------------------------------
 * Eighteen handlers across nine files accept a fiscal year from the caller.
 * Editing all eighteen leaves the nineteenth — written next month — unguarded,
 * which is exactly how the previous gaps in this project were created. The
 * guard patches `ipcMain.handle`, so it applies to every channel that carries
 * a year, including any added later.
 *
 * WHAT IS DELIBERATELY NOT BLOCKED
 * --------------------------------
 * Reads. A closed year must remain fully readable — its reports and statements
 * are the reason it was closed. Only channels that WRITE are considered, and
 * they are recognised by the same `isGuardedChannel` list the book guard uses,
 * plus the create/update/delete naming the project already follows.
 */
function refuseClosedYear(channel: string, args: unknown[]): { success: false; message: string; code: string } | null {
  // Only writes. `reports:*`, `statement:*` and every `:list`/`:get` must keep
  // working against a closed year.
  if (!/:(create|update|delete|pay|unpay|issue|cancel|return|deliver|apply|settle|add)/i.test(channel)) {
    return null;
  }

  let db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } };
  try {
    // Synchronous require: this runs on the hot path of every write, and an
    // await here would leave the check racing the handler it is meant to gate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    db = require('../database/connection').getDb();
  } catch {
    return null;   // no database yet (first run) — nothing to protect
  }

  // The document date: an explicit one from the payload (backdating), else
  // today, computed locally — this function is extracted and executed
  // standalone by the verifier, so it cannot import the shared date module.
  let payload: Record<string, unknown> | null = null;
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) { payload = arg as Record<string, unknown>; break; }
  }
  if (!payload) return null;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const explicitDate = payload.Date;
  const hasExplicitDate = explicitDate !== undefined && explicitDate !== null && explicitDate !== '';
  if (hasExplicitDate && (typeof explicitDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(explicitDate))) {
    return {
      success: false,
      code: 'FISCAL_YEAR_DATE_INVALID',
      message: 'تاريخ المستند غير صالح - الصيغة المطلوبة YYYY-MM-DD',
    };
  }
  const effectiveDate = hasExplicitDate ? (explicitDate as string) : today;

  // A document dated in the future is refused; two days of tolerance absorb a
  // clock a few minutes fast and a posting made just after midnight.
  const limit = new Date(now);
  limit.setDate(limit.getDate() + 2);
  const limitStr = `${limit.getFullYear()}-${pad(limit.getMonth() + 1)}-${pad(limit.getDate())}`;
  if (effectiveDate > limitStr) {
    return {
      success: false,
      code: 'FISCAL_YEAR_FUTURE_DATE',
      message: `لا يمكن تسجيل عملية بتاريخ مستقبلي (${effectiveDate})`,
    };
  }

  const refuseClosed = (row: { Status?: string; YearName?: string }, id: number): { success: false; code: string; message: string } => {
    console.error(`[IPC] "${channel}" refused: fiscal year ${id} is closed`);
    return {
      success: false,
      code: 'FISCAL_YEAR_CLOSED',
      message: `السنة المالية «${row.YearName || id}» مغلقة - لا يمكن تسجيل حركات فيها`,
    };
  };

  // === THE CALLER SUPPLIED A DATE: THE DATE DECIDES THE YEAR ===
  //
  // Backdated documents must land in the year that contains their date. The
  // id the renderer sent is ignored for the decision — the date is
  // authoritative — and the payload is rewritten so the handler stamps the
  // correct year. A closed year still refuses, until it is deliberately
  // reopened.
  if (hasExplicitDate) {
    let row: { FiscalYearID?: number; Status?: string; YearName?: string } | undefined;
    try {
      row = db.prepare(
        'SELECT FiscalYearID, Status, YearName FROM fiscal_years WHERE StartDate <= ? AND EndDate >= ? ORDER BY StartDate DESC LIMIT 1'
      ).get(effectiveDate, effectiveDate) as { FiscalYearID?: number; Status?: string; YearName?: string } | undefined;
    } catch {
      return null;   // table missing during a migration — do not block trading
    }
    if (!row) {
      return {
        success: false,
        code: 'FISCAL_YEAR_MISSING',
        message: `لا توجد سنة مالية تغطي تاريخ ${effectiveDate} - راجع تاريخ المستند`,
      };
    }
    if (row.Status === 'closed') return refuseClosed(row, row.FiscalYearID ?? 0);
    payload.fiscalYearId = row.FiscalYearID;
    payload.FiscalYearID = row.FiscalYearID;
    return null;
  }

  // === NO DATE: the addressed year must contain TODAY ===

  // Find the year the caller is addressing. Both spellings are in use.
  let yearId: unknown;
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    const o = arg as Record<string, unknown>;
    if (o.fiscalYearId !== undefined) { yearId = o.fiscalYearId; break; }
    if (o.FiscalYearID !== undefined) { yearId = o.FiscalYearID; break; }
  }
  if (yearId === undefined || yearId === null || yearId === '') return null;

  const id = Number(yearId);
  if (!Number.isInteger(id) || id <= 0) return null;   // the handler's own validation reports this

  let row: { Status?: string; YearName?: string; StartDate?: string; EndDate?: string } | undefined;
  try {
    row = db.prepare('SELECT Status, YearName, StartDate, EndDate FROM fiscal_years WHERE FiscalYearID = ?')
      .get(id) as { Status?: string; YearName?: string; StartDate?: string; EndDate?: string } | undefined;
  } catch {
    return null;   // table missing during a migration — do not block trading
  }

  if (!row) {
    return {
      success: false,
      code: 'FISCAL_YEAR_MISSING',
      message: `السنة المالية رقم ${id} غير موجودة`,
    };
  }

  if (row.Status === 'closed') return refuseClosed(row, id);

  // The document is dated today, so the addressed year must contain today. A
  // stale screen pointing at a year whose range does not include today is
  // told to use the right one instead of writing into the wrong period.
  if (today < (row.StartDate ?? '') || today > (row.EndDate ?? '')) {
    return {
      success: false,
      code: 'FISCAL_YEAR_DATE_OUT_OF_RANGE',
      message: `تاريخ اليوم (${today}) لا يقع ضمن نطاق هذه السنة المالية (${row.StartDate} إلى ${row.EndDate}) - اختر السنة المالية الصحيحة`,
    };
  }

  return null;
}

/**
 * Runs a money-moving handler inside a SAVEPOINT and refuses to keep the result
 * if it left the books in an impossible state.
 *
 * A SAVEPOINT rather than a transaction, because the handlers open transactions
 * of their own: `db.transaction(...)` cannot be nested, but a savepoint wraps
 * one perfectly and can still roll it back afterwards. Verified against real
 * SQLite before this was written — a handler's own committed transaction is
 * undone by `ROLLBACK TO`.
 *
 * The guard never invents an answer. If the operation is sound it is released
 * untouched and the handler's own return value is passed through unchanged; if
 * not, the data is restored and the user is told why in Arabic.
 */
async function runGuarded(channel: string, run: () => unknown): Promise<unknown> {
  // The connection is imported lazily, on purpose. A static import would pull
  // `better-sqlite3` — a native module — into every consumer of this file,
  // including the offline verifiers that check the permission table without a
  // database. Requiring it only when a guarded channel actually fires keeps
  // this module importable anywhere.
  let db: any;
  try {
    const mod = await import('../database/connection');
    db = mod.getDb();
  } catch {
    // No database yet (first run). Nothing to protect.
    return run();
  }

  let worthBefore: number | null = null;
  try { worthBefore = netWorth(db); } catch { worthBefore = null; }

  const sp = `bookguard_${(guardDepth += 1)}`;
  try {
    db.exec(`SAVEPOINT ${sp}`);
  } catch {
    // Could not open a savepoint; never block the shop from working.
    guardDepth -= 1;
    return run();
  }

  let result: unknown;
  try {
    result = await run();
  } catch (err) {
    try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* already gone */ }
    guardDepth -= 1;
    throw err;
  }

  // A handler that reported its own failure has normally rolled itself back.
  // Releasing is still correct: there is nothing to undo.
  let verdict;
  try {
    verdict = checkBooks(db, channel, worthBefore);
  } catch {
    verdict = { ok: true as const };
  }

  try {
    if (verdict.ok) {
      db.exec(`RELEASE ${sp}`);
    } else {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    }
  } catch { /* savepoint already unwound by the handler */ }
  guardDepth -= 1;

  if (!verdict.ok && verdict.breach) {
    console.error(
      `[BookGuard] refused ${channel}: ${verdict.breach.rule} — ${verdict.breach.detail}`,
    );
    return {
      success: false,
      code: 'BOOKS_INVARIANT',
      message:
        'تم رفض العملية للحفاظ على سلامة الحسابات. ' +
        verdict.breach.detail +
        ' برجاء إبلاغ الدعم الفني.',
    };
  }

  return result;
}

/** Distinguishes nested savepoints so an inner one cannot release an outer. */
let guardDepth = 0;

/**
 * Trusted user id for handlers that receive `userId` as a POSITIONAL argument
 * rather than inside an object payload. The blanket rewrite in
 * `installIpcGuard` can only reach object payloads, so those handlers must ask
 * for the caller explicitly instead of trusting their parameter.
 *
 * Falls back to the supplied value only when there is no session (which the
 * guard already rejects for non-public channels).
 */
export function getCallerUserId(event: IpcMainInvokeEvent, fallback?: number): number {
  const s = getSession(event.sender.id);
  return s ? s.userId : (fallback ?? 0);
}

/** Exposed so the caller context can be read by handlers that need more than userId. */
export function getCaller(event: IpcMainInvokeEvent): CallerContext | null {
  const s = getSession(event.sender.id);
  if (!s) return null;
  return {
    userId: s.userId,
    username: s.username,
    roleId: s.roleId,
    employeeId: s.employeeId,
    webContentsId: event.sender.id,
  };
}

export const __testing = { CHANNEL_PERMISSIONS, PUBLIC_CHANNELS, AUTHENTICATED_ONLY };
