import { useState, useEffect } from 'react';
import { Plus, Edit, FileText, Printer, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';
import { escapeHtml as esc, safeNumber } from '../../../../shared/escapeHtml';
import { printHeaderHtml, printFooterHtml, printHeaderCss } from '../../lib/printHeader';

export function PaymentMethodsPage() {
  const { showToast } = useToastStore();
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ MethodName: '', MethodType: 'pos_machine', Provider: '', PhoneNumber: '', OpeningBalance: '', IsActive: 1 });

  const [statementMethod, setStatementMethod] = useState<any>(null);
  const [statementData, setStatementData] = useState<any>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [settings, setSettings] = useState<any>({});

  const fetchData = async () => {
    const pm = await window.api.invoke('paymentMethods:list');
    setPaymentMethods(pm);
    setSettings(await window.api.invoke('settings:getAll'));
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ MethodName: '', MethodType: 'pos_machine', Provider: '', PhoneNumber: '', OpeningBalance: '', IsActive: 1 });
    setShowModal(true);
  };

  const openEdit = (pm: any) => {
    setEditing(pm);
    setForm({ MethodName: pm.MethodName, MethodType: pm.MethodType, Provider: pm.Provider || '', PhoneNumber: pm.PhoneNumber || '', OpeningBalance: '', IsActive: pm.IsActive });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.MethodName) { showToast('error', 'يرجى إدخال اسم طريقة الدفع'); return; }
    if (editing) {
      const reply = await window.api.invoke('paymentMethods:update', editing.PaymentMethodID, form);
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم التحديث');
    } else {
      const reply = await window.api.invoke('paymentMethods:create', { ...form, OpeningBalance: parseFloat(form.OpeningBalance) || 0 });
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم الإضافة');
    }
    setShowModal(false);
    fetchData();
  };

  const handlePrintStatement = () => {
    if (!statementData?.operations?.length || !statementMethod) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const rows = statementData.operations.map((op: any) => {
      return `<tr>
        <td style="text-align:center">${esc(op.Date)}</td>
        <td style="text-align:center">${esc(op.OpLabel)}</td>
        <td>${esc(op.Party || '\u2014')}</td>
        <td style="text-align:center">${esc(op.RefNumber || '')}</td>
        <td style="text-align:center;color:#16a34a;font-weight:600">${op.InAmount > 0 ? safeNumber(op.InAmount) : '\u2014'}</td>
        <td style="text-align:center;color:#dc2626;font-weight:600">${op.OutAmount > 0 ? safeNumber(op.OutAmount) : '\u2014'}</td>
        <td style="text-align:center;font-weight:700">${safeNumber(op.Balance)}</td>
      </tr>`;
    }).join('');
    const html = ['<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">',
      '<style>',
      '@page { size: A4; margin: 15mm 20mm; }',
      '* { box-sizing: border-box; }',
      "body { font-family: 'Cairo','Segoe UI',Tahoma,sans-serif; direction: rtl; color: #1e293b; font-size: 12px; }",
      '.sheet { width: 100%; }',
      '.report-header { text-align: center; margin-bottom: 8mm; border-bottom: 3px double #1e293b; padding-bottom: 5mm; }',
      '.report-header h1 { font-size: 20px; margin: 0 0 3mm; color: #1e293b; letter-spacing: 1px; }',
      '.report-header .company { font-size: 14px; color: #475569; margin-bottom: 1mm; }',
      '.report-header .sub { font-size: 11px; color: #64748b; }',
      '.party-box { border: 2px solid #e2e8f0; border-radius: 4px; padding: 4mm 5mm; margin-bottom: 5mm; display: flex; justify-content: space-between; }',
      '.party-box .label { font-size: 10px; color: #94a3b8; }',
      '.party-box .value { font-weight: 700; font-size: 13px; }',
      'table { width: 100%; border-collapse: collapse; margin-top: 3mm; }',
      'th { background: #1e293b; color: white; font-weight: 700; padding: 6px 4px; border: 1px solid #1e293b; text-align: center; font-size: 11px; }',
      'td { padding: 5px 4px; border: 1px solid #e2e8f0; font-size: 11px; }',
      'tr:nth-child(even) { background: #f8fafc; }',
      '.totals-row { background: #f1f5f9 !important; font-weight: 700; }',
      '.summary { margin-top: 5mm; display: flex; gap: 4mm; justify-content: center; }',
      '.summary-item { border: 1px solid #e2e8f0; border-radius: 4px; padding: 3mm 5mm; text-align: center; min-width: 80px; }',
      '.summary-item .num { font-size: 16px; font-weight: 700; margin-top: 1mm; }',
      '.signatures { margin-top: 12mm; display: flex; justify-content: space-between; }',
      '.sig-box { text-align: center; min-width: 120px; }',
      '.sig-box .line { border-top: 1px solid #64748b; margin-top: 20mm; padding-top: 3mm; font-size: 11px; color: #475569; }',
      '.footer { margin-top: 8mm; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 3mm; }',
      '@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }',
      printHeaderCss(settings),
      '<\/style></head><body>',
      '<div class="sheet">',
      printHeaderHtml(settings, '\u0643\u0634\u0641 \u062d\u0633\u0627\u0628 \u0645\u0627\u0643\u064a\u0646\u0629/\u0645\u062d\u0641\u0638\u0629'),
      '<div class="party-box">',
      '<div><div class="label">\u0627\u0644\u0627\u0633\u0645<\/div><div class="value">' + esc(statementMethod.MethodName) + '<\/div><\/div>',
      '<div><div class="label">\u0627\u0644\u0646\u0648\u0639<\/div><div class="value">' + esc(statementMethod.MethodType === 'pos_machine' ? '\u0645\u0627\u0643\u064A\u0646\u0629' : statementMethod.MethodType === 'digital_wallet' ? '\u0645\u062D\u0641\u0638\u0629' : '\u062A\u062D\u0648\u064A\u0644') + '<\/div><\/div>',
      '<div><div class="label">\u0627\u0644\u0631\u0635\u064A\u062F \u0627\u0644\u062D\u0627\u0644\u064A<\/div><div class="value">' + safeNumber(statementMethod.Balance ?? 0) + '<\/div><\/div>',
      '<\/div>',
      '<table>',
      '<tr><th width="12%">\u0627\u0644\u062A\u0627\u0631\u064A\u062E<\/th><th width="15%">\u0627\u0644\u0646\u0648\u0639<\/th><th>\u0627\u0644\u0637\u0631\u0641<\/th><th width="10%">\u0627\u0644\u0645\u0631\u062C\u0639<\/th><th width="13%">\u0648\u0627\u0631\u062F<\/th><th width="13%">\u0645\u0646\u0635\u0631\u0641<\/th><th width="13%">\u0627\u0644\u0631\u0635\u064A\u062F<\/th><\/tr>',
      rows,
      '<tr class="totals-row"><td colspan="4" style="text-align:left;font-weight:700">\u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A<\/td>',
      '<td style="text-align:center;color:#16a34a">' + safeNumber(statementData.totalIn || 0) + '<\/td>',
      '<td style="text-align:center;color:#dc2626">' + safeNumber(statementData.totalOut || 0) + '<\/td>',
      '<td style="text-align:center">' + safeNumber(statementData.netChange || 0) + '<\/td><\/tr>',
      '<\/table>',
      '<div class="summary">',
      '<div class="summary-item"><span style="font-size:11px;color:#16a34a">\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0648\u0627\u0631\u062F<\/span><div class="num" style="color:#16a34a">' + safeNumber(statementData.totalIn || 0) + '<\/div><\/div>',
      '<div class="summary-item"><span style="font-size:11px;color:#dc2626">\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0645\u0646\u0635\u0631\u0641<\/span><div class="num" style="color:#dc2626">' + safeNumber(statementData.totalOut || 0) + '<\/div><\/div>',
      '<div class="summary-item"><span style="font-size:11px">\u0635\u0627\u0641\u064A \u0627\u0644\u062D\u0631\u0643\u0629<\/span><div class="num" style="color:' + ((statementData.netChange || 0) >= 0 ? '#16a34a' : '#dc2626') + '">' + safeNumber(statementData.netChange || 0) + '<\/div><\/div>',
      '<\/div>',
      '<div class="signatures">',
      '<div class="sig-box"><div class="line">\u0625\u062F\u0627\u0631\u0629 \u0627\u0644\u0645\u062D\u0644<\/div><\/div>',
      '<div class="sig-box"><div class="line">\u0627\u0644\u0645\u062D\u0627\u0633\u0628<\/div><\/div>',
      '<div class="sig-box"><div class="line">\u0635\u0627\u062D\u0628 \u0627\u0644\u062D\u0633\u0627\u0628<\/div><\/div>',
      '<\/div>',
      printFooterHtml(settings, '\u0647\u0630\u0627 \u0627\u0644\u0643\u0634\u0641 \u0645\u0639\u062A\u0645\u062F \u0648\u0645\u0639\u062A\u0628\u0631'),
      '<\/div>',
      "<script>window.print();window.onafterprint=()=>window.close();<\/script>",
      '<\/body><\/html>',
    ];
    printWindow.document.write(html.join('\n'));
    printWindow.document.close();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">ماكينات وأنظمة الدفع</h1>
        <Button onClick={openCreate} icon={<Plus size={16} />}>طريقة دفع جديدة</Button>
      </div>

      <DataTable
        columns={[
          { key: 'MethodName', title: 'الاسم', render: (row) => <span className="font-medium text-slate-800 dark:text-white">{row.MethodName}</span> },
          { key: 'MethodType', title: 'النوع', render: (row) => <Badge variant={row.MethodType === 'pos_machine' ? 'blue' : row.MethodType === 'digital_wallet' ? 'green' : 'purple'}>{row.MethodType === 'pos_machine' ? 'ماكينة' : row.MethodType === 'digital_wallet' ? 'محفظة' : 'تحويل'}</Badge> },
          { key: 'Provider', title: 'المزوّد', render: (row) => <span className="text-slate-700 dark:text-slate-200">{row.Provider || '—'}</span> },
          { key: 'PhoneNumber', title: 'رقم المحفظة', render: (row) => <span className="text-slate-700 dark:text-slate-200">{row.PhoneNumber || '—'}</span> },
          { key: 'Balance', title: 'الرصيد', render: (row) => <span className="font-bold text-green-600">{row.Balance?.toFixed(2)}</span> },
          { key: 'actions', title: '', render: (row) => <div className="flex gap-2">
            <button onClick={async () => {
              setStatementMethod(row);
              setStatementLoading(true);
              const r = await window.api.invoke('paymentMethod:statement', row.PaymentMethodID);
              if (isFailure(r)) { showToast('error', failureMessage(r, 'تعذر فتح كشف الحساب')); setStatementData(null); }
              else setStatementData(r);
              setStatementLoading(false);
            }} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><FileText size={12} /> كشف حساب</button>
            <button onClick={() => openEdit(row)} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button>
          </div> },
        ]}
        data={paymentMethods}
        keyField="PaymentMethodID"
        emptyMessage="لا توجد طرق دفع"
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'تعديل طريقة دفع' : 'طريقة دفع جديدة'}
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="الاسم" value={form.MethodName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, MethodName: e.target.value })} />
          <Select label="النوع" value={form.MethodType} onChange={(e) => setForm({ ...form, MethodType: e.target.value })}>
            <option value="pos_machine">ماكينة دفع</option>
            <option value="digital_wallet">محفظة إلكترونية</option>
            <option value="transfer">تحويل</option>
          </Select>
          <Input label="المزوّد" value={form.Provider} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Provider: e.target.value })} hint="فودافون، أورانج، اتصالات، إنستا باي..." />
          <Input label="رقم المحفظة" value={form.PhoneNumber} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PhoneNumber: e.target.value })} />
          {!editing && <Input label="الرصيد الافتتاحي" type="number" value={form.OpeningBalance} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, OpeningBalance: e.target.value })} hint="يُضاف لرأس المال تلقائياً" />}
        </div>
      </Modal>

      {/* Payment Method Statement Modal */}
      {statementMethod && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50 overflow-y-auto">
          <div className="bg-white dark:bg-slate-800 rounded-xl w-full max-w-4xl mx-4 shadow-2xl border border-slate-200 dark:border-slate-700">
            <div className="sticky top-0 bg-white dark:bg-slate-800 z-10 flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700 rounded-t-xl">
              <div>
                <h3 className="text-lg font-bold text-slate-800 dark:text-white">كشف حساب: {statementMethod.MethodName}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">الرصيد الحالي: <span className="font-bold text-green-600">{statementMethod.Balance?.toFixed(2)}</span></p>
              </div>
              <div className="flex items-center gap-2">
                {statementData?.operations?.length > 0 && (
                  <button onClick={handlePrintStatement} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-blue-600" title="طباعة"><Printer size={18} /></button>
                )}
                <button onClick={() => { setStatementMethod(null); setStatementData(null); }} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"><X size={20} /></button>
              </div>
            </div>
            <div className="p-4">
              {statementLoading ? (
                <div className="text-center py-8 text-slate-500">جاري التحميل...</div>
              ) : statementData ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm bg-slate-50 dark:bg-slate-700/50 p-2 rounded">
                    <span>إجمالي الوارد: <span className="font-bold text-green-600">{statementData.totalIn?.toFixed(2)}</span></span>
                    <span>إجمالي المنصرف: <span className="font-bold text-red-600">{statementData.totalOut?.toFixed(2)}</span></span>
                    <span>صافي الحركة: <span className={`font-bold ${statementData.netChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>{statementData.netChange?.toFixed(2)}</span></span>
                  </div>
                  {asRows(statementData.operations).length === 0 ? (
                    <div className="text-center py-8 text-slate-500">لا توجد عمليات على هذه الوسيلة</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-slate-100 dark:bg-slate-700">
                            <th className="p-2 text-right">التاريخ</th>
                            <th className="p-2 text-right">البيان</th>
                            <th className="p-2 text-right">الطرف</th>
                            <th className="p-2 text-right">رقم المرجع</th>
                            <th className="p-2 text-center">وارد</th>
                            <th className="p-2 text-center">منصرف</th>
                            <th className="p-2 text-center">الرصيد</th>
                          </tr>
                        </thead>
                        <tbody>
                          {asRows<any>(statementData.operations).map((op: any, i: number) => (
                            <tr key={i} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                              <td className="p-2 whitespace-nowrap">{op.Date}</td>
                              <td className="p-2"><span className="text-slate-500">{op.OpLabel}</span></td>
                              <td className="p-2">{op.Party || '—'}</td>
                              <td className="p-2 text-slate-400">{op.RefNumber}</td>
                              <td className="p-2 text-center">
                                {op.InAmount > 0 ? <span className="text-green-600 font-bold">{op.InAmount.toFixed(2)}</span> : '—'}
                              </td>
                              <td className="p-2 text-center">
                                {op.OutAmount > 0 ? <span className="text-red-600 font-bold">{op.OutAmount.toFixed(2)}</span> : '—'}
                              </td>
                              <td className={`p-2 text-center font-bold ${op.Balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {op.Balance.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500">فشل تحميل كشف الحساب</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}