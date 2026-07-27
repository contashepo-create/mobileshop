import { useState } from 'react';
import { Settings as SettingsIcon, Palette, Printer, Users, Building2, Menu } from 'lucide-react';
import { GeneralSettings } from './GeneralSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { PrintSettings } from './PrintSettings';
import { UsersSettings } from './UsersSettings';
import { SidebarSettings } from './SidebarSettings';

type Tab = 'general' | 'appearance' | 'print' | 'users' | 'sidebar';

const tabs = [
  { key: 'general' as Tab, label: 'إعدادات عامة', icon: Building2 },
  { key: 'appearance' as Tab, label: 'المظهر', icon: Palette },
  { key: 'print' as Tab, label: 'الطباعة والفواتير', icon: Printer },
  { key: 'sidebar' as Tab, label: 'القائمة الجانبية', icon: Menu },
  { key: 'users' as Tab, label: 'المستخدمين والصلاحيات', icon: Users },
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('general');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={24} className="text-primary-600" />
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">الإعدادات</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.key
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-500 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div>
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'appearance' && <AppearanceSettings />}
        {activeTab === 'print' && <PrintSettings />}
        {activeTab === 'sidebar' && <SidebarSettings />}
        {activeTab === 'users' && <UsersSettings />}
      </div>
    </div>
  );
}
