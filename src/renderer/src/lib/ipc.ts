/**
 * Contract helpers for values that arrive from the main process.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every screen in this application fills its state directly from
 * `window.api.invoke(...)`, and the JSX underneath then reads that state as if
 * the call had succeeded. Two things break that assumption, and both are
 * ordinary events rather than exotic ones:
 *
 *   1. The IPC permission guard answers a refused channel with
 *      `{ success: false, message, code }` instead of the payload. That object
 *      is *truthy*, so `{data && <Table rows={data.rows} />}` sails straight
 *      past its own guard and hands `undefined` to the table.
 *
 *   2. A screen that keeps one `data` state for several different reports
 *      still holds the PREVIOUS report's payload for the render that happens
 *      immediately after the tab is clicked — `useEffect` only refetches
 *      afterwards. The shapes differ, so a field that exists in one payload is
 *      missing in the other.
 *
 * In a React renderer an exception thrown during render is not a cosmetic
 * problem: with no error boundary anywhere in the tree, React unmounts the
 * entire application and the shop is left with a blank window. These helpers
 * make the two cases above explicit and cheap to check at the call site.
 */

/** The shape the IPC guard and the handlers use to report a refusal. */
export interface FailureReply {
  success: false;
  message?: string;
  code?: string;
}

/**
 * True when `reply` is a handler/guard failure rather than a payload.
 *
 * Deliberately narrow: only an object carrying `success === false` counts. A
 * handler that legitimately returns `{ success: true, ... }`, a bare array, a
 * number, or a payload with no `success` field at all is NOT a failure, and
 * must not be treated as one — several handlers (`reports:*`, `maintenance:get`)
 * return their data with no envelope whatsoever.
 */
export function isFailure(reply: unknown): reply is FailureReply {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    (reply as { success?: unknown }).success === false
  );
}

/**
 * The Arabic message to show the user for a failed reply.
 *
 * Falls back to a generic sentence, because a blank toast tells the shop owner
 * nothing and an English stack trace tells them less.
 */
export function failureMessage(reply: unknown, fallback = 'تعذر تنفيذ العملية'): string {
  if (isFailure(reply) && typeof reply.message === 'string' && reply.message.trim()) {
    return reply.message;
  }
  return fallback;
}

/**
 * The payload if the call succeeded, otherwise `null`.
 *
 * Storing `null` rather than the failure object is what lets the existing
 * `{data && ...}` guards in the JSX do the job they were written to do.
 */
export function payloadOrNull<T>(reply: T): T | null {
  return isFailure(reply) ? null : reply;
}

/**
 * `value` when it really is an array, otherwise an empty array.
 *
 * Used wherever a list is read out of a payload whose shape is not guaranteed
 * — a refused call, a stale payload from another tab, or a handler that simply
 * does not return that field. Returning `[]` renders the table's own
 * "no data" row, which is the truthful thing to show and cannot throw.
 */
export function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
