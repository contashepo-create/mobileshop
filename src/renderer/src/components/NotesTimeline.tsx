import { useState, useCallback } from 'react';
import { Copy, Check, MessageSquare, User } from 'lucide-react';
import { Button } from './ui/Button';
import { Textarea } from './ui/Input';

export interface NoteItem {
  NoteID: number;
  Content: string;
  UserID: number;
  Username: string;
  CreatedAt: string;
}

interface NotesTimelineProps {
  operationType: string;
  operationId: number;
  notes: NoteItem[];
  onAddNote: (content: string) => Promise<void>;
  loading?: boolean;
}

export function NotesTimeline({ operationType, operationId, notes, onAddNote, loading }: NotesTimelineProps) {
  const [newNote, setNewNote] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleAdd = useCallback(async () => {
    if (!newNote.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await onAddNote(newNote.trim());
      setNewNote('');
    } catch (err) {
      setError('فشل إضافة الملاحظة');
    } finally {
      setSubmitting(false);
    }
  }, [newNote, onAddNote]);

  const handleCopy = (note: NoteItem) => {
    const text = `${note.Content}\n— ${note.Username} (${note.CreatedAt})`;
    navigator.clipboard.writeText(text);
    setCopiedId(note.NoteID);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare size={18} className="text-primary-600" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">الملاحظات والتحديثات</h3>
        {notes.length > 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">({notes.length})</span>
        )}
      </div>

      {/* Notes list */}
      <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
        {notes.length === 0 && !loading && (
          <p className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">لا توجد ملاحظات بعد</p>
        )}
        {loading && (
          <p className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">جاري التحميل...</p>
        )}
        {notes.map((note) => (
          <div
            key={note.NoteID}
            className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700 group"
          >
            {/* Note header: user + time */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                  <User size={12} className="text-primary-600 dark:text-primary-400" />
                </div>
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  {note.Username}
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{formatTime(note.CreatedAt)}</span>
            </div>

            {/* Note content */}
            <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
              {note.Content}
            </p>

            {/* Copy button */}
            <div className="mt-2 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleCopy(note)}
                className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-primary-600 transition-colors"
              >
                {copiedId === note.NoteID ? (
                  <>
                    <Check size={12} /> تم النسخ
                  </>
                ) : (
                  <>
                    <Copy size={12} /> نسخ
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add note */}
      <div className="space-y-2">
        <Textarea
          value={newNote}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewNote(e.target.value)}
          placeholder="اكتب ملاحظة أو تحديث جديد..."
          rows={2}
          className="bg-white dark:bg-slate-800"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleAdd}
            loading={submitting}
            disabled={!newNote.trim()}
          >
            إضافة ملاحظة
          </Button>
        </div>
      </div>
    </div>
  );
}
