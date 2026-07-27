import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useToastStore } from '../../components/ui/Toast';

const templates = [
  { id: '1', name: 'القالب الكلاسيكي', colors: { primary: '#2563eb', bg: '#ffffff' } },
  { id: '2', name: 'القالب العصري', colors: { primary: '#059669', bg: '#f0fdf4' } },
  { id: '3', name: 'القالب الأنيق', colors: { primary: '#7c3aed', bg: '#faf5ff' } },
  { id: '4', name: 'القالب البسيط', colors: { primary: '#475569', bg: '#f8fafc' } },
  { id: '5', name: 'القالب الملوّن', colors: { primary: '#dc2626', bg: '#fef2f2' } },
];

const paperSizes = [
  { value: '80mm', label: 'حراري 80mm', desc: 'ماكينة حرارية صغيرة' },
  { value: '58mm', label: 'حراري 58mm', desc: 'ماكينة حرارية صغيرة جداً' },
  { value: 'A5', label: 'A5', desc: 'نصف صفحة A4' },
  { value: 'A4', label: 'A4', desc: 'صفحة كاملة عادية' },
];

export function PrintSettings() {
  const { showToast } = useToastStore();
  const [selectedTemplate, setSelectedTemplate] = useState('1');
  const [showCustomerInfo, setShowCustomerInfo] = useState(true);
  const [showShopInfo, setShowShopInfo] = useState(true);
  const [paperSize, setPaperSize] = useState('80mm');
  const [defaultAction, setDefaultAction] = useState('preview');

  useEffect(() => {
    (async () => {
      const settings = await window.api.invoke('settings:getAll');
      setSelectedTemplate(settings.default_invoice_template || '1');
      setShowCustomerInfo(settings.invoice_show_customer !== '0');
      setShowShopInfo(settings.invoice_show_shop !== '0');
      setPaperSize(settings.paper_size || '80mm');
      setDefaultAction(settings.print_default_action || 'preview');
    })();
  }, []);

  const handleSave = async () => {
    await window.api.invoke('settings:setMany', {
      default_invoice_template: selectedTemplate,
      invoice_show_customer: showCustomerInfo ? '1' : '0',
      invoice_show_shop: showShopInfo ? '1' : '0',
      paper_size: paperSize,
      print_default_action: defaultAction,
    });
    showToast('success', 'تم حفظ إعدادات الطباعة');
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Paper Size */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">حجم الورق الافتراضي</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {paperSizes.map(ps => (
            <button key={ps.value} onClick={() => setPaperSize(ps.value)}
              className={`p-4 rounded-xl border-2 text-center transition-all ${paperSize === ps.value ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
              <div className={`font-bold text-sm ${paperSize === ps.value ? 'text-primary-700 dark:text-primary-300' : 'text-slate-700 dark:text-slate-200'}`}>{ps.label}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">{ps.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Default Action */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">سلوك زر الطباعة</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">عند الضغط على زر الطباعة في الفاتورة، ماذا يحدث؟</p>
        <div className="flex gap-3">
          <button onClick={() => setDefaultAction('preview')}
            className={`flex-1 p-4 rounded-xl border-2 text-center transition-all ${defaultAction === 'preview' ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="font-bold text-sm text-slate-700 dark:text-slate-200">معاينة أولاً</div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">يفتح معاينة + زر طباعة</div>
          </button>
          <button onClick={() => setDefaultAction('print')}
            className={`flex-1 p-4 rounded-xl border-2 text-center transition-all ${defaultAction === 'print' ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="font-bold text-sm text-slate-700 dark:text-slate-200">طباعة مباشرة</div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">يفتح نافذة الطباعة مباشرة</div>
          </button>
        </div>
      </div>

      {/* Templates */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">قوالب الفاتورة</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((tmpl) => (
            <button key={tmpl.id} onClick={() => setSelectedTemplate(tmpl.id)}
              className={`p-4 rounded-xl border-2 transition-all text-right ${selectedTemplate === tmpl.id ? 'border-primary-600 ring-2 ring-primary-200' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
              <div className="rounded-lg p-3 mb-3" style={{ backgroundColor: tmpl.colors.bg }}>
                <div className="h-2 rounded-full mb-2" style={{ backgroundColor: tmpl.colors.primary, width: '40%' }} />
                <div className="h-1.5 rounded-full mb-1 bg-slate-200" style={{ width: '100%' }} />
                <div className="h-1.5 rounded-full mb-1 bg-slate-200" style={{ width: '80%' }} />
                <div className="h-1.5 rounded-full bg-slate-200" style={{ width: '60%' }} />
                <div className="mt-2 h-3 rounded" style={{ backgroundColor: tmpl.colors.primary, width: '30%' }} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{tmpl.name}</span>
                {selectedTemplate === tmpl.id && <span className="text-xs text-primary-600 font-medium">مُختار</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Options */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">خيارات العرض</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={showCustomerInfo} onChange={(e) => setShowCustomerInfo(e.target.checked)} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">إظهار بيانات العميل</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={showShopInfo} onChange={(e) => setShowShopInfo(e.target.checked)} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">إظهار بيانات المحل</span>
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} icon={<Save size={16} />}>حفظ إعدادات الطباعة</Button>
      </div>
    </div>
  );
}
