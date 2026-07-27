import { useState, useEffect } from 'react';
import { Key, Cpu, Calendar, CheckCircle, XCircle, Phone, Mail, Copy, AlertTriangle, Shield } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

export function LicenseActivationPage() {
  const [licenseStatus, setLicenseStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    checkLicense();
  }, []);

  const checkLicense = async () => {
    const status = await window.api.invoke('license:status');
    setLicenseStatus(status);
    setLoading(false);
  };

  const handleActivate = async () => {
    if (!code) return;
    setActivating(true);
    const result = await window.api.invoke('license:activate', { code });
    if (result.success) {
      await checkLicense();
    } else {
      alert(result.message);
    }
    setActivating(false);
  };

  const copyDeviceId = () => {
    if (licenseStatus?.deviceId) {
      navigator.clipboard.writeText(licenseStatus.deviceId);
      alert('تم نسخ معرّف الجهاز');
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900"><div className="text-slate-500 dark:text-slate-400">جاري التحقق من الترخيص...</div></div>;
  }

  // If active or trial, don't render (handled by parent — app runs)
  if (licenseStatus?.status === 'active' || licenseStatus?.status === 'trial') {
    return null;
  }

  const devPhone = '01207770329';
  const devEmail = 'conta.shepo@gmail.com';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-slate-800 dark:bg-slate-900 rounded-2xl mb-3">
            <Shield size={28} className="text-slate-300" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">تفعيل البرنامج</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">أدخل كود التفعيل لاستخدام البرنامج</p>
        </div>

        {/* Status */}
        {licenseStatus?.status === 'error' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 flex items-center gap-2">
            <XCircle size={18} className="text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-300">{licenseStatus.message || 'خطأ في التحقق من الترخيص'}</span>
          </div>
        )}
        {licenseStatus?.status === 'trial_expired' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-300">انتهت الفترة التجريبية - يرجى تفعيل البرنامج</span>
          </div>
        )}
        {licenseStatus?.status === 'expired' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-300">انتهت صلاحية الترخيص</span>
          </div>
        )}
        {licenseStatus?.status === 'inactive' && (
          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-4 flex items-center gap-2">
            <AlertTriangle size={18} className="text-orange-500" />
            <span className="text-sm text-orange-700 dark:text-orange-300">البرنامج غير مفعّل</span>
          </div>
        )}
        {licenseStatus?.status === 'tampered' && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 flex items-center gap-2">
            <XCircle size={18} className="text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-300">{licenseStatus.message}</span>
          </div>
        )}

        {/* Device ID */}
        <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1">
                <Cpu size={12} /> معرّف الجهاز
              </div>
              <div className="text-xs font-mono text-slate-700 dark:text-slate-200 break-all">{licenseStatus?.deviceId}</div>
            </div>
            <button onClick={copyDeviceId} className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-primary-600">
              <Copy size={14} />
            </button>
          </div>
        </div>

        {/* Activation form */}
        <div className="space-y-3">
          <Input label="كود التفعيل" value={code} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono" />
          <Button onClick={handleActivate} loading={activating} className="w-full" icon={<Key size={16} />}>تفعيل</Button>
        </div>

        {/* Contact developer */}
        <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400 text-center mb-3">للحصول على كود التفعيل، تواصل مع المطور:</p>
          <div className="flex justify-center gap-3">
            <a href={`https://wa.me/2${devPhone}`} target="_blank" className="flex items-center gap-1 px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-xs hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors">
              <Phone size={14} /> واتساب
            </a>
            <a href={`https://t.me/+2${devPhone}`} target="_blank" className="flex items-center gap-1 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors">
              <Phone size={14} /> تليجرام
            </a>
            <a href={`mailto:${devEmail}`} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 text-xs hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors">
              <Mail size={14} /> إيميل
            </a>
          </div>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 text-center mt-3">هاتف: {devPhone} | {devEmail}</p>
        </div>
      </div>
    </div>
  );
}
