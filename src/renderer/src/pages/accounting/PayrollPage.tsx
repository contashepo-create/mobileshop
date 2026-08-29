import { useState, useEffect } from 'react';
import { Plus, DollarSign, FileText, CheckCircle, Clock, Eye, Trash2, Banknote } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';
import { localToday } from '../../lib/businessDay';

export function PayrollPage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<'salaries' | 'advances' | 'deductions' | 'commissions'>('salaries');
  const [salaries, setSalaries] = useState<any[]>([]);
  const [advances, setAdvances] = useState<any[]>([]);
  const [deductions, setDeductions] = useState<any[]>([]);
  const [commissions, setCommissions] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);

  const [showIssueModal, setShowIssueModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [showDeductionModal, setShowDeductionModal] = useState(false);
  const [showCommPayModal, setShowCommPayModal] = useState(false);
  const [selectedSalary, setSelectedSalary] = useState<any>(null);
  const [salaryDetails, setSalaryDetails] = useState<any>(null);
  const [selectedCommission, setSelectedCommission] = useState<any>(null);

  const [issueForm, setIssueForm] = useState({ EmployeeID: '', Month: new Date().toISOString().substring(0, 7) });
  const [openAdvances, setOpenAdvances] = useState<any[]>([]);
  const [advDeducts, setAdvDeducts] = useState<Record<string, string>>({});
  const [payForm, setPayForm] = useState({ PaidAmount: '', CashAccountID: '', PaymentDate: localToday() });
  const [commPayForm, setCommPayForm] = useState({ CashAccountID: '', Date: localToday() });
  const [advanceForm, setAdvanceForm] = useState({ EmployeeID: '', Amount: '', Reason: '', CashAccountID: '', AdvanceDate: localToday() });
  const [deductionForm, setDeductionForm] = useState({ EmployeeID: '', Amount: '', Reason: 'absence', DamagedItemID: '', DamageCostType: 'cost', Notes: '', DeductionDate: localToday() });

  const fetchData = async () => {
    const [s, a, d, co, em, ca, it] = await Promise.all([
      window.api.invoke('salaries:list'),
      window.api.invoke('advances:list'),
      window.api.invoke('deductions:list'),
      window.api.invoke('commissions:list'),
      window.api.invoke('employees:list', { isActive: 1 }),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('items:list', { isActive: 1 }),
    ]);
    setSalaries(s); setAdvances(a); setDeductions(d); setCommissions(co); setEmployees(em); setCashAccounts(ca); setItems(it);
  };

  useEffect(() => { fetchData(); }, []);

  // Loads the employee's OPEN advances into the issue form and pre-fills each
  // deduction with what the historical schedule would have absorbed (oldest
  // first, capped by the month's available net). That default keeps prior
  // behaviour for the person who just clicks "إصدار"; the fields stay editable
  // so any advance can be settled by any amount, and zero leaves it open.
  const onIssueEmpChange = async (empId: string) => {
    setIssueForm({ ...issueForm, EmployeeID: empId });
    setOpenAdvances([]);
    setAdvDeducts({});
    if (!empId) return;
    const emp = employees.find((e: any) => e.EmployeeID === parseInt(empId));
    const [advs, comms, deds] = await Promise.all([
      window.api.invoke('advances:list', parseInt(empId)),
      window.api.invoke('commissions:list', { employeeId: parseInt(empId), status: 'pending' }),
      window.api.invoke('deductions:list', parseInt(empId)),
    ]);
    const open = (advs || [])
      .filter((a: any) => a.IsDeducted === 0)
      .sort((a: any, b: any) => a.AdvanceID - b.AdvanceID);
    const commTotal = (comms || []).reduce((s: number, c: any) => s + (c.Amount || 0), 0);
    const dedTotal = (deds || []).filter((d: any) => d.IsDeducted === 0)
      .reduce((s: number, d: any) => s + (d.Amount || 0), 0);
    const available = Math.max(0, (emp?.BaseSalary || 0) + (emp?.Allowances || 0) + commTotal - dedTotal);
    let left = available;
    const prefill: Record<string, string> = {};
    for (const a of open) {
      const deduct = Math.min(a.Amount, left);
      prefill[a.AdvanceID] = deduct > 0 ? deduct.toFixed(2) : '0';
      left = +(left - deduct).toFixed(2);
    }
    setOpenAdvances(open);
    setAdvDeducts(prefill);
  };

  const handleIssue = async () => {
    if (!issueForm.EmployeeID) { showToast('error', 'اختر موظفاً'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const deductAmounts = openAdvances.map((a: any) => ({
      AdvanceID: a.AdvanceID,
      Amount: parseFloat(advDeducts[a.AdvanceID]) || 0,
    }));
    const result = await window.api.invoke('salaries:issue', {
      EmployeeID: parseInt(issueForm.EmployeeID),
      Month: issueForm.Month,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
      deductAmounts,
    });
    if (result.success) {
      const d = result.details;
      showToast('success',
        `تم إصدار الراتب - الأساسي: ${d.baseSalary.toFixed(2)} + بدلات: ${d.allowances.toFixed(2)} + عمولات: ${d.commissions.toFixed(2)} - خصومات: ${d.deductions.toFixed(2)} - سلف مخصومة: ${(d.advancesApplied ?? d.advances).toFixed(2)} = الصافي: ${d.netSalary.toFixed(2)}`
      );
      setShowIssueModal(false);
      setOpenAdvances([]);
      setAdvDeducts({});
      setIssueForm({ EmployeeID: '', Month: new Date().toISOString().substring(0, 7) });
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const handlePay = async () => {
    if (!selectedSalary) return;
    const result = await window.api.invoke('salaries:pay', {
      SalaryID: selectedSalary.SalaryID,
      PaidAmount: parseFloat(payForm.PaidAmount) || 0,
      CashAccountID: payForm.CashAccountID ? parseInt(payForm.CashAccountID) : undefined,
      Date: payForm.PaymentDate,
      userId: currentUserId(),
    });
    if (result.success) {
      showToast('success', `تم صرف الراتب - المدفوع: ${result.paidAmount.toFixed(2)} / الصافي: ${result.netSalary.toFixed(2)} - ${result.status === 'paid' ? 'مدفوع بالكامل' : 'دفع جزئي'}`);
      setShowPayModal(false);
      setPayForm({ PaidAmount: '', CashAccountID: '', PaymentDate: localToday() });
      setSelectedSalary(null);
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const openPayModal = (salary: any) => {
    setSelectedSalary(salary);
    setPayForm({ PaidAmount: salary.NetSalary.toString(), CashAccountID: '', PaymentDate: localToday() });
    setShowPayModal(true);
  };

  const openDetailsModal = async (salary: any) => {
    setSelectedSalary(salary);
    const result = await window.api.invoke('salaries:getDetails', salary.SalaryID);
    // `{ success: false }` (deleted salary, or no `payroll.view` permission) is
    // truthy, so the modal below would open and immediately read
    // `.salary.BaseSalary` and `.commissions.length` off an object that has
    // neither — blanking the entire application instead of the modal.
    if (isFailure(result)) {
      showToast('error', failureMessage(result, 'تعذر تحميل تفاصيل الراتب'));
      return;
    }
    setSalaryDetails(result);
    setShowDetailsModal(true);
  };

  const handleAdvance = async () => {
    if (!advanceForm.EmployeeID || !advanceForm.Amount || !advanceForm.CashAccountID) { showToast('error', 'أكمل البيانات'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const reply = await window.api.invoke('advances:create', {
      EmployeeID: parseInt(advanceForm.EmployeeID),
      Amount: parseFloat(advanceForm.Amount),
      Reason: advanceForm.Reason,
      CashAccountID: parseInt(advanceForm.CashAccountID),
      Date: advanceForm.AdvanceDate,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم صرف السلفية');
    setShowAdvanceModal(false);
    setAdvanceForm({ EmployeeID: '', Amount: '', Reason: '', CashAccountID: '', AdvanceDate: localToday() });
    fetchData();
  };

  const handleDeduction = async () => {
    if (!deductionForm.EmployeeID) { showToast('error', 'اختر موظفاً'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const result = await window.api.invoke('deductions:create', {
      EmployeeID: parseInt(deductionForm.EmployeeID),
      Amount: parseFloat(deductionForm.Amount) || 0,
      Reason: deductionForm.Reason,
      DamagedItemID: deductionForm.DamagedItemID ? parseInt(deductionForm.DamagedItemID) : undefined,
      DamageCostType: deductionForm.DamageCostType,
      Notes: deductionForm.Notes,
      Date: deductionForm.DeductionDate,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (result.success) {
      showToast('success', `تم تسجيل الخصم - المبلغ: ${result.amount?.toFixed(2)}`);
      setShowDeductionModal(false);
      setDeductionForm({ EmployeeID: '', Amount: '', Reason: 'absence', DamagedItemID: '', DamageCostType: 'cost', Notes: '', DeductionDate: localToday() });
      fetchData();
    }
  };

  const handleCommPay = async () => {
    if (!selectedCommission) return;
    if (!commPayForm.CashAccountID) { showToast('error', 'اختر الخزنة'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const result = await window.api.invoke('commissions:payImmediate', {
      CommissionID: selectedCommission.CommissionID,
      CashAccountID: parseInt(commPayForm.CashAccountID),
      Date: commPayForm.Date,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (result.success) {
      showToast('success', `تم صرف العمولة ${result.paidAmount?.toFixed(2)} ${result.voucherNumber ? `- سند ${result.voucherNumber}` : ''}`);
      setShowCommPayModal(false);
      setSelectedCommission(null);
      setCommPayForm({ CashAccountID: '', Date: localToday() });
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const deductionReasons = [
    { value: 'absence', label: 'غياب' },
    { value: 'negligence', label: 'تقصير في العمل' },
    { value: 'damage', label: 'إتلاف قطعة غيار' },
    { value: 'other', label: 'سبب آخر' },
  ];

  const tabBtnClass = (t: string) =>
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ' +
    (tab === t ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الرواتب والسلفيات</h1>

      <div className="flex gap-2">
        <button onClick={() => setTab('salaries')} className={tabBtnClass('salaries')}>الرواتب</button>
        <button onClick={() => setTab('advances')} className={tabBtnClass('advances')}>السلفيات</button>
        <button onClick={() => setTab('deductions')} className={tabBtnClass('deductions')}>الخصومات</button>
        <button onClick={() => setTab('commissions')} className={tabBtnClass('commissions')}>العمولات</button>
      </div>

      {tab === 'salaries' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowIssueModal(true)} icon={<FileText size={16} />}>إصدار راتب</Button>
          </div>
          <DataTable
            columns={[
              { key: 'EmployeeName', title: 'الموظف', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.EmployeeName}</span> },
              { key: 'Month', title: 'الشهر' },
              { key: 'BaseSalary', title: 'الأساسي', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.BaseSalary?.toFixed(2)}</span> },
              { key: 'Allowances', title: 'بدلات', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.Allowances?.toFixed(2)}</span> },
              { key: 'CommissionsTotal', title: 'عمولات', render: (r) => <span className="text-green-600">{r.CommissionsTotal?.toFixed(2) || '0'}</span> },
              { key: 'DeductionsTotal', title: 'خصومات', render: (r) => <span className="text-red-600">{r.DeductionsTotal?.toFixed(2) || '0'}</span> },
              { key: 'AdvancesTotal', title: 'سلف', render: (r) => <span className="text-orange-600">{r.AdvancesTotal?.toFixed(2) || '0'}</span> },
              { key: 'NetSalary', title: 'الصافي', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.NetSalary?.toFixed(2)}</span> },
              { key: 'PaidAmount', title: 'المدفوع', render: (r) => <span className="text-green-600">{r.PaidAmount?.toFixed(2)}</span> },
              { key: 'Status', title: 'الحالة', render: (r) => (
                <Badge variant={r.Status === 'paid' ? 'green' : r.Status === 'partial' ? 'yellow' : 'gray'}>
                  {r.Status === 'paid' ? 'مدفوع' : r.Status === 'partial' ? 'جزئي' : 'معلّق'}
                </Badge>
              )},
              { key: 'actions', title: 'إجراءات', render: (r) => (
                <div className="flex gap-2">
                  <button onClick={() => openDetailsModal(r)} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><Eye size={12} /> تفاصيل</button>
                  {r.Status !== 'paid' && <button onClick={() => openPayModal(r)} className="text-xs text-green-600 hover:underline flex items-center gap-1"><DollarSign size={12} /> صرف</button>}
                </div>
              )},
            ]}
            data={salaries}
            keyField="SalaryID"
            emptyMessage="لا توجد رواتب"
          />
        </div>
      )}

      {tab === 'advances' && (
        <div className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => setShowAdvanceModal(true)} icon={<Plus size={16} />}>سلفية جديدة</Button></div>
          <DataTable
            columns={[
              { key: 'EmployeeName', title: 'الموظف', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.EmployeeName}</span> },
              { key: 'Date', title: 'التاريخ' },
              { key: 'Amount', title: 'المتبقي', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.Amount?.toFixed(2)}</span> },
              { key: 'Reason', title: 'السبب', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Reason || '—'}</span> },
              { key: 'history', title: 'سجل الخصم الشهري', render: (r) => {
                const h = (r.history || []).map((x: any) => `${x.SalaryMonth || x.Month}: -${x.Amount?.toFixed(2)} (باقي ${x.RemainingAfter?.toFixed(2)})`);
                return h.length
                  ? <div className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5">{h.map((s: string, i: number) => <div key={i} className="whitespace-nowrap" dir="ltr">{s}</div>)}</div>
                  : <span className="text-slate-400">—</span>;
              } },
              { key: 'IsDeducted', title: 'مخصومة بالكامل', render: (r) => <Badge variant={r.IsDeducted ? 'green' : 'yellow'}>{r.IsDeducted ? 'نعم' : 'لا'}</Badge> },
              { key: 'delete', title: '', render: (r) => <button onClick={async () => { if (confirm('سيتم حذف السلفية وعكس التأثير على رصيد الموظف والخزنة. متابعة؟')) { const res = await window.api.invoke('delete:advance', r.AdvanceID); if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
            ]}
            data={advances}
            keyField="AdvanceID"
            emptyMessage="لا توجد سلفيات"
          />
        </div>
      )}

      {tab === 'deductions' && (
        <div className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => setShowDeductionModal(true)} icon={<Plus size={16} />}>خصم جديد</Button></div>
          <DataTable
            columns={[
              { key: 'EmployeeName', title: 'الموظف', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.EmployeeName}</span> },
              { key: 'Date', title: 'التاريخ' },
              { key: 'Amount', title: 'المبلغ', render: (r) => <span className="font-bold text-red-600">{r.Amount?.toFixed(2)}</span> },
              { key: 'Reason', title: 'السبب', render: (r) => { const labels: any = { absence: 'غياب', negligence: 'تقصير', damage: 'إتلاف', other: 'أخرى' }; return <span className="text-slate-600 dark:text-slate-300">{labels[r.Reason] || r.Reason}</span>; } },
              { key: 'DamagedItemName', title: 'الصنف المتلف', render: (r) => <span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">{r.DamagedItemName || '—'}</span> },
              { key: 'IsDeducted', title: 'مخصوم', render: (r) => <Badge variant={r.IsDeducted ? 'green' : 'yellow'}>{r.IsDeducted ? 'نعم' : 'لا'}</Badge> },
              { key: 'delete', title: '', render: (r) => <button onClick={async () => { if (confirm('سيتم حذف الخصم. متابعة؟')) { const res = await window.api.invoke('delete:deduction', r.DeductionID); if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
            ]}
            data={deductions}
            keyField="DeductionID"
            emptyMessage="لا توجد خصومات"
          />
        </div>
      )}

      {tab === 'commissions' && (
        <div className="space-y-4">
          <DataTable
            columns={[
              { key: 'EmployeeName', title: 'الموظف', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.EmployeeName}</span> },
              { key: 'Date', title: 'التاريخ' },
              { key: 'CommissionType', title: 'النوع', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.CommissionType === 'maintenance' ? 'عمولة صيانة' : 'عمولة مبيعات'}</span> },
              { key: 'RefNumber', title: 'المرجع', render: (r) => <span className="text-slate-500 dark:text-slate-400">{r.RefNumber || '—'}</span> },
              { key: 'Amount', title: 'المبلغ', render: (r) => <span className="font-bold text-green-600">{r.Amount?.toFixed(2)}</span> },
              { key: 'Status', title: 'الحالة', render: (r) => (
                <Badge variant={r.IsPaid ? (r.PaidInSalaryID ? 'blue' : 'green') : 'yellow'}>
                  {r.IsPaid ? (r.PaidInSalaryID ? 'مدفوعة براتب' : `مدفوعة فوراً${r.VoucherNumber ? ` (${r.VoucherNumber})` : ''}`) : 'مستحقة'}
                </Badge>
              )},
              { key: 'actions', title: '', render: (r) => (
                <div className="flex gap-2">{r.IsPaid === 0 && (
                  <button onClick={() => { setSelectedCommission(r); setCommPayForm({ CashAccountID: '', Date: localToday() }); setShowCommPayModal(true); }}
                    className="text-xs text-green-600 hover:underline flex items-center gap-1"><Banknote size={12} /> صرف فوري</button>
                )}</div>
              )},
            ]}
            data={commissions}
            keyField="CommissionID"
            emptyMessage="لا توجد عمولات"
          />
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
            العمولة المستحقة تُخصم من راتب الشهر عند إصداره، أو يمكن صرفها فوراً من الخزنة — في الحالتين تُعرض في قائمة الدخل كمصروف.
          </div>
        </div>
      )}

      {/* Issue Salary Modal */}
      <Modal isOpen={showIssueModal} onClose={() => setShowIssueModal(false)} title="إصدار راتب" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowIssueModal(false)}>إلغاء</Button><Button onClick={handleIssue}>إصدار</Button></>}
      >
        <div className="space-y-4">
          <Select label="الموظف" value={issueForm.EmployeeID} onChange={(e) => onIssueEmpChange(e.target.value)}>
            <option value="">— اختر —</option>
            {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name} (راتب: {emp.BaseSalary?.toFixed(2)})</option>)}
          </Select>
          <Input label="الشهر" type="month" value={issueForm.Month} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIssueForm({ ...issueForm, Month: e.target.value })} />
          {openAdvances.length > 0 && (
            <div className="border border-orange-200 dark:border-orange-900/40 rounded-lg overflow-hidden">
              <div className="bg-orange-50 dark:bg-orange-900/20 px-3 py-2 text-xs font-semibold text-orange-700 dark:text-orange-300 flex justify-between">
                <span>السلف المفتوحة — حدّد المبلغ المراد خصمه من هذا الشهر</span>
                <span className="font-normal">الصفر يُبقيها مفتوحة</span>
              </div>
              <div className="space-y-2 p-3">
                {openAdvances.map((a: any) => (
                  <div key={a.AdvanceID} className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex-1">
                      <div className="text-slate-600 dark:text-slate-300">{a.Reason || 'سلفية'}</div>
                      <div className="text-slate-400">باقي: {a.Amount?.toFixed(2)}</div>
                    </div>
                    <Input
                      type="number" min={0} max={a.Amount} step="0.01"
                      value={advDeducts[a.AdvanceID] ?? ''}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdvDeducts({ ...advDeducts, [a.AdvanceID]: e.target.value })}
                      className="w-32 text-center"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
            سيتم حساب: الراتب الأساسي + البدلات + العمولات غير المدفوعة − الخصومات غير المخصومة − السلف المخصومة = صافي الراتب
          </div>
        </div>
      </Modal>

      {/* Pay Salary Modal */}
      <Modal isOpen={showPayModal} onClose={() => setShowPayModal(false)} title={`صرف راتب - ${selectedSalary?.EmployeeName || ''}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowPayModal(false)}>إلغاء</Button><Button onClick={handlePay}>صرف</Button></>}
      >
        {selectedSalary && (
          <div className="space-y-4">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">صافي الراتب:</span><span className="font-bold text-slate-800 dark:text-white">{selectedSalary.NetSalary?.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">المدفوع سابقاً:</span><span className="text-green-600">{selectedSalary.PaidAmount?.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">المتبقي:</span><span className="font-bold text-red-600">{(selectedSalary.NetSalary - selectedSalary.PaidAmount).toFixed(2)}</span></div>
            </div>
            <Input label="المبلغ المراد صرفه" type="number" value={payForm.PaidAmount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPayForm({ ...payForm, PaidAmount: e.target.value })} hint={`الحد الأقصى: ${selectedSalary.NetSalary?.toFixed(2)}`} />
            <Input label="تاريخ الصرف" type="date" value={payForm.PaymentDate}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPayForm({ ...payForm, PaymentDate: e.target.value })}
              hint="قابل للتعديل - يُقيَّد الصرف في سنته المالية" />
            <Select label="الخزنة" value={payForm.CashAccountID} onChange={(e) => setPayForm({ ...payForm, CashAccountID: e.target.value })}>
              <option value="">— اختر —</option>
              {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
            </Select>
          </div>
        )}
      </Modal>

      {/* Salary Details Modal */}
      <Modal isOpen={showDetailsModal} onClose={() => setShowDetailsModal(false)} title={`تفاصيل راتب - ${selectedSalary?.EmployeeName || ''}`} size="lg"
        footer={<Button variant="secondary" onClick={() => setShowDetailsModal(false)}>إغلاق</Button>}
      >
        {salaryDetails && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">الراتب الأساسي</div><div className="font-bold text-slate-800 dark:text-white">{salaryDetails.salary?.BaseSalary?.toFixed(2)}</div></div>
              <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">البدلات</div><div className="font-bold text-slate-800 dark:text-white">{salaryDetails.salary?.Allowances?.toFixed(2)}</div></div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">عمولات</div><div className="font-bold text-green-600">{salaryDetails.salary?.CommissionsTotal?.toFixed(2)}</div></div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">خصومات</div><div className="font-bold text-red-600">{salaryDetails.salary?.DeductionsTotal?.toFixed(2)}</div></div>
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">سلف</div><div className="font-bold text-orange-600">{salaryDetails.salary?.AdvancesTotal?.toFixed(2)}</div></div>
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3"><div className="text-xs text-slate-500 dark:text-slate-400">الصافي</div><div className="font-bold text-blue-600">{salaryDetails.salary?.NetSalary?.toFixed(2)}</div></div>
            </div>

            {asRows(salaryDetails.commissions).length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-1">العمولات المضمّنة</h4>
                {asRows<any>(salaryDetails.commissions).map((c: any) => <div key={c.CommissionID} className="flex justify-between text-xs py-1"><span>{c.CommissionType === 'maintenance' ? 'عمولة صيانة' : 'عمولة مبيعات'} {c.RefNumber || ''}</span><span className="text-green-600 font-bold">{c.Amount?.toFixed(2)}</span></div>)}
              </div>
            )}
            {asRows(salaryDetails.deductions).length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-1">الخصومات المضمّنة</h4>
                {asRows<any>(salaryDetails.deductions).map((d: any) => <div key={d.DeductionID} className="flex justify-between text-xs py-1"><span>{d.Reason === 'absence' ? 'غياب' : d.Reason === 'damage' ? `إتلاف ${d.DamagedItemName || ''}` : d.Reason === 'negligence' ? 'تقصير' : 'أخرى'}</span><span className="text-red-600 font-bold">{d.Amount?.toFixed(2)}</span></div>)}
              </div>
            )}
            {asRows(salaryDetails.advances).length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-1">السلف المضمّنة</h4>
                {asRows<any>(salaryDetails.advances).map((a: any) => <div key={a.AdvanceID} className="flex justify-between text-xs py-1"><span>{a.Reason || 'سلفية'}</span><span className="text-orange-600 font-bold">{a.Amount?.toFixed(2)}</span></div>)}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Advance Modal */}
      <Modal isOpen={showAdvanceModal} onClose={() => setShowAdvanceModal(false)} title="صرف سلفية"
        footer={<><Button variant="secondary" onClick={() => setShowAdvanceModal(false)}>إلغاء</Button><Button onClick={handleAdvance}>صرف</Button></>}
      >
        <div className="space-y-4">
          <Select label="الموظف" value={advanceForm.EmployeeID} onChange={(e) => setAdvanceForm({ ...advanceForm, EmployeeID: e.target.value })}>
            <option value="">— اختر —</option>
            {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name}</option>)}
          </Select>
          <Input label="المبلغ" type="number" value={advanceForm.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdvanceForm({ ...advanceForm, Amount: e.target.value })} />
          <Input label="السبب" value={advanceForm.Reason} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdvanceForm({ ...advanceForm, Reason: e.target.value })} />
          <Input label="تاريخ الصرف" type="date" value={advanceForm.AdvanceDate}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdvanceForm({ ...advanceForm, AdvanceDate: e.target.value })}
            hint="قابل للتعديل - تُقيَّد السلفية في سنتها المالية" />
          <Select label="الخزنة" value={advanceForm.CashAccountID} onChange={(e) => setAdvanceForm({ ...advanceForm, CashAccountID: e.target.value })}>
            <option value="">— اختر —</option>
            {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName}</option>)}
          </Select>
        </div>
      </Modal>

      {/* Deduction Modal */}
      <Modal isOpen={showDeductionModal} onClose={() => setShowDeductionModal(false)} title="تسجيل خصم"
        footer={<><Button variant="secondary" onClick={() => setShowDeductionModal(false)}>إلغاء</Button><Button onClick={handleDeduction}>حفظ</Button></>}
      >
        <div className="space-y-4">
          <Select label="الموظف" value={deductionForm.EmployeeID} onChange={(e) => setDeductionForm({ ...deductionForm, EmployeeID: e.target.value })}>
            <option value="">— اختر —</option>
            {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name}</option>)}
          </Select>
          <Select label="سبب الخصم" value={deductionForm.Reason} onChange={(e) => setDeductionForm({ ...deductionForm, Reason: e.target.value, DamagedItemID: '' })}>
            {deductionReasons.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
          {deductionForm.Reason === 'damage' && (
            <>
              <Select label="الصنف المتلف" value={deductionForm.DamagedItemID} onChange={(e) => setDeductionForm({ ...deductionForm, DamagedItemID: e.target.value })}>
                <option value="">— اختر —</option>
                {items.map((it: any) => <option key={it.ItemID} value={it.ItemID}>{it.ItemName} (تكلفة: {it.CostPrice?.toFixed(2)} - بيع: {it.SalePrice?.toFixed(2)})</option>)}
              </Select>
              <Select label="نوع الخصم" value={deductionForm.DamageCostType} onChange={(e) => setDeductionForm({ ...deductionForm, DamageCostType: e.target.value })}>
                <option value="cost">بسعر التكلفة</option>
                <option value="sale">بسعر البيع</option>
                <option value="manual">يدوي</option>
              </Select>
            </>
          )}
          {(deductionForm.Reason !== 'damage' || deductionForm.DamageCostType === 'manual') && (
            <Input label="المبلغ" type="number" value={deductionForm.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeductionForm({ ...deductionForm, Amount: e.target.value })} />
          )}
          <Input label="تاريخ الخصم" type="date" value={deductionForm.DeductionDate}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeductionForm({ ...deductionForm, DeductionDate: e.target.value })}
            hint="قابل للتعديل - يُقيَّد الخصم في سنته المالية" />
        </div>
      </Modal>

      {/* Commission Immediate Pay Modal */}
      <Modal isOpen={showCommPayModal} onClose={() => setShowCommPayModal(false)} title={`صرف عمولة فوري - ${selectedCommission?.EmployeeName || ''}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowCommPayModal(false)}>إلغاء</Button><Button onClick={handleCommPay}>صرف</Button></>}
      >
        {selectedCommission && (
          <div className="space-y-4">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">مبلغ العمولة:</span><span className="font-bold text-green-600">{selectedCommission.Amount?.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">النوع:</span><span>{selectedCommission.CommissionType === 'maintenance' ? 'عمولة صيانة' : 'عمولة مبيعات'}</span></div>
            </div>
            <Input label="تاريخ الصرف" type="date" value={commPayForm.Date}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCommPayForm({ ...commPayForm, Date: e.target.value })}
              hint="قابل للتعديل - يُقيَّد الصرف في سنته المالية" />
            <Select label="الخزنة" value={commPayForm.CashAccountID} onChange={(e) => setCommPayForm({ ...commPayForm, CashAccountID: e.target.value })}>
              <option value="">— اختر —</option>
              {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
            </Select>
          </div>
        )}
      </Modal>
    </div>
  );
}
