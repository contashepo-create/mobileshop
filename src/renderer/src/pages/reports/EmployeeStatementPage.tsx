import { useState, useEffect, useRef } from 'react';
import { Printer, FileText, Search, TrendingUp, TrendingDown, Wallet, Eye, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { asRows } from '../../lib/ipc';
import { escapeHtml as esc, safeNumber } from '../../../../shared/escapeHtml';
import { printHeaderHtml, printFooterHtml, printHeaderCss, printDocument } from '../../lib/printHeader';

export function EmployeeStatementPage() {
  const { showToast } = useToastStore();
  const [employeeId, setEmployeeId] = useState<string>('');
  const [employees, setEmployees] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewOp, setPreviewOp] = useState<any>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<any>({});

  useEffect(() => {
    (async () => {
      const list = await window.api.invoke('employees:list', { isActive: 1 });
      setEmployees(list);
      setSettings(await window.api.invoke('settings:getAll'));
    })();
  }, []);

  const filteredEmployees = employees.filter(e => {
    if (!searchQuery) return true;
    return e.Name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
           e.Position?.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const fetchStatement = async (id: number) => {
    setEmployeeId(id.toString());
    setLoading(true);
    const result = await window.api.invoke('employeeStatement:get', id);
    if (result.success) {
      setData(result);
    } else {
      showToast('error', result.message);
    }
    setLoading(false);
  };

  const previewRef = useRef<any>(null);

  const fetchPreview = async (op: any) => {
    setPreviewOp(op);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const result = await window.api.invoke('statement:getOperationDetail', op.OpType, op.RefID);
      previewRef.current = result || { primary: null, items: [], title: '' };
      setPreviewData(previewRef.current);
    } catch (err: any) {
      previewRef.current = { primary: null, items: [], title: '' };
      setPreviewData(previewRef.current);
      showToast('error', err.message || 'فشل تحميل التفاصيل');
    }
    setPreviewLoading(false);
  };

  const fieldLabels: Record<string, Record<string, string>> = {
    salary: {
      EmployeeName: 'الموظف', Month: 'الشهر', BaseSalary: 'الراتب الأساسي',
      Allowances: 'البدلات', CommissionsTotal: 'العمولات', DeductionsTotal: 'الخصومات',
      AdvancesTotal: 'السلف', NetSalary: 'صافي الراتب', PaidAmount: 'المدفوع',
      Remaining: 'المتبقي', Status: 'الحالة', PaymentDate: 'تاريخ الصرف',
    },
    advance: {
      EmployeeName: 'الموظف', Amount: 'المبلغ', Date: 'التاريخ',
      Reason: 'السبب', IsDeducted: 'مخصوم',
    },
    commission: {
      EmployeeName: 'الموظف', Amount: 'المبلغ', Date: 'التاريخ',
      CommissionType: 'نوع العمولة', IsPaid: 'مدفوع',
    },
    deduction: {
      EmployeeName: 'الموظف', Amount: 'المبلغ', Date: 'التاريخ',
      Reason: 'السبب', IsDeducted: 'مخصوم',
    },
    voucher_receipt: {
      VoucherNumber: 'رقم السند', Date: 'التاريخ', Amount: 'المبلغ',
      Description: 'البيان', CashAccountName: 'الحساب النقدي', Username: 'المستخدم',
    },
    voucher_payment: {
      VoucherNumber: 'رقم السند', Date: 'التاريخ', Amount: 'المبلغ',
      Description: 'البيان', CashAccountName: 'الحساب النقدي', Username: 'المستخدم',
    },
  };

  const ignoreFields = new Set(['SaleID', 'CustomerID', 'PurchaseID', 'SupplierID', 'ReturnID',
    'DeliveryID', 'TicketID', 'VoucherID', 'CashAccountID', 'PaymentMethodID', 'UserID',
    'EmployeeID', 'FiscalYearID', 'CreatedAt', 'ReferenceType', 'ReferenceID', 'PartyType',
    'PartyID', 'Source', 'SourceID', 'CommissionID', 'AdvanceID', 'DeductionID',
    'SalaryID', 'DeductedFromSalaryID', 'PaidInSalaryID', 'DamagedItemID', 'DamageCostType',
  ]);

  const opLabels: Record<string, string> = {
    salary: 'راتب', advance: 'سلفية', commission: 'عمولة', deduction: 'خصم',
    voucher_payment: 'سند صرف', voucher_receipt: 'سند قبض',
  };

  const renderPreviewContent = () => {
    if (!previewData?.primary) return <p className="text-center text-slate-500 py-4">لا توجد بيانات</p>;
    const labels = fieldLabels[previewOp.OpType] || {};
    const primary = previewData.primary;
    const fields = Object.entries(primary)
      .filter(([k]) => !ignoreFields.has(k) && labels[k])
      .map(([k, v]) => ({ label: labels[k], value: v }));

    return (
      <div ref={printRef} className="space-y-4">
        <table className="w-full text-sm">
          <tbody>
            {fields.map((f, i) => (
              <tr key={i} className="border-b border-slate-100 dark:border-slate-700">
                <td className="py-2 pl-4 text-slate-500 dark:text-slate-400 font-medium w-1/3">{f.label}</td>
                <td className="py-2 text-slate-800 dark:text-white">{String(f.value ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {previewData.items && previewData.items.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">الأصناف</h4>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-700">
                  <th className="text-right p-2 text-slate-600 dark:text-slate-300">الصنف</th>
                  <th className="text-right p-2 text-slate-600 dark:text-slate-300">الكمية</th>
                  <th className="text-right p-2 text-slate-600 dark:text-slate-300">السعر</th>
                  <th className="text-right p-2 text-slate-600 dark:text-slate-300">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {asRows<any>(previewData.items).map((item: any, i: number) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-slate-700">
                    <td className="p-2 text-slate-800 dark:text-white">{item.ItemName || item.Description || '—'}</td>
                    <td className="p-2 text-slate-600 dark:text-slate-300">{item.Quantity ?? '—'}</td>
                    <td className="p-2 text-slate-600 dark:text-slate-300">{item.UnitPrice?.toFixed(2) ?? item.UnitCost?.toFixed(2) ?? item.Amount?.toFixed(2) ?? '—'}</td>
                    <td className="p-2 text-slate-800 dark:text-white font-medium">{item.Total?.toFixed(2) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const buildPrintHTML = (data: any, op: any) => {
    const labels = fieldLabels[op.OpType] || {};
    const primary = data?.primary;
    if (!primary) return '';
    const fields = Object.entries(primary)
      .filter(([k]) => !ignoreFields.has(k) && labels[k])
      .map(([k, v]) => ({ label: labels[k], value: v }));
    const title = opLabels[op.OpType] || 'سند';
    return `
      <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
      <style>
        body { font-family: sans-serif; padding: 20px; color: #1e293b; direction: rtl; }
        h2 { text-align: center; margin-bottom: 20px; color: #1e293b; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        td, th { padding: 8px 12px; border: 1px solid #e2e8f0; text-align: right; }
        th { background: #f1f5f9; font-weight: 600; }
        .items-table { margin-top: 20px; }
      </style></head><body>
      <h2>${esc(title)}</h2>
      <table>${fields.map(f => `<tr><td style="width:30%;font-weight:600;background:#f8fafc">${esc(f.label)}</td><td>${esc(f.value ?? '—')}</td></tr>`).join('')}</table>
      ${data.items?.length ? `<h3 style="margin-top:20px">الأصناف</h3><table class="items-table"><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>${data.items.map((item: any) => `<tr><td>${esc(item.ItemName || item.Description || '—')}</td><td>${esc(item.Quantity ?? '—')}</td><td>${item.UnitPrice ?? item.UnitCost ?? item.Amount ? safeNumber(item.UnitPrice ?? item.UnitCost ?? item.Amount) : '—'}</td><td>${item.Total != null ? safeNumber(item.Total) : '—'}</td></tr>`).join('')}</table>` : ''}
      <p style="margin-top:30px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px">تمت الطباعة من نظام المحمول</p>
      </body></html>`;
  };

  const handlePrintRecord = () => {
    if (!previewRef.current?.primary) return;
    const html = buildPrintHTML(previewRef.current, previewOp);
    if (!html) return;
    printDocument(html);
  };

  const handlePrintStatement = () => {
    if (!data?.operations?.length || !employee) return;
    const rows = data.operations.map((op: any) => {
      const info = opTypeLabels[op.OpType] || { label: op.OpType, variant: 'gray' };
      let statusText = '';
      if (op.OpType === 'salary') statusText = op.Status === 'paid' ? 'مدفوع' : op.Status === 'partial' ? 'جزئي' : 'معلّق';
      else if (op.OpType === 'advance' || op.OpType === 'deduction') statusText = op.IsDeducted ? 'مخصوم' : 'معلّق';
      else if (op.OpType === 'commission') statusText = op.IsPaid ? 'مدفوع' : 'معلّق';
      return `<tr>
        <td style="text-align:center">${esc(op.Date || op.Month || '')}</td>
        <td style="text-align:center">${esc(info.label)}</td>
        <td style="text-align:center">${esc(op.RefNumber || '')}</td>
        <td>${esc(op.Description || '')}</td>
        <td style="text-align:center;color:#dc2626;font-weight:600">${op.Debit ? safeNumber(op.Debit) : '—'}</td>
        <td style="text-align:center;color:#16a34a;font-weight:600">${op.Credit ? safeNumber(op.Credit) : '—'}</td>
        <td style="text-align:center">${esc(statusText)}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
    <style>
      @page { size: A4; margin: 15mm 20mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; direction: rtl; color: #1e293b; font-size: 12px; }
      .sheet { width: 100%; }
      .report-header { text-align: center; margin-bottom: 8mm; border-bottom: 3px double #1e293b; padding-bottom: 5mm; }
      .report-header h1 { font-size: 20px; margin: 0 0 3mm; color: #1e293b; letter-spacing: 1px; }
      .report-header .company { font-size: 14px; color: #475569; margin-bottom: 1mm; }
      .report-header .sub { font-size: 11px; color: #64748b; }
      .party-box { border: 2px solid #e2e8f0; border-radius: 4px; padding: 4mm 5mm; margin-bottom: 5mm; display: flex; justify-content: space-between; }
      .party-box .label { font-size: 10px; color: #94a3b8; }
      .party-box .value { font-weight: 700; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
      th { background: #1e293b; color: white; font-weight: 700; padding: 6px 4px; border: 1px solid #1e293b; text-align: center; font-size: 11px; }
      td { padding: 5px 4px; border: 1px solid #e2e8f0; font-size: 11px; }
      tr:nth-child(even) { background: #f8fafc; }
      .totals-row { background: #f1f5f9 !important; font-weight: 700; }
      .summary { margin-top: 5mm; display: flex; gap: 4mm; justify-content: center; flex-wrap: wrap; }
      .summary-item { border: 1px solid #e2e8f0; border-radius: 4px; padding: 3mm 5mm; text-align: center; min-width: 70px; }
      .summary-item .num { font-size: 16px; font-weight: 700; margin-top: 1mm; }
      .signatures { margin-top: 12mm; display: flex; justify-content: space-between; }
      .sig-box { text-align: center; min-width: 120px; }
      .sig-box .line { border-top: 1px solid #64748b; margin-top: 20mm; padding-top: 3mm; font-size: 11px; color: #475569; }
      .footer { margin-top: 8mm; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 3mm; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      ${printHeaderCss(settings)}
    </style></head><body>
    <div class="sheet">
      ${printHeaderHtml(settings, 'كشف حساب موظف')}
      <div class="party-box">
        <div><div class="label">اسم الموظف</div><div class="value">${esc(employee.Name)}</div></div>
        <div><div class="label">الوظيفة</div><div class="value">${esc(employee.Position || '—')}</div></div>
        <div><div class="label">الهاتف</div><div class="value">${esc(employee.Phone || '—')}</div></div>
        <div><div class="label">الراتب الأساسي</div><div class="value">${safeNumber(employee.BaseSalary || 0)}</div></div>
      </div>
      <table>
        <tr><th width="12%">التاريخ</th><th width="12%">النوع</th><th width="10%">المرجع</th><th>البيان</th><th width="13%">مدفوع</th><th width="13%">مستحق</th><th width="12%">الحالة</th></tr>
        ${rows}
      </table>
      <div class="summary">
        <div class="summary-item"><span style="font-size:11px">صافي الرواتب</span><div class="num">${safeNumber(data.totals.totalSalariesNet || 0)}</div></div>
        <div class="summary-item"><span style="font-size:11px;color:#16a34a">المنصرف</span><div class="num" style="color:#16a34a">${safeNumber(data.totals.totalSalariesPaid || 0)}</div></div>
        <div class="summary-item"><span style="font-size:11px;color:#dc2626">المتبقي</span><div class="num" style="color:#dc2626">${safeNumber(data.totals.totalSalariesRemaining || 0)}</div></div>
        <div class="summary-item"><span style="font-size:11px">العمولات</span><div class="num">${safeNumber(data.totals.totalCommissions || 0)}</div></div>
      </div>
      <div class="signatures">
        <div class="sig-box"><div class="line">إدارة المحل</div></div>
        <div class="sig-box"><div class="line">المحاسب</div></div>
        <div class="sig-box"><div class="line">الموظف</div></div>
      </div>
      ${printFooterHtml(settings, 'هذا الكشف معتمد ومعتبر لدى الطرفين')}
    </div>
    </body></html>`;
    printDocument(html);
  };

  const opTypeLabels: Record<string, { label: string; variant: string }> = {
    salary: { label: 'راتب', variant: 'blue' },
    advance: { label: 'سلفية', variant: 'orange' },
    commission: { label: 'عمولة', variant: 'green' },
    deduction: { label: 'خصم', variant: 'red' },
    voucher_payment: { label: 'سند صرف', variant: 'orange' },
    voucher_receipt: { label: 'سند قبض', variant: 'green' },
  };

  const employee = data?.employee;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between no-print">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">كشف حساب موظف</h1>
        {data && <Button variant="secondary" onClick={handlePrintStatement} icon={<Printer size={16} />}>طباعة الكشف</Button>}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 no-print">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">اختر الموظف</label>
            <div className="relative mb-2">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث بالاسم أو الوظيفة..."
                className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
              {filteredEmployees.length === 0 ? (
                <p className="text-center text-slate-500 dark:text-slate-400 py-3 text-sm">لا يوجد موظفون</p>
              ) : (
                filteredEmployees.map((e: any) => (
                  <button
                    key={e.EmployeeID}
                    onClick={() => fetchStatement(e.EmployeeID)}
                    className={`w-full text-right px-3 py-2.5 border-b border-slate-100 dark:border-slate-700/50 last:border-0 transition-colors ${
                      employeeId === e.EmployeeID.toString()
                        ? 'bg-primary-50 dark:bg-primary-900/20 border-r-4 border-r-primary-600'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium text-sm text-slate-800 dark:text-white">{e.Name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">{e.Position || '—'}</span>
                      </div>
                      <span className={`text-xs font-bold ${e.Balance > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {e.Balance?.toFixed(2)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {loading && <p className="text-center text-slate-500 dark:text-slate-400 py-8">جاري التحميل...</p>}

      {!loading && data && employee && (
        <div className="space-y-4">
          {/* Employee info */}
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 pb-4 border-b border-slate-200 dark:border-slate-700">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الاسم</div>
                <div className="font-bold text-slate-800 dark:text-white">{employee.Name}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الوظيفة</div>
                <div className="text-slate-700 dark:text-slate-200">{employee.Position || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الراتب الأساسي</div>
                <div className="text-slate-700 dark:text-slate-200">{employee.BaseSalary?.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الرصيد الحالي</div>
                <div className={`font-bold ${employee.Balance > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {employee.Balance?.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 flex items-center gap-3">
                <Wallet size={20} className="text-blue-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">إجمالي الرواتب</div>
                  <div className="text-base font-bold text-blue-600">{data.totals.totalSalariesNet?.toFixed(2)}</div>
                </div>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 flex items-center gap-3">
                <TrendingUp size={20} className="text-green-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">المنصرف</div>
                  <div className="text-base font-bold text-green-600">{data.totals.totalSalariesPaid?.toFixed(2)}</div>
                </div>
              </div>
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 flex items-center gap-3">
                <TrendingDown size={20} className="text-orange-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">المتبقي (غير منصرف)</div>
                  <div className="text-base font-bold text-orange-600">{data.totals.totalSalariesRemaining?.toFixed(2)}</div>
                </div>
              </div>
              <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 flex items-center gap-3">
                <TrendingUp size={20} className="text-purple-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">إجمالي العمولات</div>
                  <div className="text-base font-bold text-purple-600">{data.totals.totalCommissions?.toFixed(2)}</div>
                </div>
              </div>
            </div>

            {/* Pending items */}
            <div className="grid grid-cols-3 gap-3 mt-3">
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2.5 text-center">
                <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">عمولات معلّقة (غير مخصومة)</div>
                <div className="text-sm font-bold text-green-600">{data.totals.pendingCommissions?.toFixed(2)}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2.5 text-center">
                <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">خصومات معلّقة</div>
                <div className="text-sm font-bold text-red-600">{data.totals.pendingDeductions?.toFixed(2)}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2.5 text-center">
                <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">سلف معلّقة (غير مخصومة)</div>
                <div className="text-sm font-bold text-orange-600">{data.totals.pendingAdvances?.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Operations table */}
          <DataTable
            columns={[
              { key: 'Date', title: 'التاريخ', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Date || r.Month || '—'}</span> },
              { key: 'OpType', title: 'النوع', render: (r) => {
                const info = opTypeLabels[r.OpType] || { label: r.OpType, variant: 'gray' };
                return <Badge variant={info.variant as any}>{info.label}</Badge>;
              }},
              { key: 'RefNumber', title: 'المرجع', render: (r) => <span className="font-mono text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">{r.RefNumber}</span> },
              { key: 'Description', title: 'البيان', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.Description}</span> },
              { key: 'Debit', title: 'مدين (له عليه)', render: (r) => <span className="font-bold text-red-600">{r.Debit ? r.Debit.toFixed(2) : '—'}</span> },
              { key: 'Credit', title: 'دائن (له)', render: (r) => <span className="font-bold text-green-600">{r.Credit ? r.Credit.toFixed(2) : '—'}</span> },
              { key: 'Status', title: 'الحالة', render: (r) => {
                if (r.OpType === 'salary') return <Badge variant={r.Status === 'paid' ? 'green' : r.Status === 'partial' ? 'yellow' : 'gray'}>{r.Status === 'paid' ? 'مدفوع' : r.Status === 'partial' ? 'جزئي' : 'معلّق'}</Badge>;
                if (r.OpType === 'advance' || r.OpType === 'deduction') return <Badge variant={r.IsDeducted ? 'green' : 'yellow'}>{r.IsDeducted ? 'مخصوم' : 'معلّق'}</Badge>;
                if (r.OpType === 'commission') return <Badge variant={r.IsPaid ? 'green' : 'yellow'}>{r.IsPaid ? 'مدفوع' : 'معلّق'}</Badge>;
                return <span className="text-slate-500 dark:text-slate-400">—</span>;
              }},
              { key: 'actions', title: '', render: (r) => (
                <div className="flex gap-1">
                  <button onClick={() => fetchPreview(r)} className="p-1.5 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-900/20 text-primary-600 transition-colors" title="عرض التفاصيل">
                    <Eye size={15} />
                  </button>
                  <button onClick={async () => { await fetchPreview(r); handlePrintRecord(); }} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors" title="طباعة">
                    <Printer size={15} />
                  </button>
                </div>
              )},
            ]}
            data={asRows<Record<string, any>>(data.operations)}
            keyField="RefID"
            emptyMessage="لا توجد عمليات"
          />
        </div>
      )}

      {!loading && !data && (
        <div className="text-center py-12">
          <FileText size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-slate-500 dark:text-slate-400">اختر موظفاً من القائمة لعرض كشف الحساب</p>
        </div>
      )}

      {/* Preview Modal */}
      <Modal isOpen={!!previewOp} onClose={() => { setPreviewOp(null); setPreviewData(null); }}>
        {previewOp && (
          <div className="min-w-[500px] max-w-[600px]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                {opLabels[previewOp.OpType] || 'عرض التفاصيل'} - {previewOp.RefNumber}
              </h3>
              <button onClick={() => { setPreviewOp(null); setPreviewData(null); }} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400">
                <X size={18} />
              </button>
            </div>
            {previewLoading ? (
              <p className="text-center text-slate-500 py-6">جاري التحميل...</p>
            ) : (
              <>
                {renderPreviewContent()}
                <div className="flex justify-center mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <Button onClick={handlePrintRecord} icon={<Printer size={16} />}>طباعة</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
