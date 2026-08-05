import { useState, useEffect } from 'react';
import { Database, Download, Upload, HardDrive, Cloud, RefreshCw, FolderOpen, Wifi, CheckCircle, XCircle, Clock, FileSpreadsheet, Network } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';
import { isFailure, failureMessage } from '../../lib/ipc';

type Tab = 'overview' | 'export' | 'backup' | 'network' | 'cloud';

export function DatabaseManagementPage() {
  const { showToast } = useToastStore();
  const [tab, setTab] = useState<Tab>('overview');
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Network form
  const [networkPath, setNetworkPath] = useState('');
  const [dbPathSetting, setDbPathSetting] = useState('');

  // Cloud form
  const [cloudType, setCloudType] = useState('supabase');
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudApiKey, setCloudApiKey] = useState('');
  const [cloudSettings, setCloudSettings] = useState<any>({});
  const [uploading, setUploading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const [info, tbls, cloud] = await Promise.all([
      window.api.invoke('db:backupInfo'),
      window.api.invoke('db:getTables'),
      window.api.invoke('db:getCloudSettings'),
    ]);
    setDbInfo(info);
    setTables(tbls);
    setCloudSettings(cloud);
    setCloudType(cloud.cloud_type || 'supabase');
    setCloudUrl(cloud.cloud_url || '');
    setCloudApiKey(cloud.cloud_api_key || '');
    setDbPathSetting(cloud.db_path || info?.dbPath || '');
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  // Auto backup on mount
  useEffect(() => {
    window.api.invoke('db:autoBackup');
  }, []);

  const handleExportTable = async (table: string) => {
    const result = await window.api.invoke('db:exportCSV', table);
    if (result.success) {
      showToast('success', `تم تصدير ${result.count} سجل إلى: ${result.path}`);
    } else if (result.message !== 'تم الإلغاء') {
      showToast('error', result.message);
    }
  };

  const handleExportAll = async () => {
    const result = await window.api.invoke('db:exportAllCSV');
    if (result.success) {
      showToast('success', `تم تصدير ${result.tables} جدول إلى: ${result.folder}`);
    } else if (result.message !== 'تم الإلغاء') {
      showToast('error', result.message);
    }
  };

  const handleBackup = async () => {
    const result = await window.api.invoke('backup:create');
    if (result.success) {
      showToast('success', `تم حفظ النسخة في: ${result.path}`);
      fetchData();
    } else if (result.message !== 'تم الإلغاء') {
      showToast('error', result.message);
    }
  };

  const handleBrowsePath = async () => {
    const result = await window.api.invoke('db:browsePath');
    if (result.success) {
      setNetworkPath(result.path);
    }
  };

  const handleChangePath = async () => {
    if (!networkPath) { showToast('error', 'اختر ملف قاعدة البيانات'); return; }
    const result = await window.api.invoke('db:changePath', networkPath);
    if (result.success) {
      showToast('success', result.message);
    } else {
      showToast('error', result.message);
    }
  };

  const handleBrowseFolder = async () => {
    const result = await window.api.invoke('db:browseFolder');
    if (result.success) {
      setNetworkPath(result.path);
    }
  };

  const handleCreateNetwork = async () => {
    if (!networkPath) { showToast('error', 'اختر مجلداً'); return; }
    const result = await window.api.invoke('db:createNetwork', networkPath);
    if (result.success) {
      showToast('success', result.message);
    } else {
      showToast('error', result.message);
    }
  };

  const handleSaveCloud = async () => {
    const settings = {
      cloud_type: cloudType,
      cloud_url: cloudUrl,
      cloud_api_key: cloudApiKey,
    };
    const reply = await window.api.invoke('db:saveCloudSettings', settings);
    if (isFailure(reply)) { showToast('error', failureMessage(reply)); return; }
    showToast('success', 'تم حفظ إعدادات السحابة');
  };

  const handleTestConnection = async () => {
    if (!cloudUrl) { showToast('error', 'أدخل رابط الاتصال'); return; }
    setTesting(true);
    setTestResult(null);
    const result = await window.api.invoke('db:testCloudConnection', {
      type: cloudType, url: cloudUrl, apiKey: cloudApiKey,
    });
    setTestResult(result);
    setTesting(false);
    if (result.success) {
      showToast('success', result.message);
    } else {
      showToast('error', result.message);
    }
  };

  const handleUploadCloud = async () => {
    setUploading(true);
    const result = await window.api.invoke('db:uploadToCloud', {
      type: cloudType, url: cloudUrl, apiKey: cloudApiKey,
    });
    setUploading(false);
    if (result.success) {
      showToast('success', result.message);
    } else {
      showToast('error', result.message);
    }
  };

  const tabBtnClass = (t: string) =>
    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ' +
    (tab === t ? 'bg-primary-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white">إدارة قاعدة البيانات</h1>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('overview')} className={tabBtnClass('overview')}><Database size={16} /> نظرة عامة</button>
        <button onClick={() => setTab('export')} className={tabBtnClass('export')}><FileSpreadsheet size={16} /> تصدير</button>
        <button onClick={() => setTab('backup')} className={tabBtnClass('backup')}><HardDrive size={16} /> النسخ الاحتياطي</button>
        <button onClick={() => setTab('network')} className={tabBtnClass('network')}><Network size={16} /> الشبكة المحلية</button>
        <button onClick={() => setTab('cloud')} className={tabBtnClass('cloud')}><Cloud size={16} /> النسخ السحابي</button>
      </div>

      {/* ===== OVERVIEW ===== */}
      {tab === 'overview' && dbInfo && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Database size={24} className="text-blue-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-800 dark:text-white">معلومات قاعدة البيانات</h2>
                <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 break-all">{dbInfo.dbPath}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">حجم القاعدة</div>
                <div className="text-lg font-bold text-slate-800 dark:text-white">{dbInfo.dbSizeFormatted}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">عدد الجداول</div>
                <div className="text-lg font-bold text-slate-800 dark:text-white">{tables.length}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">النسخ الاحتياطية</div>
                <div className="text-lg font-bold text-slate-800 dark:text-white">{dbInfo.backups?.length || 0}</div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">الجداول ({tables.length})</h3>
            <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
              {tables.map(t => (
                <div key={t} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-700/30 rounded-lg px-3 py-1.5">
                  <Database size={12} className="text-slate-500 dark:text-slate-400" />
                  <span className="text-xs text-slate-600 dark:text-slate-300 font-mono">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== EXPORT ===== */}
      {tab === 'export' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">تصدير البيانات</h2>
              <Button onClick={handleExportAll} icon={<Download size={16} />}>تصدير كل الجداول</Button>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-3">اختر جدولاً لتصديره إلى ملف CSV (متوافق مع Excel)</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {tables.map(t => (
                <button key={t} onClick={() => handleExportTable(t)}
                  className="flex items-center justify-between bg-slate-50 dark:bg-slate-700/30 rounded-lg px-3 py-2 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors">
                  <span className="text-sm text-slate-700 dark:text-slate-200 font-mono">{t}</span>
                  <Download size={14} className="text-slate-500 dark:text-slate-400" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== BACKUP ===== */}
      {tab === 'backup' && dbInfo && (
        <div className="space-y-4">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center gap-3">
            <CheckCircle size={24} className="text-green-500" />
            <div>
              <div className="font-semibold text-green-800 dark:text-green-300">الحفظ التلقائي مفعّل</div>
              <div className="text-sm text-green-600 dark:text-green-400">يتم إنشاء نسخة احتياطية يومياً تلقائياً عند فتح التطبيق</div>
            </div>
          </div>

          <div className="flex gap-3">
            <Button onClick={handleBackup} icon={<Download size={16} />}>إنشاء نسخة احتياطية الآن</Button>
            <Button variant="secondary" onClick={fetchData} icon={<RefreshCw size={16} />}>تحديث</Button>
          </div>

          <DataTable
            columns={[
              { key: 'name', title: 'اسم الملف', render: (r) => <span className="font-mono text-xs text-slate-700 dark:text-slate-200">{r.name}</span> },
              { key: 'date', title: 'التاريخ', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.date}</span> },
              { key: 'sizeFormatted', title: 'الحجم', render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.sizeFormatted}</span> },
              { key: 'type', title: 'النوع', render: (r) => <Badge variant={r.name.startsWith('auto_') ? 'blue' : 'green'}>{r.name.startsWith('auto_') ? 'تلقائي' : 'يدوي'}</Badge> },
            ]}
            data={dbInfo.backups || []}
            keyField="name"
            emptyMessage="لا توجد نسخ احتياطية"
          />
        </div>
      )}

      {/* ===== NETWORK ===== */}
      {tab === 'network' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <Network size={20} className="text-blue-600" />
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">مشاركة قاعدة البيانات على شبكة محلية</h2>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-3">
              شارك قاعدة البيانات بين عدة أجهزة على نفس الشبكة. ضع ملف قاعدة البيانات في مجلد مشترك على الشبكة.
            </p>

            {/* Honest about the trade-off. SQLite over SMB is workable for a
                small shop and genuinely risky if the network is unreliable, and
                the owner is the only one who can weigh that. */}
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-4 text-xs text-amber-800 dark:text-amber-300">
              <div className="font-bold mb-1">⚠️ اقرأ قبل التفعيل</div>
              <ul className="space-y-1 list-disc pr-4">
                <li>جهاز واحد فقط يكتب في اللحظة الواحدة — الباقون ينتظرون ثوانٍ (هذا طبيعي).</li>
                <li>
                  <span className="font-bold">لا تفصل الكهرباء أو الشبكة</span> أثناء حفظ فاتورة —
                  الانقطاع أثناء الكتابة على مجلد شبكة قد يتلف الملف.
                </li>
                <li>يجب أن يبقى الجهاز المُضيف للمجلد <span className="font-bold">شغّالاً</span> طوال العمل.</li>
                <li>خذ <span className="font-bold">نسخة احتياطية يومية</span> — هذه أهم من أي إعداد آخر.</li>
              </ul>
              <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800">
                يضبط البرنامج نفسه تلقائياً عند اكتشاف مسار شبكة: يستخدم نمط حفظ آمن
                على الشبكة، ويطيل مهلة الانتظار حتى ٣٠ ثانية بدل الفشل الفوري.
              </div>
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
                <strong>الطريقة:</strong> 1) أنشئ مجلد مشترك على الجهاز الرئيسي 2) أنشئ قاعدة بيانات جديدة فيه 3) على الأجهزة الأخرى، اختر نفس الملف من الشبكة
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">مسار قاعدة البيانات الحالي</label>
                <div className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700/50 text-sm text-slate-600 dark:text-slate-300 break-all">
                  {dbInfo?.dbPath || '—'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">مسار جديد لقاعدة البيانات</label>
                  <div className="flex gap-2">
                    <Input value={networkPath} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNetworkPath(e.target.value)} placeholder="\\server\share\mobile_shop.db" />
                    <Button variant="secondary" onClick={handleBrowsePath} icon={<FolderOpen size={16} />}>تصفح</Button>
                  </div>
                </div>
              </div>

              <Button onClick={handleChangePath} icon={<Network size={16} />}>تغيير المسار</Button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">إنشاء قاعدة بيانات مشتركة جديدة</h3>
            <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-3">أنشئ نسخة من قاعدة البيانات الحالية في مجلد شبكي مشترك</p>
            <div className="flex gap-2 items-end">
              <Input label="مجلد الشبكة" value={networkPath} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNetworkPath(e.target.value)} placeholder="\\server\shared_folder" />
              <Button variant="secondary" onClick={handleBrowseFolder} icon={<FolderOpen size={16} />}>تصفح</Button>
              <Button onClick={handleCreateNetwork}>إنشاء</Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== CLOUD ===== */}
      {tab === 'cloud' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <Cloud size={20} className="text-purple-600" />
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">النسخ السحابي</h2>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-3">
              ارفع نسخة احتياطية من قاعدة البيانات إلى خدمة سحابية. يدعم Supabase، WebDAV، أو أي خادم مخصص.
            </p>

            {/* This is a ONE-WAY upload, not synchronisation. Saying so plainly
                because assuming otherwise loses data: an owner who believes two
                machines are kept in step will work on both, and the next upload
                silently overwrites whichever one uploaded last. */}
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-4 text-xs text-amber-800 dark:text-amber-300">
              <div className="font-bold mb-1">⚠️ هذه نسخة احتياطية باتجاه واحد — وليست مزامنة</div>
              الرفع ينسخ قاعدتك إلى السحابة فقط. <span className="font-bold">لا يوجد تنزيل ولا دمج</span>،
              ولا تتم مزامنة جهازين معاً.
              <div className="mt-1">
                لو عملت على جهازين، فكل جهاز له بياناته المنفصلة، وآخر رفع
                <span className="font-bold"> يستبدل </span> ما قبله. للعمل من أكثر من جهاز
                استخدم <span className="font-bold">قاعدة بيانات على مجلد شبكة</span> من تبويب «الشبكة».
              </div>
            </div>

            <div className="space-y-4">
              <Select label="نوع الخدمة السحابية" value={cloudType} onChange={(e) => setCloudType(e.target.value)}>
                <option value="supabase">Supabase</option>
                <option value="webdav">WebDAV</option>
                <option value="custom">خادم مخصص (Custom URL)</option>
                <option value="local_network">مسار شبكي محلي</option>
              </Select>

              {cloudType === 'local_network' ? (
                <div>
                  <Input label="مسار الشبكة" value={cloudUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCloudUrl(e.target.value)} placeholder="\\server\backup_folder" />
                </div>
              ) : (
                <>
                  <Input label="رابط الخادم" value={cloudUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCloudUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
                  {/*
                    The box shows a MASK, never the stored key — the main
                    process no longer sends it out. Leaving the mask alone
                    keeps the saved credential; typing over it replaces it.
                  */}
                  <Input
                    label="مفتاح API (API Key)"
                    type="password"
                    value={cloudApiKey}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCloudApiKey(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5..."
                    hint={cloudSettings.hasCloudApiKey
                      ? 'مفتاح محفوظ بالفعل — اتركه كما هو للإبقاء عليه، أو اكتب مفتاحاً جديداً لاستبداله'
                      : 'لا يوجد مفتاح محفوظ'}
                  />
                </>
              )}

              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" onClick={handleSaveCloud} icon={<CheckCircle size={16} />}>حفظ الإعدادات</Button>
                <Button variant="secondary" onClick={handleTestConnection} loading={testing} icon={<Wifi size={16} />}>اختبار الاتصال</Button>
                <Button onClick={handleUploadCloud} loading={uploading} icon={<Upload size={16} />}>رفع نسخة للسحابة</Button>
              </div>

              {testResult && (
                <div className={`rounded-lg p-3 flex items-center gap-2 ${testResult.success ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}`}>
                  {testResult.success ? <CheckCircle size={18} /> : <XCircle size={18} />}
                  <span className="text-sm">{testResult.message}</span>
                </div>
              )}

              {cloudSettings.cloud_url && (
                <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">الإعدادات المحفوظة</div>
                  <div className="text-sm text-slate-600 dark:text-slate-300">
                    النوع: {cloudSettings.cloud_type || '—'} | الرابط: {cloudSettings.cloud_url || '—'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Sync info */}
          <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw size={18} className="text-purple-600" />
              <h3 className="text-sm font-semibold text-purple-800 dark:text-purple-300">وضع المزامنة المحلي + السحابي</h3>
            </div>
            <p className="text-sm text-purple-700 dark:text-purple-400">
              النظام يعمل محلياً بالكامل. عند تفعيل النسخ السحابي، يتم رفع البيانات يدوياً عبر زر "رفع نسخة للسحابة".
              يمكن تشغيل عدة أجهزة محلياً، كل جهاز بقاعدة بيانات محلية، ثم دمج البيانات لاحقاً.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
