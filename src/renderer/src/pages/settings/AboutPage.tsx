import { useState, useEffect } from 'react';
import {
  Info, Phone, Mail, User, Copyright, FileText, Hash, Globe, Send, MapPin,
  CreditCard, Clock, Cloud, CloudOff, ShieldCheck, RefreshCw, ChevronDown, Facebook,
  Download, DownloadCloud,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { asRows } from '../../lib/ipc';

/** Egyptian local number (01x…) -> international digits, for wa.me / t.me. */
function toInternational(local: string): string {
  const d = (local || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('20')) return d;
  if (d.startsWith('0')) return `20${d.slice(1)}`;
  return `20${d}`;
}

export function AboutPage() {
  const [info, setInfo] = useState<any>({});
  const [sync, setSync] = useState<any>(null);
  const [privacy, setPrivacy] = useState<any>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [updaterState, setUpdaterState] = useState<{ state: string; percent?: number; message?: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    const s = await window.api.invoke('settings:getAll');
    // The version shown here is the REAL installed build, not the `app_version`
    // setting (a branding value the developer can change remotely). app:getVersion
    // returns what the packaging tool stamped into the exe, i.e. what is running.
    const installed = await window.api.invoke('app:getVersion').catch(() => s.app_version || '');
    setInfo({
      app_name: s.app_name || 'موبايل شوب سيستم',
      app_version: installed || s.app_version || '1.0.0',
      app_edition: s.app_edition || '',
      latest_version: s.latest_version || '',
      release_notes: s.release_notes || '',
      company_name: s.company_name || '',
      dev_name: s.dev_name || 'محاسب / محمد عبدة',
      dev_title: s.dev_title || '',
      dev_phone: s.dev_phone || '',
      dev_whatsapp: s.dev_whatsapp || s.dev_phone || '',
      dev_telegram: s.dev_telegram || '',
      dev_email: s.dev_email || '',
      dev_website: s.dev_website || '',
      dev_facebook: s.dev_facebook || '',
      dev_address: s.dev_address || '',
      payment_info: s.payment_info || '',
      subscription_note: s.subscription_note || '',
      support_hours: s.support_hours || '',
      copyright: s.copyright || '',
      distribution_rights: s.distribution_rights || '',
      terms_note: s.terms_note || '',
      custom_content: s.custom_content || '',
      custom_block_title: s.custom_block_title || '',
      custom_block_body: s.custom_block_body || '',
      about_footer: s.about_footer || '',
    });
  };

  useEffect(() => {
    void load();
    (async () => {
      try {
        setSync(await window.api.invoke('remote:syncInfo'));
        setPrivacy(await window.api.invoke('remote:privacyReport'));
      } catch { /* remote feature not configured */ }
    })();
    // Sync the manual-update UI with what the background updater is doing.
    void window.api.invoke('updater:getStatus').then((s: any) => {
      if (s) setUpdaterState({ state: s.state === 'downloaded' ? 'downloaded' : s.state });
    }).catch(() => { /* dev build: updater not registered */ });
    const off = window.api.on('updater:status', (s: any) => {
      if (s) setUpdaterState(s);
    });
    return () => { /* preload `on` keeps no unsubscribe handle; GC after unmount */ };
  }, []);

  const checkForUpdates = async () => {
    setChecking(true);
    await window.api.invoke('updater:check').catch(() => {});
    // Manual checks report back through 'updater:status' (downloading/downloaded/error).
    setTimeout(() => setChecking(false), 1200);
  };

  const updateNow = async () => {
    await window.api.invoke('updater:updateNow').catch(() => {});
  };

  const syncNow = async () => {
    setSyncing(true);
    const res = await window.api.invoke('remote:syncNow');
    setSync(res);
    await load();
    setSyncing(false);
  };

  const updateAvailable =
    info.latest_version && info.latest_version !== info.app_version;

  const wa = toInternational(info.dev_whatsapp);
  const tg = (info.dev_telegram || '').replace(/^@/, '');

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-8">
      <div className="flex items-center gap-3">
        <Info size={24} className="text-primary-600" />
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">حول البرنامج</h1>
      </div>

      {/* Identity */}
      <Card>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-primary-600 flex items-center justify-center shrink-0">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
              <path d="M12 18h.01" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-800 dark:text-white">{info.app_name}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400">
                <Hash size={13} /> الإصدار {info.app_version}
              </span>
              {info.app_edition && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">
                  {info.app_edition}
                </span>
              )}
            </div>
          </div>
        </div>

        {updateAvailable && (
          <div className="mt-4 space-y-3">
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  يتوفر إصدار أحدث: {info.latest_version}
                </div>
                <Button size="sm" onClick={checkForUpdates} loading={checking}
                  icon={<Download size={13} />}>
                  {checking ? 'جارٍ الفحص…' : 'تنزيل التحديث'}
                </Button>
              </div>
              {info.release_notes && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                  {info.release_notes}
                </div>
              )}
            </div>

            {updaterState && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
                {updaterState.state === 'checking' && (
                  <div className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-300">
                    <RefreshCw size={14} className="animate-spin" /> جارٍ التحقق من التحديثات…
                  </div>
                )}
                {updaterState.state === 'downloading' && (
                  <div>
                    <div className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-300 mb-1.5">
                      <DownloadCloud size={14} /> جارٍ تنزيل التحديث في الخلفية…
                    </div>
                    <div className="bg-white/70 dark:bg-slate-900/40 rounded-full h-1.5 overflow-hidden">
                      <div className="bg-blue-600 h-full rounded-full transition-all"
                        style={{ width: `${updaterState.percent ?? 0}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-blue-700/70 dark:text-blue-300/70 text-left">
                      {updaterState.percent ?? 0}%
                    </div>
                  </div>
                )}
                {updaterState.state === 'downloaded' && (
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-300">
                      <ShieldCheck size={15} /> التحديث جاهز — أعد تشغيل البرنامج لتطبيقه الآن.
                    </div>
                    <Button size="sm" variant="secondary" onClick={updateNow}
                      icon={<RefreshCw size={13} />}>
                      إعادة التشغيل وتطبيق التحديث
                    </Button>
                  </div>
                )}
                {updaterState.state === 'uptodate' && (
                  <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-300">
                    <ShieldCheck size={14} /> النسخة المثبتة هي الأحدث.
                  </div>
                )}
                {updaterState.state === 'error' && (
                  <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300">
                    <CloudOff size={14} />
                    <span>{updaterState.message || 'تعذر الاتصال بخادم التحديثات — سيتحقق البرنامج تلقائياً لاحقاً.'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Developer */}
      <Card title="بيانات المطور">
        <div className="space-y-2.5">
          <Row icon={<User size={14} className="text-blue-600" />} tone="blue"
            label={info.dev_title || 'المطور'} value={info.dev_name} />
          {info.dev_phone && (
            <Row icon={<Phone size={14} className="text-green-600" />} tone="green"
              label="الهاتف" value={info.dev_phone} href={`tel:${info.dev_phone}`} />
          )}
          {info.dev_whatsapp && (
            <Row icon={<Phone size={14} className="text-emerald-600" />} tone="emerald"
              label="واتساب" value={info.dev_whatsapp} href={`https://wa.me/${wa}`} />
          )}
          {tg && (
            <Row icon={<Send size={14} className="text-sky-600" />} tone="sky"
              label="تليجرام" value={`@${tg}`} href={`https://t.me/${tg}`} />
          )}
          {info.dev_email && (
            <Row icon={<Mail size={14} className="text-purple-600" />} tone="purple"
              label="البريد الإلكتروني" value={info.dev_email} href={`mailto:${info.dev_email}`} />
          )}
          {info.dev_website && (
            <Row icon={<Globe size={14} className="text-indigo-600" />} tone="indigo"
              label="الموقع" value={info.dev_website} href={info.dev_website} />
          )}
          {info.dev_facebook && (
            <Row icon={<Facebook size={14} className="text-blue-700" />} tone="blue"
              label="فيسبوك" value={info.dev_facebook} href={info.dev_facebook} />
          )}
          {info.dev_address && (
            <Row icon={<MapPin size={14} className="text-rose-600" />} tone="rose"
              label="العنوان" value={info.dev_address} />
          )}
          {info.support_hours && (
            <Row icon={<Clock size={14} className="text-amber-600" />} tone="amber"
              label="مواعيد الدعم" value={info.support_hours} />
          )}
        </div>
      </Card>

      {/* Payment / subscription */}
      {(info.payment_info || info.subscription_note) && (
        <Card title="الاشتراك والدفع" icon={<CreditCard size={17} className="text-teal-600" />}>
          {info.subscription_note && (
            <p className="text-sm text-slate-700 dark:text-slate-200 mb-2">{info.subscription_note}</p>
          )}
          {info.payment_info && (
            <div className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 leading-relaxed">
              {info.payment_info}
            </div>
          )}
        </Card>
      )}

      {/* Legal */}
      {(info.copyright || info.distribution_rights || info.terms_note) && (
        <Card title="حقوق النشر والتوزيع" icon={<Copyright size={17} className="text-orange-600" />}>
          {info.copyright && <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">{info.copyright}</p>}
          {info.distribution_rights && <p className="text-xs text-slate-500 dark:text-slate-400">{info.distribution_rights}</p>}
          {info.terms_note && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 whitespace-pre-wrap">{info.terms_note}</p>
          )}
        </Card>
      )}

      {/* Free-form blocks */}
      {info.custom_content && (
        <Card title="معلومات إضافية" icon={<FileText size={17} className="text-purple-600" />}>
          <div className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {info.custom_content}
          </div>
        </Card>
      )}
      {info.custom_block_body && (
        <Card title={info.custom_block_title || 'ملاحظات'} icon={<FileText size={17} className="text-cyan-600" />}>
          <div className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {info.custom_block_body}
          </div>
        </Card>
      )}

      {/* Connection + privacy */}
      {sync && (
        <Card title="الاتصال بالمطور" icon={sync.enabled
          ? <Cloud size={17} className="text-green-600" />
          : <CloudOff size={17} className="text-slate-400" />}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-slate-600 dark:text-slate-300">
              {sync.enabled ? (
                <>
                  <div>الحالة: {sync.lastSyncOk ? 'متصل ✓' : 'تعذّر الاتصال آخر مرة'}</div>
                  <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                    آخر مزامنة: {sync.lastSync ? new Date(sync.lastSync).toLocaleString('ar-EG') : 'لم تتم بعد'}
                  </div>
                </>
              ) : (
                <div>البرنامج يسجل اتصاله تلقائياً بخادم المطور ليستقبل التحديثات والرسائل; وحين يتعذّر الاتصال (لا إنترنت) يتابع عملك بلا توقف.</div>
              )}
            </div>
            {sync.enabled && (
              <Button size="sm" variant="secondary" onClick={syncNow} loading={syncing}
                icon={<RefreshCw size={13} />}>تحديث الآن</Button>
            )}
          </div>

          <button
            onClick={() => setShowPrivacy(v => !v)}
            className="mt-3 w-full flex items-center justify-between gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-700/30 rounded-lg px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-green-600" /> ما البيانات التي تُرسَل؟
            </span>
            <ChevronDown size={14} className={`transition-transform ${showPrivacy ? 'rotate-180' : ''}`} />
          </button>

          {showPrivacy && privacy && (
            <div className="mt-2 space-y-3 text-xs">
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3">
                <div className="font-semibold text-green-800 dark:text-green-300 mb-1.5">يُرسَل فقط:</div>
                <ul className="space-y-1 text-green-700 dark:text-green-300">
                  {asRows<any>(privacy.sends).map((s: any) => <li key={s.key}>• {s.label}</li>)}
                </ul>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                <div className="font-semibold text-red-800 dark:text-red-300 mb-1.5">لا يُرسَل إطلاقاً:</div>
                <ul className="space-y-1 text-red-700 dark:text-red-300">
                  {asRows<string>(privacy.neverSends).map((s: string) => <li key={s}>• {s}</li>)}
                </ul>
              </div>
              <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                الغرض: التحقق من الاشتراك وإرسال إشعارات الدعم فقط. بياناتك المحاسبية تبقى
                على جهازك ولا تغادره. يمكن إيقاف هذا الاتصال من الإعدادات دون أن يتأثر عمل البرنامج.
              </p>
            </div>
          )}
        </Card>
      )}

      <div className="text-center text-xs text-slate-500 dark:text-slate-400">
        <p>{info.app_name}{info.company_name ? ` — ${info.company_name}` : ''}</p>
        <p className="mt-1">{info.about_footer || `تطوير: ${info.dev_name}`}</p>
      </div>
    </div>
  );
}

function Card({ title, icon, children }: { title?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
      {title && (
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}

const TONES: Record<string, string> = {
  blue: 'bg-blue-100 dark:bg-blue-900/30',
  green: 'bg-green-100 dark:bg-green-900/30',
  emerald: 'bg-emerald-100 dark:bg-emerald-900/30',
  sky: 'bg-sky-100 dark:bg-sky-900/30',
  purple: 'bg-purple-100 dark:bg-purple-900/30',
  indigo: 'bg-indigo-100 dark:bg-indigo-900/30',
  rose: 'bg-rose-100 dark:bg-rose-900/30',
  amber: 'bg-amber-100 dark:bg-amber-900/30',
};

function Row({ icon, tone, label, value, href }: {
  icon: React.ReactNode; tone: string; label: string; value: string; href?: string;
}) {
  const body = (
    <div className="flex items-center gap-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${TONES[tone] || TONES.blue}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
        <div className="text-sm font-medium text-slate-800 dark:text-white break-all">{value}</div>
      </div>
    </div>
  );
  return href
    ? <a href={href} target="_blank" rel="noreferrer" className="block hover:opacity-80 transition-opacity">{body}</a>
    : body;
}
