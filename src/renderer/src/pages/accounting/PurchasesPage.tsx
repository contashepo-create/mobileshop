import { useState, useEffect } from 'react';
import { Plus, Trash2, Search, Undo2, RotateCcw, FileText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

interface PurchaseItem { ItemID: number; ItemName: string; IMEI?: string; Quantity: number; UnitCost: number; WarehouseID: number; }

/** See the note on SalesPage: one implementation, two sidebar destinations. */
export function PurchasesPage({ mode }: { mode?: 'purchases' | 'returns' } = {}) {
  const { showToast } = useToastStore();
  const [purchases, setPurchases] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState<'purchases' | 'returns'>(mode ?? 'purchases');
  const [returns, setReturns] = useState<any[]>([]);
  // Purchase-return (debit note) workflow
  const [showReturnModal, setShowReturnModal] = useState(false);
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
  const [search, setSearch] = useState('');

  const [supplierId, setSupplierId] = useState('');
  const [cart, setCart] = useState<PurchaseItem[]>([]);
  const [discount, setDiscount] = useState('');
  const [totalAmountPaid, setTotalAmountPaid] = useState('');
  const [additionalCost, setAdditionalCost] = useState('');
  const [paymentCost, setPaymentCost] = useState('');
  const [paymentSourceType, setPaymentSourceType] = useState<'cash_account' | 'payment_method'>('cash_account');
  const [paymentSourceId, setPaymentSourceId] = useState('');
  const [notes, setNotes] = useState('');

  const [selectedItem, setSelectedItem] = useState('');
  const [imei, setImei] = useState('');
  const [qty, setQty] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [warehouseId, setWarehouseId] = useState('');

  const fetchData = async () => {
    const [p, rt, su, it, wh, ca, pm] = await Promise.all([
      window.api.invoke('purchases:list'),
      window.api.invoke('purchaseReturns:list'),
      window.api.invoke('suppliers:list'),
      window.api.invoke('items:list', { search, isActive: 1 }),
      window.api.invoke('warehouses:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setPurchases(p); setReturns(rt || []); setSuppliers(su); setItems(it); setWarehouses(wh); setCashAccounts(ca); setPaymentMethods(pm);
    if (wh.length > 0 && !warehouseId) setWarehouseId(wh[0].WarehouseID.toString());
  };

  useEffect(() => { fetchData(); }, [search]);

  const subtotal = cart.reduce((sum, item) => sum + item.Quantity * item.UnitCost, 0);
  const addCost = parseFloat(additionalCost) || 0;
  const payCost = parseFloat(paymentCost) || 0;
  const discAmt = parseFloat(discount) || 0;
  const totalBeforeCosts = subtotal - discAmt;
  const grandTotal = totalBeforeCosts + addCost + payCost;
  const paid = parseFloat(totalAmountPaid) || 0;

  const addToCart = () => {
    if (!selectedItem || !warehouseId) { showToast('error', 'اختر صنفاً ومخزناً'); return; }
    const item = items.find(i => i.ItemID === parseInt(selectedItem));
    if (!item) return;
    const newItem: PurchaseItem = { ItemID: item.ItemID, ItemName: item.ItemName, IMEI: imei || undefined, Quantity: parseInt(qty) || 1, UnitCost: parseFloat(unitCost) || 0, WarehouseID: parseInt(warehouseId) };
    setCart([...cart, newItem]);
    setSelectedItem(''); setImei(''); setQty('1'); setUnitCost('');
  };

  const handlePurchase = async () => {
    if (!supplierId) { showToast('error', 'اختر المورد'); return; }
    if (cart.length === 0) { showToast('error', 'السلة فارغة'); return; }

    if (paid > 0 && !paymentSourceId) { showToast('error', 'اختر مصدر الدفع'); return; }

    const supplier = suppliers.find(s => s.SupplierID === parseInt(supplierId));
    if (supplier?.Status === 'suspended') { showToast('error', 'المورد موقوف'); return; }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    try {
      const result = await window.api.invoke('purchases:create', {
        SupplierID: parseInt(supplierId),
        items: cart,
        Discount: discAmt,
        TaxAmount: 0,
        AdditionalCost: addCost,
        PaymentCost: payCost,
        PaidAmount: paid,
        PaymentSourceType: paid > 0 ? paymentSourceType : undefined,
        PaymentSourceID: paid > 0 ? parseInt(paymentSourceId) : undefined,
        Notes: notes,
        userId: currentUserId(),
        fiscalYearId: activeFy.FiscalYearID,
      });

      if (result.success) {
        const msg = `تم إنشاء فاتورة الشراء - رقم: ${result.purchaseNumber}` +
          (result.remaining > 0 ? ` | مستحق للمورد: ${result.remaining.toFixed(2)}` : '') +
          (result.remaining < 0 ? ` | زيادة دفع: ${Math.abs(result.remaining).toFixed(2)}` : '');
        showToast('success', msg);
        setShowModal(false);
        setCart([]); setSupplierId(''); setDiscount(''); setTotalAmountPaid(''); setAdditionalCost(''); setPaymentCost(''); setPaymentSourceType('cash_account'); setPaymentSourceId(''); setNotes('');
        fetchData();
      } else {
        showToast('error', result.message || 'فشل إنشاء الفاتورة');
      }
    } catch (err: any) {
      console.error('Purchase error:', err);
      showToast('error', `خطأ غير متوقع: ${err.message || err}`);
    }
  };

  /** Opens the debit-note screen, showing what may still go back. */
  const startReturn = async (purchase: any) => {
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
    setShowReturnModal(true);
  };

  const returnTotal = Math.round(returnLines.reduce(
    (sum, l) => sum + (Number(l.ReturnQty) || 0) * (l.UnitCost || 0), 0) * 100) / 100;

  const retAllocated = Math.round(
    ((parseFloat(retAccountCredit) || 0) + (parseFloat(retCashRefund) || 0)
      + (parseFloat(retTransferRefund) || 0)) * 100) / 100;
  const retUnallocated = Math.round((returnTotal - retAllocated) * 100) / 100;

  /** Suggests debt-first, the rest in cash. Every field stays editable. */
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
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">{mode === 'returns' ? 'مرتجعات المشتريات' : 'المشتريات'}</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>فاتورة شراء</Button>
      </div>

      <div className={`flex gap-2 border-b border-slate-200 dark:border-slate-700 ${mode ? 'hidden' : ''}`}>
        <button onClick={() => setTab('purchases')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'purchases' ? 'border-primary-600 text-primary-600'
                                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
          <FileText size={16} /> فواتير الشراء ({purchases.length})
        </button>
        <button onClick={() => setTab('returns')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'returns' ? 'border-primary-600 text-primary-600'
                              : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
          <Undo2 size={16} /> مرتجعات الشراء ({returns.length})
        </button>
      </div>

      {tab === 'returns' ? (
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
      ) : (
      <DataTable
        columns={[
          { key: 'PurchaseNumber', title: 'رقم الفاتورة', render: (row) => <span className="font-mono text-xs">{row.PurchaseNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'SupplierName', title: 'المورد', render: (row) => <span className="font-medium">{row.SupplierName}</span> },
          { key: 'TotalAmount', title: 'الإجمالي', render: (row) => <span className="font-bold">{row.TotalAmount?.toFixed(2)}</span> },
          { key: 'ops', title: '', render: (row) => (
            <div className="flex items-center gap-1">
              <button onClick={() => startReturn(row)}
                className="p-1.5 rounded text-slate-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                title="مرتجع مشتريات"><Undo2 size={14} /></button>
              <button onClick={async () => { if (confirm('سيتم حذف فاتورة الشراء وعكس كل التأثيرات (المخزون، المورد، الخزنة). متابعة؟')) { const r = await window.api.invoke('delete:purchase', row.PurchaseID); if (r.success) { showToast('success', r.message); fetchData(); } else { showToast('error', r.message); } } }}
                className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="حذف"><Trash2 size={14} /></button>
            </div>
          )},
        ]}
        data={purchases}
        keyField="PurchaseID"
        emptyMessage="لا توجد فواتير شراء"
      />
      )}

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="فاتورة شراء جديدة" size="xl"
        footer={<><Button variant="secondary" onClick={() => setShowModal(false)}>إلغاء</Button><Button onClick={handlePurchase}>حفظ</Button></>}
      >
        <div className="space-y-4">
          {/* Supplier & Warehouse */}
          <div className="grid grid-cols-2 gap-3">
            <Select label="المورد" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— اختر —</option>
              {suppliers.map((s: any) => <option key={s.SupplierID} value={s.SupplierID}>{s.Name} (رصيد: {s.Balance?.toFixed(2)})</option>)}
            </Select>
            <Select label="المخزن المستلم" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w: any) => <option key={w.WarehouseID} value={w.WarehouseID}>{w.WarehouseName}</option>)}
            </Select>
          </div>

          {/* Add items */}
          <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-4">
                <Select label="الصنف" value={selectedItem} onChange={(e) => { setSelectedItem(e.target.value); const it = items.find(i => i.ItemID === parseInt(e.target.value)); setUnitCost(it?.CostPrice?.toString() || ''); }}>
                  <option value="">— اختر —</option>
                  {items.map((it: any) => <option key={it.ItemID} value={it.ItemID}>{it.ItemName} {it.IsSerialized ? '(IMEI)' : ''}</option>)}
                </Select>
              </div>
              {items.find(i => i.ItemID === parseInt(selectedItem))?.IsSerialized ? (
                <div className="col-span-3"><Input label="IMEI" value={imei} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setImei(e.target.value)} /></div>
              ) : (
                <div className="col-span-2"><Input label="الكمية" type="number" value={qty} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQty(e.target.value)} /></div>
              )}
              <div className="col-span-2"><Input label="التكلفة" type="number" value={unitCost} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUnitCost(e.target.value)} /></div>
              <div className="col-span-2"><Button onClick={addToCart} icon={<Plus size={14} />} size="sm">إضافة</Button></div>
            </div>
          </div>

          {/* Cart table */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 dark:bg-slate-800/50"><th className="px-3 py-2 text-right">الصنف</th><th className="px-3 py-2 text-right">IMEI</th><th className="px-3 py-2 text-right">كمية</th><th className="px-3 py-2 text-right">تكلفة</th><th className="px-3 py-2 text-right">إجمالي</th><th className="px-3 py-2"></th></tr></thead>
              <tbody>
                {cart.length === 0 ? <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-500 dark:text-slate-400">السلة فارغة</td></tr> :
                  cart.map((item, idx) => (
                    <tr key={idx} className="border-t border-slate-100 dark:border-slate-700/50">
                      <td className="px-3 py-2 font-medium">{item.ItemName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.IMEI || '—'}</td>
                      <td className="px-3 py-2">{item.Quantity}</td>
                      <td className="px-3 py-2">{item.UnitCost.toFixed(2)}</td>
                      <td className="px-3 py-2 font-bold">{(item.Quantity * item.UnitCost).toFixed(2)}</td>
                      <td className="px-3 py-2"><button onClick={() => setCart(cart.filter((_, i) => i !== idx))} className="text-red-500"><Trash2 size={14} /></button></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>

          {/* Totals + Costs + Payment */}
          <div className="grid grid-cols-2 gap-4">
            {/* Left: Totals */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">إجمالي الأصناف</span><span className="font-medium text-slate-800 dark:text-white">{subtotal.toFixed(2)}</span></div>
              <div className="flex items-center gap-2"><span className="text-sm text-slate-500 dark:text-slate-400">خصم</span><input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm" /></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">صافي الأصناف</span><span className="font-medium text-slate-800 dark:text-white">{totalBeforeCosts.toFixed(2)}</span></div>
              <div className="flex items-center gap-2"><span className="text-sm text-slate-500 dark:text-slate-400">تكلفة شحن/نقل</span><input type="number" value={additionalCost} onChange={(e) => setAdditionalCost(e.target.value)} className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm" /></div>
              <div className="flex items-center gap-2"><span className="text-sm text-slate-500 dark:text-slate-400">تكلفة دفع</span><input type="number" value={paymentCost} onChange={(e) => setPaymentCost(e.target.value)} className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm" /></div>
              <div className="flex justify-between text-lg font-bold border-t border-slate-200 dark:border-slate-700 pt-2"><span className="text-slate-800 dark:text-white">الإجمالي الكلي</span><span className="text-primary-600">{grandTotal.toFixed(2)}</span></div>
              <div className="text-xs text-slate-400">يتم توزيع تكاليف الشحن والدفع على الأصناف بنسبة تكلفتها</div>
            </div>

            {/* Right: Payment */}
            <div className="space-y-3">
              <Input label="المبلغ المدفوع" type="number" value={totalAmountPaid} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTotalAmountPaid(e.target.value)} hint={`الإجمالي: ${grandTotal.toFixed(2)}`} />
              {paid > 0 && (
                <>
                  <Select label="نوع مصدر الدفع" value={paymentSourceType} onChange={(e) => { setPaymentSourceType(e.target.value as 'cash_account' | 'payment_method'); setPaymentSourceId(''); }}>
                    <option value="cash_account">خزنة / بنك</option>
                    <option value="payment_method">ماكينة / محفظة</option>
                  </Select>
                  <Select label="مصدر الدفع" value={paymentSourceId} onChange={(e) => setPaymentSourceId(e.target.value)}>
                    <option value="">— اختر —</option>
                    {paymentSourceType === 'cash_account'
                      ? cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)
                      : paymentMethods.filter((pm: any) => pm.IsActive).map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)
                    }
                  </Select>
                </>
              )}
              {paid === 0 && <p className="text-sm text-slate-400">لم يتم إدخال مبلغ مدفوع — ستكون الفاتورة غير مدفوعة (رصيد للمورد)</p>}
            </div>
          </div>
        </div>
      </Modal>

      {/* Purchase return (debit note) */}
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
            {' · '}المتبقي عليك: <b>{(returnPurchase?.RemainingAmount || 0).toFixed(2)}</b>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-right">الصنف</th>
                  <th className="px-3 py-2 text-right">المخزن</th>
                  <th className="px-3 py-2 text-right">المشترى</th>
                  <th className="px-3 py-2 text-right">بالمخزن</th>
                  <th className="px-3 py-2 text-right">المتاح للإرجاع</th>
                  <th className="px-3 py-2 text-right">سعر الشراء</th>
                  <th className="px-3 py-2 text-right">الكمية المرتجعة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {returnLines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2">{l.ItemName}</td>
                    <td className="px-3 py-2 text-slate-500">{l.WarehouseName || '—'}</td>
                    <td className="px-3 py-2">{l.Quantity}</td>
                    <td className="px-3 py-2 text-slate-500">{l.InStock}</td>
                    <td className="px-3 py-2">
                      <span className={l.LimitedByStock ? 'text-orange-600 font-medium' : ''}>{l.Returnable}</span>
                      {/* Explains WHY the cap is lower than the invoice line. */}
                      {l.LimitedByStock && (
                        <span className="block text-[10px] text-orange-500">بيعت بعض الكمية</span>
                      )}
                    </td>
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
            placeholder="بضاعة تالفة، مخالفة للمواصفات..." />

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
                <Input label="يبقى على حساب المورد" type="number" value={retAccountCredit}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetAccountCredit(e.target.value)}
                  hint="يُخصم مما عليك أو يصبح لك عنده" />
                <Input label="نقداً للخزنة" type="number" value={retCashRefund}
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
                      <option value="shop">المحل</option>
                      <option value="party">المورد (يصلك أقل)</option>
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
