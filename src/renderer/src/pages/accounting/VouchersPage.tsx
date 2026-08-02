import { useState, useEffect } from 'react';
import { Plus, Receipt, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';
import { AssetPicker, splitAssetValue, useAssets } from '../../components/shared/AssetPicker';
import { currentUserId } from '../../stores/auth.store';

export function VouchersPage() {
  const { showToast } = useToastStore();
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [typeFilter, setTypeFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);

  const [form, setForm] = useState({
    VoucherType: 'receipt',
    Amount: '',
    PartyType: 'general',
    PartyID: '',
    PartyName: '',
    Description: '',
    // One field replacing CashAccountID + PaymentMethodID. Holding a single
    // value makes it impossible for the form to name two assets at once.
    AssetValue: '',
  });

  const { assets, reload: reloadAssets } = useAssets();

  const fetchData = async () => {
    const [v, ca, pm, cu, su, em] = await Promise.all([
      window.api.invoke('vouchers:list', { type: typeFilter }),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
      window.api.invoke('customers:list'),
      window.api.invoke('suppliers:list'),
      window.api.invoke('employees:list', { isActive: 1 }),
    ]);
    setVouchers(v);
    setCashAccounts(ca);
    setPaymentMethods(pm);
    setCustomers(cu);
    setSuppliers(su);
    setEmployees(em);
  };

  useEffect(() => { fetchData(); }, [typeFilter]);

  const handleSave = async () => {
    if (!form.Amount || !form.Description || !form.AssetValue) {
      showToast('error', 'يرجى إدخال المبلغ والبيان والأصل');
      return;
    }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) {
      showToast('error', 'لا توجد سنة مالية مفتوحة');
      return;
    }
    // The picker's single value becomes exactly one of the two ids the
    // handler expects, so no handler signature had to change.
    const { AssetValue, ...rest } = form;
    const data = {
      ...rest,
      Amount: parseFloat(form.Amount),
      PartyID: form.PartyID ? parseInt(form.PartyID) : null,
      ...splitAssetValue(AssetValue),
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    };
    const result = await window.api.invoke('vouchers:create', data);
    // Checked. A refused voucher used to close nothing and say nothing: the
    // modal stayed open with no explanation, which reads as the button not
    // working rather than as a rejection.
    if (isFailure(result) || !result?.success) {
      showToast('error', failureMessage(result, 'تعذّر إنشاء السند'));
      return;
    }
    showToast('success', `تم إنشاء السند - رقم: ${result.voucherNumber}`);
    setShowModal(false);
    setForm({ VoucherType: 'receipt', Amount: '', PartyType: 'general', PartyID: '', PartyName: '', Description: '', AssetValue: '' });
    reloadAssets();
    fetchData();
  };

  const partyTypeOptions = [
    { value: 'general', label: 'عام' },
    { value: 'customer', label: 'عميل' },
    { value: 'supplier', label: 'مورد' },
    { value: 'employee', label: 'موظف' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">السندات</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>سند جديد</Button>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTypeFilter('all')} className={`px-4 py-2 rounded-lg text-sm font-medium ${typeFilter === 'all' ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>الكل</button>
        <button onClick={() => setTypeFilter('receipt')} className={`px-4 py-2 rounded-lg text-sm font-medium ${typeFilter === 'receipt' ? 'bg-green-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>سندات قبض</button>
        <button onClick={() => setTypeFilter('payment')} className={`px-4 py-2 rounded-lg text-sm font-medium ${typeFilter === 'payment' ? 'bg-red-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>سندات صرف</button>
      </div>

      <DataTable
        columns={[
          { key: 'VoucherNumber', title: 'رقم السند', render: (row) => <span className="font-mono text-xs">{row.VoucherNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'VoucherType', title: 'النوع', render: (row) => <Badge variant={row.VoucherType === 'receipt' ? 'green' : 'red'}>{row.VoucherType === 'receipt' ? 'قبض' : 'صرف'}</Badge> },
          { key: 'Amount', title: 'المبلغ', render: (row) => <span className="font-bold">{row.Amount?.toFixed(2)}</span> },
          { key: 'Description', title: 'البيان' },
          { key: 'PartyName', title: 'الطرف', render: (row) => row.PartyName || '—' },
          { key: 'Username', title: 'المستخدم' },
          { key: 'actions', title: '', render: (row) => <button onClick={async () => { if (confirm('سيتم حذف السند وعكس كل التأثيرات. متابعة؟')) { const r = await window.api.invoke('delete:voucher', row.VoucherID); if (r.success) { showToast('success', r.message); fetchData(); } else { showToast('error', r.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
        ]}
        data={vouchers}
        keyField="VoucherID"
        emptyMessage="لا توجد سندات"
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="سند جديد"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Select label="نوع السند" value={form.VoucherType} onChange={(e) => setForm({ ...form, VoucherType: e.target.value })}>
            <option value="receipt">سند قبض</option>
            <option value="payment">سند صرف</option>
          </Select>
          <Input label="المبلغ" type="number" value={form.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Amount: e.target.value })} />
          <Select label="نوع الطرف" value={form.PartyType} onChange={(e) => setForm({ ...form, PartyType: e.target.value, PartyID: '' })}>
            {partyTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          {form.PartyType === 'customer' && (
            <Select label="العميل" value={form.PartyID} onChange={(e) => setForm({ ...form, PartyID: e.target.value })}>
              <option value="">— اختر —</option>
              {customers.map((c: any) => <option key={c.CustomerID} value={c.CustomerID}>{c.Name} ({c.Balance?.toFixed(2)})</option>)}
            </Select>
          )}
          {form.PartyType === 'supplier' && (
            <Select label="المورد" value={form.PartyID} onChange={(e) => setForm({ ...form, PartyID: e.target.value })}>
              <option value="">— اختر —</option>
              {suppliers.map((s: any) => <option key={s.SupplierID} value={s.SupplierID}>{s.Name} ({s.Balance?.toFixed(2)})</option>)}
            </Select>
          )}
          {form.PartyType === 'employee' && (
            <Select label="الموظف" value={form.PartyID} onChange={(e) => setForm({ ...form, PartyID: e.target.value })}>
              <option value="">— اختر —</option>
              {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name}</option>)}
            </Select>
          )}
          {form.PartyType === 'general' && (
            <Input label="اسم الطرف (اختياري)" value={form.PartyName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PartyName: e.target.value })} />
          )}
          {/* ONE question, not two. The old form offered a safe AND a separate
              "payment method (optional)", but both name an asset with a
              balance and only one of them can receive the money. Choosing
              both moved the wallet and silently ignored the safe; choosing
              neither was accepted and moved nothing at all. */}
          <div className="col-span-2">
            <AssetPicker
              label={form.VoucherType === 'receipt'
                ? 'المبلغ يدخل إلى' : 'المبلغ يخرج من'}
              assets={assets}
              value={form.AssetValue}
              onChange={(v) => setForm({ ...form, AssetValue: v })}
            />
          </div>
          <div className="col-span-2">
            <Textarea label="البيان" value={form.Description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, Description: e.target.value })} placeholder="وصف العملية..." />
          </div>
        </div>
      </Modal>
    </div>
  );
}
