/**
 * The single authority for "what day is it in the shop".
 *
 * WHY THIS EXISTS
 * ---------------
 * Business dates were produced with `new Date().toISOString().split('T')[0]`,
 * which is the date in **UTC**, not in the shop's own timezone. Egypt runs at
 * UTC+2 in winter and UTC+3 in summer, so every sale, purchase, voucher and
 * maintenance ticket created between midnight and 02:00 (03:00 in summer) was
 * filed under the PREVIOUS day.
 *
 * For a phone shop that stays open late this is not a rounding detail:
 *   - the daily sales report misses the night's takings;
 *   - the cash drawer never reconciles against the report;
 *   - document numbers (SAL-YYYYMMDD-nnn) belong to yesterday's sequence;
 *   - a sale made after midnight on the 1st lands in the previous month, and
 *     on 1 January it lands in the previous FISCAL YEAR.
 *
 * The fix is to derive the date from the local calendar instead of the UTC
 * instant. `en-CA` is used because it formats as `YYYY-MM-DD`, which is exactly
 * the shape already stored in the database — so nothing downstream changes.
 *
 * DAYLIGHT SAVING (Egypt reinstated DST in 2023)
 * ----------------------------------------------
 * Nothing here needs a DST table. The operating system owns the timezone rules
 * and Node reads them from the IANA database, so the answers below follow
 * Egypt's clock automatically, including the April and October switches.
 *
 * A DST change never moves the epoch backwards — only the wall clock label
 * changes — which is why the licence checks below are written against absolute
 * time wherever a "has time gone backwards?" question is asked.
 */

/**
 * Today's date in the shop's own timezone, as `YYYY-MM-DD`.
 *
 * `en-CA` gives ISO-ordered output; the explicit `undefined` locale is avoided
 * so the result never depends on the user's Windows regional format (an Arabic
 * locale would otherwise return Arabic-Indic digits, e.g. ٢٠٢٦-٠٧-٢٨, which
 * would corrupt every date comparison in SQL).
 */
export function businessToday(now: Date = new Date()): string {
  return formatLocalDate(now);
}

/** Formats any instant as a local `YYYY-MM-DD`. */
export function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local timestamp as `YYYY-MM-DD HH:MM:SS`, matching SQLite's localtime form. */
export function formatLocalDateTime(d: Date = new Date()): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${formatLocalDate(d)} ${hh}:${mm}:${ss}`;
}

/** Local date `n` days before `now`, for "not seen in N days" style filters. */
export function localDateDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  // setDate handles month/year rollover, and because it works on local
  // components it stays correct across a DST boundary (unlike subtracting
  // 86_400_000 ms, which is an hour short on the day the clocks change).
  d.setDate(d.getDate() - days);
  return formatLocalDate(d);
}

/**
 * Whether a stored business date is impossibly far in the future.
 *
 * Used by the licence check instead of a bare `now < newest` comparison.
 * A small tolerance absorbs the cases that are NOT tampering:
 *   - a till in a shop whose PC clock is a few minutes fast;
 *   - a record created seconds before midnight and read seconds after;
 *   - a backup restored from a machine in a timezone one day ahead.
 */
export const FUTURE_DATE_TOLERANCE_DAYS = 2;

export function isImplausiblyFuture(
  storedDate: string,
  now: Date = new Date(),
  toleranceDays: number = FUTURE_DATE_TOLERANCE_DAYS,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(storedDate)) return false;
  const limit = new Date(now);
  limit.setDate(limit.getDate() + toleranceDays);
  return storedDate > formatLocalDate(limit);
}
