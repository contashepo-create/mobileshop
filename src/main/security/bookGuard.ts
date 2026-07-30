/**
 * Runtime guard over the books.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository already states sixteen universal truths about the books in
 * `scripts/lib/invariants.mjs`, and a fuzzer throws thousands of random
 * operation sequences at them. That machinery has found every accounting fault
 * in this project. But it lives in `scripts/`, which means it protects the
 * DEVELOPER at test time and nobody at all in the shop.
 *
 * The gap that leaves is precise: a fault on a path the fuzzer never reached,
 * or in a module it does not load, reaches the owner's real data silently. The
 * damage is then permanent, because by the time a wrong balance is noticed
 * there is no way to tell which of the day's operations caused it.
 *
 * WHY NOT DOUBLE-ENTRY
 * --------------------
 * The obvious answer to "how do we stop balance errors" is double-entry
 * bookkeeping, and this file is deliberately NOT that. Measured against the
 * real fault found in `delete:maintenanceDelivery` — a customer's debt reversed
 * twice — double-entry catches it only while the mistake is UNBALANCED:
 *
 *   reverse 600 twice, post nothing else      -> rejected, out of balance
 *   reverse 1200 and balance it against income -> ACCEPTED, perfectly balanced,
 *                                                 customer left 600 in credit
 *
 * Double-entry proves a transaction is balanced. It does not prove it is
 * right. A conservation check compares the shop's actual worth before and
 * after, so a "balanced" error is caught just as readily as a lopsided one.
 * That is the property worth having, and it is the one this guard enforces.
 *
 * WHAT IT DOES
 * ------------
 * Wraps every money-moving IPC channel in a SAVEPOINT. After the handler
 * finishes, the invariants are re-checked. If the operation broke one, the
 * savepoint is rolled back and the user is told in Arabic — so the bad write
 * never reaches the database at all, rather than being discovered months later.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not touch a single line of accounting logic. Nothing is re-derived,
 * no balance is recomputed, no handler is rewritten. That restraint is the
 * point: the alternative — routing all 106 manual balance writes through one
 * function — is the same shape of sweeping change that failed six times on the
 * serialised-stock defect. This guard is the safety net that makes that
 * refactor survivable later, not a substitute for it.
 */
import type Database from 'better-sqlite3';

/** A breach: which rule failed, and in plain terms what is wrong. */
export interface Breach {
  rule: string;
  detail: string;
}

const r2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Channels that move money or stock and must therefore be checked.
 *
 * A prefix list rather than an exhaustive one: a new `sales:*` handler is
 * guarded from the moment it is written, which is the opposite of the failure
 * mode this project keeps hitting — a new path nobody remembered to cover.
 */
const GUARDED_PREFIXES = [
  'sales:', 'saleReturns:', 'purchases:', 'purchaseReturns:',
  'maintenance:', 'delete:', 'vouchers:', 'transfers:', 'warehouseTransfers:',
  'services:', 'payroll:', 'salaries:', 'advances:', 'deductions:',
  'settlements:', 'openingBalances:', 'rent:', 'stock:', 'items:',
];

/** Read-only channels inside those prefixes. Checking them wastes time only. */
const READ_ONLY = /(^|:)(list|get|getDetails|returnable|openTickets|statement|summary|getFinancialSummary|getWarrantyHistory|listServiceCosts)$/;

export function isGuardedChannel(channel: string): boolean {
  if (READ_ONLY.test(channel)) return false;
  return GUARDED_PREFIXES.some(p => channel.startsWith(p));
}

/**
 * The rules enforced at runtime.
 *
 * These are the subset of the sixteen test-time invariants that are (a) cheap
 * enough to run after every write and (b) unambiguous enough that failing them
 * always means a genuine fault rather than an unusual but legitimate position.
 *
 * The accounting identity itself is NOT among them: it needs a known opening
 * position, which a live shop that has been trading for months does not have
 * to hand. It is replaced by `worthMovedWithoutReason`, which compares the
 * position immediately before and after a single operation — the same
 * conservation property, measured over a window where it is knowable.
 */
type Rule = (db: Database.Database) => Breach | null;

/** No number in the books may be NaN or Infinity. */
const noNonFiniteMoney: Rule = (db) => {
  const cols: Record<string, string[]> = {
    cash_accounts: ['Balance'],
    payment_methods: ['Balance'],
    customers: ['Balance'],
    suppliers: ['Balance'],
    employees: ['Balance'],
    stock_quantities: ['Quantity', 'CostPrice'],
  };
  for (const [table, list] of Object.entries(cols)) {
    for (const col of list) {
      let rows: { v: number }[];
      try {
        rows = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} IS NOT NULL`).all() as any[];
      } catch { continue; }
      for (const row of rows) {
        if (!Number.isFinite(row.v)) {
          return {
            rule: 'noNonFiniteMoney',
            detail: `القيمة في ${table}.${col} أصبحت غير صالحة (${row.v})`,
          };
        }
      }
    }
  }
  return null;
};

/** Stock may not go negative unless the shop explicitly allowed it. */
const noNegativeStock: Rule = (db) => {
  const allowed = (db.prepare(
    "SELECT Value v FROM settings WHERE Key='allow_negative_stock'",
  ).get() as any)?.v === '1';
  if (allowed) return null;
  const bad = db.prepare(
    'SELECT ItemID, WarehouseID, Quantity FROM stock_quantities WHERE Quantity < -0.001 LIMIT 3',
  ).all() as any[];
  if (!bad.length) return null;
  return {
    rule: 'noNegativeStock',
    detail: 'الكمية في المخزن أصبحت بالسالب: ' +
      bad.map(b => `صنف ${b.ItemID} مخزن ${b.WarehouseID} = ${r2(b.Quantity)}`).join('، '),
  };
};

/** Stock may not be valued at a negative unit cost. */
const noNegativeCost: Rule = (db) => {
  const bad = db.prepare(
    'SELECT ItemID, WarehouseID, CostPrice FROM stock_quantities WHERE CostPrice < -0.001 LIMIT 3',
  ).all() as any[];
  if (!bad.length) return null;
  return {
    rule: 'noNegativeCost',
    detail: 'تكلفة الوحدة أصبحت بالسالب: ' +
      bad.map(b => `صنف ${b.ItemID} = ${r2(b.CostPrice)}`).join('، '),
  };
};

/**
 * A cash box or wallet may not hold less than nothing.
 *
 * Unlike a customer balance — which is legitimately negative when the shop owes
 * a refund — physical cash cannot be. A negative drawer is always either a
 * double deduction or a payment banked to the wrong account.
 */
const noNegativeCash: Rule = (db) => {
  for (const [table, id, name] of [
    ['cash_accounts', 'CashAccountID', 'AccountName'],
    ['payment_methods', 'PaymentMethodID', 'MethodName'],
  ] as const) {
    let bad: any[];
    try {
      bad = db.prepare(
        `SELECT ${id} i, ${name} n, Balance b FROM ${table} WHERE Balance < -0.011 LIMIT 3`,
      ).all() as any[];
    } catch { continue; }
    if (bad.length) {
      return {
        rule: 'noNegativeCash',
        detail: 'الرصيد النقدي أصبح بالسالب: ' +
          bad.map(b => `${b.n} = ${r2(b.b)}`).join('، '),
      };
    }
  }
  return null;
};

/** Every rule, in the order they are cheapest to evaluate. */
const RULES: Rule[] = [
  noNegativeCash,
  noNegativeStock,
  noNegativeCost,
  noNonFiniteMoney,
];

/**
 * Everything the shop is worth, as one number.
 *
 * Deliberately the SAME shape the test-time invariants use, so a fault caught
 * here and a fault caught by the fuzzer are the same measurement.
 */
export function netWorth(db: Database.Database): number {
  const g = (sql: string): number => {
    try { return Number((db.prepare(sql).get() as any)?.v) || 0; } catch { return 0; }
  };
  return r2(
    g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers')
    - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers'),
  );
}

/**
 * Channels whose whole purpose is to move value, where a change in net worth
 * is expected and correct (a sale earns profit, a voucher takes cash out).
 *
 * Everything NOT in this list is a reversal or a rearrangement: cancelling a
 * document, transferring between warehouses, correcting a balance. Those must
 * leave the shop's total worth alone, and it is exactly there that the
 * double-reversal faults in this project have appeared.
 */
const VALUE_NEUTRAL = /^(delete:|warehouseTransfers:|transfers:)/;

/**
 * How far net worth may drift on a neutral operation.
 *
 * Not zero: weighted-average costing legitimately loses fractions of a piastre
 * when a pool is re-averaged, and the existing `inventory_adjustments`
 * machinery records larger, explained write-offs. The threshold catches the
 * class of fault actually seen — whole units of currency appearing or
 * vanishing — without firing on rounding dust.
 */
const NEUTRAL_TOLERANCE = 1.0;

export interface GuardOutcome {
  ok: boolean;
  breach?: Breach;
}

/**
 * Checks the books, including whether a supposedly neutral operation moved the
 * shop's net worth.
 */
export function checkBooks(
  db: Database.Database,
  channel: string,
  worthBefore: number | null,
): GuardOutcome {
  for (const rule of RULES) {
    const breach = rule(db);
    if (breach) return { ok: false, breach };
  }

  if (worthBefore !== null && VALUE_NEUTRAL.test(channel)) {
    const moved = r2(netWorth(db) - worthBefore);
    if (Math.abs(moved) > NEUTRAL_TOLERANCE) {
      return {
        ok: false,
        breach: {
          rule: 'worthMovedWithoutReason',
          detail:
            `هذه العملية كان يجب ألا تغيّر صافي قيمة المحل، لكنها غيّرته بمقدار ${moved}. ` +
            'تم إلغاء العملية والبيانات كما كانت.',
        },
      };
    }
  }

  return { ok: true };
}
