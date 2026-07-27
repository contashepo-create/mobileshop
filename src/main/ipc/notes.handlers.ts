import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

export function registerNotesHandlers() {
  // Get notes for an operation
  ipcMain.handle('notes:list', async (_event, { operationType, operationId }: { operationType: string; operationId: number }) => {
    const db = getDb();
    const notes = db.prepare(`
      SELECT n.*, u.Username
      FROM operation_notes n
      JOIN users u ON n.UserID = u.UserID
      WHERE n.OperationType = ? AND n.OperationID = ?
      ORDER BY n.CreatedAt ASC
    `).all(operationType, operationId);
    return notes;
  });

  // Add a note to an operation
  ipcMain.handle('notes:add', async (_event, { operationType, operationId, content, userId }: {
    operationType: string;
    operationId: number;
    content: string;
    userId: number;
  }) => {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO operation_notes (OperationType, OperationID, Content, UserID)
      VALUES (?, ?, ?, ?)
    `).run(operationType, operationId, content, userId);

    const note = db.prepare(`
      SELECT n.*, u.Username
      FROM operation_notes n
      JOIN users u ON n.UserID = u.UserID
      WHERE n.NoteID = ?
    `).get(result.lastInsertRowid);

    return note;
  });
}
