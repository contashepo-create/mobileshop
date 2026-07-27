import { useState, useEffect } from 'react';
import {
  Save, Bell, BellOff, RotateCcw, Moon, Users, Truck, Wrench, Package,
  User, Wallet, ChevronDown, ChevronLeft, ShieldCheck,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useToastStore } from '../../components/ui/Toast';

/**
 * Control panel for the smart-notification engine.
 *
 * The whole screen is GENERATED from the rule catalogue the main process sends
 * back with the preferences. Nothing about a rule is written twice: adding one
 * to `src/main/notifications/prefs.ts` makes its switch, its priority selector
 * and its numeric thresholds appear here automatically, with the correct
 * limits already enforced.
 *
 * Developer messages are intentionally absent. They arrive through a separate
 * channel and are not affected by anything on this page — the panel at the
 * bottom says so explicitly rather than leaving the owner to wonder why the
 * switches do not cover them.
 */

const CATEGORY_ICONS: Record<string, typeof Users> = {
  customer: Users, supplier: Truck, maintenance: Wrench,
  inventory: Package, employee: User, financial: Wallet,
};

const PRIORITIES = [
  { key: 'critical', label: 'حرج', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  { key: 'high', label: 'مهم', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  { key: 'medium', label: 'متوسط', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300' },
  { key: 'low', label: 'منخفض', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
];

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const UNIT_SUFFIX: Record<string, string> = {
  money: 'ج.م', days: 'يوم', count: 'عدد',
};

interface RuleParam {
  key: string; label: string; unit: string;
  def: number; min: number; max: number; hint?: string;
}
interface Rule {
  id: string; category: string; label: string; description: string;
  icon: string; params: RuleParam[];
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 ${className}`}>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
        checked ? 'bg-primary-600' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      {/* RTL: the knob travels leftwards when switched on. */}
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
          checked ? 'right-0.5' : 'right-[22px]'
        }`}
      />
    </button>
  );
}

export function NotificationSettings() {
  const { showToast } = useToastStore();
  const [prefs, setPrefs] = useState<any>(null);
  const [catalogue, setCatalogue] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = async () => {
    try {
      const res = await window.api.invoke('notifications:getPrefs');
      setPrefs(res.prefs);
      setCatalogue(res.catalogue || []);
      setCategories(res.categories || {});
    } catch {
      showToast('error', 'تعذّر تحميل إعدادات الإشعارات');
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const setGlobal = (key: string, value: unknown) =>
    setPrefs((p: any) => ({ ...p, global: { ...p.global, [key]: value } }));

  const setRule = (id: string, patch: Record<string, unknown>) =>
    setPrefs((p: any) => ({ ...p, rules: { ...p.rules, [id]: { ...p.rules[id], ...patch } } }));

  const setParam = (id: string, key: string, value: number) =>
    setPrefs((p: any) => ({
      ...p,
      rules: {
        ...p.rules,
        [id]: { ...p.rules[id], params: { ...p.rules[id].params, [key]: value } },
      },
    }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await window.api.invoke('notifications:setPrefs', prefs);
      // The main process clamps out-of-range numbers, so adopt what it stored
      // rather than what was typed — otherwise the screen would keep showing a
      // value that was never saved.
      if (res?.prefs) setPrefs(res.prefs);
      showToast('success', 'تم حفظ إعدادات الإشعارات');
    } catch {
      showToast('error', 'فشل حفظ الإعدادات');
    }
    setSaving(false);
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await window.api.invoke('notifications:resetPrefs');
      if (res?.prefs) setPrefs(res.prefs);
      showToast('success', 'تمت الاستعادة للإعدادات الافتراضية');
    } catch {
      showToast('error', 'فشلت الاستعادة');
    }
    setSaving(false);
  };

  const bulk = (enabled: boolean) =>
    setPrefs((p: any) => {
      const rules = { ...p.rules };
      for (const r of catalogue) rules[r.id] = { ...rules[r.id], enabled };
      return { ...p, rules };
    });

  if (loading || !prefs) {
    return <div className="text-slate-500 dark:text-slate-400">جاري التحميل...</div>;
  }

  const byCategory = catalogue.reduce<Record<string, Rule[]>>((acc, r) => {
    (acc[r.category] ||= []).push(r);
    return acc;
  }, {});

  const activeCount = catalogue.filter(r => prefs.rules[r.id]?.enabled).length;

  return (
    <div className="max-w-3xl space-y-5">
      {/* ---------------------------------------------------------- master */}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {prefs.global.enabled
              ? <Bell size={22} className="text-primary-600 mt-0.5" />
              : <BellOff size={22} className="text-slate-400 mt-0.5" />}
            <div>
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">
                نظام التنبيهات الذكي
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                {prefs.global.enabled
                  ? `مُفعّل — ${activeCount} من ${catalogue.length} تنبيه نشط`
                  : 'موقوف بالكامل — لن تظهر أي تنبيهات'}
              </p>
            </div>
          </div>
          <Toggle
            checked={prefs.global.enabled}
            onChange={v => setGlobal('enabled', v)}
            label="تشغيل نظام التنبيهات"
          />
        </div>
      </Card>

      {/* ---------------------------------------------------------- general */}
      <Card>
        <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-4">
          إعدادات عامة
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
              أقل أهمية تظهر لك
            </label>
            <div className="flex gap-2 flex-wrap">
              {PRIORITIES.map(p => (
                <button
                  key={p.key}
                  onClick={() => setGlobal('minPriority', p.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    prefs.global.minPriority === p.key
                      ? `${p.cls} ring-2 ring-primary-500`
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {p.label} فأعلى
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              اختيار «مهم فأعلى» يخفي التنبيهات المتوسطة والمنخفضة تماماً.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
                أقصى عدد تنبيهات معروضة
              </label>
              <input
                type="number" min={1} max={500}
                value={prefs.global.maxItems}
                onChange={e => setGlobal('maxItems', Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
                تحديث التنبيهات كل (دقيقة)
              </label>
              <input
                type="number" min={1} max={240}
                value={prefs.global.refreshMinutes}
                onChange={e => setGlobal('refreshMinutes', Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
              أيام العمل التي تريد التنبيهات فيها
            </label>
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  onClick={() => {
                    const days = [...prefs.global.days];
                    days[i] = !days[i];
                    setGlobal('days', days);
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    prefs.global.days[i]
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-400'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------ quiet hours */}
      <Card>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-start gap-3">
            <Moon size={20} className="text-indigo-500 mt-0.5" />
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-white">
                ساعات الهدوء
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                إيقاف التنبيهات في أوقات محددة (مثلاً بعد إغلاق المحل)
              </p>
            </div>
          </div>
          <Toggle
            checked={prefs.global.quietEnabled}
            onChange={v => setGlobal('quietEnabled', v)}
            label="تفعيل ساعات الهدوء"
          />
        </div>

        {prefs.global.quietEnabled && (
          <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-700">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
                  من الساعة
                </label>
                <select
                  value={prefs.global.quietFrom}
                  onChange={e => setGlobal('quietFrom', Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1.5">
                  إلى الساعة
                </label>
                <select
                  value={prefs.global.quietTo}
                  onChange={e => setGlobal('quietTo', Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.global.quietAllowCritical}
                onChange={e => setGlobal('quietAllowCritical', e.target.checked)}
                className="w-4 h-4 rounded accent-primary-600"
              />
              اسمح للتنبيهات <b>الحرجة</b> بالظهور رغم ساعات الهدوء
            </label>
          </div>
        )}
      </Card>

      {/* ----------------------------------------------------------- rules */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-800 dark:text-white">
          التنبيهات التفصيلية
        </h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => bulk(true)}>تفعيل الكل</Button>
          <Button size="sm" variant="outline" onClick={() => bulk(false)}>إيقاف الكل</Button>
        </div>
      </div>

      {Object.entries(byCategory).map(([cat, rules]) => {
        const Icon = CATEGORY_ICONS[cat] || Bell;
        return (
          <Card key={cat}>
            <div className="flex items-center gap-2 mb-3">
              <Icon size={18} className="text-primary-600" />
              <h4 className="font-semibold text-slate-800 dark:text-white">
                {categories[cat] || cat}
              </h4>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-700">
              {rules.map(rule => {
                const state = prefs.rules[rule.id];
                if (!state) return null;
                const isOpen = open[rule.id];
                return (
                  <div key={rule.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        onClick={() => setOpen(o => ({ ...o, [rule.id]: !o[rule.id] }))}
                        className="flex items-start gap-2 text-right flex-1 min-w-0"
                        disabled={!state.enabled}
                      >
                        {rule.params.length > 0 && (
                          isOpen
                            ? <ChevronDown size={15} className="mt-1 text-slate-400 shrink-0" />
                            : <ChevronLeft size={15} className="mt-1 text-slate-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className={`text-sm font-medium ${
                            state.enabled
                              ? 'text-slate-800 dark:text-white'
                              : 'text-slate-400 dark:text-slate-500 line-through'
                          }`}>
                            {rule.label}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {rule.description}
                          </div>
                        </div>
                      </button>
                      <Toggle
                        checked={state.enabled}
                        onChange={v => setRule(rule.id, { enabled: v })}
                        label={rule.label}
                      />
                    </div>

                    {state.enabled && isOpen && (
                      <div className="mt-3 mr-6 space-y-3 bg-slate-50 dark:bg-slate-900/40 rounded-lg p-3">
                        <div>
                          <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                            درجة الأهمية
                          </label>
                          <div className="flex gap-1.5 flex-wrap">
                            {PRIORITIES.map(p => (
                              <button
                                key={p.key}
                                onClick={() => setRule(rule.id, { priority: p.key })}
                                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                                  state.priority === p.key
                                    ? `${p.cls} ring-2 ring-primary-500`
                                    : 'bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {rule.params.map(p => (
                          <div key={p.key}>
                            <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                              {p.label}
                              <span className="text-slate-400"> ({UNIT_SUFFIX[p.unit] || ''})</span>
                            </label>
                            <input
                              type="number"
                              min={p.min}
                              max={p.max}
                              value={state.params[p.key] ?? p.def}
                              onChange={e => setParam(rule.id, p.key, Number(e.target.value))}
                              className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                            />
                            {p.hint && (
                              <p className="text-[10px] text-slate-400 mt-0.5">{p.hint}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      {/* --------------------------------------------------- developer note */}
      <Card className="border-primary-200 dark:border-primary-800 bg-primary-50/40 dark:bg-primary-900/10">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="text-primary-600 mt-0.5 shrink-0" />
          <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
            <b className="text-slate-800 dark:text-white">رسائل المطور</b>
            <p className="mt-1">
              الإعدادات في هذه الصفحة تتحكم في تنبيهات <b>بيانات محلك</b> فقط
              (العملاء، المخزون، الخزينة…).
            </p>
            <p className="mt-1.5">
              أما رسائل المطور وتنبيهات انتهاء الاشتراك فتصلك عبر مسار منفصل
              ولا تتأثر بأي خيار هنا — لأنها الرسائل التي لا يصح أن تفوتك.
            </p>
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------- actions */}
      <div className="flex items-center justify-between gap-3 pb-4">
        <Button variant="outline" onClick={reset} disabled={saving} icon={<RotateCcw size={16} />}>
          استعادة الافتراضي
        </Button>
        <Button onClick={save} loading={saving} icon={<Save size={16} />}>
          حفظ الإعدادات
        </Button>
      </div>
    </div>
  );
}
