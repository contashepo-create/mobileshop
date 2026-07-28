/**
 * `database/connection` stand-in: returns the harness's in-memory database.
 *
 * Redirected by the loader hook so the handler modules import it without any
 * change to their own source.
 */
export function getDb() {
  if (!globalThis.__TEST_DB__) throw new Error('harness: database not built yet');
  return globalThis.__TEST_DB__;
}
export function getDbPath() { return ':memory:'; }
export function closeDb() {}
