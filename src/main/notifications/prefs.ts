/**
 * Smart-notification preferences: the catalogue of rules and the shop's
 * choices about them.
 *
 * WHY A CATALOGUE INSTEAD OF LOOSE SETTINGS KEYS
 * ----------------------------------------------
 * Every alert the engine can raise is declared here once, together with the
 * numbers that drive it and the limits those numbers may take. The settings
 * screen is *generated* from this catalogue, so a rule can never exist in the
 * engine without a control in the UI, and a control can never point at a
 * threshold the engine ignores. Adding a rule in one place adds it everywhere.
 *
 * WHAT THE SHOP OWNER CONTROLS vs WHAT THE DEVELOPER CONTROLS
 * -----------------------------------------------------------
 * Everything in this file is the SHOP's business data — their customers, their
 * stock, their cash. They may switch any of it off, retune it, or silence it
 * at night.
 *
 * Messages from the developer are deliberately NOT here. They travel a
 * completely separate path (`remote:pendingNotices` -> `NoticeCenter`) and are
 * not filtered by any preference in this module. A customer cannot switch off
 * a licence-expiry warning or a maintenance announcement, because those are the
 * messages they most need to see. There is a test that fails if the two paths
 * are ever wired together.
 *
 * STORAGE
 * -------
 * One JSON row in `settings` under `notif_prefs`. A single row keeps a save
 * atomic — a half-applied set of thresholds could silence an alert the owner
 * believed was on. Unknown keys and out-of-range numbers are dropped on write
 * AND clamped on read, so a corrupted or hand-edited row degrades to defaults
 * instead of breaking the bell.
 */

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

export interface RuleParam {
  key: string;
  label: string;
  /** Drives the input's unit suffix and validation in the UI. */
  unit: 'money' | 'days' | 'count';
  def: number;
  min: number;
  max: number;
  hint?: string;
}

export interface NotificationRule {
  id: string;
  category: 'customer' | 'supplier' | 'maintenance' | 'inventory' | 'employee' | 'financial';
  label: string;
  description: string;
  icon: string;
  defEnabled: boolean;
  defPriority: Priority;
  params: RuleParam[];
}

export const CATEGORY_LABELS: Record<string, string> = {
  customer: 'العملاء',
  supplier: 'الموردين',
  maintenance: 'الصيانة',
  inventory: 'المخزون',
  employee: 'الموظفين',
  financial: 'الخزينة والمالية',
};

/**
 * The complete rule catalogue.
 *
 * Defaults reproduce the behaviour the app shipped with, so upgrading changes
 * nothing until the owner deliberately retunes something.
 */
export const NOTIFICATION_RULES: NotificationRule[] = [
  // ------------------------------------------------------------- customers
  {
    id: 'customer_overdue',
    category: 'customer',
    label: 'عميل متأخر عن السداد',
    description: 'عميل عليه رصيد ولم يتعامل معك منذ فترة.',
    icon: 'users',
    defEnabled: true,
    defPriority: 'high',
    params: [
      { key: 'minBalance', label: 'أقل رصيد يستحق التنبيه', unit: 'money', def: 1, min: 0, max: 10_000_000,
        hint: 'تجاهل المبالغ الصغيرة جداً' },
      { key: 'days', label: 'عدد الأيام بدون تعامل', unit: 'days', def: 30, min: 1, max: 3650 },
      { key: 'highAfter', label: 'يصبح «مهم» بعد', unit: 'days', def: 45, min: 1, max: 3650 },
      { key: 'criticalAfter', label: 'يصبح «حرج» بعد', unit: 'days', def: 60, min: 1, max: 3650 },
    ],
  },
  {
    id: 'customer_high_balance',
    category: 'customer',
    label: 'رصيد عميل مرتفع',
    description: 'تنبيه عندما يتجاوز رصيد العميل حداً معيناً.',
    icon: 'users',
    defEnabled: true,
    defPriority: 'medium',
    params: [
      { key: 'threshold', label: 'الرصيد الذي يبدأ عنده التنبيه', unit: 'money', def: 3000, min: 1, max: 10_000_000 },
      { key: 'limit', label: 'أقصى عدد عملاء يُعرضون', unit: 'count', def: 10, min: 1, max: 200 },
    ],
  },
  {
    id: 'customer_suspended',
    category: 'customer',
    label: 'عملاء محظورون',
    description: 'تذكير بوجود عملاء موقوفين.',
    icon: 'users',
    defEnabled: true,
    defPriority: 'low',
    params: [],
  },

  // ------------------------------------------------------------- suppliers
  {
    id: 'supplier_overdue',
    category: 'supplier',
    label: 'مورد مستحق الدفع',
    description: 'مورد له رصيد ولم تشترِ منه منذ فترة.',
    icon: 'truck',
    defEnabled: true,
    defPriority: 'medium',
    params: [
      { key: 'minBalance', label: 'أقل مبلغ مستحق', unit: 'money', def: 1, min: 0, max: 10_000_000 },
      { key: 'days', label: 'عدد الأيام بدون تعامل', unit: 'days', def: 30, min: 1, max: 3650 },
      { key: 'highAfter', label: 'يصبح «مهم» بعد', unit: 'days', def: 45, min: 1, max: 3650 },
    ],
  },

  // ----------------------------------------------------------- maintenance
  {
    id: 'maintenance_overdue',
    category: 'maintenance',
    label: 'صيانة متأخرة عن موعد التسليم',
    description: 'تذكرة تجاوزت تاريخ التسليم المتفق عليه.',
    icon: 'wrench',
    defEnabled: true,
    defPriority: 'high',
    params: [
      { key: 'highAfter', label: 'تصبح «مهمة» بعد تأخير', unit: 'days', def: 3, min: 1, max: 365 },
      { key: 'criticalAfter', label: 'تصبح «حرجة» بعد تأخير', unit: 'days', def: 7, min: 1, max: 365 },
    ],
  },
  {
    id: 'maintenance_stale',
    category: 'maintenance',
    label: 'صيانة معلّقة بدون تحديث',
    description: 'تذكرة ما زالت «مستلمة» أو «تحت الفحص» منذ فترة.',
    icon: 'wrench',
    defEnabled: true,
    defPriority: 'medium',
    params: [
      { key: 'days', label: 'عدد الأيام بدون تحديث', unit: 'days', def: 7, min: 1, max: 365 },
    ],
  },

  // ------------------------------------------------------------- inventory
  {
    id: 'inventory_low_stock',
    category: 'inventory',
    label: 'مخزون منخفض',
    description: 'صنف وصل إلى الحد الأدنى المحدَّد له في كارت الصنف.',
    icon: 'package',
    defEnabled: true,
    defPriority: 'high',
    params: [
      { key: 'limit', label: 'أقصى عدد أصناف تُعرض', unit: 'count', def: 50, min: 1, max: 500 },
    ],
  },
  {
    id: 'inventory_out_of_stock',
    category: 'inventory',
    label: 'نفاد مخزون',
    description: 'صنف نشط رصيده صفر.',
    icon: 'package',
    defEnabled: true,
    defPriority: 'high',
    params: [
      { key: 'limit', label: 'أقصى عدد أصناف تُعرض', unit: 'count', def: 20, min: 1, max: 500 },
    ],
  },
  {
    id: 'inventory_slow_moving',
    category: 'inventory',
    label: 'صنف بطيء الحركة',
    description: 'صنف متوفر في المخزون ولم يُبَع منذ فترة طويلة.',
    icon: 'package',
    defEnabled: true,
    defPriority: 'low',
    params: [
      { key: 'days', label: 'عدد الأيام بدون بيع', unit: 'days', def: 60, min: 1, max: 3650 },
      { key: 'minStock', label: 'أقل كمية بالمخزون تستحق التنبيه', unit: 'count', def: 1, min: 1, max: 1_000_000 },
      { key: 'limit', label: 'أقصى عدد أصناف تُعرض', unit: 'count', def: 10, min: 1, max: 500 },
    ],
  },

  // ------------------------------------------------------------- employees
  {
    id: 'employee_salary_due',
    category: 'employee',
    label: 'راتب معلّق',
    description: 'موظف له رصيد مستحق لم يُصرف.',
    icon: 'user',
    defEnabled: true,
    defPriority: 'medium',
    params: [
      { key: 'minBalance', label: 'أقل مبلغ مستحق', unit: 'money', def: 1, min: 0, max: 10_000_000 },
    ],
  },
  {
    id: 'employee_commissions',
    category: 'employee',
    label: 'عمولات غير مدفوعة',
    description: 'عمولات مستحقة للموظفين ولم تُصرف بعد.',
    icon: 'user',
    defEnabled: true,
    defPriority: 'low',
    params: [
      { key: 'minTotal', label: 'أقل إجمالي عمولات', unit: 'money', def: 1, min: 0, max: 10_000_000 },
    ],
  },

  // ------------------------------------------------------------- financial
  {
    id: 'cash_low',
    category: 'financial',
    label: 'رصيد خزينة منخفض',
    description: 'حساب نقدي انخفض تحت الحد الآمن.',
    icon: 'wallet',
    defEnabled: true,
    defPriority: 'medium',
    params: [
      { key: 'threshold', label: 'الحد الأدنى الآمن للرصيد', unit: 'money', def: 1000, min: 0, max: 10_000_000 },
    ],
  },
];

const RULE_BY_ID = new Map(NOTIFICATION_RULES.map(r => [r.id, r]));

// ---------------------------------------------------------------- global

export interface GlobalPrefs {
  enabled: boolean;
  minPriority: Priority;
  maxItems: number;
  refreshMinutes: number;
  quietEnabled: boolean;
  /** Local hour, 0-23. `from` may be greater than `to` (overnight window). */
  quietFrom: number;
  quietTo: number;
  /** Critical alerts can be allowed to pierce the quiet window. */
  quietAllowCritical: boolean;
  /** Which weekdays produce alerts. Index 0 = Sunday. */
  days: boolean[];
}

export const DEFAULT_GLOBAL: GlobalPrefs = {
  enabled: true,
  minPriority: 'low',
  maxItems: 50,
  refreshMinutes: 1,
  quietEnabled: false,
  quietFrom: 22,
  quietTo: 8,
  quietAllowCritical: true,
  days: [true, true, true, true, true, true, true],
};

export interface RuleState {
  enabled: boolean;
  priority: Priority;
  params: Record<string, number>;
}

export interface Prefs {
  global: GlobalPrefs;
  rules: Record<string, RuleState>;
}

// ---------------------------------------------------------------- helpers

const isPriority = (v: unknown): v is Priority =>
  v === 'critical' || v === 'high' || v === 'medium' || v === 'low';

/**
 * Clamps into range. A non-finite value (NaN from a blanked input, or a string
 * that survived JSON) falls back to the default rather than poisoning a
 * comparison — `x > NaN` is always false, which would silently disable a rule.
 */
function clamp(value: unknown, min: number, max: number, def: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Defaults for one rule, used as the base for every merge. */
export function defaultRuleState(rule: NotificationRule): RuleState {
  const params: Record<string, number> = {};
  for (const p of rule.params) params[p.key] = p.def;
  return { enabled: rule.defEnabled, priority: rule.defPriority, params };
}

export function defaultPrefs(): Prefs {
  const rules: Record<string, RuleState> = {};
  for (const r of NOTIFICATION_RULES) rules[r.id] = defaultRuleState(r);
  return { global: { ...DEFAULT_GLOBAL, days: [...DEFAULT_GLOBAL.days] }, rules };
}

/**
 * Merges stored JSON over the defaults.
 *
 * Deliberately additive: anything missing, unknown, or out of range is replaced
 * by its default. That means a preferences row written by an older version, or
 * one that lost a key, still yields a complete and valid configuration.
 */
export function normalisePrefs(raw: unknown): Prefs {
  const base = defaultPrefs();
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as any;

  const g = input.global;
  if (g && typeof g === 'object') {
    if (typeof g.enabled === 'boolean') base.global.enabled = g.enabled;
    if (isPriority(g.minPriority)) base.global.minPriority = g.minPriority;
    base.global.maxItems = clamp(g.maxItems, 1, 500, DEFAULT_GLOBAL.maxItems);
    base.global.refreshMinutes = clamp(g.refreshMinutes, 1, 240, DEFAULT_GLOBAL.refreshMinutes);
    if (typeof g.quietEnabled === 'boolean') base.global.quietEnabled = g.quietEnabled;
    base.global.quietFrom = clamp(g.quietFrom, 0, 23, DEFAULT_GLOBAL.quietFrom);
    base.global.quietTo = clamp(g.quietTo, 0, 23, DEFAULT_GLOBAL.quietTo);
    if (typeof g.quietAllowCritical === 'boolean') {
      base.global.quietAllowCritical = g.quietAllowCritical;
    }
    if (Array.isArray(g.days) && g.days.length === 7) {
      base.global.days = g.days.map((d: unknown) => d !== false);
    }
  }

  const r = input.rules;
  if (r && typeof r === 'object') {
    for (const [id, stateRaw] of Object.entries(r)) {
      const rule = RULE_BY_ID.get(id);
      // Unknown ids are dropped: a stale or injected rule must never reach the
      // engine, which would then run a query nobody reviewed.
      if (!rule || !stateRaw || typeof stateRaw !== 'object') continue;
      const state = stateRaw as any;
      const target = base.rules[id];
      if (typeof state.enabled === 'boolean') target.enabled = state.enabled;
      if (isPriority(state.priority)) target.priority = state.priority;
      if (state.params && typeof state.params === 'object') {
        for (const p of rule.params) {
          if (p.key in state.params) {
            target.params[p.key] = clamp(state.params[p.key], p.min, p.max, p.def);
          }
        }
      }
    }
  }

  return base;
}

// ---------------------------------------------------------------- timing

/**
 * True when the current moment falls inside the shop's quiet window.
 *
 * Handles the overnight case (22:00 -> 08:00) by testing the union of the two
 * spans rather than a single range, which would silently never match.
 * `from === to` is treated as "no quiet period" instead of "quiet all day",
 * because a full-day silence is almost certainly a mis-set field, and silently
 * hiding every alert forever is the worse failure.
 */
export function isQuietHour(prefs: Prefs, now: Date): boolean {
  const g = prefs.global;
  if (!g.quietEnabled) return false;
  if (g.quietFrom === g.quietTo) return false;
  const h = now.getHours();
  return g.quietFrom < g.quietTo
    ? h >= g.quietFrom && h < g.quietTo
    : h >= g.quietFrom || h < g.quietTo;
}

/** True when today is a day the shop wants alerts on. */
export function isActiveDay(prefs: Prefs, now: Date): boolean {
  return prefs.global.days[now.getDay()] !== false;
}

export interface SuppressionResult {
  /** Priorities at or above this rank survive. */
  allowed: (p: Priority) => boolean;
  suppressed: boolean;
  reason: 'off' | 'day' | 'quiet' | 'none';
}

/**
 * The single place that decides what may be shown right now.
 *
 * Returned as a predicate rather than a boolean so the caller cannot
 * accidentally apply the day rule and forget the priority floor.
 */
export function evaluateSuppression(prefs: Prefs, now: Date): SuppressionResult {
  const floor = PRIORITY_ORDER[prefs.global.minPriority];
  const meetsFloor = (p: Priority) => PRIORITY_ORDER[p] <= floor;

  if (!prefs.global.enabled) {
    return { allowed: () => false, suppressed: true, reason: 'off' };
  }
  if (!isActiveDay(prefs, now)) {
    return { allowed: () => false, suppressed: true, reason: 'day' };
  }
  if (isQuietHour(prefs, now)) {
    // Critical alerts may pierce the quiet window: a till that cannot pay
    // suppliers at 23:00 is still worth knowing about at 23:00.
    return prefs.global.quietAllowCritical
      ? { allowed: p => p === 'critical' && meetsFloor(p), suppressed: true, reason: 'quiet' }
      : { allowed: () => false, suppressed: true, reason: 'quiet' };
  }
  return { allowed: meetsFloor, suppressed: false, reason: 'none' };
}

/** Convenience accessor used throughout the engine. */
export function ruleState(prefs: Prefs, id: string): RuleState {
  const rule = RULE_BY_ID.get(id);
  return prefs.rules[id] ?? (rule ? defaultRuleState(rule) : {
    enabled: false, priority: 'low', params: {},
  });
}

/** Numeric parameter with its catalogue default as the fallback. */
export function param(prefs: Prefs, ruleId: string, key: string): number {
  const rule = RULE_BY_ID.get(ruleId);
  const def = rule?.params.find(p => p.key === key)?.def ?? 0;
  const v = ruleState(prefs, ruleId).params[key];
  return Number.isFinite(v) ? v : def;
}
