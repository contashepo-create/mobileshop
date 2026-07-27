import { Moon, Sun, Check } from 'lucide-react';
import { useThemeStore } from '../../stores/theme.store';
import { useToastStore } from '../../components/ui/Toast';

export function AppearanceSettings() {
  const { theme, setTheme } = useThemeStore();
  const { showToast } = useToastStore();

  const handleSetTheme = (newTheme: 'light' | 'dark') => {
    setTheme(newTheme);
    window.api.invoke('settings:set', 'theme', newTheme);
    showToast('success', 'تم تغيير المظهر بنجاح');
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">الوضع</h2>
        <div className="grid grid-cols-2 gap-4">
          {/* Light */}
          <button
            onClick={() => handleSetTheme('light')}
            className={`relative p-6 rounded-xl border-2 transition-all ${
              theme === 'light'
                ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
            }`}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-yellow-100 flex items-center justify-center">
                <Sun size={28} className="text-yellow-500" />
              </div>
              <span className="font-medium text-slate-700 dark:text-slate-200">الوضع الفاتح</span>
            </div>
            {theme === 'light' && (
              <div className="absolute top-2 right-2 w-6 h-6 bg-primary-600 rounded-full flex items-center justify-center">
                <Check size={14} className="text-white" />
              </div>
            )}
          </button>

          {/* Dark */}
          <button
            onClick={() => handleSetTheme('dark')}
            className={`relative p-6 rounded-xl border-2 transition-all ${
              theme === 'dark'
                ? 'border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
            }`}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-slate-700 flex items-center justify-center">
                <Moon size={28} className="text-slate-300" />
              </div>
              <span className="font-medium text-slate-700 dark:text-slate-200">الوضع الداكن</span>
            </div>
            {theme === 'dark' && (
              <div className="absolute top-2 right-2 w-6 h-6 bg-primary-600 rounded-full flex items-center justify-center">
                <Check size={14} className="text-white" />
              </div>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
