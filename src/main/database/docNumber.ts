import type Database from 'better-sqlite3';

/**
 * Collision-free document numbers.
 *
 * The old approach was `COUNT(*) WHERE Date = today` + 1. That breaks in two
 * ways that both lose real transactions:
 *   1. after deleting a document the counter goes backwards and regenerates an
 *      existing number -> UNIQUE constraint violation;
 *   2. two clients on a shared network database generate the same number.
 *
 * We now keep a dedicated monotonic counter per (table, date) in
 * `document_sequences`, incremented atomically. The counter never decreases, so
 * deletions cannot cause reuse. As a safety net we also skip any value that is
 * already present in the target table (covers databases migrated from the old
 * scheme, where high numbers may already exist).
 */
export function nextDocNumber(
  db: Database.Database,
  table: string,
  column: string,
  prefix: string,
  dateStr: string,
): string {
  const key = `${table}:${dateStr}`;
  const compact = dateStr.replace(/-/g, '');

  // Atomic increment: INSERT the row at 1, or bump the existing one.
  db.prepare(`
    INSERT INTO document_sequences (SeqKey, LastValue) VALUES (?, 1)
    ON CONFLICT(SeqKey) DO UPDATE SET LastValue = LastValue + 1
  `).run(key);

  let seq = (db.prepare('SELECT LastValue FROM document_sequences WHERE SeqKey = ?').get(key) as any).LastValue as number;

  // Safety net for pre-existing rows created by the old COUNT(*) scheme.
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`);
  let candidate = `${prefix}-${compact}-${String(seq).padStart(4, '0')}`;
  let guard = 0;
  while (exists.get(candidate) && guard++ < 10000) {
    seq++;
    candidate = `${prefix}-${compact}-${String(seq).padStart(4, '0')}`;
  }
  if (guard > 0) {
    db.prepare('UPDATE document_sequences SET LastValue = ? WHERE SeqKey = ?').run(seq, key);
  }

  return candidate;
}
