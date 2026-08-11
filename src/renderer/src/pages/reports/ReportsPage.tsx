import { useState, useEffect } from 'react';
import { FileText, Calendar, Printer } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';
import { escapeHtml as esc, safeNumber } from '../../../../shared/escapeHtml';
import { printHeaderHtml, printFooterHtml, printHeaderCss } from '../../lib/printHeader';

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
  const [settings, setSettings] = useState<any>({});

  useEffect(() => {
    (async () => {
      setSettings(await window.api.invoke('settings:getAll'));
    })();
  }, []);

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
    if (!report?.data) {
      showToast('error', 'لا توجد بيانات للطباعة');
      return;
    }
    const html = buildReportPrintHtml(activeReport, report.data, settings, fromDate, toDate);
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(html);
    printWindow.document.close();
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
          <ReportLine label="ذمم الموردين (مستحقة لنا) — فائض مدفوع أو مرتجع غير مسترد" value={assets.totalSupplierCredits ?? 0} />
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

// ------------------------------------------------------------------ printing
//
// The reports screen used to call `window.print()` on the whole React app, so
// the sidebar, the header and the page chrome all landed on the paper. Every
// other printable document in the app (invoices, statements, the assets
// register) builds a standalone HTML document in a fresh window instead, with
// the shop's letterhead and a proper A4 layout. The reports now do the same:
// `buildReportPrintHtml` serialises the CURRENT report into a clean document
// and prints only that. See `printHeader.ts` for the shared letterhead.

/** A column definition shared between the on-screen table and the printout. */
interface PrintColumn {
  title: string;
  align?: 'right' | 'center';
  bold?: boolean;
  render: (r: any) => string;
}

function escNum(v: unknown, digits = 2): string {
  return v === null || v === undefined || v === '' ? '—' : safeNumber(v, digits);
}

function reportPrintTitle(type: ReportType): string {
  return (reportTypes.find(r => r.key === type)?.label) || 'تقرير';
}

function reportTableColumns(type: ReportType): PrintColumn[] | null {
  switch (type) {
    case 'sales':
      return [
        { title: 'رقم الفاتورة', align: 'center' as const, render: r => esc(r.SaleNumber) },
        { title: 'التاريخ', align: 'center' as const, render: r => esc(r.Date) },
        { title: 'العميل', render: r => esc(r.CustomerName || '—') },
        { title: 'الإجمالي', render: r => escNum(r.TotalAmount) },
      ];
    case 'purchases':
      return [
        { title: 'رقم الفاتورة', align: 'center' as const, render: r => esc(r.PurchaseNumber) },
        { title: 'التاريخ', align: 'center' as const, render: r => esc(r.Date) },
        { title: 'المورد', render: r => esc(r.SupplierName) },
        { title: 'الإجمالي', render: r => escNum(r.TotalAmount) },
      ];
    case 'maintenance':
      return [
        { title: 'رقم الأمر', align: 'center' as const, render: r => esc(r.TicketNumber) },
        { title: 'التاريخ', align: 'center' as const, render: r => esc(r.Date) },
        { title: 'العميل', render: r => esc(r.CustomerName) },
        { title: 'الجهاز', render: r => esc(r.DeviceModel) },
        { title: 'الفني', render: r => esc(r.TechnicianName || '—') },
        { title: 'التكلفة', render: r => escNum(r.TotalCost) },
      ];
    case 'customers':
      return [
        { title: 'الاسم', bold: true as const, render: r => esc(r.Name) },
        { title: 'الهاتف', render: r => esc(r.Phone || '—') },
        { title: 'الرصيد', bold: true as const, render: r => escNum(r.Balance) },
        { title: 'عدد الفواتير', align: 'center' as const, render: r => escNum(r.SalesCount, 0) },
        { title: 'إجمالي المشتريات', render: r => escNum(r.TotalPurchases) },
      ];
    case 'suppliers':
      return [
        { title: 'الاسم', bold: true as const, render: r => esc(r.Name) },
        { title: 'الهاتف', render: r => esc(r.Phone || '—') },
        { title: 'الرصيد', bold: true as const, render: r => escNum(r.Balance) },
        { title: 'عدد الفواتير', align: 'center' as const, render: r => escNum(r.PurchaseCount, 0) },
        { title: 'إجمالي المشتريات', render: r => escNum(r.TotalPurchases) },
      ];
    case 'employees':
      return [
        { title: 'الاسم', bold: true as const, render: r => esc(r.Name) },
        { title: 'الوظيفة', render: r => esc(r.Position || '—') },
        { title: 'الراتب', render: r => escNum(r.BaseSalary) },
        { title: 'المدفوع', render: r => escNum(r.TotalPaid) },
        { title: 'عمولات غير مدفوعة', render: r => escNum(r.UnpaidCommissions) },
        { title: 'سلف غير مخصومة', render: r => escNum(r.UnpaidAdvances) },
        { title: 'الرصيد', bold: true as const, render: r => escNum(r.Balance) },
      ];
    case 'inventory':
      return [
        { title: 'الصنف', bold: true as const, render: r => esc(r.ItemName) },
        { title: 'المخزون', align: 'center' as const, render: r => r.IsSerialized ? `${escNum(r.AvailableSerials, 0)} متاح / ${escNum(r.SoldSerials, 0)} مباع` : escNum(r.TotalStock, 0) },
        { title: 'سعر البيع', render: r => escNum(r.SalePrice) },
        { title: 'حد التنبيه', align: 'center' as const, render: r => escNum(r.MinStock, 0) },
      ];
    default:
      return null;
  }
}

/**
 * Renders the report rows as HTML table rows. Only the column set defined
 * above appears, so the printout carries exactly what the on-screen table
 * shows — never the app's navigation chrome.
 */
function renderRows(rows: any[] | null | undefined, cols: PrintColumn[]): string {
  const safe = Array.isArray(rows) ? rows : [];
  if (safe.length === 0) {
    return `<tr><td colspan="${cols.length}" style="text-align:center;color:#94a3b8;padding:8mm">لا توجد بيانات</td></tr>`;
  }
  return safe.map(r => {
    const tds = cols.map(c => {
      const content = c.render(r);
      const align = c.align === 'center' ? 'center' : 'right';
      const bold = c.bold ? 'font-weight:700;' : '';
      return `<td style="text-align:${align};padding:5px 4px;border:1px solid #e2e8f0;font-size:11px;${bold}">${content}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
}

function renderSummaryBox(label: string, value: string, color = '#1e293b'): string {
  return `<div class="summary-item"><span style="font-size:10px;color:#94a3b8">${esc(label)}</span><div class="num" style="color:${color}">${value}</div></div>`;
}

/**
 * Builds a standalone A4 document for the given report. Kept separate from the
 * React tree so the printed page is only the report — no sidebar, no header.
 */
function buildReportPrintHtml(
  type: ReportType,
  data: any,
  settings: any,
  fromDate?: string,
  toDate?: string,
): string {
  const title = reportPrintTitle(type);
  const cols = reportTableColumns(type);
  const rows = asRows<any>(data?.rows);
  const period = (fromDate || toDate)
    ? `الفترة: ${esc(fromDate || '...')} إلى ${esc(toDate || '...')}`
    : '';

  let body = '';
  if (type === 'profitLoss') {
    const pl = data || {};
    const rev = pl.revenue || {}; const costs = pl.costs || {}; const exp = pl.expenses || {};
    const netP = typeof pl.netProfit === 'number' ? pl.netProfit : 0;
    body = `
      <h3 class="section green">الإيرادات</h3>
      ${printLine('إجمالي المبيعات', rev.salesGross)}
      ${printLine('(-) مرتجعات المبيعات', -(rev.salesReturns ?? 0))}
      ${printLine('= صافي المبيعات', rev.netSales, true)}
      ${printLine('إيرادات الصيانة', rev.maintenance)}
      ${printLine('(-) مرتجعات الصيانة', -(rev.maintenanceReturns ?? 0))}
      ${printLine('إيرادات الخدمات (تحويل وشحن)', rev.services)}
      ${printLine('إيرادات إيجار (لنا)', rev.rentIncome)}
      ${printLine('إيرادات أخرى (سندات قبض)', rev.otherIncome)}
      ${printLine('إجمالي الإيرادات', rev.total, true)}
      <h3 class="section orange">التكاليف المباشرة</h3>
      ${printLine('تكلفة البضاعة المباعة (COGS)', costs.cogs)}
      ${printLine('(-) عكس تكلفة المرتجعات', -(costs.cogsReturns ?? 0))}
      ${printLine('تكلفة قطع غيار الصيانة', costs.parts)}
      ${printLine('تكلفة الخدمات (تحويل وشحن)', costs.serviceCosts)}
      ${printLine('إجمالي التكاليف المباشرة', costs.total, true)}
      <div class="gross">${printLine('مجمل الربح (الإيرادات - التكاليف المباشرة)', pl.grossProfit, true)}</div>
      <h3 class="section red">المصروفات التشغيلية</h3>
      ${printLine('مصروفات عامة (كهرباء، مياه، إلخ)', exp.general)}
      ${printLine('رواتب (التكلفة الإجمالية)', exp.salaries)}
      ${printLine('إيجار مدفوع (علينا)', exp.rent)}
      ${printLine('إجمالي المصروفات', exp.total, true)}
      <div class="net ${netP >= 0 ? 'positive' : 'negative'}">
        <span>صافي الربح / الخسارة</span>
        <strong>${netP >= 0 ? '+' : ''}${safeNumber(netP)}</strong>
      </div>`;
  } else if (type === 'financialPosition') {
    const fp = data || {};
    const assets = fp.assets || {}; const liab = fp.liabilities || {}; const cap = fp.capital || {};
    body = `
      <h3 class="section green">الأصول (ما نملكه)</h3>
      ${printLine('رصيد الخزائن والبنوك', assets.totalCash)}
      ${printLine('رصيد ماكينات وأنظمة الدفع', assets.totalPaymentMethods)}
      ${printLine('ذمم العملاء (مستحقة لنا)', assets.totalCustomers)}
      ${printLine('ذمم الموردين (مستحقة لنا) — فائض مدفوع أو مرتجع غير مسترد', assets.totalSupplierCredits)}
      ${printLine('سلف الموظفين (غير مخصومة)', assets.employeeAdvances)}
      ${printLine('قيمة المخزون', assets.totalInventory)}
      ${printLine('إجمالي الأصول', assets.totalAssets, true)}
      <h3 class="section red">الخصوم (ما علينا)</h3>
      ${printLine('ذمم الموردين (مستحقة لهم)', liab.totalSuppliers)}
      ${printLine('مستحقات الموظفين', liab.totalEmployees)}
      ${printLine('أرصدة دائنة للعملاء (فائض مدفوع)', liab.totalCustomerCredits)}
      ${printLine('إجمالي الخصوم', liab.totalLiabilities, true)}
      <h3 class="section blue">حقوق الملكية (رأس المال + الأرباح)</h3>
      ${printLine('رأس المال الافتتاحي', cap.explicitCapital)}
      ${printLine('صافي الربح / الخسارة (من P&L)', cap.netProfit)}
      ${printLine('إجمالي حقوق الملكية', cap.calculatedCapital, true)}
      <div class="check">
        <div class="chk-row"><span>الأصول - الخصوم</span><strong>${safeNumber(cap.balanceCheck)}</strong></div>
        <div class="chk-row"><span>حقوق الملكية (رأس المال + الربح)</span><strong>${safeNumber(cap.calculatedCapital)}</strong></div>
        <div class="chk-row total"><span>الفرق (أرباح محتجزة / خسائر متراكمة)</span><strong>${(cap.retainedEarnings ?? 0) >= 0 ? '+' : ''}${safeNumber(cap.retainedEarnings)}</strong></div>
      </div>`;
  } else if (cols) {
    let summary = '';
    const totals = data?.totals || {};
    switch (type) {
      case 'sales':
        summary = renderSummaryBox('إجمالي المبيعات', safeNumber(totals.total), '#16a34a')
          + renderSummaryBox('مدفوع بالفاتورة', safeNumber(totals.paid), '#2563eb')
          + renderSummaryBox('سدد لاحقاً (سندات)', safeNumber(totals.laterPayments), '#0891b2')
          + renderSummaryBox('المتبقي فعلياً', safeNumber(totals.remaining), '#dc2626');
        break;
      case 'purchases':
        summary = renderSummaryBox('إجمالي المشتريات', safeNumber(totals.total), '#ea580c')
          + renderSummaryBox('المدفوع', safeNumber(totals.paid), '#16a34a')
          + renderSummaryBox('المتبقي للموردين', safeNumber(totals.remaining), '#dc2626');
        break;
      case 'maintenance':
        summary = renderSummaryBox('إجمالي التكلفة', safeNumber(totals.totalCost), '#2563eb')
          + renderSummaryBox('تكلفة القطع', safeNumber(totals.partsCost), '#ea580c')
          + renderSummaryBox('المصنعية', safeNumber(totals.laborCost), '#16a34a');
        break;
      case 'customers':
        summary = renderSummaryBox('عدد العملاء', safeNumber(totals.totalCustomers, 0), '#2563eb')
          + renderSummaryBox('إجمالي الأرصدة المستحقة', safeNumber(totals.totalBalance), '#dc2626');
        break;
      case 'suppliers':
        summary = renderSummaryBox('عدد الموردين', safeNumber(totals.totalSuppliers, 0), '#2563eb')
          + renderSummaryBox('إجمالي المستحق للموردين', safeNumber(totals.totalBalance), '#ea580c');
        break;
      case 'inventory':
        summary = renderSummaryBox('عدد الأصناف', safeNumber(totals.totalItems, 0), '#2563eb')
          + renderSummaryBox('قيمة المخزون', safeNumber(totals.stockValue), '#16a34a')
          + renderSummaryBox('أصناف منخفضة', safeNumber(totals.lowStock, 0), '#dc2626');
        break;
    }
    body = `
      <div class="summary">${summary}</div>
      <table>
        <tr>${cols.map(c => `<th${c.align === 'center' ? ' style="text-align:center"' : ''}>${esc(c.title)}</th>`).join('')}</tr>
        ${renderRows(rows, cols)}
      </table>`;
  } else {
    body = `<p style="text-align:center;color:#94a3b8;padding:10mm">لا توجد بيانات</p>`;
  }

  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
  <style>
    @page { size: A4; margin: 15mm 18mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; direction: rtl; color: #1e293b; font-size: 12px; }
    .sheet { width: 100%; }
    .report-header { text-align: center; margin-bottom: 8mm; border-bottom: 3px double #1e293b; padding-bottom: 5mm; }
    .report-header h1 { font-size: 20px; margin: 0 0 3mm; color: #1e293b; letter-spacing: 1px; }
    .report-header .company { font-size: 14px; color: #475569; margin-bottom: 1mm; }
    .report-header .sub { font-size: 11px; color: #64748b; }
    .period { text-align: center; font-size: 11px; color: #64748b; margin-bottom: 5mm; }
    table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
    th { background: #1e293b; color: white; font-weight: 700; padding: 6px 4px; border: 1px solid #1e293b; text-align: right; font-size: 11px; }
    td { padding: 5px 4px; border: 1px solid #e2e8f0; font-size: 11px; }
    tr:nth-child(even) { background: #f8fafc; }
    .summary { margin: 3mm 0 1mm; display: flex; gap: 4mm; justify-content: center; flex-wrap: wrap; }
    .summary-item { border: 1px solid #e2e8f0; border-radius: 4px; padding: 3mm 6mm; text-align: center; min-width: 80px; }
    .summary-item .num { font-size: 15px; font-weight: 700; margin-top: 1mm; }
    .section { font-size: 13px; font-weight: 700; margin: 6mm 0 2mm; padding-bottom: 2mm; border-bottom: 2px solid; }
    .section.green { color: #16a34a; border-color: #16a34a; }
    .section.orange { color: #ea580c; border-color: #ea580c; }
    .section.red { color: #dc2626; border-color: #dc2626; }
    .section.blue { color: #2563eb; border-color: #2563eb; }
    .line { display: flex; justify-content: space-between; padding: 2mm 0; font-size: 12px; }
    .line.bold { font-weight: 700; border-top: 1px solid #e2e8f0; margin-top: 1mm; }
    .gross { background: #eff6ff; border-radius: 4px; padding: 3mm 4mm; margin: 4mm 0; }
    .net { border-radius: 4px; padding: 4mm; margin-top: 5mm; display: flex; justify-content: space-between; align-items: center; }
    .net.positive { background: #f0fdf4; color: #16a34a; }
    .net.negative { background: #fef2f2; color: #dc2626; }
    .net strong { font-size: 18px; }
    .check { border: 1px solid #e2e8f0; border-radius: 4px; padding: 3mm 4mm; margin-top: 4mm; }
    .chk-row { display: flex; justify-content: space-between; padding: 1.5mm 0; font-size: 12px; }
    .chk-row.total { border-top: 1px solid #e2e8f0; margin-top: 1mm; padding-top: 2mm; font-weight: 700; }
    .footer { margin-top: 10mm; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 3mm; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    ${printHeaderCss(settings)}
  </style></head><body>
  <div class="sheet">
    ${printHeaderHtml(settings, title)}
    ${period ? `<div class="period">${period}</div>` : ''}
    ${body}
    ${printFooterHtml(settings, 'تمت الطباعة من نظام إدارة محلات الموبايلات')}
  </div>
  <script>window.print();window.onafterprint=()=>window.close();<\/script>
  </body></html>`;
}

function printLine(label: string, value: unknown, bold = false): string {
  const num = typeof value === 'number' ? value : 0;
  return `<div class="line ${bold ? 'bold' : ''}">
    <span>${esc(label)}</span>
    <span style="${num < 0 ? 'color:#dc2626;' : ''}">${safeNumber(num)}</span>
  </div>`;
}
