import { useState, useEffect } from 'react';
import {
  Key, Cpu, CheckCircle, XCircle, Copy, AlertTriangle, Shield, Send, Check,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

/** Egyptian local number (01xxxxxxxxx) -> international digits (201xxxxxxxxx). */
function toInternational(local: string): string {
  const digits = (local || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20')) return digits;          // already international
  if (digits.startsWith('0')) return `20${digits.slice(1)}`;
  return `20${digits}`;
}

export function LicenseActivationPage() {
  const [licenseStatus, setLicenseStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);
  const [dev, setDev] = useState({ phone: '', telegram: '', name: '' });

  useEffect(() => {
    (async () => {
      const status = await window.api.invoke('license:status');
      setLicenseStatus(status);
      try {
        const s = await window.api.invoke('settings:getAll');
        setDev({
          phone: s?.dev_phone || '01207770329',
          telegram: s?.dev_telegram || '',
          name: s?.dev_name || 'الدعم الفني',
        });
      } catch {
        setDev({ phone: '01207770329', telegram: '', name: 'الدعم الفني' });
      }
      setLoading(false);
    })();
  }, []);

  const refresh = async () => {
    const status = await window.api.invoke('license:status');
    setLicenseStatus(status);
  };

  const handleActivate = async () => {
    if (!code.trim()) { setError('أدخل كود التفعيل'); return; }
    setActivating(true);
    setError('');
    setSuccess('');
    const result = await window.api.invoke('license:activate', { code: code.trim() });
    setActivating(false);
    if (result.success) {
      setSuccess(result.message);
      // Give the user a moment to read the confirmation, then re-enter the app.
      setTimeout(() => { void refresh(); }, 1200);
    } else {
      setError(result.message || 'فشل التفعيل');
    }
  };

  const deviceId: string = licenseStatus?.deviceId || '';

  const copyDeviceId = async () => {
    if (!deviceId) return;
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };

  /**
   * Pre-written request the customer sends us. It already contains the device
   * id, so there is nothing for them to copy by hand and nothing for us to ask
   * for — the most common source of back-and-forth in activation support.
   */
  const requestMessage =
    `السلام عليكم 👋\n` +
    `أرغب في تفعيل برنامج إدارة محلات الموبايلات.\n\n` +
    `🔑 معرّف الجهاز:\n${deviceId}\n\n` +
    `📌 الحالة الحالية: ${statusLabel(licenseStatus?.status)}\n\n` +
    `برجاء إرسال كود التفعيل. شكراً لحضرتك.`;

  const encoded = encodeURIComponent(requestMessage);
  const intlPhone = toInternational(dev.phone);
  const waLink = `https://wa.me/${intlPhone}?text=${encoded}`;
  // A @username supports a prefilled message; a bare phone link can only open
  // the chat, so we copy the text to the clipboard in that case.
  const tgUser = (dev.telegram || '').replace(/^@/, '').trim();
  const tgLink = tgUser
    ? `https://t.me/${tgUser}?text=${encoded}`
    : `https://t.me/+${intlPhone}`;

  const openTelegram = async () => {
    if (!tgUser) {
      try { await navigator.clipboard.writeText(requestMessage); } catch { /* ignore */ }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900">
        <div className="text-slate-500 dark:text-slate-400">جاري التحقق من الترخيص...</div>
      </div>
    );
  }

  if (licenseStatus?.status === 'active' || licenseStatus?.status === 'trial') return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-7">

        <div className="text-center mb-5">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-slate-800 dark:bg-slate-900 rounded-2xl mb-3">
            <Shield size={28} className="text-slate-300" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">تفعيل البرنامج</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            أرسل معرّف الجهاز واستلم كود التفعيل
          </p>
        </div>

        <StatusBanner status={licenseStatus?.status} message={licenseStatus?.message} />

        {/* Step 1 — device id */}
        <Step number={1} title="معرّف الجهاز الخاص بك" />
        <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 mb-3 border border-slate-200 dark:border-slate-600">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-slate-400 shrink-0" />
            <code className="text-[11px] font-mono text-slate-700 dark:text-slate-200 break-all flex-1 leading-relaxed">
              {deviceId || '—'}
            </code>
            <button
              onClick={copyDeviceId}
              title="نسخ"
              className="p-1.5 rounded shrink-0 text-slate-500 hover:text-primary-600 hover:bg-white dark:hover:bg-slate-600 transition-colors"
            >
              {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            </button>
          </div>
        </div>

        {/* Step 2 — one-tap request */}
        <Step number={2} title="أرسل طلب التفعيل" />
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">
          اضغط على أي زر — ستفتح المحادثة برسالة جاهزة تحتوي معرّف جهازك تلقائياً.
        </p>
        <div className="grid grid-cols-2 gap-2 mb-1">
          <a
            href={waLink}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[#25D366] hover:bg-[#1fa855] text-white text-sm font-medium transition-colors shadow-sm"
          >
            <WhatsAppIcon /> واتساب
          </a>
          <a
            href={tgLink}
            target="_blank"
            rel="noreferrer"
            onClick={openTelegram}
            className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[#229ED9] hover:bg-[#1b8cc0] text-white text-sm font-medium transition-colors shadow-sm"
          >
            <Send size={15} /> تليجرام
          </a>
        </div>
        {!tgUser && (
          <p className="text-[10px] text-slate-400 dark:text-slate-500 text-center mb-3">
            تليجرام: سيتم نسخ الرسالة تلقائياً — الصقها في المحادثة
          </p>
        )}
        {tgUser && <div className="mb-3" />}

        {/* Step 3 — enter the code */}
        <Step number={3} title="أدخل كود التفعيل" />
        <div className="space-y-2">
          {/* A v2 (Ed25519) code is ~138 characters — an Ed25519 signature
              cannot be truncated the way the old HMAC tag was, so the code
              carries all 64 signature bytes. It is far too long to read out
              over the phone or to fit a centred single-line box, so it is a
              textarea with a paste button. Short legacy codes still fit. */}
          <textarea
            value={code}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              setCode(e.target.value.toUpperCase());
              setError('');
            }}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              // Enter submits; Shift+Enter is left alone so a pasted code that
              // arrived with line breaks can still be edited.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleActivate(); }
            }}
            rows={3}
            dir="ltr"
            placeholder="الصق كود التفعيل هنا"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white font-mono text-xs break-all resize-none"
          />
          <button
            type="button"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) { setCode(text.trim().toUpperCase()); setError(''); }
              } catch {
                setError('تعذّر القراءة من الحافظة - الصق الكود يدوياً');
              }
            }}
            className="w-full py-1.5 text-xs rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            📋 لصق الكود من الحافظة
          </button>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 flex items-start gap-2">
              <XCircle size={15} className="text-red-500 shrink-0 mt-0.5" />
              <span className="text-xs text-red-700 dark:text-red-300">{error}</span>
            </div>
          )}
          {success && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-2.5 flex items-start gap-2">
              <CheckCircle size={15} className="text-green-600 shrink-0 mt-0.5" />
              <span className="text-xs text-green-700 dark:text-green-300">{success}</span>
            </div>
          )}

          <Button
            onClick={handleActivate}
            loading={activating}
            disabled={!code.trim() || !!success}
            className="w-full"
            icon={<Key size={16} />}
          >
            تفعيل
          </Button>
        </div>

        <div className="mt-5 pt-3 border-t border-slate-200 dark:border-slate-700 text-center">
          <p className="text-[10px] text-slate-400 dark:text-slate-500">
            {dev.name} · {dev.phone}
          </p>
        </div>
      </div>
    </div>
  );
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'trial': return 'فترة تجريبية';
    case 'trial_expired': return 'انتهت الفترة التجريبية';
    case 'expired': return 'انتهى الاشتراك — طلب تجديد';
    case 'tampered': return 'مشكلة في التحقق';
    case 'error': return 'غير مفعّل';
    default: return 'غير مفعّل';
  }
}

function Step({ number, title }: { number: number; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-4 first:mt-0">
      <span className="w-5 h-5 rounded-full bg-primary-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
        {number}
      </span>
      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</span>
    </div>
  );
}

function StatusBanner({ status, message }: { status?: string; message?: string }) {
  if (!status || status === 'active' || status === 'trial') return null;

  const isExpiry = status === 'expired' || status === 'trial_expired';
  const tone = isExpiry
    ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300'
    : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300';

  const text = message || (status === 'trial_expired'
    ? 'انتهت الفترة التجريبية - يرجى تفعيل البرنامج'
    : status === 'expired' ? 'انتهت صلاحية الترخيص' : 'البرنامج غير مفعّل');

  return (
    <div className={`border rounded-lg p-3 mb-4 flex items-start gap-2 ${tone}`}>
      <AlertTriangle size={16} className="shrink-0 mt-0.5" />
      <div className="text-xs leading-relaxed">
        <div>{text}</div>
        {isExpiry && (
          <div className="mt-1 opacity-90">بياناتك محفوظة بالكامل — التفعيل يعيد فتح البرنامج فوراً.</div>
        )}
      </div>
    </div>
  );
}

/** Inline WhatsApp glyph (lucide has no brand icons). */
function WhatsAppIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.465 3.488" />
    </svg>
  );
}
