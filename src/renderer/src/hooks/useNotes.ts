import { useState, useCallback, useEffect } from 'react';
import type { NoteItem } from '../components/NotesTimeline';

interface UseNotesOptions {
  operationType: string;
  operationId: number | null;
  userId: number;
}

export function useNotes({ operationType, operationId, userId }: UseNotesOptions) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchNotes = useCallback(async () => {
    if (!operationId) return;
    setLoading(true);
    try {
      const result = await window.api.invoke('notes:list', { operationType, operationId });
      setNotes(result as NoteItem[]);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [operationType, operationId]);

  const addNote = useCallback(async (content: string) => {
    if (!operationId) return;
    const newNote = await window.api.invoke('notes:add', {
      operationType,
      operationId,
      content,
      userId,
    });
    setNotes((prev) => [...prev, newNote as NoteItem]);
  }, [operationType, operationId, userId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  return { notes, loading, addNote, fetchNotes };
}
