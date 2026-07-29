import { useState, useEffect, useRef } from 'react';
import { Search, Bell, Moon, Sun, LogOut, AlertTriangle, Package, Users, Truck, Wrench, Wallet, User, X, Clock } from 'lucide-react';
import { useAuthStore } from '../../stores/auth.store';
import { useThemeStore } from '../../stores/theme.store';
import { isFailure, asRows } from '../../lib/ipc';

export function Header() {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [notifications, setNotifications] = useState<any>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [refreshMs, setRefreshMs] = useState(60000);
  const notifRef = useRef<HTMLDivElement>(null);

  // The refresh cadence is the shop's choice, so the timer is rebuilt whenever
  // the engine reports a different value (saved on the settings screen).
  useEffect(() => {
    void fetchNotifications();
    const interval = setInterval(() => { void fetchNotifications(); }, refreshMs);
    return () => clearInterval(interval);
  }, [refreshMs]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const fetchNotifications = async () => {
    try {
      const result = await window.api.invoke('notifications:smart');
      // A session that has expired answers `{ success: false, ... }`. That is
      // truthy, so the `showNotifications && notifications` guard below would
      // still open the panel and then read `.notifications.length` off an
      // object that has no such field, taking the whole window down with it.
      setNotifications(isFailure(result) ? null : result);
      const mins = Number(result?.refreshMinutes);
      if (Number.isFinite(mins) && mins >= 1) {
        const ms = mins * 60000;
        // Only trigger a re-subscribe when it actually changed, otherwise the
        // effect would tear down and rebuild the timer on every poll.
        setRefreshMs(prev => (prev === ms ? prev : ms));
      }
    } catch {}
  };

  const notifCount = notifications?.counts?.total || 0;
  const criticalCount = notifications?.counts?.critical || 0;

  const iconMap: any = {
    users: Users, truck: Truck, wrench: Wrench, package: Package,
    wallet: Wallet, user: User,
  };

  const priorityColors: any = {
    critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-red-300',
    high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-300',
    medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-300',
    low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-300',
  };

  return (
    <header className="h-16 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between px-6 flex-shrink-0">
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={18} />
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث شامل: عميل، هاتف، IMEI، فاتورة، صيانة..."
            className="w-full pr-10 pl-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Smart Notifications */}
        <div className="relative" ref={notifRef}>
          <button onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-lg text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
            <Bell size={20} />
            {notifCount > 0 && (
              <span className={`absolute top-1 left-1 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center ${criticalCount > 0 ? 'bg-red-500' : 'bg-orange-500'}`}>
                {notifCount > 99 ? '99+' : notifCount}
              </span>
            )}
          </button>

          {showNotifications && notifications && (
            <div className="absolute left-0 mt-2 w-96 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 max-h-[500px] overflow-y-auto">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800 dark:text-white">الإشعارات الذكية</span>
                <div className="flex gap-1">
                  {criticalCount > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">{criticalCount} حرج</span>}
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">{notifCount} إجمالي</span>
                </div>
              </div>

                  {asRows(notifications.notifications).length === 0 ? (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
                  {/* An empty bell has three very different meanings. Saying
                      "all good" when alerts are switched off would be a lie. */}
                  {notifications.suppressionReason === 'off'
                    ? 'نظام التنبيهات موقوف من الإعدادات'
                    : notifications.suppressionReason === 'quiet'
                    ? 'ساعات الهدوء مفعّلة الآن 🌙'
                    : notifications.suppressionReason === 'day'
                    ? 'التنبيهات موقوفة في هذا اليوم'
                    : 'لا توجد إشعارات - كل شيء على ما يرام ✅'}
                </div>
              ) : (
                <div>
                  <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700/50 flex gap-1">
                    <button onClick={async () => { await window.api.invoke('notifications:dismissAll', notifications.keys); fetchNotifications(); }} className="text-[10px] px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600">مسح الكل</button>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
                    {asRows<any>(notifications.notifications).slice(0, 50).map((n: any, i: number) => {
                      const Icon = iconMap[n.icon] || AlertTriangle;
                      const key = notifications.keys?.[i] || '';
                      return (
                        <div key={i} className="px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors group">
                          <div className="flex items-start gap-2">
                            <div className={`p-1.5 rounded-lg border ${priorityColors[n.priority] || priorityColors.low}`}>
                              <Icon size={14} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-slate-800 dark:text-white truncate">{n.title}</div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-500 dark:text-slate-400 mt-0.5">{n.message}</div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={async () => { await window.api.invoke('notifications:dismiss', key); fetchNotifications(); }} className="p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-red-500" title="إخفاء"><X size={12} /></button>
                              <button onClick={async () => { await window.api.invoke('notifications:snooze', key, 24); fetchNotifications(); }} className="p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-blue-500" title="كتم ليوم"><Clock size={12} /></button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <button onClick={toggleTheme} className="p-2 rounded-lg text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
          {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
        </button>

        <div className="flex items-center gap-2 pr-3 border-r border-slate-200 dark:border-slate-700">
          <div className="text-left">
            <div className="text-sm font-medium text-slate-700 dark:text-white">{user?.username || 'المستخدم'}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{user?.roleName || ''}</div>
          </div>
          <button onClick={logout} className="p-2 rounded-lg text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors">
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}
