import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock, Save, Edit, Phone, Mail, User, FileText, Hash, Copyright, Key, Cpu, Calendar, CheckCircle, XCircle, Trash2, Plus, AlertTriangle, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Textarea, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';

const ENCRYPTED_DEV_USER = btoa('zerocold'.split('').reverse().join(''));
const ENCRYPTED_DEV_PASS = btoa('014253'.split('').reverse().join(''));

function decrypt(str: string): string {
  try { return atob(str).split('').reverse().join(''); } catch { return ''; }
}

type DevTab = 'about' | 'license' | 'codes';

export function DevConsolePage() {
  const { showToast } = useToastStore();
  const navigate = useNavigate();
  const [unlocked, setUnlocked] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState<DevTab>('about');
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  // About info
  const [devInfo, setDevInfo] = useState({ app_name: '', dev_name: '', dev_phone: '', dev_email: '', copyright: '', distribution_rights: '', custom_content: '', app_version: '' });

  // License
  const [licenseStatus, setLicenseStatus] = useState<any>(null);
  const [devPassword, setDevPassword] = useState('');
  const [generatedCodes, setGeneratedCodes] = useState<any[]>([]);
  const [genDays, setGenDays] = useState('30');
  const [genType, setGenType] = useState('trial');
  const [genDeviceId, setGenDeviceId] = useState('');
  const [showGenModal, setShowGenModal] = useState(false);

  useEffect(() => {
    const unlockedSession = sessionStorage.getItem('dev_unlocked');
    if (unlockedSession === 'true') {
      setUnlocked(true);
      fetchDevInfo();
      fetchLicenseStatus();
    }
  }, []);

  const fetchDevInfo = async () => {
    const settings = await window.api.invoke('settings:getAll');
    setDevInfo({
      app_name: settings.app_name || 'موبايل شوب سيستم',
      dev_name: settings.dev_name || 'محاسب / محمد عبدة',
      dev_phone: settings.dev_phone || '01207770329',
      dev_email: settings.dev_email || 'conta.shepo@gmail.com',
      copyright: settings.copyright || '© 2026 محاسب / محمد عبدة - جميع الحقوق محفوظة',
      distribution_rights: settings.distribution_rights || 'غير مسموح بتوزيع أو نسخ البرنامج بدون إذن المطور',
      custom_content: settings.custom_content || '',
      app_version: settings.app_version || '1.0.0',
    });
  };

  const fetchLicenseStatus = async () => {
    const status = await window.api.invoke('license:status');
    setLicenseStatus(status);
  };

  const fetchCodes = async () => {
    if (!devPassword) return;
    const result = await window.api.invoke('license:listCodes', { devPassword });
    if (result.success) setGeneratedCodes(result.codes);
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUser === decrypt(ENCRYPTED_DEV_USER) && loginPass === decrypt(ENCRYPTED_DEV_PASS)) {
      setUnlocked(true);
      sessionStorage.setItem('dev_unlocked', 'true');
      setLoginError('');
      fetchDevInfo();
      fetchLicenseStatus();
      showToast('success', 'مرحباً بالمطور');
    } else {
      setLoginError('بيانات الدخول غير صحيحة');
    }
  };

  const handleSave = async () => {
    await window.api.invoke('settings:setMany', devInfo);
    showToast('success', 'تم حفظ البيانات');
    setMode('view');
  };

  const handleGenerateCode = async () => {
    if (!devPassword) { showToast('error', 'أدخل الرقم السري للمطور'); return; }
    if (!genDeviceId.trim()) { showToast('error', 'أدخل معرّف جهاز العميل'); return; }
    const days = parseInt(genDays);
    const result = await window.api.invoke('license:generateCode', { days, type: genType, customerDeviceId: genDeviceId.trim(), devPassword });
    if (result.success) {
      showToast('success', `تم إنشاء كود: ${result.code} (${result.days === 0 ? 'غير محدود' : result.days + ' يوم'})`);
      setShowGenModal(false);
      setGenDeviceId('');
      fetchCodes();
    } else {
      showToast('error', result.message);
    }
  };

  const handleRevoke = async (code: string) => {
    if (!devPassword) return;
    const result = await window.api.invoke('license:revokeCode', { code, devPassword });
    if (result.success) {
      showToast('success', 'تم إلغاء الكود');
      fetchCodes();
    }
  };

  const handleDeactivate = async () => {
    if (!devPassword) { showToast('error', 'أدخل الرقم السري'); return; }
    if (!confirm('تحذير: سيتم إلغاء تفعيل الترخيص على هذا الجهاز. متابعة؟')) return;
    const result = await window.api.invoke('license:deactivate', { devPassword });
    if (result.success) {
      showToast('success', result.message);
      fetchLicenseStatus();
    }
  };

  // ===== LOGIN SCREEN =====
  if (!unlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900">
        <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-slate-800 dark:bg-slate-900 rounded-xl mb-3">
              <Shield size={28} className="text-slate-300" />
            </div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-white">وصول المطور</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">منطقة محظورة - للمطور فقط</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">اسم المستخدم</label>
              <input type="text" value={loginUser} onChange={(e) => setLoginUser(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-slate-500" autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">الرقم السري</label>
              <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-slate-500" />
            </div>
            {loginError && <div className="text-red-500 text-xs text-center bg-red-50 dark:bg-red-900/20 py-2 rounded-lg">{loginError}</div>}
            <button type="submit" className="w-full py-2.5 bg-slate-800 dark:bg-slate-900 hover:bg-slate-700 dark:hover:bg-slate-800 text-white font-medium rounded-lg transition-colors">دخول</button>
          </form>
          <button onClick={() => navigate('/')} className="w-full mt-3 flex items-center justify-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
            <ArrowRight size={14} /> رجوع
          </button>
        </div>
      </div>
    );
  }

  const tabBtnClass = (t: string) =>
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ' +
    (tab === t ? 'bg-slate-800 dark:bg-slate-900 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300');

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-900 p-6">
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-800 dark:bg-slate-900"><Shield size={20} className="text-slate-300" /></div>
          <div><h1 className="text-2xl font-bold text-slate-800 dark:text-white">لوحة المطور</h1><p className="text-xs text-slate-500 dark:text-slate-400">التحكم الكامل في التطبيق والتراخيص</p></div>
        </div>
        <Button variant="secondary" onClick={() => { sessionStorage.removeItem('dev_unlocked'); setUnlocked(false); setLoginUser(''); setLoginPass(''); setDevPassword(''); }}>خروج</Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('about')} className={tabBtnClass('about')}><FileText size={16} /> بيانات البرنامج</button>
        <button onClick={() => setTab('license')} className={tabBtnClass('license')}><Key size={16} /> الترخيص والتفعيل</button>
        <button onClick={() => setTab('codes')} className={tabBtnClass('codes')}><Hash size={16} /> أكواد التفعيل</button>
      </div>

      {/* Dev Password */}
      <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">الرقم السري للمطور (مطلوب لجميع العمليات)</label>
        <input type="password" value={devPassword} onChange={(e) => setDevPassword(e.target.value)} placeholder="••••••"
          className="w-full max-w-xs px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
      </div>

      {/* ===== ABOUT TAB ===== */}
      {tab === 'about' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">بيانات البرنامج</h2>
              {mode === 'view' ? <Button size="sm" variant="secondary" onClick={() => setMode('edit')} icon={<Edit size={14} />}>تعديل</Button>
                : <Button size="sm" onClick={handleSave} icon={<Save size={14} />}>حفظ</Button>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="text-xs text-slate-500 dark:text-slate-400">اسم البرنامج</label>{mode === 'view' ? <div className="font-bold text-slate-800 dark:text-white">{devInfo.app_name || 'موبايل شوب سيستم'}</div> : <Input value={devInfo.app_name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, app_name: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">الإصدار</label>{mode === 'view' ? <div className="font-bold text-blue-600">{devInfo.app_version}</div> : <Input value={devInfo.app_version} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, app_version: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">اسم المطور</label>{mode === 'view' ? <div className="font-medium text-slate-800 dark:text-white">{devInfo.dev_name}</div> : <Input value={devInfo.dev_name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, dev_name: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">الهاتف</label>{mode === 'view' ? <div className="text-slate-700 dark:text-slate-200">{devInfo.dev_phone || '—'}</div> : <Input value={devInfo.dev_phone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, dev_phone: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">الإيميل</label>{mode === 'view' ? <div className="text-slate-700 dark:text-slate-200">{devInfo.dev_email || '—'}</div> : <Input value={devInfo.dev_email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, dev_email: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">حقوق النشر</label>{mode === 'view' ? <div className="text-sm text-slate-700 dark:text-slate-200">{devInfo.copyright || '—'}</div> : <Input value={devInfo.copyright} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, copyright: e.target.value })} />}</div>
              <div><label className="text-xs text-slate-500 dark:text-slate-400">حقوق التوزيع</label>{mode === 'view' ? <div className="text-sm text-slate-700 dark:text-slate-200">{devInfo.distribution_rights || '—'}</div> : <Input value={devInfo.distribution_rights} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevInfo({ ...devInfo, distribution_rights: e.target.value })} />}</div>
              <div className="col-span-2"><label className="text-xs text-slate-500 dark:text-slate-400">محتوى مخصص</label>{mode === 'view' ? <div className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200 min-h-[60px] bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3">{devInfo.custom_content || '—'}</div> : <Textarea value={devInfo.custom_content} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDevInfo({ ...devInfo, custom_content: e.target.value })} rows={3} />}</div>
            </div>
          </div>
        </div>
      )}

      {/* ===== LICENSE TAB ===== */}
      {tab === 'license' && licenseStatus && (
        <div className="space-y-4">
          {/* Status */}
          <div className={`rounded-xl p-5 border-2 ${licenseStatus.status === 'active' ? 'border-green-300 bg-green-50 dark:bg-green-900/20' : licenseStatus.status === 'expired' ? 'border-red-300 bg-red-50 dark:bg-red-900/20' : 'border-orange-300 bg-orange-50 dark:bg-orange-900/20'}`}>
            <div className="flex items-center gap-3 mb-3">
              {licenseStatus.status === 'active' ? <CheckCircle size={24} className="text-green-500" /> : <AlertTriangle size={24} className={licenseStatus.status === 'expired' ? 'text-red-500' : 'text-orange-500'} />}
              <div>
                <div className="font-bold text-slate-800 dark:text-white">{licenseStatus.message}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">الحالة: {licenseStatus.status}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4">
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
                <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1"><Cpu size={12} /> معرّف الجهاز</div>
                <div className="text-xs font-mono text-slate-700 dark:text-slate-200 break-all">{licenseStatus.deviceId}</div>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
                <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1"><Calendar size={12} /> تاريخ البدء</div>
                <div className="text-sm text-slate-700 dark:text-slate-200">{licenseStatus.startDate || '—'}</div>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3">
                <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-1"><Hash size={12} /> الأيام المتبقية</div>
                <div className="text-lg font-bold text-slate-800 dark:text-white">{licenseStatus.remainingDays ?? '—'}</div>
              </div>
            </div>
          </div>

          {/* Deactivate */}
          {licenseStatus.status === 'active' && (
            <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-red-200 dark:border-red-700">
              <h3 className="text-sm font-semibold text-red-700 dark:text-red-300 mb-2">إلغاء التفعيل</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">إلغاء تفعيل الترخيص على هذا الجهاز (للنقل لجهاز آخر)</p>
              <Button variant="danger" onClick={handleDeactivate} icon={<Trash2 size={14} />}>إلغاء التفعيل</Button>
            </div>
          )}
        </div>
      )}

      {/* ===== CODES TAB ===== */}
      {tab === 'codes' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowGenModal(true)} icon={<Plus size={16} />}>إنشاء كود تفعيل</Button>
          </div>

          <div className="mb-3">
            <Button variant="secondary" onClick={fetchCodes} icon={<Hash size={14} />}>تحديث القائمة</Button>
          </div>

          <DataTable
            columns={[
              { key: 'code', title: 'الكود', render: (r) => <span className="font-mono text-xs font-bold text-slate-800 dark:text-white">{r.code}</span> },
              { key: 'days', title: 'الأيام', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.days === 0 ? 'غير محدود' : r.days + ' يوم'}</span> },
              { key: 'type', title: 'النوع', render: (r) => <Badge variant={r.type === 'full' ? 'green' : 'blue'}>{r.type === 'full' ? 'كامل' : 'تجريبي'}</Badge> },
              { key: 'deviceId', title: 'جهاز العميل', render: (r) => <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 break-all">{r.deviceId?.substring(0, 16) || '—'}...</span> },
              { key: 'used', title: 'الحالة', render: (r) => <Badge variant={r.used ? 'red' : 'green'}>{r.used ? 'مستخدم' : 'متاح'}</Badge> },
              { key: 'createdAt', title: 'تاريخ الإنشاء', render: (r) => <span className="text-xs text-slate-500 dark:text-slate-400">{r.createdAt?.split('T')[0]}</span> },
              { key: 'actions', title: '', render: (r) => <button onClick={() => handleRevoke(r.code)} className="text-xs text-red-500 hover:underline">إلغاء</button> },
            ]}
            data={generatedCodes}
            keyField="code"
            emptyMessage="لا توجد أكواد - أنشئ كوداً جديداً"
          />
        </div>
      )}

      {/* Generate Code Modal */}
      <Modal isOpen={showGenModal} onClose={() => setShowGenModal(false)} title="إنشاء كود تفعيل" size="sm"
        footer={<><Button variant="secondary" onClick={() => setShowGenModal(false)}>إلغاء</Button><Button onClick={handleGenerateCode}>إنشاء</Button></>}>
        <div className="space-y-4">
          <Input label="معرّف جهاز العميل" value={genDeviceId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGenDeviceId(e.target.value)} placeholder="ألصق معرّف جهاز العميل هنا" hint="يجب على العميل نسخ معرّف جهازه من شاشة التفعيل أو الإعدادات" />
          <Input label="عدد الأيام (0 = غير محدود)" type="number" value={genDays} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGenDays(e.target.value)} hint="7 = أسبوع، 30 = شهر، 0 = غير محدود" />
          <Select label="نوع الاشتراك" value={genType} onChange={(e) => setGenType(e.target.value)}>
            <option value="trial">تجريبي</option>
            <option value="full">كامل (غير محدود الميزات)</option>
          </Select>
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
            سيتم إنشاء كود تفعيل فريد مرتبط بجهاز العميل المحدد. لا يمكن استخدام الكود على جهاز آخر.
          </div>
        </div>
      </Modal>
      </div>
    </div>
  );
}
