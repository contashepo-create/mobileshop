/**
 * The shop's letterhead for documents the RENDERER prints itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * Invoices are built in the main process (`print.handlers.ts`) and have always
 * carried the shop's logo, address, phone and tax number. The statements and
 * the assets register are built in the renderer and printed through
 * `window.open(...).document.write(...)`, and they carried NONE of it:
 *
 *   - no logo at all, on any of the four
 *   - supplier and employee statements read `window.__settings`, a global that
 *     is never assigned anywhere in the codebase, so the shop name printed as
 *     an EMPTY STRING; the assets register fell back to the generic
 *     "نظام المحمول" instead of the shop's own name
 *   - no tax number, which a statement handed to a customer or a supplier is
 *     expected to carry
 *
 * The logo was reachable the whole time — `logo_path` is in the settings map
 * every one of these screens can load. Three of them simply never loaded it.
 *
 * One builder, imported by all four, means a fix or an addition lands on every
 * printed document at once instead of on whichever screen someone remembered.
 */
import { escapeHtml as esc } from '../../../shared/escapeHtml';

/** The subset of settings a letterhead needs. */
export interface ShopIdentity {
  company_name?: string;
  logo_path?: string;
  address?: string;
  phone?: string;
  tax_number?: string;
  print_logo_height?: string;
}

/**
 * Only allow image sources that cannot execute.
 *
 * Mirrors `safeImageSrc` in print.handlers.ts. These documents are written
 * into a `window.open` child that inherits the opener's preload — script in
 * there reaches the whole IPC surface — so a `javascript:` or
 * `data:text/html` logo must never become an `<img src>`.
 */
export function safeLogoSrc(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s) || /^data:image\//i.test(s)) return esc(s);
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return esc('file://' + s.replace(/\\/g, '/'));
  return null;
}

/** Clamped logo height, matching the invoice so documents look consistent. */
export function logoHeight(settings: ShopIdentity | null | undefined): number {
  const n = Number(settings?.print_logo_height);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(20, n));
}

/** The CSS the header markup needs. Injected alongside each page's own styles. */
export function printHeaderCss(settings: ShopIdentity | null | undefined): string {
  const h = logoHeight(settings);
  return `
    .ph-logo { max-height: ${h}px; max-width: ${Math.round(h * 3)}px;
               display: block; margin: 0 auto 2mm; object-fit: contain; }
    .ph-contact { font-size: 10px; color: #64748b; margin-top: 1mm; }
  `;
}

/**
 * The letterhead block: logo, shop name, contact line and tax number.
 *
 * `title` is the document's own heading, kept as an argument so each screen
 * still says what it is ("كشف حساب عميل", "كشف حساب خزينة"...).
 *
 * Every value is escaped here rather than at the call sites, because a call
 * site that forgets is exactly the defect this module was written to remove.
 */
export function printHeaderHtml(
  settings: ShopIdentity | null | undefined,
  title: string,
): string {
  const s = settings || {};
  const logo = safeLogoSrc(s.logo_path);
  const contact = [s.address, s.phone ? `هاتف: ${s.phone}` : '']
    .filter(Boolean).map((x) => esc(x)).join(' — ');

  return `
    <div class="report-header">
      ${logo ? `<img src="${logo}" class="ph-logo" alt="" />` : ''}
      <h1>${esc(title)}</h1>
      <div class="company">${esc(s.company_name || '')}</div>
      ${contact ? `<div class="ph-contact">${contact}</div>` : ''}
      ${s.tax_number ? `<div class="ph-contact">رقم ضريبي: ${esc(s.tax_number)}</div>` : ''}
      <div class="sub">تاريخ الطباعة: ${esc(new Date().toLocaleDateString('ar-EG-u-ca-islamic'))} | ${esc(new Date().toLocaleDateString('ar-EG'))}</div>
    </div>
  `;
}

/** The closing line, so the shop's real name appears at the foot too. */
export function printFooterHtml(
  settings: ShopIdentity | null | undefined,
  text: string,
): string {
  const name = (settings?.company_name || '').trim();
  return `<div class="footer">${esc(text)}${name ? ` — ${esc(name)}` : ''}</div>`;
}
