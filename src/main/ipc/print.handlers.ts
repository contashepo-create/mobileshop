import { ipcMain, BrowserWindow } from 'electron';
import { getSession } from '../security/session';
import { businessToday } from '../../shared/businessDate';
import {
  DOCUMENT_TYPES, COLUMN_LABELS, resolveProfile, visibleColumns,
  type DocumentType, type ColumnKey,
} from '../../shared/printProfile';

/**
 * SECURITY: every value that reaches the invoice HTML is attacker-controllable
 * (item names, customer names, notes, company settings). Without escaping, an
 * item named `<img src=x onerror=...>` executes script inside the print window.
 * The print window is loaded from a `data:` URL, which does NOT inherit the
 * CSP declared in index.html, so escaping here is the only defence.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formats a value as a fixed-2 number, never emitting raw user input. */
function num(value: unknown, digits = 2): string {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n.toFixed(digits) : (0).toFixed(digits);
}

/** Only allow safe image sources for the logo (no javascript:/data:text). */
function safeImageSrc(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s) || /^data:image\//i.test(s)) return esc(s);
  // Bare filesystem path (Windows drive or POSIX) -> treat as file URL
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return esc('file://' + s.replace(/\\/g, '/'));
  return null;
}

export function registerPrintHandlers() {
  // Preview invoice - shows preview window with print button
  /**
   * Who is printing, taken from the SESSION rather than the payload.
   *
   * Every screen that prints would otherwise have to remember to pass a
   * username, and the one that forgot would silently produce an unattributed
   * document. Reading it here means the line is always correct and cannot be
   * spoofed by a modified renderer.
   */
  const printingUser = (event: Electron.IpcMainInvokeEvent): string => {
    try { return getSession(event.sender.id)?.username || ''; } catch { return ''; }
  };

  /**
   * The profile the WINDOW must agree with.
   *
   * `generateInvoiceHTML` resolves this too, but the two handlers also need it
   * before the HTML exists -- to size the preview window and to choose the
   * page size and copy count for the printer. Resolving it in one place means
   * the sheet and the document it carries can never be decided by different
   * values.
   */
  const profileFor = (data: any) => {
    const type = (DOCUMENT_TYPES as readonly string[]).includes(data?.type)
      ? (data.type as DocumentType) : 'sale';
    return resolveProfile(data?.companyInfo, type);
  };

  ipcMain.handle('print:preview', async (event, data: {
    type: string;
    paperSize: string;
    template: string;
    companyInfo: any;
    invoiceData: any;
  }) => {
    const profile = profileFor(data);
    const html = generateInvoiceHTML({ ...data, printedBy: printingUser(event) }, false);

    const previewWindow = new BrowserWindow({
      width: profile.paper === 'A4' || profile.paper === 'A5' ? 820 : 420,
      height: 750,
      title: 'معاينة الفاتورة',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true, // needed only for the "print" button
      },
      show: true,
    });

    previewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return { success: true };
  });

  // Print directly - opens print dialog
  ipcMain.handle('print:invoice', async (event, data: {
    type: string;
    paperSize: string;
    template: string;
    companyInfo: any;
    invoiceData: any;
  }) => {
    const profile = profileFor(data);
    const html = generateInvoiceHTML({ ...data, printedBy: printingUser(event) }, false);

    const printWindow = new BrowserWindow({
      width: profile.paper === 'A4' || profile.paper === 'A5' ? 820 : 420,
      height: 750,
      title: 'طباعة الفاتورة',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
      },
      show: true,
    });

    printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    printWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        printWindow.webContents.print({
          silent: false,
          printBackground: true,
          margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
          // The page size comes from the RESOLVED profile, not from the
          // payload. Passing `data.paperSize` here while the HTML was built at
          // the profile's size printed an 80mm document onto an A4 sheet
          // whenever the two disagreed — the body and the paper have to be
          // decided by the same value.
          pageSize: getPageSize(profile.paper),
          copies: profile.copies,
        }, () => {});
      }, 500);
    });

    return { success: true };
  });
}

function getPageSize(paperSize: string) {
  if (paperSize === 'A4') return { width: 210000, height: 297000 };
  if (paperSize === 'A5') return { width: 148000, height: 210000 };
  if (paperSize === '80mm') return { width: 80000, height: 297000 };
  if (paperSize === '58mm') return { width: 58000, height: 297000 };
  return { width: 210000, height: 297000 };
}

function generateInvoiceHTML(data: any, autoPrint: boolean): string {
  const { type, companyInfo, invoiceData } = data;

  /**
   * The effective settings for THIS KIND of document.
   *
   * Resolved here, in the main process, from the stored settings — not taken
   * from the payload. The renderer still sends `paperSize` and `template`
   * (every existing caller does), but a renderer can be modified, and the
   * document a shop gets must be the one the shop configured. The payload is
   * accepted only as a fallback for a caller that has not been migrated.
   *
   * `resolveProfile` answers per-document value -> existing global value ->
   * default, so a shop that never opens the new screen keeps exactly the
   * document it had before this change.
   */
  const docType: DocumentType =
    (DOCUMENT_TYPES as readonly string[]).includes(type) ? type : 'sale';
  const profile = resolveProfile(companyInfo, docType);
  const paperSize = profile.paper || data.paperSize;
  const template = profile.template || data.template;

  // Supplied by the caller (the renderer knows who is signed in). Falls back to
  // a blank rather than guessing, so the line is never misleading.
  const printedBy = (data as any).printedBy || companyInfo.printed_by || '';
  const printedAt = new Date().toLocaleString('en-GB');
  const isThermal = paperSize === '80mm' || paperSize === '58mm';
  const isA5 = paperSize === 'A5';
  const width = paperSize === '80mm' ? '80mm' : paperSize === '58mm' ? '58mm' : paperSize === 'A5' ? '148mm' : '210mm';

  /**
   * Every dimension below used to be hardcoded, so a shop whose printer cut off
   * the last column, or whose thermal roll needed a wider margin, had no way to
   * fix it. These are the settings a real invoice designer exposes.
   *
   * Each falls back to the value that was previously fixed, so a shop that
   * changes nothing sees exactly the same document as before. A stored value is
   * only honoured when it parses as a sane number — a blank or a typo must not
   * produce a page with a 900mm margin.
   */
  const numOpt = (key: string, fallback: number, min: number, max: number): number => {
    const raw = Number(companyInfo[key]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
  };

  const font = `${numOpt('print_font_size', isThermal ? 12 : isA5 ? 13 : 14, 7, 24)}px`;
  const pageMargin = isThermal
    ? `${numOpt('print_margin_thermal', 0, 0, 20)}mm`
    : `${numOpt('print_margin', isA5 ? 8 : 12, 0, 40)}mm`;
  const bodyPad = isThermal ? '4mm 3mm' : '0';
  const logoMaxH = numOpt('print_logo_height', 50, 20, 200);
  const fontFamily = companyInfo.print_font_family === 'tahoma'
    ? "Tahoma, 'Segoe UI', sans-serif"
    : companyInfo.print_font_family === 'arial'
      ? "Arial, Helvetica, sans-serif"
      : "'Cairo', 'Segoe UI', Tahoma, sans-serif";

  /**
   * The item table, built from the resolved profile.
   *
   * Columns used to be emitted in a fixed order with a per-column on/off flag
   * spliced into the markup by hand, which meant "hide a column" and "move a
   * column" were two unrelated problems and only the first was solvable. Both
   * now come from the same ordered list, so a shop can put the total first, or
   * drop the index entirely, without the header and the body ever
   * disagreeing — they are generated from one array.
   */
  const cols = visibleColumns(profile);

  const cellFor = (key: ColumnKey, item: any, i: number): string => {
    switch (key) {
      case 'index': return `<td class="center">${i + 1}</td>`;
      case 'name': {
        const name = esc(item.ItemName || item.Description || item.IMEI || item.ServiceName || '—');
        // The IMEI rides under the name only when it has no column of its own;
        // otherwise it would be printed twice.
        const inlineImei = !cols.includes('imei') && item.IMEI
          ? `<br/><small class="imei">${esc(item.IMEI)}</small>` : '';
        return `<td>${name}${inlineImei}</td>`;
      }
      case 'qty': return `<td class="center">${esc(item.Quantity ?? 1)}</td>`;
      case 'price': return `<td class="center">${num(item.UnitPrice ?? item.UnitCost)}</td>`;
      case 'total': return `<td class="center bold">${num(
        item.Total ?? ((Number(item.Quantity) || 0) * (Number(item.UnitPrice ?? item.UnitCost) || 0)),
      )}</td>`;
      case 'imei': return `<td class="center">${esc(item.IMEI || '—')}</td>`;
      default: return '';
    }
  };

  const itemsTable = (items: any[]): string => `
      <table class="items-table">
        <thead><tr>${cols.map(k => `<th>${esc(COLUMN_LABELS[k])}</th>`).join('')}</tr></thead>
        <tbody>
          ${(items || []).map((item: any, i: number) =>
            `<tr>${cols.map(k => cellFor(k, item, i)).join('')}</tr>`).join('')}
        </tbody>
      </table>
    `;

  /** The money block. Shared by sales, purchases and maintenance. */
  const totalsBlock = (d: any): string => `
      <div class="totals">
        <div class="total-row"><span>الإجمالي الفرعي:</span><span>${num(d.subtotal)}</span></div>
        ${d.discount > 0 ? `<div class="total-row"><span>الخصم:</span><span>${num(d.discount)}</span></div>` : ''}
        ${d.taxAmount > 0 ? `<div class="total-row"><span>الضريبة (${esc(d.taxRate || 0)}%):</span><span>${num(d.taxAmount)}</span></div>` : ''}
        <div class="total-row grand"><span>الإجمالي:</span><span>${num(d.totalAmount)} ${esc(companyInfo.currency || 'ج.م')}</span></div>
        <div class="total-row paid"><span>المدفوع:</span><span>${num(d.paidAmount)}</span></div>
        ${d.remaining > 0 ? `<div class="total-row remaining"><span>المتبقي:</span><span>${num(d.remaining)}</span></div>` : ''}
      </div>
      ${d.notes || d.Notes ? `<div class="invoice-notes">ملاحظات: ${esc(d.notes || d.Notes)}</div>` : ''}
    `;

  const titles: any = {
    sale: 'فاتورة مبيعات', purchase: 'فاتورة مشتريات',
    maintenance: 'فاتورة صيانة', voucher_receipt: 'سند قبض',
    voucher_payment: 'سند صرف', statement: 'كشف حساب',
  };

  const showCustomer = companyInfo.invoice_show_customer !== '0';
  const showShop = companyInfo.invoice_show_shop !== '0';

  const header = showShop ? `
    <div class="invoice-header">
      ${safeImageSrc(companyInfo.logo_path) ? `<img src="${safeImageSrc(companyInfo.logo_path)}" class="logo" />` : ''}
      <div class="company-name">${esc(companyInfo.company_name || 'محل الموبايلات')}</div>
      ${companyInfo.address ? `<div class="info-line">${esc(companyInfo.address)}</div>` : ''}
      ${companyInfo.phone ? `<div class="info-line">هاتف: ${esc(companyInfo.phone)}</div>` : ''}
      ${companyInfo.tax_number ? `<div class="info-line">رقم ضريبي: ${esc(companyInfo.tax_number)}</div>` : ''}
    </div>
    <hr class="divider" />
  ` : '';

  let itemsHTML = '';
  let totalsHTML = '';

  // A sale and a purchase are the same shape of document -- a list of lines and
  // a money block -- so they share one branch. `purchase` previously had a
  // TITLE but no body: printing one produced a header, an empty table and no
  // totals at all. Same for `statement`.
  if ((type === 'sale' || type === 'purchase') && invoiceData) {
    itemsHTML = itemsTable(invoiceData.items);
    totalsHTML = totalsBlock(invoiceData);
  } else if ((type === 'voucher_receipt' || type === 'voucher_payment') && invoiceData) {
    itemsHTML = `
      <div class="voucher-box">
        <div class="voucher-amount">المبلغ: <strong>${num(invoiceData.amount)} ${esc(companyInfo.currency || 'ج.م')}</strong></div>
        <div class="voucher-desc">البيان: ${esc(invoiceData.description || '—')}</div>
        <div class="voucher-party">الطرف: ${esc(invoiceData.partyName || '—')}</div>
      </div>
    `;
  } else if (type === 'maintenance' && invoiceData) {
    const deviceSection = invoiceData.deviceModel ? `
      <div class="device-info">
        <div class="device-row"><span class="device-label">الجهاز:</span><span>${esc(invoiceData.deviceModel || '—')}</span></div>
        ${invoiceData.deviceIMEI ? `<div class="device-row"><span class="device-label">IMEI:</span><span>${esc(invoiceData.deviceIMEI)}</span></div>` : ''}
        ${invoiceData.problemDesc ? `<div class="device-row"><span class="device-label">المشكلة:</span><span>${esc(invoiceData.problemDesc)}</span></div>` : ''}
        ${invoiceData.ticketNumber ? `<div class="device-row"><span class="device-label">تذكرة:</span><span>${esc(invoiceData.ticketNumber)}</span></div>` : ''}
      </div>
    ` : '';
    itemsHTML = deviceSection + itemsTable(invoiceData.items);
    totalsHTML = totalsBlock(invoiceData);
  } else if (type === 'statement' && invoiceData) {
    // A statement is a running ledger, not an invoice: it has no subtotal or
    // amount paid, and its closing balance is the only figure that matters.
    // It had a title and nothing else before.
    itemsHTML = `
      <table class="items-table">
        <thead><tr>
          <th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th>
        </tr></thead>
        <tbody>
          ${(invoiceData.items || []).map((row: any) => `
            <tr>
              <td class="center">${esc(row.Date || row.date || '')}</td>
              <td>${esc(row.Description || row.description || '—')}</td>
              <td class="center">${row.Debit ? num(row.Debit) : '—'}</td>
              <td class="center">${row.Credit ? num(row.Credit) : '—'}</td>
              <td class="center bold">${num(row.Balance)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    totalsHTML = `
      <div class="totals">
        <div class="total-row"><span>إجمالي المدين:</span><span>${num(invoiceData.totalDebit)}</span></div>
        <div class="total-row"><span>إجمالي الدائن:</span><span>${num(invoiceData.totalCredit)}</span></div>
        <div class="total-row grand"><span>الرصيد:</span><span>${num(invoiceData.netBalance)} ${esc(companyInfo.currency || 'ج.م')}</span></div>
      </div>
    `;
  }

  const partyInfo = showCustomer && invoiceData ? `
    <div class="party-info">
      ${invoiceData.customerName || invoiceData.CustomerName ? `<div>العميل: ${esc(invoiceData.customerName || invoiceData.CustomerName)}</div>` : ''}
      ${invoiceData.customerPhone || invoiceData.CustomerPhone ? `<div>هاتف: ${esc(invoiceData.customerPhone || invoiceData.CustomerPhone)}</div>` : ''}
    </div>
  ` : '';

  const primaryColor = template === '2' ? '#059669' : template === '3' ? '#7c3aed' : template === '4' ? '#475569' : template === '5' ? '#dc2626' : '#2563eb';

  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${esc(titles[type] || 'فاتورة')}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: ${fontFamily}; font-size: ${font}; color: #333; padding: ${bodyPad}; width: ${isThermal ? width : 'auto'}; max-width: ${isThermal ? width : '210mm'}; margin: 0 auto; }
        @media print { body { width: auto; padding: 0; } @page { margin: ${pageMargin}; size: ${isThermal ? width + ' auto' : 'A4'}; } .no-print { display: none !important; } }
        .invoice-header { text-align: center; margin-bottom: 8px; }
        .logo { max-height: ${logoMaxH}px; max-width: ${Math.round(logoMaxH * 3)}px; margin-bottom: 5px; }
        .printed-by { margin-top: 6px; padding-top: 4px; border-top: 1px dashed #bbb;
                      font-size: 9px; color: #666; text-align: center; }
        .terms { margin-top: 6px; font-size: 9px; color: #555; text-align: center;
                 white-space: pre-line; }
        .doc-header-text { margin: 4px 0; font-size: 10px; color: #444; text-align: center;
                           white-space: pre-line; }
        .doc-footer-text { margin-top: 6px; font-size: 9px; color: #555; text-align: center;
                           white-space: pre-line; }
        .company-name { font-size: ${isThermal ? '14px' : '20px'}; font-weight: bold; }
        .info-line { font-size: 11px; color: #666; }
        .divider { border: none; border-top: 1px dashed #ccc; margin: 5px 0; }
        .invoice-title { text-align: center; background: ${primaryColor}; color: white; padding: 8px; border-radius: 5px; margin: 5px 0; font-size: ${isThermal ? '13px' : '18px'}; font-weight: bold; }
        .invoice-meta { display: flex; justify-content: space-between; font-size: 11px; margin: 5px 0; color: #666; }
        .party-info { margin: 5px 0; font-size: 11px; }
        .items-table { width: 100%; border-collapse: collapse; margin: 5px 0; }
        .items-table th { background: #f5f5f5; padding: 4px; border: 1px solid #ddd; text-align: right; }
        .items-table td { padding: 3px; border: 1px solid #ddd; }
        .items-table .center { text-align: center; }
        .items-table .bold { font-weight: bold; }
        .imei { color: #999; font-size: 10px; }
        .totals { margin-top: 8px; }
        .total-row { display: flex; justify-content: space-between; padding: 2px 0; }
        .total-row.grand { font-weight: bold; font-size: ${isThermal ? '14px' : '16px'}; border-top: 2px solid #333; margin-top: 5px; padding-top: 4px; }
        .total-row.paid { color: green; }
        .total-row.remaining { color: red; }
        .device-info { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px 8px; margin: 4px 0; font-size: 11px; }
        .device-row { display: flex; gap: 6px; padding: 1px 0; }
        .device-label { font-weight: 600; color: #475569; min-width: 60px; }
        .invoice-notes { background: #fef9c3; border: 1px solid #eab308; border-radius: 4px; padding: 6px 8px; margin: 6px 0; font-size: 11px; text-align: right; }
        .voucher-box { margin: 15px 0; padding: 15px; border: 2px solid #333; border-radius: 5px; }
        .voucher-amount { font-size: 16px; margin-bottom: 8px; }
        .thank-you { text-align: center; margin-top: 10px; font-weight: bold; }
        .footer { margin-top: 10px; text-align: center; font-size: 10px; color: #999; border-top: 1px dashed #ccc; padding-top: 5px; }
        .print-btn { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: ${primaryColor}; color: white; padding: 10px 30px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; font-family: inherit; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
        .print-btn:hover { opacity: 0.9; }
      </style>
    </head>
    <body>
      ${header}
      <div class="invoice-title">${esc(titles[type] || 'فاتورة')}</div>
      ${/*
         Free text the shop can put on THIS KIND of document only.
         A sales invoice may need a returns policy, a purchase invoice an
         internal reference, a voucher nothing at all. One shared block could
         not say different things on different documents.
         `white-space: pre-line` so a typed line break survives; escaped, so
         the text cannot become markup.
      */ ''}
      ${profile.headerText ? `<div class="doc-header-text">${esc(profile.headerText)}</div>` : ''}
      <div class="invoice-meta">
        <span>رقم: ${esc(invoiceData?.saleNumber || invoiceData?.purchaseNumber || invoiceData?.ticketNumber || invoiceData?.voucherNumber || '—')}</span>
        <span>التاريخ: ${esc(invoiceData?.date || invoiceData?.Date || businessToday())}</span>
      </div>
      ${partyInfo}
      ${itemsHTML}
      ${totalsHTML}
      <div class="thank-you">${esc(companyInfo.invoice_thanks_note || 'شكراً لتعاملكم معنا')}</div>
      ${companyInfo.invoice_terms ? `<div class="terms">${esc(companyInfo.invoice_terms)}</div>` : ''}
      ${profile.footerText ? `<div class="doc-footer-text">${esc(profile.footerText)}</div>` : ''}
      <div class="footer">
        ${companyInfo.owner_name ? `المالك: ${esc(companyInfo.owner_name)} | ` : ''}
        ${companyInfo.phone ? `هاتف: ${esc(companyInfo.phone)}` : ''}
      </div>
      ${/*
         Who printed this, and when.
         Not decoration: a statement of account or an invoice reprint is
         evidence in a dispute, and "which of my staff produced this copy" is a
         question that gets asked. Without it a printout has no provenance at
         all. Suppressible for shops that would rather not show it.
      */ ''}
      ${companyInfo.print_show_user === '0' ? '' : `
      <div class="printed-by">
        تمت الطباعة بواسطة: ${esc(printedBy || 'غير معروف')}
        &nbsp;·&nbsp; ${esc(printedAt)}
      </div>`}
      <button class="print-btn no-print" onclick="window.print()">🖨️ طباعة</button>
    </body>
    </html>
  `;
}
