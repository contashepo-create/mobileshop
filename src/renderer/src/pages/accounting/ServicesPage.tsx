import { useState, useEffect } from 'react';
import { Plus, Trash2, Printer, Pencil, Undo2, CornerUpLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';
import { localToday } from '../../lib/businessDay';

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

const typeLabels: Record<string, string> = {
  balance_transfer: 'تحويل رصيد', bill_payment: 'دفع فاتورة',
  topup: 'شحن رصيد', electronic_payment: 'مدفوعات إلكترونية',
};

const emptyForm = {
  CustomerID: '', CustomerName: '', CustomerPhone: '',
  ServiceType: 'balance_transfer', ServiceTypeLabel: '',
  Provider: 'vodafone', ProviderLabel: '',
  TargetPhone: '',
  PaidToProvider: '',      // المدفوع للمزوّد (يخرج من أصل التمويل)
  ChargeAmount: '',        // المحصَّل من العميل (يصل إلى أصل الاستلام)
  PaidAmount: '',          // المدفوع من العميل الآن
  CashAccountID: '',       // أصل تحويل الرصيد (خزنة)
  PaymentMethodID: '',     // أصل تحويل الرصيد (ماكينة/محفظة)
  ReceiveAccountType: '', ReceiveAccountID: '',   // أصل استلام المبلغ من العميل
  ServiceDate: localToday(), Notes: '',
};

export function ServicesPage() {
  const { showToast } = useToastStore();
  const [services, setServices] = useState<any[]>([]);
  const [returns, setReturns] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [returning, setReturning] = useState<any>(null);
  const [returnReason, setReturnReason] = useState('');
  const [returnDate, setReturnDate] = useState(localToday());

  const [form, setForm] = useState({ ...emptyForm });

  const fetchData = async () => {
    const [s, r, cu, ca, pm] = await Promise.all([
      window.api.invoke('serviceSales:list'),
      window.api.invoke('serviceReturns:list'),
      window.api.invoke('customers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setServices(s); setReturns(r); setCustomers(cu); setCashAccounts(ca); setPaymentMethods(pm);
  };

  useEffect(() => { fetchData(); }, []);

  const isWalkIn = !form.CustomerID;

  const paidTo = parseFloat(form.PaidToProvider) || 0;
  const charge = parseFloat(form.ChargeAmount) || 0;
  const paid = isWalkIn ? charge : (parseFloat(form.PaidAmount) || 0);
  const remaining = charge - paid;
  const profit = charge - paidTo;

  const setPaidTo = (v: string) => setForm((f) => ({ ...f, PaidToProvider: v }));

  const setCharge = (v: string) => {
    setForm((f) => ({
      ...f,
      ChargeAmount: v,
      PaidAmount: !f.CustomerID && v !== '' ? v : f.PaidAmount,
    }));
  };

  const handleSave = async () => {
    if (paidTo <= 0) {
      showToast('error', 'أدخل المبلغ المدفوع للمزوّد');
      return;
    }
    if (charge <= 0) {
      showToast('error', 'أدخل المبلغ المحصَّل من العميل');
      return;
    }
    if (!form.TargetPhone) { showToast('error', 'أدخل رقم الوجهة'); return; }
    if (paid > charge) { showToast('error', 'المدفوع من العميل لا يتجاوز المحصَّل'); return; }
    if (isWalkIn && paid !== charge) { showToast('error', 'العميل النقدي يدفع كامل المبلغ فوراً — المدفوع يساوي المحصَّل'); return; }
    if (paid > 0 && !form.ReceiveAccountType) { showToast('error', 'اختر أصل استلام المبلغ من العميل (خزنة أو ماكينة)'); return; }
    if ((paidTo) > 0 && !form.CashAccountID && !form.PaymentMethodID) {
      showToast('error', 'اختر أصل تحويل الرصيد (الخزنة أو الماكينة التي يُدفع منها المزوّد)');
      return;
    }

    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    const customer = customers.find(c => c.CustomerID === parseInt(form.CustomerID));
    const providerLabel = form.Provider === 'other' ? (form.ProviderLabel || 'مزوّد آخر') : (providers.find(p => p.value === form.Provider)?.label || form.Provider);
    const typeLabel = form.ServiceType === 'other' ? (form.ServiceTypeLabel || 'خدمة أخرى') : (serviceTypes.find(t => t.value === form.ServiceType)?.label || form.ServiceType);

    const payload = {
      CustomerID: form.CustomerID ? parseInt(form.CustomerID) : undefined,
      CustomerName: customer?.Name || form.CustomerName || undefined,
      CustomerPhone: customer?.Phone || form.CustomerPhone || undefined,
      ServiceType: form.ServiceType === 'other' ? typeLabel : form.ServiceType,
      Provider: form.Provider === 'other' ? providerLabel : form.Provider,
      TargetPhone: form.TargetPhone,
      Date: form.ServiceDate,
      PaidToProvider: paidTo,
      ChargeAmount: charge,
      PaidAmount: paid,
      PaymentMethod: paid > 0 ? 'cash' : 'credit',
      CashAccountID: form.CashAccountID ? parseInt(form.CashAccountID) : undefined,
      PaymentMethodID: form.PaymentMethodID ? parseInt(form.PaymentMethodID) : undefined,
      ReceiveAccountType: form.ReceiveAccountType || undefined,
      ReceiveAccountID: form.ReceiveAccountID ? parseInt(form.ReceiveAccountID) : undefined,
      Notes: form.Notes,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    };

    try {
      const result = editingId
        ? await window.api.invoke('serviceSales:update', { id: editingId, ...payload })
        : await window.api.invoke('serviceSales:create', payload);

      if (result.success) {
        let msg = editingId ? `تم تعديل العملية` : `تم تسجيل العملية - رقم: ${result.serviceNumber}`;
        msg += ` | الربح: ${result.profit.toFixed(2)}`;
        if (result.remaining > 0) msg += ` | المتبقي على العميل: ${result.remaining.toFixed(2)}`;
        showToast('success', msg);
        setShowModal(false);
        setEditingId(null);
        setForm({ ...emptyForm });
        fetchData();
      } else {
        showToast('error', result.message || 'فشل');
      }
    } catch (err: any) {
      showToast('error', `خطأ: ${err.message || err}`);
    }
  };

  const closeModal = () => {
    setShowModal(false); setEditingId(null); setForm({ ...emptyForm });
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm });
    setShowModal(true);
  };

  const openEdit = async (row: any) => {
    const detail = await window.api.invoke('serviceSales:get', row.ServiceSaleID);
    if (!detail) { showToast('error', 'تعذّر قراءة العملية'); return; }
    setEditingId(detail.ServiceSaleID);
    setForm({
      CustomerID: detail.CustomerID ? String(detail.CustomerID) : '',
      CustomerName: detail.CustomerName || '',
      CustomerPhone: detail.CustomerPhone || '',
      ServiceType: detail.ServiceType,
      ServiceTypeLabel: '',
      Provider: detail.Provider,
      ProviderLabel: '',
      TargetPhone: detail.TargetPhone || '',
      PaidToProvider: String((detail.Amount || 0) + (detail.ServiceCost || 0) + (detail.TransferCost || 0)),
      ChargeAmount: detail.ChargeAmount != null ? String(detail.ChargeAmount) : '',
      PaidAmount: detail.PaidAmount != null ? String(detail.PaidAmount) : '',
      CashAccountID: detail.CashAccountID ? String(detail.CashAccountID) : '',
      PaymentMethodID: detail.PaymentMethodID ? String(detail.PaymentMethodID) : '',
      ReceiveAccountType: detail.ReceiveAccountType || '',
      ReceiveAccountID: detail.ReceiveAccountID ? String(detail.ReceiveAccountID) : '',
      ServiceDate: detail.Date || localToday(),
      Notes: detail.Notes || '',
    });
    setShowModal(true);
  };

  const doReturn = async () => {
    if (!returning) return;
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    const result = await window.api.invoke('serviceSales:return', {
      id: returning.ServiceSaleID,
      Reason: returnReason,
      Date: returnDate,
      userId: currentUserId(),
      fiscalYearId: activeFy?.FiscalYearID,
    });
    if (result.success) {
      showToast('success', result.message);
      setReturning(null); setReturnReason(''); setReturnDate(localToday());
      fetchData();
    } else {
      showToast('error', result.message || 'فشل');
    }
  };

  const undoReturn = async (row: any) => {
    const ret = returns.find((r: any) => r.ServiceSaleID === row.ServiceSaleID);
    if (!ret) return;
    if (!confirm('سيتم إلغاء المرتجع وإعادة العملية لحالتها. متابعة؟')) return;
    const res = await window.api.invoke('delete:serviceReturn', ret.ReturnID);
    if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); }
  };

  const printService = async (row: any) => {
    const settings = await window.api.invoke('settings:getAll');
    const template = settings.default_invoice_template || '1';
    const paperSize = settings.paper_size || '80mm';
    const defaultAction = settings.print_default_action || 'preview';
    const invoiceData = {
      serviceNumber: row.ServiceNumber,
      date: row.Date,
      serviceType: typeLabels[row.ServiceType] || row.ServiceType,
      provider: row.Provider,
      targetPhone: row.TargetPhone,
      customerName: row.CustomerName,
      customerPhone: row.CustomerPhone,
      amount: row.Amount,
      chargeAmount: row.ChargeAmount,
      paidAmount: row.PaidAmount,
      remainingAmount: row.RemainingAmount,
      returned: row.Status === 'returned',
      reason: '',
    };
    const printData = { type: 'service', paperSize, template, companyInfo: settings, invoiceData };
    await window.api.invoke(defaultAction === 'print' ? 'print:invoice' : 'print:preview', printData);
  };

  const actionBtn = 'p-1.5 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">خدمات التحويل والشحن</h1>
        <Button onClick={openCreate} icon={<Plus size={16} />}>عملية جديدة</Button>
      </div>

      <DataTable
        columns={[
          { key: 'ServiceNumber', title: 'رقم العملية', render: (r) => <span className="font-mono text-xs">{r.ServiceNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'CustomerName', title: 'العميل', render: (r) => r.CustomerName || '—' },
          { key: 'ServiceType', title: 'النوع', render: (r) => <Badge variant="blue">{typeLabels[r.ServiceType] || r.ServiceType}</Badge> },
          { key: 'TargetPhone', title: 'رقم الوجهة' },
          { key: 'PaidToProvider', title: 'المدفوع للمزوّد', render: (r) => <span className="font-bold text-green-600">{(r.Amount + r.ServiceCost + r.TransferCost)?.toFixed(2)}</span> },
          { key: 'ChargeAmount', title: 'المحصَّل', render: (r) => <span className="font-bold text-blue-600">{r.ChargeAmount?.toFixed(2)}</span> },
          { key: 'PaidAmount', title: 'المدفوع', render: (r) => <span>{r.PaidAmount?.toFixed(2)}</span> },
          { key: 'Profit', title: 'الربح', render: (r) => <span className={`font-bold ${r.Profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{r.Profit?.toFixed(2)}</span> },
          {
            key: 'Status', title: 'الحالة',
            render: (r) => <Badge variant={r.Status === 'completed' ? 'green' : r.Status === 'returned' ? 'red' : r.Status === 'partial' ? 'yellow' : 'red'}>{r.Status === 'completed' ? 'مكتملة' : r.Status === 'returned' ? 'مرتجعة' : r.Status === 'partial' ? 'جزئية' : 'آجلة'}</Badge>,
          },
          {
            key: 'actions', title: '',
            render: (r) => (
              <div className="flex items-center gap-1">
                <button onClick={() => printService(r)} className={actionBtn} title="طباعة إيصال"><Printer size={14} /></button>
                {r.Status !== 'returned' && (
                  <>
                    <button onClick={() => openEdit(r)} className={`${actionBtn} hover:text-blue-600`} title="تعديل"><Pencil size={14} /></button>
                    <button onClick={() => { setReturning(r); setReturnReason(''); setReturnDate(localToday()); }} className={`${actionBtn} hover:text-amber-600`} title="مرتجع (إلغاء العملية وردّ المبالغ)"><CornerUpLeft size={14} /></button>
                  </>
                )}
                {r.Status === 'returned' && (
                  <button onClick={() => undoReturn(r)} className={`${actionBtn} hover:text-purple-600`} title="إلغاء المرتجع"><Undo2 size={14} /></button>
                )}
                <button
                  onClick={async () => {
                    if (!confirm('سيتم حذف العملية وعكس كل التأثيرات. متابعة؟')) return;
                    const res = await window.api.invoke('delete:serviceSale', r.ServiceSaleID);
                    if (res.success) { showToast('success', res.message); fetchData(); } else { showToast('error', res.message); }
                  }}
                  className={`${actionBtn} hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20`} title="حذف"
                ><Trash2 size={14} /></button>
              </div>
            ),
          },
        ]}
        data={services}
        keyField="ServiceSaleID"
        emptyMessage="لا توجد عمليات"
      />

      <Modal isOpen={showModal} onClose={closeModal} title={editingId ? 'تعديل عملية' : 'عملية تحويل/شحن/خدمة'} size="lg"
        footer={<><Button variant="secondary" onClick={closeModal}>إلغاء</Button><Button onClick={handleSave}>{editingId ? 'حفظ التعديل' : 'تسجيل'}</Button></>}
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

          {/* Customer */}
          <div className="grid grid-cols-2 gap-4">
            <Select label="العميل (اختياري)" value={form.CustomerID} onChange={(e) => setForm({ ...form, CustomerID: e.target.value, PaidAmount: e.target.value === '' ? form.ChargeAmount : form.PaidAmount })}>
              <option value="">— عميل نقدي —</option>
              {customers.map((c: any) => <option key={c.CustomerID} value={c.CustomerID}>{c.Name} ({c.Phone || '—'}) - رصيد: {c.Balance?.toFixed(2)}</option>)}
            </Select>
            {isWalkIn ? (
              <div className="grid grid-cols-2 gap-2">
                <Input label="الاسم" value={form.CustomerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, CustomerName: e.target.value })} />
                <Input label="الهاتف" value={form.CustomerPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, CustomerPhone: e.target.value })} />
              </div>
            ) : <div className="text-sm text-slate-500 dark:text-slate-400 self-end pb-1">سيُسجَّل المتبقي على رصيد العميل إن دفع جزئياً</div>}
          </div>

          {/* Target & the two money fields */}
          <div className="grid grid-cols-3 gap-4">
            <Input label="رقم الوجهة" value={form.TargetPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, TargetPhone: e.target.value })} placeholder="01xxxxxxxxx" />
            <Input label="المدفوع للمزوّد" type="number" value={form.PaidToProvider} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPaidTo(e.target.value)} hint="يخرج من أصل التمويل (الخزنة/الماكينة)" />
            <Input label="المحصَّل من العميل" type="number" value={form.ChargeAmount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCharge(e.target.value)} hint="يصل إلى أصل الاستلام من العميل" />
          </div>

          <Input
            label="المدفوع من العميل"
            type="number"
            value={form.PaidAmount}
            disabled={isWalkIn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, PaidAmount: e.target.value })}
            hint={isWalkIn ? 'العميل النقدي يدفع المحصَّل تلقائياً' : 'المتبقي يُسجَّل على رصيد العميل'}
          />

          {/* Live calculation */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg p-2 text-center bg-slate-50 dark:bg-slate-700/30">
              <div className="text-xs text-slate-500 dark:text-slate-400">المدفوع للمزوّد</div>
              <div className="text-lg font-bold text-slate-700 dark:text-white">{paidTo.toFixed(2)}</div>
            </div>
            <div className="rounded-lg p-2 text-center bg-blue-50 dark:bg-blue-900/20">
              <div className="text-xs text-slate-500 dark:text-slate-400">ربح العملية</div>
              <div className={`text-lg font-bold ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{profit.toFixed(2)}</div>
            </div>
            <div className="rounded-lg p-2 text-center bg-green-50 dark:bg-green-900/20">
              <div className="text-xs text-slate-500 dark:text-slate-400">إجمالي المحصَّل</div>
              <div className="text-lg font-bold text-blue-600">{charge.toFixed(2)}</div>
            </div>
            <div className={`rounded-lg p-2 text-center ${remaining > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-slate-50 dark:bg-slate-700/30'}`}>
              <div className="text-xs text-slate-500 dark:text-slate-400">{isWalkIn ? 'العميل النقدي' : remaining > 0 ? 'متبقي على العميل' : 'سُدّد بالكامل'}</div>
              <div className={`text-lg font-bold ${remaining > 0 ? 'text-red-600' : 'text-slate-700 dark:text-white'}`}>{remaining > 0 ? remaining.toFixed(2) : '—'}</div>
            </div>
          </div>

          {/* The two assets — receiving vs funding, clearly separate */}
          {paid > 0 && (
            <div className="rounded-lg border border-green-200 dark:border-green-800 p-3 space-y-2">
              <div className="text-xs font-bold text-green-700 dark:text-green-400">أصل استلام المبلغ من العميل — يصل إليه المدفوع ({paid.toFixed(2)})</div>
              <div className="grid grid-cols-2 gap-4">
                <Select label="خزنة استلام" value={form.ReceiveAccountType === 'cash_account' ? form.ReceiveAccountID : ''} onChange={(e) => setForm({ ...form, ReceiveAccountType: 'cash_account', ReceiveAccountID: e.target.value })}>
                  <option value="">— اختر —</option>
                  {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
                </Select>
                <Select label="ماكينة/محفظة استلام" value={form.ReceiveAccountType === 'payment_method' ? form.ReceiveAccountID : ''} onChange={(e) => setForm({ ...form, ReceiveAccountType: 'payment_method', ReceiveAccountID: e.target.value })}>
                  <option value="">— اختر —</option>
                  {paymentMethods.map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
                </Select>
              </div>
            </div>
          )}

          {(paidTo > 0) && (
            <div className="rounded-lg border border-orange-200 dark:border-orange-800 p-3 space-y-2">
              <div className="text-xs font-bold text-orange-700 dark:text-orange-400">أصل تحويل الرصيد — يُدفع منه للمزوّد ({paidTo.toFixed(2)})</div>
              <div className="grid grid-cols-2 gap-4">
                <Select label="خزنة التحويل" value={form.CashAccountID} onChange={(e) => setForm({ ...form, CashAccountID: e.target.value })}>
                  <option value="">— اختر —</option>
                  {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
                </Select>
                <Select label="ماكينة/محفظة التحويل" value={form.PaymentMethodID} onChange={(e) => setForm({ ...form, PaymentMethodID: e.target.value })}>
                  <option value="">— اختر —</option>
                  {paymentMethods.map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
                </Select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input label="تاريخ العملية" type="date" value={form.ServiceDate}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ServiceDate: e.target.value })}
              hint="قابل للتعديل - تُقيَّد العملية في سنتها المالية" />
            <Textarea label="ملاحظات" value={form.Notes} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, Notes: e.target.value })} rows={2} />
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!returning} onClose={() => setReturning(null)} title={`مرتجع عملية ${returning?.ServiceNumber || ''}`} size="md"
        footer={<><Button variant="secondary" onClick={() => setReturning(null)}>إلغاء</Button><Button variant="danger" onClick={doReturn} icon={<CornerUpLeft size={14} />}>تأكيد الإرجاع الكامل</Button></>}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            سيُردّ المبلغ المدفوع للعميل ({Number(returning?.PaidAmount || 0).toFixed(2)}) من أصل الاستلام،
            ويُرجع المزوّد المبلغ المدفوع إليه إلى أصل التمويل، ويُلغى متبقي العميل إن وُجد.
            تعود العملية إلى الحالة المكتملة إذا حُذف المرتجع لاحقاً.
          </p>
          <Input label="تاريخ المرتجع" type="date" value={returnDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReturnDate(e.target.value)} />
          <Textarea label="سبب الإرجاع" value={returnReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReturnReason(e.target.value)} rows={2} />
        </div>
      </Modal>
    </div>
  );
}
