import { useState, useEffect } from 'react';
import { Plus, Undo2, RotateCcw, Printer, ChevronDown, Search } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

/**
 * Standalone sales-returns page.
 *
 * Two ways to start a return:
 *   1. From an invoice — pick a sale, see its returnable lines, choose qtys.
 *   2. Quick return — pick a customer, pick items from their purchase history.
 *
 * Both paths use the same `saleReturns:create` handler on the server, which
 * validates everything and does the stock/balance settlement.
 */
export function SalesReturnsPage() {
  const { showToast } = useToastStore();
  const [returns, setReturns] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showInvoicePicker, setShowInvoicePicker] = useState(false);
  const [returnSale, setReturnSale] = useState<any>(null);
  const [returnLines, setReturnLines] = useState<any[]>([]);
  const [returnReason, setReturnReason] = useState('');
  const [returnCashAccountId, setReturnCashAccountId] = useState('');
  const [retAccountCredit, setRetAccountCredit] = useState('');
  const [retCashRefund, setRetCashRefund] = useState('');
  const [retTransferRefund, setRetTransferRefund] = useState('');
  const [retPaymentMethodId, setRetPaymentMethodId] = useState('');
  const [retTransferCost, setRetTransferCost] = useState('');
  const [retFeeBearer, setRetFeeBearer] = useState<'shop' | 'party'>('shop');
  const [showPrintMenu, setShowPrintMenu] = useState<number | null>(null);
  const [invoiceSearch, setInvoiceSearch] = useState('');

  const fetchData = async () => {
    const [rt, s, cu, ca, pm] = await Promise.all([
      window.api.invoke('saleReturns:list'),
      window.api.invoke('sales:list'),
      window.api.invoke('customers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    setReturns(rt || []);
    setSales(s || []);
    setCustomers(cu || []);
    setCashAccounts(ca || []);
    setPaymentMethods(pm || []);
  };

  useEffect(() => { fetchData(); }, []);

  const filteredSales = invoiceSearch
    ? sales.filter(s =>
        (s.SaleNumber || '').includes(invoiceSearch) ||
        (s.CustomerName || '').includes(invoiceSearch))
    : sales;

  /** Opens the return modal from a specific invoice. */
  const startReturnFromInvoice = async (sale: any) => {
    const lines = await window.api.invoke('saleReturns:returnable', sale.SaleID);
    if (!Array.isArray(lines) || lines.length === 0) {
      showToast('error', 'لا توجد بنود قابلة للإرجاع'); return;
    }
    const open = lines.filter((l: any) => l.Returnable > 0);
    if (open.length === 0) { showToast('error', 'تم إرجاع كل بنود هذه الفاتورة'); return; }
    setReturnSale(sale);
    setReturnLines(open.map((l: any) => ({ ...l, ReturnQty: 0 })));
    setReturnReason('');
    setReturnCashAccountId(sale.CashAccountID ? String(sale.CashAccountID) : '');
    setRetAccountCredit(''); setRetCashRefund(''); setRetTransferRefund('');
    setRetPaymentMethodId(''); setRetTransferCost(''); setRetFeeBearer('shop');
    setShowInvoicePicker(false);
    setShowReturnModal(true);
  };

  const returnTotal = Math.round(returnLines.reduce(
    (sum, l) => sum + (Number(l.ReturnQty) || 0) * (l.UnitPrice || 0), 0) * 100) / 100;

  const hasCustomerAccount = !!returnSale?.CustomerID;
  const retAllocated = Math.round(
    ((parseFloat(retAccountCredit) || 0) + (parseFloat(retCashRefund) || 0)
      + (parseFloat(retTransferRefund) || 0)) * 100) / 100;
  const retUnallocated = Math.round((returnTotal - retAllocated) * 100) / 100;

  useEffect(() => {
    if (!showReturnModal || returnTotal <= 0) return;
    if (!hasCustomerAccount) {
      setRetAccountCredit('0');
      setRetCashRefund(returnTotal.toFixed(2));
      setRetTransferRefund('0');
      return;
    }
    const outstanding = Math.max(0, returnSale?.RemainingAmount || 0);
    const credit = Math.min(returnTotal, outstanding);
    setRetAccountCredit(credit.toFixed(2));
    setRetCashRefund((returnTotal - credit).toFixed(2));
    setRetTransferRefund('0');
  }, [returnTotal, showReturnModal, hasCustomerAccount]);

  const submitReturn = async () => {
    const picked = returnLines.filter(l => (Number(l.ReturnQty) || 0) > 0);
    if (picked.length === 0) { showToast('error', 'حدد الكمية المرتجعة'); return; }
    for (const l of picked) {
      if (Number(l.ReturnQty) > l.Returnable) {
        showToast('error', `الكمية المرتجعة من "${l.ItemName || 'بند'}" أكبر من المتاح (${l.Returnable})`);
        return;
      }
    }
    const res = await window.api.invoke('saleReturns:create', {
      SaleID: returnSale.SaleID,
      items: picked.map(l => ({
        ItemID: l.ItemID, SerialID: l.SerialID || undefined,
        Quantity: Number(l.ReturnQty), UnitPrice: l.UnitPrice,
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
      showToast('success', `تم إنشاء مرتجع رقم ${res.returnNumber}`);
      setShowReturnModal(false);
      setReturnSale(null);
      fetchData();
    } else {
      showToast('error', res?.message || 'فشل إنشاء المرتجع');
    }
  };

  const undoReturn = async (returnId: number, number: string) => {
    if (!confirm(`إلغاء المرتجع ${number}؟\n\nسيتم عكس كل تأثيراته: البضاعة تخرج من المخزن، والمبلغ المرتجع يعود للخزنة، ويعود الدين على العميل.`)) return;
    const res = await window.api.invoke('delete:saleReturn', returnId);
    if (res?.success) { showToast('success', res.message); fetchData(); }
    else showToast('error', res?.message || 'فشل الإلغاء');
  };

  const printReturn = async (ret: any, overridePaperSize?: string) => {
    const settings = await window.api.invoke('settings:getAll');
    const template = settings.default_invoice_template || '1';
    const paperSize = overridePaperSize || settings.paper_size || '80mm';
    const defaultAction = settings.print_default_action || 'preview';

    const { header, details } = await window.api.invoke('saleReturns:get', ret.ReturnID);
    if (!header) { showToast('error', 'تعذّر تحميل المرتجع'); return; }

    const invoiceData: any = {
      items: details || [],
      returnNumber: header.ReturnNumber,
      date: header.Date,
      customerName: header.CustomerName,
      customerPhone: header.CustomerPhone,
      subtotal: header.TotalAmount,
      totalAmount: header.TotalAmount,
      returnValue: header.TotalAmount,
      debtRelief: header.DebtRelief || 0,
      cashRefund: header.CashRefund || 0,
      transferRefund: header.TransferRefund || 0,
      reason: header.Reason,
    };

    const printData = { type: 'sale_return', paperSize, template, companyInfo: settings, invoiceData };
    await window.api.invoke(defaultAction === 'print' ? 'print:invoice' : 'print:preview', printData);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">مرتجعات المبيعات</h1>
        <Button onClick={() => setShowInvoicePicker(true)} icon={<Plus size={16} />}>فاتورة مرتجع جديدة</Button>
      </div>

      <DataTable
        columns={[
          { key: 'ReturnNumber', title: 'رقم المرتجع', render: (r) => <span className="font-mono text-xs">{r.ReturnNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'SaleNumber', title: 'فاتورة البيع', render: (r) => <span className="font-mono text-xs">{r.SaleNumber}</span> },
          { key: 'CustomerName', title: 'العميل', render: (r) => r.CustomerName || 'عميل نقدي' },
          { key: 'TotalAmount', title: 'قيمة المرتجع', render: (r) => <span className="font-bold">{r.TotalAmount?.toFixed(2)}</span> },
          { key: 'DebtRelief', title: 'خُصم من الدين', render: (r) => <span className="text-blue-600">{(r.DebtRelief || 0).toFixed(2)}</span> },
          { key: 'CashRefund', title: 'رُدّ نقداً', render: (r) => <span className="text-red-600">{(r.CashRefund || 0).toFixed(2)}</span> },
          { key: 'Reason', title: 'السبب', render: (r) => r.Reason || '—' },
          { key: 'print', title: 'طباعة', render: (r) => (
            <div className="flex items-center gap-1 relative">
              <button onClick={() => printReturn(r)} className="p-1.5 rounded text-slate-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20" title="طباعة مرتجع"><Printer size={14} /></button>
              <button onClick={() => setShowPrintMenu(showPrintMenu === r.ReturnID ? null : r.ReturnID)} className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" title="خيارات الطباعة">
                <ChevronDown size={12} />
              </button>
              {showPrintMenu === r.ReturnID && (
                <div className="absolute top-full right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 w-40">
                  <button onClick={() => { printReturn(r); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">الإعداد الافتراضي</button>
                  <div className="border-t border-slate-100 dark:border-slate-700"></div>
                  <button onClick={() => { printReturn(r, '80mm'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">حراري 80mm</button>
                  <button onClick={() => { printReturn(r, '58mm'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">حراري 58mm</button>
                  <button onClick={() => { printReturn(r, 'A5'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">A5</button>
                  <button onClick={() => { printReturn(r, 'A4'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">A4</button>
                </div>
              )}
            </div>
          )},
          { key: 'undo', title: '', render: (r) => (
            <button onClick={() => undoReturn(r.ReturnID, r.ReturnNumber)}
              className="p-1.5 rounded text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              title="إلغاء المرتجع وعكس تأثيره"><RotateCcw size={14} /></button>
          )},
        ]}
        data={returns}
        keyField="ReturnID"
        emptyMessage="لا توجد مرتجعات"
      />

      {/* Invoice picker modal */}
      <Modal isOpen={showInvoicePicker} onClose={() => setShowInvoicePicker(false)}
        title="اختر فاتورة لإنشاء مرتجع" size="xl"
        footer={<Button variant="secondary" onClick={() => setShowInvoicePicker(false)}>إغلاق</Button>}
      >
        <div className="space-y-3">
          <div className="relative">
            <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="بحث برقم الفاتورة أو اسم العميل..."
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
                  <th className="px-3 py-2 text-right">العميل</th>
                  <th className="px-3 py-2 text-right">الإجمالي</th>
                  <th className="px-3 py-2 text-right">المتبقي</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {filteredSales.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-500">لا توجد فواتير</td></tr>
                ) : filteredSales.map((s: any) => (
                  <tr key={s.SaleID} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                    <td className="px-3 py-2 font-mono text-xs">{s.SaleNumber}</td>
                    <td className="px-3 py-2">{s.Date}</td>
                    <td className="px-3 py-2">{s.CustomerName || 'عميل نقدي'}</td>
                    <td className="px-3 py-2 font-bold">{s.TotalAmount?.toFixed(2)}</td>
                    <td className="px-3 py-2">{s.RemainingAmount > 0 ? <span className="text-red-600">{s.RemainingAmount?.toFixed(2)}</span> : '—'}</td>
                    <td className="px-3 py-2">
                      <Button size="sm" variant="outline" onClick={() => startReturnFromInvoice(s)} icon={<Undo2 size={14} />}>
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

      {/* Return (credit note) modal */}
      <Modal isOpen={showReturnModal} onClose={() => setShowReturnModal(false)}
        title={`مرتجع بيع — فاتورة ${returnSale?.SaleNumber || ''}`} size="lg"
        footer={<>
          <Button variant="secondary" onClick={() => setShowReturnModal(false)}>إلغاء</Button>
          <Button onClick={submitReturn} icon={<Undo2 size={16} />}>تأكيد المرتجع</Button>
        </>}
      >
        <div className="space-y-4">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            العميل: <b>{returnSale?.CustomerName || 'عميل نقدي'}</b>
            {' · '}إجمالي الفاتورة: <b>{returnSale?.TotalAmount?.toFixed(2)}</b>
            {' · '}المتبقي على العميل: <b>{(returnSale?.RemainingAmount || 0).toFixed(2)}</b>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-right">الصنف</th>
                  <th className="px-3 py-2 text-right">المباع</th>
                  <th className="px-3 py-2 text-right">المتاح للإرجاع</th>
                  <th className="px-3 py-2 text-right">السعر</th>
                  <th className="px-3 py-2 text-right">الكمية المرتجعة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {returnLines.map((l, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2">{l.ItemName || l.IMEI || 'بند/خدمة'}</td>
                    <td className="px-3 py-2">{l.Quantity}</td>
                    <td className="px-3 py-2 text-slate-500">{l.Returnable}</td>
                    <td className="px-3 py-2">{(l.UnitPrice || 0).toFixed(2)}</td>
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
            placeholder="عيب مصنعي، رغبة العميل..." />

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

              {!hasCustomerAccount && (
                <div className="text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded p-2">
                  عميل نقدي — لا يوجد له حساب، لذا يجب صرف القيمة بالكامل نقداً و/أو تحويلاً.
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <Input label="يبقى على حسابه" type="number" value={retAccountCredit}
                  disabled={!hasCustomerAccount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetAccountCredit(e.target.value)}
                  hint={hasCustomerAccount ? 'يُخصم من دَينه أو يصبح رصيداً له' : 'غير متاح لعميل نقدي'} />
                <Input label="نقداً من الخزنة" type="number" value={retCashRefund}
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
                      <option value="party">العميل (يصله أقل)</option>
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
