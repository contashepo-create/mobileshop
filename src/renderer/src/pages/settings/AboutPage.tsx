import { useState, useEffect } from 'react';
import { Info, Phone, Mail, User, Copyright, FileText, Hash, Shield, ChevronLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';

export function AboutPage() {
  const [info, setInfo] = useState<any>({});
  const [showDevLogin, setShowDevLogin] = useState(false);

  useEffect(() => {
    (async () => {
      const settings = await window.api.invoke('settings:getAll');
      setInfo({
        app_name: settings.app_name || 'موبايل شوب سيستم',
        company_name: settings.company_name || 'محل الموبايلات',
        owner_name: settings.owner_name || 'Acc. Mohamed Abdou',
        phone: settings.phone || '',
        email: settings.email || '',
        address: settings.address || '',
        tax_number: settings.tax_number || '',
        copyright: settings.copyright || '© 2026 محاسب / محمد عبدة - جميع الحقوق محفوظة',
        distribution_rights: settings.distribution_rights || 'غير مسموح بتوزيع أو نسخ البرنامج بدون إذن المطور',
        custom_content: settings.custom_content || '',
        app_version: settings.app_version || '1.0.0',
        dev_name: settings.dev_name || 'محاسب / محمد عبدة',
        dev_phone: settings.dev_phone || '01207770329',
        dev_email: settings.dev_email || 'conta.shepo@gmail.com',
      });
    })();
  }, []);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Info size={24} className="text-primary-600" />
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">حول البرنامج</h1>
      </div>

      {/* App Info */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-16 h-16 rounded-2xl bg-primary-600 flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
              <path d="M12 18h.01"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-white">{info.app_name}</h2>
            <div className="flex items-center gap-1 mt-1">
              <Hash size={14} className="text-slate-500 dark:text-slate-400" />
              <span className="text-sm text-slate-500 dark:text-slate-400">الإصدار {info.app_version}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Developer Info */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">بيانات المطور</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <User size={14} className="text-blue-600" />
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">المطور</div>
              <div className="text-sm font-medium text-slate-800 dark:text-white">{info.dev_name}</div>
            </div>
          </div>
          {info.dev_phone && (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Phone size={14} className="text-green-600" />
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">الهاتف</div>
                <div className="text-sm font-medium text-slate-800 dark:text-white">{info.dev_phone}</div>
              </div>
            </div>
          )}
          {info.dev_email && (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                <Mail size={14} className="text-purple-600" />
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">البريد الإلكتروني</div>
                <div className="text-sm font-medium text-slate-800 dark:text-white">{info.dev_email}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Copyright */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2 mb-3">
          <Copyright size={18} className="text-orange-600" />
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">حقوق النشر والتوزيع</h3>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">{info.copyright}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{info.distribution_rights}</p>
      </div>

      {/* Custom Content */}
      {info.custom_content && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <FileText size={18} className="text-purple-600" />
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">معلومات إضافية</h3>
          </div>
          <div className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{info.custom_content}</div>
        </div>
      )}

      {/* Footer */}
      <div className="text-center text-xs text-slate-500 dark:text-slate-400 pb-4">
        <p>{info.app_name} — {info.company_name}</p>
        <p className="mt-1">تطوير: {info.dev_name}</p>
      </div>
    </div>
  );
}
