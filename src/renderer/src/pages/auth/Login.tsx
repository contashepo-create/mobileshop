import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth.store';
import { useThemeStore } from '../../stores/theme.store';
import { Lock, User, Moon, Sun, Eye, EyeOff, Save, KeyRound, ShieldAlert, X } from 'lucide-react';
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
  const [savePassword, setSavePassword] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<{username: string; password: string}[]>([]);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotDevUser, setForgotDevUser] = useState('');
  const [forgotDevPass, setForgotDevPass] = useState('');
  const [forgotNewPass, setForgotNewPass] = useState('');
  const [forgotTargetUser, setForgotTargetUser] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [usersList, setUsersList] = useState<any[]>([]);

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
    const savedPass = localStorage.getItem('saved_password');
    if (savedPass) {
      try {
        const parsed = JSON.parse(savedPass);
        if (parsed.username) {
          setUsername(parsed.username);
          setPassword(parsed.password || '');
          setSavePassword(true);
          setSaveUsername(true);
        }
      } catch {}
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

      // Save password if checked
      if (savePassword) {
        localStorage.setItem('saved_password', JSON.stringify({ username, password }));
      } else {
        localStorage.removeItem('saved_password');
      }
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
    const users = await window.api.invoke('users:list');
    setUsersList(users);
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
    setForgotLoading(true);
    const result = await window.api.invoke('users:resetByDev', {
      devUser: forgotDevUser,
      devPassword: forgotDevPass,
      targetUserId: parseInt(forgotTargetUser),
      newPassword: forgotNewPass,
    });
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

            <label className={`flex items-center gap-2 cursor-pointer ${!saveUsername ? 'opacity-40' : ''}`}>
              <input
                type="checkbox"
                checked={savePassword}
                onChange={(e) => setSavePassword(e.target.checked)}
                disabled={!saveUsername}
                className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500"
              />
              <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1">
                <KeyRound size={14} /> حفظ كلمة المرور
              </span>
            </label>
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
            <form onSubmit={handleForgotSubmit} className="p-4 space-y-3">
              <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2.5 text-xs text-orange-700 dark:text-orange-300">
                هذه الخاصية مخصصة لحالة نسيان كلمة المرور. يرجى إدخال بيانات الدخول الخاصة بالمطور.
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
                  {usersList.map((u: any) => <option key={u.UserID} value={u.UserID}>{u.Username} ({u.RoleName})</option>)}
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
