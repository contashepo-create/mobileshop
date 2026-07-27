import { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle, Info, BellRing, WifiOff, CalendarClock, X, CheckCircle2,
} from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * Modal notices shown to the shop owner.
 *
 * WHY A MODAL AND NOT A TOAST
 * ---------------------------
 * Developer messages and renewal warnings are things the owner must actually
 * read: "your subscription stops in 3 days" is useless if it fades away after
 * four seconds while they are serving a customer. Anything with a consequence
 * gets a dialog that has to be dismissed deliberately. The bell menu in the
 * header stays for routine business alerts.
 *
 * QUEUEING
 * --------
 * Several things can be pending at once (two developer messages plus a renewal
 * warning). They are shown one at a time, in urgency order, so the screen is
 * never covered by a stack of overlapping dialogs.
 *
 * NON-BLOCKING BY CONSTRUCTION
 * ----------------------------
 * Every failure path here is a no-op: if the IPC call throws, or the remote
 * feature is not configured, the queue is simply empty and the component
 * renders nothing. It can never stop the user reaching their data.
 */

interface RemoteMessage {
  MessageID: number;
  Title: string;
  Body: string;
  Severity: string;
  CreatedAt: string;
}

type QueueItem =
  | { kind: 'message'; id: number; title: string; body: string; severity: string }
  | { kind: 'expiry'; daysLeft: number; expiry: string }
  | { kind: 'offline'; daysOffline: number; reminderDays: number };

/** Re-checked periodically so a message that arrives mid-session still shows. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function NoticeCenter() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await window.api.invoke('remote:pendingNotices');
      if (!res) return;

      const items: QueueItem[] = [];

      // Urgency order: a deadline first, then things to read, then the
      // "please connect" nudge, which is the least time-critical of the three.
      if (res.expiry) {
        items.push({
          kind: 'expiry',
          daysLeft: res.expiry.daysLeft,
          expiry: res.expiry.expiry,
        });
      }
      for (const m of (res.messages || []) as RemoteMessage[]) {
        items.push({
          kind: 'message',
          id: m.MessageID,
          title: m.Title || 'رسالة من المطور',
          body: m.Body || '',
          severity: m.Severity || 'info',
        });
      }
      if (res.offline) {
        items.push({
          kind: 'offline',
          daysOffline: res.offline.daysOffline,
          reminderDays: res.offline.reminderDays,
        });
      }

      // Replace rather than append: the server is the source of truth and
      // anything already acknowledged is filtered out on that side.
      setQueue(items);
    } catch {
      /* remote feature unconfigured or main process busy — show nothing */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load]);

  const current = queue[0];
  if (!current) return null;

  const dismiss = async () => {
    setBusy(true);
    try {
      if (current.kind === 'message') {
        await window.api.invoke('remote:markRead', current.id);
      } else {
        await window.api.invoke('remote:dismissNotice', current.kind);
      }
    } catch {
      /* dismissing must always work locally even if the write fails */
    }
    setQueue(q => q.slice(1));
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-2xl overflow-hidden animate-slide-in">
        {current.kind === 'expiry' && <ExpiryBody notice={current} />}
        {current.kind === 'offline' && <OfflineBody notice={current} />}
        {current.kind === 'message' && <MessageBody notice={current} />}

        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {queue.length > 1 ? `${queue.length - 1} إشعار آخر بانتظارك` : ''}
          </span>
          <Button onClick={dismiss} loading={busy} icon={<CheckCircle2 size={16} />}>
            {current.kind === 'message' ? 'تم، قرأت الرسالة' : 'حسناً، فهمت'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bodies

function ExpiryBody({ notice }: { notice: Extract<QueueItem, { kind: 'expiry' }> }) {
  // Under a week is treated as red: at that point the owner needs to act now,
  // not "soon".
  const critical = notice.daysLeft <= 7;
  const tone = critical
    ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
    : 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300';

  return (
    <>
      <div className={`px-6 py-5 ${tone} flex items-start gap-3`}>
        <CalendarClock size={26} className="shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-bold">
            {notice.daysLeft <= 0
              ? 'انتهى اشتراكك'
              : `اشتراكك ينتهي خلال ${notice.daysLeft} يوم`}
          </h2>
          <p className="text-sm mt-1 opacity-90">تاريخ الانتهاء: {notice.expiry}</p>
        </div>
      </div>
      <div className="px-6 py-5 space-y-3 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
        <p>
          لتجديد الاشتراك تواصل مع المطور واطلب كود تفعيل جديد، ثم أدخله من
          صفحة <b>الإعدادات ← الترخيص</b>.
        </p>
        <div className="bg-slate-100 dark:bg-slate-900/50 rounded-lg p-3 text-xs">
          <b>ملاحظة مهمة:</b> كود التفعيل يعمل بدون إنترنت — يكفي أن تكتبه في
          البرنامج ويتم التفعيل فوراً.
        </div>
      </div>
    </>
  );
}

function OfflineBody({ notice }: { notice: Extract<QueueItem, { kind: 'offline' }> }) {
  return (
    <>
      <div className="px-6 py-5 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 flex items-start gap-3">
        <WifiOff size={26} className="shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-bold">يُفضّل الاتصال بالإنترنت</h2>
          <p className="text-sm mt-1 opacity-90">
            مرّ {notice.daysOffline} يوم بدون اتصال بخادم المطور
          </p>
        </div>
      </div>
      <div className="px-6 py-5 space-y-3 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
        <p>
          برنامجك يعمل بشكل طبيعي تماماً بدون إنترنت، ولن يتوقف. لكن الاتصال
          لدقيقة واحدة يجعلك تستقبل:
        </p>
        <ul className="space-y-1.5 pr-4">
          <li>• رسائل وتنبيهات المطور</li>
          <li>• تحديث بيانات التواصل والدعم</li>
          <li>• الإعلان عن الإصدارات الجديدة</li>
        </ul>
        <div className="bg-slate-100 dark:bg-slate-900/50 rounded-lg p-3 text-xs">
          افتح الإنترنت ثم اذهب إلى <b>حول البرنامج</b> واضغط
          «تحديث الآن» — أو اتركه متصلاً وسيتم ذلك تلقائياً.
        </div>
      </div>
    </>
  );
}

function MessageBody({ notice }: { notice: Extract<QueueItem, { kind: 'message' }> }) {
  const styles: Record<string, { tone: string; Icon: typeof Info }> = {
    urgent: {
      tone: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
      Icon: AlertTriangle,
    },
    warning: {
      tone: 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
      Icon: BellRing,
    },
    info: {
      tone: 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300',
      Icon: Info,
    },
  };
  const { tone, Icon } = styles[notice.severity] || styles.info;

  return (
    <>
      <div className={`px-6 py-5 ${tone} flex items-start gap-3`}>
        <Icon size={26} className="shrink-0 mt-0.5" />
        <h2 className="text-lg font-bold">{notice.title}</h2>
      </div>
      <div className="px-6 py-5 text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
        {notice.body}
      </div>
    </>
  );
}
