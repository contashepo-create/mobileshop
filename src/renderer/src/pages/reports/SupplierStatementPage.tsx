import { useState, useEffect, useRef } from 'react';
import { Printer, FileText, Search, TrendingUp, TrendingDown, Scale, Eye, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { asRows } from '../../lib/ipc';
import { escapeHtml as esc, safeNumber } from '../../../../shared/escapeHtml';
import { printHeaderHtml, printFooterHtml, printHeaderCss } from '../../lib/printHeader';

export function SupplierStatementPage() {
  const { showToast } = useToastStore();
  const [supplierId, setSupplierId] = useState<string>('');
  const [suppliers, setSuppliers] = useState<any[]>([]);
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
      const list = await window.api.invoke('suppliers:list');
      setSuppliers(list);
      setSettings(await window.api.invoke('settings:getAll'));
    })();
  }, []);

  const filteredSuppliers = suppliers.filter(s => {
    if (!searchQuery) return true;
    return s.Name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
           s.Phone?.includes(searchQuery);
  });

  const fetchStatement = async (id: number) => {
    setSupplierId(id.toString());
    setLoading(true);
    const result = await window.api.invoke('supplierStatement:get', id, {
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

  const fieldLabels: Record<string, Record<string, string>> = {
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
    'PartyID', 'Source', 'SourceID',
  ]);

  const opLabels: Record<string, string> = {
    purchase: 'فاتورة شراء', purchase_return: 'مرتجع مشتريات',
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
    if (!data?.operations?.length || !supplier) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const rows = data.operations.map((op: any) => {
      const info = opTypeLabels[op.OpType] || { label: op.OpType, variant: 'gray' };
      return `<tr>
        <td style="text-align:center">${esc(op.Date || '')}</td>
        <td style="text-align:center">${esc(info.label)}</td>
        <td style="text-align:center">${esc(op.RefNumber || '')}</td>
        <td>${esc(op.Description || '')}</td>
        <td style="text-align:center;color:#16a34a;font-weight:600">${op.Credit ? safeNumber(op.Credit) : '—'}</td>
        <td style="text-align:center;color:#dc2626;font-weight:600">${op.Debit ? safeNumber(op.Debit) : '—'}</td>
        <td style="text-align:center;font-weight:700">${safeNumber(Math.abs(op.Balance))}</td>
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
      ${printHeaderCss(settings)}
    </style></head><body>
    <div class="sheet">
      ${printHeaderHtml(settings, 'كشف حساب مورد')}
      <div class="party-box">
        <div><div class="label">اسم المورد</div><div class="value">${esc(supplier.Name)}</div></div>
        <div><div class="label">الهاتف</div><div class="value">${esc(supplier.Phone || '—')}</div></div>
        <div><div class="label">العنوان</div><div class="value">${esc(supplier.Address || '—')}</div></div>
        <div><div class="label">الرصيد الافتتاحي</div><div class="value">0.00</div></div>
      </div>
      <table>
        <tr><th width="12%">التاريخ</th><th width="12%">النوع</th><th width="12%">المرجع</th><th>البيان</th><th width="13%">مستحق للمورد</th><th width="13%">مدفوع/مرتجع</th><th width="13%">الرصيد</th></tr>
        ${rows}
        <tr class="totals-row"><td colspan="4" style="text-align:left;font-weight:700">الإجمالي</td>
          <td style="text-align:center;color:#dc2626">${safeNumber(data.totals?.totalCredit || 0)}</td>
          <td style="text-align:center;color:#16a34a">${safeNumber(data.totals?.totalDebit || 0)}</td>
          <td style="text-align:center">${safeNumber(Math.abs(netBal))} ${netBal >= 0 ? '(للمورد)' : '(لنا)'}</td>
        </tr>
      </table>
      <div class="summary">
        <div class="summary-item"><span style="font-size:11px;color:#dc2626">إجمالي المستحق</span><div class="num" style="color:#dc2626">${safeNumber(data.totals?.totalCredit || 0)}</div></div>
        <div class="summary-item"><span style="font-size:11px;color:#16a34a">إجمالي المدفوع</span><div class="num" style="color:#16a34a">${safeNumber(data.totals?.totalDebit || 0)}</div></div>
        <div class="summary-item"><span style="font-size:11px">الرصيد النهائي</span><div class="num" style="color:${netBal > 0 ? '#dc2626' : netBal < 0 ? '#16a34a' : '#1e293b'}">${safeNumber(Math.abs(netBal))}</div></div>
      </div>
      <div class="signatures">
        <div class="sig-box"><div class="line">إدارة المحل</div></div>
        <div class="sig-box"><div class="line">المحاسب</div></div>
        <div class="sig-box"><div class="line">المورد</div></div>
      </div>
      ${printFooterHtml(settings, 'هذا الكشف معتمد لدى الطرفين')}
    </div>
    <script>window.print();window.onafterprint=()=>window.close();<\/script>
    </body></html>`;
    printWindow.document.write(html);
    printWindow.document.close();
  };

  const opTypeLabels: Record<string, { label: string; variant: string }> = {
    purchase: { label: 'فاتورة شراء', variant: 'blue' },
    purchase_return: { label: 'مرتجع مشتريات', variant: 'green' },
    voucher_payment: { label: 'سند صرف', variant: 'green' },
    voucher_receipt: { label: 'سند قبض', variant: 'red' },
  };

  const supplier = data?.supplier;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between no-print">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">كشف حساب مورد</h1>
        {data && <Button variant="secondary" onClick={handlePrintStatement} icon={<Printer size={16} />}>طباعة الكشف</Button>}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 no-print">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">اختر المورد</label>
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
              {filteredSuppliers.length === 0 ? (
                <p className="text-center text-slate-500 dark:text-slate-400 py-3 text-sm">لا يوجد موردين</p>
              ) : (
                filteredSuppliers.map((s: any) => (
                  <button
                    key={s.SupplierID}
                    onClick={() => fetchStatement(s.SupplierID)}
                    className={`w-full text-right px-3 py-2.5 border-b border-slate-100 dark:border-slate-700/50 last:border-0 transition-colors ${
                      supplierId === s.SupplierID.toString()
                        ? 'bg-primary-50 dark:bg-primary-900/20 border-r-4 border-r-primary-600'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium text-sm text-slate-800 dark:text-white">{s.Name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">{s.Phone || '—'}</span>
                      </div>
                      <span className={`text-xs font-bold ${s.Balance > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                        {s.Balance?.toFixed(2)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <Input label="من تاريخ" type="date" value={fromDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFromDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Input label="إلى تاريخ" type="date" value={toDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToDate(e.target.value)} />
            {supplierId && (
              <Button onClick={() => fetchStatement(parseInt(supplierId))} className="mt-1">تحديث الكشف</Button>
            )}
          </div>
        </div>
      </div>

      {loading && <p className="text-center text-slate-500 dark:text-slate-400 py-8">جاري التحميل...</p>}

      {!loading && data && supplier && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 pb-4 border-b border-slate-200 dark:border-slate-700">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الاسم</div>
                <div className="font-bold text-slate-800 dark:text-white">{supplier.Name}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الهاتف</div>
                <div className="text-slate-700 dark:text-slate-200">{supplier.Phone || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">العنوان</div>
                <div className="text-slate-700 dark:text-slate-200">{supplier.Address || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">الرصيد المستحق له</div>
                <div className={`font-bold ${supplier.Balance > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {supplier.Balance?.toFixed(2)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 flex items-center gap-3">
                <TrendingUp size={20} className="text-orange-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">إجمالي مستحق (مشتريات)</div>
                  <div className="text-lg font-bold text-orange-600">{data.totals.totalCredit?.toFixed(2)}</div>
                </div>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 flex items-center gap-3">
                <TrendingDown size={20} className="text-green-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">إجمالي مدفوع + مرتجع</div>
                  <div className="text-lg font-bold text-green-600">{data.totals.totalDebit?.toFixed(2)}</div>
                </div>
              </div>
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 flex items-center gap-3">
                <Scale size={20} className="text-blue-500" />
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">صافي الرصيد المستحق</div>
                  <div className={`text-lg font-bold ${data.totals.netBalance >= 0 ? 'text-orange-600' : 'text-green-600'}`}>
                    {Math.abs(data.totals.netBalance).toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DataTable
            columns={[
              { key: 'Date', title: 'التاريخ', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Date}</span> },
              { key: 'OpType', title: 'النوع', render: (r) => {
                const info = opTypeLabels[r.OpType] || { label: r.OpType, variant: 'gray' };
                return <Badge variant={info.variant as any}>{info.label}</Badge>;
              }},
              { key: 'RefNumber', title: 'المرجع', render: (r) => <span className="font-mono text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400">{r.RefNumber}</span> },
              { key: 'Description', title: 'البيان', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.Description}</span> },
              { key: 'Debit', title: 'مدفوع/مرتجع', render: (r) => <span className="font-bold text-green-600">{r.Debit ? r.Debit.toFixed(2) : '—'}</span> },
              { key: 'Credit', title: 'مستحق', render: (r) => <span className="font-bold text-orange-600">{r.Credit ? r.Credit.toFixed(2) : '—'}</span> },
              { key: 'Balance', title: 'الرصيد', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.Balance?.toFixed(2)}</span> },
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
            keyField="RefNumber"
            emptyMessage="لا توجد عمليات"
          />
        </div>
      )}

      {!loading && !data && (
        <div className="text-center py-12">
          <FileText size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-slate-500 dark:text-slate-400">اختر مورداً من القائمة لعرض كشف الحساب</p>
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
