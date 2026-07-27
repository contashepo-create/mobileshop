import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Calculator,
  Package,
  Users,
  Wallet,
  FileText,
  Settings,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
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
  Folder,
} from 'lucide-react';
import { useSidebarStore, type SidebarConfig } from '../../stores/sidebar.store';
import type { LucideIcon } from 'lucide-react';

interface MenuItem {
  path?: string;
  label: string;
  icon: LucideIcon;
  children?: { path: string; label: string; icon: LucideIcon }[];
}

const defaultItems: MenuItem[] = [
  { path: '/', label: 'لوحة التحكم', icon: LayoutDashboard },
  {
    label: 'الحسابات',
    icon: Calculator,
    children: [
      { path: '/accounting/sales', label: 'مبيعات', icon: ShoppingCart },
      { path: '/accounting/purchases', label: 'مشتريات', icon: Truck },
      { path: '/accounting/maintenance', label: 'صيانة', icon: Wrench },
      { path: '/accounting/vouchers', label: 'سندات', icon: Receipt },
      { path: '/accounting/payroll', label: 'رواتب وسلف', icon: DollarSign },
      { path: '/accounting/rents', label: 'إيجارات', icon: Banknote },
      { path: '/accounting/services', label: 'تحويل وشحن', icon: Smartphone },
      { path: '/accounting/fiscal-year', label: 'السنة المالية', icon: Calendar },
      { path: '/accounting/settlement', label: 'التسوية الجردية', icon: ClipboardCheck },
      { path: '/accounting/opening-balances', label: 'الأرصدة الافتتاحية', icon: Scale },
    ],
  },
  { path: '/inventory', label: 'المخازن والأصناف', icon: Package },
  {
    label: 'الموارد البشرية',
    icon: Users,
    children: [
      { path: '/hr/employees', label: 'الموظفين', icon: UserCircle },
      { path: '/hr/customers', label: 'العملاء', icon: Users },
      { path: '/hr/suppliers', label: 'الموردين', icon: Truck },
    ],
  },
  {
    label: 'الأصول',
    icon: Wallet,
    children: [
      { path: '/assets', label: 'البنوك والخزائن', icon: CreditCard },
      { path: '/assets/payment-methods', label: 'ماكينات الدفع', icon: CreditCard },
      { path: '/assets/transfers', label: 'تحويلات بين الحسابات', icon: ArrowRightLeft },
    ],
  },
  {
    label: 'التقارير',
    icon: FileText,
    children: [
      { path: '/reports', label: 'التقارير العامة', icon: FileText },
      { path: '/reports/customer-statement', label: 'كشف حساب عميل', icon: Users },
      { path: '/reports/supplier-statement', label: 'كشف حساب مورد', icon: Truck },
      { path: '/reports/employee-statement', label: 'كشف حساب موظف', icon: UserCircle },
    ],
  },
  { path: '/settings', label: 'الإعدادات', icon: Settings },
  { path: '/settings/database', label: 'قاعدة البيانات', icon: Database },
  { path: '/settings/license', label: 'الترخيص والاشتراك', icon: Shield },
  { path: '/settings/backup', label: 'النسخ الاحتياطي', icon: HardDrive },
  { path: '/about', label: 'حول البرنامج', icon: Info },
];

// Map of standalone labels to their path + icon
const standaloneMeta: Record<string, { path: string; icon: LucideIcon; label: string }> = {
  'لوحة التحكم': { path: '/', icon: LayoutDashboard, label: 'لوحة التحكم' },
  'المخازن والأصناف': { path: '/inventory', icon: Package, label: 'المخازن والأصناف' },
  'الإعدادات': { path: '/settings', icon: Settings, label: 'الإعدادات' },
  'قاعدة البيانات': { path: '/settings/database', icon: Database, label: 'قاعدة البيانات' },
  'الترخيص والاشتراك': { path: '/settings/license', icon: Shield, label: 'الترخيص والاشتراك' },
  'النسخ الاحتياطي': { path: '/settings/backup', icon: HardDrive, label: 'النسخ الاحتياطي' },
  'حول البرنامج': { path: '/about', icon: Info, label: 'حول البرنامج' },
};

// Reverse map: path → standalone label
const pathToStandalone: Record<string, string> = {};
for (const [label, meta] of Object.entries(standaloneMeta)) {
  pathToStandalone[meta.path] = label;
}

function buildOrderedMenu(config: SidebarConfig): MenuItem[] {
  // Build catalog of ALL possible children
  const allChildren = new Map<string, NonNullable<MenuItem['children']>[number]>();
  for (const item of defaultItems) {
    if (item.children) {
      for (const c of item.children) allChildren.set(c.path, c);
    }
  }

  const itemMap = new Map<string, MenuItem>();
  for (const item of defaultItems) itemMap.set(item.label, item);

  const ordered: MenuItem[] = [];
  for (const entry of config.mainOrder) {
    // Check if entry is a promoted child path (starts with /)
    const isPathEntry = entry.startsWith('/');
    let item = isPathEntry ? null : itemMap.get(entry);
    const isCustom = !item && !isPathEntry && config.customSections?.[entry];

    if (!item && isCustom) {
      item = { label: entry, icon: Folder, children: [] };
    }

    // If entry is a path (promoted child), find its default info
    if (!item && isPathEntry) {
      const childInfo = allChildren.get(entry);
      if (childInfo) {
        item = { path: childInfo.path, label: entry, icon: childInfo.icon };
      } else {
        // Could be a standalone path moved to main
        const standLabel = pathToStandalone[entry];
        if (standLabel) {
          const meta = standaloneMeta[standLabel];
          item = { path: meta.path, label: entry, icon: meta.icon };
        }
      }
    }

    if (!item) continue;

    if (item.children !== undefined) {
      const childOrder = config.childrenOrder[entry] || [];
      const orderedChildren: NonNullable<MenuItem['children']> = [];

      for (const childPath of childOrder) {
        const child = allChildren.get(childPath);
        if (child) {
          orderedChildren.push(child);
        } else {
          // Check if childPath corresponds to a standalone item
          const standLabel = pathToStandalone[childPath];
          if (standLabel) {
            const meta = standaloneMeta[standLabel];
            orderedChildren.push({ path: meta.path, label: meta.label, icon: meta.icon });
          }
        }
      }

      if (orderedChildren.length > 0 || !isCustom) {
        ordered.push({ ...item, children: orderedChildren });
      }
    } else {
      ordered.push(item);
    }
  }

  // Add default items that are in mainOrder but were missed (e.g. newly added by updates)
  for (const item of defaultItems) {
    if (
      config.mainOrder.includes(item.label) &&
      !ordered.some((o) => o.label === item.label)
    ) {
      ordered.push(item);
    }
  }
  return ordered;
}

// One-time fix: clear all hidden items
try {
  const raw = localStorage.getItem('sidebarConfig');
  if (raw) {
    const cfg = JSON.parse(raw);
    if (cfg.hidden && cfg.hidden.length > 0) {
      cfg.hidden = [];
      localStorage.setItem('sidebarConfig', JSON.stringify(cfg));
    }
  }
  // Also update store in-memory
  useSidebarStore.getState().repairHiddenCustomSections();
} catch {}

export function Sidebar() {
  const { config, getDisplayLabel } = useSidebarStore();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(new Set());
  const [appTitle, setAppTitle] = useState('موبايل شوب سيستم');

  useEffect(() => {
    (async () => {
      const s = await window.api.invoke('settings:getAll');
      if (s?.app_name) setAppTitle(s.app_name);
    })();
  }, []);

  useEffect(() => {
    setExpandedMenus(new Set());
  }, [config.mainOrder]);

  const toggleMenu = (label: string) => {
    setExpandedMenus((prev) => {
      if (prev.has(label)) return new Set(); // close if already open
      return new Set([label]); // open only this one
    });
  };

  const menuItems = buildOrderedMenu(config);

  return (
    <aside
      className={`${
        collapsed ? 'w-16' : 'w-60'
      } bg-slate-800 dark:bg-slate-950 text-white flex flex-col transition-all duration-200 flex-shrink-0`}
    >
      <div className="h-16 flex flex-col items-center justify-center border-b border-slate-700">
        {!collapsed && <><span className="font-bold text-sm whitespace-nowrap leading-tight">{appTitle}</span></>}
      </div>

      <nav className="flex-1 py-4 space-y-1 overflow-y-auto overflow-x-hidden">
          {menuItems.map((item) => {
          const Icon = item.icon;
          const hasChildren = !!item.children;
          if (!hasChildren) {
            return (
              <NavLink
                key={item.label}
                to={item.path!}
                end={item.path === '/' || menuItems.some((m) => m.path !== item.path && m.path?.startsWith(item.path! + '/'))}
                className={({ isActive }) =>
                  `flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-slate-700/80 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                  }`
                }
                title={item.label}
              >
                <Icon size={20} className="flex-shrink-0" />
                {!collapsed && <span className="text-sm whitespace-nowrap">{getDisplayLabel(item.label)}</span>}
              </NavLink>
            );
          }
          return (
            <div key={item.label} className="mb-1">
              <button
                onClick={() => toggleMenu(item.label)}
                className={`w-full flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg transition-colors ${
                  expandedMenus.has(item.label)
                    ? 'bg-slate-700/60 text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                }`}
                title={item.label}
              >
                <Icon size={20} className="flex-shrink-0" />
                {!collapsed && (
                  <>
                    <span className="text-sm whitespace-nowrap flex-1 text-right">{getDisplayLabel(item.label)}</span>
                    {expandedMenus.has(item.label) ? (
                      <ChevronDown size={14} className="text-slate-400" />
                    ) : (
                      <ChevronLeft size={14} className="text-slate-400" />
                    )}
                  </>
                )}
              </button>
              {!collapsed && expandedMenus.has(item.label) && (
                <div className="mr-3 space-y-0.5 mt-0.5">
                  {(item.children || []).map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        end={item.children?.some((c) => c.path !== child.path && c.path.startsWith(child.path + '/')) ?? false}
                        className={({ isActive }) =>
                          `flex items-center gap-2 mx-1 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                            isActive
                              ? 'bg-primary-600/80 text-white'
                              : 'text-slate-400 hover:bg-slate-700/50 hover:text-white'
                          }`
                        }
                      >
                        <ChildIcon size={14} className="flex-shrink-0 opacity-70" />
                        <span className="whitespace-nowrap">{getDisplayLabel(child.path)}</span>
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <button
        onClick={() => setCollapsed(!collapsed)}
        className="h-10 flex items-center justify-center border-t border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
      >
        {collapsed ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
      </button>
    </aside>
  );
}
