/**
 * Server-side input validation for every value that arrives from the renderer.
 *
 * WHY THIS EXISTS
 * ---------------
 * An audit of the 250 IPC channels compared what the SCREENS refuse against
 * what the HANDLERS refuse, and the two lists barely overlapped. 106 guards
 * were counted in the React pages; the matching check in the main process was
 * usually absent. Some of what that allowed was measured against the real
 * handlers, not reasoned about:
 *
 *   - `vouchers:create` with `VoucherType: 'RECEIPT'` (capitals) took 5,000
 *     out of the safe. Every report filters `WHERE VoucherType = 'receipt'`
 *     or `'payment'`, so the row matched neither: the money left the till and
 *     no statement, ledger or P&L could account for it.
 *
 *   - `maintenance:updateStatus` accepted any string, including `'delivered'`.
 *     `maintenance:deliver` — the handler that actually bills the customer —
 *     refuses a ticket that is already `delivered`. So one call marked a
 *     device handed over and permanently blocked the invoice: 800 EGP of work
 *     that the shop could never charge for.
 *
 *   - `customers:create` stored a name of 5,000,000 characters, and also the
 *     empty string, and also eight spaces. The screen requires a name; the
 *     handler never did.
 *
 *   - `settings:set` wrote `db_path`, `cloud_api_key`, `telegram_bot_token`
 *     and `allow_negative_stock`. `settings:get` has a deny-list for exactly
 *     those keys — reading them was closed, writing them was wide open.
 *
 * The renderer is not a security boundary. It is a *convenience* boundary: it
 * exists so the user is told about a mistake before the round trip. Anything
 * reachable through `window.api.invoke` is reachable from the DevTools console
 * of the shop's own machine, from a script pasted by a customer "helping" with
 * a problem, and — because `window.open` children inherit the preload bundle —
 * from injected markup in a printed statement.
 *
 * HOW TO USE IT
 * -------------
 * Every function returns either a value or a message; nothing throws, because
 * the handlers all answer `{ success: false, message }` and an Arabic string is
 * what the toast needs.
 *
 *     const name = requireText(data.Name, 'اسم العميل', LIMITS.NAME);
 *     if (!name.ok) return { success: false, message: name.message };
 *     // name.value is trimmed, control characters removed, length-capped
 *
 * For several fields at once:
 *
 *     const bad = firstProblem([
 *       [() => requireText(data.Name, 'الاسم', LIMITS.NAME)],
 *       [() => optionalText(data.Phone, 'الهاتف', LIMITS.PHONE)],
 *     ]);
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not escape HTML. Escaping belongs at the point of OUTPUT — see
 * `src/shared/escapeHtml.ts`, which every printing path already uses — because
 * a value escaped on the way in is double-escaped the moment it is shown in a
 * React text node, and a customer legitimately named "محل الأخوة & أولاده"
 * would be stored as `&amp;`. What this module removes is the class of
 * character that has no legitimate place in a business record at all:
 * C0/C1 control codes, which corrupt printed documents and CSV exports.
 */

// ---------------------------------------------------------------- limits
/**
 * Length ceilings, in characters.
 *
 * These are not arbitrary. Each is generous enough for the longest real value
 * the field can hold in Egyptian commerce and small enough that a hostile
 * caller cannot use the field as storage. A person's name is not 5,000,000
 * characters; a database that accepts one has a denial-of-service bug wearing
 * a text box.
 */
export const LIMITS = {
  /** Party, item, warehouse, category, role and account names. */
  NAME: 200,
  /** Usernames — long enough for an email address, short enough to display. */
  USERNAME: 64,
  /** Phone numbers, including a country code and separators. */
  PHONE: 32,
  /** Email addresses. RFC 5321 caps the whole address at 254. */
  EMAIL: 254,
  /** Postal addresses. */
  ADDRESS: 500,
  /** Free-text notes, descriptions and problem reports. */
  NOTES: 2000,
  /** Short descriptive lines that appear on a printed document. */
  DESCRIPTION: 500,
  /** Barcodes and serial numbers — EAN/UPC/IMEI plus room for custom codes. */
  CODE: 64,
  /** Search boxes. Beyond this SQLite itself rejects the LIKE pattern. */
  SEARCH: 100,
  /** A settings value. Print templates are the largest legitimate one. */
  SETTING_VALUE: 20000,
  /** A settings key. */
  SETTING_KEY: 100,
} as const;

// ---------------------------------------------------------------- result type
export interface Ok<T> { ok: true; value: T }
export interface Bad { ok: false; message: string }
export type Result<T> = Ok<T> | Bad;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const bad = (message: string): Bad => ({ ok: false, message });

// ---------------------------------------------------------------- sanitising
/**
 * Removes characters that cannot appear in a legitimate business record.
 *
 * The set is the C0 control block minus tab/newline/carriage-return, plus DEL
 * and the C1 block. These are not a theoretical concern:
 *
 *   - `\u0000` truncates the value in any C consumer, including some printer
 *     drivers and the CSV export;
 *   - `\r` alone rewrites a line in a terminal or a log file, which is how a
 *     forged audit-log entry is built;
 *   - `\u202E` (RIGHT-TO-LEFT OVERRIDE) reverses the display of everything
 *     after it. In an app that is already right-to-left this is invisible to
 *     the reader and can make `‮1.00` render as a different number on an
 *     invoice.
 *
 * Newlines and tabs are KEPT: an address and a note are legitimately
 * multi-line, and stripping them would silently mangle real data.
 */
export function stripControlChars(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    '',
  );
}

/**
 * Collapses runs of whitespace and trims the ends.
 *
 * Applied to NAMES only, never to notes. "محمد    عبده" and "محمد عبده" are
 * the same customer, and storing both makes the list screen show two people
 * who look identical. A multi-line note, by contrast, means what it says.
 */
export function collapseSpaces(input: string): string {
  return input.replace(/[ \t]+/g, ' ').trim();
}

// ---------------------------------------------------------------- text
/**
 * A required piece of text: present, non-blank, sanitised and length-capped.
 *
 * Rejects rather than truncates. Silently cutting a value to fit is how a
 * record ends up wrong instead of absent, and absent is the honest answer to
 * an input the caller should not have sent.
 */
export function requireText(raw: unknown, label: string, max: number): Result<string> {
  if (raw === null || raw === undefined) return bad(`${label} مطلوب`);
  if (typeof raw !== 'string') {
    // Numbers are accepted — a barcode typed into a number-typed input arrives
    // as one — but objects and arrays are a programming error or an attack,
    // and `String({})` would store the literal text "[object Object]".
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return bad(`${label} يجب أن يكون نصاً`);
    }
    raw = String(raw);
  }
  const cleaned = collapseSpaces(stripControlChars(raw as string));
  if (!cleaned) return bad(`${label} مطلوب`);
  if (cleaned.length > max) return bad(`${label} أطول من الحد المسموح (${max} حرف)`);
  return ok(cleaned);
}

/**
 * An optional piece of text. Blank, null and undefined all become `null`, so
 * the column holds a real NULL rather than an empty string — the two are
 * different in every `COALESCE` and `IS NULL` in the reports.
 */
export function optionalText(raw: unknown, label: string, max: number): Result<string | null> {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return bad(`${label} يجب أن يكون نصاً`);
  const cleaned = collapseSpaces(stripControlChars(raw));
  if (!cleaned) return ok(null);
  if (cleaned.length > max) return bad(`${label} أطول من الحد المسموح (${max} حرف)`);
  return ok(cleaned);
}

/**
 * Multi-line free text — notes, descriptions, problem reports.
 *
 * Differs from `optionalText` in that internal newlines survive. Only the
 * ends are trimmed and runs of blank lines are left alone, because a
 * technician's note is written the way they wrote it.
 */
export function optionalNote(raw: unknown, label: string, max = LIMITS.NOTES): Result<string | null> {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return bad(`${label} يجب أن يكون نصاً`);
  const cleaned = stripControlChars(raw).trim();
  if (!cleaned) return ok(null);
  if (cleaned.length > max) return bad(`${label} أطول من الحد المسموح (${max} حرف)`);
  return ok(cleaned);
}

// ---------------------------------------------------------------- allow-lists
/**
 * Restricts a value to a fixed set.
 *
 * This is the check whose absence cost the most in the audit. An enum column
 * with no allow-list is not a string column — it is a column where exactly one
 * spelling works and every other spelling silently detaches the row from every
 * query that reads it.
 *
 * Matching is EXACT, deliberately. Accepting `'RECEIPT'` by lower-casing it
 * would be friendlier and wrong: the caller that sent it is not the screen
 * (the screen sends a constant), so the request is either a bug worth
 * surfacing or an attempt worth refusing.
 */
export function oneOf<T extends string>(
  raw: unknown,
  label: string,
  allowed: readonly T[],
): Result<T> {
  if (typeof raw !== 'string' || !raw) return bad(`${label} مطلوب`);
  if (!(allowed as readonly string[]).includes(raw)) {
    return bad(`${label} غير صالح — القيم المسموحة: ${allowed.join('، ')}`);
  }
  return ok(raw as T);
}

/** As `oneOf`, but absence is allowed and yields `null`. */
export function optionalOneOf<T extends string>(
  raw: unknown,
  label: string,
  allowed: readonly T[],
): Result<T | null> {
  if (raw === null || raw === undefined || raw === '') return ok(null);
  return oneOf(raw, label, allowed);
}

// ---------------------------------------------------------------- identifiers
/**
 * A database row id: a positive whole number.
 *
 * `Number('12abc')` is NaN but `parseInt('12abc')` is 12, and a handler that
 * used the second would look up the wrong row. Only a value that is entirely
 * numeric is accepted.
 */
export function requireId(raw: unknown, label: string): Result<number> {
  // Only a number or a string of digits. Everything else is refused OUTRIGHT
  // rather than coerced, because JavaScript's coercions are far too generous
  // to be an identity check:
  //
  //     Number([1])            === 1     an array of one becomes that one
  //     Number({toString:()=>'1'}) === 1 any object can claim to be an id
  //     Number(' 1 ')          === 1     surrounding whitespace is ignored
  //     Number('1.0')          === 1     a decimal that happens to be whole
  //     Number(true)           === 1     a boolean
  //
  // MEASURED against `customers:update`: `[1]` and `{toString:()=>'1'}` both
  // reached customer 1 and renamed it. No screen sends any of these — every
  // call site passes the integer straight off the row it just read
  // (`editing.CustomerID`) — so nothing legitimate is lost by insisting.
  //
  // `'1.0'` and `' 1 '` are refused too. They are harmless in isolation, but
  // an identity that has more than one spelling is an identity that can be
  // used to slip past a comparison somewhere else.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return bad(`${label} غير صالح`);
  }
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    return bad(`${label} غير صالح`);
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return bad(`${label} غير صالح`);
  }
  // Beyond this an integer is no longer exactly representable, so two
  // different ids can compare equal.
  if (n > Number.MAX_SAFE_INTEGER) return bad(`${label} غير صالح`);
  return ok(n);
}

/** As `requireId`, but absence yields `null`. */
export function optionalId(raw: unknown, label: string): Result<number | null> {
  if (raw === null || raw === undefined || raw === '') return ok(null);
  return requireId(raw, label);
}

/**
 * A 0/1 flag.
 *
 * Measured: `items:create` with `IsSerialized: 99` stored 99. Every consumer
 * tests `IsSerialized === 1` or `IsSerialized ? ... : ...`, so 99 is
 * simultaneously "not serialised" to one branch and "truthy" to another.
 */
export function requireFlag(raw: unknown, label: string, fallback: 0 | 1 = 0): Result<0 | 1> {
  if (raw === null || raw === undefined || raw === '') return ok(fallback);
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return ok(1);
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return ok(0);
  return bad(`${label} يجب أن يكون نعم أو لا`);
}

// ---------------------------------------------------------------- dates
/**
 * A calendar date in `YYYY-MM-DD`, verified to be a date that exists.
 *
 * The shape test alone is not enough: `2026-02-31` and `2026-13-45` both match
 * `\d{4}-\d{2}-\d{2}`. Round-tripping through `Date` catches both, because
 * JavaScript normalises 31 February to 3 March and the formatted result no
 * longer equals the input.
 *
 * The range is bounded too. A hire date of `1899-01-01` or `3026-01-01` is not
 * a business record; it is a value that will sort to one end of every report
 * forever.
 */
export function requireDate(raw: unknown, label: string): Result<string> {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return bad(`${label} يجب أن يكون تاريخاً صالحاً (YYYY-MM-DD)`);
  }
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return bad(`${label} تاريخ غير موجود`);
  }
  if (y < 2000 || y > 2100) return bad(`${label} خارج النطاق المسموح`);
  return ok(raw);
}

/** As `requireDate`, but absence yields `null`. */
export function optionalDate(raw: unknown, label: string): Result<string | null> {
  if (raw === null || raw === undefined || raw === '') return ok(null);
  return requireDate(raw, label);
}

// ---------------------------------------------------------------- search
/**
 * Prepares a user-typed search term for a `LIKE` clause.
 *
 * Two separate problems, both measured:
 *
 *   1. LENGTH. A 60,000-character term made SQLite itself throw
 *      "LIKE or GLOB pattern too complex", which crossed the IPC boundary as a
 *      generic handler error and left the screen blank. Capped here.
 *
 *   2. METACHARACTERS. `%` and `_` are wildcards inside LIKE. A search for `%`
 *      returned every row in the table regardless of the filter the user
 *      thought they were applying, and `_` matched any single character. These
 *      are escaped so a customer whose name genuinely contains `%` is findable
 *      and a caller cannot widen someone else's filter.
 *
 * The caller must pair this with `ESCAPE '\'` in the SQL. Returning the term
 * pre-wrapped in `%...%` would hide that requirement, so it does not.
 */
export function searchTerm(raw: unknown, max = LIMITS.SEARCH): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return null;
  const cleaned = stripControlChars(raw).trim().slice(0, max);
  if (!cleaned) return null;
  // Backslash FIRST, or the escapes added below would themselves be escaped.
  return cleaned.replace(/[\\%_]/g, (c) => '\\' + c);
}

// ---------------------------------------------------------------- composition
/**
 * Runs several checks and returns the first failure message, or null.
 *
 * Thunks rather than values, so a later check never evaluates against an
 * earlier one's rejected input.
 */
export function firstProblem(checks: Array<() => Result<unknown>>): string | null {
  for (const check of checks) {
    const r = check();
    if (!r.ok) return r.message;
  }
  return null;
}

// ---------------------------------------------------------------- domain enums
/**
 * The vocabularies the database actually uses.
 *
 * Each list was read off the queries that CONSUME the column, not off the
 * screen that writes it — the screen can only ever tell you what one caller
 * sends, while the consumers tell you what the rest of the system understands.
 * `VOUCHER_TYPES` is exactly the set that appears in
 * `WHERE VoucherType = ...` across reports, statements and payroll.
 */
export const VOUCHER_TYPES = ['receipt', 'payment'] as const;
export const PARTY_TYPES = ['customer', 'supplier', 'employee', 'general'] as const;
export const PARTY_STATUSES = ['active', 'warned', 'suspended'] as const;
export const ITEM_TYPES = ['phone', 'accessory', 'service'] as const;
/**
 * Warehouse kinds, read off the `<option>` values in InventoryPage.tsx.
 *
 * A first draft guessed `['main','branch','maintenance','damaged']`. The form
 * offers exactly three — `main`, `maintenance`, `other` — and the list badge
 * renders anything that is neither of the first two as "أخرى". Guessing would
 * have refused `other` (a value the shop can pick) while accepting `branch`
 * and `damaged` (values nothing produces or understands).
 */
export const WAREHOUSE_TYPES = ['main', 'maintenance', 'other'] as const;
/**
 * Cash-box kinds: a physical safe, or a bank account.
 *
 * `'safe'`, NOT `'cash'`. A first draft of this list said `['cash','bank']`,
 * which would have refused every cash box the shop creates — the dropdown in
 * AssetsPage.tsx offers `<option value="safe">خزنة</option>`, the statement
 * header prints `AccountType === 'safe' ? 'خزنة' : 'بنك'`, and the badge in
 * the list does the same. The only occurrences of `'cash'` anywhere were the
 * two lines of that draft.
 *
 * Caught by an existing suite (`verify_master_data.mjs`) failing, which is the
 * argument for running the whole battery rather than only the new file: an
 * allow-list written from the wrong source is a self-inflicted outage.
 */
export const CASH_ACCOUNT_TYPES = ['safe', 'bank'] as const;
export const RENT_TYPES = ['expense', 'income'] as const;
export const RENT_PERIODS = ['monthly', 'yearly'] as const;

/**
 * Maintenance ticket states.
 *
 * `delivered`, `cancelled` and `returned` are TERMINAL and are reached only
 * through the handlers that do the accompanying bookkeeping —
 * `maintenance:deliver`, `:cancel` and `:return`. `maintenance:updateStatus`
 * is the technician's progress switch and must never reach them: setting
 * `delivered` there marked the device handed over while
 * `maintenance:deliver` then refused to bill it, which was measured at 800 EGP
 * of unbillable work per ticket.
 */
export const MAINTENANCE_WORKFLOW_STATUSES = [
  'received', 'inspecting', 'in_progress', 'ready',
] as const;
export const MAINTENANCE_TERMINAL_STATUSES = [
  'delivered', 'cancelled', 'returned',
] as const;
export const MAINTENANCE_ALL_STATUSES = [
  ...MAINTENANCE_WORKFLOW_STATUSES, ...MAINTENANCE_TERMINAL_STATUSES,
] as const;
