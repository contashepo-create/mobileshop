import { useState, useEffect } from 'react';
import { TrendingUp, Wrench, PackageX, Wallet, AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';

export function Dashboard() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    (async () => {
      const data = await window.api.invoke('reports:dashboard');
      setStats(data);
    })();
  }, []);

  const cards = [
    { label: 'مبيعات اليوم', value: `${(stats?.todaySales || 0).toFixed(2)} ج.م`, icon: TrendingUp, color: 'bg-green-500' },
    { label: 'صيانة معلقة', value: stats?.pendingMaintenance || 0, icon: Wrench, color: 'bg-orange-500' },
    { label: 'مخزون منخفض', value: stats?.lowStock || 0, icon: PackageX, color: 'bg-red-500' },
    { label: 'رصيد الخزائن', value: `${(stats?.cashBalance || 0).toFixed(2)} ج.م`, icon: Wallet, color: 'bg-blue-500' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white">لوحة التحكم</h1>

      {/* Alerts */}
      {(stats?.overdueMaintenance > 0 || stats?.lowStock > 0) && (
        <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle size={20} className="text-orange-500 flex-shrink-0" />
          <div className="text-sm text-orange-700 dark:text-orange-300">
            {stats?.overdueMaintenance > 0 && <span>يوجد {stats.overdueMaintenance} أمر صيانة متأخر عن موعد التسليم. </span>}
            {stats?.lowStock > 0 && <span>يوجد {stats.lowStock} صنف اقترب من النفاد.</span>}
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white dark:bg-slate-800 rounded-xl p-5 shadow-sm border border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <div className={`p-2 rounded-lg ${card.color}`}>
                  <Icon size={20} className="text-white" />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-800 dark:text-white">{card.value}</div>
              <div className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mt-1">{card.label}</div>
            </div>
          );
        })}
      </div>

      {/* Monthly Sales Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">المبيعات الشهرية</h2>
          {stats?.monthlySales?.length > 0 ? (
            <div className="flex items-end gap-2 h-48">
              {stats.monthlySales.map((item: any, idx: number) => {
                const maxVal = Math.max(...stats.monthlySales.map((s: any) => s.total), 1);
                const height = (item.total / maxVal) * 100;
                return (
                  <div key={idx} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full bg-primary-600 rounded-t-lg" style={{ height: `${height}%`, minHeight: '4px' }} title={item.total.toFixed(2)} />
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 whitespace-nowrap">{item.month}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 dark:text-slate-400">لا توجد بيانات</div>
          )}
        </div>

        {/* Recent Operations */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">أحدث العمليات</h2>
          <div className="space-y-2">
            {stats?.recentSales?.map((sale: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                <div>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{sale.CustomerName || 'عميل نقدي'}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">{sale.SaleNumber}</span>
                </div>
                <span className="text-sm font-bold text-green-600">{sale.TotalAmount?.toFixed(2)}</span>
              </div>
            ))}
            {stats?.recentMaintenance?.map((ticket: any, idx: number) => (
              <div key={`m${idx}`} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                <div>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{ticket.DeviceModel}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">{ticket.CustomerName}</span>
                </div>
                <Badge variant="blue">{ticket.Status}</Badge>
              </div>
            ))}
            {!stats?.recentSales?.length && !stats?.recentMaintenance?.length && (
              <p className="text-center text-slate-500 dark:text-slate-400 py-4">لا توجد عمليات بعد</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
