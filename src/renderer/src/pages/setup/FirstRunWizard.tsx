import { useState } from 'react';
import { validateRegistration, EGYPT_GOVERNORATES } from '../../../../shared/registration';
import { useNavigate } from 'react-router-dom';
import { Building2, User, Phone, Mail, MapPin, Save, ArrowRight, Shield, Store, DatabaseBackup, Upload } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { useToastStore } from '../../components/ui/Toast';

export function FirstRunWizard() {
  const { showToast } = useToastStore();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  const [company, setCompany] = useState({
    companyName: '',
    ownerName: '',
    phone: '',
    email: '',
    address: '',
    taxNumber: '',
    governorate: '',
    city: '',
    birthDate: '',
  });
  // Per-field messages from the shared validator, so the owner sees every
  // problem at once instead of discovering them one submit at a time.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Phone confirmation via the shop's own Telegram bot. Optional: a shop with
  // no bot configured must still be able to finish setting up.
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);

  const [admin, setAdmin] = useState({
    username: 'admin',
    password: '',
    confirmPassword: '',
    employeeName: '',
    position: '',
    phone: '',
  });

  const steps = [
    { num: 1, label: 'بيانات الشركة', icon: Building2 },
    { num: 2, label: 'حساب المدير', icon: Shield },
    { num: 3, label: 'التأكيد', icon: Save },
  ];

  const handleNext = () => {
    if (step === 1) {
      // Same validator the main process runs, so the wizard can never let
      // through something the handler will reject.
      const problems = validateRegistration(company);
      if (problems.length > 0) {
        const map: Record<string, string> = {};
        for (const p of problems) map[p.field] = p.message;
        setFieldErrors(map);
        showToast('error', 'راجع الحقول المميّزة بالأحمر');
        return;
      }
      setFieldErrors({});
    }
    if (step === 2) {
      if (!admin.username || !admin.password) {
        showToast('error', 'يرجى إدخال اسم المستخدم وكلمة المرور');
        return;
      }
      if (admin.password.length < 6) {
        showToast('error', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل');
        return;
      }
      if (admin.password !== admin.confirmPassword) {
        showToast('error', 'كلمتا المرور غير متطابقتان');
        return;
      }
    }
    if (step < 3) setStep(s => s + 1);
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const result = await window.api.invoke('setup:initialize', {
        company,
        admin,
      });
      if (result?.success) {
        showToast('success', 'تم إعداد النظام بنجاح');
        // Reload the app so App.tsx re-checks setup:isComplete and routes
        // to login instead of staying on the wizard.
        setTimeout(() => window.location.reload(), 1000);
      } else {
        showToast('error', result?.message || 'فشل الإعداد');
      }
    } catch (err: any) {
      console.error('[Setup] Error:', err);
      showToast('error', 'حدث خطأ أثناء الإعداد: ' + (err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * The Windows-reinstall path: this machine was installed fresh, but the shop
   * already exists on an older copy of the database the owner kept. Adopt it
   * directly instead of typing everything in again — all customers, invoices
   * and balances come back whole.
   */
  const handleImportDatabase = async () => {
    setLoading(true);
    try {
      const result = await window.api.invoke('setup:importDatabase');
      if (result?.success) {
        showToast('success', result.message || 'تم الاستيراد');
        setTimeout(() => window.location.reload(), 1000);
      } else {
        showToast('error', result?.message || 'تعذّر الاستيراد');
      }
    } catch (err: any) {
      console.error('[Setup] Import error:', err);
      showToast('error', 'حدث خطأ أثناء الاستيراد: ' + (err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-600 to-slate-800 p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-white rounded-2xl mb-4 shadow-lg">
            <Store size={36} className="text-primary-600" />
          </div>
          <h1 className="text-2xl font-bold text-white">إعداد النظام</h1>
          <p className="text-sm text-primary-100 mt-2">مرحباً بك — سنحتاج بعض المعلومات للبدء</p>
        </div>

        {/* Steps */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {steps.map((s) => (
            <div key={s.num} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                step >= s.num ? 'bg-white text-primary-600' : 'bg-primary-800 text-primary-300'
              }`}>
                {s.num}
              </div>
              <span className={`text-xs ${step >= s.num ? 'text-white' : 'text-primary-300'}`}>{s.label}</span>
              {s.num < 3 && <div className={`w-8 h-0.5 ${step > s.num ? 'bg-white' : 'bg-primary-700'}`} />}
            </div>
          ))}
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-6 border border-slate-200 dark:border-slate-700">
          {/* Windows-reinstall import: offer it before the company form, on
              every step, so the owner can adopt an old database at any moment
              of the wizard instead of re-entering everything by hand. The card
              is visually prominent (gradient + strong border) so an owner who
              reinstalled Windows or bought a new machine sees it immediately. */}
          <div className="mb-5 rounded-xl overflow-hidden border-2 border-primary-500 dark:border-primary-600 shadow-lg shadow-primary-500/20">
            <div className="flex items-center gap-3 bg-gradient-to-l from-primary-600 to-primary-500 px-4 py-3">
              <div className="p-2 rounded-lg bg-white/20">
                <DatabaseBackup size={20} className="text-white" />
              </div>
              <div className="flex-1 text-white">
                <h4 className="text-sm font-bold">غيّرت ويندوز أو اشتريت جهازاً جديداً؟ لا تفقد بياناتك</h4>
                <p className="text-[11px] text-primary-100 mt-0.5">
                  استبدل هذا الإعداد النظيف بقاعدتك القديمة — عملاؤك وفواتيرك وأرصدتك ستعود كما كانت،
                  بلا إعادة كتابة أي شيء.
                </p>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 flex items-center justify-between gap-3 p-3">
              <p className="text-[11px] text-slate-500 dark:text-slate-400 flex-1">
                اختر ملف <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">mobile_shop.db</code> —
                يُفحص ويُرحَّب به بأمان تام.
              </p>
              <button type="button" disabled={loading}
                onClick={handleImportDatabase}
                className="shrink-0 text-xs font-bold text-white bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600 disabled:opacity-50 px-4 py-2 rounded-lg flex items-center gap-1.5 shadow-sm">
                <Upload size={14} /> استيراد قاعدة البيانات
              </button>
            </div>
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <Building2 size={20} /> بيانات الشركة
              </h3>
               <Input label="اسم المحل / الشركة" value={company.companyName} onChange={(e) => setCompany({...company, companyName: e.target.value})} required />
               {fieldErrors.companyName && <p className="text-[11px] text-red-600 -mt-2">{fieldErrors.companyName}</p>}
               <Input label="اسم صاحب المحل" value={company.ownerName} onChange={(e) => setCompany({...company, ownerName: e.target.value})} />
               {fieldErrors.ownerName && <p className="text-[11px] text-red-600 -mt-2">{fieldErrors.ownerName}</p>}
               <div className="grid grid-cols-2 gap-3">
                 <div>
                   <Input label="الهاتف" value={company.phone}
                     onChange={(e) => { setCompany({...company, phone: e.target.value}); setPhoneVerified(false); }} />
                   {fieldErrors.phone && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.phone}</p>}
                   {phoneVerified ? (
                     <p className="text-[11px] text-green-600 mt-1">✅ تم تأكيد الرقم عبر تليجرام</p>
                   ) : (
                     <button type="button" disabled={phoneBusy || !company.phone}
                       onClick={async () => {
                         setPhoneBusy(true);
                         showToast('info', 'افتح تليجرام واضغط زر «مشاركة رقمي»');
                         const r = await window.api.invoke('phone:verify', { phone: company.phone });
                         setPhoneBusy(false);
                         if (r?.success) { setPhoneVerified(true); showToast('success', r.message); }
                         else showToast('error', r?.message || 'تعذّر التأكيد');
                       }}
                       className="text-[11px] text-primary-600 hover:underline mt-1 disabled:opacity-50">
                       {phoneBusy ? 'في انتظار الضغط على الزر في تليجرام...' : '📱 تأكيد الرقم عبر تليجرام (اختياري)'}
                     </button>
                   )}
                 </div>
                 <div><Input label="البريد الإلكتروني" type="email" value={company.email} onChange={(e) => setCompany({...company, email: e.target.value})} />
                 {fieldErrors.email && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.email}</p>}</div>
               </div>
               <div className="grid grid-cols-2 gap-3">
                 <div>
                   <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">المحافظة</label>
                   <select value={company.governorate}
                     onChange={(e) => setCompany({...company, governorate: e.target.value})}
                     className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm">
                     <option value="">اختر المحافظة</option>
                     {EGYPT_GOVERNORATES.map(g => <option key={g} value={g}>{g}</option>)}
                   </select>
                   {fieldErrors.governorate && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.governorate}</p>}
                 </div>
                 <div>
                   <Input label="المدينة" value={company.city} onChange={(e) => setCompany({...company, city: e.target.value})} />
                   {fieldErrors.city && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.city}</p>}
                 </div>
               </div>
               <Input label="العنوان" value={company.address} onChange={(e) => setCompany({...company, address: e.target.value})} />
               {fieldErrors.address && <p className="text-[11px] text-red-600 -mt-2">{fieldErrors.address}</p>}
               <div>
                 <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">تاريخ ميلاد صاحب المحل</label>
                 <input type="date" value={company.birthDate} dir="ltr"
                   onChange={(e) => setCompany({...company, birthDate: e.target.value})}
                   className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
                 {fieldErrors.birthDate && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.birthDate}</p>}
               </div>
               <Input label="الرقم الضريبي" value={company.taxNumber} onChange={(e) => setCompany({...company, taxNumber: e.target.value})} />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <Shield size={20} /> حساب المدير
              </h3>
              <Input label="اسم المستخدم" value={admin.username} onChange={(e) => setAdmin({...admin, username: e.target.value})} />
              <Input label="كلمة المرور" type="password" value={admin.password} onChange={(e) => setAdmin({...admin, password: e.target.value})} />
              <Input label="تأكيد كلمة المرور" type="password" value={admin.confirmPassword} onChange={(e) => setAdmin({...admin, confirmPassword: e.target.value})} />
              <Input label="اسم المدير الكامل" value={admin.employeeName} onChange={(e) => setAdmin({...admin, employeeName: e.target.value})} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="المنصب" value={admin.position} onChange={(e) => setAdmin({...admin, position: e.target.value})} />
                <Input label="الهاتف" value={admin.phone} onChange={(e) => setAdmin({...admin, phone: e.target.value})} />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">مراجعة البيانات</h3>
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-4 space-y-3 text-sm">
               <div className="flex justify-between"><span className="text-slate-500">اسم المحل</span><span className="font-medium">{company.companyName}</span></div>
                 <div className="flex justify-between"><span className="text-slate-500">المالك</span><span className="font-medium">{company.ownerName}</span></div>
                 <div className="flex justify-between"><span className="text-slate-500">هاتف المحل</span><span className="font-medium">{company.phone}</span></div>
                 <div className="flex justify-between"><span className="text-slate-500">حساب المدير</span><span className="font-medium text-primary-600">{admin.username}</span></div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">هل أنت متأكد من أن هذه البيانات صحيحة؟ يمكن تعديلها لاحقاً من الإعدادات.</p>
            </div>
          )}

          <div className="flex justify-between mt-6">
            {step > 1 ? (
              <Button variant="secondary" onClick={() => setStep(s => s - 1)}>السابق</Button>
            ) : <div />}
            {step < 3 ? (
              <Button onClick={handleNext}>التالي <ArrowRight size={16} className="mr-1" /></Button>
            ) : (
              <Button onClick={handleSubmit} loading={loading} icon={<Save size={16} />}>
                إنهاء الإعداد
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
