/**
 * Today's date in the shop's own timezone, as `YYYY-MM-DD`.
 *
 * Same contract as `businessToday()` in the main process (src/shared):
 * derived from the LOCAL calendar, never from UTC (`toISOString()` would
 * serve the wrong day between midnight and dawn in Egypt), and formatted
 * with Latin digits so SQLite compares strings correctly.
 */
export function localToday(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}