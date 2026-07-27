import { useState, useEffect } from 'react';
import { Download, Upload, Database, HardDrive } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useToastStore } from '../../components/ui/Toast';

export function BackupPage() {
  const { showToast } = useToastStore();
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchInfo = async () => {
    const info = await window.api.invoke('backup:info');
    setDbInfo(info);
  };

  useEffect(() => { fetchInfo(); }, []);

  const handleBackup = async () => {
    setLoading(true);
    const result = await window.api.invoke('backup:create');
    if (result.success) {
      showToast('success', `تم حفظ النسخة الاحتياطية في: ${result.path}`);
    } else if (result.message !== 'تم الإلغاء') {
      showToast('error', result.message);
    }
    setLoading(false);
  };

  const handleRestore = async () => {
    if (!confirm('تحذير: سيتم استبدال قاعدة البيانات الحالية بالنسخة الاحتياطية. تأكد من عمل نسخة احتياطية أولاً. هل تريد المتابعة؟')) {
      return;
    }
    setLoading(true);
    const result = await window.api.invoke('backup:restore');
    if (result.success) {
      showToast('success', result.message);
    } else if (result.message !== 'تم الإلغاء') {
      showToast('error', result.message);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white">النسخ الاحتياطي</h1>

      {/* DB Info */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-lg bg-blue-100 dark:bg-blue-900/30">
            <Database size={24} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-800 dark:text-white">معلومات قاعدة البيانات</h2>
            <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400">{dbInfo?.path || '—'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <HardDrive size={16} className="text-slate-500 dark:text-slate-400" />
          <span className="text-slate-500 dark:text-slate-500 dark:text-slate-400">حجم القاعدة:</span>
          <span className="font-bold text-slate-700 dark:text-slate-200">{dbInfo?.sizeFormatted || '—'}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Backup */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700 text-center">
          <div className="inline-flex p-4 rounded-full bg-green-100 dark:bg-green-900/30 mb-4">
            <Download size={28} className="text-green-600" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">إنشاء نسخة احتياطية</h3>
          <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-4">
            احفظ نسخة كاملة من قاعدة البيانات في ملف آمن
          </p>
          <Button onClick={handleBackup} loading={loading} icon={<Download size={16} />} className="w-full">
            حفظ نسخة احتياطية
          </Button>
        </div>

        {/* Restore */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700 text-center">
          <div className="inline-flex p-4 rounded-full bg-orange-100 dark:bg-orange-900/30 mb-4">
            <Upload size={28} className="text-orange-600" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">استعادة نسخة احتياطية</h3>
          <p className="text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 mb-4">
            استبدل قاعدة البيانات الحالية بنسخة سابقة
          </p>
          <Button onClick={handleRestore} variant="warning" loading={loading} icon={<Upload size={16} />} className="w-full">
            استعادة من نسخة
          </Button>
        </div>
      </div>

      {/* Warning */}
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4">
        <p className="text-sm text-yellow-700 dark:text-yellow-300">
          ⚠️ يُنصح بعمل نسخة احتياطية يومياً للحفاظ على بياناتك. بعد الاستعادة، يلزم إعادة تشغيل التطبيق.
        </p>
      </div>
    </div>
  );
}
