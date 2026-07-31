import { useState, useEffect } from 'react';
import { Save, AlertTriangle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useToastStore } from '../../components/ui/Toast';

export function GeneralSettings() {
  const { showToast } = useToastStore();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Two-step reset: the password is proven first, and only then is a
  // confirmation code sent to the shop's Telegram. Splitting it this way means
  // nobody can spam the owner's phone with reset prompts without already
  // knowing a valid password.
  const [resetStep, setResetStep] = useState<1 | 2>(1);
  const [resetCode, setResetCode] = useState('');
  const [resetTgReady, setResetTgReady] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await window.api.invoke('settings:getAll');
      setSettings(result);
      setLoading(false);
    })();
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.api.invoke('settings:setMany', settings);
      showToast('success', 'تم حفظ الإعدادات بنجاح');
    } catch {
      showToast('error', 'فشل حفظ الإعدادات');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-slate-500 dark:text-slate-400">جاري التحميل...</div>;

  return (
    <div className="max-w-2xl space-y-6">
      {/* Company Info */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">بيانات المحل</h2>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="اسم المحل / الشركة"
            value={settings.company_name || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('company_name', e.target.value)}
          />
          <Input
            label="اسم المالك"
            value={settings.owner_name || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('owner_name', e.target.value)}
          />
          <Input
            label="رقم الهاتف"
            value={settings.phone || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('phone', e.target.value)}
          />
          <Input
            label="البريد الإلكتروني"
            value={settings.email || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('email', e.target.value)}
          />
          <Input
            label="العنوان"
            value={settings.address || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('address', e.target.value)}
            className="col-span-2"
          />
          <Input
            label="السجل التجاري"
            value={settings.tax_number || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('tax_number', e.target.value)}
          />
        </div>
      </div>

      {/* Bank Info */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">البيانات البنكية</h2>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="اسم البنك"
            value={settings.bank_name || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('bank_name', e.target.value)}
          />
          <Input
            label="رقم الحساب البنكي"
            value={settings.bank_account || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('bank_account', e.target.value)}
          />
        </div>
      </div>

      {/* Tax Settings */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">إعدادات الضريبة</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">العملة</label>
            <select
              value={settings.currency || 'ج.م'}
              onChange={(e) => handleChange('currency', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm"
            >
              <option value="ج.م">جنيه مصري (ج.م)</option>
              <option value="ر.س">ريال سعودي (ر.س)</option>
              <option value="د.إ">درهم إماراتي (د.إ)</option>
              <option value="د.ك">دينار كويتي (د.ك)</option>
              <option value="ر.ق">ريال قطري (ر.ق)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">تفعيل الضريبة</label>
            <select
              value={settings.vat_enabled || '0'}
              onChange={(e) => handleChange('vat_enabled', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white text-sm"
            >
              <option value="0">غير مفعّل</option>
              <option value="1">مفعّل</option>
            </select>
          </div>
          {settings.vat_enabled === '1' && (
            <Input
              label="نسبة الضريبة (%)"
              type="number"
              value={settings.vat_rate || '14'}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('vat_rate', e.target.value)}
            />
          )}
        </div>
      </div>

      {/* Customer Color Thresholds */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">حدود ألوان العملاء</h2>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="حد اللون الأصفر (تحذير)"
            type="number"
            value={settings.customer_warn_threshold || '1000'}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('customer_warn_threshold', e.target.value)}
            hint="المبلغ الذي يبدأ من عنده تحول لون العميل للأصفر"
          />
          <Input
            label="حد اللون البرتقالي (خطر)"
            type="number"
            value={settings.customer_danger_threshold || '5000'}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('customer_danger_threshold', e.target.value)}
            hint="المبلغ الذي يبدأ من عنده تحول لون العميل للبرتقالي"
          />
        </div>
      </div>

      {/* Negative Balance Settings */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">الرصيد السالب</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={settings.allow_negative_stock === '1'} onChange={(e) => handleChange('allow_negative_stock', e.target.checked ? '1' : '0')} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">السماح برصيد مخزون سالب (بيع بدون رصيد)</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={settings.allow_negative_customer === '1'} onChange={(e) => handleChange('allow_negative_customer', e.target.checked ? '1' : '0')} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">السماح برصيد عميل سالب (دائن للعميل)</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={settings.allow_negative_cash === '1'} onChange={(e) => handleChange('allow_negative_cash', e.target.checked ? '1' : '0')} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">السماح برصيد خزنة/بنك سالب</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={settings.allow_negative_supplier === '1'} onChange={(e) => handleChange('allow_negative_supplier', e.target.checked ? '1' : '0')} className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500" />
            <span className="text-sm text-slate-700 dark:text-slate-200">السماح برصيد مورد سالب (مدين للمحل)</span>
          </label>
        </div>
        <div className="mt-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 text-xs text-orange-700 dark:text-orange-300">
          ⚠️ عند إيقاف الرصيد السالب، يجب أن تكون كل الأرصدة صفر أو موجبة قبل الإيقاف. سيتم منع العمليات التي تسبب رصيداً سالباً.
        </div>
      </div>

      <div className="flex justify-between items-center">
        <Button variant="outline" className="!border-red-300 !text-red-600 hover:!bg-red-50 dark:!border-red-800 dark:hover:!bg-red-900/20" onClick={async () => {
          setResetStep(1); setResetPassword(''); setResetCode('');
          // Tell the owner up front if no bot is configured, rather than
          // letting them type a password only to be refused afterwards.
          const avail = await window.api.invoke('settings:resetIsAvailable');
          setResetTgReady(Boolean(avail?.available));
          setShowResetConfirm(true);
        }} icon={<AlertTriangle size={16} />}>
          تصفير قاعدة البيانات
        </Button>
        <Button onClick={handleSave} loading={saving} icon={<Save size={16} />}>
          حفظ الإعدادات
        </Button>
      </div>

      {/* Reset Database Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl border border-red-200 dark:border-red-800">
            <div className="text-center mb-4">
              <AlertTriangle size={48} className="mx-auto text-red-500 mb-2" />
              <h3 className="text-xl font-bold text-red-600 dark:text-red-400">تصفير قاعدة البيانات</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">
                سيتم حذف <strong>جميع</strong> البيانات بالكامل:
                العملاء، الموردين، المخازن، الأصناف، الفواتير، التذاكر، المرتبات، العقود، الأرصدة...
              </p>
              <p className="text-sm text-red-600 dark:text-red-400 font-bold mt-1">
                لا يمكن التراجع عن هذه العملية!
              </p>
            </div>
            <div className="space-y-3">
              {!resetTgReady && (
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-2.5 text-xs text-amber-700 dark:text-amber-300">
                  ⚠️ لا يمكن التصفير قبل ضبط بوت تليجرام الخاص بالمحل.
                  <div className="mt-1">اضبطه من: الإعدادات ← النسخ الاحتياطي.</div>
                </div>
              )}

              <div className="bg-slate-100 dark:bg-slate-700/40 rounded-lg p-2.5 text-xs text-slate-600 dark:text-slate-300">
                🛡 قبل الحذف يأخذ البرنامج <span className="font-bold">نسخة احتياطية</span> تلقائياً
                ويتحقق من صلاحيتها، ويصلك <span className="font-bold">إشعار على تليجرام</span> بعد التنفيذ.
              </div>

              {resetStep === 1 ? (
                <>
                  <Input
                    label="أدخل كلمة المرور الخاصة بك"
                    type="password"
                    value={resetPassword}
                    onChange={(e: any) => setResetPassword(e.target.value)}
                    placeholder="كلمة المرور"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      className="flex-1"
                      loading={resetting}
                      disabled={!resetPassword.trim()}
                      onClick={async () => {
                        setResetting(true);
                        try {
                          const userId = localStorage.getItem('userId');
                          const result = await window.api.invoke('settings:resetRequestCode', {
                            userId: parseInt(userId || '0'), password: resetPassword,
                          });
                          if (result?.success) {
                            showToast('success', result.message);
                            setResetStep(2);
                          } else {
                            showToast('error', result?.message || 'تعذّر إرسال الرمز');
                          }
                        } catch {
                          showToast('error', 'تعذّر إرسال رمز التحقق');
                        } finally {
                          setResetting(false);
                        }
                      }}
                    >
                      إرسال رمز التأكيد
                    </Button>
                    <Button variant="secondary" onClick={() => {
                      setShowResetConfirm(false); setResetPassword(''); setResetCode(''); setResetStep(1);
                    }}>
                      إلغاء
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2.5 text-xs text-blue-700 dark:text-blue-300">
                    تم إرسال رمز من ٦ أرقام إلى بوت تليجرام الخاص بالمحل. أدخله للتأكيد النهائي.
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                      رمز التحقق
                    </label>
                    <input
                      type="text" inputMode="numeric" maxLength={6} dir="ltr"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-center text-lg tracking-[0.4em]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      className="flex-1"
                      loading={resetting}
                      disabled={resetCode.length !== 6}
                      onClick={async () => {
                        setResetting(true);
                        try {
                          const userId = localStorage.getItem('userId');
                          const result = await window.api.invoke('settings:resetDatabase', {
                            userId: parseInt(userId || '0'), password: resetPassword, code: resetCode,
                          });
                          if (result?.success) {
                            showToast('success', result.message);
                            setShowResetConfirm(false);
                            setResetPassword(''); setResetCode(''); setResetStep(1);
                          } else {
                            showToast('error', result?.message || 'تعذّر التصفير');
                          }
                        } catch {
                          showToast('error', 'فشل تصفير قاعدة البيانات');
                        } finally {
                          setResetting(false);
                        }
                      }}
                    >
                      تأكيد التصفير نهائياً
                    </Button>
                    <Button variant="secondary" onClick={() => {
                      setShowResetConfirm(false); setResetPassword(''); setResetCode(''); setResetStep(1);
                    }}>
                      إلغاء
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
