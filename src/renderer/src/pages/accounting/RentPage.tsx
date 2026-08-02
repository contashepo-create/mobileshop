import { useState, useEffect } from 'react';
import { Plus, FileText, XCircle, RotateCcw, AlertTriangle, TrendingDown, TrendingUp, Clock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';
import { currentUserId } from '../../stores/auth.store';

/**
 * RENT CONTRACTS.
 *
 * The previous layout stacked every contract as a full-width card with a
 * single "generate instalments" button, and put an unfiltered list of every
 * instalment ever created underneath. With three contracts and a year of
 * monthly instalments that is 36 rows below three cards, and no way to see
 * what a single contract owes.
 *
 * This follows the shape used by accounting packages generally: a summary
 * strip for the figures that matter, a CONTRACTS table, and an INSTALMENTS
 * table that can be filtered down to one contract. The two are separate
 * because they answer different questions — "what have I agreed to" and
 * "what is due".
 *
 * The commitments strip is INFORMATION ONLY. Unpaid instalments are not an
 * expense and never reach the profit and loss; showing them here answers
 * "what is coming" without the accounts pretending the money has gone.
 */
export function RentPage() {
  const { showToast } = useToastStore();
  const [rents, setRents] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [commitments, setCommitments] = useState<any>(null);

  const [showModal, setShowModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<any>(null);
  const [selectedRent, setSelectedRent] = useState<any>(null);
  const [payCashAccount, setPayCashAccount] = useState('');
  const [genCount, setGenCount] = useState('12');
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);

  /** Which contract's instalments are shown; '' means all of them. */
  const [filterRent, setFilterRent] = useState('');
  const [filterStatus, setFilterStatus] = useState('pending');
  const [showInactive, setShowInactive] = useState(false);

  const [form, setForm] = useState({
    RentName: '', RentType: 'expense', Amount: '', Period: 'monthly',
    StartDate: new Date().toISOString().split('T')[0], EndDate: '',
    PartyName: '', PartyPhone: '', Notes: '',
  });

  const fetchData = async () => {
    const [r, p, ca, c] = await Promise.all([
      window.api.invoke('rents:list'),
      window.api.invoke('rentPayments:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('rents:commitments'),
    ]);
    setRents(Array.isArray(r) ? r : []);
    setPayments(Array.isArray(p) ? p : []);
    setCashAccounts(Array.isArray(ca) ? ca : []);
    setCommitments(isFailure(c) ? null : c);
  };

  useEffect(() => { fetchData(); }, []);

  const resetForm = () => setForm({
    RentName: '', RentType: 'expense', Amount: '', Period: 'monthly',
    StartDate: new Date().toISOString().split('T')[0], EndDate: '',
    PartyName: '', PartyPhone: '', Notes: '',
  });

  const handleCreate = async () => {
    if (!form.RentName || !form.Amount) { showToast('error', 'أكمل البيانات'); return; }
    setBusy(true);
    const reply = await window.api.invoke('rents:create', { ...form, Amount: parseFloat(form.Amount) });
    setBusy(false);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم إضافة العقد');
    setShowModal(false);
    resetForm();
    fetchData();
  };

  const openGenerate = (rent: any) => {
    setSelectedRent(rent);
    // A sensible default that respects the contract's own end date rather than
    // always proposing twelve.
    setGenCount(rent.EndDate ? String(monthsBetween(rent.StartDate, rent.EndDate, rent.Period)) : '12');
    setShowGenModal(true);
  };

  const handleGenerate = async () => {
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const count = parseInt(genCount);
    if (!Number.isFinite(count) || count < 1) { showToast('error', 'أدخل عدد أقساط صحيحاً'); return; }
    setBusy(true);
    const reply = await window.api.invoke(
      'rents:generatePayments', selectedRent.RentID, count, currentUserId(), activeFy.FiscalYearID,
    );
    setBusy(false);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', reply?.message || 'تم توليد الأقساط');
    setShowGenModal(false);
    fetchData();
  };

  const handlePay = async () => {
    if (!payCashAccount) { showToast('error', 'اختر الخزنة'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    setBusy(true);
    const reply = await window.api.invoke('rentPayments:pay', {
      RentPaymentID: selectedPayment.RentPaymentID,
      CashAccountID: parseInt(payCashAccount),
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    setBusy(false);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم دفع القسط');
    setShowPayModal(false);
    setSelectedPayment(null);
    setPayCashAccount('');
    fetchData();
  };

  const handleUnpay = async (row: any) => {
    if (!confirm(`التراجع عن دفع قسط ${row.PeriodLabel}؟ سيُعاد المبلغ إلى الخزينة.`)) return;
    const reply = await window.api.invoke('rentPayments:unpay', { RentPaymentID: row.RentPaymentID });
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', reply?.message || 'تم التراجع');
    fetchData();
  };

  const handleCancel = async () => {
    if (!cancelReason.trim()) { showToast('error', 'اكتب سبب الإلغاء'); return; }
    setBusy(true);
    const reply = await window.api.invoke('rents:cancel', {
      RentID: selectedRent.RentID, Reason: cancelReason.trim(),
    });
    setBusy(false);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', reply?.message || 'تم إلغاء العقد');
    setShowCancelModal(false);
    setCancelReason('');
    fetchData();
  };

  const visibleRents = rents.filter(r => showInactive || (r.Status ?? 'active') === 'active');
  const visiblePayments = payments.filter(p => {
    if (filterRent && String(p.RentID) !== filterRent) return false;
    if (filterStatus === 'pending') return p.Status === 'pending' && !p.CancelledAt;
    if (filterStatus === 'paid') return p.Status === 'paid';
    if (filterStatus === 'cancelled') return !!p.CancelledAt;
    return true;
  });

  const today = new Date().toISOString().split('T')[0];
  const money = (n: unknown) => (Number(n) || 0).toFixed(2);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">عقود الإيجار</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>عقد جديد</Button>
      </div>

      {/* Commitments. Not an expense — see the note on rents:commitments. */}
      {commitments && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SummaryCard
            icon={<TrendingDown size={18} className="text-red-600" />}
            label="التزامات علينا (غير مدفوعة)"
            value={money(commitments.totalOwed)}
            tone="red"
          />
          <SummaryCard
            icon={<TrendingUp size={18} className="text-green-600" />}
            label="مستحقات لنا (غير محصّلة)"
            value={money(commitments.totalDue)}
            tone="green"
          />
          <SummaryCard
            icon={<Clock size={18} className="text-amber-600" />}
            label={`أقساط متأخرة (${commitments.overdueCount || 0})`}
            value={money(commitments.overdueTotal)}
            tone="amber"
          />
        </div>
      )}
      <p className="text-[11px] text-slate-400">
        هذه الأرقام للعلم فقط — القسط غير المدفوع ليس مصروفاً ولا يدخل في الأرباح والخسائر.
      </p>

      {/* ---------------------------------------------------------- contracts */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white">العقود</h2>
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">
            <input type="checkbox" checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />
            إظهار المنتهية والملغاة
          </label>
        </div>
        <DataTable
          columns={[
            {
              key: 'RentName', title: 'العقد',
              render: (row: any) => (
                <div>
                  <div className="font-medium text-slate-800 dark:text-white">{row.RentName}</div>
                  {row.PartyName && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">{row.PartyName}</div>
                  )}
                </div>
              ),
            },
            {
              key: 'RentType', title: 'النوع',
              render: (row: any) => (
                <Badge variant={row.RentType === 'expense' ? 'red' : 'green'}>
                  {row.RentType === 'expense' ? 'علينا' : 'لنا'}
                </Badge>
              ),
            },
            {
              key: 'Amount', title: 'القيمة',
              render: (row: any) => (
                <span className="font-bold">
                  {money(row.Amount)}
                  <span className="text-xs font-normal text-slate-400">
                    {row.Period === 'monthly' ? ' /شهر' : ' /سنة'}
                  </span>
                </span>
              ),
            },
            {
              key: 'period', title: 'المدة',
              render: (row: any) => (
                <span className="text-xs text-slate-600 dark:text-slate-300">
                  {row.StartDate}
                  {row.EndDate ? ` ← ${row.EndDate}` : ' ← مفتوح'}
                </span>
              ),
            },
            {
              key: 'progress', title: 'الأقساط',
              render: (row: any) => (
                <span className="text-xs">
                  <span className="font-semibold text-green-600">{row.PaidInstalments || 0}</span>
                  <span className="text-slate-400"> / {row.TotalInstalments || 0}</span>
                  {(row.OutstandingTotal || 0) > 0 && (
                    <div className="text-[11px] text-red-600">
                      متبقٍ {money(row.OutstandingTotal)}
                    </div>
                  )}
                </span>
              ),
            },
            {
              key: 'Status', title: 'الحالة',
              render: (row: any) => {
                const st = row.Status ?? 'active';
                if (st === 'cancelled') return <Badge variant="gray">ملغى</Badge>;
                if (row.EndDate && row.EndDate < today) return <Badge variant="yellow">منتهٍ</Badge>;
                return <Badge variant="green">ساري</Badge>;
              },
            },
            {
              key: 'actions', title: '',
              render: (row: any) => (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setFilterRent(String(row.RentID)); setFilterStatus('all'); }}
                    className="text-xs text-primary-600 hover:underline">
                    الأقساط
                  </button>
                  {(row.Status ?? 'active') === 'active' && (
                    <>
                      <button onClick={() => openGenerate(row)}
                        className="text-xs text-slate-600 dark:text-slate-300 hover:underline">
                        توليد
                      </button>
                      <button
                        onClick={() => { setSelectedRent(row); setCancelReason(''); setShowCancelModal(true); }}
                        className="text-xs text-red-600 hover:underline">
                        إلغاء
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          data={visibleRents}
          keyField="RentID"
          emptyMessage="لا توجد عقود إيجار"
        />
      </div>

      {/* -------------------------------------------------------- instalments */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white">الأقساط</h2>
          <div className="flex items-center gap-2">
            <select value={filterRent} onChange={(e) => setFilterRent(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700">
              <option value="">كل العقود</option>
              {rents.map((r: any) => (
                <option key={r.RentID} value={r.RentID}>{r.RentName}</option>
              ))}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700">
              <option value="pending">المستحقة</option>
              <option value="paid">المدفوعة</option>
              <option value="cancelled">الملغاة</option>
              <option value="all">الكل</option>
            </select>
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'PeriodLabel', title: 'الفترة', render: (row: any) => <span className="font-medium">{row.PeriodLabel}</span> },
            { key: 'RentName', title: 'العقد' },
            { key: 'Amount', title: 'المبلغ', render: (row: any) => <span className="font-bold">{money(row.Amount)}</span> },
            {
              key: 'DueDate', title: 'الاستحقاق',
              render: (row: any) => {
                const late = row.Status === 'pending' && !row.CancelledAt && row.DueDate < today;
                return (
                  <span className={late ? 'text-red-600 font-medium' : ''}>
                    {row.DueDate}
                    {late && <AlertTriangle size={12} className="inline mr-1" />}
                  </span>
                );
              },
            },
            {
              key: 'Status', title: 'الحالة',
              render: (row: any) => {
                if (row.CancelledAt) return <Badge variant="gray">ملغى</Badge>;
                return (
                  <Badge variant={row.Status === 'paid' ? 'green' : 'red'}>
                    {row.Status === 'paid' ? 'مدفوع' : 'مستحق'}
                  </Badge>
                );
              },
            },
            {
              key: 'actions', title: '',
              render: (row: any) => {
                if (row.CancelledAt) return null;
                if (row.Status === 'paid') {
                  return (
                    <button onClick={() => handleUnpay(row)}
                      className="text-xs text-amber-600 hover:underline flex items-center gap-1">
                      <RotateCcw size={12} /> تراجع
                    </button>
                  );
                }
                return (
                  <button onClick={() => { setSelectedPayment(row); setShowPayModal(true); }}
                    className="text-xs text-green-600 hover:underline">دفع</button>
                );
              },
            },
          ]}
          data={visiblePayments}
          keyField="RentPaymentID"
          emptyMessage="لا توجد أقساط بهذا التصنيف"
        />
      </div>

      {/* ------------------------------------------------------------- modals */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="عقد إيجار جديد"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleCreate} loading={busy}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="اسم العقد" value={form.RentName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, RentName: e.target.value })} />
          <Select label="النوع" value={form.RentType} onChange={(e) => setForm({ ...form, RentType: e.target.value })}>
            <option value="expense">إيجار علينا (مصروف)</option>
            <option value="income">إيجار لنا (إيراد)</option>
          </Select>
          <Input label="قيمة القسط" type="number" value={form.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Amount: e.target.value })} />
          <Select label="الدورية" value={form.Period} onChange={(e) => setForm({ ...form, Period: e.target.value })}>
            <option value="monthly">شهري</option>
            <option value="yearly">سنوي</option>
          </Select>
          <Input label="بداية العقد" type="date" value={form.StartDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, StartDate: e.target.value })} />
          <Input label="نهاية العقد (اختياري)" type="date" value={form.EndDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, EndDate: e.target.value })} />
          <Input label="اسم الطرف الآخر" value={form.PartyName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PartyName: e.target.value })} />
          <Input label="هاتف الطرف" value={form.PartyPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PartyPhone: e.target.value })} />
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          اترك تاريخ النهاية فارغاً للعقود المفتوحة. عند تحديده لن يولّد البرنامج أقساطاً بعده.
        </p>
      </Modal>

      <Modal isOpen={showGenModal} onClose={() => setShowGenModal(false)} title="توليد الأقساط" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowGenModal(false)}>إلغاء</Button><Button onClick={handleGenerate} loading={busy} icon={<FileText size={16} />}>توليد</Button></>}
      >
        {selectedRent && (
          <div className="space-y-3">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">العقد:</span><span className="font-medium">{selectedRent.RentName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">القسط:</span><span className="font-bold">{money(selectedRent.Amount)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">النهاية:</span><span>{selectedRent.EndDate || 'مفتوح'}</span></div>
            </div>
            <Input label="عدد الأقساط" type="number" min={1} max={120} value={genCount}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGenCount(e.target.value)} />
            <p className="text-[11px] text-slate-400">
              لن يتجاوز البرنامج تاريخ نهاية العقد مهما كان العدد المطلوب. الأقساط المولّدة سابقاً لا تتكرر.
            </p>
          </div>
        )}
      </Modal>

      <Modal isOpen={showCancelModal} onClose={() => setShowCancelModal(false)} title="إلغاء العقد" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowCancelModal(false)}>تراجع</Button><Button onClick={handleCancel} loading={busy} icon={<XCircle size={16} />}>تأكيد الإلغاء</Button></>}
      >
        {selectedRent && (
          <div className="space-y-3">
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-200">
              سيتم سحب الأقساط <strong>غير المدفوعة</strong> فقط. الأقساط المدفوعة تبقى كما هي لأن المبلغ خرج فعلاً من الخزينة.
            </div>
            <Input label="سبب الإلغاء" value={cancelReason}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCancelReason(e.target.value)} />
          </div>
        )}
      </Modal>

      <Modal isOpen={showPayModal} onClose={() => setShowPayModal(false)} title="دفع قسط" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowPayModal(false)}>إلغاء</Button><Button onClick={handlePay} loading={busy}>دفع</Button></>}
      >
        {selectedPayment && (
          <div className="space-y-4">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">الفترة:</span><span className="font-medium text-slate-700 dark:text-slate-200">{selectedPayment.PeriodLabel}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">المبلغ:</span><span className="font-bold text-slate-700 dark:text-white">{money(selectedPayment.Amount)}</span></div>
            </div>
            <Select label="الخزنة/البنك" value={payCashAccount} onChange={(e) => setPayCashAccount(e.target.value)}>
              <option value="">— اختر —</option>
              {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({money(ca.Balance)})</option>)}
            </Select>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** How many instalments fit between two dates, for the generate default. */
function monthsBetween(start: string, end: string, period: string): number {
  const a = new Date(start); const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 12;
  if (period === 'yearly') return Math.max(1, b.getFullYear() - a.getFullYear() + 1);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  return Math.min(120, Math.max(1, months));
}

function SummaryCard({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string; tone: 'red' | 'green' | 'amber';
}) {
  const ring = tone === 'red' ? 'border-red-200 dark:border-red-900'
    : tone === 'green' ? 'border-green-200 dark:border-green-900'
      : 'border-amber-200 dark:border-amber-900';
  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl p-4 border ${ring}`}>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {icon}{label}
      </div>
      <div className="mt-1 text-xl font-bold text-slate-800 dark:text-white">{value}</div>
    </div>
  );
}
