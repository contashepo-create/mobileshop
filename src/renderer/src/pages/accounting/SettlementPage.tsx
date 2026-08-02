import { useState, useEffect } from 'react';
import { ClipboardCheck, Eye, History } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { Modal } from '../../components/ui/Modal';
import { useToastStore } from '../../components/ui/Toast';
import { currentUserId } from '../../stores/auth.store';
import { isFailure, failureMessage, asRows } from '../../lib/ipc';

export function SettlementPage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<'adjust' | 'history'>('adjust');
  const [section, setSection] = useState('cash');
  const [data, setData] = useState<any[]>([]);
  const [adjustments, setAdjustments] = useState<Record<number, string>>({});
  const [settlements, setSettlements] = useState<any[]>([]);
  const [detailsModal, setDetailsModal] = useState<any>(null);

  const sectionLabels: Record<string, string> = {
    cash: 'الخزائن والبنوك',
    paymentMethods: 'ماكينات وأنظمة الدفع',
    inventory: 'المخزون',
    customers: 'العملاء',
    suppliers: 'الموردين',
  };

  const fetchData = async () => {
    let rows: any[] = [];
    if (section === 'inventory') {
      rows = asRows(await window.api.invoke('stock:list'));
      rows = rows.map((r: any) => ({ ...r, ItemID: r.ItemID, ItemName: r.ItemName, RecordedBalance: r.Quantity, ActualBalance: '' }));
    } else if (section === 'cash') {
      rows = asRows(await window.api.invoke('cashAccounts:list'));
      rows = rows.map((r: any) => ({ ...r, ItemID: r.CashAccountID, ItemName: r.AccountName, RecordedBalance: r.Balance, ActualBalance: '' }));
    } else if (section === 'paymentMethods') {
      rows = asRows(await window.api.invoke('paymentMethods:list'));
      rows = rows.map((r: any) => ({ ...r, ItemID: r.PaymentMethodID, ItemName: r.MethodName, RecordedBalance: r.Balance, ActualBalance: '' }));
    } else if (section === 'customers') {
      rows = asRows(await window.api.invoke('customers:list'));
      rows = rows.map((r: any) => ({ ...r, ItemID: r.CustomerID, ItemName: r.Name, RecordedBalance: r.Balance, ActualBalance: '' }));
    } else if (section === 'suppliers') {
      rows = asRows(await window.api.invoke('suppliers:list'));
      rows = rows.map((r: any) => ({ ...r, ItemID: r.SupplierID, ItemName: r.Name, RecordedBalance: r.Balance, ActualBalance: '' }));
    }
    setData(rows);
    setAdjustments({});
  };

  const fetchSettlements = async () => {
    const result = await window.api.invoke('settlements:list', { section: 'all' });
    setSettlements(asRows(result));
  };

  useEffect(() => { fetchData(); }, [section]);
  useEffect(() => { if (tab === 'history') fetchSettlements(); }, [tab]);

  const handleActualChange = (id: number, value: string) => {
    setAdjustments({ ...adjustments, [id]: value });
  };

  const handleSave = async () => {
    const activeFy = await window.api.invoke('fiscalYear:getActive');
    if (!activeFy) { showToast('error', 'لا توجد سنة مالية مفتوحة'); return; }

    const items = data
      .filter((r: any) => adjustments[r.ItemID] !== undefined && adjustments[r.ItemID] !== '')
      .map((r: any) => {
        const actual = parseFloat(adjustments[r.ItemID]);
        const recorded = r.RecordedBalance || 0;
        const diff = actual - recorded;
        return {
          ItemID: r.ItemID,
          ItemName: r.ItemName,
          RecordedBalance: recorded,
          ActualBalance: actual,
          Difference: diff,
          AdjustmentType: diff > 0 ? 'increase' : diff < 0 ? 'decrease' : 'none',
        };
      })
      .filter((i: any) => i.AdjustmentType !== 'none');

    if (items.length === 0) {
      showToast('info', 'لا توجد تسويات للضبط');
      return;
    }

    const result = await window.api.invoke('settlements:apply', {
      section,
      items,
      userId: currentUserId(),
      fiscalYearId: activeFy.FiscalYearID,
    });

    if (result.success) {
      showToast('success', `تم تطبيق تسوية ${result.count} عنصر - رقم: ${result.settlementNumber}`);
      setAdjustments({});
      fetchData();
    } else {
      showToast('error', 'فشل تطبيق التسوية');
    }
  };

  const openDetails = async (settlementId: number) => {
    const result = await window.api.invoke('settlements:getDetails', settlementId);
    // A refusal is truthy, and `isOpen={!!detailsModal}` would then open a
    // modal whose table is fed `detailsModal.details` — a field a refusal does
    // not carry.
    if (isFailure(result)) {
      showToast('error', failureMessage(result, 'تعذر تحميل تفاصيل التسوية'));
      return;
    }
    setDetailsModal(result);
  };

  const tabBtnClass = (t: string) =>
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ' +
    (tab === t ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">التسوية الجردية</h1>
        {tab === 'adjust' && <Button onClick={handleSave} icon={<ClipboardCheck size={16} />}>حفظ وتطبيق التسوية</Button>}
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTab('adjust')} className={tabBtnClass('adjust')}><ClipboardCheck size={16} /> تسوية جديدة</button>
        <button onClick={() => setTab('history')} className={tabBtnClass('history')}><History size={16} /> سجل التسويات</button>
      </div>

      {tab === 'adjust' && (
        <>
          {/* Section selector */}
          <div className="flex gap-2 flex-wrap">
            {Object.entries(sectionLabels).map(([key, label]) => (
              <button key={key} onClick={() => setSection(key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${section === key ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
            أدخل الرصيد الفعلي لكل عنصر. سيتم حساب الفرق تلقائياً وتطبيقه على قاعدة البيانات عند الحفظ.
          </div>

          <DataTable
            columns={[
              { key: 'ItemName', title: 'الاسم', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.ItemName}</span> },
              { key: 'RecordedBalance', title: 'الرصيد المسجل', render: (r) => <span className="font-bold text-slate-700 dark:text-slate-200">{r.RecordedBalance?.toFixed(2)}</span> },
              {
                key: 'ActualBalance',
                title: 'الرصيد الفعلي',
                render: (r) => (
                  <input
                    type="number"
                    value={adjustments[r.ItemID] || ''}
                    onChange={(e) => handleActualChange(r.ItemID, e.target.value)}
                    placeholder={r.RecordedBalance?.toString()}
                    className="w-32 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-white"
                  />
                ),
              },
              {
                key: 'Difference',
                title: 'الفرق',
                render: (r) => {
                  const actual = adjustments[r.ItemID] !== undefined && adjustments[r.ItemID] !== '' ? parseFloat(adjustments[r.ItemID]) : null;
                  if (actual === null) return <span className="text-slate-500 dark:text-slate-400">—</span>;
                  const diff = actual - (r.RecordedBalance || 0);
                  return (
                    <Badge variant={diff === 0 ? 'gray' : diff > 0 ? 'green' : 'red'}>
                      {diff > 0 ? '+' : ''}{diff.toFixed(2)}
                    </Badge>
                  );
                },
              },
            ]}
            data={data}
            keyField="ItemID"
            emptyMessage="لا توجد بيانات"
          />
        </>
      )}

      {tab === 'history' && (
        <DataTable
          columns={[
            { key: 'SettlementNumber', title: 'رقم التسوية', render: (r) => <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{r.SettlementNumber}</span> },
            { key: 'Date', title: 'التاريخ', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Date}</span> },
            { key: 'Section', title: 'القسم', render: (r) => <Badge variant="blue">{sectionLabels[r.Section] || r.Section}</Badge> },
            { key: 'TotalDifference', title: 'إجمالي الفروقات', render: (r) => <span className="font-bold text-slate-800 dark:text-white">{r.TotalDifference?.toFixed(2)}</span> },
            { key: 'Username', title: 'المستخدم', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.Username}</span> },
            { key: 'actions', title: '', render: (r) => <button onClick={() => openDetails(r.SettlementID)} className="text-xs text-primary-600 hover:underline flex items-center gap-1"><Eye size={12} /> تفاصيل</button> },
          ]}
          data={settlements}
          keyField="SettlementID"
          emptyMessage="لا توجد تسويات سابقة"
        />
      )}

      {/* Details Modal */}
      <Modal isOpen={!!detailsModal} onClose={() => setDetailsModal(null)} title={`تفاصيل التسوية - ${detailsModal?.settlement?.SettlementNumber || ''}`} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailsModal(null)}>إغلاق</Button>}
      >
        {detailsModal && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2"><div className="text-xs text-slate-500 dark:text-slate-400">التاريخ</div><div className="text-sm font-medium text-slate-800 dark:text-white">{detailsModal.settlement?.Date}</div></div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2"><div className="text-xs text-slate-500 dark:text-slate-400">القسم</div><div className="text-sm font-medium text-slate-800 dark:text-white">{sectionLabels[detailsModal.settlement?.Section] || detailsModal.settlement?.Section}</div></div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-2"><div className="text-xs text-slate-500 dark:text-slate-400">إجمالي الفروقات</div><div className="text-sm font-bold text-slate-800 dark:text-white">{detailsModal.settlement?.TotalDifference?.toFixed(2)}</div></div>
            </div>
            <DataTable
              columns={[
                { key: 'ItemName', title: 'الاسم', render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.ItemName}</span> },
                { key: 'RecordedBalance', title: 'المسجل', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.RecordedBalance?.toFixed(2)}</span> },
                { key: 'ActualBalance', title: 'الفعلي', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.ActualBalance?.toFixed(2)}</span> },
                { key: 'Difference', title: 'الفرق', render: (r) => <Badge variant={r.Difference > 0 ? 'green' : 'red'}>{r.Difference > 0 ? '+' : ''}{r.Difference?.toFixed(2)}</Badge> },
              ]}
              data={asRows<Record<string, any>>(detailsModal.details)}
              keyField="DetailID"
              emptyMessage="لا توجد تفاصيل"
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
