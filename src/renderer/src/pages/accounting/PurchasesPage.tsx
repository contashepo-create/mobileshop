import { useState, useEffect } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

interface PurchaseItem { ItemID: number; ItemName: string; IMEI?: string; Quantity: number; UnitCost: number; WarehouseID: number; }

export function PurchasesPage() {
  const { showToast } = useToastStore();
  const [purchases, setPurchases] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
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
    const [p, su, it, wh, ca, pm] = await Promise.all([
      window.api.invoke('purchases:list'),
      window.api.invoke('suppliers:list'),
      window.api.invoke('items:list', { search, isActive: 1 }),
      window.api.invoke('warehouses:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setPurchases(p); setSuppliers(su); setItems(it); setWarehouses(wh); setCashAccounts(ca); setPaymentMethods(pm);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">المشتريات</h1>
        <Button onClick={() => setShowModal(true)} icon={<Plus size={16} />}>فاتورة شراء</Button>
      </div>

      <DataTable
        columns={[
          { key: 'PurchaseNumber', title: 'رقم الفاتورة', render: (row) => <span className="font-mono text-xs">{row.PurchaseNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'SupplierName', title: 'المورد', render: (row) => <span className="font-medium">{row.SupplierName}</span> },
          { key: 'TotalAmount', title: 'الإجمالي', render: (row) => <span className="font-bold">{row.TotalAmount?.toFixed(2)}</span> },
          { key: 'PaidAmount', title: 'المدفوع', render: (row) => <span className="text-green-600">{row.PaidAmount?.toFixed(2)}</span> },
          { key: 'RemainingAmount', title: 'المتبقي', render: (row) => row.RemainingAmount > 0 ? <span className="text-red-600">{row.RemainingAmount?.toFixed(2)}</span> : '—' },
          { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={row.Status === 'completed' ? 'green' : row.Status === 'partial' ? 'yellow' : 'red'}>{row.Status === 'completed' ? 'مكتملة' : row.Status === 'partial' ? 'جزئية' : 'غير مدفوعة'}</Badge> },
          { key: 'delete', title: '', render: (row) => <button onClick={async () => { if (confirm('سيتم حذف فاتورة الشراء وعكس كل التأثيرات (المخزون، المورد، الخزنة). متابعة؟')) { const r = await window.api.invoke('delete:purchase', row.PurchaseID); if (r.success) { showToast('success', r.message); fetchData(); } else { showToast('error', r.message); } } }} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="حذف"><Trash2 size={14} /></button> },
        ]}
        data={purchases}
        keyField="PurchaseID"
        emptyMessage="لا توجد فواتير شراء"
      />

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
    </div>
  );
}
