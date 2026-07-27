import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, User, Phone, Mail, MapPin, Save, ArrowRight, Shield, Store } from 'lucide-react';
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
  });

  const [customer, setCustomer] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
  });

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
    if (step === 1 && !company.companyName) {
      showToast('error', 'يرجى إدخال اسم المحل/الشركة');
      return;
    }
    if (step === 2) {
      if (!admin.username || !admin.password) {
        showToast('error', 'يرجى إدخال اسم المستخدم وكلمة المرور');
        return;
      }
      if (admin.password.length < 4) {
        showToast('error', 'كلمة المرور يجب أن تكون 4 أحرف على الأقل');
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
        customer,
        admin,
      });
      if (result.success) {
        showToast('success', 'تم إعداد النظام بنجاح');
        navigate('/login');
      } else {
        showToast('error', result.message || 'فشل الإعداد');
      }
    } catch {
      showToast('error', 'حدث خطأ أثناء الإعداد');
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
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <Building2 size={20} /> بيانات الشركة
              </h3>
               <Input label="اسم المحل / الشركة" value={company.companyName} onChange={(e) => setCompany({...company, companyName: e.target.value})} required />
               <Input label="اسم صاحب المحل" value={company.ownerName} onChange={(e) => setCompany({...company, ownerName: e.target.value})} />
               <div className="grid grid-cols-2 gap-3">
                 <Input label="الهاتف" value={company.phone} onChange={(e) => setCompany({...company, phone: e.target.value})} />
                 <Input label="البريد الإلكتروني" type="email" value={company.email} onChange={(e) => setCompany({...company, email: e.target.value})} />
               </div>
               <Input label="العنوان" value={company.address} onChange={(e) => setCompany({...company, address: e.target.value})} />
               <Input label="الرقم الضريبي" value={company.taxNumber} onChange={(e) => setCompany({...company, taxNumber: e.target.value})} />

               <div className="border-t border-slate-200 dark:border-slate-700 my-4" />
               <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400">بيانات العميل الأول (اختياري)</h3>
               <Input label="اسم العميل" value={customer.name} onChange={(e) => setCustomer({...customer, name: e.target.value})} />
               <div className="grid grid-cols-2 gap-3">
                 <Input label="هاتف العميل" value={customer.phone} onChange={(e) => setCustomer({...customer, phone: e.target.value})} />
                 <Input label="بريد العميل" type="email" value={customer.email} onChange={(e) => setCustomer({...customer, email: e.target.value})} />
               </div>
               <Input label="عنوان العميل" value={customer.address} onChange={(e) => setCustomer({...customer, address: e.target.value})} />
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
                 {customer.name && <div className="flex justify-between"><span className="text-slate-500">العميل الأول</span><span className="font-medium">{customer.name}</span></div>}
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
