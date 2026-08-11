import { useState, useEffect } from 'react';
import { Plus, Trash2, ShoppingCart, Wrench, Printer, Eye, ChevronDown, FileText, Pencil, Undo2, RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';

interface CartItem {
  uid: string; // unique per cart entry, stable across add/remove
  ItemID?: number; ItemName: string; SerialID?: number; IMEI?: string;
  Quantity: number; UnitPrice: number; UnitCost?: number; isService?: boolean;
  ServiceCost?: number;
}

/**
 * `mode` lets the same screen serve two sidebar entries.
 *
 * Sales returns were a TAB inside this page, so "مرتجعات المبيعات" could not
 * be a section of its own — the shop had to know it lived behind a tab on
 * another screen. Passing the mode from the route makes it a real destination
 * without duplicating the page: one implementation, two doors. The tab strip
 * is hidden when a mode is fixed, because a tab that navigates away from the
 * section you just opened is worse than no tab.
 */
export function SalesPage({ mode }: { mode?: 'sales' | 'returns' } = {}) {
  const { showToast } = useToastStore();
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [tab, setTab] = useState<'sales' | 'returns'>(mode ?? 'sales');
  const [returns, setReturns] = useState<any[]>([]);
  // Set while editing an existing invoice; null when creating a new one.
  const [editingSaleId, setEditingSaleId] = useState<number | null>(null);
  // Sale-return workflow
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnSale, setReturnSale] = useState<any>(null);
  const [returnLines, setReturnLines] = useState<any[]>([]);
  const [returnReason, setReturnReason] = useState('');
  const [returnCashAccountId, setReturnCashAccountId] = useState('');
  // How the return value is settled: on account / cash / transfer.
  const [retAccountCredit, setRetAccountCredit] = useState('');
  const [retCashRefund, setRetCashRefund] = useState('');
  const [retTransferRefund, setRetTransferRefund] = useState('');
  const [retPaymentMethodId, setRetPaymentMethodId] = useState('');
  const [retTransferCost, setRetTransferCost] = useState('');
  const [retFeeBearer, setRetFeeBearer] = useState<'shop' | 'party'>('shop');
  const [sales, setSales] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [availableSerials, setAvailableSerials] = useState<any[]>([]);
  const [searchItem, setSearchItem] = useState('');

  // Sale form
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discount, setDiscount] = useState('');
  const [taxRate, setTaxRate] = useState(0);
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paidAmount, setPaidAmount] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [notes, setNotes] = useState('');

  const [selectedItem, setSelectedItem] = useState('');
  const [selectedSerial, setSelectedSerial] = useState('');
  const [itemQty, setItemQty] = useState('1');
  const [itemPrice, setItemPrice] = useState('');

  // Service form
  const [serviceName, setServiceName] = useState('');
  const [servicePrice, setServicePrice] = useState('');
  const [serviceCost, setServiceCost] = useState('');
  const [serviceQty, setServiceQty] = useState('1');

  // Stable unique key for each cart entry. Using array index as React key
  // breaks when items are removed from the middle — React's reconciliation
  // shifts the indices, causing input fields to lose focus and state.
  let cartUid = 0;
  const nextUid = () => `cart-${Date.now()}-${cartUid++}`;

  // Transfer cost (when paying via wallet/transfer, the fee charged by the provider)
  const [transferCost, setTransferCost] = useState('');
  // Who absorbs the machine's commission: the shop, or the customer.
  const [feeBearer, setFeeBearer] = useState<'shop' | 'customer'>('shop');

  const fetchData = async () => {
    const [s, rt, cu, ca, pm, it, settings] = await Promise.all([
      window.api.invoke('sales:list'),
      window.api.invoke('saleReturns:list'),
      window.api.invoke('customers:list'),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
      window.api.invoke('items:list', { search: searchItem, isActive: 1 }),
      window.api.invoke('settings:getAll'),
    ]);
    setSales(s);
    setReturns(rt || []);
    setCustomers(cu);
    setCashAccounts(ca);
    setPaymentMethods(pm);
    setItems(it);
    setTaxEnabled(settings.vat_enabled === '1');
    setTaxRate(parseFloat(settings.vat_rate || '0'));
  };

  useEffect(() => { fetchData(); }, [searchItem]);

  const subtotal = cart.reduce((sum, item) => sum + item.Quantity * item.UnitPrice, 0);
  const discountAmount = parseFloat(discount) || 0;
  const taxAmount = taxEnabled ? (subtotal - discountAmount) * (taxRate / 100) : 0;
  // A fee the CUSTOMER pays is part of the invoice: the customer hands over
  // items + fee and the provider keeps the fee, so TotalAmount covers both.
  // A fee the shop absorbs stays outside the invoice and is a cost instead.
  // Without this the `total` (and therefore `remaining`) disagreed with the
  // server, and a customer-paid walk-in sale always looked "unpaid" by the fee.
  const customerFee = feeBearer === 'customer' ? (parseFloat(transferCost) || 0) : 0;
  const total = subtotal - discountAmount + taxAmount + customerFee;

  const addToCart = async () => {
    if (!selectedItem) { showToast('error', 'اختر صنفاً'); return; }
    const item = items.find(i => i.ItemID === parseInt(selectedItem));
    if (!item) return;

    if (item.IsSerialized) {
      if (!selectedSerial) { showToast('error', 'اختر رقم IMEI'); return; }
      const serial = availableSerials.find(s => s.SerialID === parseInt(selectedSerial));
      if (!serial) return;
      if (cart.find(c => c.SerialID === serial.SerialID)) { showToast('error', 'هذا الجهاز في السلة بالفعل'); return; }
      setCart([...cart, { uid: nextUid(), ItemID: item.ItemID, ItemName: item.ItemName, SerialID: serial.SerialID, IMEI: serial.IMEI, Quantity: 1, UnitPrice: parseFloat(itemPrice) || item.SalePrice || 0, UnitCost: item.CostPrice }]);
      setSelectedSerial('');
    } else {
      const qty = parseInt(itemQty) || 1;
      const maxStock = item.TotalStock || 0;
      const alreadyInCart = cart.filter(c => c.ItemID === item.ItemID && !c.isService).reduce((sum, c) => sum + c.Quantity, 0);

      // Check negative balance setting
      const settings = await window.api.invoke('settings:getAll');
      const allowNegativeStock = settings.allow_negative_stock === '1';

      if (maxStock <= 0 && !allowNegativeStock) {
        showToast('error', `لا يوجد رصيد متاح من هذا الصنف (${item.ItemName})`);
        return;
      }
      if (!allowNegativeStock && qty + alreadyInCart > maxStock) {
        showToast('error', `الكمية المتاحة: ${maxStock} (في السلة: ${alreadyInCart})`);
        return;
      }
      setCart([...cart, { uid: nextUid(), ItemID: item.ItemID, ItemName: item.ItemName, Quantity: qty, UnitPrice: parseFloat(itemPrice) || item.SalePrice || 0, UnitCost: item.CostPrice }]);
    }
    setSelectedItem('');
    setItemPrice('');
    setItemQty('1');
  };

  const addServiceToCart = () => {
    if (!serviceName.trim()) { showToast('error', 'أدخل اسم الخدمة'); return; }
    if (!servicePrice || parseFloat(servicePrice) <= 0) { showToast('error', 'أدخل سعر الخدمة'); return; }
    setCart([...cart, {
      uid: nextUid(),
      ItemName: serviceName.trim(),
      Quantity: parseInt(serviceQty) || 1,
      UnitPrice: parseFloat(servicePrice),
      UnitCost: serviceCost ? parseFloat(serviceCost) : 0,
      isService: true,
      ServiceCost: serviceCost ? parseFloat(serviceCost) : 0,
    }]);
    setServiceName('');
    setServicePrice('');
    setServiceCost('');
    setServiceQty('1');
  };

  const removeFromCart = (uid: string) => setCart(cart.filter(c => c.uid !== uid));

  const onItemSelected = async (itemId: string) => {
    setSelectedItem(itemId);
    const item = items.find(i => i.ItemID === parseInt(itemId));
    if (item?.IsSerialized) {
      const serials = await window.api.invoke('serials:getAvailable', parseInt(itemId));
      setAvailableSerials(serials);
    } else {
      setAvailableSerials([]);
      setItemPrice(item?.SalePrice?.toString() || '');
    }
  };

  const handleSale = async () => {
    if (cart.length === 0) { showToast('error', 'السلة فارغة'); return; }

    // المبلغ المحصّل من العميل
    const paid = parseFloat(paidAmount) || 0;
    const remaining = total - paid;

    // إذا دفع العميل مبلغ، يجب اختيار مصدر الاستلام (خزنة أو ماكينة)
    if (paid > 0 && !cashAccountId && !paymentMethodId) {
      showToast('error', 'اختر مصدر استلام المبلغ (خزنة/بنك/ماكينة)');
      return;
    }

    // منع الآجل للعميل النقدي - يجب دفع كامل المبلغ
    if (!selectedCustomer && remaining > 0) {
      showToast('error', 'العميل النقدي يجب أن يدفع المبلغ كاملاً - إما سجّل العميل أو أدفع المبلغ كاملاً');
      return;
    }

    // منع الدفع الزائد للعميل النقدي
    if (!selectedCustomer && remaining < 0) {
      showToast('error', 'لا يمكن استلام مبلغ أكبر من الفاتورة لعميل نقدي');
      return;
    }

    const customer = customers.find(c => c.CustomerID === parseInt(selectedCustomer));
    if (selectedCustomer && customer?.Status === 'suspended') {
      showToast('error', 'العميل محظور - لا يمكن البيع له');
      return;
    }

    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) {
      showToast('error', 'لا توجد سنة مالية مفتوحة - افتح سنة مالية أولاً');
      return;
    }

    try {
      // Same payload either way; the channel decides create vs edit.
      const channel = editingSaleId ? 'sales:update' : 'sales:create';
      const result = await window.api.invoke(channel, {
        ...(editingSaleId ? { SaleID: editingSaleId } : {}),
        CustomerID: selectedCustomer ? parseInt(selectedCustomer) : undefined,
        CustomerName: customer?.Name || customerName || undefined,
        CustomerPhone: customer?.Phone || customerPhone || undefined,
        items: cart.map(c => ({
          ItemID: c.ItemID || 0,
          SerialID: c.SerialID,
          IMEI: c.IMEI,
          Quantity: c.Quantity,
          UnitPrice: c.UnitPrice,
          UnitCost: c.UnitCost,
          isService: c.isService,
          ServiceName: c.isService ? c.ItemName : undefined,
        })),
        Discount: discountAmount,
        TaxRate: taxEnabled ? taxRate : 0,
        TaxAmount: taxAmount,
        PaymentMethod: paid > 0 ? paymentMethod : 'credit',
        PaidAmount: paid,
        TransferCost: parseFloat(transferCost) || 0,
        TransferCostBearer: feeBearer,
        CashAccountID: cashAccountId ? parseInt(cashAccountId) : undefined,
        PaymentMethodID: paymentMethodId ? parseInt(paymentMethodId) : undefined,
        Notes: notes,
        userId: currentUserId(),
        fiscalYearId: activeFy.FiscalYearID,
      });

      if (result.success) {
        let msg = editingSaleId
          ? `تم تعديل الفاتورة - رقم: ${result.saleNumber}`
          : `تم إنشاء الفاتورة - رقم: ${result.saleNumber}`;
        if (result.remaining > 0) {
          msg += ` | المتبقي على العميل: ${result.remaining.toFixed(2)}`;
        } else {
          msg += ' | مدفوعة بالكامل';
        }
        showToast('success', msg);
        setShowSaleModal(false);
        resetForm();
        fetchData();
      } else {
        showToast('error', result.message || 'فشل إنشاء الفاتورة');
      }
    } catch (err: any) {
      console.error('Sale error:', err);
      showToast('error', `خطأ غير متوقع: ${err.message || err}`);
    }
  };

  const resetForm = () => {
    setCart([]); setSelectedCustomer(''); setCustomerName(''); setCustomerPhone('');
    setDiscount(''); setPaidAmount(''); setCashAccountId(''); setPaymentMethodId(''); setNotes('');
    setTransferCost('');
    setFeeBearer('shop');
    setEditingSaleId(null);
  };

  const selectedCustomerObj = customers.find(c => c.CustomerID === parseInt(selectedCustomer));
  const selectedItemObj = items.find(i => i.ItemID === parseInt(selectedItem));

  // Delete sale with reversal
  const handleDeleteSale = async (saleId: number) => {
    if (!confirm('تحذير: سيتم حذف الفاتورة وعكس كل التأثيرات (المخزون، الخزنة، رصيد العميل). متابعة؟')) return;
    const result = await window.api.invoke('delete:sale', saleId);
    if (result.success) {
      showToast('success', result.message);
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  // Print invoice - uses default settings, with quick override
  const printInvoice = async (sale: any, overridePaperSize?: string) => {
    const settings = await window.api.invoke('settings:getAll');
    const template = settings.default_invoice_template || '1';
    const paperSize = overridePaperSize || settings.paper_size || '80mm';
    const defaultAction = settings.print_default_action || 'preview';

    // Fetch sale details
    const details = await window.api.invoke('sales:get', sale.SaleID);

    let type = 'sale';
    const invoiceData: any = {
      ...sale,
      items: details.details,
      subtotal: sale.Subtotal,
      discount: sale.Discount,
      taxRate: sale.TaxRate,
      taxAmount: sale.TaxAmount,
      totalAmount: sale.TotalAmount,
      paidAmount: sale.PaidAmount,
      remaining: sale.RemainingAmount,
      date: sale.Date,
      saleNumber: sale.SaleNumber,
      customerName: sale.CustomerName,
      customerPhone: sale.CustomerPhone,
    };

    if (sale.Source === 'maintenance' && sale.SourceID) {
      type = 'maintenance';
      const maintInfo = await window.api.invoke('statement:getOperationDetail', 'maintenance_delivery', sale.SourceID);
      if (maintInfo?.primary) {
        invoiceData.deviceModel = maintInfo.primary.DeviceModel;
        invoiceData.deviceIMEI = maintInfo.primary.DeviceIMEI;
        invoiceData.problemDesc = maintInfo.primary.ProblemDesc;
        invoiceData.ticketNumber = maintInfo.primary.TicketNumber;
      }
    }

    const printData = { type, paperSize, template, companyInfo: settings, invoiceData };

    // Use default action (preview or direct print)
    await window.api.invoke(defaultAction === 'print' ? 'print:invoice' : 'print:preview', printData);
  };

  // Preview invoice template before saving
  const previewInvoiceTemplate = async () => {
    if (cart.length === 0) { showToast('error', 'السلة فارغة'); return; }
    const settings = await window.api.invoke('settings:getAll');
    const template = settings.default_invoice_template || '1';
    const paperSize = settings.paper_size || '80mm';

    const customer = customers.find(c => c.CustomerID === parseInt(selectedCustomer));
    const paid = parseFloat(paidAmount) || 0;

    await window.api.invoke('print:preview', {
      type: 'sale',
      paperSize,
      template,
      companyInfo: settings,
      invoiceData: {
        saleNumber: 'معاينة',
        date: new Date().toISOString().split('T')[0],
        customerName: customer?.Name || customerName || 'عميل نقدي',
        customerPhone: customer?.Phone || customerPhone || '',
        items: cart.map(c => ({
          ItemName: c.ItemName,
          IMEI: c.IMEI,
          Quantity: c.Quantity,
          UnitPrice: c.UnitPrice,
        })),
        subtotal,
        discount: discountAmount,
        taxRate: taxEnabled ? taxRate : 0,
        taxAmount,
        totalAmount: total,
        paidAmount: paid,
        remaining: total - paid,
      },
    });
  };

  /** Loads an existing invoice into the form for editing. */
  const startEdit = async (saleId: number) => {
    const res = await window.api.invoke('sales:get', saleId);
    if (!res?.sale) { showToast('error', 'تعذّر تحميل الفاتورة'); return; }
    const { sale, details } = res;
    setEditingSaleId(saleId);
    setSelectedCustomer(sale.CustomerID ? String(sale.CustomerID) : '');
    setCustomerName(sale.CustomerName || '');
    setCustomerPhone(sale.CustomerPhone || '');
    setCart((details || []).map((d: any) => ({
      uid: `edit-${d.DetailID || Date.now()}-${Math.random()}`,
      ItemID: d.ItemID || undefined,
      ItemName: d.ItemName || d.IMEI || 'بند',
      SerialID: d.SerialID || undefined,
      IMEI: d.IMEI || undefined,
      Quantity: d.Quantity,
      UnitPrice: d.UnitPrice,
      UnitCost: d.UnitCost,
      isService: d.ItemID == null,
    })));
    setDiscount(sale.Discount ? String(sale.Discount) : '');
    setTaxEnabled(!!sale.TaxAmount);
    setPaidAmount(sale.PaidAmount ? String(sale.PaidAmount) : '');
    setPaymentMethod(sale.PaymentMethod || 'cash');
    setCashAccountId(sale.CashAccountID ? String(sale.CashAccountID) : '');
    setPaymentMethodId(sale.PaymentMethodID ? String(sale.PaymentMethodID) : '');
    setTransferCost(sale.TransferCost ? String(sale.TransferCost) : '');
    setFeeBearer(sale.TransferCostBearer === 'customer' ? 'customer' : 'shop');
    setNotes(sale.Notes || '');
    setShowSaleModal(true);
  };

  /** Opens the credit-note screen for an invoice, showing what is still returnable. */
  const startReturn = async (sale: any) => {
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
    setShowReturnModal(true);
  };

  const returnTotal = Math.round(returnLines.reduce(
    (sum, l) => sum + (Number(l.ReturnQty) || 0) * (l.UnitPrice || 0), 0) * 100) / 100;

  const hasCustomerAccount = !!returnSale?.CustomerID;
  const retAllocated = Math.round(
    ((parseFloat(retAccountCredit) || 0) + (parseFloat(retCashRefund) || 0)
      + (parseFloat(retTransferRefund) || 0)) * 100) / 100;
  const retUnallocated = Math.round((returnTotal - retAllocated) * 100) / 100;

  /**
   * Pre-fills a sensible split whenever the returned quantities change.
   * Only a starting point — every field stays editable.
   */
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
      // The settlement the user chose. The server validates that the three
      // parts add up to the return value before touching any balance.
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

  /** Prints a CREDIT NOTE for a return — never the original sale invoice. */
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

  // Quick print with specific paper size
  const [showPrintMenu, setShowPrintMenu] = useState<number | null>(null);

  // Get stock label for item dropdown
  const getStockLabel = (it: any) => {
    if (it.IsSerialized) return `(متاح: ${it.AvailableSerials || 0})`;
    return `(متاح: ${it.TotalStock || 0} ${it.Unit || ''})`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">{mode === 'returns' ? 'مرتجعات المبيعات' : 'المبيعات'}</h1>
        <Button onClick={() => { resetForm(); setShowSaleModal(true); }} icon={<Plus size={16} />}>فاتورة جديدة</Button>
      </div>

      <div className={`flex gap-2 border-b border-slate-200 dark:border-slate-700 ${mode ? 'hidden' : ''}`}>
        <button onClick={() => setTab('sales')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'sales' ? 'border-primary-600 text-primary-600'
                            : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
          <FileText size={16} /> فواتير البيع ({sales.length})
        </button>
        <button onClick={() => setTab('returns')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'returns' ? 'border-primary-600 text-primary-600'
                              : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
          <Undo2 size={16} /> مرتجعات البيع ({returns.length})
        </button>
      </div>

      {tab === 'returns' ? (
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
                <button onClick={() => printReturn(r)} className="p-1.5 rounded text-slate-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20" title="طباعة مرتجع (بالإعداد الافتراضي)"><Printer size={14} /></button>
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
      ) : (
      <DataTable
        columns={[
          { key: 'SaleNumber', title: 'رقم الفاتورة', render: (row) => <span className="font-mono text-xs">{row.SaleNumber}</span> },
          { key: 'Date', title: 'التاريخ' },
          { key: 'CustomerName', title: 'العميل', render: (row) => row.CustomerName || '—' },
          { key: 'TotalAmount', title: 'الإجمالي', render: (row) => <span className="font-bold">{row.TotalAmount?.toFixed(2)}</span> },
          { key: 'actions', title: 'طباعة', render: (row) => (
            <div className="flex items-center gap-1 relative">
              <button onClick={() => printInvoice(row)} className="p-1.5 rounded text-slate-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20" title="طباعة (بالإعداد الافتراضي)"><Printer size={14} /></button>
              <button onClick={() => setShowPrintMenu(showPrintMenu === row.SaleID ? null : row.SaleID)} className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" title="خيارات الطباعة">
                <ChevronDown size={12} />
              </button>
              {showPrintMenu === row.SaleID && (
                <div className="absolute top-full right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 w-40">
                  <button onClick={() => { printInvoice(row); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">الإعداد الافتراضي</button>
                  <div className="border-t border-slate-100 dark:border-slate-700"></div>
                  <button onClick={() => { printInvoice(row, '80mm'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">حراري 80mm</button>
                  <button onClick={() => { printInvoice(row, '58mm'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">حراري 58mm</button>
                  <button onClick={() => { printInvoice(row, 'A5'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">A5</button>
                  <button onClick={() => { printInvoice(row, 'A4'); setShowPrintMenu(null); }} className="w-full text-right px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">A4</button>
                </div>
              )}
            </div>
          )},
          { key: 'ops', title: '', render: (row) => (
            <div className="flex items-center gap-1">
              <button onClick={() => startEdit(row.SaleID)}
                className="p-1.5 rounded text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                title="تعديل الفاتورة"><Pencil size={14} /></button>
              <button onClick={() => startReturn(row)}
                className="p-1.5 rounded text-slate-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                title="مرتجع بيع"><Undo2 size={14} /></button>
              <button onClick={() => handleDeleteSale(row.SaleID)}
                className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="حذف"><Trash2 size={14} /></button>
            </div>
          )},
        ]}
        data={sales}
        keyField="SaleID"
        emptyMessage="لا توجد فواتير"
      />
      )}

      {/* Sale Modal */}
      <Modal isOpen={showSaleModal} onClose={() => { setShowSaleModal(false); resetForm(); }} title={editingSaleId ? 'تعديل فاتورة بيع' : 'فاتورة بيع جديدة'} size="xl"
        footer={<>
          <Button variant="secondary" onClick={() => { setShowSaleModal(false); resetForm(); }}>إلغاء</Button>
          <Button variant="outline" onClick={previewInvoiceTemplate} icon={<Eye size={16} />}>معاينة الفاتورة</Button>
          <Button onClick={handleSale} icon={<ShoppingCart size={16} />}>{editingSaleId ? 'حفظ التعديل' : 'إتمام البيع'}</Button>
        </>}
      >
        <div className="space-y-4">
          {/* Customer */}
          <div className="grid grid-cols-3 gap-3">
            <Select label="العميل" value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)}>
              <option value="">— عميل نقدي —</option>
              {customers.map((c: any) => <option key={c.CustomerID} value={c.CustomerID}>{c.Name} ({c.Phone || '—'})</option>)}
            </Select>
            {!selectedCustomer && <>
              <Input label="الاسم" value={customerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomerName(e.target.value)} />
              <Input label="الهاتف" value={customerPhone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomerPhone(e.target.value)} />
            </>}
            {selectedCustomerObj && <>
              <Input label="الهاتف" value={selectedCustomerObj.Phone || ''} disabled />
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">الرصيد السابق</label>
                <div className={`px-3 py-2 rounded-lg text-sm font-bold ${selectedCustomerObj.Balance > 0 ? 'text-red-600 bg-red-50 dark:bg-red-900/20' : selectedCustomerObj.Balance < 0 ? 'text-green-600 bg-green-50 dark:bg-green-900/20' : 'text-slate-500 bg-slate-50 dark:bg-slate-700/30'}`}>
                  {selectedCustomerObj.Balance > 0
                    ? `${selectedCustomerObj.Balance?.toFixed(2)} مدين`
                    : selectedCustomerObj.Balance < 0
                      ? `${Math.abs(selectedCustomerObj.Balance || 0).toFixed(2)} دائن (مستحق له)`
                      : '0.00'}
                </div>
                {selectedCustomerObj.Balance < 0 && (
                  <div className="mt-1 text-xs text-green-600 bg-green-50 dark:bg-green-900/20 rounded p-1.5">
                    💡 هذا العميل لديه رصيد دائن بقيمة {Math.abs(selectedCustomerObj.Balance).toFixed(2)} — يمكنك خصم الفاتورة من رصيده
                  </div>
                )}
              </div>
            </>}
          </div>

          {/* Add product / item */}
          <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-4">
                <Select label="الصنف" value={selectedItem} onChange={(e) => onItemSelected(e.target.value)}>
                  <option value="">— اختر صنفاً —</option>
                  {items.map((it: any) => (
                    <option key={it.ItemID} value={it.ItemID}>
                      {it.ItemName} {getStockLabel(it)}
                    </option>
                  ))}
                </Select>
              </div>
              {availableSerials.length > 0 && (
                <div className="col-span-3">
                  <Select label="IMEI" value={selectedSerial} onChange={(e) => setSelectedSerial(e.target.value)}>
                    <option value="">— اختر —</option>
                    {availableSerials.map((s: any) => <option key={s.SerialID} value={s.SerialID}>{s.IMEI}</option>)}
                  </Select>
                </div>
              )}
              {availableSerials.length === 0 && selectedItem && (
                <div className="col-span-2"><Input label="الكمية" type="number" value={itemQty} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemQty(e.target.value)} /></div>
              )}
              <div className="col-span-2"><Input label="السعر" type="number" value={itemPrice} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemPrice(e.target.value)} /></div>
              <div className="col-span-2"><Button onClick={addToCart} icon={<Plus size={14} />} size="sm">إضافة</Button></div>
            </div>
          </div>

          {/* Add service / custom line */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-2">
              <Wrench size={14} className="text-blue-600" />
              <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">إضافة خدمة / بند مخصص (بدون مخزون)</span>
            </div>
            <div className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-4">
                <Input label="اسم الخدمة" value={serviceName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServiceName(e.target.value)} placeholder="مثال: تركيب شاشة، فك رمز..." />
              </div>
              <div className="col-span-2">
                <Input label="سعر الخدمة (للعميل)" type="number" value={servicePrice} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServicePrice(e.target.value)} />
              </div>
              <div className="col-span-2">
                <Input label="تكلفة الخدمة" type="number" value={serviceCost} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServiceCost(e.target.value)} />
              </div>
              <div className="col-span-2">
                <Input label="الكمية" type="number" value={serviceQty} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServiceQty(e.target.value)} />
              </div>
              <div className="col-span-2">
                <Button onClick={addServiceToCart} variant="secondary" icon={<Plus size={14} />} size="sm">إضافة</Button>
              </div>
            </div>
          </div>

          {/* Cart */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 dark:bg-slate-800/50">
                <th className="px-3 py-2 text-right">الصنف</th>
                <th className="px-3 py-2 text-right">IMEI</th>
                <th className="px-3 py-2 text-right">النوع</th>
                <th className="px-3 py-2 text-right">الكمية</th>
                <th className="px-3 py-2 text-right">السعر</th>
                <th className="px-3 py-2 text-right">التكلفة</th>
                <th className="px-3 py-2 text-right">الربح</th>
                <th className="px-3 py-2 text-right">الإجمالي</th>
                <th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {cart.length === 0 ? <tr><td colSpan={9} className="px-3 py-4 text-center text-slate-500 dark:text-slate-400">السلة فارغة</td></tr> :
                  cart.map((item, idx) => {
                    const lineTotal = item.Quantity * item.UnitPrice;
                    const lineCost = (item.UnitCost || 0) * item.Quantity;
                    const lineProfit = lineTotal - lineCost;
                    return (
                    <tr key={item.uid} className="border-t border-slate-100 dark:border-slate-700/50">
                      <td className="px-3 py-2 font-medium">{item.ItemName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.IMEI || '—'}</td>
                      <td className="px-3 py-2">
                        {item.isService ? <Badge variant="blue">خدمة</Badge> : item.IMEI ? <Badge variant="purple">هاتف</Badge> : <Badge variant="green">منتج</Badge>}
                      </td>
                      <td className="px-3 py-2">{item.Quantity}</td>
                      <td className="px-3 py-2">{item.UnitPrice.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-500 dark:text-slate-400">{(item.UnitCost || 0).toFixed(2)}</td>
                      <td className={`px-3 py-2 font-bold ${lineProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{lineProfit.toFixed(2)}</td>
                      <td className="px-3 py-2 font-bold">{lineTotal.toFixed(2)}</td>
                      <td className="px-3 py-2"><button onClick={() => removeFromCart(item.uid)} className="text-red-500 hover:text-red-600"><Trash2 size={14} /></button></td>
                    </tr>
                    );
                  })
                }
              </tbody>
            </table>
          </div>

          {/* Totals & Payment */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">الإجمالي الفرعي</span><span className="font-medium text-slate-800 dark:text-white">{subtotal.toFixed(2)}</span></div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} className="w-4 h-4" />
                <span className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400">ضريبة ({taxRate}%)</span>
                <span className="font-medium mr-auto text-slate-800 dark:text-white">{taxAmount.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400">خصم</span>
                <input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} className="w-24 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm" />
              </div>
              <div className="flex justify-between text-lg font-bold border-t border-slate-200 dark:border-slate-700 pt-2"><span className="text-slate-800 dark:text-white">الإجمالي</span><span className="text-primary-600">{total.toFixed(2)}</span></div>
            </div>
            <div className="space-y-3">
              {/* المبلغ المحصل */}
              <Input
                label="المبلغ المحصّل من العميل"
                type="number"
                value={paidAmount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPaidAmount(e.target.value)}
                hint={`إجمالي الفاتورة: ${total.toFixed(2)}`}
              />

              {/* عرض المتبقي أو الزيادة لحظياً */}
              {paidAmount && parseFloat(paidAmount) !== total && (
                <div className={`rounded-lg p-2 text-sm font-bold text-center ${
                  (parseFloat(paidAmount) || 0) < total
                    ? 'bg-red-50 dark:bg-red-900/20 text-red-600'
                    : 'bg-green-50 dark:bg-green-900/20 text-green-600'
                }`}>
                  {(parseFloat(paidAmount) || 0) < total
                    ? `المتبقي على العميل: ${(total - (parseFloat(paidAmount) || 0)).toFixed(2)}`
                    : `زيادة للعميل: ${((parseFloat(paidAmount) || 0) - total).toFixed(2)} (تُخصم من رصيده)`
                  }
                </div>
              )}

              {/* مصدر الاستلام - يظهر فقط إذا دفع مبلغ */}
              {parseFloat(paidAmount) > 0 && (
                <>
                  {/* The money lands in ONE account. Choosing a machine/wallet
                      clears the safe selection (and vice-versa) so the invoice
                      can never credit two accounts for a single payment. */}
                  <Select label="مصدر استلام المبلغ" value={cashAccountId}
                    onChange={(e) => { setCashAccountId(e.target.value); if (e.target.value) { setPaymentMethodId(''); setPaymentMethod('cash'); } }}>
                    <option value="">— اختر الخزنة/البنك —</option>
                    {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
                  </Select>
                  <Select label="أو ماكينة/محفظة دفع" value={paymentMethodId}
                    onChange={(e) => { setPaymentMethodId(e.target.value); if (e.target.value) { setCashAccountId(''); setPaymentMethod('wallet'); } }}>
                    <option value="">— بدون —</option>
                    {paymentMethods.map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName} ({pm.Balance?.toFixed(2)})</option>)}
                  </Select>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    يتم استلام المبلغ في حساب واحد فقط — اختيار الماكينة يلغي اختيار الخزنة.
                  </div>
                  {(paymentMethod === 'transfer' || paymentMethod === 'wallet' || paymentMethod === 'card') && (
                    <>
                      <Input label="عمولة الماكينة / المحفظة" type="number" value={transferCost}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTransferCost(e.target.value)}
                        hint="المبلغ الذي تخصمه الماكينة أو المحفظة على هذه العملية" />
                      {parseFloat(transferCost) > 0 && (
                        <>
                          <Select label="من يتحمل العمولة؟" value={feeBearer}
                            onChange={(e) => setFeeBearer(e.target.value as 'shop' | 'customer')}>
                            <option value="shop">المحل يتحمّلها (تُخصم من المبلغ الواصل لك)</option>
                            <option value="customer">العميل يدفعها (فوق قيمة الفاتورة)</option>
                          </Select>
                          {/* Spelled out in money, because "commission" alone is
                              exactly what was unclear. */}
                          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                            {feeBearer === 'shop' ? (
                              <>
                                <div>العميل يدفع: <b>{(parseFloat(paidAmount) || 0).toFixed(2)}</b></div>
                                <div>الماكينة تخصم: <b>{(parseFloat(transferCost) || 0).toFixed(2)}</b></div>
                                <div>يصل إلى حسابك: <b>{((parseFloat(paidAmount) || 0) - (parseFloat(transferCost) || 0)).toFixed(2)}</b></div>
                                <div className="pt-1 border-t border-amber-200 dark:border-amber-800">العمولة تُسجَّل كمصروف على المحل.</div>
                              </>
                            ) : (
                              <>
                                <div>العميل يدفع: <b>{(parseFloat(paidAmount) || 0).toFixed(2)}</b> (الفاتورة تشمل العمولة)</div>
                                <div>الماكينة تخصم: <b>{(parseFloat(transferCost) || 0).toFixed(2)}</b></div>
                                <div>يصل إلى حسابك: <b>{((parseFloat(paidAmount) || 0) - (parseFloat(transferCost) || 0)).toFixed(2)}</b></div>
                                <div className="pt-1 border-t border-amber-200 dark:border-amber-800">العمولة داخل الفاتورة — يدفعها العميل ولا تُسجَّل كمصروف.</div>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              )}

              {/* إذا لم يدفع شيئاً = آجل بالكامل */}
              {(!paidAmount || parseFloat(paidAmount) === 0) && cart.length > 0 && (
                <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2 text-sm text-orange-600 dark:text-orange-300 text-center">
                  فاتورة آجلة - المبلغ كامل على حساب العميل
                </div>
              )}
            </div>
          </div>

          {/* Profit summary */}
          {cart.length > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 flex items-center justify-between">
              <span className="text-sm font-medium text-green-700 dark:text-green-300">
                الربح المتوقع (الإيراد - التكاليف{transferCost && feeBearer === 'shop' ? ' - عمولة الماكينة' : ''})
              </span>
              <span className="text-lg font-bold text-green-600">
                {(subtotal - discountAmount - cart.reduce((s, i) => s + (i.UnitCost || 0) * i.Quantity, 0) - (feeBearer === 'shop' ? (parseFloat(transferCost) || 0) : 0)).toFixed(2)}
              </span>
            </div>
          )}
        </div>
      </Modal>

      {/* Sale return (credit note) */}
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
                          // Clamped here as well as on the server, so the total
                          // shown can never promise a refund the server refuses.
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

          {/* --- How the value is settled. Chosen, not computed. --- */}
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

              {/* The running check: the three parts must add up exactly. */}
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
