import { useState, useEffect } from 'react';
import { Wallet, Users, Truck, Package, Save, RefreshCw, CreditCard, Scale } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';

type Tab = 'cash' | 'paymentMethods' | 'customers' | 'suppliers' | 'employees';

export function OpeningBalancePage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<Tab>('cash');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [capital, setCapital] = useState('0');
  const [showCapitalModal, setShowCapitalModal] = useState(false);
  const [capitalInput, setCapitalInput] = useState('');

  const fetchData = async () => {
    setLoading(true);
    const result = await window.api.invoke('openingBalances:overview');
    // The `!data` guard further down only protects against null. A refusal is
    // an object, so it would pass that guard and then be read for
    // `data.totals.totalCash` — a field it does not have.
    if (isFailure(result)) {
      showToast('error', failureMessage(result, 'تعذر تحميل الأرصدة الافتتاحية'));
      setData(null);
      setLoading(false);
      return;
    }
    setData(result);
    setEdits({});
    const cap = await window.api.invoke('capital:get');
    setCapital(cap.toString());
    setCapitalInput(cap.toString());
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleEdit = (id: number, value: string) => {
    setEdits({ ...edits, [id]: value });
  };

  const handleSave = async () => {
    const items = Object.entries(edits)
      .filter(([_, v]) => v !== '' && v !== null)
      .map(([id, v]) => ({ id: parseInt(id), balance: parseFloat(v) || 0 }));

    if (items.length === 0) {
      showToast('info', 'لا توجد تعديلات للحفظ');
      return;
    }

    setSaving(true);
    const payload: any = {
      cashAccounts: [], paymentMethods: [], customers: [], suppliers: [], employees: []
    };

    if (tab === 'cash') payload.cashAccounts = items;
    else if (tab === 'paymentMethods') payload.paymentMethods = items;
    else if (tab === 'customers') payload.customers = items;
    else if (tab === 'suppliers') payload.suppliers = items;
    else if (tab === 'employees') payload.employees = items;

    const result = await window.api.invoke('openingBalances:batchUpdate', payload);
    if (result.success) {
      showToast('success', `تم تحديث ${items.length} رصيد`);
      fetchData();
    } else {
      showToast('error', 'فشل الحفظ');
    }
    setSaving(false);
  };

  const handleSaveCapital = async () => {
    await window.api.invoke('capital:set', parseFloat(capitalInput) || 0);
    setCapital(capitalInput);
    setShowCapitalModal(false);
    showToast('success', 'تم تحديث رأس المال');
  };

  if (loading || !data) {
    return <div className="text-slate-500 dark:text-slate-400 text-center py-8">جاري التحميل...</div>;
  }

  const tabs = [
    { key: 'cash' as Tab, label: 'الخزائن والبنوك', icon: Wallet, total: data.totals.totalCash },
    { key: 'paymentMethods' as Tab, label: 'ماكينات وأنظمة الدفع', icon: CreditCard, total: data.totals.totalPaymentMethods },
    { key: 'customers' as Tab, label: 'العملاء', icon: Users, total: data.totals.totalCustomers },
    { key: 'suppliers' as Tab, label: 'الموردين', icon: Truck, total: data.totals.totalSuppliers },
    { key: 'employees' as Tab, label: 'الموظفين', icon: Package, total: data.totals.totalEmployees },
  ];

  const currentData = tab === 'cash' ? data.cashAccounts
    : tab === 'paymentMethods' ? data.paymentMethods
    : tab === 'customers' ? data.customers
    : tab === 'suppliers' ? data.suppliers
    : data.employees;

  const idField = tab === 'cash' ? 'CashAccountID'
    : tab === 'paymentMethods' ? 'PaymentMethodID'
    : tab === 'customers' ? 'CustomerID'
    : tab === 'suppliers' ? 'SupplierID'
    : 'EmployeeID';

  const nameField = tab === 'cash' ? 'AccountName'
    : tab === 'paymentMethods' ? 'MethodName'
    : 'Name';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الأرصدة الافتتاحية</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCapitalModal(true)} icon={<Scale size={16} />}>رأس المال: {parseFloat(capital).toFixed(2)}</Button>
          <Button variant="secondary" onClick={fetchData} icon={<RefreshCw size={16} />}>تحديث</Button>
          <Button onClick={handleSave} loading={saving} icon={<Save size={16} />}>حفظ التعديلات</Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl border-2 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20">
          <div className="text-xs font-medium text-green-700 dark:text-green-300">إجمالي الأصول</div>
          <div className="text-lg font-bold text-green-600">{data.totals.totalAssets?.toFixed(2)}</div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">نقدية + عملاء + مخزون</div>
        </div>
        <div className="p-4 rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">إجمالي الخصوم</div>
          <div className="text-lg font-bold text-red-600">{data.totals.totalLiabilities?.toFixed(2)}</div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">موردين + موظفين</div>
        </div>
        <div className="p-4 rounded-xl border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
          <div className="text-xs font-medium text-blue-700 dark:text-blue-300">رأس المال المحدد</div>
          <div className="text-lg font-bold text-blue-600">{parseFloat(capital).toFixed(2)}</div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">رأس المال الافتتاحي</div>
        </div>
        <div className="p-4 rounded-xl border-2 border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20">
          <div className="text-xs font-medium text-purple-700 dark:text-purple-300">صافي المركز المالي</div>
          <div className="text-lg font-bold text-purple-600">{(data.totals.totalAssets - data.totals.totalLiabilities).toFixed(2)}</div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">أصول - خصوم</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`p-3 rounded-xl border-2 text-right transition-all ${tab === t.key ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'}`}>
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className={tab === t.key ? 'text-primary-600' : 'text-slate-500 dark:text-slate-400'} />
                <span className={`text-xs font-medium ${tab === t.key ? 'text-primary-700 dark:text-primary-300' : 'text-slate-500 dark:text-slate-500 dark:text-slate-400'}`}>{t.label}</span>
              </div>
              <div className="text-base font-bold text-slate-800 dark:text-white">{t.total?.toFixed(2)}</div>
            </button>
          );
        })}
      </div>

      {/* Edit table */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">عدّل القيمة في عمود "الرصيد الجديد" ثم اضغط "حفظ التعديلات"</p>

        <DataTable
          columns={[
            { key: nameField, title: 'الاسم', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r[nameField]}</span> },
            { key: 'sub', title: 'تفاصيل', render: (r) => {
              if (tab === 'cash') return <Badge variant={r.AccountType === 'safe' ? 'blue' : 'purple'}>{r.AccountType === 'safe' ? 'خزنة' : 'بنك'}</Badge>;
              if (tab === 'paymentMethods') return <Badge variant={r.MethodType === 'pos_machine' ? 'blue' : r.MethodType === 'digital_wallet' ? 'green' : 'purple'}>{r.MethodType === 'pos_machine' ? 'ماكينة' : r.MethodType === 'digital_wallet' ? 'محفظة' : 'تحويل'}</Badge>;
              if (tab === 'suppliers' || tab === 'customers') return r.Phone || '—';
              return r.Phone || '—';
            }},
            { key: 'Balance', title: 'الرصيد الحالي', render: (r) => <span className="font-bold text-slate-700 dark:text-slate-200">{r.Balance?.toFixed(2)}</span> },
            {
              key: 'newBalance',
              title: 'الرصيد الجديد',
              render: (r) => (
                <input
                  type="number"
                  value={edits[r[idField]] ?? ''}
                  onChange={(e) => handleEdit(r[idField], e.target.value)}
                  placeholder={r.Balance?.toString() || '0'}
                  className="w-32 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm"
                />
              ),
            },
          ]}
          data={currentData}
          keyField={idField}
          emptyMessage="لا توجد بيانات"
        />
      </div>

      {/* Capital Modal */}
      <Modal isOpen={showCapitalModal} onClose={() => setShowCapitalModal(false)} title="رأس المال الافتتاحي" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowCapitalModal(false)}>إلغاء</Button><Button onClick={handleSaveCapital}>حفظ</Button></>}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400">
            رأس المال هو المبلغ الذي بدأت به المحل. يساعد في حساب الأرباح والخسائر الفعلية ومعرفة المركز المالي الصحيح.
          </p>
          <Input
            label="رأس المال الافتتاحي"
            type="number"
            value={capitalInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCapitalInput(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
