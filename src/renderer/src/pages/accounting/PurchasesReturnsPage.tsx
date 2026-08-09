import { useState, useEffect } from 'react';
import { Plus, Undo2, RotateCcw, Search } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

/**
 * Standalone purchase-returns page.
 *
 * Pick a purchase invoice, see its returnable lines, choose quantities, and
 * settle the refund (on account / cash / transfer). Uses the same
 * `purchaseReturns:create` handler as the old tab did.
 */
export function PurchasesReturnsPage() {
  const { showToast } = useToastStore();
  const [returns, setReturns] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showInvoicePicker, setShowInvoicePicker] = useState(false);
  const [returnPurchase, setReturnPurchase] = useState<any>(null);
  const [returnLines, setReturnLines] = useState<any[]>([]);
  const [returnReason, setReturnReason] = useState('');
  const [returnCashAccountId, setReturnCashAccountId] = useState('');
  const [retAccountCredit, setRetAccountCredit] = useState('');
  const [retCashRefund, setRetCashRefund] = useState('');
  const [retTransferRefund, setRetTransferRefund] = useState('');
  const [retPaymentMethodId, setRetPaymentMethodId] = useState('');
  const [retTransferCost, setRetTransferCost] = useState('');
  const [retFeeBearer, setRetFeeBearer] = useState<'shop' | 'party'>('shop');
  const [invoiceSearch, setInvoiceSearch] = useState('');

  const fetchData = async () => {
    const [rt, p, su, ca, pm] = await Promise.all([
      window.api.invoke('purchaseReturns:list'),
      window.api.invoke('purchases:list'),
      window.api.invoke('suppliers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setReturns(rt || []);
    setPurchases(p || []);
    setSuppliers(su || []);
    setCashAccounts(ca || []);
    setPaymentMethods(pm || []);
  };

  useEffect(() => { fetchData(); }, []);

  const filteredPurchases = invoiceSearch
    ? purchases.filter(p =>
        (p.PurchaseNumber || '').includes(invoiceSearch) ||
        (p.SupplierName || '').includes(invoiceSearch))
    : purchases;

  const startReturnFromInvoice = async (purchase: any) => {
    const lines = await window.api.invoke('purchaseReturns:returnable', purchase.PurchaseID);
    if (!Array.isArray(lines) || lines.length === 0) {
      showToast('error', 'لا توجد بنود قابلة للإرجاع'); return;
    }
    const open = lines.filter((l: any) => l.Returnable > 0);
    if (open.length === 0) {
      showToast('error', 'لا يمكن إرجاع أي بند: إما تم إرجاعه أو لم يعد موجوداً بالمخزن');
      return;
    }
    setReturnPurchase(purchase);
    setReturnLines(open.map((l: any) => ({ ...l, ReturnQty: 0 })));
    setReturnReason('');
    setReturnCashAccountId('');
    setRetAccountCredit(''); setRetCashRefund(''); setRetTransferRefund('');
    setRetPaymentMethodId(''); setRetTransferCost(''); setRetFeeBearer('shop');
    setShowInvoicePicker(false);
    setShowReturnModal(true);
  };

  const returnTotal = Math.round(returnLines.reduce(
    (sum, l) => sum + (Number(l.ReturnQty) || 0) * (l.UnitCost || 0), 0) * 100) / 100;

  const retAllocated = Math.round(
    ((parseFloat(retAccountCredit) || 0) + (parseFloat(retCashRefund) || 0)
      + (parseFloat(retTransferRefund) || 0)) * 100) / 100;
  const retUnallocated = Math.round((returnTotal - retAllocated) * 100) / 100;

  useEffect(() => {
    if (!showReturnModal || returnTotal <= 0) return;
    const outstanding = Math.max(0, returnPurchase?.RemainingAmount || 0);
    const credit = Math.min(returnTotal, outstanding);
    setRetAccountCredit(credit.toFixed(2));
    setRetCashRefund((returnTotal - credit).toFixed(2));
    setRetTransferRefund('0');
  }, [returnTotal, showReturnModal]);

  const submitReturn = async () => {
    const picked = returnLines.filter(l => (Number(l.ReturnQty) || 0) > 0);
    if (picked.length === 0) { showToast('error', 'حدد الكمية المرتجعة'); return; }
    for (const l of picked) {
      if (Number(l.ReturnQty) > l.Returnable) {
        showToast('error', `الكمية المرتجعة من "${l.ItemName}" أكبر من المتاح (${l.Returnable})`);
        return;
      }
    }
    const res = await window.api.invoke('purchaseReturns:create', {
      PurchaseID: returnPurchase.PurchaseID,
      items: picked.map(l => ({
        ItemID: l.ItemID, Quantity: Number(l.ReturnQty),
        UnitCost: l.UnitCost, WarehouseID: l.WarehouseID,
      })),
      Reason: returnReason || undefined,
      AccountCredit: parseFloat(retAccountCredit) || 0,
      CashRefund: parseFloat(retCashRefund) || 0,
      TransferRefund: parseFloat(retTransferRefund) || 0,
      CashAccountID: returnCashAccountId ? parseInt(returnCashAccountId) : undefined,
      PaymentMethodID: retPaymentMethodId ? parseInt(retPaymentMethodId) : undefined,
      TransferCost: parseFloat(retTransferCost) || 0,
      TransferCostBearer: retFeeBearer,
      userId: currentUserId(),
    });
    if (res?.success) {
      showToast('success', `تم إنشاء مرتجع مشتريات رقم ${res.returnNumber}`);
      setShowReturnModal(false);
      setReturnPurchase(null);
      fetchData();
    } else {
      showToast('error', res?.message || 'فشل إنشاء المرتجع');
    }
  };

  const undoReturn = async (returnId: number, number: string) => {
    if (!confirm(`إلغاء المرتجع ${number}؟\n\nستعود البضاعة للمخزن، ويُعاد المبلغ للمورد، ويرجع الدين عليك.`)) return;
    const res = await window.api.invoke('delete:purchaseReturn', returnId);
    if (res?.success) { showToast('success', res.message); fetchData(); }
    else showToast('error', res?.message || 'فشل الإلغاء');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">مرتجعات المشتريات</h1>
        <Button onClick={() => setShowInvoicePicker(true)} icon={<Plus size={16} />}>فاتورة مرتجع جديدة</Button>
      </div>

      <DataTable
        columns={[
          { key: 'ReturnNumber', title: 'رقم المرتجع', render: (r) => <span className="font-mono text-xs">{r.ReturnNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'PurchaseNumber', title: 'فاتورة الشراء', render: (r) => <span className="font-mono text-xs">{r.PurchaseNumber}</span> },
          { key: 'SupplierName', title: 'المورد' },
          { key: 'TotalAmount', title: 'قيمة المرتجع', render: (r) => <span className="font-bold">{r.TotalAmount?.toFixed(2)}</span> },
          { key: 'DebtRelief', title: 'خُصم من دَينك', render: (r) => <span className="text-blue-600">{(r.DebtRelief || 0).toFixed(2)}</span> },
          { key: 'CashRefund', title: 'استرددت نقداً', render: (r) => <span className="text-green-600">{(r.CashRefund || 0).toFixed(2)}</span> },
          { key: 'Reason', title: 'السبب', render: (r) => r.Reason || '—' },
          { key: 'undo', title: '', render: (r) => (
            <button onClick={() => undoReturn(r.ReturnID, r.ReturnNumber)}
              className="p-1.5 rounded text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              title="إلغاء المرتجع وعكس تأثيره"><RotateCcw size={14} /></button>
          )},
        ]}
        data={returns}
        keyField="ReturnID"
        emptyMessage="لا توجد مرتجعات شراء"
      />

      {/* Invoice picker modal */}
      <Modal isOpen={showInvoicePicker} onClose={() => setShowInvoicePicker(false)}
        title="اختر فاتورة شراء لإنشاء مرتجع" size="xl"
        footer={<Button variant="secondary" onClick={() => setShowInvoicePicker(false)}>إغلاق</Button>}
      >
        <div className="space-y-3">
          <div className="relative">
            <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="بحث برقم الفاتورة أو اسم المورد..."
              value={invoiceSearch}
              onChange={(e) => setInvoiceSearch(e.target.value)}
              className="w-full pr-10 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm"
            />
          </div>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-right">رقم الفاتورة</th>
                  <th className="px-3 py-2 text-right">التاريخ</th>
                  <th className="px-3 py-2 text-right">المورد</th>
                  <th className="px-3 py-2 text-right">الإجمالي</th>
                  <th className="px-3 py-2 text-right">المتبقي</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {filteredPurchases.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-500">لا توجد فواتير شراء</td></tr>
                ) : filteredPurchases.map((p: any) => (
                  <tr key={p.PurchaseID} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                    <td className="px-3 py-2 font-mono text-xs">{p.PurchaseNumber}</td>
                    <td className="px-3 py-2">{p.Date}</td>
                    <td className="px-3 py-2">{p.SupplierName}</td>
                    <td className="px-3 py-2 font-bold">{p.TotalAmount?.toFixed(2)}</td>
                    <td className="px-3 py-2">{p.RemainingAmount > 0 ? <span className="text-red-600">{p.RemainingAmount?.toFixed(2)}</span> : '—'}</td>
                    <td className="px-3 py-2">
                      <Button size="sm" variant="outline" onClick={() => startReturnFromInvoice(p)} icon={<Undo2 size={14} />}>
                        مرتجع
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* Return (debit note) modal */}
      <Modal isOpen={showReturnModal} onClose={() => setShowReturnModal(false)}
        title={`مرتجع مشتريات — فاتورة ${returnPurchase?.PurchaseNumber || ''}`} size="lg"
        footer={<>
          <Button variant="secondary" onClick={() => setShowReturnModal(false)}>إلغاء</Button>
          <Button onClick={submitReturn} icon={<Undo2 size={16} />}>تأكيد المرتجع</Button>
        </>}
      >
        <div className="space-y-4">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            المورد: <b>{returnPurchase?.SupplierName}</b>
            {' · '}إجمالي الفاتورة: <b>{returnPurchase?.TotalAmount?.toFixed(2)}</b>
            {' · '}المستحق للمورد: <b>{(returnPurchase?.RemainingAmount || 0).toFixed(2)}</b>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-right">الصنف</th>
                  <th className="px-3 py-2 text-right">المشترى</th>
                  <th className="px-3 py-2 text-right">المتاح للإرجاع</th>
                  <th className="px-3 py-2 text-right">التكلفة</th>
                  <th className="px-3 py-2 text-right">الكمية المرتجعة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {returnLines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2">{l.ItemName || 'بند'}</td>
                    <td className="px-3 py-2">{l.Quantity}</td>
                    <td className="px-3 py-2 text-slate-500">{l.Returnable}</td>
                    <td className="px-3 py-2">{(l.UnitCost || 0).toFixed(2)}</td>
                    <td className="px-3 py-2 w-32">
                      <input type="number" min={0} max={l.Returnable} value={l.ReturnQty}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(l.Returnable, Number(e.target.value) || 0));
                          setReturnLines(rows => rows.map((r, i) => i === idx ? { ...r, ReturnQty: v } : r));
                        }}
                        className="w-full px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Input label="سبب الإرجاع" value={returnReason}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReturnReason(e.target.value)}
            placeholder="عيب مصنعي، تالف..." />

          {returnTotal > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  كيف تُسوّى قيمة المرتجع؟
                </span>
                <span className="text-sm font-bold text-slate-800 dark:text-white">
                  {returnTotal.toFixed(2)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Input label="يُخصم من دَيني" type="number" value={retAccountCredit}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetAccountCredit(e.target.value)}
                  hint="يُخصم من المستحق للمورد" />
                <Input label="استرداد نقداً" type="number" value={retCashRefund}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetCashRefund(e.target.value)} />
                <Input label="تحويل/محفظة" type="number" value={retTransferRefund}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetTransferRefund(e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {(parseFloat(retCashRefund) || 0) > 0 && (
                  <Select label="الخزنة" value={returnCashAccountId}
                    onChange={(e) => setReturnCashAccountId(e.target.value)}>
                    <option value="">— اختر —</option>
                    {cashAccounts.map((ca: any) => (
                      <option key={ca.CashAccountID} value={ca.CashAccountID}>
                        {ca.AccountName} ({ca.Balance?.toFixed(2)})
                      </option>
                    ))}
                  </Select>
                )}
                {(parseFloat(retTransferRefund) || 0) > 0 && (
                  <Select label="المحفظة / الماكينة" value={retPaymentMethodId}
                    onChange={(e) => setRetPaymentMethodId(e.target.value)}>
                    <option value="">— اختر —</option>
                    {paymentMethods.map((pm: any) => (
                      <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>
                        {pm.MethodName} ({pm.Balance?.toFixed(2)})
                      </option>
                    ))}
                  </Select>
                )}
              </div>

              {(parseFloat(retTransferRefund) || 0) > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <Input label="عمولة التحويل" type="number" value={retTransferCost}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetTransferCost(e.target.value)} />
                  {(parseFloat(retTransferCost) || 0) > 0 && (
                    <Select label="من يتحمل العمولة؟" value={retFeeBearer}
                      onChange={(e) => setRetFeeBearer(e.target.value as 'shop' | 'party')}>
                      <option value="shop">المحل (يخرج من المحفظة أكثر)</option>
                      <option value="party">المورد (يصله أقل)</option>
                    </Select>
                  )}
                </div>
              )}

              <div className={`rounded-lg p-2 text-sm flex items-center justify-between ${
                Math.abs(retUnallocated) < 0.005
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}`}>
                <span>الموزّع: <b>{retAllocated.toFixed(2)}</b> من <b>{returnTotal.toFixed(2)}</b></span>
                <span>
                  {Math.abs(retUnallocated) < 0.005
                    ? 'مطابق ✓'
                    : retUnallocated > 0
                      ? `متبقٍ ${retUnallocated.toFixed(2)}`
                      : `زائد ${Math.abs(retUnallocated).toFixed(2)}`}
                </span>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
