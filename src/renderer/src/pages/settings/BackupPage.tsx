import { useState, useEffect } from 'react';
import { Download, Upload, Database, HardDrive, Send, CheckCircle, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useToastStore } from '../../components/ui/Toast';

export function BackupPage() {
  const { showToast } = useToastStore();
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Telegram off-site backup.
  // `tgToken` holds only what the owner types now: the stored token is never
  // sent back to the renderer, so there is nothing to pre-fill it with.
  const [tg, setTg] = useState<any>({ hasToken: false, chatId: '', enabled: false, tokenHint: '' });
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgBusy, setTgBusy] = useState(false);

  const fetchInfo = async () => {
    const [info, tgInfo] = await Promise.all([
      window.api.invoke('backup:info'),
      window.api.invoke('telegram:getSettings'),
    ]);
    setDbInfo(info);
    if (tgInfo) {
      setTg(tgInfo);
      setTgChatId(tgInfo.chatId || '');
    }
  };

  useEffect(() => { fetchInfo(); }, []);

  const handleTgSave = async () => {
    setTgBusy(true);
    const res = await window.api.invoke('telegram:saveSettings', {
      botToken: tgToken, chatId: tgChatId, enabled: tg.enabled,
    });
    setTgBusy(false);
    if (res?.success) {
      showToast('success', res.message);
      setTgToken('');        // never keep a credential in renderer state
      fetchInfo();
    } else {
      showToast('error', res?.message || 'تعذّر الحفظ');
    }
  };

  const handleTgTest = async () => {
    setTgBusy(true);
    const res = await window.api.invoke('telegram:test', { botToken: tgToken, chatId: tgChatId });
    setTgBusy(false);
    showToast(res?.success ? 'success' : 'error', res?.message || '');
  };

  const handleTgSend = async () => {
    setTgBusy(true);
    showToast('info', 'جاري رفع النسخة... قد يستغرق دقائق حسب سرعة الإنترنت');
    const res = await window.api.invoke('telegram:sendBackup');
    setTgBusy(false);
    showToast(res?.success ? 'success' : 'error', res?.message || '');
    if (res?.success) fetchInfo();
  };

  const handleTgClear = async () => {
    if (!confirm('سيتم حذف رمز البوت ومعرّف المحادثة. هل تريد المتابعة؟')) return;
    setTgBusy(true);
    const res = await window.api.invoke('telegram:clearSettings');
    setTgBusy(false);
    showToast(res?.success ? 'success' : 'error', res?.message || '');
    setTgToken(''); setTgChatId('');
    fetchInfo();
  };

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

      {/* Telegram off-site backup */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-lg bg-sky-100 dark:bg-sky-900/30">
            <Send size={24} className="text-sky-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-white">
              نسخة احتياطية على تليجرام
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              نسخة خارج الجهاز - تنجو لو تعطّل القرص الصلب أو سُرق الكمبيوتر
            </p>
          </div>
          {tg.hasToken && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle size={14} /> مُفعّل
            </span>
          )}
        </div>

        <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-4 text-xs text-amber-700 dark:text-amber-300">
          ⚠️ يتم رفع <span className="font-bold">قاعدة البيانات كاملة</span> (كل العملاء والأسعار
          والأرصدة) إلى بوت تليجرام الخاص بك أنت. استخدم بوتاً خاصاً بك ولا تشارك رمزه مع أحد.
          <div className="mt-1">الحد الأقصى لتليجرام: ٥٠ ميجابايت.</div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              رمز البوت {tg.hasToken && <span className="text-green-600">(محفوظ: {tg.tokenHint})</span>}
            </label>
            <input
              type="password" dir="ltr" value={tgToken} onChange={(e) => setTgToken(e.target.value)}
              placeholder={tg.hasToken ? 'اتركه فارغاً للإبقاء على المحفوظ' : '123456789:AA...'}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              معرّف المحادثة (Chat ID)
            </label>
            <input
              type="text" dir="ltr" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)}
              placeholder="123456789"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white text-sm"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 mb-4 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox" checked={Boolean(tg.enabled)}
            onChange={(e) => setTg({ ...tg, enabled: e.target.checked })}
            className="rounded border-slate-300"
          />
          إرسال النسخة اليومية تلقائياً إلى تليجرام
        </label>

        <div className="flex flex-wrap gap-2">
          <Button onClick={handleTgSave} loading={tgBusy} variant="primary">حفظ الإعدادات</Button>
          <Button onClick={handleTgTest} loading={tgBusy} variant="secondary">اختبار الاتصال</Button>
          <Button
            onClick={handleTgSend} loading={tgBusy} variant="success"
            icon={<Send size={16} />} disabled={!tg.hasToken}
          >
            إرسال نسخة الآن
          </Button>
          {tg.hasToken && (
            <Button onClick={handleTgClear} loading={tgBusy} variant="danger" icon={<Trash2 size={16} />}>
              حذف الإعدادات
            </Button>
          )}
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
