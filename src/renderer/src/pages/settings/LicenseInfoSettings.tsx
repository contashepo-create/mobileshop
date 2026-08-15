import { useState, useEffect } from 'react';
import { Shield, Cpu, Calendar, CheckCircle, AlertTriangle, Copy, Phone, Mail, Key, Clock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useToastStore } from '../../components/ui/Toast';

export function LicenseInfoSettings() {
  const { showToast } = useToastStore();
  const [license, setLicense] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activateCode, setActivateCode] = useState('');
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    fetchLicense();
  }, []);

  const fetchLicense = async () => {
    const status = await window.api.invoke('license:status');
    setLicense(status);
    setLoading(false);
  };

  const handleActivate = async () => {
    if (!activateCode.trim()) { showToast('error', 'أدخل كود التفعيل'); return; }
    setActivating(true);
    const result = await window.api.invoke('license:activate', { code: activateCode.trim() });
    if (result.success) {
      showToast('success', result.message);
      setActivateCode('');
      await fetchLicense();
    } else {
      showToast('error', result.message);
    }
    setActivating(false);
  };

  const devPhone = '01207770329';
  const devEmail = 'conta.shepo@gmail.com';

  if (loading) return <div className="text-slate-500 dark:text-slate-400 text-center py-8">جاري التحميل...</div>;
  if (!license) return <div className="text-slate-500 dark:text-slate-400 text-center py-8">تعذر قراءة حالة الترخيص</div>;

  const isActive = license.status === 'active';
  const isTrial = license.status === 'trial';
  const isExpired = license.status === 'expired' || license.status === 'trial_expired';
  const isInactive = license.status === 'inactive' || license.status === 'error' || license.status === 'tampered';

  const copyDeviceId = () => {
    navigator.clipboard.writeText(license.deviceId || '');
    showToast('success', 'تم نسخ معرّف الجهاز');
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Shield size={24} className="text-primary-600" />
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الترخيص والاشتراك</h1>
      </div>

      {/* Status banner */}
      <div className={`rounded-xl p-5 border-2 ${isActive || isTrial ? 'border-green-300 bg-green-50 dark:bg-green-900/20' : isExpired ? 'border-red-300 bg-red-50 dark:bg-red-900/20' : 'border-orange-300 bg-orange-50 dark:bg-orange-900/20'}`}>
        <div className="flex items-center gap-3 mb-3">
          {isActive || isTrial ? <CheckCircle size={28} className="text-green-500" /> : <AlertTriangle size={28} className={isExpired ? 'text-red-500' : 'text-orange-500'} />}
          <div>
            <div className="font-bold text-lg text-slate-800 dark:text-white">{license.message}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">الحالة: {isActive ? 'مفعّل' : isTrial ? 'فترة تجريبية' : isExpired ? 'منتهي' : 'غير مفعّل'}</div>
          </div>
        </div>

        {/* License details */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          {/* Device ID */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3 col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1">
                <Cpu size={12} /> معرّف الجهاز (كود العميل)
              </div>
              <button onClick={copyDeviceId} className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-primary-600" title="نسخ">
                <Copy size={12} />
              </button>
            </div>
            <div className="text-xs font-mono text-slate-700 dark:text-slate-200 break-all">{license.deviceId}</div>
          </div>

          {/* Subscription type */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">نوع الاشتراك</div>
            <div className="text-sm font-bold text-slate-800 dark:text-white">
              {license.type === 'full' ? 'كامل (غير محدود)' : license.type === 'trial' ? 'تجريبي' : '—'}
            </div>
          </div>

          {/* Activation code */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
            <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1">
              <Key size={12} /> كود التفعيل
            </div>
            <div className="text-sm font-mono text-slate-700 dark:text-slate-200">{license.code || '—'}</div>
          </div>

          {/* Start date */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
            <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1">
              <Calendar size={12} /> تاريخ التفعيل
            </div>
            <div className="text-sm text-slate-700 dark:text-slate-200">{license.startDate?.split('T')[0] || '—'}</div>
          </div>

          {/* Remaining days */}
          <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
            <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1">
              <Clock size={12} /> الأيام المتبقية
            </div>
            <div className={`text-lg font-bold ${isActive || isTrial ? 'text-green-600' : 'text-red-600'}`}>
              {license.remainingDays !== undefined ? license.remainingDays : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Activate / Renew license */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">تفعيل / تجديد الاشتراك</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">أدخل كود التفعيل الذي حصلت عليه من المطور لتفعيل أو تجديد اشتراكك</p>
        <div className="flex gap-2">
          <Input value={activateCode} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setActivateCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono flex-1" />
          <Button onClick={handleActivate} loading={activating} icon={<Key size={16} />}>تفعيل</Button>
        </div>
      </div>

      {/* Contact developer */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">التواصل مع المطور</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">للتجديد أو الدعم الفني أو الحصول على كود تفعيل جديد:</p>
        <div className="flex gap-2 flex-wrap">
          <a href={`https://wa.me/2${devPhone}`} target="_blank" className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-sm hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors" rel="noreferrer">
            <Phone size={16} /> واتساب
          </a>
          <a href={`https://t.me/+2${devPhone}`} target="_blank" className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-sm hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors" rel="noreferrer">
            <Phone size={16} /> تليجرام
          </a>
          <a href={`mailto:${devEmail}`} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 text-sm hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors">
            <Mail size={16} /> بريد إلكتروني
          </a>
        </div>
        <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 text-center">
          <p>المطور: محاسب / محمد عبدة</p>
          <p className="mt-1">هاتف: {devPhone} | {devEmail}</p>
        </div>
      </div>
    </div>
  );
}
