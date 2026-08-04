import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Folder,
  CircleDot,
} from 'lucide-react';
import { useSidebarStore, type SidebarConfig } from '../../stores/sidebar.store';
import {
  DESTINATION_BY_PATH,
  SECTION_BY_LABEL,
  LABEL_BY_PATH,
} from '../../lib/navCatalog';
import type { LucideIcon } from 'lucide-react';

interface MenuItem {
  path?: string;
  label: string;
  icon: LucideIcon;
  children?: { path: string; label: string; icon: LucideIcon }[];
}

/**
 * Turns the saved layout into the menu that is drawn.
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * This function used to consult a private `defaultItems` list that described
 * one section called "الحسابات". When the store began defaulting to five
 * sections instead, this list was not changed, so `itemMap.get(entry)` found
 * nothing for any of the five, `if (!item) continue;` skipped them, and the
 * sidebar drew four sections out of ten. Eleven screens left the program in
 * one commit, with no error anywhere, because a `continue` on an unrecognised
 * name is indistinguishable from ordinary defensive code.
 *
 * It now reads the same catalogue the store does, so "the store lists a
 * section this cannot draw" is no longer a state that exists.
 *
 * Anything it still cannot place is reported instead of skipped — see the
 * `unplaceable` return.
 */
export function buildOrderedMenu(config: SidebarConfig): {
  menu: MenuItem[];
  unplaceable: string[];
} {
  const menu: MenuItem[] = [];
  const unplaceable: string[] = [];
  const seen = new Set<string>();

  const childOf = (path: string) => {
    const dest = DESTINATION_BY_PATH[path];
    if (dest) return { path: dest.path, label: dest.label, icon: dest.icon };
    // A route that is not offered in the menu can still be sitting in a saved
    // layout — the shop may have put it there before it was retired. Draw it
    // with the name it has rather than dropping it without a word.
    const label = LABEL_BY_PATH[path];
    if (label) return { path, label, icon: CircleDot };
    return null;
  };

  for (const entry of config.mainOrder) {
    if (seen.has(entry)) continue; // a name repeated in mainOrder draws twice
    seen.add(entry);

    // 1. A section: one of ours, or one the shop created.
    const known = SECTION_BY_LABEL[entry];
    const custom = config.customSections?.[entry];
    if (known || custom) {
      const orderedChildren: NonNullable<MenuItem['children']> = [];
      const inSection = new Set<string>();
      for (const childPath of config.childrenOrder[entry] || []) {
        if (inSection.has(childPath)) continue;
        const child = childOf(childPath);
        if (child) {
          inSection.add(childPath);
          orderedChildren.push(child);
        } else {
          unplaceable.push(childPath);
        }
      }
      menu.push({
        label: entry,
        icon: known ? known.icon : Folder,
        children: orderedChildren,
      });
      continue;
    }

    // 2. A destination promoted to the top level. It is stored as its path.
    if (entry.startsWith('/')) {
      const dest = childOf(entry);
      if (dest) menu.push({ path: dest.path, label: entry, icon: dest.icon });
      else unplaceable.push(entry);
      continue;
    }

    // 3. A top-level link stored by its label, e.g. لوحة التحكم.
    const byLabel = Object.values(DESTINATION_BY_PATH).find(
      (d) => d.section === null && d.label === entry,
    );
    if (byLabel) {
      menu.push({ path: byLabel.path, label: entry, icon: byLabel.icon });
      continue;
    }

    unplaceable.push(entry);
  }

  return { menu, unplaceable };
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

  const { menu: menuItems, unplaceable } = buildOrderedMenu(config);

  // A saved layout naming something this build does not have is not fatal, but
  // it must not be silent either: silence is exactly how five sections went
  // missing without anybody being told. It is reported in the console, and the
  // shop is shown the way back in the menu itself.
  useEffect(() => {
    if (unplaceable.length > 0) {
      console.warn('[الشريط الجانبي] عناصر محفوظة غير معروفة في هذه النسخة:', unplaceable);
    }
  }, [unplaceable.join('|')]);

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
                className={({ isActive }: { isActive: boolean }) =>
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
                  {(item.children || []).length === 0 && (
                    // An empty group opens onto nothing, which reads as a
                    // broken program. Say what it is and where to fix it.
                    <div className="mx-1 px-3 py-1.5 text-[10px] text-slate-500 italic">
                      لا توجد عناصر — أضِفها من الإعدادات ← ترتيب القائمة
                    </div>
                  )}
                  {(item.children || []).map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        end={item.children?.some((c) => c.path !== child.path && c.path.startsWith(child.path + '/')) ?? false}
                        className={({ isActive }: { isActive: boolean }) =>
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
