import { useState, useEffect } from 'react';
import { Plus, Search, Ban, Edit } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';

export function SuppliersPage() {
  const { showToast } = useToastStore();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ Name: '', Phone: '', Email: '', Address: '', CreditLimit: '', Status: 'active' });

  const fetchData = async () => {
    const data = await window.api.invoke('suppliers:list', { search, status: statusFilter });
    setSuppliers(data);
  };

  useEffect(() => { fetchData(); }, [search, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setForm({ Name: '', Phone: '', Email: '', Address: '', CreditLimit: '', Status: 'active' });
    setShowModal(true);
  };

  const openEdit = (s: any) => {
    setEditing(s);
    setForm({ Name: s.Name, Phone: s.Phone || '', Email: s.Email || '', Address: s.Address || '', CreditLimit: s.CreditLimit?.toString() || '', Status: s.Status });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.Name) { showToast('error', 'يرجى إدخال اسم المورد'); return; }
    const data = { ...form, CreditLimit: form.CreditLimit ? parseFloat(form.CreditLimit) : null };
    if (editing) {
      const reply = await window.api.invoke('suppliers:update', editing.SupplierID, data);
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم تحديث المورد');
    } else {
      const reply = await window.api.invoke('suppliers:create', data);
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم إضافة المورد');
    }
    setShowModal(false);
    fetchData();
  };

  const handleStatusChange = async (id: number, status: string) => {
    const reply = await window.api.invoke('suppliers:updateStatus', id, status);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم تحديث حالة المورد');
    fetchData();
  };

  const statusLabels: Record<string, string> = { active: 'نشط', warned: 'تحذير', suspended: 'موقف' };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الموردين</h1>
        <Button onClick={openCreate} icon={<Plus size={16} />}>مورد جديد</Button>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الهاتف..." className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-xs">
          <option value="all">كل الحالات</option>
          <option value="active">نشط</option>
          <option value="warned">تحذير</option>
          <option value="suspended">موقف</option>
        </Select>
      </div>

      <DataTable
        columns={[
          { key: 'Name', title: 'الاسم', render: (row) => <span className="font-medium">{row.Name}</span> },
          { key: 'Phone', title: 'الهاتف', render: (row) => row.Phone || '—' },
          { key: 'Balance', title: 'الرصيد', render: (row) => <span className={row.Balance > 0 ? 'text-orange-600 font-medium' : 'text-green-600'}>{row.Balance > 0 ? `${row.Balance.toFixed(2)} مستحق له` : '0'}</span> },
          { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={row.Status === 'active' ? 'green' : row.Status === 'warned' ? 'yellow' : 'red'}>{statusLabels[row.Status]}</Badge> },
          { key: 'CreditLimit', title: 'حد ائتماني', render: (row) => row.CreditLimit ? row.CreditLimit.toFixed(2) : '—' },
          {
            key: 'actions', title: 'إجراءات',
            render: (row) => (
              <div className="flex gap-2">
                <button onClick={() => openEdit(row)} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button>
                {row.Status !== 'suspended' ? (
                  <button onClick={() => handleStatusChange(row.SupplierID, 'suspended')} className="text-xs text-red-500 hover:underline flex items-center gap-1"><Ban size={12} /> إيقاف</button>
                ) : (
                  <button onClick={() => handleStatusChange(row.SupplierID, 'active')} className="text-xs text-green-600 hover:underline">تفعيل</button>
                )}
              </div>
            ),
          },
        ]}
        data={suppliers}
        keyField="SupplierID"
        emptyMessage="لا يوجد موردين"
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'تعديل مورد' : 'مورد جديد'}
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="الاسم" value={form.Name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Name: e.target.value })} />
          <Input label="رقم الهاتف" value={form.Phone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Phone: e.target.value })} />
          <Input label="البريد الإلكتروني" value={form.Email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Email: e.target.value })} />
          <Input label="العنوان" value={form.Address} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Address: e.target.value })} />
          <Input label="حد ائتماني" type="number" value={form.CreditLimit} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, CreditLimit: e.target.value })} />
          <Select label="الحالة" value={form.Status} onChange={(e) => setForm({ ...form, Status: e.target.value })}>
            <option value="active">نشط</option>
            <option value="warned">تحذير</option>
            <option value="suspended">موقف</option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}
