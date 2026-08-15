import { useState, useEffect } from 'react';
import { Calendar, Lock, Unlock, Plus, CheckCircle, Wallet } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';

const accountTypeLabels: Record<string, string> = {
  cash_account: 'خزينة/بنك',
  payment_method: 'ماكينة/محفظة',
  customer: 'عميل',
  supplier: 'مورد',
};

export function FiscalYearPage() {
  const { showToast } = useToastStore();
  const [fiscalYears, setFiscalYears] = useState<any[]>([]);
  const [activeFy, setActiveFy] = useState<any>(null);
  const [showModal, setShowModal] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [showOpenings, setShowOpenings] = useState<number | null>(null);
  const [openings, setOpenings] = useState<any[]>([]);
  const [form, setForm] = useState({
    YearName: '',
    StartDate: new Date().toISOString().split('T')[0],
    EndDate: '',
  });

  const fetchData = async () => {
    const [list, active] = await Promise.all([
      window.api.invoke('fiscalYear:list'),
      window.api.invoke('fiscalYear:getActive'),
    ]);
    setFiscalYears(list);
    setActiveFy(active);
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async () => {
    if (!form.YearName || !form.StartDate || !form.EndDate) {
      showToast('error', 'أكمل جميع البيانات');
      return;
    }
    const result = await window.api.invoke('fiscalYear:create', form);
    if (result.success) {
      showToast('success', 'تم فتح سنة مالية جديدة');
      setShowModal(false);
      setForm({ YearName: '', StartDate: new Date().toISOString().split('T')[0], EndDate: '' });
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const handleClose = async (id: number) => {
    if (!confirm('هل أنت متأكد من إقفال هذه السنة المالية؟ سيتم ترحيل الأرصدة لسنة جديدة ومنع أي عمليات على هذه السنة.')) {
      return;
    }
    const result = await window.api.invoke('fiscalYear:close', id, 1);
    if (result.success) {
      showToast('success', 'تم إقفال السنة المالية وفتح سنة جديدة');
      fetchData();
    } else {
      showToast('error', result.message);
    }
    setClosingId(null);
  };

  const handleReopen = async (id: number) => {
    if (!confirm('إعادة فتح سنة مالية مقفلة؟ يمكنك حينها تسجيل عمليات بتاريخ يقع داخل فترة هذه السنة، مع العلم أن أرصدة الافتتاحية المعروضة للسنوات اللاحقة ستُحذف وتُلتقط من جديد عند الإقفال التالي.')) {
      return;
    }
    const result = await window.api.invoke('fiscalYear:reopen', id, 1);
    if (result.success) {
      showToast('success', 'تمت إعادة فتح السنة المالية');
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const handleShowOpenings = async (id: number) => {
    const result = await window.api.invoke('fiscalYear:openings', id);
    if (result.success) {
      setOpenings(result.openings);
      setShowOpenings(id);
    } else {
      showToast('error', result.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">السنة المالية</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>فتح سنة مالية</Button>
      </div>

      {/* Active year banner */}
      {activeFy ? (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle size={24} className="text-green-500" />
          <div>
            <div className="font-semibold text-green-800 dark:text-green-300">السنة المالية الحالية: {activeFy.YearName}</div>
            <div className="text-sm text-green-600 dark:text-green-400">{activeFy.StartDate} ← {activeFy.EndDate}</div>
          </div>
          {Array.isArray(activeFy.openingBalances) && activeFy.openingBalances.length > 0 && (
            <button onClick={() => { setOpenings(activeFy.openingBalances); setShowOpenings(activeFy.FiscalYearID); }} className="mr-auto text-xs text-green-700 dark:text-green-300 hover:underline flex items-center gap-1">
              <Wallet size={14} /> عرض الأرصدة الافتتاحية ({activeFy.openingBalances.length})
            </button>
          )}
        </div>
      ) : (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 flex items-center gap-3">
          <Lock size={24} className="text-red-500" />
          <div>
            <div className="font-semibold text-red-800 dark:text-red-300">لا توجد سنة مالية مفتوحة</div>
            <div className="text-sm text-red-600 dark:text-red-400">لا يمكن تسجيل أي عملية محاسبية حتى يتم فتح سنة مالية</div>
          </div>
        </div>
      )}

      {/* All fiscal years */}
      <DataTable
        columns={[
          { key: 'YearName', title: 'الاسم', render: (r) => <span className="font-medium">{r.YearName}</span> },
          { key: 'StartDate', title: 'من', render: (r) => <span className="flex items-center gap-1"><Calendar size={14} className="text-slate-500 dark:text-slate-400" /> {r.StartDate}</span> },
          { key: 'EndDate', title: 'إلى', render: (r) => <span className="flex items-center gap-1"><Calendar size={14} className="text-slate-500 dark:text-slate-400" /> {r.EndDate}</span> },
          { key: 'Status', title: 'الحالة', render: (r) => <Badge variant={r.Status === 'open' ? 'green' : 'gray'}>{r.Status === 'open' ? 'مفتوحة' : 'مقفلة'}</Badge> },
          { key: 'ClosedAt', title: 'تاريخ الإقفال', render: (r) => r.ClosedAt || '—' },
          {
            key: 'actions', title: 'إجراءات',
            render: (r) => (
              <div className="flex items-center gap-3">
                <button onClick={() => handleShowOpenings(r.FiscalYearID)} className="text-xs text-primary-600 hover:underline flex items-center gap-1">
                  <Wallet size={12} /> الأرصدة الافتتاحية
                </button>
                {r.Status === 'open' ? (
                  <button onClick={() => handleClose(r.FiscalYearID)} className="text-xs text-red-500 hover:underline flex items-center gap-1">
                    <Lock size={12} /> إقفال
                  </button>
                ) : (
                  <button onClick={() => handleReopen(r.FiscalYearID)} className="text-xs text-slate-500 hover:underline flex items-center gap-1">
                    <Unlock size={12} /> إعادة فتح
                  </button>
                )}
              </div>
            ),
          },
        ]}
        data={fiscalYears}
        keyField="FiscalYearID"
        emptyMessage="لا توجد سنوات مالية"
      />

      {/* Opening balances Modal */}
      <Modal isOpen={showOpenings !== null} onClose={() => setShowOpenings(null)} title={`الأرصدة الافتتاحية - ${fiscalYears.find(y => y.FiscalYearID === showOpenings)?.YearName || ''}`}>
        <div className="max-h-[60vh] overflow-y-auto">
          {openings.length === 0 ? (
            <p className="text-center text-slate-500 py-6">لا توجد أرصدة افتتاحية مسجلة لهذه السنة (تُلتقط عند إقفال السنة السابقة)</p>
          ) : (
            <DataTable
              columns={[
                { key: 'AccountType', title: 'النوع', render: (r) => <Badge variant="blue">{accountTypeLabels[r.AccountType] || r.AccountType}</Badge> },
                { key: 'AccountID', title: 'المعرف', render: (r) => <span className="font-mono text-xs">{r.AccountID}</span> },
                { key: 'Balance', title: 'الرصيد الافتتاحي', render: (r) => <span className="font-bold">{Number(r.Balance || 0).toFixed(2)}</span> },
              ]}
              data={openings}
              keyField="AccountID"
              emptyMessage="لا توجد بيانات"
            />
          )}
        </div>
      </Modal>

      {/* Create Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="فتح سنة مالية جديدة"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleCreate}>فتح</Button></>}
      >
        <div className="space-y-4">
          <Input label="اسم السنة المالية" value={form.YearName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, YearName: e.target.value })} placeholder="مثال: السنة المالية 2026" />
          <Input label="تاريخ البداية" type="date" value={form.StartDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, StartDate: e.target.value })} />
          <Input label="تاريخ النهاية" type="date" value={form.EndDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, EndDate: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
