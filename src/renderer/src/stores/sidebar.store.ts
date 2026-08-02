import { create } from 'zustand';

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

const defaultMainOrder = [
  'لوحة التحكم',
  'الحسابات',
  'المخازن والأصناف',
  'الموارد البشرية',
  'الأصول',
  'التقارير',
  'الإعدادات',
];

const standalonePaths: Record<string, string> = {
  'لوحة التحكم': '/',
  'المخازن والأصناف': '/inventory',
};

const defaultChildrenOrder: Record<string, string[]> = {
  'الحسابات': [
    '/accounting/sales',
    '/accounting/purchases',
    '/accounting/maintenance',
    '/accounting/vouchers',
    '/accounting/payroll',
    '/accounting/rents',
    '/accounting/rent-parties',
    '/accounting/services',
    '/accounting/fiscal-year',
    '/accounting/settlement',
    '/accounting/opening-balances',
  ],
  'الموارد البشرية': [
    '/hr/employees',
    '/hr/customers',
    '/hr/suppliers',
  ],
  'الأصول': [
    '/assets',
    '/assets/payment-methods',
    '/assets/transfers',
  ],
  'التقارير': [
    '/reports',
    '/reports/customer-statement',
    '/reports/supplier-statement',
    '/reports/employee-statement',
  ],
  'الإعدادات': [
    '/settings',
    '/settings/database',
    '/settings/license',
    '/settings/backup',
    '/about',
  ],
};

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

function loadConfig(): SidebarConfig {
  // First check if frozen defaults are set (for production builds)
  const frozen = getFrozenDefaults();
  if (frozen) return frozen;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const config = {
        mainOrder: parsed.mainOrder || [...defaultMainOrder],
        childrenOrder: { ...defaultChildrenOrder, ...(parsed.childrenOrder || {}) },
        hidden: [], // hiding is no longer supported
        customSections: parsed.customSections || {},
        customLabels: parsed.customLabels || {},
      };
      return migrateConfig(config);
    }
  } catch {}
  return {
    mainOrder: [...defaultMainOrder],
    childrenOrder: { ...defaultChildrenOrder },
    hidden: [],
    customSections: {},
    customLabels: {},
  };
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
    delete newChildrenOrder[label];
    const result = { ...cfg, mainOrder: newMainOrder, hidden: [], customSections: newCustomSections, childrenOrder: newChildrenOrder };
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
    // If key is a child path, store as custom label
    const hasChild = defaultChildrenOrder && Object.values(defaultChildrenOrder).some((arr) => arr.includes(key));
    const isCustomSection = !!cfg.customSections[key];
    const isDefaultSection = defaultMainOrder.includes(key) && !!defaultChildrenOrder[key];
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
    } else if (isDefaultSection || hasChild || isStandalonePath) {
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
    const newConfig = frozen || {
      mainOrder: [...defaultMainOrder],
      childrenOrder: { ...defaultChildrenOrder },
      hidden: [],
      customSections: {},
      customLabels: {},
    };
    saveConfig(newConfig);
    set({ config: newConfig });
  },

  isHidden: (key: string) => get().config.hidden.includes(key),

  getDisplayLabel: (key: string) => {
    const cfg = get().config;
    if (cfg.customLabels[key]) return cfg.customLabels[key];
    // Child paths -> look up default label
    const childCatalog: Record<string, string> = {
      '/accounting/sales': 'مبيعات',
      '/accounting/purchases': 'مشتريات',
      '/accounting/maintenance': 'صيانة',
      '/accounting/vouchers': 'سندات',
      '/accounting/payroll': 'رواتب وسلف',
      '/accounting/rents': 'إيجارات',
      '/accounting/rent-parties': 'المؤجرون والمستأجرون',
      '/accounting/services': 'تحويل وشحن',
      '/accounting/fiscal-year': 'السنة المالية',
      '/accounting/settlement': 'التسوية الجردية',
      '/accounting/opening-balances': 'الأرصدة الافتتاحية',
      '/hr/employees': 'الموظفين',
      '/hr/customers': 'العملاء',
      '/hr/suppliers': 'الموردين',
      '/assets': 'البنوك والخزائن',
      '/assets/payment-methods': 'ماكينات الدفع',
      '/assets/transfers': 'تحويلات بين الحسابات',
      '/reports': 'التقارير العامة',
      '/reports/customer-statement': 'كشف حساب عميل',
      '/reports/supplier-statement': 'كشف حساب مورد',
      '/reports/employee-statement': 'كشف حساب موظف',
      // Standalone paths (may appear as children when moved to a section)
      '/': 'لوحة التحكم',
      '/inventory': 'المخازن والأصناف',
      '/settings': 'الإعدادات العامة',
      '/settings/database': 'قاعدة البيانات',
      '/settings/license': 'الترخيص والاشتراك',
      '/settings/backup': 'النسخ الاحتياطي',
      '/about': 'حول البرنامج',
    };
    if (childCatalog[key]) return childCatalog[key];
    return key;
  },
}));
