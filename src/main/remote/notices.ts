/**
 * Decides which dialogs the customer should be shown, and when.
 *
 * DESIGN RULE — the application must never be held hostage by the network.
 * ------------------------------------------------------------------------
 * The licence decision is made entirely from local files (see
 * `license.handlers.ts`): no request is issued, and no screen waits for one.
 * A shop with no internet at all works exactly like a shop with fibre.
 *
 * The check-in exists only to *deliver* things — renewal reminders, developer
 * messages, updated contact details. An install that never reaches the server
 * simply keeps using the last values it received. The only cost of staying
 * offline is that those deliveries stop, and the owner would not find out until
 * something they expected never arrived.
 *
 * So the customer is reminded — at most once every 20 days — that connecting
 * briefly would refresh everything. The reminder is a dismissible dialog. It
 * never disables a feature, never blocks a screen, and disappears the moment a
 * check-in succeeds.
 *
 * Every function here is PURE: no database, no clock, no Electron. That keeps
 * the timing rules testable without booting the app, which is why the tests can
 * assert the exact day a dialog appears.
 */

/** How long a customer may stay offline before being reminded. */
export const OFFLINE_REMINDER_DAYS = 20;

/** How long the reminder stays quiet after the customer dismisses it. */
export const OFFLINE_SNOOZE_DAYS = 20;

/** Start warning this many days before the subscription stops. */
export const EXPIRY_WARNING_DAYS = 14;

/** The expiry warning is a daily nudge, not a per-launch one. */
export const EXPIRY_SNOOZE_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/**
 * Parses a stored timestamp.
 *
 * Two formats coexist in `remote_state`: ISO strings written by JavaScript
 * (`2026-07-28T10:00:00.000Z`) and SQLite's `datetime('now')` output
 * (`2026-07-28 10:00:00`, always UTC but with no zone marker). Feeding the
 * second one to `new Date()` is parsed as LOCAL time by some engines, which
 * would shift the result by the timezone offset and could make a reminder fire
 * a day early or late. Normalising here removes that whole class of bug.
 */
export function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  // 'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SSZ'
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole days between two instants, floored, never negative.
 *
 * A negative result means the clock moved backwards (or a file was copied from
 * a machine in the future). Clamping to 0 makes that look like "just now"
 * rather than "overdue by minus three days", which would otherwise satisfy
 * every `>=` comparison below and fire all the dialogs at once.
 */
export function daysBetween(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

// ---------------------------------------------------------------- offline

export interface OfflineNoticeInput {
  now: Date;
  /** Last successful check-in, ISO. Null when it has never happened. */
  lastSync: string | null;
  /** When this install first created its remote tables — the fallback anchor. */
  installedAt: string | null;
  /** When the reminder was last dismissed. */
  lastShown: string | null;
  /** False when the feature is switched off or unconfigured. */
  remoteEnabled: boolean;
}

export interface OfflineNoticeResult {
  show: boolean;
  daysOffline: number;
  /** Why the decision went the way it did — surfaced in diagnostics and tests. */
  reason: 'disabled' | 'no-anchor' | 'recent' | 'snoozed' | 'due';
}

export function evaluateOfflineNotice(input: OfflineNoticeInput): OfflineNoticeResult {
  // The developer never configured a server, or the customer switched telemetry
  // off. Nagging someone to connect to something that does not exist — or that
  // they deliberately opted out of — would be pure noise.
  if (!input.remoteEnabled) return { show: false, daysOffline: 0, reason: 'disabled' };

  // Prefer the last successful sync; fall back to the install date so a copy
  // that has NEVER reached the server is still reminded after 20 days rather
  // than staying silent forever.
  const anchor = parseStamp(input.lastSync) ?? parseStamp(input.installedAt);
  if (!anchor) return { show: false, daysOffline: 0, reason: 'no-anchor' };

  const daysOffline = daysBetween(anchor, input.now);
  if (daysOffline < OFFLINE_REMINDER_DAYS) {
    return { show: false, daysOffline, reason: 'recent' };
  }

  const shown = parseStamp(input.lastShown);
  if (shown && daysBetween(shown, input.now) < OFFLINE_SNOOZE_DAYS) {
    return { show: false, daysOffline, reason: 'snoozed' };
  }

  return { show: true, daysOffline, reason: 'due' };
}

// ---------------------------------------------------------------- expiry

export interface ExpiryNoticeInput {
  now: Date;
  /** Licence status as the local check reported it. */
  status: string | null | undefined;
  /** 'YYYY-MM-DD', or null for a perpetual licence. */
  expiry: string | null | undefined;
  lastShown: string | null;
}

export interface ExpiryNoticeResult {
  show: boolean;
  daysLeft: number;
  expiry: string | null;
  reason: 'not-applicable' | 'plenty' | 'snoozed' | 'due';
}

/**
 * Warns before the subscription stops.
 *
 * This matters most for a customer who is OFFLINE: their licence still expires
 * on schedule, because expiry is computed locally and does not need a server.
 * Without a warning, the first sign would be a locked application in the middle
 * of a working day. With it, they have two weeks to ask for a renewal code —
 * which they can type in without any internet connection, since the code
 * carries its own signed expiry.
 */
export function evaluateExpiryNotice(input: ExpiryNoticeInput): ExpiryNoticeResult {
  // Perpetual licences and non-active states (trial screens, activation page)
  // are handled elsewhere; there is nothing to count down to.
  if (input.status !== 'active' || !input.expiry) {
    return { show: false, daysLeft: 0, expiry: null, reason: 'not-applicable' };
  }

  const end = parseStamp(`${input.expiry}T00:00:00Z`);
  if (!end) return { show: false, daysLeft: 0, expiry: null, reason: 'not-applicable' };

  const daysLeft = Math.ceil((end.getTime() - input.now.getTime()) / MS_PER_DAY);
  if (daysLeft > EXPIRY_WARNING_DAYS) {
    return { show: false, daysLeft, expiry: input.expiry, reason: 'plenty' };
  }

  const shown = parseStamp(input.lastShown);
  if (shown && daysBetween(shown, input.now) < EXPIRY_SNOOZE_DAYS) {
    return { show: false, daysLeft, expiry: input.expiry, reason: 'snoozed' };
  }

  return { show: true, daysLeft, expiry: input.expiry, reason: 'due' };
}
