/**
 * HTML escaping for every document this application builds as a string.
 *
 * WHY THIS EXISTS
 * ---------------
 * The application prints from two completely separate places:
 *
 *   1. `src/main/ipc/print.handlers.ts` — invoices and vouchers, built in the
 *      main process and loaded into a `data:` URL. It has always escaped.
 *
 *   2. Four renderer screens — the customer, supplier and employee statements
 *      and the assets register — which build their own HTML and hand it to
 *      `window.open(...).document.write(...)`. These escaped NOTHING.
 *
 * The second group interpolated names, addresses and free-text descriptions
 * straight into markup:
 *
 *     <div class="value">${customer.Name}</div>
 *     <td>${op.Description || ''}</td>
 *
 * `customers:create` stores whatever it is given — there is no validation on
 * the name — so a customer saved as
 *
 *     <img src=x onerror="...">
 *
 * becomes live markup the moment anyone prints that customer's statement.
 * That is stored XSS, and the window it runs in is not a harmless one:
 * `window.open` children inherit the opener's `webPreferences`, which on the
 * main window means the preload bundle is attached. `window.api.invoke` is
 * therefore reachable from injected script, and that is the whole IPC surface
 * — 238 channels, including the ones that read settings and write records.
 *
 * The `data:` URL used by the main-process printer does not inherit the CSP
 * from index.html either, so neither printing path is protected by the policy.
 * Escaping at the point of interpolation is the only real defence.
 *
 * WHY IT LIVES IN `shared/`
 * -------------------------
 * There were already two copies of this logic in the codebase — one in
 * print.handlers.ts and one, missing entirely, in the statement pages. A
 * single implementation that both sides import cannot drift, and cannot be
 * "fixed" in one place while the other stays vulnerable.
 */

/**
 * Renders any value inert as HTML text.
 *
 * The five characters below are the complete set required to neutralise markup
 * in both element content and quoted attribute values:
 *
 *   &  first, or it would double-escape the entities produced by the others
 *   <  >  open and close tags
 *   "  '  break out of either attribute-quoting style
 *
 * `null` and `undefined` become an empty string rather than the words "null"
 * and "undefined", because these values land in printed documents a customer
 * reads.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a value as a fixed-decimal number, emitting no user input at all.
 *
 * Money and quantities on a printed document must never be a passthrough for
 * a stored string. Anything that is not a finite number prints as 0.00 rather
 * than leaking the original text into the page.
 */
export function safeNumber(value: unknown, digits = 2): string {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n.toFixed(digits) : (0).toFixed(digits);
}
