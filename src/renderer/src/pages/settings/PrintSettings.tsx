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
  // Branding and provenance on printed documents.
  const [logoPath, setLogoPath] = useState('');
  const [showPrintUser, setShowPrintUser] = useState(true);
  const [thanksNote, setThanksNote] = useState('');
  const [terms, setTerms] = useState('');
  // Layout tunables. Every one of these was a hardcoded constant.
  const [fontSize, setFontSize] = useState('');
  const [fontFamily, setFontFamily] = useState('cairo');
  const [margin, setMargin] = useState('');
  const [logoHeight, setLogoHeight] = useState('');
  const [cols, setCols] = useState<Record<string, boolean>>({
    index: true, qty: true, price: true, total: true, imei: true,
  });

  useEffect(() => {
    (async () => {
      const settings = await window.api.invoke('settings:getAll');
      setSelectedTemplate(settings.default_invoice_template || '1');
      setShowCustomerInfo(settings.invoice_show_customer !== '0');
      setShowShopInfo(settings.invoice_show_shop !== '0');
      setPaperSize(settings.paper_size || '80mm');
      setDefaultAction(settings.print_default_action || 'preview');
      setLogoPath(settings.logo_path || '');
      setShowPrintUser(settings.print_show_user !== '0');
      setThanksNote(settings.invoice_thanks_note || '');
      setTerms(settings.invoice_terms || '');
      setFontSize(settings.print_font_size || '');
      setFontFamily(settings.print_font_family || 'cairo');
      setMargin(settings.print_margin || '');
      setLogoHeight(settings.print_logo_height || '');
      setCols({
        index: settings.print_col_index !== '0',
        qty: settings.print_col_qty !== '0',
        price: settings.print_col_price !== '0',
        total: settings.print_col_total !== '0',
        imei: settings.print_col_imei !== '0',
      });
    })();
  }, []);

  const handleSave = async () => {
    await window.api.invoke('settings:setMany', {
      default_invoice_template: selectedTemplate,
      invoice_show_customer: showCustomerInfo ? '1' : '0',
      invoice_show_shop: showShopInfo ? '1' : '0',
      paper_size: paperSize,
      print_default_action: defaultAction,
      logo_path: logoPath,
      print_show_user: showPrintUser ? '1' : '0',
      invoice_thanks_note: thanksNote,
      invoice_terms: terms,
      print_font_size: fontSize,
      print_font_family: fontFamily,
      print_margin: margin,
      print_logo_height: logoHeight,
      print_col_index: cols.index ? '1' : '0',
      print_col_qty: cols.qty ? '1' : '0',
      print_col_price: cols.price ? '1' : '0',
      print_col_total: cols.total ? '1' : '0',
      print_col_imei: cols.imei ? '1' : '0',
    });
    showToast('success', 'تم حفظ إعدادات الطباعة');
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Shop logo — the value already reached the printed invoice, but there
          was no way to set it, so it sat unused in the database. */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">شعار المحل</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          يظهر أعلى الفاتورة وكشف الحساب والتقارير.
        </p>
        <div className="flex items-center gap-3">
          {logoPath ? (
            <img src={logoPath} alt="شعار" className="h-14 w-auto max-w-[140px] object-contain rounded border border-slate-200 dark:border-slate-700 bg-white p-1" />
          ) : (
            <div className="h-14 w-24 rounded border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center text-[10px] text-slate-400">
              لا يوجد شعار
            </div>
          )}
          <div className="flex-1 space-y-2">
            <Button
              variant="secondary"
              onClick={async () => {
                const r = await window.api.invoke('settings:pickLogo');
                if (r?.success) { setLogoPath(r.dataUrl); showToast('success', 'تم اختيار الشعار - اضغط حفظ'); }
                else if (r?.message) showToast('error', r.message);
              }}
            >
              اختر صورة الشعار
            </Button>
            {logoPath && (
              <button type="button" onClick={() => setLogoPath('')}
                className="block text-xs text-red-600 hover:underline">
                إزالة الشعار
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Layout. Each of these replaced a hardcoded constant, so a shop whose
          printer clipped a column, or whose thermal roll needed a different
          margin, previously had no way to correct it. */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">تنسيق المستند</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              حجم الخط (نقطة) — اتركه فارغاً للافتراضي
            </label>
            <input type="number" min={7} max={24} value={fontSize} dir="ltr"
              onChange={(e) => setFontSize(e.target.value)} placeholder="14"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">نوع الخط</label>
            <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm">
              <option value="cairo">Cairo (افتراضي)</option>
              <option value="tahoma">Tahoma</option>
              <option value="arial">Arial</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              هامش الصفحة (مم) — لـ A4 و A5
            </label>
            <input type="number" min={0} max={40} value={margin} dir="ltr"
              onChange={(e) => setMargin(e.target.value)} placeholder="12"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              أقصى ارتفاع للشعار (بكسل)
            </label>
            <input type="number" min={20} max={200} value={logoHeight} dir="ltr"
              onChange={(e) => setLogoHeight(e.target.value)} placeholder="50"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          القيم خارج المدى المسموح تُضبط تلقائياً — لن يُطبع مستند بهامش مستحيل.
        </p>
      </div>

      {/* Which columns appear in the items table. */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">أعمدة جدول الأصناف</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          الورق الحراري 58مم ضيّق — أخفِ ما لا تحتاجه ليظهر الباقي بوضوح.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {([
            ['index', 'رقم مسلسل'],
            ['qty', 'الكمية'],
            ['price', 'سعر الوحدة'],
            ['total', 'الإجمالي'],
            ['imei', 'رقم IMEI تحت اسم الصنف'],
          ] as [string, string][]).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" checked={cols[key]}
                onChange={(e) => setCols({ ...cols, [key]: e.target.checked })}
                className="rounded" />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Provenance and free text on the document. */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">محتوى المستند</h2>

        <label className="flex items-start gap-2 mb-4 cursor-pointer">
          <input type="checkbox" checked={showPrintUser}
            onChange={(e) => setShowPrintUser(e.target.checked)} className="mt-1 rounded" />
          <span className="text-sm text-slate-700 dark:text-slate-300">
            طباعة اسم المستخدم الذي طبع المستند
            <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              يظهر أسفل المستند: «تمت الطباعة بواسطة: ... » مع التاريخ والوقت.
              مفيد عند مراجعة نزاع لمعرفة من أصدر النسخة.
            </span>
          </span>
        </label>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              عبارة الشكر أسفل الفاتورة
            </label>
            <input type="text" value={thanksNote} onChange={(e) => setThanksNote(e.target.value)}
              placeholder="شكراً لتعاملكم معنا"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              شروط البيع / ملاحظات (تظهر أسفل كل فاتورة)
            </label>
            <textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3}
              placeholder="مثال: البضاعة المباعة لا تُرد ولا تُستبدل بعد ١٤ يوماً - الضمان لا يشمل الكسر أو المياه"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm resize-none" />
          </div>
        </div>
      </div>

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
