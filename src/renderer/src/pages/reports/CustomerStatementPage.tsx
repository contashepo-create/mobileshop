import { useState, useEffect, useRef } from 'react';
import { Printer, FileText, Search, Calendar, TrendingUp, TrendingDown, Scale, Wallet, Users, Eye, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { asRows } from '../../lib/ipc';

const fieldLabels: Record<string, Record<string, string>> = {
  sale: {
    SaleNumber: 'رقم الفاتورة', Date: 'التاريخ', CustomerName: 'العميل',
    TotalAmount: 'الإجمالي', Discount: 'الخصم', TaxAmount: 'الضريبة',
    PaidAmount: 'المدفوع', RemainingAmount: 'المتبقي', PaymentMethod: 'طريقة الدفع',
    Status: 'الحالة', Notes: 'ملاحظات',
  },
  sale_return: {
    ReturnNumber: 'رقم المرتجع', Date: 'التاريخ', SaleNumber: 'الفاتورة الأصلية',
    TotalAmount: 'الإجمالي', Reason: 'السبب', CustomerName: 'العميل',
  },
  maintenance_delivery: {
    DeliveryNumber: 'رقم التسليم', Date: 'التاريخ', CustomerName: 'العميل',
    TicketNumber: 'تذكرة الصيانة', DeviceModel: 'الجهاز',
    PartsCost: 'تكلفة القطع', LaborCost: 'تكلفة الصيانة', AdditionalCosts: 'تكاليف إضافية',
    TotalCost: 'الإجمالي', PaidAmount: 'المدفوع', RemainingAmount: 'المتبقي', PaymentMethod: 'طريقة الدفع',
  },
  purchase: {
    PurchaseNumber: 'رقم الفاتورة', Date: 'التاريخ', SupplierName: 'المورد',
    TotalAmount: 'الإجمالي', Discount: 'الخصم', TaxAmount: 'الضريبة',
    PaidAmount: 'المدفوع', RemainingAmount: 'المتبقي', PaymentMethod: 'طريقة الدفع',
    Status: 'الحالة', Notes: 'ملاحظات',
  },
  purchase_return: {
    ReturnNumber: 'رقم المرتجع', Date: 'التاريخ', PurchaseNumber: 'الفاتورة الأصلية',
    TotalAmount: 'الإجمالي', Reason: 'السبب', SupplierName: 'المورد',
  },
  voucher_receipt: {
    VoucherNumber: 'رقم السند', Date: 'التاريخ', VoucherType: 'النوع',
    Amount: 'المبلغ', Description: 'البيان', PartyName: 'الطرف',
    CashAccountName: 'الحساب النقدي', Username: 'المستخدم',
  },
  voucher_payment: {
    VoucherNumber: 'رقم السند', Date: 'التاريخ', VoucherType: 'النوع',
    Amount: 'المبلغ', Description: 'البيان', PartyName: 'الطرف',
    CashAccountName: 'الحساب النقدي', Username: 'المستخدم',
  },
  salary: {
    EmployeeName: 'الموظف', Month: 'الشهر', BaseSalary: 'الراتب الأساسي',
    Allowances: 'البدلات', CommissionsTotal: 'العمولات', DeductionsTotal: 'الخصومات',
    AdvancesTotal: 'السلف', NetSalary: 'صافي الراتب', PaidAmount: 'المدفوع',
    Status: 'الحالة', PaymentDate: 'تاريخ الصرف',
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
};

const ignoreFields = new Set(['SaleID', 'CustomerID', 'PurchaseID', 'SupplierID', 'ReturnID',
  'DeliveryID', 'TicketID', 'VoucherID', 'CashAccountID', 'PaymentMethodID', 'UserID',
  'EmployeeID', 'FiscalYearID', 'CreatedAt', 'CommissionID', 'AdvanceID', 'DeductionID',
  'SalaryID', 'ReferenceType', 'ReferenceID', 'PartyType', 'PartyID', 'PaidInSalaryID',
  'DeductedFromSalaryID', 'DamagedItemID', 'DamageCostType', 'WarehouseID', 'SerialID',
  'DetailID', 'ItemID', 'IsPaid', 'IsDeducted', 'Source', 'SourceID',
]);

const opLabels: Record<string, string> = {
  sale: 'فاتورة بيع', sale_return: 'مرتجع مبيعات', maintenance_delivery: 'تسليم صيانة',
  purchase: 'فاتورة شراء', purchase_return: 'مرتجع مشتريات',
  voucher_receipt: 'سند قبض', voucher_payment: 'سند صرف',
  salary: 'راتب', advance: 'سلفية', commission: 'عمولة', deduction: 'خصم',
};

export function CustomerStatementPage() {
  const { showToast } = useToastStore();
  const [customerId, setCustomerId] = useState<string>('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [previewOp, setPreviewOp] = useState<any>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<any>({});

  useEffect(() => {
    (async () => {
      const list = await window.api.invoke('customers:list');
      setCustomers(list);
      const s = await window.api.invoke('settings:getAll');
      setSettings(s);
    })();
  }, []);

  const filteredCustomers = customers.filter(c => {
    if (!searchQuery) return true;
    return c.Name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
           c.Phone?.includes(searchQuery);
  });

  const fetchStatement = async (id: number) => {
    setCustomerId(id.toString());
    setLoading(true);
    const result = await window.api.invoke('customerStatement:get', id, {
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
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
      <h2>${title}</h2>
      <table>${fields.map(f => `<tr><td style="width:30%;font-weight:600;background:#f8fafc">${f.label}</td><td>${String(f.value ?? '—')}</td></tr>`).join('')}</table>
      ${data.items?.length ? `<h3 style="margin-top:20px">الأصناف</h3><table class="items-table"><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>${data.items.map((item: any) => `<tr><td>${item.ItemName || item.Description || '—'}</td><td>${item.Quantity ?? '—'}</td><td>${(item.UnitPrice ?? item.UnitCost ?? item.Amount ?? '—')?.toFixed?.(2) ?? '—'}</td><td>${item.Total?.toFixed?.(2) ?? '—'}</td></tr>`).join('')}</table>` : ''}
      <p style="margin-top:30px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px">تمت الطباعة من نظام المحمول</p>
      <script>window.print();window.onafterprint=()=>window.close();<\/script>
      </body></html>`;
  };

  const handlePrintRecord = () => {
    if (!previewRef.current?.primary) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const html = buildPrintHTML(previewRef.current, previewOp);
    if (!html) return;
    printWindow.document.write(html);
    printWindow.document.close();
  };

  const handlePrintStatement = () => {
    if (!data?.operations?.length || !customer) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const rows = data.operations.map((op: any) => {
      const info = opTypeLabels[op.OpType] || { label: op.OpType, variant: 'gray' };
      return `<tr>
        <td style="text-align:center">${op.Date || ''}</td>
        <td style="text-align:center">${info.label}</td>
        <td style="text-align:center">${op.RefNumber || ''}</td>
        <td>${op.Description || ''}</td>
        <td style="text-align:center;color:#dc2626;font-weight:600">${op.Debit ? op.Debit.toFixed(2) : '—'}</td>
        <td style="text-align:center;color:#16a34a;font-weight:600">${op.Credit ? op.Credit.toFixed(2) : '—'}</td>
        <td style="text-align:center;font-weight:700">${Math.abs(op.Balance).toFixed(2)} ${op.Balance > 0 ? '(عليه)' : op.Balance < 0 ? '(له)' : '—'}</td>
      </tr>`;
    }).join('');
    const netBal = data.totals?.netBalance || 0;
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
      .summary { margin-top: 5mm; display: flex; gap: 4mm; justify-content: center; }
      .summary-item { border: 1px solid #e2e8f0; border-radius: 4px; padding: 3mm 5mm; text-align: center; min-width: 80px; }
      .summary-item .num { font-size: 16px; font-weight: 700; margin-top: 1mm; }
      .signatures { margin-top: 12mm; display: flex; justify-content: space-between; }
      .sig-box { text-align: center; min-width: 120px; }
      .sig-box .line { border-top: 1px solid #64748b; margin-top: 20mm; padding-top: 3mm; font-size: 11px; color: #475569; }
      .footer { margin-top: 8mm; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 3mm; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style></head><body>
    <div class="sheet">
      <div class="report-header">
        <h1>كشف حساب عميل</h1>
        <div class="company">${settings.company_name || ''}</div>
        <div class="sub">تاريخ الطباعة: ${new Date().toLocaleDateString('ar-EG-u-ca-islamic')} | ${new Date().toLocaleDateString('ar-EG')}</div>
      </div>
      <div class="party-box">
        <div><div class="label">اسم العميل</div><div class="value">${customer.Name}</div></div>
        <div><div class="label">الهاتف</div><div class="value">${customer.Phone || '—'}</div></div>
        <div><div class="label">العنوان</div><div class="value">${customer.Address || '—'}</div></div>
        <div><div class="label">الرصيد الافتتاحي</div><div class="value">0.00</div></div>
      </div>
      <table>
        <tr><th width="12%">التاريخ</th><th width="12%">النوع</th><th width="12%">المرجع</th><th>البيان</th><th width="13%">مدين (عليه)</th><th width="13%">دائن (له)</th><th width="13%">الرصيد</th></tr>
        ${rows}
        <tr class="totals-row"><td colspan="4" style="text-align:left;font-weight:700">الإجمالي</td>
          <td style="text-align:center;color:#dc2626">${(data.totals?.totalDebit || 0).toFixed(2)}</td>
          <td style="text-align:center;color:#16a34a">${(data.totals?.totalCredit || 0).toFixed(2)}</td>
          <td style="text-align:center">${Math.abs(netBal).toFixed(2)} ${netBal > 0 ? '(عليه)' : netBal < 0 ? '(له)' : '—'}</td>
        </tr>
      </table>
      <div class="summary">
        <div class="summary-item"><span style="font-size:11px;color:#dc2626">إجمالي المستحق</span><div class="num" style="color:#dc2626">${(data.totals?.totalDebit || 0).toFixed(2)}</div></div>
        <div class="summary-item"><span style="font-size:11px;color:#16a34a">إجمالي المدفوع</span><div class="num" style="color:#16a34a">${(data.totals?.totalCredit || 0).toFixed(2)}</div></div>
        <div class="summary-item"><span style="font-size:11px">الرصيد النهائي</span><div class="num" style="color:${netBal > 0 ? '#dc2626' : netBal < 0 ? '#16a34a' : '#1e293b'}">${Math.abs(netBal).toFixed(2)}</div></div>
      </div>
      <div class="signatures">
        <div class="sig-box"><div class="line">إدارة المحل</div></div>
        <div class="sig-box"><div class="line">المحاسب</div></div>
        <div class="sig-box"><div class="line">العميل</div></div>
      </div>
      <div class="footer">هذا الكشف معتمد ومعتبر لدى الطرفين — ${settings.company_name || 'نظام المحمول'}</div>
    </div>
    <script>window.print();window.onafterprint=()=>window.close();<\/script>
    </body></html>`;
    printWindow.document.write(html);
    printWindow.document.close();
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

  const opTypeLabels: Record<string, { label: string; variant: string }> = {
    sale: { label: 'فاتورة بيع', variant: 'blue' },
    sale_return: { label: 'مرتجع مبيعات', variant: 'green' },
    maintenance_delivery: { label: 'تسليم صيانة', variant: 'purple' },
    voucher_receipt: { label: 'سند قبض', variant: 'green' },
    voucher_payment: { label: 'سند صرف', variant: 'red' },
  };

  const customer = data?.customer;
  const selectedCustomer = customers.find(c => c.CustomerID === parseInt(customerId));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between no-print">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">كشف حساب عميل</h1>
        {data && <Button variant="secondary" onClick={handlePrintStatement} icon={<Printer size={16} />}>طباعة الكشف</Button>}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 no-print">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Customer search + select */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">اختر العميل</label>
            <div className="relative mb-2">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث بالاسم أو الهاتف..."
                className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
              {filteredCustomers.length === 0 ? (
                <p className="text-center text-slate-500 dark:text-slate-400 py-3 text-sm">لا يوجد عملاء</p>
              ) : (
                filteredCustomers.map((c: any) => (
                  <button
                    key={c.CustomerID}
                    onClick={() => fetchStatement(c.CustomerID)}
                    className={`w-full text-right px-3 py-2.5 border-b border-slate-100 dark:border-slate-700/50 last:border-0 transition-colors ${
                      customerId === c.CustomerID.toString()
                        ? 'bg-primary-50 dark:bg-primary-900/20 border-r-4 border-r-primary-600'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium text-sm text-slate-800 dark:text-white">{c.Name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">{c.Phone || '—'}</span>
                      </div>
                      <span className={`text-xs font-bold ${c.Balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {c.Balance?.toFixed(2)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Date filters */}
          <div>
            <Input label="من تاريخ" type="date" value={fromDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFromDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Input label="إلى تاريخ" type="date" value={toDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToDate(e.target.value)} />
            {customerId && (
              <Button onClick={() => fetchStatement(parseInt(customerId))} className="mt-1">تحديث الكشف</Button>
            )}
          </div>
        </div>
      </div>

      {loading && <p className="text-center text-slate-500 dark:text-slate-400 py-8">جاري التحميل...</p>}

      {!loading && data && customer && (
        <div className="space-y-4">
          {/* Customer info header */}
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-4 mb-4 pb-4 border-b border-slate-200 dark:border-slate-700">
              <div className="w-12 h-12 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                <Users size={24} className="text-primary-600" />
              </div>
              <div className="flex-1">
                <div className="text-lg font-bold text-slate-800 dark:text-white">{customer.Name}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">{customer.Phone || '—'} {customer.Address ? `| ${customer.Address}` : ''}</div>
              </div>
              <Badge variant={customer.Status === 'active' ? 'green' : customer.Status === 'warned' ? 'yellow' : 'red'}>
                {customer.Status === 'active' ? 'نشط' : customer.Status === 'warned' ? 'تحذير' : 'محظور'}
              </Badge>
            </div>

            {/* Balance summary - clear and professional */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Total invoiced (what he owes) */}
              <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp size={16} className="text-red-500" />
                  <span className="text-xs font-medium text-red-700 dark:text-red-300">إجمالي الفواتير (مستحق عليه)</span>
                </div>
                <div className="text-2xl font-bold text-red-600">{data.totals.totalDebit?.toFixed(2)}</div>
                <div className="text-[10px] text-red-400 mt-1">مجموع الفواتير + الصيانة</div>
              </div>

              {/* Total collected (what he paid) */}
              <div className="rounded-xl border-2 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingDown size={16} className="text-green-500" />
                  <span className="text-xs font-medium text-green-700 dark:text-green-300">إجمالي محصّل (مدفوع + سندات)</span>
                </div>
                <div className="text-2xl font-bold text-green-600">{data.totals.totalCredit?.toFixed(2)}</div>
                <div className="text-[10px] text-green-400 mt-1">مدفوع بالفاتورة + سندات قبض + مرتجعات</div>
              </div>

              {/* Net balance */}
              <div className={`rounded-xl border-2 p-4 ${data.totals.netBalance > 0 ? 'border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20' : 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Scale size={16} className={data.totals.netBalance > 0 ? 'text-orange-500' : 'text-blue-500'} />
                  <span className={`text-xs font-medium ${data.totals.netBalance > 0 ? 'text-orange-700 dark:text-orange-300' : 'text-blue-700 dark:text-blue-300'}`}>
                    {data.totals.netBalance > 0 ? 'المبلغ المتبقي عليه' : 'رصيد دائن (له)'}
                  </span>
                </div>
                <div className={`text-2xl font-bold ${data.totals.netBalance > 0 ? 'text-orange-600' : 'text-blue-600'}`}>
                  {Math.abs(data.totals.netBalance).toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                  {data.totals.netBalance > 0 ? 'مدين - يجب السداد' : 'له - مبلغ له'}
                </div>
              </div>

              {/* Current balance from DB */}
              <div className="rounded-xl border-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700/30 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Wallet size={16} className="text-slate-500" />
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">الرصيد الحالي بالقاعدة</span>
                </div>
                <div className={`text-2xl font-bold ${customer.Balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {Math.abs(customer.Balance || 0).toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                  {customer.Balance > 0 ? 'مدين (عليه)' : customer.Balance < 0 ? 'دائن (له)' : 'متساوي'}
                </div>
              </div>
            </div>
          </div>

          {/* Operations table */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">تفاصيل العمليات ({asRows(data.operations).length})</h3>
            </div>
            <DataTable
              columns={[
                { key: 'Date', title: 'التاريخ', render: (r) => <span className="text-slate-600 dark:text-slate-300 text-xs">{r.Date}</span> },
                { key: 'OpType', title: 'النوع', render: (r) => {
                  const info = opTypeLabels[r.OpType] || { label: r.OpType, variant: 'gray' };
                  return <Badge variant={info.variant as any}>{info.label}</Badge>;
                }},
                { key: 'RefNumber', title: 'المرجع', render: (r) => <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{r.RefNumber}</span> },
                { key: 'Description', title: 'البيان', render: (r) => <span className="text-slate-700 dark:text-slate-200 text-sm">{r.Description}</span> },
                { key: 'Debit', title: 'مستحق عليه', render: (r) => <span className="font-bold text-red-600">{r.Debit ? r.Debit.toFixed(2) : '—'}</span> },
                { key: 'Credit', title: 'محصّل/مدفوع', render: (r) => <span className="font-bold text-green-600">{r.Credit ? r.Credit.toFixed(2) : '—'}</span> },
                { key: 'Balance', title: 'الرصيد التراكمي', render: (r) => (
                  <span className={`font-bold ${r.Balance > 0 ? 'text-orange-600' : r.Balance < 0 ? 'text-blue-600' : 'text-slate-800 dark:text-white'}`}>
                    {Math.abs(r.Balance).toFixed(2)} {r.Balance > 0 ? 'عليه' : r.Balance < 0 ? 'له' : ''}
                  </span>
                )},
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
              data={asRows(data.operations)}
              keyField="RefNumber"
              emptyMessage="لا توجد عمليات"
            />
          </div>
        </div>
      )}

      {!loading && !data && (
        <div className="text-center py-12">
          <FileText size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-slate-500 dark:text-slate-400">اختر عميلاً من القائمة لعرض كشف الحساب</p>
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
