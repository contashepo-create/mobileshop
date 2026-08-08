import { useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, X } from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * A slim, dismissible banner shown on every screen once an update has been
 * downloaded in the background. The owner is mid-sale, so this only appears
 * when the new build is already on disk — installing is then one click.
 */
export function UpdateReadyBanner() {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const onStatus = (s: any) => {
      setReady(s?.state === 'downloaded');
      setDismissed(false);
    };
    window.api.on('updater:status', onStatus);
    void window.api.invoke('updater:getStatus').then((s: any) => {
      if (s?.state === 'downloaded') setReady(true);
    }).catch(() => {});
    return () => {};
  }, []);

  if (!ready || dismissed) return null;

  const install = async () => {
    setRestarting(true);
    await window.api.invoke('updater:updateNow').catch(() => setRestarting(false));
  };

  return (
    <div className="bg-green-600 text-white px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck size={16} />
        تم تنزيل تحديث جديد — أعد تشغيل البرنامج لتطبيقه والاستفادة من التحسينات.
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="secondary" onClick={install} loading={restarting}
          className="!bg-white !text-green-700 hover:!bg-green-50"
          icon={<RefreshCw size={13} />}>
          إعادة التشغيل الآن
        </Button>
        <button onClick={() => setDismissed(true)} aria-label="تجاهل"
          className="p-1 rounded hover:bg-white/20 transition-colors">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
