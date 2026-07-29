import { useState, useEffect } from 'react';
import { FileText, Calendar, Printer } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';

type ReportType = 'sales' | 'purchases' | 'maintenance' | 'customers' | 'suppliers' | 'employees' | 'inventory' | 'profitLoss' | 'financialPosition';

const reportTypes: { key: ReportType; label: string }[] = [
  { key: 'sales', label: 'تقرير المبيعات' },
  { key: 'purchases', label: 'تقرير المشتريات' },
  { key: 'maintenance', label: 'تقرير الصيانة' },
  { key: 'customers', label: 'تقرير العملاء' },
  { key: 'suppliers', label: 'تقرير الموردين' },
  { key: 'employees', label: 'تقرير الموظفين' },
  { key: 'inventory', label: 'تقرير المخازن' },
  { key: 'profitLoss', label: 'الأرباح والخسائر' },
  { key: 'financialPosition', label: 'المركز المالي' },
];

export function ReportsPage() {
  const { showToast } = useToastStore();
  const [activeReport, setActiveReport] = useState<ReportType>('sales');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  /**
   * The report payload, TOGETHER WITH the report it belongs to.
   *
   * Keeping the two in one piece of state is the whole fix for the blank
   * screen. Clicking a tab re-renders immediately, but the refetch only runs
   * afterwards in the effect below, so for one render `data` still holds the
   * PREVIOUS report. The payload shapes are not interchangeable — the P&L
   * statement has no `rows`, the employees report has no `totals` — so the old
   * payload rendered against the new tab's JSX read `undefined.length` and
   * took the entire application down with it (there is no error boundary).
   * Tagging the payload lets the render below ignore anything stale.
   */
  const [report, setReport] = useState<{ type: ReportType; data: any } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchReport = async () => {
    // Captured now: `activeReport` may change again while this await is in
    // flight, and a slow reply for the old tab must not overwrite the new one.
    const requested = activeReport;
    setLoading(true);
    try {
      let result: any;
      if (requested === 'customers' || requested === 'suppliers' || requested === 'employees' || requested === 'inventory' || requested === 'financialPosition') {
        result = await window.api.invoke(`reports:${requested}`);
      } else {
        const filters = { fromDate: fromDate || undefined, toDate: toDate || undefined };
        result = await window.api.invoke(`reports:${requested}`, filters);
      }
      // A refused channel answers `{ success: false, message }`, which is
      // truthy and would otherwise be rendered as if it were the report.
      if (isFailure(result)) {
        showToast('error', failureMessage(result, 'تعذر تحميل التقرير'));
        setReport({ type: requested, data: null });
      } else {
        setReport({ type: requested, data: result });
      }
    } catch (err) {
      console.error('Report error:', err);
      showToast('error', 'تعذر تحميل التقرير');
      setReport({ type: requested, data: null });
    }
    setLoading(false);
  };

  useEffect(() => { fetchReport(); }, [activeReport]);

  const handlePrint = () => {
    window.print();
  };

  const showDateFilter = ['sales', 'purchases', 'maintenance', 'profitLoss'].includes(activeReport);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between no-print">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">التقارير</h1>
        <Button variant="secondary" onClick={handlePrint} icon={<Printer size={16} />}>طباعة</Button>
      </div>

      {/* Report tabs */}
      <div className="flex flex-wrap gap-2 no-print">
        {reportTypes.map(r => (
          <button key={r.key} onClick={() => setActiveReport(r.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeReport === r.key ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}>
            {r.label}
          </button>
        ))}
      </div>

      {/* Date filter */}
      {showDateFilter && (
        <div className="flex gap-3 items-end no-print">
          <Input label="من تاريخ" type="date" value={fromDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFromDate(e.target.value)} />
          <Input label="إلى تاريخ" type="date" value={toDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToDate(e.target.value)} />
          <Button onClick={fetchReport} icon={<Calendar size={16} />}>عرض</Button>
        </div>
      )}

      {/* Report content */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        {loading ? <p className="text-center text-slate-500 dark:text-slate-400 py-8">جاري التحميل...</p> : (
          /*
            `report.type === activeReport` is the guard. Anything else is the
            previous tab's payload, whose shape does not match this tab's JSX.
            Passing `null` renders the ordinary "no data" line for the one
            render before the refetch lands.
          */
          <ReportContent
            type={activeReport}
            data={report && report.type === activeReport ? report.data : null}
          />
        )}
      </div>
    </div>
  );
}

function ReportContent({ type, data }: { type: ReportType; data: any }) {
  if (!data) return <p className="text-center text-slate-500 dark:text-slate-400 py-8">لا توجد بيانات</p>;

  switch (type) {
    case 'sales':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير المبيعات" />
          <div className="grid grid-cols-4 gap-4">
            <StatBox label="إجمالي المبيعات" value={data.totals?.total?.toFixed(2) || '0'} color="text-green-600" />
            <StatBox label="مدفوع بالفاتورة" value={data.totals?.paid?.toFixed(2) || '0'} color="text-blue-600" />
            <StatBox label="سدد لاحقاً (سندات)" value={data.totals?.laterPayments?.toFixed(2) || '0'} color="text-cyan-600" />
            <StatBox label="المتبقي فعلياً" value={data.totals?.remaining?.toFixed(2) || '0'} color="text-red-600" />
          </div>
          <DataTable
            columns={[
              { key: 'SaleNumber', title: 'رقم الفاتورة' },
              { key: 'Date', title: 'التاريخ' },
              { key: 'CustomerName', title: 'العميل', render: (r) => r.CustomerName || '—' },
              { key: 'TotalAmount', title: 'الإجمالي', render: (r) => r.TotalAmount?.toFixed(2) },
              { key: 'PaidAmount', title: 'مدفوع بالفاتورة', render: (r) => <span className="text-green-600">{r.PaidAmount?.toFixed(2)}</span> },
              { key: 'LaterPayments', title: 'سدد لاحقاً', render: (r) => (r.LaterPayments > 0 ? <span className="text-cyan-600">{r.LaterPayments?.toFixed(2)}</span> : '—') },
              { key: 'ActualRemaining', title: 'المتبقي فعلياً', render: (r) => r.ActualRemaining > 0 ? <span className="text-red-600 font-bold">{r.ActualRemaining?.toFixed(2)}</span> : <span className="text-green-600">0</span> },
              { key: 'Status', title: 'الحالة', render: (r) => <Badge variant={r.ActualRemaining <= 0 ? 'green' : r.Status === 'partial' ? 'yellow' : 'red'}>{r.ActualRemaining <= 0 ? 'مكتملة' : r.Status === 'partial' ? 'جزئية' : 'غير مدفوعة'}</Badge> },
            ]}
            data={data.rows}
            keyField="SaleNumber"
            emptyMessage="لا توجد مبيعات"
          />
        </div>
      );

    case 'purchases':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير المشتريات" />
          <div className="grid grid-cols-3 gap-4">
            <StatBox label="إجمالي المشتريات" value={data.totals?.total?.toFixed(2) || '0'} color="text-orange-600" />
            <StatBox label="المدفوع" value={data.totals?.paid?.toFixed(2) || '0'} color="text-green-600" />
            <StatBox label="المتبقي للموردين" value={data.totals?.remaining?.toFixed(2) || '0'} color="text-red-600" />
          </div>
          <DataTable
            columns={[
              { key: 'PurchaseNumber', title: 'رقم الفاتورة' },
              { key: 'Date', title: 'التاريخ' },
              { key: 'SupplierName', title: 'المورد' },
              { key: 'TotalAmount', title: 'الإجمالي', render: (r) => r.TotalAmount?.toFixed(2) },
              { key: 'PaidAmount', title: 'المدفوع', render: (r) => r.PaidAmount?.toFixed(2) },
              { key: 'RemainingAmount', title: 'المتبقي', render: (r) => r.RemainingAmount > 0 ? r.RemainingAmount?.toFixed(2) : '—' },
            ]}
            data={data.rows}
            keyField="PurchaseNumber"
            emptyMessage="لا توجد مشتريات"
          />
        </div>
      );

    case 'maintenance':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير الصيانة" />
          <div className="grid grid-cols-3 gap-4">
            <StatBox label="إجمالي التكلفة" value={data.totals?.totalCost?.toFixed(2) || '0'} color="text-blue-600" />
            <StatBox label="تكلفة القطع" value={data.totals?.partsCost?.toFixed(2) || '0'} color="text-orange-600" />
            <StatBox label="المصنعية" value={data.totals?.laborCost?.toFixed(2) || '0'} color="text-green-600" />
          </div>
          <DataTable
            columns={[
              { key: 'TicketNumber', title: 'رقم الأمر' },
              { key: 'Date', title: 'التاريخ' },
              { key: 'CustomerName', title: 'العميل' },
              { key: 'DeviceModel', title: 'الجهاز' },
              { key: 'TechnicianName', title: 'الفني', render: (r) => r.TechnicianName || '—' },
              { key: 'TotalCost', title: 'التكلفة', render: (r) => r.TotalCost?.toFixed(2) || '0' },
              { key: 'Status', title: 'الحالة', render: (r) => <Badge variant="blue">{r.Status}</Badge> },
            ]}
            data={data.rows}
            keyField="TicketNumber"
            emptyMessage="لا توجد أوامر صيانة"
          />
        </div>
      );

    case 'customers':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير العملاء" />
          <div className="grid grid-cols-2 gap-4">
            <StatBox label="عدد العملاء" value={data.totals?.totalCustomers || '0'} color="text-blue-600" />
            <StatBox label="إجمالي الأرصدة المستحقة" value={data.totals?.totalBalance?.toFixed(2) || '0'} color="text-red-600" />
          </div>
          <DataTable
            columns={[
              { key: 'Name', title: 'الاسم', render: (r) => <span className="font-medium">{r.Name}</span> },
              { key: 'Phone', title: 'الهاتف', render: (r) => r.Phone || '—' },
              { key: 'Balance', title: 'الرصيد', render: (r) => <span className={r.Balance > 0 ? 'text-red-600 font-bold' : 'text-green-600'}>{r.Balance?.toFixed(2)}</span> },
              { key: 'SalesCount', title: 'عدد الفواتير' },
              { key: 'TotalPurchases', title: 'إجمالي المشتريات', render: (r) => r.TotalPurchases?.toFixed(2) },
              { key: 'Status', title: 'الحالة', render: (r) => <Badge variant={r.Status === 'active' ? 'green' : r.Status === 'warned' ? 'yellow' : 'red'}>{r.Status === 'active' ? 'نشط' : r.Status === 'warned' ? 'تحذير' : 'محظور'}</Badge> },
            ]}
            data={data.rows}
            keyField="CustomerID"
            emptyMessage="لا يوجد عملاء"
          />
        </div>
      );

    case 'suppliers':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير الموردين" />
          <div className="grid grid-cols-2 gap-4">
            <StatBox label="عدد الموردين" value={data.totals?.totalSuppliers || '0'} color="text-blue-600" />
            <StatBox label="إجمالي المستحق للموردين" value={data.totals?.totalBalance?.toFixed(2) || '0'} color="text-orange-600" />
          </div>
          <DataTable
            columns={[
              { key: 'Name', title: 'الاسم', render: (r) => <span className="font-medium">{r.Name}</span> },
              { key: 'Phone', title: 'الهاتف', render: (r) => r.Phone || '—' },
              { key: 'Balance', title: 'الرصيد', render: (r) => <span className={r.Balance > 0 ? 'text-orange-600 font-bold' : 'text-green-600'}>{r.Balance?.toFixed(2)}</span> },
              { key: 'PurchaseCount', title: 'عدد الفواتير' },
              { key: 'TotalPurchases', title: 'إجمالي المشتريات', render: (r) => r.TotalPurchases?.toFixed(2) },
            ]}
            data={data.rows}
            keyField="SupplierID"
            emptyMessage="لا يوجد موردين"
          />
        </div>
      );

    case 'employees':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير الموظفين" />
          <DataTable
            columns={[
              { key: 'Name', title: 'الاسم', render: (r) => <span className="font-medium">{r.Name}</span> },
              { key: 'Position', title: 'الوظيفة', render: (r) => r.Position || '—' },
              { key: 'BaseSalary', title: 'الراتب', render: (r) => r.BaseSalary?.toFixed(2) },
              { key: 'TotalPaid', title: 'الإجمالي المدفوع', render: (r) => <span className="text-green-600">{r.TotalPaid?.toFixed(2)}</span> },
              { key: 'UnpaidCommissions', title: 'عمولات غير مدفوعة', render: (r) => r.UnpaidCommissions > 0 ? <span className="text-orange-600">{r.UnpaidCommissions?.toFixed(2)}</span> : '—' },
              { key: 'UnpaidAdvances', title: 'سلف غير مخصومة', render: (r) => r.UnpaidAdvances > 0 ? <span className="text-red-600">{r.UnpaidAdvances?.toFixed(2)}</span> : '—' },
              { key: 'Balance', title: 'الرصيد', render: (r) => r.Balance?.toFixed(2) },
            ]}
            data={data.rows}
            keyField="EmployeeID"
            emptyMessage="لا يوجد موظفون"
          />
        </div>
      );

    case 'inventory':
      return (
        <div className="space-y-4">
          <ReportTitle title="تقرير المخازن" />
          <div className="grid grid-cols-3 gap-4">
            <StatBox label="عدد الأصناف" value={data.totals?.totalItems || '0'} color="text-blue-600" />
            <StatBox label="قيمة المخزون" value={data.totals?.stockValue?.toFixed(2) || '0'} color="text-green-600" />
            <StatBox label="أصناف منخفضة" value={data.totals?.lowStock || '0'} color="text-red-600" />
          </div>
          <DataTable
            columns={[
              { key: 'ItemName', title: 'الصنف', render: (r) => <span className="font-medium">{r.ItemName}</span> },
              { key: 'stock', title: 'المخزون', render: (r) => r.IsSerialized ? `${r.AvailableSerials} متاح / ${r.SoldSerials} مباع` : r.TotalStock },
              { key: 'SalePrice', title: 'سعر البيع', render: (r) => r.SalePrice?.toFixed(2) },
              { key: 'MinStock', title: 'حد التنبيه', render: (r) => r.MinStock },
            ]}
            data={data.rows}
            keyField="ItemID"
            emptyMessage="لا توجد أصناف"
          />
        </div>
      );

    case 'profitLoss':
      return <ProfitLossReport data={data} />;

    case 'financialPosition':
      return <FinancialPositionReport data={data} />;

    default:
      return null;
  }
}

function ReportTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-slate-700">
      <FileText size={20} className="text-primary-600" />
      <h2 className="text-lg font-semibold text-slate-800 dark:text-white">{title}</h2>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function ReportLine({ label, value, bold, large }: { label: string; value: number; bold?: boolean; large?: boolean }) {
  const num = typeof value === 'number' ? value : 0;
  return (
    <div className={`flex items-center justify-between py-1 ${bold ? 'border-t border-slate-200 dark:border-slate-700 mt-1 pt-2' : ''}`}>
      <span className={`${bold ? 'font-bold' : ''} ${large ? 'text-lg' : 'text-sm'} text-slate-700 dark:text-slate-200`}>{label}</span>
      <span className={`${bold ? 'font-bold' : ''} ${large ? 'text-xl' : 'text-sm'} ${num >= 0 ? 'text-slate-800 dark:text-white' : 'text-red-600'}`}>{num.toFixed(2)}</span>
    </div>
  );
}

function ProfitLossReport({ data }: { data: any }) {
  const pl = data || {};
  const rev = pl.revenue || {};
  const costs = pl.costs || {};
  const exp = pl.expenses || {};
  const netP = typeof pl.netProfit === 'number' ? pl.netProfit : 0;
  return (
    <div className="space-y-6">
      <ReportTitle title="قائمة الأرباح والخسائر" />

      <div>
        <h3 className="text-sm font-semibold text-green-700 dark:text-green-400 mb-2 pb-2 border-b border-green-200 dark:border-green-800">الإيرادات</h3>
        <div className="space-y-1">
          <ReportLine label="إجمالي المبيعات" value={rev.salesGross ?? 0} />
          <ReportLine label="(-) مرتجعات المبيعات" value={-(rev.salesReturns ?? 0)} />
          <ReportLine label="= صافي المبيعات" value={rev.netSales ?? 0} bold />
          <ReportLine label="إيرادات الصيانة" value={rev.maintenance ?? 0} />
          <ReportLine label="(-) مرتجعات الصيانة" value={-(rev.maintenanceReturns ?? 0)} />
          <ReportLine label="إيرادات الخدمات (تحويل وشحن)" value={rev.services ?? 0} />
          <ReportLine label="إيرادات إيجار (لنا)" value={rev.rentIncome ?? 0} />
          <ReportLine label="إيرادات أخرى (سندات قبض)" value={rev.otherIncome ?? 0} />
          <ReportLine label="إجمالي الإيرادات" value={rev.total ?? 0} bold />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-orange-700 dark:text-orange-400 mb-2 pb-2 border-b border-orange-200 dark:border-orange-800">التكاليف المباشرة</h3>
        <div className="space-y-1">
          <ReportLine label="تكلفة البضاعة المباعة (COGS)" value={costs.cogs ?? 0} />
          <ReportLine label="(-) عكس تكلفة المرتجعات" value={-(costs.cogsReturns ?? 0)} />
          <ReportLine label="تكلفة قطع غيار الصيانة" value={costs.parts ?? 0} />
          <ReportLine label="تكلفة الخدمات (تحويل وشحن)" value={costs.serviceCosts ?? 0} />
          <ReportLine label="إجمالي التكاليف المباشرة" value={costs.total ?? 0} bold />
        </div>
      </div>

      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
        <ReportLine label="مجمل الربح (الإيرادات - التكاليف المباشرة)" value={pl.grossProfit ?? 0} bold large />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2 pb-2 border-b border-red-200 dark:border-red-800">المصروفات التشغيلية</h3>
        <div className="space-y-1">
          <ReportLine label="مصروفات عامة (كهرباء، مياه، إلخ)" value={exp.general ?? 0} />
          <ReportLine label="رواتب (التكلفة الإجمالية)" value={exp.salaries ?? 0} />
          <ReportLine label="إيجار مدفوع (علينا)" value={exp.rent ?? 0} />
          <ReportLine label="إجمالي المصروفات" value={exp.total ?? 0} bold />
        </div>
      </div>

      <div className={`rounded-lg p-4 ${netP >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-slate-800 dark:text-white">صافي الربح / الخسارة</span>
          <span className={`text-2xl font-bold ${netP >= 0 ? 'text-green-600' : 'text-red-600'}`}>{netP >= 0 ? '+' : ''}{netP.toFixed(2)}</span>
        </div>
      </div>

      <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400 space-y-1">
        <div><strong>ملاحظات محاسبية:</strong></div>
        <div>• سندات الصرف لموردين/عملاء = سداد دين وليست مصروف (تُحتسب فقط السندات العامة)</div>
        <div>• سندات القبض من عملاء/موردين = تحصيل دين وليست إيراد (تُحتسب فقط السندات العامة)</div>
        <div>• السلف = ذمم مدينة/أصل وليست مصروف (ظهرت ضمن الأصول في المركز المالي)</div>
        <div>• الخصومات = جزء من حساب الرواتب وليست بند منفصل (الرواتب تُحتسب بالصافي)</div>
        <div>• تكلفة الخدمات = ServiceCost + Amount + TransferCost من service_sales</div>
        <div>• أرباح المحمول والتحويل = ChargeAmount - (ServiceCost + Amount + TransferCost)</div>
      </div>
    </div>
  );
}

function FinancialPositionReport({ data }: { data: any }) {
  const fp = data || {};
  const assets = fp.assets || {};
  const liab = fp.liabilities || {};
  const cap = fp.capital || {};
  return (
    <div className="space-y-6">
      <ReportTitle title="المركز المالي (الميزانية)" />
      <p className="text-xs text-slate-500 dark:text-slate-400">حالة لحظية للأرصدة - بدون قيود محاسبية</p>

      <div>
        <h3 className="text-sm font-semibold text-green-700 dark:text-green-400 mb-2 pb-2 border-b border-green-200 dark:border-green-800">الأصول (ما نملكه)</h3>
        <div className="space-y-1">
          <ReportLine label="رصيد الخزائن والبنوك" value={assets.totalCash ?? 0} />
          <ReportLine label="رصيد ماكينات وأنظمة الدفع" value={assets.totalPaymentMethods ?? 0} />
          <ReportLine label="ذمم العملاء (مستحقة لنا)" value={assets.totalCustomers ?? 0} />
          <ReportLine label="سلف الموظفين (غير مخصومة)" value={assets.employeeAdvances ?? 0} />
          <ReportLine label="قيمة المخزون" value={assets.totalInventory ?? 0} />
          <ReportLine label="إجمالي الأصول" value={assets.totalAssets ?? 0} bold />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2 pb-2 border-b border-red-200 dark:border-red-800">الخصوم (ما علينا)</h3>
        <div className="space-y-1">
          <ReportLine label="ذمم الموردين (مستحقة لهم)" value={liab.totalSuppliers ?? 0} />
          <ReportLine label="مستحقات الموظفين" value={liab.totalEmployees ?? 0} />
          <ReportLine label="أرصدة دائنة للعملاء (فائض مدفوع)" value={liab.totalCustomerCredits ?? 0} />
          <ReportLine label="إجمالي الخصوم" value={liab.totalLiabilities ?? 0} bold />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400 mb-2 pb-2 border-b border-blue-200 dark:border-blue-800">حقوق الملكية (رأس المال + الأرباح)</h3>
        <div className="space-y-1">
          <ReportLine label="رأس المال الافتتاحي" value={cap.explicitCapital ?? 0} />
          <ReportLine label="صافي الربح / الخسارة (من P&L)" value={cap.netProfit ?? 0} />
          <ReportLine label="إجمالي حقوق الملكية" value={cap.calculatedCapital ?? 0} bold />
        </div>
      </div>

      <div className={`rounded-lg p-4 ${Math.abs((cap.balanceCheck ?? 0) - (cap.calculatedCapital ?? 0)) < 1 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-orange-50 dark:bg-orange-900/20'}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">التحقق من التوازن (أصول - خصوم = حقوق ملكية)</span>
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">الأصول - الخصوم</span><span className="font-bold text-slate-800 dark:text-white">{(cap.balanceCheck ?? 0).toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">حقوق الملكية (رأس المال + الربح)</span><span className="font-bold text-slate-800 dark:text-white">{(cap.calculatedCapital ?? 0).toFixed(2)}</span></div>
          <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-slate-700">
            <span className="font-bold text-slate-700 dark:text-slate-200">الفرق (أرباح محتجزة / خسائر متراكمة)</span>
            <span className={`font-bold ${(cap.retainedEarnings ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {(cap.retainedEarnings ?? 0) >= 0 ? '+' : ''}{(cap.retainedEarnings ?? 0).toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
