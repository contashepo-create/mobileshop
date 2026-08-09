/**
 * THE ONE LIST OF EVERY SCREEN IN THE PROGRAM.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The sidebar used to be described in three separate places that each had to
 * agree with the other two, and nothing checked that they did:
 *
 *   1. `sidebar.store.ts`      — which sections exist and what is in them
 *   2. `Sidebar.tsx`           — the icon and label used to DRAW each entry
 *   3. `SidebarSettings.tsx`   — what the user is allowed to reorder
 *
 * Whoever added a screen had to remember all three. Nobody did, every time:
 *
 *   - `/accounting/rent-parties` was added to the store and never to the other
 *     two, so the landlords screen shipped but could not be reached.
 *   - The five accounting sections were added to the store only. `Sidebar.tsx`
 *     still described one `الحسابات`, so it recognised none of the five and
 *     drew NOTHING for them — eleven screens vanished from the program at once
 *     while the settings page still listed them as present.
 *
 * That failure is silent by construction: the store says a section exists, the
 * drawing code has never heard of it, and the `continue` that skips it looks
 * like ordinary defensive coding.
 *
 * So there is now exactly one list. The store, the sidebar and the settings
 * page all read THIS file. Adding a screen means adding one line here, and
 * `verify_sidebar_nav.mjs` fails the build if a route exists that this file
 * does not mention — the mistake cannot be made quietly again.
 */
import {
  LayoutDashboard,
  Package,
  Users,
  Wallet,
  FileText,
  Settings,
  ShoppingCart,
  Wrench,
  Receipt,
  DollarSign,
  UserCircle,
  Truck,
  Banknote,
  CreditCard,
  Calendar,
  ClipboardCheck,
  HardDrive,
  Scale,
  Database,
  Info,
  Smartphone,
  ArrowRightLeft,
  Shield,
  Building2,
  TrendingUp,
  TrendingDown,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** A place the user can actually go. */
export interface NavDestination {
  /** The router path. Must match a `<Route>` in App.tsx. */
  path: string;
  /** What it is called in the menu, before any rename by the shop. */
  label: string;
  icon: LucideIcon;
  /**
   * The section this belongs to when nobody has moved it.
   *
   * This is what lets a screen find its way home. If a saved layout does not
   * mention a destination anywhere — because it was saved before the screen
   * existed, or because the section holding it was deleted — reconciliation
   * puts it back here instead of leaving it unreachable.
   *
   * `null` means it stands on its own at the top level.
   */
  section: string | null;
}

/** A collapsible group in the sidebar. */
export interface NavSectionDef {
  label: string;
  icon: LucideIcon;
}

/**
 * The sections, in the order a shop meets them.
 *
 * `الحسابات` used to hold eleven unrelated screens: sales next to fiscal years
 * next to stocktakes. That groups by "these are all accounting", which is true
 * and useless — nothing in it tells the shop where to look. These follow how
 * the work actually divides, so the name answers "what am I doing" rather than
 * "what is this software".
 *
 * This is the DEFAULT order. Every section can be renamed, reordered or merged
 * from the sidebar settings, and a shop that has arranged its own keeps it.
 */
export const NAV_SECTIONS: NavSectionDef[] = [
  { label: 'المبيعات', icon: ShoppingCart },
  { label: 'المشتريات', icon: Truck },
  { label: 'السندات والرواتب والإيجارات', icon: Receipt },
  { label: 'السنة المالية والأرصدة الافتتاحية', icon: Calendar },
  { label: 'المخازن والتسوية الجردية', icon: Package },
  { label: 'الموارد البشرية', icon: Users },
  { label: 'الأصول', icon: Wallet },
  { label: 'التقارير', icon: FileText },
  { label: 'الإعدادات', icon: Settings },
];

/**
 * Where the top-level entries sit relative to the sections.
 *
 * The dashboard is a destination, not a group, so it cannot live in
 * NAV_SECTIONS; it still has to be first. This says so.
 */
export const NAV_TOP_ORDER: string[] = [
  'لوحة التحكم',
  ...NAV_SECTIONS.map((s) => s.label),
];

/**
 * Every screen, once.
 *
 * The order within a section is the order it is offered in.
 */
export const NAV_DESTINATIONS: NavDestination[] = [
  { path: '/', label: 'لوحة التحكم', icon: LayoutDashboard, section: null },

  // Sales.
  { path: '/accounting/sales', label: 'مبيعات', icon: ShoppingCart, section: 'المبيعات' },
  { path: '/accounting/sale-returns', label: 'مرتجعات المبيعات', icon: Undo2, section: 'المبيعات' },
  { path: '/accounting/services', label: 'تحويل وشحن', icon: Smartphone, section: 'المبيعات' },
  { path: '/accounting/maintenance', label: 'صيانة', icon: Wrench, section: 'المبيعات' },

  { path: '/accounting/purchases', label: 'مشتريات', icon: Truck, section: 'المشتريات' },
  { path: '/accounting/purchase-returns', label: 'مرتجعات المشتريات', icon: Undo2, section: 'المشتريات' },

  // Receipts and payments are split: a shop thinks "money in" and "money out",
  // and they are different daily tasks.
  { path: '/accounting/vouchers-receipt', label: 'سندات القبض', icon: TrendingUp, section: 'السندات والرواتب والإيجارات' },
  { path: '/accounting/vouchers-payment', label: 'سندات الصرف', icon: TrendingDown, section: 'السندات والرواتب والإيجارات' },
  { path: '/accounting/payroll', label: 'رواتب وسلف', icon: DollarSign, section: 'السندات والرواتب والإيجارات' },
  { path: '/accounting/rents', label: 'إيجارات', icon: Banknote, section: 'السندات والرواتب والإيجارات' },
  { path: '/accounting/rent-parties', label: 'المؤجرون والمستأجرون', icon: Building2, section: 'السندات والرواتب والإيجارات' },

  { path: '/accounting/fiscal-year', label: 'السنة المالية', icon: Calendar, section: 'السنة المالية والأرصدة الافتتاحية' },
  { path: '/accounting/opening-balances', label: 'الأرصدة الافتتاحية', icon: Scale, section: 'السنة المالية والأرصدة الافتتاحية' },

  { path: '/inventory', label: 'المخازن والأصناف', icon: Package, section: 'المخازن والتسوية الجردية' },
  { path: '/accounting/settlement', label: 'التسوية الجردية', icon: ClipboardCheck, section: 'المخازن والتسوية الجردية' },

  { path: '/hr/employees', label: 'الموظفين', icon: UserCircle, section: 'الموارد البشرية' },
  { path: '/hr/customers', label: 'العملاء', icon: Users, section: 'الموارد البشرية' },
  { path: '/hr/suppliers', label: 'الموردين', icon: Truck, section: 'الموارد البشرية' },

  { path: '/assets', label: 'البنوك والخزائن', icon: CreditCard, section: 'الأصول' },
  { path: '/assets/payment-methods', label: 'ماكينات الدفع', icon: CreditCard, section: 'الأصول' },
  { path: '/assets/transfers', label: 'تحويلات بين الحسابات', icon: ArrowRightLeft, section: 'الأصول' },

  { path: '/reports', label: 'التقارير العامة', icon: FileText, section: 'التقارير' },
  { path: '/reports/customer-statement', label: 'كشف حساب عميل', icon: Users, section: 'التقارير' },
  { path: '/reports/supplier-statement', label: 'كشف حساب مورد', icon: Truck, section: 'التقارير' },
  { path: '/reports/employee-statement', label: 'كشف حساب موظف', icon: UserCircle, section: 'التقارير' },

  { path: '/settings', label: 'الإعدادات العامة', icon: Settings, section: 'الإعدادات' },
  { path: '/settings/database', label: 'قاعدة البيانات', icon: Database, section: 'الإعدادات' },
  { path: '/settings/license', label: 'الترخيص والاشتراك', icon: Shield, section: 'الإعدادات' },
  { path: '/settings/backup', label: 'النسخ الاحتياطي', icon: HardDrive, section: 'الإعدادات' },
  { path: '/about', label: 'حول البرنامج', icon: Info, section: 'الإعدادات' },
];

/**
 * Routes that exist but are deliberately not offered in the menu.
 *
 * They are still reachable — an old bookmark, a link from another screen, a
 * deep link — so they need a name when one is asked for. They are listed here
 * rather than left out so that the "every route is accounted for" check can
 * tell "intentionally not in the menu" apart from "somebody forgot".
 */
export const NAV_ALIASES: { path: string; label: string; reason: string }[] = [
  { path: '/accounting/vouchers', label: 'سندات', reason: 'صار قسمين: سندات القبض وسندات الصرف' },
  { path: '/inventory/warehouses', label: 'المخازن', reason: 'نفس شاشة المخازن والأصناف' },
  { path: '/inventory/items', label: 'الأصناف', reason: 'نفس شاشة المخازن والأصناف' },
];

/** Routes that exist outside the shell, so the sidebar never draws them. */
export const NAV_OUTSIDE_SHELL = ['/login', '/dev-console'];

// ---------------------------------------------------------------------------
// Derived views. Everything below is computed, so it cannot drift.
// ---------------------------------------------------------------------------

/** path → destination */
export const DESTINATION_BY_PATH: Record<string, NavDestination> = Object.fromEntries(
  NAV_DESTINATIONS.map((d) => [d.path, d]),
);

/** label → section definition */
export const SECTION_BY_LABEL: Record<string, NavSectionDef> = Object.fromEntries(
  NAV_SECTIONS.map((s) => [s.label, s]),
);

/** The top-level entries that are a single link rather than a group. */
export const STANDALONE_DESTINATIONS: NavDestination[] = NAV_DESTINATIONS.filter(
  (d) => d.section === null,
);

/** label → path, for the top-level entries that are a single link. */
export const STANDALONE_PATHS: Record<string, string> = Object.fromEntries(
  STANDALONE_DESTINATIONS.map((d) => [d.label, d.path]),
);

/** section label → the paths it holds by default, in order. */
export const DEFAULT_CHILDREN: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const s of NAV_SECTIONS) out[s.label] = [];
  for (const d of NAV_DESTINATIONS) {
    if (d.section !== null && out[d.section]) out[d.section].push(d.path);
  }
  return out;
})();

/** Every name the menu can need for a path, including the ones it does not offer. */
export const LABEL_BY_PATH: Record<string, string> = {
  ...Object.fromEntries(NAV_DESTINATIONS.map((d) => [d.path, d.label])),
  ...Object.fromEntries(NAV_ALIASES.map((a) => [a.path, a.label])),
};

/**
 * Puts a screen back where it belongs when a saved layout has lost it.
 *
 * A shop's layout is saved the day it arranges it. Every screen added after
 * that day is absent from the saved copy, and merging defaults per-section
 * does not help: the section is present, so the saved list wins whole and the
 * new screen is in none of it. That is how `مرتجعات المبيعات` could be built,
 * routed, and still be invisible to anyone who had ever touched the sidebar.
 *
 * Deleting a custom section had the same effect and was worse — the screens
 * parked inside it were removed with it and never came back.
 *
 * Hiding is not a feature of this program: every screen is meant to be
 * reachable. So a destination that appears nowhere is unambiguously a fault,
 * and this repairs it rather than asking the shop to notice. Anything the shop
 * DID place is left exactly where it put it.
 *
 * @returns the repaired config, or the same object when nothing was missing.
 */
export function reconcileLayout<
  T extends {
    mainOrder: string[];
    childrenOrder: Record<string, string[]>;
    customSections?: Record<string, { label: string }>;
  },
>(config: T): T {
  const placed = new Set<string>();
  for (const list of Object.values(config.childrenOrder)) {
    for (const p of list) placed.add(p);
  }
  // A promoted child sits in mainOrder as its own path.
  for (const entry of config.mainOrder) {
    if (entry.startsWith('/')) placed.add(entry);
  }
  // A standalone entry stands for its path.
  for (const [label, path] of Object.entries(STANDALONE_PATHS)) {
    if (config.mainOrder.includes(label)) placed.add(path);
  }

  const missing = NAV_DESTINATIONS.filter((d) => !placed.has(d.path));
  if (missing.length === 0) return config;

  const mainOrder = [...config.mainOrder];
  const childrenOrder: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(config.childrenOrder)) childrenOrder[k] = [...v];

  for (const dest of missing) {
    if (dest.section === null) {
      // A top-level link. Put it back at the position it holds by default.
      const at = NAV_TOP_ORDER.indexOf(dest.label);
      mainOrder.splice(at === -1 ? mainOrder.length : Math.min(at, mainOrder.length), 0, dest.label);
      continue;
    }
    // Its home section may itself be gone; bring it back in its default place.
    if (!mainOrder.includes(dest.section)) {
      const at = NAV_TOP_ORDER.indexOf(dest.section);
      mainOrder.splice(at === -1 ? mainOrder.length : Math.min(at, mainOrder.length), 0, dest.section);
    }
    if (!childrenOrder[dest.section]) childrenOrder[dest.section] = [];
    // Append rather than insert at the default index: the shop's ordering of
    // what it already has is its own, and a new arrival should not push it
    // around. It goes at the end of its section, where it is easy to spot.
    childrenOrder[dest.section].push(dest.path);
  }

  return { ...config, mainOrder, childrenOrder };
}
