import { useState, useEffect } from 'react';
import { Plus, Users, FileText, Printer, X, Wallet, TrendingDown, Clock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';
import { escapeHtml as esc, safeNumber } from '../../../../shared/escapeHtml';
import { printHeaderHtml, printFooterHtml, printHeaderCss } from '../../lib/printHeader';

/**
 * LANDLORDS AND TENANTS.
 *
 * The other party to a rent agreement used to be two free-text columns on the
 * contract, which cannot carry a balance and cannot be looked up. A landlord
 * renting three units to the shop was three unrelated strings, and there was
 * no way to answer the questions that actually matter about them: how much
 * have I paid this person, how much do I still owe, which months are settled.
 *
 * Two tabs, because a landlord and a tenant are opposite relationships and
 * mixing them in one list makes every total ambiguous.
 */
export function RentPartiesPage() {
  const { showToast } = useToastStore();
  const [kind, setKind] = useState<'landlord' | 'tenant'>('landlord');
  const [parties, setParties] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const [statement, setStatement] = useState<any>(null);
  const [showStatement, setShowStatement] = useState(false);
  const [settings, setSettings] = useState<any>({});

  const [form, setForm] = useState({
    Name: '', Phone: '', NationalID: '', Address: '', Notes: '',
  });

  const fetchData = async () => {
    const [list, s] = await Promise.all([
      window.api.invoke('rentParties:list', kind),
      window.api.invoke('settings:getAll'),
    ]);
    setParties(Array.isArray(list) ? list : []);
    if (!isFailure(s)) setSettings(s);
  };

  useEffect(() => { fetchData(); }, [kind]);

  const money = (n: unknown) => (Number(n) || 0).toFixed(2);

  const openCreate = () => {
    setEditing(null);
    setForm({ Name: '', Phone: '', NationalID: '', Address: '', Notes: '' });
    setShowModal(true);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    setForm({
      Name: row.Name || '', Phone: row.Phone || '', NationalID: row.NationalID || '',
      Address: row.Address || '', Notes: row.Notes || '',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.Name.trim()) { showToast('error', 'الاسم مطلوب'); return; }
    setBusy(true);
    const reply = editing
      ? await window.api.invoke('rentParties:update', editing.RentPartyID,
        { ...form, PartyKind: editing.PartyKind, IsActive: editing.IsActive })
      : await window.api.invoke('rentParties:create', { ...form, PartyKind: kind });
    setBusy(false);
    if (isFailure(reply) || !reply?.success) {
      showToast('error', failureMessage(reply, 'تعذّر الحفظ'));
      return;
    }
    showToast('success', editing ? 'تم التعديل' : 'تمت الإضافة');
    setShowModal(false);
    fetchData();
  };

  const openStatement = async (row: any) => {
    const res = await window.api.invoke('rentParty:statement', row.RentPartyID);
    if (isFailure(res) || !res?.success) {
      showToast('error', failureMessage(res, 'تعذّر تحميل كشف الحساب'));
      return;
    }
    setStatement(res);
    setShowStatement(true);
  };

  const handleHide = async (row: any) => {
    if (!confirm(`إخفاء ${row.Name}؟`)) return;
    const reply = await window.api.invoke('rentParties:delete', row.RentPartyID);
    if (isFailure(reply) || !reply?.success) {
      showToast('error', failureMessage(reply, 'تعذّر الإخفاء'));
      return;
    }
    showToast('success', 'تم الإخفاء');
    fetchData();
  };

  /**
   * Prints the statement.
   *
   * Built with the SHARED letterhead and the shared escaper, like every other
   * printed document — a screen that assembles its own header ends up being
   * the one that forgets to escape a name.
   */
  const printStatement = () => {
    // Every field is guarded, not just the top-level object. A statement whose
    // fetch half-failed, or a future handler that omits a list, would
    // otherwise throw DURING RENDER — and with no error boundary in this app
    // that unmounts the whole application and leaves the shop staring at a
    // blank window.
    if (!statement?.party || !statement?.totals) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const t = statement.totals;
    const isLandlord = statement.party.PartyKind === 'landlord';
    const instalments = Array.isArray(statement.instalments) ? statement.instalments : [];
    const contracts = Array.isArray(statement.contracts) ? statement.contracts : [];

    const rows = instalments.map((i: any) => {
      const paid = i.PaidAmount || 0;
      const left = (i.Amount || 0) - paid;
      const state = i.CancelledAt ? 'ملغى'
        : i.Status === 'paid' ? 'مدفوع'
          : paid > 0 ? 'جزئي' : 'مستحق';
      return `<tr>
        <td style="text-align:center">${esc(i.PeriodLabel)}</td>
        <td>${esc(i.RentName)}</td>
        <td style="text-align:center">${esc(i.DueDate)}</td>
        <td style="text-align:center">${safeNumber(i.Amount)}</td>
        <td style="text-align:center;color:#16a34a">${paid > 0 ? safeNumber(paid) : '—'}</td>
        <td style="text-align:center;color:#dc2626">${left > 0.005 ? safeNumber(left) : '—'}</td>
        <td style="text-align:center">${esc(state)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
    <style>
      @page { size: A4; margin: 15mm 20mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Cairo','Segoe UI',Tahoma,sans-serif; direction: rtl; color: #1e293b; font-size: 12px; }
      .report-header { text-align:center; margin-bottom:8mm; border-bottom:3px double #1e293b; padding-bottom:5mm; }
      .report-header h1 { font-size:20px; margin:0 0 3mm; }
      .report-header .company { font-size:14px; color:#475569; }
      .report-header .sub { font-size:11px; color:#64748b; }
      .party-box { border:2px solid #e2e8f0; border-radius:4px; padding:4mm 5mm; margin-bottom:5mm; display:flex; justify-content:space-between; }
      .party-box .label { font-size:10px; color:#94a3b8; }
      .party-box .value { font-weight:700; font-size:13px; }
      table { width:100%; border-collapse:collapse; margin-top:3mm; }
      th { background:#1e293b; color:#fff; padding:6px 4px; border:1px solid #1e293b; text-align:center; font-size:11px; }
      td { padding:5px 4px; border:1px solid #e2e8f0; font-size:11px; }
      tr:nth-child(even) { background:#f8fafc; }
      .summary { margin-top:5mm; display:flex; gap:4mm; justify-content:center; }
      .summary-item { border:1px solid #e2e8f0; border-radius:4px; padding:3mm 5mm; text-align:center; min-width:90px; }
      .summary-item .num { font-size:16px; font-weight:700; margin-top:1mm; }
      .signatures { margin-top:12mm; display:flex; justify-content:space-between; }
      .sig-box { text-align:center; min-width:120px; }
      .sig-box .line { border-top:1px solid #64748b; margin-top:20mm; padding-top:3mm; font-size:11px; color:#475569; }
      .footer { margin-top:8mm; text-align:center; font-size:10px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:3mm; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      ${printHeaderCss(settings)}
    </style></head><body>
    ${printHeaderHtml(settings, isLandlord ? 'كشف حساب مؤجر' : 'كشف حساب مستأجر')}
    <div class="party-box">
      <div><div class="label">الاسم</div><div class="value">${esc(statement.party.Name)}</div></div>
      <div><div class="label">الهاتف</div><div class="value">${esc(statement.party.Phone || '—')}</div></div>
      <div><div class="label">عدد العقود</div><div class="value">${esc(contracts.length)}</div></div>
      <div><div class="label">أقرب استحقاق</div><div class="value">${esc(t.nextDue || '—')}</div></div>
    </div>
    <table>
      <tr><th>الفترة</th><th>العقد</th><th>الاستحقاق</th><th>القيمة</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th></tr>
      ${rows}
    </table>
    <div class="summary">
      <div class="summary-item"><span style="font-size:11px">إجمالي المستحق</span><div class="num">${safeNumber(t.totalDue)}</div></div>
      <div class="summary-item"><span style="font-size:11px;color:#16a34a">إجمالي المدفوع</span><div class="num" style="color:#16a34a">${safeNumber(t.totalPaid)}</div></div>
      <div class="summary-item"><span style="font-size:11px;color:#dc2626">المتبقي</span><div class="num" style="color:#dc2626">${safeNumber(t.outstanding)}</div></div>
      <div class="summary-item"><span style="font-size:11px">رصيد المقدم</span><div class="num">${safeNumber(t.advanceHeld)}</div></div>
    </div>
    <div class="signatures">
      <div class="sig-box"><div class="line">إدارة المحل</div></div>
      <div class="sig-box"><div class="line">المحاسب</div></div>
      <div class="sig-box"><div class="line">${esc(isLandlord ? 'المؤجر' : 'المستأجر')}</div></div>
    </div>
    ${printFooterHtml(settings, 'هذا الكشف معتمد ومعتبر لدى الطرفين')}
    <script>window.print();window.onafterprint=()=>window.close();<\/script>
    </body></html>`;
    w.document.write(html);
    w.document.close();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users size={24} className="text-primary-600" />
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">المؤجرون والمستأجرون</h1>
        </div>
        <Button onClick={openCreate} icon={<Plus size={16} />}>
          {kind === 'landlord' ? 'مؤجر جديد' : 'مستأجر جديد'}
        </Button>
      </div>

      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        {([['landlord', 'المؤجرون (ندفع لهم)'], ['tenant', 'المستأجرون (يدفعون لنا)']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              kind === k
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
            }`}>
            {label}
          </button>
        ))}
      </div>

      <DataTable
        columns={[
          {
            key: 'Name', title: 'الاسم',
            render: (row: any) => (
              <div>
                <div className="font-medium text-slate-800 dark:text-white">{row.Name}</div>
                {row.Phone && <div className="text-xs text-slate-500 dark:text-slate-400">{row.Phone}</div>}
              </div>
            ),
          },
          { key: 'ContractCount', title: 'العقود', render: (row: any) => <span className="font-medium">{row.ContractCount || 0}</span> },
          {
            key: 'TotalPaid', title: kind === 'landlord' ? 'إجمالي المدفوع' : 'إجمالي المحصّل',
            render: (row: any) => <span className="font-bold text-green-600">{money(row.TotalPaid)}</span>,
          },
          {
            key: 'Outstanding', title: 'المتبقي',
            render: (row: any) => (
              <span className={`font-bold ${(row.Outstanding || 0) > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                {money(row.Outstanding)}
              </span>
            ),
          },
          {
            key: 'AdvanceHeld', title: 'رصيد مقدم',
            render: (row: any) => (row.AdvanceHeld || 0) > 0
              ? <span className="text-blue-600 font-medium">{money(row.AdvanceHeld)}</span>
              : <span className="text-slate-300">—</span>,
          },
          {
            key: 'IsActive', title: 'الحالة',
            render: (row: any) => row.IsActive
              ? <Badge variant="green">نشط</Badge>
              : <Badge variant="gray">مخفي</Badge>,
          },
          {
            key: 'actions', title: '',
            render: (row: any) => (
              <div className="flex items-center gap-2">
                <button onClick={() => openStatement(row)} className="text-xs text-primary-600 hover:underline">كشف حساب</button>
                <button onClick={() => openEdit(row)} className="text-xs text-slate-600 dark:text-slate-300 hover:underline">تعديل</button>
                {row.IsActive === 1 && (
                  <button onClick={() => handleHide(row)} className="text-xs text-red-600 hover:underline">إخفاء</button>
                )}
              </div>
            ),
          },
        ]}
        data={parties}
        keyField="RentPartyID"
        emptyMessage={kind === 'landlord' ? 'لا يوجد مؤجرون' : 'لا يوجد مستأجرون'}
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)}
        title={editing ? 'تعديل البيانات' : (kind === 'landlord' ? 'مؤجر جديد' : 'مستأجر جديد')}
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave} loading={busy}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="الاسم" value={form.Name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Name: e.target.value })} />
          <Input label="الهاتف" value={form.Phone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Phone: e.target.value })} />
          <Input label="الرقم القومي" value={form.NationalID} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, NationalID: e.target.value })} />
          <Input label="العنوان" value={form.Address} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Address: e.target.value })} />
          <div className="col-span-2">
            <Input label="ملاحظات" value={form.Notes} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Notes: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- statement */}
      {showStatement && statement?.party && statement?.totals && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowStatement(false)}>
          <div className="bg-white dark:bg-slate-800 rounded-xl w-full max-w-4xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 p-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-800 dark:text-white">
                  كشف حساب — {statement.party.Name}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {statement.contracts?.length ?? 0} عقد · {statement.totals.paidCount ?? 0} قسط مدفوع · {statement.totals.pendingCount ?? 0} مستحق
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={printStatement} icon={<Printer size={16} />}>طباعة</Button>
                <button onClick={() => setShowStatement(false)} className="p-2 text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={<FileText size={16} className="text-slate-500" />} label="إجمالي المستحق" value={money(statement.totals.totalDue)} />
                <StatCard icon={<Wallet size={16} className="text-green-600" />} label="إجمالي المدفوع" value={money(statement.totals.totalPaid)} tone="green" />
                <StatCard icon={<TrendingDown size={16} className="text-red-600" />} label="المتبقي" value={money(statement.totals.outstanding)} tone="red" />
                <StatCard icon={<Clock size={16} className="text-amber-600" />} label="متأخر" value={money(statement.totals.overdue)} tone="amber" />
              </div>
              {statement.totals.advanceHeld > 0 && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 text-sm text-blue-800 dark:text-blue-200">
                  رصيد مقدم محتفظ به: <strong>{money(statement.totals.advanceHeld)}</strong> — يُخصم من الأقساط القادمة.
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">الأقساط</h3>
                <DataTable
                  columns={[
                    { key: 'PeriodLabel', title: 'الفترة' },
                    { key: 'RentName', title: 'العقد' },
                    { key: 'DueDate', title: 'الاستحقاق' },
                    { key: 'Amount', title: 'القيمة', render: (r: any) => money(r.Amount) },
                    { key: 'PaidAmount', title: 'المدفوع', render: (r: any) => <span className="text-green-600">{money(r.PaidAmount)}</span> },
                    { key: 'Remaining', title: 'المتبقي', render: (r: any) => (r.Remaining || 0) > 0.005 ? <span className="text-red-600">{money(r.Remaining)}</span> : '—' },
                    {
                      key: 'Status', title: 'الحالة',
                      render: (r: any) => r.CancelledAt ? <Badge variant="gray">ملغى</Badge>
                        : r.Status === 'paid' ? <Badge variant="green">مدفوع</Badge>
                          : (r.PaidAmount || 0) > 0 ? <Badge variant="yellow">جزئي</Badge>
                            : <Badge variant="red">مستحق</Badge>,
                    },
                  ]}
                  data={statement.instalments ?? []}
                  keyField="RentPaymentID"
                  emptyMessage="لا توجد أقساط"
                />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">حركة المدفوعات</h3>
                <DataTable
                  columns={[
                    { key: 'TxnDate', title: 'التاريخ' },
                    { key: 'RentName', title: 'العقد' },
                    { key: 'PeriodLabel', title: 'الفترة', render: (r: any) => r.PeriodLabel || <span className="text-blue-600">مقدم</span> },
                    { key: 'Amount', title: 'المبلغ', render: (r: any) => <span className="font-bold">{money(r.Amount)}</span> },
                    { key: 'source', title: 'من', render: (r: any) => r.PaymentMethodName || r.CashAccountName || '—' },
                    {
                      key: 'SourceType', title: 'عبر',
                      render: (r: any) => <Badge variant={r.SourceType === 'voucher' ? 'purple' : 'blue'}>
                        {r.SourceType === 'voucher' ? 'سند' : 'الإيجارات'}
                      </Badge>,
                    },
                  ]}
                  data={statement.transactions ?? []}
                  keyField="RentTxnID"
                  emptyMessage="لا توجد حركات"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'green' | 'red' | 'amber';
}) {
  const ring = tone === 'green' ? 'border-green-200 dark:border-green-900'
    : tone === 'red' ? 'border-red-200 dark:border-red-900'
      : tone === 'amber' ? 'border-amber-200 dark:border-amber-900'
        : 'border-slate-200 dark:border-slate-700';
  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl p-3 border ${ring}`}>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">{icon}{label}</div>
      <div className="mt-1 text-lg font-bold text-slate-800 dark:text-white">{value}</div>
    </div>
  );
}
