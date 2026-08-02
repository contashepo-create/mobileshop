import { useState, useEffect } from 'react';
import { Plus, DollarSign, FileText, CheckCircle, Clock, Eye, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';

export function PayrollPage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<'salaries' | 'advances' | 'deductions'>('salaries');
  const [salaries, setSalaries] = useState<any[]>([]);
  const [advances, setAdvances] = useState<any[]>([]);
  const [deductions, setDeductions] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);

  const [showIssueModal, setShowIssueModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [showDeductionModal, setShowDeductionModal] = useState(false);
  const [selectedSalary, setSelectedSalary] = useState<any>(null);
  const [salaryDetails, setSalaryDetails] = useState<any>(null);

  const [issueForm, setIssueForm] = useState({ EmployeeID: '', Month: new Date().toISOString().substring(0, 7) });
  const [payForm, setPayForm] = useState({ PaidAmount: '', CashAccountID: '' });
  const [advanceForm, setAdvanceForm] = useState({ EmployeeID: '', Amount: '', Reason: '', CashAccountID: '' });
  const [deductionForm, setDeductionForm] = useState({ EmployeeID: '', Amount: '', Reason: 'absence', DamagedItemID: '', DamageCostType: 'cost', Notes: '' });

  const fetchData = async () => {
    const [s, a, d, em, ca, it] = await Promise.all([
      window.api.invoke('salaries:list'),
      window.api.invoke('advances:list'),
      window.api.invoke('deductions:list'),
      window.api.invoke('employees:list', { isActive: 1 }),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('items:list', { isActive: 1 }),
    ]);
    setSalaries(s); setAdvances(a); setDeductions(d); setEmployees(em); setCashAccounts(ca); setItems(it);
  };

  useEffect(() => { fetchData(); }, []);

  const handleIssue = async () => {
    if (!issueForm.EmployeeID) { showToast('error', 'اختر موظفاً'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const result = await window.api.invoke('salaries:issue', {
      EmployeeID: parseInt(issueForm.EmployeeID),
      Month: issueForm.Month,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (result.success) {
      const d = result.details;
      showToast('success',
        `تم إصدار الراتب - الأساسي: ${d.baseSalary.toFixed(2)} + بدلات: ${d.allowances.toFixed(2)} + عمولات: ${d.commissions.toFixed(2)} - خصومات: ${d.deductions.toFixed(2)} - سلف: ${d.advances.toFixed(2)} = الصافي: ${d.netSalary.toFixed(2)}`
      );
      setShowIssueModal(false);
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
      userId: currentUserId(),
    });
    if (result.success) {
      showToast('success', `تم صرف الراتب - المدفوع: ${result.paidAmount.toFixed(2)} / الصافي: ${result.netSalary.toFixed(2)} - ${result.status === 'paid' ? 'مدفوع بالكامل' : 'دفع جزئي'}`);
      setShowPayModal(false);
      setPayForm({ PaidAmount: '', CashAccountID: '' });
      setSelectedSalary(null);
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const openPayModal = (salary: any) => {
    setSelectedSalary(salary);
    setPayForm({ PaidAmount: salary.NetSalary.toString(), CashAccountID: '' });
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
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم صرف السلفية');
    setShowAdvanceModal(false);
    setAdvanceForm({ EmployeeID: '', Amount: '', Reason: '', CashAccountID: '' });
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
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });
    if (result.success) {
      showToast('success', `تم تسجيل الخصم - المبلغ: ${result.amount?.toFixed(2)}`);
      setShowDeductionModal(false);
      setDeductionForm({ EmployeeID: '', Amount: '', Reason: 'absence', DamagedItemID: '', DamageCostType: 'cost', Notes: '' });
      fetchData();
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
              { key: 'Amount', title: 'المبلغ', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.Amount?.toFixed(2)}</span> },
              { key: 'Reason', title: 'السبب', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Reason || '—'}</span> },
              { key: 'IsDeducted', title: 'مخصومة', render: (r) => <Badge variant={r.IsDeducted ? 'green' : 'yellow'}>{r.IsDeducted ? 'نعم' : 'لا'}</Badge> },
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

      {/* Issue Salary Modal */}
      <Modal isOpen={showIssueModal} onClose={() => setShowIssueModal(false)} title="إصدار راتب" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowIssueModal(false)}>إلغاء</Button><Button onClick={handleIssue}>إصدار</Button></>}
      >
        <div className="space-y-4">
          <Select label="الموظف" value={issueForm.EmployeeID} onChange={(e) => setIssueForm({ ...issueForm, EmployeeID: e.target.value })}>
            <option value="">— اختر —</option>
            {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name} (راتب: {emp.BaseSalary?.toFixed(2)})</option>)}
          </Select>
          <Input label="الشهر" type="month" value={issueForm.Month} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIssueForm({ ...issueForm, Month: e.target.value })} />
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
            سيتم حساب: الراتب الأساسي + البدلات + العمولات غير المدفوعة − الخصومات غير المخصومة − السلف غير المخصومة = صافي الراتب
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
        </div>
      </Modal>
    </div>
  );
}
