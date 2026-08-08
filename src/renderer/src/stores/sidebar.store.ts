import { create } from 'zustand';
import {
  NAV_TOP_ORDER,
  DEFAULT_CHILDREN,
  STANDALONE_PATHS,
  LABEL_BY_PATH,
  SECTION_BY_LABEL,
  DESTINATION_BY_PATH as NAV_DESTINATIONS_BY_PATH,
  reconcileLayout,
} from '../lib/navCatalog';

const STORAGE_KEY = 'sidebarConfig';

// عند الانتهاء من كافة تعديلات النظام وقبل إنشاء الملف التنفيذي:
// 1. قم بترتيب القائمة الجانبية كما تريدها أن تظهر للمستخدم الجديد
// 2. افتح المتصفح (F12) واكتب في الـ Console:
//    localStorage.setItem('sidebarConfig_frozen', JSON.stringify(JSON.parse(localStorage.getItem('sidebarConfig'))))
// 3. غيّر FREEZE_DEFAULTS إلى true
// 4. هذا سيُحمّل التنسيق الحالي كافتراضي لكل المستخدمين الجدد
const FREEZE_DEFAULTS = false;

export interface SidebarConfig {
  mainOrder: string[];
  childrenOrder: Record<string, string[]>;
  hidden: string[];
  customSections: Record<string, { label: string }>;
  customLabels: Record<string, string>;
}

interface SidebarState {
  config: SidebarConfig;
  updateMainOrder: (order: string[]) => void;
  updateChildrenOrder: (sectionLabel: string, order: string[]) => void;
  toggleHidden: (key: string) => void;
  addCustomSection: (label: string) => void;
  removeCustomSection: (label: string) => void;
  moveChildToSection: (childPath: string, fromSection: string, toSection: string) => void;
  renameItem: (key: string, newLabel: string) => void;
  promoteChildToMain: (childPath: string, fromSection: string) => void;
  demoteMainToChild: (mainLabel: string, toSection: string) => void;
  moveStandaloneToSection: (mainLabel: string, toSection: string) => void;
  resetConfig: () => void;
  showAllHidden: () => void;
  repairHiddenCustomSections: () => void;
  isHidden: (key: string) => boolean;
  getDisplayLabel: (key: string) => string;
}

/**
 * The default layout.
 *
 * These are DERIVED from `navCatalog.ts`, never restated. Restating them is
 * exactly how the five accounting sections came to exist in this file while
 * `Sidebar.tsx` had never heard of them and drew nothing for any of them.
 *
 * They are defaults: every section can be renamed, reordered or merged from
 * the sidebar settings, and a shop that has already arranged its own layout
 * keeps it — see `reconcileLayout`.
 */
const defaultMainOrder = [...NAV_TOP_ORDER];

const standalonePaths: Record<string, string> = { ...STANDALONE_PATHS };

const defaultChildrenOrder: Record<string, string[]> = Object.fromEntries(
  Object.entries(DEFAULT_CHILDREN).map(([k, v]) => [k, [...v]]),
);

function getFrozenDefaults(): SidebarConfig | null {
  if (!FREEZE_DEFAULTS) return null;
  try {
    const frozen = localStorage.getItem('sidebarConfig_frozen');
    if (frozen) {
      const parsed = JSON.parse(frozen);
      return {
        mainOrder: parsed.mainOrder || [...defaultMainOrder],
        childrenOrder: { ...defaultChildrenOrder, ...(parsed.childrenOrder || {}) },
        hidden: [],
        customSections: parsed.customSections || {},
        customLabels: parsed.customLabels || {},
      };
    }
  } catch {}
  return null;
}

function migrateConfig(config: SidebarConfig): SidebarConfig {
  const oldSettingsStandalone = ['قاعدة البيانات', 'الترخيص والاشتراك', 'النسخ الاحتياطي', 'حول البرنامج'];
  const hasOldSettings = oldSettingsStandalone.some((label) => config.mainOrder.includes(label));
  if (!hasOldSettings) return config;

  const newMainOrder = config.mainOrder.filter((label) => !oldSettingsStandalone.includes(label));
  if (!newMainOrder.includes('الإعدادات')) {
    newMainOrder.splice(newMainOrder.length, 0, 'الإعدادات');
  }
  const settingsChildren = ['/settings', '/settings/database', '/settings/license', '/settings/backup', '/about'];
  const newChildrenOrder = { ...config.childrenOrder, 'الإعدادات': settingsChildren };
  return { ...config, mainOrder: newMainOrder, childrenOrder: newChildrenOrder };
}

/**
 * Upgrades a saved layout from the single "الحسابات" section to the five.
 *
 * A shop that arranged its sidebar has that arrangement in localStorage, and
 * it names a section that no longer exists. Without this the saved config wins
 * and the new structure is never seen.
 *
 * This only handles the RENAME — the old section becoming five. Filling those
 * sections is `reconcileLayout`'s job, so that a screen added tomorrow reaches
 * the shop without another migration being written for it.
 */
/**
 * Where a retired screen goes when its old section disappears.
 *
 * These are not offered in the menu any more, but a shop can still be holding
 * one in a saved layout. Losing it during the split would delete a row the
 * shop can see — silently, which is the whole family of faults this file now
 * exists to prevent.
 */
const RETIRED_SCREEN_HOMES: Record<string, string> = {
  '/accounting/vouchers': 'السندات والرواتب والإيجارات',
  '/inventory/warehouses': 'المخازن والتسوية الجردية',
  '/inventory/items': 'المخازن والتسوية الجردية',
  '/accounting/sale-returns': 'المبيعات',
  '/accounting/purchase-returns': 'المشتريات',
};

function migrateAccountingSplit(config: SidebarConfig): SidebarConfig {
  if (!config.mainOrder.includes('الحسابات')) return config;

  const newSections = [
    'المبيعات',
    'المشتريات',
    'السندات والرواتب والإيجارات',
    'السنة المالية والأرصدة الافتتاحية',
    'المخازن والتسوية الجردية',
  ];

  // Put the five where the old one stood, so the sidebar does not reshuffle.
  const at = config.mainOrder.indexOf('الحسابات');
  const mainOrder = [...config.mainOrder];
  mainOrder.splice(at, 1, ...newSections.filter((x) => !mainOrder.includes(x)));

  // "المخازن والأصناف" was a standalone entry and is now a child of the
  // stocktake section; leaving both would list the same screen twice.
  const withoutInventory = mainOrder.filter((x) => x !== 'المخازن والأصناف');

  const childrenOrder = { ...config.childrenOrder };
  // Everything the shop had filed under the old name keeps its place: each
  // screen goes to the section that now owns it, in the order the shop had it.
  const orphans = childrenOrder['الحسابات'] || [];
  delete childrenOrder['الحسابات'];
  for (const section of newSections) {
    if (!childrenOrder[section]) childrenOrder[section] = [];
  }
  for (const path of orphans) {
    // A screen with a home goes to it. One without — the old combined سندات,
    // which the split replaced — has nowhere to be filed, and dropping it here
    // would erase a row the shop can see, along with any name it gave it. It
    // goes to the section that took over its work, where it can be recognised
    // and removed deliberately rather than vanishing.
    const home = NAV_DESTINATIONS_BY_PATH[path]?.section
      ?? RETIRED_SCREEN_HOMES[path];
    if (home && childrenOrder[home] && !childrenOrder[home].includes(path)) {
      childrenOrder[home].push(path);
    }
  }

  return { ...config, mainOrder: withoutInventory, childrenOrder };
}

function loadConfig(): SidebarConfig {
  // First check if frozen defaults are set (for production builds)
  const frozen = getFrozenDefaults();
  if (frozen) return reconcileLayout(frozen);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const config: SidebarConfig = {
        // A saved layout is authoritative about ORDER, never about
        // COMPLETENESS. Spreading the defaults under it, as this used to do,
        // looks like it fills the gaps but does not: a section present in the
        // saved copy replaces the default list whole, so every screen added
        // after the day the shop arranged its menu was silently dropped.
        mainOrder: usableMainOrder(parsed.mainOrder, parsed.customSections),
        childrenOrder: sanitiseChildren(parsed.childrenOrder),
        hidden: [], // hiding is no longer supported
        customSections: parsed.customSections || {},
        customLabels: parsed.customLabels || {},
      };
      // Rename first, then put back anything that is missing. In that order a
      // v1 layout gets the five sections AND everything that belongs in them.
      return reconcileLayout(migrateAccountingSplit(migrateConfig(config)));
    }
  } catch {}
  return {
    mainOrder: [...defaultMainOrder],
    childrenOrder: Object.fromEntries(
      Object.entries(defaultChildrenOrder).map(([k, v]) => [k, [...v]]),
    ),
    hidden: [],
    customSections: {},
    customLabels: {},
  };
}

/**
 * Accepts a saved top-level order, and falls back when there is nothing to use.
 *
 * An empty or non-array `mainOrder` cannot be shown — it is a sidebar with no
 * entries — so the defaults have to take over. But falling back to the bare
 * defaults would throw away the sections the SHOP created, which are named
 * nowhere else: their contents are in `childrenOrder` and their existence is
 * in `customSections`, and with the order gone they would be unreachable with
 * everything parked in them.
 */
function usableMainOrder(raw: unknown, customSections: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (list.length > 0) return list;

  const custom = customSections && typeof customSections === 'object'
    ? Object.keys(customSections as Record<string, unknown>)
    : [];
  return [...defaultMainOrder, ...custom.filter((c) => !defaultMainOrder.includes(c))];
}

/**
 * Accepts a saved childrenOrder only as far as it is actually usable.
 *
 * localStorage is editable by anyone at the keyboard and survives every
 * upgrade, so it is the one input to this program that is guaranteed to be
 * wrong eventually. A string where a list was expected used to reach the
 * renderer and take the sidebar down with it.
 */
function sanitiseChildren(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of value) {
      // A path listed twice in one section draws twice; React then warns on
      // the duplicate key and one of the two is unclickable.
      if (typeof item === 'string' && item && !seen.has(item)) {
        seen.add(item);
        list.push(item);
      }
    }
    out[key] = list;
  }
  return out;
}

function saveConfig(config: SidebarConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  config: (() => {
    const cfg = loadConfig();
    if (cfg.hidden.length > 0) {
      const fixed = { ...cfg, hidden: [] };
      saveConfig(fixed);
      return fixed;
    }
    return cfg;
  })(),

  updateMainOrder: (order: string[]) => {
    const newConfig = { ...get().config, mainOrder: order };
    saveConfig(newConfig);
    set({ config: newConfig });
  },

  updateChildrenOrder: (sectionLabel: string, order: string[]) => {
    const newConfig = {
      ...get().config,
      childrenOrder: { ...get().config.childrenOrder, [sectionLabel]: order },
    };
    saveConfig(newConfig);
    set({ config: newConfig });
  },

  toggleHidden: () => {}, // disabled - hiding sections is no longer supported

  showAllHidden: () => {}, // hiding is no longer supported

  repairHiddenCustomSections: () => {
    const cfg = get().config;
    if (cfg.hidden.length > 0) {
      const newConfig = { ...cfg, hidden: [] };
      saveConfig(newConfig);
      set({ config: newConfig });
    }
  },

  addCustomSection: (label: string) => {
    const cfg = get().config;
    if (cfg.mainOrder.includes(label) || cfg.customSections[label]) return;
    const newMainOrder = [...cfg.mainOrder, label];
    const newCustomSections = { ...cfg.customSections, [label]: { label } };
    const newChildrenOrder = { ...cfg.childrenOrder, [label]: [] };
    const result = { ...cfg, mainOrder: newMainOrder, customSections: newCustomSections, childrenOrder: newChildrenOrder };
    saveConfig(result);
    set({ config: result });
  },

  removeCustomSection: (label: string) => {
    const cfg = get().config;
    if (!cfg.customSections[label]) return;
    const newMainOrder = cfg.mainOrder.filter((m) => m !== label);
    const newCustomSections = { ...cfg.customSections };
    delete newCustomSections[label];
    const newChildrenOrder = { ...cfg.childrenOrder };
    // Deleting the folder must not delete the screens in it. This used to
    // take them with it: park العملاء in a section, delete the section, and
    // the customers screen was gone from the program until a factory reset.
    // `reconcileLayout` sends each one back to the section that owns it.
    delete newChildrenOrder[label];
    const result = reconcileLayout({
      ...cfg,
      mainOrder: newMainOrder,
      hidden: [],
      customSections: newCustomSections,
      childrenOrder: newChildrenOrder,
    });
    saveConfig(result);
    set({ config: result });
  },

  moveChildToSection: (childPath: string, fromSection: string, toSection: string) => {
    if (fromSection === toSection) return;
    const cfg = get().config;
    const fromChildren = [...(cfg.childrenOrder[fromSection] || [])];
    const toChildren = [...(cfg.childrenOrder[toSection] || [])];
    const idx = fromChildren.indexOf(childPath);
    if (idx === -1) return;
    fromChildren.splice(idx, 1);
    toChildren.push(childPath);
    const newChildrenOrder = { ...cfg.childrenOrder, [fromSection]: fromChildren, [toSection]: toChildren };
    const result = { ...cfg, childrenOrder: newChildrenOrder };
    saveConfig(result);
    set({ config: result });
  },

  renameItem: (key: string, newLabel: string) => {
    const cfg = get().config;
    // A path is renameable if it is a screen this program has; a section is
    // renameable if it is one of ours. Asking the CATALOGUE rather than the
    // saved layout means a screen the shop has moved elsewhere can still be
    // renamed — the old test looked it up in the default section lists, so
    // moving an item quietly took its rename button away.
    // Any path the menu can NAME can be renamed — which includes the retired
    // screens in NAV_ALIASES. A shop that still keeps the old combined سندات
    // in a section could see it but not rename it, for no reason it could
    // work out.
    const isKnownPath = LABEL_BY_PATH[key] !== undefined;
    const isCustomSection = !!cfg.customSections[key];
    const isDefaultSection = !!SECTION_BY_LABEL[key];
    const isStandalonePath = Object.values(standalonePaths).includes(key);

    if (isCustomSection) {
      const order = cfg.mainOrder.map((m) => (m === key ? newLabel : m));
      const children = { ...cfg.childrenOrder };
      if (children[key] !== undefined) { children[newLabel] = children[key]; delete children[key]; }
      const sections = { ...cfg.customSections };
      sections[newLabel] = { label: newLabel };
      delete sections[key];
      const hidden = cfg.hidden.map((h) => (h === key ? newLabel : h));
      const labels = { ...cfg.customLabels, [key]: newLabel };
      const result = { ...cfg, mainOrder: order, childrenOrder: children, customSections: sections, hidden, customLabels: labels };
      saveConfig(result);
      set({ config: result });
    } else if (isDefaultSection || isKnownPath || isStandalonePath) {
      const labels = { ...cfg.customLabels, [key]: newLabel };
      const result = { ...cfg, customLabels: labels };
      saveConfig(result);
      set({ config: result });
    }
  },

  promoteChildToMain: (childPath: string, fromSection: string) => {
    const cfg = get().config;
    const childLabel = cfg.customLabels[childPath] || childPath.split('/').pop() || childPath;
    // Use a unique key: the path itself
    if (cfg.mainOrder.includes(childPath)) return;
    // Remove child from its section
    const fromChildren = [...(cfg.childrenOrder[fromSection] || [])];
    const idx = fromChildren.indexOf(childPath);
    if (idx === -1) return;
    fromChildren.splice(idx, 1);
    const newChildrenOrder = { ...cfg.childrenOrder, [fromSection]: fromChildren };
    // Add as main item using path as key
    const newMainOrder = [...cfg.mainOrder, childPath];
    const newCustomLabels = { ...cfg.customLabels, [childPath]: childLabel };
    const result = { ...cfg, mainOrder: newMainOrder, childrenOrder: newChildrenOrder, customLabels: newCustomLabels };
    saveConfig(result);
    set({ config: result });
  },

  demoteMainToChild: (mainLabel: string, toSection: string) => {
    const cfg = get().config;
    const isCustom = !!cfg.customSections[mainLabel];
    const isStandalone = !isCustom && !defaultChildrenOrder[mainLabel];
    const idx = cfg.mainOrder.indexOf(mainLabel);
    if (idx === -1) return;

    if (isCustom) {
      const myChildren = cfg.childrenOrder[mainLabel] || [];
      const newMainOrder = cfg.mainOrder.filter((m) => m !== mainLabel);
      const newSections = { ...cfg.customSections };
      delete newSections[mainLabel];
      const newChildrenOrder = { ...cfg.childrenOrder };
      delete newChildrenOrder[mainLabel];
      const targetChildren = [...(newChildrenOrder[toSection] || []), ...myChildren];
      newChildrenOrder[toSection] = targetChildren;
      const result = { ...cfg, mainOrder: newMainOrder, customSections: newSections, childrenOrder: newChildrenOrder };
      saveConfig(result);
      set({ config: result });
    } else if (isStandalone) {
      const path = standalonePaths[mainLabel] || mainLabel;
      const newMainOrder = cfg.mainOrder.filter((m) => m !== mainLabel);
      const targetChildren = [...(cfg.childrenOrder[toSection] || []), path];
      const newChildrenOrder = { ...cfg.childrenOrder, [toSection]: targetChildren };
      const result = { ...cfg, mainOrder: newMainOrder, childrenOrder: newChildrenOrder };
      saveConfig(result);
      set({ config: result });
    }
  },

  moveStandaloneToSection: (mainLabel: string, toSection: string) => {
    const cfg = get().config;
    if (mainLabel === toSection) return;
    const path = standalonePaths[mainLabel] || mainLabel;
    const newMainOrder = cfg.mainOrder.filter((m) => m !== mainLabel);
    const targetChildren = [...(cfg.childrenOrder[toSection] || []), path];
    const newChildrenOrder = { ...cfg.childrenOrder, [toSection]: targetChildren };
    const result = { ...cfg, mainOrder: newMainOrder, childrenOrder: newChildrenOrder };
    saveConfig(result);
    set({ config: result });
  },

  resetConfig: () => {
    const frozen = getFrozenDefaults();
    const newConfig = reconcileLayout(frozen || {
      mainOrder: [...defaultMainOrder],
      // A shallow copy shares the ARRAYS with the module-level defaults, so the
      // next reorder mutates the defaults themselves and "reset" stops
      // returning to the factory layout.
      childrenOrder: Object.fromEntries(
        Object.entries(defaultChildrenOrder).map(([k, v]) => [k, [...v]]),
      ),
      hidden: [],
      customSections: {},
      customLabels: {},
    });
    saveConfig(newConfig);
    set({ config: newConfig });
  },

  isHidden: (key: string) => get().config.hidden.includes(key),

  getDisplayLabel: (key: string) => {
    const cfg = get().config;
    if (cfg.customLabels[key]) return cfg.customLabels[key];
    // A fourth restatement of the catalogue used to live here. It is now the
    // one in navCatalog.ts, so a screen cannot be named in the menu and
    // unnamed in the settings page.
    return LABEL_BY_PATH[key] ?? key;
  },
}));
