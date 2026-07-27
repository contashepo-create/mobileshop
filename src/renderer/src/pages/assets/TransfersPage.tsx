import { useState, useEffect } from 'react';
import { ArrowRightLeft, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';

export function TransfersPage() {
  const { showToast } = useToastStore();
  const [transfers, setTransfers] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);

  const [form, setForm] = useState({
    FromType: 'cash_account', FromID: '',
    ToType: 'cash_account', ToID: '',
    Amount: '', TransferCost: '', TransferCostSource: 'from_amount',
    Notes: '',
  });

  const fetchData = async () => {
    const [t, ca, pm] = await Promise.all([
      window.api.invoke('transfers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setTransfers(t);
    setCashAccounts(ca);
    setPaymentMethods(pm);
  };

  useEffect(() => { fetchData(); }, []);

  // All accounts combined
  const allAccounts = [
    ...cashAccounts.map((ca: any) => ({ id: ca.CashAccountID, type: 'cash_account', name: ca.AccountName, balance: ca.Balance, kind: ca.AccountType === 'safe' ? 'خزنة' : 'بنك' })),
    ...paymentMethods.map((pm: any) => ({ id: pm.PaymentMethodID, type: 'payment_method', name: pm.MethodName, balance: pm.Balance, kind: pm.MethodType === 'pos_machine' ? 'ماكينة' : pm.MethodType === 'digital_wallet' ? 'محفظة' : 'تحويل' })),
  ];

  const sourceAccount = allAccounts.find(a => a.type === form.FromType && a.id === parseInt(form.FromID));
  const destAccount = allAccounts.find(a => a.type === form.ToType && a.id === parseInt(form.ToID));
  const amount = parseFloat(form.Amount) || 0;
  const cost = parseFloat(form.TransferCost) || 0;
  const received = form.TransferCostSource === 'from_amount' ? amount - cost : amount;
  const totalDeduction = form.TransferCostSource === 'separate' ? amount + cost : amount;

  const handleSave = async () => {
    if (!form.FromID || !form.ToID) { showToast('error', 'اختر الحساب المصدر والوجهة'); return; }
    if (form.FromType === form.ToType && form.FromID === form.ToID) { showToast('error', 'لا يمكن التحويل من نفس الحساب'); return; }
    if (amount <= 0) { showToast('error', 'أدخل مبلغاً صحيحاً'); return; }

    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    try {
      const result = await window.api.invoke('transfers:create', {
        FromType: form.FromType,
        FromID: parseInt(form.FromID),
        ToType: form.ToType,
        ToID: parseInt(form.ToID),
        Amount: amount,
        TransferCost: cost,
        TransferCostSource: form.TransferCostSource,
        Notes: form.Notes,
        userId: 1,
        fiscalYearId: activeFy.FiscalYearID,
      });

      if (result.success) {
        let msg = `تم التحويل - رقم: ${result.transferNumber}`;
        msg += ` | وصل للوجهة: ${result.receivedAmount.toFixed(2)}`;
        if (result.transferCost > 0) msg += ` | تكلفة التحويل: ${result.transferCost.toFixed(2)}`;
        showToast('success', msg);
        setShowModal(false);
        setForm({ FromType: 'cash_account', FromID: '', ToType: 'cash_account', ToID: '', Amount: '', TransferCost: '', TransferCostSource: 'from_amount', Notes: '' });
        fetchData();
      } else {
        showToast('error', result.message);
      }
    } catch (err: any) {
      showToast('error', `خطأ: ${err.message || err}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">تحويلات بين الأصول</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>تحويل جديد</Button>
      </div>

      <DataTable
        columns={[
          { key: 'TransferNumber', title: 'رقم التحويل', render: (r) => <span className="font-mono text-xs">{r.TransferNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'FromName', title: 'من', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.FromName}</span> },
          { key: 'ToName', title: 'إلى', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.ToName}</span> },
          { key: 'Amount', title: 'المبلغ', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.Amount?.toFixed(2)}</span> },
          { key: 'TransferCost', title: 'تكلفة التحويل', render: (r) => r.TransferCost > 0 ? <span className="text-red-600">{r.TransferCost?.toFixed(2)}</span> : '—' },
          { key: 'ReceivedAmount', title: 'وصل للوجهة', render: (r) => <span className="text-green-600 font-bold">{r.ReceivedAmount?.toFixed(2)}</span> },
          { key: 'delete', title: '', render: (r) => <button onClick={async () => { if (confirm('سيتم حذف التحويل وعكس كل التأثيرات. متابعة؟')) { const res = await window.api.invoke('delete:transfer', r.TransferID); if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
        ]}
        data={transfers}
        keyField="TransferID"
        emptyMessage="لا توجد تحويلات"
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="تحويل بين الحسابات" size="lg"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave} icon={<ArrowRightLeft size={16} />}>تحويل</Button></>}
      >
        <div className="space-y-4">
          {/* Source */}
          <div className="grid grid-cols-2 gap-3">
            <Select label="من حساب" value={`${form.FromType}:${form.FromID}`} onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              setForm({ ...form, FromType: type, FromID: id });
            }}>
              <option value="cash_account:">— اختر المصدر —</option>
              <optgroup label="الخزائن والبنوك">
                {cashAccounts.map((ca: any) => <option key={`c${ca.CashAccountID}`} value={`cash_account:${ca.CashAccountID}`}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
              </optgroup>
              <optgroup label="ماكينات ومحافظ الدفع">
                {paymentMethods.map((pm: any) => <option key={`p${pm.PaymentMethodID}`} value={`payment_method:${pm.PaymentMethodID}`}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
              </optgroup>
            </Select>
            <Select label="إلى حساب" value={`${form.ToType}:${form.ToID}`} onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              setForm({ ...form, ToType: type, ToID: id });
            }}>
              <option value="cash_account:">— اختر الوجهة —</option>
              <optgroup label="الخزائن والبنوك">
                {cashAccounts.map((ca: any) => <option key={`c2${ca.CashAccountID}`} value={`cash_account:${ca.CashAccountID}`}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
              </optgroup>
              <optgroup label="ماكينات ومحافظ الدفع">
                {paymentMethods.map((pm: any) => <option key={`p2${pm.PaymentMethodID}`} value={`payment_method:${pm.PaymentMethodID}`}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
              </optgroup>
            </Select>
          </div>

          {/* Amount & cost */}
          <div className="grid grid-cols-3 gap-3">
            <Input label="المبلغ المحوّل" type="number" value={form.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Amount: e.target.value })} />
            <Input label="تكلفة التحويل" type="number" value={form.TransferCost} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, TransferCost: e.target.value })} hint="عمولة/رسوم" />
            <Select label="خصم التكلفة من" value={form.TransferCostSource} onChange={(e) => setForm({ ...form, TransferCostSource: e.target.value })}>
              <option value="from_amount">من المبلغ المحوّل</option>
              <option value="separate">من حساب المصدر (منفصل)</option>
            </Select>
          </div>

          {/* Live calculation */}
          {sourceAccount && destAccount && amount > 0 && (
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">من:</span><span className="font-medium text-slate-700 dark:text-slate-200">{sourceAccount.name} (رصيد: {sourceAccount.balance?.toFixed(2)})</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">إلى:</span><span className="font-medium text-slate-700 dark:text-slate-200">{destAccount.name}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">المبلغ:</span><span className="font-bold text-slate-800 dark:text-white">{amount.toFixed(2)}</span></div>
              {cost > 0 && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">تكلفة التحويل:</span><span className="text-red-600">{cost.toFixed(2)}</span></div>}
              <div className="flex justify-between border-t border-slate-200 dark:border-slate-700 pt-1"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">يُخصم من المصدر:</span><span className="font-bold text-red-600">{totalDeduction.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">يصل للوجهة:</span><span className="font-bold text-green-600">{received.toFixed(2)}</span></div>
            </div>
          )}

          <Textarea label="ملاحظات" value={form.Notes} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, Notes: e.target.value })} rows={2} />
        </div>
      </Modal>
    </div>
  );
}
