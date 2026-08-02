import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth.store';
import { useThemeStore } from '../../stores/theme.store';
import { Lock, User, Moon, Sun, Eye, EyeOff, Save, ShieldAlert, X } from 'lucide-react';
import { useToastStore } from '../../components/ui/Toast';

export function Login() {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const { showToast } = useToastStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saveUsername, setSaveUsername] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<{username: string; password: string}[]>([]);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotDevUser, setForgotDevUser] = useState('');
  const [forgotDevPass, setForgotDevPass] = useState('');
  const [forgotNewPass, setForgotNewPass] = useState('');
  const [forgotTargetUser, setForgotTargetUser] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [usersList, setUsersList] = useState<any[]>([]);
  // Recovery by Telegram code — the route the shop owner drives alone.
  // `forgotMode` starts on 'self' so the owner meets the option that does not
  // need a phone call; the developer route stays one click away for a shop
  // with no internet.
  const [forgotMode, setForgotMode] = useState<'self' | 'dev'>('self');
  const [selfAvailable, setSelfAvailable] = useState(true);
  const [selfStep, setSelfStep] = useState<1 | 2>(1);
  const [selfAdmins, setSelfAdmins] = useState<any[]>([]);
  const [selfUserId, setSelfUserId] = useState('');
  const [selfCode, setSelfCode] = useState('');
  const [selfNewPass, setSelfNewPass] = useState('');
  const [selfNewPass2, setSelfNewPass2] = useState('');

  // Load saved credentials on mount
  useEffect(() => {
    const saved = localStorage.getItem('saved_accounts');
    if (saved) {
      try {
        const accounts = JSON.parse(saved);
        setSavedAccounts(accounts);
        if (accounts.length > 0) {
          setUsername(accounts[0].username);
          setSaveUsername(true);
        }
      } catch {}
    }
    // A previous build stored the password here. Read the USERNAME out of it
    // so the shop does not lose that convenience, then delete the record —
    // leaving it in place would keep the plaintext on disk indefinitely for
    // anyone who upgrades.
    const legacy = localStorage.getItem('saved_password');
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy);
        if (parsed?.username) {
          setUsername(parsed.username);
          setSaveUsername(true);
          localStorage.setItem('saved_username', parsed.username);
        }
      } catch { /* unreadable: it is being deleted anyway */ }
      localStorage.removeItem('saved_password');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError('يرجى إدخال اسم المستخدم وكلمة المرور');
      return;
    }

    setLoading(true);
    setError('');

    const success = await login(username, password);
    if (success) {
      // Save username if checked
      if (saveUsername) {
        localStorage.setItem('saved_username', username);
      } else {
        localStorage.removeItem('saved_username');
      }

      // The password is NEVER persisted.
      //
      // It used to be written to localStorage as plain JSON — not even
      // obfuscated — under `saved_password`. localStorage is readable by any
      // script running in this window and by anyone who opens the profile
      // folder, and a shop counter is a shared machine: the point of a
      // password is that the next person on the till does not have it.
      //
      // Removed unconditionally, so a build that once saved one wipes it on
      // the next successful login rather than leaving it on disk forever.
      localStorage.removeItem('saved_password');
      navigate('/');
    } else {
      setError('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    setLoading(false);
  };

  const handleForgotOpen = async () => {
    setShowForgot(true);
    setForgotDevUser('');
    setForgotDevPass('');
    setForgotNewPass('');
    setForgotTargetUser('');
    setSelfStep(1);
    setSelfUserId('');
    setSelfCode('');
    setSelfNewPass('');
    setSelfNewPass2('');
    // `users:listBasic` exposes only id + username (callable pre-login),
    // unlike `users:list` which leaks roles/employee links.
    const users = await window.api.invoke('users:listBasic');
    setUsersList(Array.isArray(users) ? users : []);
    // Administrators only — the self-service route is not offered to a cashier,
    // whose password their administrator already resets from the users screen.
    const admins = await window.api.invoke('users:listRecoverable');
    const adminList = Array.isArray(admins) ? admins : [];
    setSelfAdmins(adminList);
    if (adminList.length === 1) setSelfUserId(String(adminList[0].UserID));
    // If this build has no recovery server configured, do not offer a button
    // that can only fail — send the owner straight to the developer route.
    const avail = await window.api.invoke('recovery:isAvailable');
    const ok = Boolean(avail?.available) && adminList.length > 0;
    setSelfAvailable(ok);
    setForgotMode(ok ? 'self' : 'dev');
  };

  /** Step 1 — ask the server to send a code to the owner's Telegram. */
  const handleSendCode = async () => {
    if (!selfUserId) {
      showToast('error', 'اختر حساب المدير أولاً');
      return;
    }
    setForgotLoading(true);
    const res = await window.api.invoke('recovery:requestCode', {
      userId: parseInt(selfUserId),
    });
    setForgotLoading(false);
    if (res?.success) {
      showToast('success', res.message);
      setSelfStep(2);
    } else {
      showToast('error', res?.message || 'تعذّر إرسال الرمز');
    }
  };

  /** Step 2 — send the code and the new password together. */
  const handleSelfReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(selfCode.trim())) {
      showToast('error', 'الرمز يجب أن يكون ٦ أرقام');
      return;
    }
    if (selfNewPass.length < 6) {
      showToast('error', 'كلمة المرور الجديدة يجب أن تكون ٦ أحرف على الأقل');
      return;
    }
    // Caught here rather than after the one-time code is spent: a typo in the
    // confirmation must not burn the code and force a fresh request.
    if (selfNewPass !== selfNewPass2) {
      showToast('error', 'كلمتا المرور غير متطابقتين');
      return;
    }
    setForgotLoading(true);
    const res = await window.api.invoke('recovery:resetPassword', {
      userId: parseInt(selfUserId),
      code: selfCode.trim(),
      newPassword: selfNewPass,
    });
    setForgotLoading(false);
    if (res?.success) {
      showToast('success', res.message);
      setShowForgot(false);
      // Pre-fill the username so the owner can sign in immediately.
      const who = selfAdmins.find((u: any) => String(u.UserID) === selfUserId);
      if (who?.Username) setUsername(who.Username);
      setPassword('');
    } else {
      showToast('error', res?.message || 'تعذّر إعادة التعيين');
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotDevUser || !forgotDevPass || !forgotNewPass || !forgotTargetUser) {
      showToast('error', 'يرجى إدخال جميع الحقول');
      return;
    }
    if (forgotNewPass.length < 4) {
      showToast('error', 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل');
      return;
    }
    if (forgotNewPass.length < 6) {
      showToast('error', 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
      return;
    }
    setForgotLoading(true);
    // Two steps: the main process verifies the developer credentials (bcrypt +
    // lockout) and returns a short-lived token, which then authorises the reset.
    // The credentials themselves are never compared in the renderer.
    const auth = await window.api.invoke('dev:login', {
      username: forgotDevUser,
      password: forgotDevPass,
    });
    if (!auth?.success || !auth.token) {
      setForgotLoading(false);
      showToast('error', auth?.message || 'بيانات المطور غير صحيحة');
      return;
    }
    const result = await window.api.invoke('users:resetByDev', {
      devToken: auth.token,
      targetUserId: parseInt(forgotTargetUser),
      newPassword: forgotNewPass,
    });
    // Fire and forget on purpose: the reset above already succeeded or failed
    // on its own terms, and its outcome is reported below. Whether the
    // developer token was torn down cleanly is not something to interrupt the
    // shop owner about.
    void window.api.invoke('dev:logout', { devToken: auth.token });
    setForgotLoading(false);
    if (result.success) {
      showToast('success', result.message);
      setShowForgot(false);
    } else {
      showToast('error', result.message);
    }
  };

  // Load saved username on mount
  useEffect(() => {
    if (!saveUsername) {
      const savedUser = localStorage.getItem('saved_username');
      if (savedUser) {
        setUsername(savedUser);
        setSaveUsername(true);
      }
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-800">
      <button
        onClick={toggleTheme}
        className="absolute top-4 left-4 p-2 rounded-lg bg-white dark:bg-slate-800 shadow-md text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
      >
        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
      </button>

      <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-primary-600 rounded-2xl mb-4">
            <SmartphoneIcon />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">
            نظام إدارة المحمول
          </h1>
          <p className="text-slate-500 dark:text-slate-500 dark:text-slate-400 mt-2 text-sm">
            محلات الموبايلات والصيانة
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              اسم المستخدم
            </label>
            <div className="relative">
              <User className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={18} />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pr-10 pl-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 transition-colors"
                placeholder="أدخل اسم المستخدم"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              كلمة المرور
            </label>
            <div className="relative">
              <Lock className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={18} />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pr-10 pl-10 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 transition-colors"
                placeholder="أدخل كلمة المرور"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {/* Save options */}
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveUsername}
                onChange={(e) => {
                  setSaveUsername(e.target.checked);
                  if (!e.target.checked) setSavePassword(false);
                }}
                className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500"
              />
              <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1">
                <Save size={14} /> حفظ اسم المستخدم
              </span>
            </label>

            {/* "Save password" removed. Offering it implies the program can
                store a password safely on a shared counter machine, and it
                cannot: localStorage is plain text to anyone with the profile
                folder. The username is still remembered. */}
          </div>

          {error && (
            <div className="text-red-500 text-sm text-center bg-red-50 dark:bg-red-900/20 py-2 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'جاري التحقق...' : 'تسجيل الدخول'}
          </button>

          <div className="text-center">
            <button type="button" onClick={handleForgotOpen} className="text-xs text-slate-500 dark:text-slate-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors">
              نسيت كلمة المرور؟
            </button>
          </div>
        </form>
      </div>

      {/* Forgot Password Modal */}
      {showForgot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-xl w-full max-w-sm mx-4 shadow-2xl border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <ShieldAlert size={18} className="text-orange-500" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-white">إعادة تعيين كلمة المرور</h3>
              </div>
              <button onClick={() => setShowForgot(false)} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"><X size={18} /></button>
            </div>
            {/* Two routes: the owner's own Telegram (needs internet, no phone
                call) and the developer (works offline). The self-service tab is
                hidden entirely when this build has no recovery server. */}
            {selfAvailable && (
              <div className="flex gap-1 p-2 pb-0">
                <button type="button" onClick={() => setForgotMode('self')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    forgotMode === 'self'
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                  برمز تليجرام
                </button>
                <button type="button" onClick={() => setForgotMode('dev')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    forgotMode === 'dev'
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                  بمساعدة المطور
                </button>
              </div>
            )}

            {forgotMode === 'self' && selfAvailable && (
              <div className="p-4 space-y-3">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2.5 text-xs text-blue-700 dark:text-blue-300">
                  سيصل رمز مكوّن من ٦ أرقام إلى <span className="font-medium">بوت تليجرام الخاص بالمحل</span>
                  {' '}(المضبوط في الإعدادات ← النسخ الاحتياطي).
                  <div className="mt-1">لا تعطِ هذا الرمز لأي شخص مهما كان.</div>
                </div>

                {selfStep === 1 ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">حساب المدير</label>
                      <select value={selfUserId} onChange={(e) => setSelfUserId(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm">
                        <option value="">اختر الحساب</option>
                        {selfAdmins.map((u: any) => <option key={u.UserID} value={u.UserID}>{u.Username}</option>)}
                      </select>
                    </div>
                    <button type="button" onClick={handleSendCode} disabled={forgotLoading}
                      className="w-full py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
                      {forgotLoading ? 'جاري الإرسال...' : 'إرسال الرمز إلى تليجرام'}
                    </button>
                  </>
                ) : (
                  <form onSubmit={handleSelfReset} className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">رمز التحقق (٦ أرقام)</label>
                      <input type="text" inputMode="numeric" maxLength={6} value={selfCode}
                        onChange={(e) => setSelfCode(e.target.value.replace(/\D/g, ''))}
                        dir="ltr"
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-center text-lg tracking-[0.4em]" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">كلمة المرور الجديدة</label>
                      <input type="password" value={selfNewPass} onChange={(e) => setSelfNewPass(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">تأكيد كلمة المرور</label>
                      <input type="password" value={selfNewPass2} onChange={(e) => setSelfNewPass2(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
                    </div>
                    <button type="submit" disabled={forgotLoading}
                      className="w-full py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
                      {forgotLoading ? 'جاري...' : 'تعيين كلمة المرور'}
                    </button>
                    <button type="button" onClick={() => { setSelfStep(1); setSelfCode(''); }}
                      className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-primary-600">
                      لم يصلني الرمز - إرسال مرة أخرى
                    </button>
                  </form>
                )}
              </div>
            )}

            {(forgotMode === 'dev' || !selfAvailable) && (
            <form onSubmit={handleForgotSubmit} className="p-4 space-y-3">
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2.5 text-xs text-orange-700 dark:text-orange-300">
                استعادة كلمة المرور تتطلب تدخل المطور. تواصل مع الدعم الفني وسيقوم هو بإدخال بياناته.
                <div className="mt-1 font-medium">لا تشارك بيانات دخولك مع أي شخص.</div>
                {!selfAvailable && (
                  <div className="mt-2 pt-2 border-t border-orange-200 dark:border-orange-800">
                    💡 لتستعيد كلمة المرور بنفسك مستقبلاً دون انتظار الدعم، اضبط بوت تليجرام الخاص
                    بمحلك من: الإعدادات ← النسخ الاحتياطي.
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">اسم مستخدم المطور</label>
                <input type="text" value={forgotDevUser} onChange={(e) => setForgotDevUser(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">الرقم السري للمطور</label>
                <input type="password" value={forgotDevPass} onChange={(e) => setForgotDevPass(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">المستخدم</label>
                <select value={forgotTargetUser} onChange={(e) => setForgotTargetUser(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm">
                  <option value="">اختر المستخدم</option>
                  {usersList.map((u: any) => <option key={u.UserID} value={u.UserID}>{u.Username}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">كلمة المرور الجديدة</label>
                <input type="password" value={forgotNewPass} onChange={(e) => setForgotNewPass(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm" />
              </div>
              <button type="submit" disabled={forgotLoading}
                className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
                {forgotLoading ? 'جاري...' : 'إعادة تعيين كلمة المرور'}
              </button>
            </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SmartphoneIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}
