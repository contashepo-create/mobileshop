import { useState, useEffect } from 'react';
import { Plus, Edit, CreditCard } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';

export function PaymentMethodsPage() {
  const { showToast } = useToastStore();
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ MethodName: '', MethodType: 'pos_machine', Provider: '', PhoneNumber: '', IsActive: 1 });

  const fetchData = async () => {
    const pm = await window.api.invoke('paymentMethods:list');
    setPaymentMethods(pm);
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ MethodName: '', MethodType: 'pos_machine', Provider: '', PhoneNumber: '', IsActive: 1 });
    setShowModal(true);
  };

  const openEdit = (pm: any) => {
    setEditing(pm);
    setForm({ MethodName: pm.MethodName, MethodType: pm.MethodType, Provider: pm.Provider || '', PhoneNumber: pm.PhoneNumber || '', IsActive: pm.IsActive });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.MethodName) { showToast('error', 'يرجى إدخال اسم طريقة الدفع'); return; }
    if (editing) {
      await window.api.invoke('paymentMethods:update', editing.PaymentMethodID, form);
      showToast('success', 'تم التحديث');
    } else {
      await window.api.invoke('paymentMethods:create', form);
      showToast('success', 'تم الإضافة');
    }
    setShowModal(false);
    fetchData();
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
          { key: 'actions', title: '', render: (row) => <button onClick={() => openEdit(row)} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button> },
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
        </div>
      </Modal>
    </div>
  );
}
