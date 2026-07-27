import { useState, useEffect } from 'react';
import { Plus, Search, Ban, Edit, FileText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { getPartyColor } from '../../../../shared/types';

export function CustomersPage() {
  const { showToast } = useToastStore();
  const [customers, setCustomers] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [thresholds, setThresholds] = useState({ warn: 1000, danger: 5000 });

  // Form state
  const [form, setForm] = useState({ Name: '', Phone: '', Email: '', Address: '', CreditLimit: '', Status: 'active' });

  const fetchData = async () => {
    const data = await window.api.invoke('customers:list', { search, status: statusFilter });
    setCustomers(data);
    const settings = await window.api.invoke('settings:getAll');
    setThresholds({
      warn: parseInt(settings.customer_warn_threshold || '1000'),
      danger: parseInt(settings.customer_danger_threshold || '5000'),
    });
  };

  useEffect(() => { fetchData(); }, [search, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setForm({ Name: '', Phone: '', Email: '', Address: '', CreditLimit: '', Status: 'active' });
    setShowModal(true);
  };

  const openEdit = (c: any) => {
    setEditing(c);
    setForm({ Name: c.Name, Phone: c.Phone || '', Email: c.Email || '', Address: c.Address || '', CreditLimit: c.CreditLimit?.toString() || '', Status: c.Status });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.Name) { showToast('error', 'يرجى إدخال اسم العميل'); return; }
    const data = { ...form, CreditLimit: form.CreditLimit ? parseFloat(form.CreditLimit) : null };
    if (editing) {
      await window.api.invoke('customers:update', editing.CustomerID, data);
      showToast('success', 'تم تحديث العميل');
    } else {
      await window.api.invoke('customers:create', data);
      showToast('success', 'تم إضافة العميل');
    }
    setShowModal(false);
    fetchData();
  };

  const handleStatusChange = async (id: number, status: string) => {
    await window.api.invoke('customers:updateStatus', id, status);
    showToast('success', status === 'suspended' ? 'تم حظر العميل' : 'تم تحديث حالة العميل');
    fetchData();
  };

  const colorVariants: Record<string, 'green' | 'yellow' | 'orange' | 'red'> = {
    green: 'green', yellow: 'yellow', orange: 'orange', red: 'red'
  };

  const statusLabels: Record<string, string> = {
    active: 'نشط', warned: 'تحذير', suspended: 'محظور'
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">العملاء</h1>
        <Button onClick={openCreate} icon={<Plus size={16} />}>عميل جديد</Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو الهاتف..."
            className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-xs">
          <option value="all">كل الحالات</option>
          <option value="active">نشط</option>
          <option value="warned">تحذير</option>
          <option value="suspended">محظور</option>
        </Select>
      </div>

      {/* Table */}
      <DataTable
        columns={[
          {
            key: 'Name',
            title: 'الاسم',
            render: (row) => {
              const color = getPartyColor(row.Balance, row.Status, thresholds.warn, thresholds.danger);
              return (
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    color === 'green' ? 'bg-green-500' : color === 'yellow' ? 'bg-yellow-500' : color === 'orange' ? 'bg-orange-500' : 'bg-red-500'
                  }`} />
                  <span className="font-medium">{row.Name}</span>
                </div>
              );
            },
          },
          { key: 'Phone', title: 'الهاتف', render: (row) => row.Phone || '—' },
          {
            key: 'Balance',
            title: 'الرصيد',
            render: (row) => (
              <span className={row.Balance > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
                {row.Balance > 0 ? `${row.Balance.toFixed(2)} مدين` : `${Math.abs(row.Balance).toFixed(2)}`}
              </span>
            ),
          },
          {
            key: 'Status',
            title: 'الحالة',
            render: (row) => <Badge variant={row.Status === 'active' ? 'green' : row.Status === 'warned' ? 'yellow' : 'red'}>{statusLabels[row.Status]}</Badge>,
          },
          {
            key: 'actions',
            title: 'إجراءات',
            render: (row) => (
              <div className="flex gap-2">
                <button onClick={() => openEdit(row)} className="text-xs text-primary-600 hover:underline flex items-center gap-1">
                  <Edit size={12} /> تعديل
                </button>
                {row.Status !== 'suspended' ? (
                  <button onClick={() => handleStatusChange(row.CustomerID, 'suspended')} className="text-xs text-red-500 hover:underline flex items-center gap-1">
                    <Ban size={12} /> حظر
                  </button>
                ) : (
                  <button onClick={() => handleStatusChange(row.CustomerID, 'active')} className="text-xs text-green-600 hover:underline flex items-center gap-1">
                    تفعيل
                  </button>
                )}
              </div>
            ),
          },
        ]}
        data={customers}
        keyField="CustomerID"
        emptyMessage="لا يوجد عملاء"
      />

      {/* Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'تعديل عميل' : 'عميل جديد'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button>
            <Button onClick={handleSave}>حفظ</Button>
          </>
        }
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
            <option value="suspended">محظور</option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}
