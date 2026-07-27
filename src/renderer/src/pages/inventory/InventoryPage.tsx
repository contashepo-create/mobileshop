import { useState, useEffect } from 'react';
import { Plus, Search, Edit, Trash2, Package, ArrowRightLeft, Smartphone, Tag, ScanLine } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { UNIT_OPTIONS } from '../../../../shared/types';

export function InventoryPage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<'items' | 'categories' | 'warehouses' | 'transfers'>('items');
  const [items, setItems] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('0');
  const [showItemModal, setShowItemModal] = useState(false);
  const [showWhModal, setShowWhModal] = useState(false);
  const [showCatModal, setShowCatModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showSerialsModal, setShowSerialsModal] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingWh, setEditingWh] = useState<any>(null);
  const [editingCat, setEditingCat] = useState<any>(null);
  const [serialsItem, setSerialsItem] = useState<any>(null);
  const [barcodeSearch, setBarcodeSearch] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddForm, setQuickAddForm] = useState({ Barcode: '', ItemName: '', SalePrice: '' });

  const [itemForm, setItemForm] = useState({ ItemName: '', CategoryID: '', Barcode: '', IsSerialized: 0, SalePrice: '', MinStock: '', Unit: '\u0642\u0637\u0639\u0629', IsActive: 1 });
  const [whForm, setWhForm] = useState({ WarehouseName: '', WarehouseType: 'main' });
  const [catForm, setCatForm] = useState({ CategoryName: '' });
  const [serials, setSerials] = useState<any[]>([]);
  const [newImei, setNewImei] = useState('');

  const fetchData = async () => {
    const [it, wh, cat] = await Promise.all([
      window.api.invoke('items:list', { search, categoryId: parseInt(categoryFilter), isActive: 1 }),
      window.api.invoke('warehouses:list'),
      window.api.invoke('categories:list'),
    ]);
    setItems(it);
    setWarehouses(wh);
    setCategories(cat);
  };

  const fetchCategories = async () => {
    const cat = await window.api.invoke('categories:list');
    setCategories(cat);
  };

  useEffect(() => { fetchData(); }, [search, categoryFilter]);
  useEffect(() => { fetchCategories(); }, []);

  const saveItem = async () => {
    if (!itemForm.ItemName) { showToast('error', 'يرجى إدخال اسم الصنف'); return; }
    const data = {
      ...itemForm,
      CategoryID: itemForm.CategoryID ? parseInt(itemForm.CategoryID) : null,
      SalePrice: parseFloat(itemForm.SalePrice) || 0,
      MinStock: parseInt(itemForm.MinStock) || 0,
      IsSerialized: itemForm.IsSerialized ? 1 : 0,
    };
    try {
      if (editingItem) {
        const result = await window.api.invoke('items:update', editingItem.ItemID, data);
        if (result?.success === false) { showToast('error', result.message); return; }
        showToast('success', 'تم تحديث الصنف');
      } else {
        const result = await window.api.invoke('items:create', data);
        if (result?.success === false) { showToast('error', result.message); return; }
        showToast('success', 'تم إضافة الصنف');
      }
      setShowItemModal(false);
      fetchData();
    } catch (err: any) {
      showToast('error', `خطأ: ${err.message || err}`);
    }
  };

  const saveWh = async () => {
    if (!whForm.WarehouseName) { showToast('error', 'يرجى إدخال اسم المخزن'); return; }
    if (editingWh) {
      await window.api.invoke('warehouses:update', editingWh.WarehouseID, whForm);
    } else {
      await window.api.invoke('warehouses:create', whForm);
    }
    setShowWhModal(false);
    fetchData();
    showToast('success', 'تم الحفظ');
  };

  const saveCategory = async () => {
    if (!catForm.CategoryName.trim()) { showToast('error', 'أدخل اسم الفئة'); return; }
    if (editingCat) {
      await window.api.invoke('categories:update', editingCat.CategoryID, catForm.CategoryName.trim());
      showToast('success', 'تم تحديث الفئة');
    } else {
      await window.api.invoke('categories:create', catForm.CategoryName.trim());
      showToast('success', 'تم إضافة الفئة');
    }
    setShowCatModal(false);
    setCatForm({ CategoryName: '' });
    setEditingCat(null);
    await fetchCategories();
    fetchData();
  };

  const deleteCategory = async (cat: any) => {
    const result = await window.api.invoke('categories:delete', cat.CategoryID);
    if (result.success) {
      showToast('success', 'تم حذف الفئة');
      await fetchCategories();
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  const openSerials = async (item: any) => {
    setSerialsItem(item);
    const s = await window.api.invoke('serials:list', item.ItemID);
    setSerials(s);
    setShowSerialsModal(true);
  };

  const addSerial = async () => {
    if (!newImei) return;
    const wh = warehouses[0];
    const result = await window.api.invoke('serials:add', { ItemID: serialsItem.ItemID, IMEI: newImei, WarehouseID: wh.WarehouseID });
    if (!result.success) { showToast('error', result.message); return; }
    setNewImei('');
    const s = await window.api.invoke('serials:list', serialsItem.ItemID);
    setSerials(s);
    showToast('success', 'تم إضافة الرقم التسلسلي');
  };

  // Barcode scan: find existing or prompt to create
  const handleBarcodeScan = async () => {
    if (!barcodeSearch.trim()) return;
    const item = await window.api.invoke('items:findByBarcode', barcodeSearch.trim());
    if (item) {
      setEditingItem(item);
      setItemForm({ ItemName: item.ItemName, CategoryID: item.CategoryID?.toString() || '', Barcode: item.Barcode || '', IsSerialized: item.IsSerialized, SalePrice: item.SalePrice?.toString() || '', MinStock: item.MinStock?.toString() || '', Unit: item.Unit || 'قطعة', IsActive: item.IsActive });
      setShowItemModal(true);
    } else {
      setQuickAddForm({ Barcode: barcodeSearch.trim(), ItemName: '', SalePrice: '' });
      setShowQuickAdd(true);
    }
    setBarcodeSearch('');
  };

  const onBarcodeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBarcodeScan();
    }
  };

  const handleQuickAdd = async () => {
    if (!quickAddForm.Barcode) { showToast('error', 'أدخل الباركود'); return; }
    const result = await window.api.invoke('items:quickCreate', {
      Barcode: quickAddForm.Barcode,
      ItemName: quickAddForm.ItemName || undefined,
      SalePrice: quickAddForm.SalePrice ? parseFloat(quickAddForm.SalePrice) : 0,
    });
    if (result.success) {
      showToast('success', 'تم إضافة الصنف بالباركود');
      setShowQuickAdd(false);
      setQuickAddForm({ Barcode: '', ItemName: '', SalePrice: '' });
      fetchData();
    } else if (result.item) {
      showToast('info', 'الباركود موجود بالفعل - تم فتح الصنف');
      const item = result.item;
      setEditingItem(item);
      setItemForm({ ItemName: item.ItemName, CategoryID: item.CategoryID?.toString() || '', Barcode: item.Barcode || '', IsSerialized: item.IsSerialized, SalePrice: item.SalePrice?.toString() || '', MinStock: item.MinStock?.toString() || '', Unit: item.Unit || 'قطعة', IsActive: item.IsActive });
      setShowItemModal(true);
      setShowQuickAdd(false);
    } else {
      showToast('error', result.message);
    }
  };

  const tabBtnClass = (t: string) =>
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ' +
    (tab === t ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white">المخازن والأصناف</h1>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('items')} className={tabBtnClass('items')}><Package size={16} /> الأصناف</button>
        <button onClick={() => setTab('categories')} className={tabBtnClass('categories')}><Tag size={16} /> الفئات</button>
        <button onClick={() => setTab('warehouses')} className={tabBtnClass('warehouses')}><Package size={16} /> المخازن</button>
        <button onClick={() => setTab('transfers')} className={tabBtnClass('transfers')}><ArrowRightLeft size={16} /> التحويلات</button>
      </div>

      {/* ===== ITEMS TAB ===== */}
      {tab === 'items' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-3 flex-1">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الباركود..." className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="max-w-xs">
                <option value="0">كل الفئات</option>
                {categories.map((c: any) => <option key={c.CategoryID} value={c.CategoryID}>{c.CategoryName}</option>)}
              </Select>
            </div>
            <Button onClick={() => { setEditingItem(null); setItemForm({ ItemName: '', CategoryID: '', Barcode: '', IsSerialized: 0, SalePrice: '', MinStock: '', Unit: '\u0642\u0637\u0639\u0629', IsActive: 1 }); setShowItemModal(true); }} icon={<Plus size={16} />}>صنف جديد</Button>
          </div>

          {/* Barcode scanner field */}
          <div className="flex gap-2 items-end bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">مسح الباركود</label>
              <div className="relative">
                <ScanLine className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} />
                <input
                  type="text"
                  value={barcodeSearch}
                  onChange={(e) => setBarcodeSearch(e.target.value)}
                  onKeyDown={onBarcodeKeyDown}
                  placeholder="امسح أو أدخل الباركود ثم اضغط Enter..."
                  className="w-full pr-9 pl-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
              </div>
            </div>
            <Button onClick={handleBarcodeScan} size="sm">بحث</Button>
          </div>

          <DataTable
            columns={[
              { key: 'ItemName', title: 'الاسم', render: (row) => <span className="font-medium text-slate-800 dark:text-white">{row.ItemName}</span> },
              { key: 'CategoryName', title: 'الفئة', render: (row) => row.CategoryName ? <Badge variant="gray">{row.CategoryName}</Badge> : '—' },
              { key: 'Barcode', title: 'الباركود', render: (row) => row.Barcode || '—' },
              { key: 'SalePrice', title: 'سعر البيع', render: (row) => <span className="text-slate-700 dark:text-slate-200">{row.SalePrice?.toFixed(2) || '—'}</span> },
              { key: 'stock', title: 'المخزون', render: (row) => <span className="text-slate-700 dark:text-slate-200">{row.IsSerialized ? `${row.AvailableSerials} متاح` : `${row.TotalStock || 0} ${row.Unit}`}</span> },
              { key: 'actions', title: 'إجراءات', render: (row) => (
                <div className="flex gap-2">
                  <button onClick={() => { setEditingItem(row); setItemForm({ ItemName: row.ItemName, CategoryID: row.CategoryID?.toString() || '', Barcode: row.Barcode || '', IsSerialized: row.IsSerialized, SalePrice: row.SalePrice?.toString() || '', MinStock: row.MinStock?.toString() || '', Unit: row.Unit || 'قطعة', IsActive: row.IsActive }); setShowItemModal(true); }} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button>
                  {row.IsSerialized && <button onClick={() => openSerials(row)} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><Smartphone size={12} /> IMEI</button>}
                  {!row.TotalStock && !row.AvailableSerials && (
                    <button onClick={async () => { if (!confirm('حذف الصنف نهائياً؟')) return; const r = await window.api.invoke('items:deleteSafe', row.ItemID); if (r.success) { showToast('success', r.message); fetchData(); } else { showToast('error', r.message); } }} className="text-xs text-red-500 hover:underline flex items-center gap-1"><Trash2 size={12} /> حذف</button>
                  )}
                </div>
              )},
            ]}
            data={items}
            keyField="ItemID"
            emptyMessage="لا توجد أصناف"
          />
        </div>
      )}

      {/* ===== CATEGORIES TAB ===== */}
      {tab === 'categories' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setEditingCat(null); setCatForm({ CategoryName: '' }); setShowCatModal(true); }} icon={<Plus size={16} />}>فئة جديدة</Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((cat: any) => {
              const itemCount = items.filter((i: any) => i.CategoryID === cat.CategoryID).length;
              return (
                <div key={cat.CategoryID} className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-primary-100 dark:bg-primary-900/30">
                        <Tag size={16} className="text-primary-600" />
                      </div>
                      <div>
                        <div className="font-medium text-slate-800 dark:text-white">{cat.CategoryName}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{itemCount} صنف</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => { setEditingCat(cat); setCatForm({ CategoryName: cat.CategoryName }); setShowCatModal(true); }} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button>
                    <button onClick={() => deleteCategory(cat)} className="text-xs text-red-500 hover:underline flex items-center gap-1"><Trash2 size={12} /> حذف</button>
                  </div>
                </div>
              );
            })}
            {categories.length === 0 && <p className="text-center text-slate-500 dark:text-slate-400 py-8 col-span-full">لا توجد فئات - أضف فئات مثل: شاشات، بطاريات، جرابات، وصلات، شواحن...</p>}
          </div>
        </div>
      )}

      {/* ===== WAREHOUSES TAB ===== */}
      {tab === 'warehouses' && (
        <div className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => { setEditingWh(null); setWhForm({ WarehouseName: '', WarehouseType: 'main' }); setShowWhModal(true); }} icon={<Plus size={16} />}>مخزن جديد</Button></div>
          <DataTable
            columns={[
              { key: 'WarehouseName', title: 'الاسم', render: (row) => <span className="font-medium text-slate-800 dark:text-white">{row.WarehouseName}</span> },
              { key: 'WarehouseType', title: 'النوع', render: (row) => <Badge variant={row.WarehouseType === 'main' ? 'blue' : row.WarehouseType === 'maintenance' ? 'orange' : 'gray'}>{row.WarehouseType === 'main' ? 'رئيسي' : row.WarehouseType === 'maintenance' ? 'صيانة' : 'أخرى'}</Badge> },
              { key: 'actions', title: '', render: (row) => <button onClick={() => { setEditingWh(row); setWhForm({ WarehouseName: row.WarehouseName, WarehouseType: row.WarehouseType }); setShowWhModal(true); }} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Edit size={12} /> تعديل</button> },
            ]}
            data={warehouses}
            keyField="WarehouseID"
            emptyMessage="لا توجد مخازن"
          />
        </div>
      )}

      {/* ===== TRANSFERS TAB ===== */}
      {tab === 'transfers' && (
        <div className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => setShowTransferModal(true)} icon={<ArrowRightLeft size={16} />}>تحويل جديد</Button></div>
          <TransferList warehouses={warehouses} showToast={showToast} />
        </div>
      )}

      {/* Item Modal */}
      <Modal isOpen={showItemModal} onClose={() => setShowItemModal(false)} title={editingItem ? 'تعديل صنف' : 'صنف جديد'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setShowItemModal(false)}>إلغاء</Button><Button onClick={saveItem}>حفظ</Button></>}
      >
        <div className="grid grid-cols-2 gap-4">
          <Input label="اسم الصنف" value={itemForm.ItemName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemForm({ ...itemForm, ItemName: e.target.value })} />
          <Select label="الفئة" value={itemForm.CategoryID} onChange={(e) => setItemForm({ ...itemForm, CategoryID: e.target.value })}>
            <option value="">— بدون فئة —</option>
            {categories.map((c: any) => <option key={c.CategoryID} value={c.CategoryID}>{c.CategoryName}</option>)}
          </Select>
          <Input label="الباركود" value={itemForm.Barcode} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemForm({ ...itemForm, Barcode: e.target.value })} />
          <Input label="سعر البيع" type="number" value={itemForm.SalePrice} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemForm({ ...itemForm, SalePrice: e.target.value })} />
          <Input label="حد التنبيه" type="number" value={itemForm.MinStock} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setItemForm({ ...itemForm, MinStock: e.target.value })} />
          <Select label="وحدة القياس" value={itemForm.Unit} onChange={(e) => setItemForm({ ...itemForm, Unit: e.target.value })}>
            {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="isSerialized" checked={itemForm.IsSerialized === 1} onChange={(e) => setItemForm({ ...itemForm, IsSerialized: e.target.checked ? 1 : 0 })} className="rounded border-slate-300 dark:border-slate-600" />
            <label htmlFor="isSerialized" className="text-sm text-slate-700 dark:text-slate-200 cursor-pointer">صنف مسلسل (IMEI)</label>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">يتم حساب سعر التكلفة تلقائياً من فواتير الشراء (متوسط مرجح + توزيع التكاليف)</div>
      </Modal>

      {/* Quick Add Modal (from barcode scan) */}
      <Modal isOpen={showQuickAdd} onClose={() => setShowQuickAdd(false)} title="إضافة صنف بالباركود" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowQuickAdd(false)}>إلغاء</Button><Button onClick={handleQuickAdd}>إضافة</Button></>}
      >
        <div className="space-y-3">
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2 text-xs text-blue-700 dark:text-blue-300">
            الباركود غير موجود. املأ البيانات لإضافة صنف جديد بسرعة.
          </div>
          <Input label="الباركود" value={quickAddForm.Barcode} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuickAddForm({ ...quickAddForm, Barcode: e.target.value })} disabled />
          <Input label="اسم الصنف" value={quickAddForm.ItemName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuickAddForm({ ...quickAddForm, ItemName: e.target.value })} placeholder={`صنف ${quickAddForm.Barcode}`} />
          <Input label="سعر البيع" type="number" value={quickAddForm.SalePrice} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuickAddForm({ ...quickAddForm, SalePrice: e.target.value })} />
          <div className="text-xs text-slate-400">يتم حساب سعر التكلفة تلقائياً من فواتير الشراء</div>
        </div>
      </Modal>

      {/* Category Modal */}
      <Modal isOpen={showCatModal} onClose={() => setShowCatModal(false)} title={editingCat ? 'تعديل فئة' : 'فئة جديدة'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowCatModal(false)}>إلغاء</Button><Button onClick={saveCategory}>حفظ</Button></>}
      >
        <Input label="اسم الفئة" value={catForm.CategoryName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCatForm({ CategoryName: e.target.value })} placeholder="مثال: شاشات، بطاريات، جرابات، وصلات..." />
      </Modal>

      {/* Warehouse Modal */}
      <Modal isOpen={showWhModal} onClose={() => setShowWhModal(false)} title={editingWh ? 'تعديل مخزن' : 'مخزن جديد'}
        footer={<><Button variant="secondary" onClick={() => setShowWhModal(false)}>إلغاء</Button><Button onClick={saveWh}>حفظ</Button></>}
      >
        <div className="space-y-4">
          <Input label="اسم المخزن" value={whForm.WarehouseName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhForm({ ...whForm, WarehouseName: e.target.value })} />
          <Select label="النوع" value={whForm.WarehouseType} onChange={(e) => setWhForm({ ...whForm, WarehouseType: e.target.value })}>
            <option value="main">مخزن رئيسي</option>
            <option value="maintenance">مخزن صيانة</option>
            <option value="other">أخرى</option>
          </Select>
        </div>
      </Modal>

      {/* Serials Modal */}
      <Modal isOpen={showSerialsModal} onClose={() => setShowSerialsModal(false)} title={`أرقام IMEI - ${serialsItem?.ItemName || ''}`} size="lg">
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input placeholder="أدخل رقم IMEI" value={newImei} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewImei(e.target.value)} />
            <Button onClick={addSerial}>إضافة</Button>
          </div>
          <DataTable
            columns={[
              { key: 'IMEI', title: 'IMEI', render: (row) => <span className="font-mono">{row.IMEI}</span> },
              { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={row.Status === 'available' ? 'green' : row.Status === 'sold' ? 'red' : 'orange'}>{row.Status === 'available' ? 'متاح' : row.Status === 'sold' ? 'مباع' : row.Status === 'returned' ? 'مرتجع' : 'في الصيانة'}</Badge> },
              { key: 'WarehouseName', title: 'المخزن' },
              { key: 'CostPrice', title: 'التكلفة', render: (row) => row.CostPrice?.toFixed(2) || '—' },
            ]}
            data={serials}
            keyField="SerialID"
            emptyMessage="لا توجد أرقام تسلسلية"
          />
        </div>
      </Modal>
    </div>
  );
}

function TransferList({ warehouses, showToast }: { warehouses: any[]; showToast: (type: 'success' | 'error', msg: string) => void }) {
  const [transfers, setTransfers] = useState<any[]>([]);

  const fetchTransfers = async () => {
    const t = await window.api.invoke('warehouseTransfers:list');
    setTransfers(t);
  };

  useEffect(() => { fetchTransfers(); }, []);

  return (
    <DataTable
      columns={[
        { key: 'TransferNumber', title: 'رقم التحويل', render: (row) => <span className="font-mono text-xs">{row.TransferNumber}</span> },
        { key: 'Date', title: 'التاريخ' },
        { key: 'FromWarehouse', title: 'من', render: (row) => row.FromWarehouse },
        { key: 'ToWarehouse', title: 'إلى', render: (row) => row.ToWarehouse },
        { key: 'Status', title: 'الحالة', render: (row) => <Badge variant={row.Status === 'completed' ? 'green' : 'gray'}>{row.Status === 'completed' ? 'مكتمل' : 'ملغي'}</Badge> },
      ]}
      data={transfers}
      keyField="TransferID"
      emptyMessage="لا توجد تحويلات"
    />
  );
}
