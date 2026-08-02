import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit, FileText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';

export function EmployeesPage() {
  const navigate = useNavigate();
  const { showToast } = useToastStore();
  const [employees, setEmployees] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ Name: '', Phone: '', Position: '', Department: '', BaseSalary: '', Allowances: '', HireDate: '', Notes: '', IsActive: 1 });

  const fetchData = async () => {
    const data = await window.api.invoke('employees:list', { isActive: 1 });
    setEmployees(data);
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ Name: '', Phone: '', Position: '', Department: '', BaseSalary: '', Allowances: '', HireDate: new Date().toISOString().split('T')[0], Notes: '', IsActive: 1 });
    setShowModal(true);
  };

  const openEdit = (emp: any) => {
    setEditing(emp);
    setForm({ Name: emp.Name, Phone: emp.Phone || '', Position: emp.Position || '', Department: emp.Department || '', BaseSalary: emp.BaseSalary?.toString() || '', Allowances: emp.Allowances?.toString() || '', HireDate: emp.HireDate || '', Notes: emp.Notes || '', IsActive: emp.IsActive });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.Name) { showToast('error', 'يرجى إدخال اسم الموظف'); return; }
    const data = { ...form, BaseSalary: parseFloat(form.BaseSalary) || 0, Allowances: parseFloat(form.Allowances) || 0 };
    if (editing) {
      const reply = await window.api.invoke('employees:update', editing.EmployeeID, data);
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم تحديث الموظف');
    } else {
      const reply = await window.api.invoke('employees:create', data);
      if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
      showToast('success', 'تم إضافة الموظف');
    }
    setShowModal(false);
    fetchData();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الموظفين</h1>
        <Button onClick={openCreate} icon={<Plus size={16} />}>موظف جديد</Button>
      </div>

      <DataTable
        columns={[
          { key: 'Name', title: 'الاسم', render: (row) => <span className="font-medium">{row.Name}</span> },
          { key: 'Position', title: 'الوظيفة', render: (row) => row.Position || '—' },
          { key: 'Department', title: 'القسم', render: (row) => row.Department || '—' },
          { key: 'BaseSalary', title: 'الراتب الأساسي', render: (row) => `${row.BaseSalary?.toFixed(2) || '0'}` },
          { key: 'Balance', title: 'الرصيد', render: (row) => <span className={row.Balance > 0 ? 'text-green-600 font-medium' : 'text-slate-500 dark:text-slate-500 dark:text-slate-400'}>{row.Balance?.toFixed(2) || '0'}</span> },
          {
            key: 'actions', title: 'إجراءات',
            render: (row) => (
              <div className="flex gap-2">
                <button onClick={() => openEdit(row)} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button>
                <button onClick={() => navigate('/reports/employee-statement')} className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:text-primary-600 flex items-center gap-1"><FileText size={12} /> كشف حساب</button>
              </div>
            ),
          },
        ]}
        data={employees}
        keyField="EmployeeID"
        emptyMessage="لا يوجد موظفون"
      />

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'تعديل موظف' : 'موظف جديد'}
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handleSave}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="الاسم" value={form.Name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Name: e.target.value })} />
          <Input label="رقم الهاتف" value={form.Phone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Phone: e.target.value })} />
          <Input label="الوظيفة" value={form.Position} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Position: e.target.value })} />
          <Input label="القسم" value={form.Department} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Department: e.target.value })} />
          <Input label="الراتب الأساسي" type="number" value={form.BaseSalary} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, BaseSalary: e.target.value })} />
          <Input label="البدلات" type="number" value={form.Allowances} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Allowances: e.target.value })} />
          <Input label="تاريخ التعيين" type="date" value={form.HireDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, HireDate: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
