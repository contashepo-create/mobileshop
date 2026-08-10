import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Wrench, Smartphone, Eye, X, ArrowRight, ClipboardList, Package, DollarSign, MessageSquare, Trash2, CheckCircle, Printer, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { useAuthStore } from '../../stores/auth.store';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';

const statusLabels: Record<string, string> = {
  received: 'مستلم', inspecting: 'فحص', in_progress: 'قيد العمل',
  ready: 'جاهز للتسليم', delivered: 'تم التسليم', returned: 'مرتجع', cancelled: 'ملغي'
};
const statusVariants: Record<string, 'gray' | 'blue' | 'yellow' | 'orange' | 'green' | 'red' | 'purple'> = {
  received: 'blue', inspecting: 'yellow', in_progress: 'orange',
  ready: 'purple', delivered: 'green', returned: 'red', cancelled: 'gray'
};

const nextStatuses: Record<string, string[]> = {
  received: ['inspecting', 'in_progress', 'ready', 'cancelled'],
  inspecting: ['in_progress', 'ready', 'received', 'cancelled'],
  in_progress: ['ready', 'inspecting', 'received', 'cancelled'],
  ready: ['delivered', 'in_progress', 'cancelled'],
  delivered: [],
  returned: ['in_progress', 'ready', 'cancelled'],
  cancelled: [],
};

export function MaintenancePage() {
  const { showToast } = useToastStore();
  const user = useAuthStore((s) => s.user);
  const userId = user?.userId || 1;
  const [tickets, setTickets] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [customers, setCustomers] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);

  // Receive modal
  const [showReceive, setShowReceive] = useState(false);
  const [recvForm, setRecvForm] = useState({ CustomerID: '', CustomerName: '', CustomerPhone: '', DeviceModel: '', DeviceIMEI: '', ProblemDesc: '', Accessories: '', DevicePassword: '', AgreedDeliveryDate: '', AgreedCost: '', TechnicianID: '', MaintenanceType: 'normal', ReferenceTicketID: '' });

  // Workbench state
  const [workbenchTicketId, setWorkbenchTicketId] = useState<number | null>(null);
  const [wbData, setWbData] = useState<any>(null);
  const [newStatus, setNewStatus] = useState('');
  const [statusNotes, setStatusNotes] = useState('');
  const [newNote, setNewNote] = useState('');
  const [wbLoading, setWbLoading] = useState(false);

  // Part issue
  const [showIssuePart, setShowIssuePart] = useState(false);
  const [partForm, setPartForm] = useState({ ItemID: '', Quantity: '1', UnitCost: '', SalePrice: '', WarehouseID: '' });

  // Service cost
  const [svcDesc, setSvcDesc] = useState('');
  const [svcCostOnUs, setSvcCostOnUs] = useState('');
  const [svcPrice, setSvcPrice] = useState('');

  // Service usage
  const [usageForm, setUsageForm] = useState({ ItemID: '', Description: '', CostOnUs: '', PriceToClient: '', Quantity: '1' });

  // Delivery
  const [showDeliver, setShowDeliver] = useState(false);
  const [deliverForm, setDeliverForm] = useState({ LaborCost: '', PaidAmount: '', CashAccountID: '', PaymentMethodID: '', Discount: '', FinalPrice: '', FinalNotes: '' });

  // Cancel
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // Warranty
  const [warrantyHistory, setWarrantyHistory] = useState<any[]>([]);

  // Delivery success
  const [showDeliverySuccess, setShowDeliverySuccess] = useState(false);
  const [deliveryResult, setDeliveryResult] = useState<any>(null);

  // Preview
  const [showPreview, setShowPreview] = useState(false);
  const [previewTicket, setPreviewTicket] = useState<any>(null);

  // Financial summary
  const [finSummary, setFinSummary] = useState<any>(null);
  const notesEndRef = useRef<HTMLDivElement>(null);

  // Warehouse-specific items for part issue
  const [warehouseItems, setWarehouseItems] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    const [t, cu, em, ca, pm, it, wh] = await Promise.all([
      window.api.invoke('maintenance:list', { status: statusFilter }),
      window.api.invoke('customers:list'),
      window.api.invoke('employees:list', { isActive: 1 }),
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
      window.api.invoke('items:list', { isActive: 1 }),
      window.api.invoke('warehouses:list'),
    ]);
    setTickets(t); setCustomers(cu); setEmployees(em); setCashAccounts(ca); setPaymentMethods(pm);
    setInventoryItems(it); setWarehouses(wh);
  }, [statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (notesEndRef.current) {
      notesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [wbData?.notes]);

  const loadWarehouseItems = async (warehouseId: string) => {
    if (!warehouseId) { setWarehouseItems([]); return; }
    const items = await window.api.invoke('items:listByWarehouse', parseInt(warehouseId));
    setWarehouseItems(items);
  };

  const loadWorkbench = async (ticketId: number) => {
    setWbLoading(true);
    setWorkbenchTicketId(ticketId);
    const result = await window.api.invoke('maintenance:get', ticketId);
    // `if (workbenchTicketId && wbData)` opens the workbench on a truthy value,
    // and the very first thing it reads is `wbData.ticket.TicketNumber`. A
    // refusal has no `ticket`, so the technician's screen would go blank.
    if (isFailure(result)) {
      showToast('error', failureMessage(result, 'تعذر فتح أمر الصيانة'));
      setWorkbenchTicketId(null);
      setWbData(null);
      setWbLoading(false);
      return;
    }
    setWbData(result);
    setNewStatus('');
    setStatusNotes('');
    setNewNote('');

    const fin = await window.api.invoke('maintenance:getFinancialSummary', ticketId);
    setFinSummary(fin);

    const history = await window.api.invoke('maintenance:getWarrantyHistory', ticketId);
    setWarrantyHistory(history);

    setWbLoading(false);
  };

  const refreshWorkbench = async () => {
    if (!workbenchTicketId) return;
    await loadWorkbench(workbenchTicketId);
  };

  const closeWorkbench = () => {
    setWorkbenchTicketId(null);
    setWbData(null);
    setFinSummary(null);
    fetchData();
  };

  // === Status Change ===
  const handleStatusChange = async () => {
    if (!workbenchTicketId || !newStatus) { showToast('error', 'اختر الحالة الجديدة'); return; }
    if (!statusNotes.trim()) { showToast('error', 'الملاحظات إجبارية عند تغيير الحالة'); return; }
    const result = await window.api.invoke('maintenance:updateStatus', workbenchTicketId, newStatus, statusNotes, userId);
    if (result.success) {
      showToast('success', `تم تغيير الحالة إلى: ${statusLabels[newStatus]}`);
      setNewStatus('');
      setStatusNotes('');
      await refreshWorkbench();
    } else {
      showToast('error', result.message);
    }
  };

  // === Parts ===
  const handleIssuePart = async () => {
    if (!partForm.ItemID || !partForm.Quantity || !partForm.WarehouseID) {
      showToast('error', 'اكمل بيانات القطعة'); return;
    }
    const qty = parseFloat(partForm.Quantity) || 1;
    const warehouseItem = warehouseItems.find(i => i.ItemID === parseInt(partForm.ItemID));
    if (!warehouseItem) {
      showToast('error', 'القطعة غير موجودة في هذا المخزن'); return;
    }
    if (qty > warehouseItem.StockQuantity) {
      showToast('error', `الكمية المطلوبة (${qty}) أكبر من المتاح (${warehouseItem.StockQuantity})`); return;
    }
    const result = await window.api.invoke('maintenance:issuePart', {
      TicketID: workbenchTicketId,
      ItemID: parseInt(partForm.ItemID),
      Quantity: parseFloat(partForm.Quantity) || 1,
      UnitCost: parseFloat(partForm.UnitCost) || undefined,
      SalePrice: parseFloat(partForm.SalePrice) || undefined,
      WarehouseID: parseInt(partForm.WarehouseID),
      userId,
    });
    if (result.success) {
      showToast('success', 'تم إضافة القطعة');
      setShowIssuePart(false);
      setPartForm({ ItemID: '', Quantity: '1', UnitCost: '', SalePrice: '', WarehouseID: '' });
      await refreshWorkbench();
    } else {
      showToast('error', result.message);
    }
  };

  const handleRemovePart = async (partId: number) => {
    if (!confirm('إزالة القطعة وإعادتها للمخزن؟')) return;
    const result = await window.api.invoke('maintenance:removePart', partId, workbenchTicketId, userId);
    if (result.success) {
      showToast('success', 'تم إزالة القطعة');
      await refreshWorkbench();
    }
  };

  // === Service Costs ===
  const handleAddServiceCost = async () => {
    if (!svcDesc.trim()) { showToast('error', 'وصف الخدمة مطلوب'); return; }
    const result = await window.api.invoke('maintenance:addServiceCost', {
      TicketID: workbenchTicketId,
      Description: svcDesc,
      CostOnUs: parseFloat(svcCostOnUs) || 0,
      PriceToClient: parseFloat(svcPrice) || 0,
      userId,
    });
    if (result.success) {
      showToast('success', 'تمت إضافة الخدمة');
      setSvcDesc(''); setSvcCostOnUs(''); setSvcPrice('');
      await refreshWorkbench();
    }
  };

  const handleRemoveServiceCost = async (costId: number) => {
    await window.api.invoke('maintenance:removeServiceCost', costId);
    await refreshWorkbench();
  };

  // === Service Usage ===
  const handleAddUsage = async () => {
    if (!usageForm.Description.trim()) { showToast('error', 'وصف الخدمة مطلوب'); return; }
    const result = await window.api.invoke('maintenance:addServiceUsage', {
      TicketID: workbenchTicketId,
      Description: usageForm.Description,
      CostOnUs: parseFloat(usageForm.CostOnUs) || 0,
      PriceToClient: parseFloat(usageForm.PriceToClient) || 0,
      Quantity: parseFloat(usageForm.Quantity) || 1,
      ItemID: usageForm.ItemID ? parseInt(usageForm.ItemID) : undefined,
      userId,
    });
    if (result.success) {
      showToast('success', 'تمت الإضافة');
      setUsageForm({ ItemID: '', Description: '', CostOnUs: '', PriceToClient: '', Quantity: '1' });
      await refreshWorkbench();
    }
  };

  const handleRemoveUsage = async (usageId: number) => {
    await window.api.invoke('maintenance:removeServiceUsage', usageId);
    await refreshWorkbench();
  };

  // === Notes ===
  const handleAddNote = async () => {
    if (!newNote.trim()) { showToast('error', 'محتوى الملاحظة مطلوب'); return; }
    const result = await window.api.invoke('maintenance:addNote', { TicketID: workbenchTicketId, Content: newNote, userId });
    if (!result.success) { showToast('error', result.message || 'فشل إضافة الملاحظة'); return; }
    showToast('success', 'تمت إضافة الملاحظة');
    setNewNote('');
    await refreshWorkbench();
  };

  // === Deliver ===
  const openDeliverModal = () => {
    const t = wbData?.ticket;
    // Calculate the FULL total: parts + services + usage + labor
    // (not just service costs — the old code used finSummary.totalPriceToClient
    // which excluded parts and labor, so the "paid" field showed a partial amount)
    const _partsSale = wbData?.parts?.reduce((s: number, p: any) => s + ((p.SalePrice || p.UnitCost) * p.Quantity), 0) || 0;
    const _svcPrice = wbData?.serviceCosts?.reduce((s: number, c: any) => s + (c.PriceToClient || 0), 0) || 0;
    const _usagePrice = wbData?.serviceUsage?.reduce((s: number, u: any) => s + ((u.PriceToClient || 0) * (u.Quantity || 1)), 0) || 0;
    const _labor = t?.AgreedCost || 0;
    const _total = _partsSale + _svcPrice + _usagePrice + _labor;
    setDeliverForm({
      LaborCost: t?.AgreedCost?.toString() || '',
      PaidAmount: _total.toFixed(2),
      CashAccountID: '', PaymentMethodID: '', Discount: '', FinalPrice: '',
      FinalNotes: '',
    });
    setShowDeliver(true);
  };

  const handleDeliver = async () => {
    if (!workbenchTicketId) return;
    const paidAmount = parseFloat(deliverForm.PaidAmount) || 0;
    const finalPrice = parseFloat(deliverForm.FinalPrice) || 0;
    const discount = parseFloat(deliverForm.Discount) || 0;

    // Re-fetch ticket from DB to get latest CustomerID (may have been auto-registered)
    const freshTicket = await window.api.invoke('maintenance:get', workbenchTicketId);
    const effectiveCustomerId = freshTicket?.ticket?.CustomerID || wbData?.ticket?.CustomerID;
    if (!effectiveCustomerId && (finalPrice - paidAmount) > 0) {
      showToast('error', 'العميل النقدي يجب أن يدفع المبلغ كاملاً');
      return;
    }
    if (paidAmount > 0 && !deliverForm.CashAccountID && !deliverForm.PaymentMethodID) {
      showToast('error', 'اختر مصدر استلام المبلغ');
      return;
    }

    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    const result = await window.api.invoke('maintenance:deliver', {
      TicketID: workbenchTicketId,
      CustomerID: effectiveCustomerId,
      CustomerName: wbData?.ticket?.CustomerName,
      CustomerPhone: wbData?.ticket?.CustomerPhone,
      LaborCost: parseFloat(deliverForm.LaborCost) || 0,
      PaymentMethod: paidAmount > 0 ? 'cash' : 'credit',
      PaidAmount: paidAmount,
      CashAccountID: deliverForm.CashAccountID ? parseInt(deliverForm.CashAccountID) : undefined,
      PaymentMethodID: deliverForm.PaymentMethodID ? parseInt(deliverForm.PaymentMethodID) : undefined,
      Discount: discount,
      FinalPrice: finalPrice || undefined,
      FinalNotes: deliverForm.FinalNotes,
      userId,
      fiscalYearId: activeFy.FiscalYearID,
    });

    if (result.success) {
      setDeliveryResult(result);
      setShowDeliverySuccess(true);
      setShowDeliver(false);
    } else {
      showToast('error', result.message || 'فشل');
    }
  };

  // === Print delivery invoice ===
  const printDeliveryInvoice = async () => {
    if (!deliveryResult?.saleNumber) return;
    const settings = await window.api.invoke('settings:getAll');
    const template = settings.default_invoice_template || '1';
    const paperSize = settings.paper_size || '80mm';
    const defaultAction = settings.print_default_action || 'preview';
    const salesList = await window.api.invoke('sales:list', {});
    const sale = salesList.find((s: any) => s.SaleNumber === deliveryResult.saleNumber);
    if (!sale) { showToast('error', 'فاتورة الصيانة غير موجودة'); return; }
    const details = await window.api.invoke('sales:get', sale.SaleID);
    const maintInfo = await window.api.invoke('statement:getOperationDetail', 'maintenance_delivery', sale.SourceID);
    const invoiceData: any = {
      ...sale,
      items: details.details,
      subtotal: sale.Subtotal, discount: sale.Discount,
      taxRate: sale.TaxRate, taxAmount: sale.TaxAmount,
      totalAmount: sale.TotalAmount, paidAmount: sale.PaidAmount,
      remaining: sale.RemainingAmount, date: sale.Date,
      saleNumber: sale.SaleNumber, customerName: sale.CustomerName,
      customerPhone: sale.CustomerPhone,
    };
    if (maintInfo?.primary) {
      invoiceData.deviceModel = maintInfo.primary.DeviceModel;
      invoiceData.deviceIMEI = maintInfo.primary.DeviceIMEI;
      invoiceData.problemDesc = maintInfo.primary.ProblemDesc;
      invoiceData.ticketNumber = maintInfo.primary.TicketNumber;
    }
    await window.api.invoke(defaultAction === 'print' ? 'print:invoice' : 'print:preview', {
      type: 'maintenance', paperSize, template, companyInfo: settings, invoiceData,
    });
  };

  // === Cancel ===
  const handleCancel = async () => {
    if (!cancelReason.trim()) { showToast('error', 'سبب الإلغاء مطلوب'); return; }
    if (!confirm('تأكيد إلغاء أمر الصيانة؟ سيتم إعادة كل القطع للمخزن.')) return;
    const result = await window.api.invoke('maintenance:cancel', { TicketID: workbenchTicketId, Reason: cancelReason, userId });
    if (result.success) {
      showToast('success', 'تم إلغاء أمر الصيانة');
      setShowCancel(false);
      setCancelReason('');
      closeWorkbench();
    } else {
       showToast('error', result.message);
     }
   };

   // === Warranty — open new warranty ticket linked to original ===
    const openWarrantyTicket = (originalTicket: any) => {
      setRecvForm({
       CustomerID: originalTicket.CustomerID?.toString() || '',
       CustomerName: originalTicket.CustomerName || '',
       CustomerPhone: originalTicket.CustomerPhone || '',
       DeviceModel: originalTicket.DeviceModel || '',
       DeviceIMEI: originalTicket.DeviceIMEI || '',
       ProblemDesc: '',
       Accessories: '',
       DevicePassword: originalTicket.DevicePassword || '',
       AgreedDeliveryDate: '',
       AgreedCost: '0',
       TechnicianID: originalTicket.TechnicianID?.toString() || '',
       MaintenanceType: 'warranty',
       ReferenceTicketID: String(originalTicket.TicketID),
     });
     setShowReceive(true);
   };

   // === Preview ===
  const openPreview = async (ticket: any) => {
    const details = await window.api.invoke('maintenance:get', ticket.TicketID);
    if (isFailure(details)) {
      showToast('error', failureMessage(details, 'تعذر عرض أمر الصيانة'));
      return;
    }
    setPreviewTicket({ ...details.ticket, parts: details.parts, log: details.log, serviceCosts: details.serviceCosts, serviceUsage: details.serviceUsage, notes: details.notes });
    setShowPreview(true);
  };

  // === Calculations ===
  const partsCostOnUs = wbData?.parts?.reduce((s: number, p: any) => s + (p.TotalCost || 0), 0) || 0;
  const partsSalePrice = wbData?.parts?.reduce((s: number, p: any) => s + ((p.SalePrice || p.UnitCost) * p.Quantity), 0) || 0;
  const servicesCostOnUs = wbData?.serviceCosts?.reduce((s: number, c: any) => s + (c.CostOnUs || 0), 0) || 0;
  const servicesPrice = wbData?.serviceCosts?.reduce((s: number, c: any) => s + (c.PriceToClient || 0), 0) || 0;
  const usageCostOnUs = wbData?.serviceUsage?.reduce((s: number, u: any) => s + ((u.CostOnUs || 0) * (u.Quantity || 1)), 0) || 0;
  const usagePrice = wbData?.serviceUsage?.reduce((s: number, u: any) => s + ((u.PriceToClient || 0) * (u.Quantity || 1)), 0) || 0;
  const laborCost = parseFloat(deliverForm.LaborCost) || 0;
  const deliveryDiscount = parseFloat(deliverForm.Discount) || 0;
  const deliveryPartsTotal = partsSalePrice;
  const deliveryTotal = deliveryPartsTotal + servicesPrice + usagePrice + laborCost;
  const deliveryFinalPrice = parseFloat(deliverForm.FinalPrice) || (deliveryTotal - deliveryDiscount);
  const totalCostOnUs = partsCostOnUs + servicesCostOnUs + usageCostOnUs;
  const expectedProfit = deliveryFinalPrice - totalCostOnUs;

  const selectedWarehouses = warehouses;
  const selectedItems = inventoryItems;

  // ====== RENDER ======
  if (workbenchTicketId && wbData) {
    const t = wbData.ticket;
    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <button onClick={closeWorkbench} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <ArrowRight size={20} className="text-slate-500 dark:text-slate-400" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-800 dark:text-white">
                  {t.TicketNumber}
                </h1>
                <Badge variant={statusVariants[t.Status]}>{statusLabels[t.Status]}</Badge>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t.CustomerName} - {t.DeviceModel} | {t.Date} | {t.Username}
              </p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {!['delivered', 'cancelled'].includes(t.Status) && (
              <>
                <Button size="sm" variant="success" onClick={openDeliverModal} icon={<Smartphone size={14} />}>تسليم</Button>
                <Button size="sm" variant="danger" onClick={() => setShowCancel(true)} icon={<X size={14} />}>إلغاء</Button>
              </>
            )}
             {t.Status === 'returned' && (
               <Button size="sm" variant="success" onClick={openDeliverModal} icon={<Smartphone size={14} />}>إعادة تسليم</Button>
             )}
          </div>
        </div>

        {/* Grid: Info + Timeline + Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Right: Ticket Info */}
          <div className="lg:col-span-1 space-y-4">
            {/* Info card */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">العميل:</span><span className="font-medium text-slate-800 dark:text-white">{t.CustomerName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الهاتف:</span><span className="text-slate-700 dark:text-slate-200">{t.CustomerPhone || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الجهاز:</span><span className="text-slate-700 dark:text-slate-200">{t.DeviceModel}</span></div>
              {t.DeviceIMEI && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">IMEI:</span><span className="font-mono text-xs text-slate-700 dark:text-slate-200">{t.DeviceIMEI}</span></div>}
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الفني:</span><span className="text-slate-700 dark:text-slate-200">{t.TechnicianName || '—'}</span></div>
              {t.DevicePassword && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">كلمة السر:</span><span className="font-mono text-xs text-slate-700 dark:text-slate-200">{t.DevicePassword}</span></div>}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-2"><span className="text-slate-500 dark:text-slate-400">المشكلة:</span><p className="text-slate-700 dark:text-slate-200 mt-1">{t.ProblemDesc}</p></div>
              {t.Accessories && <div><span className="text-slate-500 dark:text-slate-400">المرفقات:</span><span className="text-slate-700 dark:text-slate-200 mr-1">{t.Accessories}</span></div>}
            </div>

            {/* Status Timeline */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-1"><ClipboardList size={14} /> سجل الحالات</h3>
              <div className="space-y-2">
                {wbData.log?.map((l: any, idx: number) => (
                  <div key={idx} className="flex items-start gap-2 text-xs">
                    <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${l.Status === 'cancelled' ? 'bg-red-500' : l.Status === 'delivered' ? 'bg-green-500' : 'bg-primary-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <Badge variant={statusVariants[l.Status] || 'gray'}>{statusLabels[l.Status] || l.Status}</Badge>
                        <span className="text-slate-400 text-[10px]">{l.Date}</span>
                        <span className="text-slate-400 text-[10px]">- {l.Username}</span>
                      </div>
                      {l.Notes && <p className="text-slate-600 dark:text-slate-300 mt-0.5">{l.Notes}</p>}
                    </div>
                  </div>
                ))}
                {(!wbData.log || wbData.log.length === 0) && <p className="text-slate-400 text-xs">لا يوجد سجل</p>}
              </div>
            </div>

            {/* Notes */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-1"><MessageSquare size={14} /> ملاحظات</h3>
              <div className="space-y-2 mb-3 max-h-40 overflow-y-auto">
                {wbData.notes?.map((n: any, idx: number) => (
                  <div key={idx} className="text-xs bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2">
                    <div className="flex items-center gap-2 text-slate-400 mb-1">
                      <span className="font-medium text-slate-600 dark:text-slate-300">{n.Username}</span>
                      <span>{n.CreatedAt}</span>
                    </div>
                    <p className="text-slate-700 dark:text-slate-200">{n.Content}</p>
                  </div>
                ))}
                {(!wbData.notes || wbData.notes.length === 0) && <p className="text-slate-400 text-xs">لا توجد ملاحظات</p>}
                <div ref={notesEndRef} />
              </div>
              <div className="flex gap-2">
                <input type="text" value={newNote} onChange={(e) => setNewNote(e.target.value)}
                  placeholder="أضف ملاحظة..." className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                <Button size="sm" onClick={handleAddNote}>إضافة</Button>
              </div>
            </div>

            {/* Warranty — history + open new warranty ticket */}
            {(t.Status === 'delivered' || t.Status === 'returned' || warrantyHistory.length > 0) && (
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-1"><ShieldCheck size={14} /> الضمان</h3>
                {(t.Status === 'delivered' || t.Status === 'returned') && (
                  <Button size="sm" className="w-full mb-3" onClick={() => openWarrantyTicket(t)} icon={<ShieldCheck size={14} />}>
                    فتح صيانة ضمان
                  </Button>
                )}
                {warrantyHistory.length > 0 && (
                  <div className="space-y-1.5">
                    {warrantyHistory.map((wh: any, idx: number) => (
                      <div key={idx} className={`text-xs p-2 rounded-lg ${wh.TicketID === t.TicketID ? 'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-700' : 'bg-slate-50 dark:bg-slate-700/30'}`}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{wh.TicketNumber}</span>
                          <Badge variant={statusVariants[wh.Status] || 'gray'}>{statusLabels[wh.Status] || wh.Status}</Badge>
                        </div>
                        <div className="text-slate-500 dark:text-slate-400 mt-0.5">{wh.Date} | {wh.DeviceModel}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Status Change */}
            {nextStatuses[t.Status]?.length > 0 && (
              <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3">تغيير الحالة</h3>
                <div className="space-y-2">
                  <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                    <option value="">— اختر الحالة —</option>
                    {nextStatuses[t.Status].map(s => (
                      <option key={s} value={s}>{statusLabels[s] || s}</option>
                    ))}
                  </Select>
                  <textarea value={statusNotes} onChange={(e) => setStatusNotes(e.target.value)}
                    placeholder="ملاحظات إجبارية عن سبب التغيير..."
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" rows={2} />
                  <Button size="sm" className="w-full" onClick={handleStatusChange} disabled={!newStatus}>حفظ التغيير</Button>
                </div>
              </div>
            )}
          </div>

          {/* Left: Parts + Services + Financials */}
          <div className="lg:col-span-2 space-y-4">
            {/* Parts from inventory */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1"><Package size={14} /> قطع الغيار من المخزن</h3>
                {!['delivered', 'cancelled'].includes(t.Status) && (
                  <Button size="sm" variant="secondary" onClick={() => setShowIssuePart(true)} icon={<Plus size={12} />}>إضافة قطعة</Button>
                )}
              </div>
              {wbData.parts?.length > 0 ? (
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-right py-1.5 text-slate-500 dark:text-slate-400">القطعة</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">الكمية</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">تكلفتنا</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">سعر البيع</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">الربح</th>
                    {!['delivered', 'cancelled'].includes(t.Status) && <th className="text-center py-1.5"></th>}
                  </tr></thead>
                  <tbody>
                    {asRows<any>(wbData.parts).map((p: any, idx: number) => {
                      const salePrice = p.SalePrice || p.UnitCost;
                      const profit = (salePrice - p.UnitCost) * p.Quantity;
                      return (
                        <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50">
                          <td className="py-2 font-medium text-slate-700 dark:text-slate-200">{p.ItemName}</td>
                          <td className="py-2 text-center text-slate-600 dark:text-slate-300">{p.Quantity}</td>
                          <td className="py-2 text-center text-red-600">{p.TotalCost?.toFixed(2)}</td>
                          <td className="py-2 text-center text-green-600">{(salePrice * p.Quantity).toFixed(2)}</td>
                          <td className="py-2 text-center font-bold text-slate-700 dark:text-slate-200">{profit.toFixed(2)}</td>
                          {!['delivered', 'cancelled'].includes(t.Status) && (
                            <td className="py-2 text-center"><button onClick={() => handleRemovePart(p.PartID)} className="text-red-500 hover:text-red-700"><Trash2 size={12} /></button></td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-slate-400">لا توجد قطع غيار - أضف قطعاً من المخزن</p>
              )}
              {partsCostOnUs > 0 && (
                <div className="flex justify-between text-xs font-bold border-t border-slate-200 dark:border-slate-700 pt-2 mt-2">
                  <span className="text-slate-600 dark:text-slate-300">الإجمالي: تكلفتنا {partsCostOnUs.toFixed(2)} | سعر البيع {partsSalePrice.toFixed(2)}</span>
                  <span className="text-green-600">ربح: {(partsSalePrice - partsCostOnUs).toFixed(2)}</span>
                </div>
              )}
            </div>

            {/* Service Costs (manual) */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-1"><DollarSign size={14} /> تكاليف الخدمات (يدوي)</h3>
              {!['delivered', 'cancelled'].includes(t.Status) && (
                <div className="flex flex-wrap gap-2 mb-3">
                  <input type="text" value={svcDesc} onChange={(e) => setSvcDesc(e.target.value)} placeholder="وصف الخدمة (سوفت، لحام...)"
                    className="flex-1 min-w-[120px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <input type="number" value={svcCostOnUs} onChange={(e) => setSvcCostOnUs(e.target.value)} placeholder="تكلفتنا"
                    className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <input type="number" value={svcPrice} onChange={(e) => setSvcPrice(e.target.value)} placeholder="سعر للعميل"
                    className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <Button size="sm" onClick={handleAddServiceCost} icon={<Plus size={12} />}>إضافة</Button>
                </div>
              )}
              {wbData.serviceCosts?.length > 0 ? (
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-right py-1.5 text-slate-500 dark:text-slate-400">الخدمة</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">تكلفتنا</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">السعر</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">الربح</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">بواسطة</th>
                    {!['delivered', 'cancelled'].includes(t.Status) && <th></th>}
                  </tr></thead>
                  <tbody>
                    {asRows<any>(wbData.serviceCosts).map((c: any, idx: number) => (
                      <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td className="py-2 text-slate-700 dark:text-slate-200">{c.Description}</td>
                        <td className="py-2 text-center text-red-600">{c.CostOnUs?.toFixed(2)}</td>
                        <td className="py-2 text-center text-green-600">{c.PriceToClient?.toFixed(2)}</td>
                        <td className="py-2 text-center font-bold text-slate-700 dark:text-slate-200">{(c.PriceToClient - c.CostOnUs).toFixed(2)}</td>
                        <td className="py-2 text-center text-slate-400">{c.Username}</td>
                        {!['delivered', 'cancelled'].includes(t.Status) && (
                          <td className="py-2 text-center"><button onClick={() => handleRemoveServiceCost(c.CostID)} className="text-red-500 hover:text-red-700"><Trash2 size={12} /></button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-xs text-slate-400">لا توجد خدمات مضافة</p>}
            </div>

            {/* Service Usage */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-1"><Wrench size={14} /> خدمات إضافية (مخزنية)</h3>
              {!['delivered', 'cancelled'].includes(t.Status) && (
                <div className="flex flex-wrap gap-2 mb-3">
                  <input type="text" value={usageForm.Description} onChange={(e) => setUsageForm({...usageForm, Description: e.target.value})} placeholder="وصف"
                    className="w-28 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <input type="number" value={usageForm.CostOnUs} onChange={(e) => setUsageForm({...usageForm, CostOnUs: e.target.value})} placeholder="تكلفتنا"
                    className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <input type="number" value={usageForm.PriceToClient} onChange={(e) => setUsageForm({...usageForm, PriceToClient: e.target.value})} placeholder="السعر"
                    className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <input type="number" value={usageForm.Quantity} onChange={(e) => setUsageForm({...usageForm, Quantity: e.target.value})} placeholder="الكمية"
                    className="w-16 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-xs" />
                  <Button size="sm" onClick={handleAddUsage} icon={<Plus size={12} />}>إضافة</Button>
                </div>
              )}
              {wbData.serviceUsage?.length > 0 ? (
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-right py-1.5 text-slate-500 dark:text-slate-400">الخدمة</th><th className="text-center py-1.5 text-slate-500 dark:text-slate-400">الكمية</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">تكلفتنا</th><th className="text-center py-1.5 text-slate-500 dark:text-slate-400">السعر</th>
                    <th className="text-center py-1.5 text-slate-500 dark:text-slate-400">الربح</th>
                    {!['delivered', 'cancelled'].includes(t.Status) && <th></th>}
                  </tr></thead>
                  <tbody>
                    {asRows<any>(wbData.serviceUsage).map((u: any, idx: number) => (
                      <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td className="py-2 text-slate-700 dark:text-slate-200">{u.Description}</td>
                        <td className="py-2 text-center text-slate-600 dark:text-slate-300">{u.Quantity}</td>
                        <td className="py-2 text-center text-red-600">{(u.CostOnUs * u.Quantity).toFixed(2)}</td>
                        <td className="py-2 text-center text-green-600">{(u.PriceToClient * u.Quantity).toFixed(2)}</td>
                        <td className="py-2 text-center font-bold text-slate-700 dark:text-slate-200">{((u.PriceToClient - u.CostOnUs) * u.Quantity).toFixed(2)}</td>
                        {!['delivered', 'cancelled'].includes(t.Status) && (
                          <td><button onClick={() => handleRemoveUsage(u.UsageID)} className="text-red-500 hover:text-red-700"><Trash2 size={12} /></button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-xs text-slate-400">لا توجد خدمات إضافية</p>}
            </div>

            {/* Financial Summary */}
            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border-2 border-primary-200 dark:border-primary-800">
              <h3 className="text-xs font-semibold text-primary-700 dark:text-primary-300 mb-3 flex items-center gap-1"><DollarSign size={14} /> ملخص مالي مباشر</h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">قطع الغيار (تكلفتنا):</span><span className="text-red-600 font-bold">{partsCostOnUs.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">قطع الغيار (سعر البيع):</span><span className="text-green-600 font-bold">{partsSalePrice.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الخدمات (تكلفتنا):</span><span className="text-red-600 font-bold">{(servicesCostOnUs + usageCostOnUs).toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الخدمات (سعر البيع):</span><span className="text-green-600 font-bold">{(servicesPrice + usagePrice).toFixed(2)}</span></div>
                  {t.Status === 'ready' && (
                    <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">المصنعية المقترحة:</span><span className="text-slate-700 dark:text-slate-200 font-bold">{t.AgreedCost ? t.AgreedCost.toFixed(2) : '—'}</span></div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm font-bold border-b border-slate-200 dark:border-slate-700 pb-1">
                    <span className="text-slate-700 dark:text-slate-200">التكلفة علينا:</span>
                    <span className="text-red-600">{totalCostOnUs.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold">
                    <span className="text-slate-700 dark:text-slate-200">الإيراد المتوقع:</span>
                    <span className="text-green-600">{finSummary?.totalPriceToClient?.toFixed(2) || (partsSalePrice + servicesPrice + usagePrice).toFixed(2)}</span>
                  </div>
                  <div className={`flex justify-between text-base font-bold border-t border-slate-200 dark:border-slate-700 pt-1 ${expectedProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    <span>صافي الربح المتوقع:</span>
                    <span>{expectedProfit.toFixed(2)}</span>
                  </div>
                  {finSummary?.profitMargin && (
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">هامش الربح:</span>
                      <span className={`font-bold ${parseFloat(finSummary.profitMargin) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{finSummary.profitMargin}%</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Issue Part Modal */}
        <Modal isOpen={showIssuePart} onClose={() => setShowIssuePart(false)} title="إضافة قطعة من المخزن" size="sm"
          footer={<><Button variant="secondary" onClick={() => setShowIssuePart(false)}>إلغاء</Button><Button onClick={handleIssuePart}>إضافة</Button></>}>
          <div className="space-y-3">
            <Select label="المخزن" value={partForm.WarehouseID} onChange={(e) => {
              setPartForm({ ...partForm, ItemID: '', WarehouseID: e.target.value, UnitCost: '', SalePrice: '' });
              loadWarehouseItems(e.target.value);
            }}>
              <option value="">— اختر المخزن أولاً —</option>
              {warehouses.map((w: any) => <option key={w.WarehouseID} value={w.WarehouseID}>{w.WarehouseName}</option>)}
            </Select>
            <Select label="القطعة" value={partForm.ItemID} onChange={(e) => {
              const item = warehouseItems.find(i => i.ItemID === parseInt(e.target.value));
              setPartForm({ ...partForm, ItemID: e.target.value, UnitCost: item?.StockCostPrice?.toString() || '', SalePrice: item?.SalePrice?.toString() || '' });
            }}>
              <option value="">— {partForm.WarehouseID ? 'اختر قطعة' : 'اختر المخزن أولاً'} —</option>
              {warehouseItems.map((it: any) => (
                <option key={it.ItemID} value={it.ItemID}>
                  {it.ItemName} ({it.StockQuantity} متاح)
                </option>
              ))}
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <Input label="الكمية" type="number" value={partForm.Quantity} onChange={(e: any) => setPartForm({ ...partForm, Quantity: e.target.value })} />
              <Input label="سعر التكلفة (قابل للتعديل)" type="number" value={partForm.UnitCost} onChange={(e: any) => setPartForm({ ...partForm, UnitCost: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="سعر البيع للعميل" type="number" value={partForm.SalePrice} onChange={(e: any) => setPartForm({ ...partForm, SalePrice: e.target.value })} />
            </div>
          </div>
        </Modal>

        {/* Delivery Modal */}
        <Modal isOpen={showDeliver} onClose={() => setShowDeliver(false)} title="تسليم الجهاز للعميل" size="lg"
          footer={<><Button variant="secondary" onClick={() => setShowDeliver(false)}>إلغاء</Button><Button onClick={handleDeliver} icon={<Smartphone size={14} />}>تسليم وإنشاء فاتورة</Button></>}>
          <div className="space-y-4">
            {/* Financial breakdown */}
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">قطع الغيار:</span><span className="font-bold text-slate-700 dark:text-slate-200">{deliveryPartsTotal.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">الخدمات:</span><span className="font-bold text-slate-700 dark:text-slate-200">{(servicesPrice + usagePrice).toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">المصنعية:</span><span className="font-bold text-slate-700 dark:text-slate-200">{laborCost.toFixed(2)}</span></div>
              <div className="flex justify-between text-sm font-bold border-t border-slate-200 dark:border-slate-700 pt-2">
                <span className="text-slate-800 dark:text-white">الإجمالي:</span><span className="text-primary-600">{deliveryTotal.toFixed(2)}</span>
              </div>
              {deliveryDiscount > 0 && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">(-) خصم:</span><span className="text-red-600 font-bold">{deliveryDiscount.toFixed(2)}</span></div>}
              <div className="flex justify-between text-base font-bold border-t border-slate-200 dark:border-slate-700 pt-1">
                <span className="text-slate-800 dark:text-white">السعر النهائي:</span><span className="text-primary-600">{deliveryFinalPrice.toFixed(2)}</span>
              </div>
              <div className={`flex justify-between font-bold ${expectedProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                <span>الربح:</span><span>{expectedProfit.toFixed(2)}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Input label="المصنعية (العمالة)" type="number" value={deliverForm.LaborCost} onChange={(e: any) => setDeliverForm({...deliverForm, LaborCost: e.target.value})} />
              <Input label="خصم" type="number" value={deliverForm.Discount} onChange={(e: any) => setDeliverForm({...deliverForm, Discount: e.target.value})} />
              <Input label="السعر النهائي" type="number" value={deliverForm.FinalPrice} onChange={(e: any) => setDeliverForm({...deliverForm, FinalPrice: e.target.value})} hint={`تلقائي: ${(deliveryTotal - deliveryDiscount).toFixed(2)}`} />
            </div>

            <Textarea label="ملاحظات الفاتورة (تظهر للعميل)" value={deliverForm.FinalNotes} onChange={(e: any) => setDeliverForm({...deliverForm, FinalNotes: e.target.value})} rows={2} placeholder="ملاحظات إضافية على الفاتورة..." />

            <Input label="المبلغ المحصّل من العميل" type="number" value={deliverForm.PaidAmount} onChange={(e: any) => setDeliverForm({...deliverForm, PaidAmount: e.target.value})}
              hint={`الإجمالي المستحق: ${deliveryFinalPrice.toFixed(2)}`}
            />
            {parseFloat(deliverForm.PaidAmount || '0') > 0 && (
              <div className="grid grid-cols-2 gap-3">
                {/* One destination only — selecting a machine clears the safe,
                    matching the backend which credits a single account. */}
                <Select label="خزنة/بنك" value={deliverForm.CashAccountID} onChange={(e) => setDeliverForm({...deliverForm, CashAccountID: e.target.value, PaymentMethodID: e.target.value ? '' : deliverForm.PaymentMethodID})}>
                  <option value="">— اختر —</option>
                  {cashAccounts.map((ca: any) => <option key={ca.CashAccountID} value={ca.CashAccountID}>{ca.AccountName} ({ca.Balance?.toFixed(2)})</option>)}
                </Select>
                <Select label="ماكينة/محفظة" value={deliverForm.PaymentMethodID} onChange={(e) => setDeliverForm({...deliverForm, PaymentMethodID: e.target.value, CashAccountID: e.target.value ? '' : deliverForm.CashAccountID})}>
                  <option value="">— بدون —</option>
                  {paymentMethods.map((pm: any) => <option key={pm.PaymentMethodID} value={pm.PaymentMethodID}>{pm.MethodName}</option>)}
                </Select>
              </div>
            )}
            {(!deliverForm.PaidAmount || parseFloat(deliverForm.PaidAmount) === 0) && (
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2 text-xs text-orange-600 dark:text-orange-300 text-center">تسليم آجل - المبلغ كامل على حساب العميل</div>
            )}
          </div>
        </Modal>

        {/* Cancel Modal */}
        <Modal isOpen={showCancel} onClose={() => setShowCancel(false)} title="إلغاء أمر الصيانة" size="sm"
          footer={<><Button variant="secondary" onClick={() => setShowCancel(false)}>رجوع</Button><Button variant="danger" onClick={handleCancel} icon={<X size={14} />}>تأكيد الإلغاء</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">سيتم إعادة جميع القطع المستخدمة إلى المخزن.</p>
            <Textarea label="سبب الإلغاء (إجباري)" value={cancelReason} onChange={(e: any) => setCancelReason(e.target.value)} rows={3} placeholder="اكتب سبب الإلغاء..." />
          </div>
        </Modal>

        {/* Delivery Success Modal */}
        <Modal isOpen={showDeliverySuccess} onClose={() => { setShowDeliverySuccess(false); closeWorkbench(); }}>
          <div className="min-w-[400px] text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <CheckCircle size={36} className="text-green-600" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-2">تم التسليم بنجاح</h3>
            <div className="text-sm text-slate-500 dark:text-slate-400 mb-4 space-y-1">
              <p>فاتورة: {deliveryResult?.saleNumber || '—'}</p>
              <p>رقم التسليم: {deliveryResult?.deliveryNumber || '—'}</p>
              <p className="text-lg font-bold text-primary-600 mt-2">الإجمالي: {deliveryResult?.totalCost?.toFixed(2)}</p>
              {deliveryResult?.remaining > 0 && <p className="text-orange-600">المتبقي: {deliveryResult?.remaining?.toFixed(2)}</p>}
            </div>
            <div className="flex gap-3 justify-center">
              <Button variant="secondary" onClick={() => { setShowDeliverySuccess(false); closeWorkbench(); }}>إغلاق</Button>
              <Button onClick={printDeliveryInvoice} icon={<Printer size={16} />}>طباعة الفاتورة</Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ====== LIST VIEW (default) ======
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الصيانة</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => {
            // Quick deliver - show list of ready tickets
            const ready = tickets.filter(t => t.Status === 'ready');
            if (ready.length === 0) { showToast('info', 'لا توجد أجهزة جاهزة للتسليم'); return; }
            loadWorkbench(ready[0].TicketID);
          }} icon={<Smartphone size={16} />}>تسليم جهاز</Button>
          <Button onClick={() => setShowReceive(true)} icon={<Plus size={16} />}>استلام جهاز</Button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {['all', 'received', 'inspecting', 'in_progress', 'ready', 'delivered', 'returned', 'cancelled'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary-600 text-white'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}>
            {statusLabels[s] || s}
          </button>
        ))}
      </div>

      <DataTable
        columns={[
          { key: 'TicketNumber', title: 'الأمر', render: (row) => <span className="font-mono text-xs font-bold text-slate-800 dark:text-white">{row.TicketNumber}</span> },
          { key: 'Date', title: 'التاريخ', render: (row) => <span className="text-xs text-slate-500 dark:text-slate-400">{row.Date}</span> },
          { key: 'CustomerName', title: 'العميل', render: (row) => <span className="font-medium text-slate-800 dark:text-white">{row.CustomerName}</span> },
          { key: 'DeviceModel', title: 'الجهاز', render: (row) => <span className="text-slate-700 dark:text-slate-200">{row.DeviceModel}</span> },
          { key: 'TechnicianName', title: 'الفني', render: (row) => row.TechnicianName || <span className="text-slate-400">—</span> },
          { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={statusVariants[row.Status] || 'gray'}>{statusLabels[row.Status] || row.Status}</Badge> },
          { key: 'TotalCost', title: 'التكلفة', render: (row) => row.TotalCost > 0 ? <span className="font-bold text-slate-800 dark:text-white">{row.TotalCost?.toFixed(2)}</span> : <span className="text-slate-400">—</span> },
          { key: 'actions', title: '', render: (row) => (
            <div className="flex gap-1">
              <button onClick={() => openPreview(row)} className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded" title="عرض"><Eye size={14} /></button>
              <button onClick={() => loadWorkbench(row.TicketID)} className="p-1.5 text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded" title="ورشة العمل">
                <Wrench size={14} />
              </button>
              {row.Status === 'ready' && (
                <button onClick={() => {
                  loadWorkbench(row.TicketID);
                  setTimeout(() => openDeliverModal(), 500);
                }} className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded" title="تسليم"><Smartphone size={14} /></button>
              )}
            </div>
          )},
        ]}
        data={tickets}
        keyField="TicketID"
        emptyMessage="لا توجد أوامر صيانة"
      />

      {/* Receive Modal */}
      <Modal isOpen={showReceive} onClose={() => setShowReceive(false)} title="استلام جهاز للصيانة" size="lg"
        footer={<><Button variant="secondary" onClick={() => setShowReceive(false)}>إلغاء</Button><Button onClick={handleReceive} icon={<Wrench size={16} />}>استلام</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <Select label="العميل (اختياري)" value={recvForm.CustomerID} onChange={(e) => {
            const c = customers.find(c => c.CustomerID === parseInt(e.target.value));
            setRecvForm({ ...recvForm, CustomerID: e.target.value, CustomerName: c?.Name || recvForm.CustomerName, CustomerPhone: c?.Phone || recvForm.CustomerPhone });
          }}>
            <option value="">— عميل جديد —</option>
            {customers.map((c: any) => <option key={c.CustomerID} value={c.CustomerID}>{c.Name} ({c.Phone || '—'})</option>)}
          </Select>
          <Input label="رقم الهاتف" value={recvForm.CustomerPhone} onChange={(e: any) => setRecvForm({ ...recvForm, CustomerPhone: e.target.value })} />
          <Input label="اسم العميل" value={recvForm.CustomerName} onChange={(e: any) => setRecvForm({ ...recvForm, CustomerName: e.target.value })} />
          <Input label="نوع الجهاز" value={recvForm.DeviceModel} onChange={(e: any) => setRecvForm({ ...recvForm, DeviceModel: e.target.value })} />
          <Input label="رقم IMEI" value={recvForm.DeviceIMEI} onChange={(e: any) => setRecvForm({ ...recvForm, DeviceIMEI: e.target.value })} />
          <Input label="الموعد المتفق للتسليم" type="date" value={recvForm.AgreedDeliveryDate} onChange={(e: any) => setRecvForm({ ...recvForm, AgreedDeliveryDate: e.target.value })} />
          <Input label="المبلغ المتفق عليه" type="number" value={recvForm.AgreedCost} onChange={(e: any) => setRecvForm({ ...recvForm, AgreedCost: e.target.value })} />
          <Select label="الفني" value={recvForm.TechnicianID} onChange={(e) => setRecvForm({ ...recvForm, TechnicianID: e.target.value })}>
            <option value="">— بدون —</option>
            {employees.map((emp: any) => <option key={emp.EmployeeID} value={emp.EmployeeID}>{emp.Name}</option>)}
          </Select>
          <div className="col-span-2"><Textarea label="المشكلة المشتكى منها" value={recvForm.ProblemDesc} onChange={(e: any) => setRecvForm({ ...recvForm, ProblemDesc: e.target.value })} /></div>
          <Input label="المرفقات (شريحة، ميموري، جراب)" value={recvForm.Accessories} onChange={(e: any) => setRecvForm({ ...recvForm, Accessories: e.target.value })} />
          <Input label="الرقم السري / نمط القفل" value={recvForm.DevicePassword} onChange={(e: any) => setRecvForm({ ...recvForm, DevicePassword: e.target.value })} />
        </div>
      </Modal>

      {/* Preview Modal */}
      <Modal isOpen={showPreview} onClose={() => setShowPreview(false)} title={`تفاصيل: ${previewTicket?.TicketNumber || ''}`} size="lg"
        footer={<Button variant="secondary" onClick={() => setShowPreview(false)}>إغلاق</Button>}>
        {previewTicket && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><span className="text-slate-500 dark:text-slate-400">العميل:</span> <span className="font-medium text-slate-800 dark:text-white">{previewTicket.CustomerName}</span></div>
              <div><span className="text-slate-500 dark:text-slate-400">الهاتف:</span> <span className="text-slate-700 dark:text-slate-200">{previewTicket.CustomerPhone}</span></div>
              <div><span className="text-slate-500 dark:text-slate-400">الجهاز:</span> <span className="text-slate-700 dark:text-slate-200">{previewTicket.DeviceModel}</span></div>
              <div><span className="text-slate-500 dark:text-slate-400">الحالة:</span> <Badge variant={statusVariants[previewTicket.Status]}>{statusLabels[previewTicket.Status]}</Badge></div>
              <div className="col-span-2"><span className="text-slate-500 dark:text-slate-400">المشكلة:</span> <span className="text-slate-700 dark:text-slate-200">{previewTicket.ProblemDesc}</span></div>
            </div>

            {previewTicket.parts?.length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 mb-1">قطع الغيار</h4>
                {asRows<any>(previewTicket.parts).map((p: any, idx: number) => (
                  <div key={idx} className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700/50">
                    <span className="text-slate-700 dark:text-slate-200">{p.ItemName} × {p.Quantity}</span>
                    <span className="font-bold text-orange-600">{p.TotalCost?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {previewTicket.serviceCosts?.length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 mb-1">تكاليف الخدمات</h4>
                {asRows<any>(previewTicket.serviceCosts).map((c: any, idx: number) => (
                  <div key={idx} className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700/50">
                    <span className="text-slate-700 dark:text-slate-200">{c.Description}</span>
                    <span className="font-bold text-green-600">{c.PriceToClient?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {previewTicket.serviceUsage?.length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 mb-1">خدمات مستخدمة</h4>
                {asRows<any>(previewTicket.serviceUsage).map((u: any, idx: number) => (
                  <div key={idx} className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700/50">
                    <span className="text-slate-700 dark:text-slate-200">{u.Description || u.ItemName} × {u.Quantity}</span>
                    <span className="font-bold text-green-600">{(u.PriceToClient * (u.Quantity || 1))?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2 text-center"><div className="text-xs text-slate-500 dark:text-slate-400">قطع الغيار</div><div className="font-bold text-orange-600">{(previewTicket.parts?.reduce((s: number, p: any) => s + (p.TotalCost || 0), 0) || 0).toFixed(2)}</div></div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2 text-center"><div className="text-xs text-slate-500 dark:text-slate-400">الخدمات والمصنعية</div><div className="font-bold text-green-600">{((previewTicket.serviceCosts?.reduce((s: number, c: any) => s + (c.PriceToClient || 0), 0) || 0) + (previewTicket.serviceUsage?.reduce((s: number, u: any) => s + ((u.PriceToClient || 0) * (u.Quantity || 1)), 0) || 0) + (previewTicket.LaborCost || 0)).toFixed(2)}</div></div>
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2 text-center"><div className="text-xs text-slate-500 dark:text-slate-400">الإجمالي</div><div className="font-bold text-blue-600">{(previewTicket.TotalCost?.toFixed(2) || '0')}</div></div>
            </div>

            {previewTicket.log?.length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 mb-1">سجل الحالات</h4>
                {asRows<any>(previewTicket.log).map((l: any, idx: number) => (
                  <div key={idx} className="flex items-center gap-2 text-xs py-1">
                    <Badge variant="gray">{statusLabels[l.Status] || l.Status}</Badge>
                    <span className="text-slate-500 dark:text-slate-400">{l.Date}</span>
                    <span className="text-slate-400">{l.Username}</span>
                    {l.Notes && <span className="text-slate-500">- {l.Notes}</span>}
                  </div>
                ))}
              </div>
            )}

            {previewTicket.notes?.length > 0 && (
              <div><h4 className="text-xs font-semibold text-slate-500 mb-1">ملاحظات</h4>
                {asRows<any>(previewTicket.notes).map((n: any, idx: number) => (
                  <div key={idx} className="text-xs bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2 mb-1">
                    <span className="text-slate-400">{n.Username} - {n.CreatedAt}</span>
                    <p className="text-slate-700 dark:text-slate-200">{n.Content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );

  // ====== Receive handler ======
  async function handleReceive() {
    if (!recvForm.CustomerName || !recvForm.CustomerPhone || !recvForm.DeviceModel || !recvForm.ProblemDesc) {
      showToast('error', 'يرجى إدخال بيانات العميل والجهاز والمشكلة');
      return;
    }
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }
    const result = await window.api.invoke('maintenance:receive', {
      CustomerID: recvForm.CustomerID ? parseInt(recvForm.CustomerID) : undefined,
      CustomerName: recvForm.CustomerName, CustomerPhone: recvForm.CustomerPhone,
      DeviceModel: recvForm.DeviceModel, DeviceIMEI: recvForm.DeviceIMEI || undefined,
      ProblemDesc: recvForm.ProblemDesc, Accessories: recvForm.Accessories || undefined,
      DevicePassword: recvForm.DevicePassword || undefined,
      AgreedDeliveryDate: recvForm.AgreedDeliveryDate || undefined,
      AgreedCost: recvForm.AgreedCost ? parseFloat(recvForm.AgreedCost) : undefined,
      TechnicianID: recvForm.TechnicianID ? parseInt(recvForm.TechnicianID) : undefined,
      MaintenanceType: recvForm.MaintenanceType,
      ReferenceTicketID: recvForm.ReferenceTicketID ? parseInt(recvForm.ReferenceTicketID) : undefined,
      userId, fiscalYearId: activeFy.FiscalYearID,
    });
    if (result.success) {
      showToast('success', `تم استلام الجهاز - رقم: ${result.ticketNumber}`);
      setShowReceive(false);
      setRecvForm({ CustomerID: '', CustomerName: '', CustomerPhone: '', DeviceModel: '', DeviceIMEI: '', ProblemDesc: '', Accessories: '', DevicePassword: '', AgreedDeliveryDate: '', AgreedCost: '', TechnicianID: '', MaintenanceType: 'normal', ReferenceTicketID: '' });
      fetchData();
    }
  }
}
