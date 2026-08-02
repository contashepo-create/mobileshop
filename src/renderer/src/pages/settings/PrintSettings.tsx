import { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import {
  DOCUMENT_TYPES, DOCUMENT_LABELS, COLUMN_KEYS, COLUMN_LABELS,
  MANDATORY_COLUMNS, resolveProfile, profileKeys,
  type DocumentType, type ColumnKey, type PrintProfile,
} from '../../../../shared/printProfile';
import { Button } from '../../components/ui/Button';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';
import { SettingsHeader } from '../../components/shared/SettingsHeader';

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

  /**
   * Per-document overrides.
   *
   * `docType` is which document the panel below is editing; `profiles` holds
   * the resolved settings for every type. They are resolved from the SAME
   * module the printer uses, so what this screen shows is what will print.
   */
  const [docType, setDocType] = useState<DocumentType>('sale');
  const [profiles, setProfiles] = useState<Record<string, PrintProfile>>({});
  const [rawSettings, setRawSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  /**
   * A snapshot of what was loaded, so the header can say whether anything is
   * pending. Compared as JSON rather than field by field: the page has
   * seventeen global fields plus a profile per document type, and a hand-rolled
   * comparison would silently stop noticing whichever field was added last.
   */
  const [baseline, setBaseline] = useState('');
  const [loaded, setLoaded] = useState(false);

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
      setRawSettings(settings);
      const resolved: Record<string, PrintProfile> = {};
      for (const t of DOCUMENT_TYPES) resolved[t] = resolveProfile(settings, t);
      setProfiles(resolved);
      setLoaded(true);
    })();
  }, []);

  // Taken AFTER the state has been applied, not inside the loader: setState is
  // asynchronous, so a snapshot taken there would capture the previous values
  // and the page would open already claiming unsaved changes.
  useEffect(() => {
    if (loaded && baseline === '') setBaseline(snapshot());
  });

  /**
   * Everything this page owns, in one comparable value.
   *
   * Used both for the dirty marker and to reset it after a successful save,
   * so the two can never disagree about what "saved" means.
   */
  const snapshot = () => JSON.stringify({
    selectedTemplate, showCustomerInfo, showShopInfo, paperSize, defaultAction,
    logoPath, showPrintUser, thanksNote, terms,
    fontSize, fontFamily, margin, logoHeight, cols, profiles,
  });

  const dirty = baseline !== '' && snapshot() !== baseline;

  const handleSave = async () => {
    // The reply is CHECKED. `settings:setMany` is permission-gated
    // (`settings.edit`) and the IPC guard answers a refusal — an expired
    // session, or a user without the permission — with
    // `{ success: false, message, code }` rather than by throwing. Ignoring it
    // and showing the success toast anyway is what made a failed logo save
    // look like a successful one: the shop pressed حفظ, was told the settings
    // were saved, and nothing had been written.
    setSaving(true);
    try {
    const reply = await window.api.invoke('settings:setMany', {
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
      ...perDocumentPayload(),
    });
    if (isFailure(reply)) {
      showToast('error', failureMessage(reply, 'تعذّر حفظ إعدادات الطباعة'));
      return;
    }

    // Read the settings back and confirm the logo really landed.
    //
    // A logo is a large value — a 400 KB image becomes ~533 KB of base64 —
    // and it is the one setting where "saved" and "stored" can diverge. Saying
    // so immediately is far better than the shop discovering it on a printed
    // invoice in front of a customer.
    const after = await window.api.invoke('settings:getAll');
    if (!isFailure(after) && (after?.logo_path || '') !== logoPath) {
      showToast('error', 'لم يُحفظ الشعار - جرّب صورة أصغر حجماً');
      return;
    }
    // Only now is the page clean. Clearing the marker before the write, or on
    // a failed one, would tell the shop its changes are safe when they are not.
    setBaseline(snapshot());
    showToast('success', 'تم حفظ إعدادات الطباعة');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Flattens the per-document profiles back into settings keys.
   *
   * Written as an explicit list from `profileKeys` rather than by spreading
   * whatever happens to be on the object: the settings table is shared with
   * accounting and security values, and a screen that writes arbitrary keys
   * into it is a way to overwrite one by accident.
   */
  const perDocumentPayload = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const t of DOCUMENT_TYPES) {
      const pf = profiles[t];
      if (!pf) continue;
      out[`print_doc_${t}_template`] = pf.template;
      out[`print_doc_${t}_paper`] = pf.paper;
      out[`print_doc_${t}_copies`] = String(pf.copies);
      out[`print_doc_${t}_order`] = pf.order.join(',');
      out[`print_doc_${t}_header`] = pf.headerText;
      out[`print_doc_${t}_footer`] = pf.footerText;
      out[`print_doc_${t}_qr`] = pf.showQr ? '1' : '0';
      for (const k of COLUMN_KEYS) out[`print_doc_${t}_col_${k}`] = pf.columns[k] ? '1' : '0';
    }
    return out;
  };

  /** Updates one field of the document currently being edited. */
  const patchProfile = (patch: Partial<PrintProfile>) =>
    setProfiles((prev) => ({ ...prev, [docType]: { ...prev[docType], ...patch } }));

  /** Moves a column up or down in the print order. */
  const moveColumn = (key: ColumnKey, delta: number) => {
    const pf = profiles[docType];
    if (!pf) return;
    const order = [...pf.order];
    const i = order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    patchProfile({ order });
  };

  /**
   * Restores this document to following the global settings.
   *
   * Writing empty strings makes `resolveProfile` fall through to the global
   * value again, which is exactly what "no override" means. Deleting the rows
   * would work too, but `settings:setMany` only upserts, and an empty string
   * is already treated as absent by the resolver.
   */
  const clearOverrides = async () => {
    const cleared: Record<string, string> = {};
    for (const k of profileKeys(docType)) cleared[k] = '';
    const reply = await window.api.invoke('settings:setMany', cleared);
    if (isFailure(reply)) {
      showToast('error', failureMessage(reply, 'تعذّر إلغاء التخصيص'));
      return;
    }
    const settings = await window.api.invoke('settings:getAll');
    setRawSettings(settings);
    const resolved: Record<string, PrintProfile> = {};
    for (const t of DOCUMENT_TYPES) resolved[t] = resolveProfile(settings, t);
    setProfiles(resolved);
    showToast('success', `أُعيد ${DOCUMENT_LABELS[docType]} إلى الإعدادات العامة`);
  };

  /** True when this document has at least one stored override of its own. */
  const hasOverrides = (t: DocumentType): boolean =>
    profileKeys(t).some((k) => String(rawSettings[k] ?? '').trim() !== '');

  return (
    <div className="max-w-3xl space-y-6">
      <SettingsHeader
        title="الطباعة والفواتير"
        description="الشعار، تنسيق المستند، الأعمدة، وإعدادات كل نوع مستند على حدة"
        onSave={handleSave}
        saving={saving}
        dirty={dirty}
        saveLabel="حفظ إعدادات الطباعة"
      />
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

      {/* Per-document overrides. Everything above is GLOBAL; this panel lets one
          kind of document differ. A sales invoice goes to the customer on a
          thermal roll, a purchase invoice is an internal A4 record, and a
          receipt voucher has no line items at all — one shared answer was
          wrong for all but one of them. */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">إعدادات كل مستند على حدة</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          اختر نوع المستند ثم عدّل ما يخصه. أي إعداد لا تغيّره هنا يتبع الإعدادات العامة أعلاه تلقائياً.
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {DOCUMENT_TYPES.map((t) => (
            <button key={t} type="button" onClick={() => setDocType(t)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                docType === t
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600'
              }`}>
              {DOCUMENT_LABELS[t]}
              {hasOverrides(t) && <span className="mr-1 text-[10px]">●</span>}
            </button>
          ))}
        </div>

        {profiles[docType] && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">القالب</label>
                <select value={profiles[docType].template}
                  onChange={(e) => patchProfile({ template: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">حجم الورق</label>
                <select value={profiles[docType].paper}
                  onChange={(e) => patchProfile({ paper: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm">
                  {paperSizes.map((ps) => <option key={ps.value} value={ps.value}>{ps.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">عدد النسخ</label>
                <input type="number" min={1} max={5} dir="ltr"
                  value={profiles[docType].copies}
                  onChange={(e) => patchProfile({ copies: Math.min(5, Math.max(1, parseInt(e.target.value) || 1)) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm" />
              </div>
            </div>

            {/* Column ORDER and visibility together. They were two separate
                problems before and only visibility was solvable. */}
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">
                ترتيب الأعمدة وإظهارها — الأعلى يُطبع أولاً (من اليمين)
              </label>
              <div className="space-y-1">
                {profiles[docType].order.map((key, idx) => {
                  const required = MANDATORY_COLUMNS.includes(key);
                  return (
                    <div key={key}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600">
                      <span className="text-xs text-slate-400 w-4">{idx + 1}</span>
                      <input type="checkbox" checked={profiles[docType].columns[key] || required}
                        disabled={required}
                        onChange={(e) => patchProfile({
                          columns: { ...profiles[docType].columns, [key]: e.target.checked },
                        })}
                        className="rounded disabled:opacity-50" />
                      <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">
                        {COLUMN_LABELS[key]}
                        {required && <span className="text-[10px] text-slate-400 mr-2">(إجباري)</span>}
                      </span>
                      <button type="button" onClick={() => moveColumn(key, -1)} disabled={idx === 0}
                        className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-30"
                        title="لأعلى"><ArrowUp size={14} /></button>
                      <button type="button" onClick={() => moveColumn(key, 1)}
                        disabled={idx === profiles[docType].order.length - 1}
                        className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-30"
                        title="لأسفل"><ArrowDown size={14} /></button>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                اسم الصنف إجباري — فاتورة تقول &quot;٢ × ١٥٠&quot; دون ذكر الصنف ليست مستنداً يُعتد به.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  نص أعلى المستند (خاص بهذا النوع)
                </label>
                <textarea rows={2} value={profiles[docType].headerText}
                  onChange={(e) => patchProfile({ headerText: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  نص أسفل المستند (خاص بهذا النوع)
                </label>
                <textarea rows={2} value={profiles[docType].footerText}
                  onChange={(e) => patchProfile({ footerText: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm" />
              </div>
            </div>

            <button type="button" onClick={clearOverrides}
              className="text-xs text-red-600 hover:underline">
              إلغاء تخصيص {DOCUMENT_LABELS[docType]} والعودة للإعدادات العامة
            </button>
          </div>
        )}
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

    </div>
  );
}
