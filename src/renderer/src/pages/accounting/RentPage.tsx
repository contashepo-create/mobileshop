import { useState, useEffect } from 'react';
import { Plus, DollarSign } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

export function RentPage() {
  const { showToast } = useToastStore();
  const [rents, setRents] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<any>(null);
  const [payCashAccount, setPayCashAccount] = useState('');

  const [form, setForm] = useState({
    RentName: '', RentType: 'expense', Amount: '', Period: 'monthly',
    StartDate: new Date().toISOString().split('T')[0], PartyName: '', PartyPhone: '', Notes: '',
  });

  const fetchData = async () => {
    const [r, p, ca] = await Promise.all([
      window.api.invoke('rents:list'),
      window.api.invoke('rentPayments:list'),
      window.api.invoke('cashAccounts:list'),
    ]);
    setRents(r.filter((rent: any) => rent.IsActive === 1));
    setPayments(p);
    setCashAccounts(ca);
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async () => {
    if (!form.RentName || !form.Amount) { showToast('error', 'أكمل البيانات'); return; }
    await window.api.invoke('rents:create', { ...form, Amount: parseFloat(form.Amount) });
    showToast('success', 'تم إضافة الإيجار');
    setShowModal(false);
    setForm({ RentName: '', RentType: 'expense', Amount: '', Period: 'monthly', StartDate: new Date().toISOString().split('T')[0], PartyName: '', PartyPhone: '', Notes: '' });
    fetchData();
  };

  const handleGenerate = async (rentId: number) => {
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    await window.api.invoke('rents:generatePayments', rentId, 12, 1, activeFy.FiscalYearID);
    showToast('success', 'تم توليد دفعات الإيجار');
    fetchData();
  };

  const handlePay = async () => {
    if (!payCashAccount) { showToast('error', 'اختر الخزنة'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    await window.api.invoke('rentPayments:pay', {
      RentPaymentID: selectedPayment.RentPaymentID,
      CashAccountID: parseInt(payCashAccount),
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    showToast('success', 'تم دفع الإيجار');
    setShowPayModal(false);
    setSelectedPayment(null);
    setPayCashAccount('');
    fetchData();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">إدارة الإيجارات</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>إيجار جديد</Button>
      </div>

      {/* Rents */}
      <div className="space-y-2">
        {rents.map((rent: any) => (
          <div key={rent.RentID} className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800 dark:text-white">{rent.RentName}</span>
                <Badge variant={rent.RentType === 'expense' ? 'red' : 'green'}>{rent.RentType === 'expense' ? 'علينا' : 'لنا'}</Badge>
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mt-1">
                {rent.Amount?.toFixed(2)} / {rent.Period === 'monthly' ? 'شهرياً' : 'سنوياً'}
                {rent.PartyName && ` - ${rent.PartyName}`}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => handleGenerate(rent.RentID)}>توليد دفعات</Button>
          </div>
        ))}
        {rents.length === 0 && <p className="text-center text-slate-500 dark:text-slate-400 py-8">لا توجد إيجارات</p>}
      </div>

      {/* Payments */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-3">دفعات الإيجار</h2>
        <DataTable
          columns={[
            { key: 'PeriodLabel', title: 'الفترة', render: (row) => <span className="font-medium">{row.PeriodLabel}</span> },
            { key: 'RentName', title: 'الإيجار' },
            { key: 'Amount', title: 'المبلغ', render: (row) => <span className="font-bold">{row.Amount?.toFixed(2)}</span> },
            { key: 'DueDate', title: 'تاريخ الاستحقاق' },
            { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={row.Status === 'paid' ? 'green' : 'red'}>{row.Status === 'paid' ? 'مدفوع' : 'مستحق'}</Badge> },
            { key: 'actions', title: '', render: (row) => row.Status === 'pending' ? <button onClick={() => { setSelectedPayment(row); setShowPayModal(true); }} className="text-xs text-green-600 hover:underline">دفع</button> : null },
          ]}
          data={payments}
          keyField="RentPaymentID"
          emptyMessage="لا توجد دفعات"
        />
      </div>

      {/* Create Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="إيجار جديد"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleCreate}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="اسم الإيجار" value={form.RentName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, RentName: e.target.value })} />
          <Select label="النوع" value={form.RentType} onChange={(e) => setForm({ ...form, RentType: e.target.value })}>
            <option value="expense">إيجار علينا (مصروف)</option>
            <option value="income">إيجار لنا (إيراد)</option>
          </Select>
          <Input label="المبلغ" type="number" value={form.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Amount: e.target.value })} />
          <Select label="الدورية" value={form.Period} onChange={(e) => setForm({ ...form, Period: e.target.value })}>
            <option value="monthly">شهري</option>
            <option value="yearly">سنوي</option>
          </Select>
          <Input label="تاريخ البداية" type="date" value={form.StartDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, StartDate: e.target.value })} />
          <Input label="اسم الطرف الآخر" value={form.PartyName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PartyName: e.target.value })} />
          <Input label="هاتف الطرف" value={form.PartyPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PartyPhone: e.target.value })} />
        </div>
      </Modal>

      {/* Pay Modal */}
      <Modal isOpen={showPayModal} onClose={() => setShowPayModal(false)} title="دفع إيجار" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowPayModal(false)}>إلغاء</Button><Button onClick={handlePay}>دفع</Button></>}
      >
        {selectedPayment && (
          <div className="space-y-4">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">الفترة:</span><span className="font-medium text-slate-700 dark:text-slate-200">{selectedPayment.PeriodLabel}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">المبلغ:</span><span className="font-bold text-slate-700 dark:text-white">{selectedPayment.Amount?.toFixed(2)}</span></div>
            </div>
            <Select label="الخزنة/البنك" value={payCashAccount} onChange={(e) => setPayCashAccount(e.target.value)}>
              <option value="">— اختر —</option>
              {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
            </Select>
          </div>
        )}
      </Modal>
    </div>
  );
}
