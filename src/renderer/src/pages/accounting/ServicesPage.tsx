import { useState, useEffect } from 'react';
import { Plus, Smartphone, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

const serviceTypes = [
  { value: 'balance_transfer', label: 'تحويل رصيد' },
  { value: 'bill_payment', label: 'دفع فاتورة' },
  { value: 'topup', label: 'شحن رصيد' },
  { value: 'electronic_payment', label: 'مدفوعات إلكترونية' },
  { value: 'other', label: 'خدمة أخرى (مخصصة)' },
];

const providers = [
  { value: 'vodafone', label: 'فودافون كاش' },
  { value: 'orange', label: 'أورانج موني' },
  { value: 'etisalat', label: 'اتصالات كاش' },
  { value: 'instapay', label: 'إنستا باي' },
  { value: 'fawry', label: 'فوري' },
  { value: 'other', label: 'مزوّد آخر (مخصص)' },
];

export function ServicesPage() {
  const { showToast } = useToastStore();
  const [services, setServices] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);

  const [form, setForm] = useState({
    CustomerID: '', CustomerName: '', CustomerPhone: '',
    ServiceType: 'balance_transfer', ServiceTypeLabel: '',
    Provider: 'vodafone', ProviderLabel: '',
    TargetPhone: '',
    Amount: '', ServiceCost: '', ChargeAmount: '',
    PaidAmount: '', CashAccountID: '', PaymentMethodID: '',
    TransferCost: '', Notes: '',
  });

  const fetchData = async () => {
    const [s, cu, ca, pm] = await Promise.all([
      window.api.invoke('serviceSales:list'),
      window.api.invoke('customers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setServices(s); setCustomers(cu); setCashAccounts(ca); setPaymentMethods(pm);
  };

  useEffect(() => { fetchData(); }, []);

  const amount = parseFloat(form.Amount) || 0;
  const serviceCost = parseFloat(form.ServiceCost) || 0;
  const transferCost = parseFloat(form.TransferCost) || 0;
  const autoCharge = amount + serviceCost;
  const paid = parseFloat(form.PaidAmount) || 0;
  const remaining = (parseFloat(form.ChargeAmount) || autoCharge) - paid;
  const profit = (parseFloat(form.ChargeAmount) || autoCharge) - amount - serviceCost - transferCost;

  const handleSave = async () => {
    if (!form.Amount || amount <= 0) { showToast('error', 'أدخل المبلغ'); return; }
    if (!form.TargetPhone) { showToast('error', 'أدخل رقم الوجهة'); return; }
    if (paid > 0 && !form.CashAccountID && !form.PaymentMethodID) {
      showToast('error', 'اختر مصدر استلام المبلغ'); return;
    }

    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    const customer = customers.find(c => c.CustomerID === parseInt(form.CustomerID));
    const charge = parseFloat(form.ChargeAmount) || autoCharge;

    // Determine provider label
    const providerLabel = form.Provider === 'other' ? (form.ProviderLabel || 'مزوّد آخر') : (providers.find(p => p.value === form.Provider)?.label || form.Provider);

    try {
      const result = await window.api.invoke('serviceSales:create', {
        CustomerID: form.CustomerID ? parseInt(form.CustomerID) : undefined,
        CustomerName: customer?.Name || form.CustomerName || undefined,
        CustomerPhone: customer?.Phone || form.CustomerPhone || undefined,
        ServiceType: form.ServiceType,
        Provider: form.Provider === 'other' ? providerLabel : form.Provider,
        TargetPhone: form.TargetPhone,
        Amount: amount,
        ServiceCost: serviceCost,
        ChargeAmount: charge,
        PaidAmount: paid,
        PaymentMethod: paid > 0 ? 'cash' : 'credit',
        CashAccountID: form.CashAccountID ? parseInt(form.CashAccountID) : undefined,
        PaymentMethodID: form.PaymentMethodID ? parseInt(form.PaymentMethodID) : undefined,
        TransferCost: transferCost,
        Notes: form.Notes,
        userId: currentUserId(),
        fiscalYearId: activeFy.FiscalYearID,
      });

      if (result.success) {
        let msg = `تم تسجيل العملية - رقم: ${result.serviceNumber}`;
        msg += ` | الربح: ${result.profit.toFixed(2)}`;
        if (result.remaining > 0) msg += ` | المتبقي على العميل: ${result.remaining.toFixed(2)}`;
        showToast('success', msg);
        setShowModal(false);
        resetForm();
        fetchData();
      } else {
        showToast('error', result.message || 'فشل');
      }
    } catch (err: any) {
      showToast('error', `خطأ: ${err.message || err}`);
    }
  };

  const resetForm = () => {
    setForm({ CustomerID: '', CustomerName: '', CustomerPhone: '', ServiceType: 'balance_transfer', ServiceTypeLabel: '', Provider: 'vodafone', ProviderLabel: '', TargetPhone: '', Amount: '', ServiceCost: '', ChargeAmount: '', PaidAmount: '', CashAccountID: '', PaymentMethodID: '', TransferCost: '', Notes: '' });
  };

  const typeLabels: Record<string, string> = {
    balance_transfer: 'تحويل رصيد', bill_payment: 'دفع فاتورة',
    topup: 'شحن رصيد', electronic_payment: 'مدفوعات إلكترونية',
  };

  const getTypeLabel = (type: string) => typeLabels[type] || type;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">خدمات التحويل والشحن</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>عملية جديدة</Button>
      </div>

      <DataTable
        columns={[
          { key: 'ServiceNumber', title: 'رقم العملية', render: (r) => <span className="font-mono text-xs">{r.ServiceNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'ServiceType', title: 'النوع', render: (r) => <Badge variant="blue">{getTypeLabel(r.ServiceType)}</Badge> },
          { key: 'Provider', title: 'المزوّد', render: (r) => r.Provider || '—' },
          { key: 'TargetPhone', title: 'رقم الوجهة' },
          { key: 'Amount', title: 'المبلغ المحوّل', render: (r) => <span className="font-bold text-orange-600">{r.Amount?.toFixed(2)}</span> },
          { key: 'ChargeAmount', title: 'المحصّل', render: (r) => <span className="font-bold text-green-600">{r.ChargeAmount?.toFixed(2)}</span> },
          { key: 'Profit', title: 'الربح', render: (r) => <span className={`font-bold ${r.Profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{r.Profit?.toFixed(2)}</span> },
          { key: 'Status', title: 'الحالة', render: (r) => <Badge variant={r.Status === 'completed' ? 'green' : r.Status === 'partial' ? 'yellow' : 'red'}>{r.Status === 'completed' ? 'مكتملة' : r.Status === 'partial' ? 'جزئية' : 'آجلة'}</Badge> },
          { key: 'delete', title: '', render: (r) => <button onClick={async () => { if (confirm('سيتم حذف العملية وعكس كل التأثيرات. متابعة؟')) { const res = await window.api.invoke('delete:serviceSale', r.ServiceSaleID); if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
        ]}
        data={services}
        keyField="ServiceSaleID"
        emptyMessage="لا توجد عمليات"
      />

      <Modal isOpen={showModal} onClose={() => { setShowModal(false); resetForm(); }} title="عملية تحويل/شحن/خدمة" size="lg"
        footer={<><Button variant="secondary" onClick={() => { setShowModal(false); resetForm(); }}>إلغاء</Button><Button onClick={handleSave}>تسجيل</Button></>}
      >
        <div className="space-y-4">
          {/* Service type & provider */}
          <div className="grid grid-cols-2 gap-4">
            <Select label="نوع الخدمة" value={form.ServiceType} onChange={(e) => setForm({ ...form, ServiceType: e.target.value })}>
              {serviceTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            {form.ServiceType === 'other' && (
              <Input label="اسم الخدمة المخصصة" value={form.ServiceTypeLabel} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ServiceTypeLabel: e.target.value })} placeholder="مثال: تصوير مستندات، طباعة..." />
            )}
            <Select label="المزوّد" value={form.Provider} onChange={(e) => setForm({ ...form, Provider: e.target.value })}>
              {providers.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
            {form.Provider === 'other' && (
              <Input label="اسم المزوّد المخصص" value={form.ProviderLabel} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ProviderLabel: e.target.value })} placeholder="مثال: بنك مصر، البريد..." />
            )}
          </div>

          {/* Target phone & amounts */}
          <div className="grid grid-cols-3 gap-4">
            <Input label="رقم الوجهة" value={form.TargetPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, TargetPhone: e.target.value })} placeholder="01xxxxxxxxx" />
            <Input label="المبلغ للعميل" type="number" value={form.Amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, Amount: e.target.value })} />
            <Input label="تكلفة الخدمة" type="number" value={form.ServiceCost} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ServiceCost: e.target.value })} hint="عمولة + رسوم" />
          </div>

          {/* Charge amount (auto or manual) */}
          <div className="grid grid-cols-3 gap-4">
            <Input label="المحصّل من العميل" type="number" value={form.ChargeAmount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ChargeAmount: e.target.value })} hint={`تلقائي: ${autoCharge.toFixed(2)}`} />
            <Input label="المدفوع من العميل" type="number" value={form.PaidAmount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PaidAmount: e.target.value })} />
            <Input label="عمولة المزوّد" type="number" value={form.TransferCost} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, TransferCost: e.target.value })} />
          </div>

          {/* Live calculation */}
          <div className="grid grid-cols-3 gap-3">
            <div className={`rounded-lg p-2 text-center ${remaining > 0 ? 'bg-red-50 dark:bg-red-900/20' : remaining < 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-slate-50 dark:bg-slate-700/30'}`}>
              <div className="text-xs text-slate-500 dark:text-slate-400">{remaining > 0 ? 'متبقي على العميل' : remaining < 0 ? 'زيادة للعميل' : 'متساوي'}</div>
              <div className={`text-lg font-bold ${remaining > 0 ? 'text-red-600' : remaining < 0 ? 'text-green-600' : 'text-slate-700 dark:text-white'}`}>{Math.abs(remaining).toFixed(2)}</div>
            </div>
            <div className="rounded-lg p-2 text-center bg-green-50 dark:bg-green-900/20">
              <div className="text-xs text-slate-500 dark:text-slate-400">الربح المتوقع</div>
              <div className={`text-lg font-bold ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{profit.toFixed(2)}</div>
            </div>
            <div className="rounded-lg p-2 text-center bg-blue-50 dark:bg-blue-900/20">
              <div className="text-xs text-slate-500 dark:text-slate-400">إجمالي المحصّل</div>
              <div className="text-lg font-bold text-blue-600">{(parseFloat(form.ChargeAmount) || autoCharge).toFixed(2)}</div>
            </div>
          </div>

          {/* Customer & payment source */}
          <div className="grid grid-cols-2 gap-4">
            <Select label="العميل (اختياري)" value={form.CustomerID} onChange={(e) => setForm({ ...form, CustomerID: e.target.value })}>
              <option value="">— عميل نقدي —</option>
              {customers.map((c: any) => <option key={c.CustomerID} value={c.CustomerID}>{c.Name} ({c.Phone || '—'}) - رصيد: {c.Balance?.toFixed(2)}</option>)}
            </Select>
            {!form.CustomerID && (
              <div className="grid grid-cols-2 gap-2">
                <Input label="الاسم" value={form.CustomerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, CustomerName: e.target.value })} />
                <Input label="الهاتف" value={form.CustomerPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, CustomerPhone: e.target.value })} />
              </div>
            )}
          </div>

          {paid > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <Select label="مصدر استلام المبلغ (خزنة/بنك)" value={form.CashAccountID} onChange={(e) => setForm({ ...form, CashAccountID: e.target.value })}>
                <option value="">— اختر —</option>
                {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
              </Select>
              <Select label="ماكينة/محفظة الإرسال" value={form.PaymentMethodID} onChange={(e) => setForm({ ...form, PaymentMethodID: e.target.value })}>
                <option value="">— اختر —</option>
                {paymentMethods.map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
              </Select>
            </div>
          )}

          <Textarea label="ملاحظات" value={form.Notes} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, Notes: e.target.value })} rows={2} />
        </div>
      </Modal>
    </div>
  );
}
