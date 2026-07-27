import { ipcMain, BrowserWindow } from 'electron';

export function registerPrintHandlers() {
  // Preview invoice - shows preview window with print button
  ipcMain.handle('print:preview', async (_event, data: {
    type: string;
    paperSize: string;
    template: string;
    companyInfo: any;
    invoiceData: any;
  }) => {
    const html = generateInvoiceHTML(data, false);

    const previewWindow = new BrowserWindow({
      width: data.paperSize === 'A4' ? 820 : 420,
      height: 750,
      title: 'معاينة الفاتورة',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
      show: true,
    });

    previewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return { success: true };
  });

  // Print directly - opens print dialog
  ipcMain.handle('print:invoice', async (_event, data: {
    type: string;
    paperSize: string;
    template: string;
    companyInfo: any;
    invoiceData: any;
  }) => {
    const html = generateInvoiceHTML(data, false);

    const printWindow = new BrowserWindow({
      width: data.paperSize === 'A4' ? 820 : 420,
      height: 750,
      title: 'طباعة الفاتورة',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
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
          pageSize: getPageSize(data.paperSize),
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
  const { type, paperSize, template, companyInfo, invoiceData } = data;
  const isThermal = paperSize === '80mm' || paperSize === '58mm';
  const isA5 = paperSize === 'A5';
  const width = paperSize === '80mm' ? '80mm' : paperSize === '58mm' ? '58mm' : paperSize === 'A5' ? '148mm' : '210mm';
  const font = isThermal ? '12px' : isA5 ? '13px' : '14px';
  const pageMargin = isThermal ? '0' : isA5 ? '8mm' : '12mm';
  const bodyPad = isThermal ? '4mm 3mm' : '0';

  const titles: any = {
    sale: 'فاتورة مبيعات', purchase: 'فاتورة مشتريات',
    maintenance: 'فاتورة صيانة', voucher_receipt: 'سند قبض',
    voucher_payment: 'سند صرف', statement: 'كشف حساب',
  };

  const showCustomer = companyInfo.invoice_show_customer !== '0';
  const showShop = companyInfo.invoice_show_shop !== '0';

  const header = showShop ? `
    <div class="invoice-header">
      ${companyInfo.logo_path ? `<img src="${companyInfo.logo_path}" class="logo" />` : ''}
      <div class="company-name">${companyInfo.company_name || 'محل الموبايلات'}</div>
      ${companyInfo.address ? `<div class="info-line">${companyInfo.address}</div>` : ''}
      ${companyInfo.phone ? `<div class="info-line">هاتف: ${companyInfo.phone}</div>` : ''}
      ${companyInfo.tax_number ? `<div class="info-line">رقم ضريبي: ${companyInfo.tax_number}</div>` : ''}
    </div>
    <hr class="divider" />
  ` : '';

  let itemsHTML = '';
  let totalsHTML = '';

  if (type === 'sale' && invoiceData) {
    itemsHTML = `
      <table class="items-table">
        <thead><tr>
          <th>الصنف</th><th>كمية</th><th>سعر</th><th>إجمالي</th>
        </tr></thead>
        <tbody>
          ${(invoiceData.items || []).map((item: any) => `
            <tr>
              <td>${item.ItemName || item.IMEI || item.ServiceName || '—'}${item.IMEI ? `<br/><small class="imei">${item.IMEI}</small>` : ''}</td>
              <td class="center">${item.Quantity}</td>
              <td class="center">${item.UnitPrice?.toFixed(2)}</td>
              <td class="center bold">${(item.Quantity * item.UnitPrice).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    totalsHTML = `
      <div class="totals">
        <div class="total-row"><span>الإجمالي الفرعي:</span><span>${(invoiceData.subtotal || 0).toFixed(2)}</span></div>
        ${invoiceData.discount > 0 ? `<div class="total-row"><span>الخصم:</span><span>${invoiceData.discount.toFixed(2)}</span></div>` : ''}
        ${invoiceData.taxAmount > 0 ? `<div class="total-row"><span>الضريبة (${invoiceData.taxRate || 0}%):</span><span>${invoiceData.taxAmount.toFixed(2)}</span></div>` : ''}
        <div class="total-row grand"><span>الإجمالي:</span><span>${(invoiceData.totalAmount || 0).toFixed(2)} ${companyInfo.currency || 'ج.م'}</span></div>
        <div class="total-row paid"><span>المدفوع:</span><span>${(invoiceData.paidAmount || 0).toFixed(2)}</span></div>
        ${invoiceData.remaining > 0 ? `<div class="total-row remaining"><span>المتبقي:</span><span>${invoiceData.remaining.toFixed(2)}</span></div>` : ''}
      </div>
      ${invoiceData.notes || invoiceData.Notes ? `<div class="invoice-notes">ملاحظات: ${invoiceData.notes || invoiceData.Notes}</div>` : ''}
    `;
  } else if ((type === 'voucher_receipt' || type === 'voucher_payment') && invoiceData) {
    itemsHTML = `
      <div class="voucher-box">
        <div class="voucher-amount">المبلغ: <strong>${(invoiceData.amount || 0).toFixed(2)} ${companyInfo.currency || 'ج.م'}</strong></div>
        <div class="voucher-desc">البيان: ${invoiceData.description || '—'}</div>
        <div class="voucher-party">الطرف: ${invoiceData.partyName || '—'}</div>
      </div>
    `;
  } else if (type === 'maintenance' && invoiceData) {
    const deviceSection = invoiceData.deviceModel ? `
      <div class="device-info">
        <div class="device-row"><span class="device-label">الجهاز:</span><span>${invoiceData.deviceModel || '—'}</span></div>
        ${invoiceData.deviceIMEI ? `<div class="device-row"><span class="device-label">IMEI:</span><span>${invoiceData.deviceIMEI}</span></div>` : ''}
        ${invoiceData.problemDesc ? `<div class="device-row"><span class="device-label">المشكلة:</span><span>${invoiceData.problemDesc}</span></div>` : ''}
        ${invoiceData.ticketNumber ? `<div class="device-row"><span class="device-label">تذكرة:</span><span>${invoiceData.ticketNumber}</span></div>` : ''}
      </div>
    ` : '';
    itemsHTML = `
      ${deviceSection}
      <table class="items-table">
        <thead><tr>
          <th>البيان</th><th>كمية</th><th>سعر</th><th>إجمالي</th>
        </tr></thead>
        <tbody>
          ${(invoiceData.items || []).map((item: any) => `
            <tr>
              <td>${item.Description || item.ItemName || '—'}</td>
              <td class="center">${item.Quantity ?? 1}</td>
              <td class="center">${(item.UnitPrice || 0).toFixed(2)}</td>
              <td class="center bold">${(item.Total || item.Quantity * item.UnitPrice || 0).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    totalsHTML = `
      <div class="totals">
        <div class="total-row"><span>الإجمالي الفرعي:</span><span>${(invoiceData.subtotal || 0).toFixed(2)}</span></div>
        ${invoiceData.discount > 0 ? `<div class="total-row"><span>الخصم:</span><span>${invoiceData.discount.toFixed(2)}</span></div>` : ''}
        <div class="total-row grand"><span>الإجمالي:</span><span>${(invoiceData.totalAmount || 0).toFixed(2)} ${companyInfo.currency || 'ج.م'}</span></div>
        <div class="total-row paid"><span>المدفوع:</span><span>${(invoiceData.paidAmount || 0).toFixed(2)}</span></div>
        ${invoiceData.remaining > 0 ? `<div class="total-row remaining"><span>المتبقي:</span><span>${invoiceData.remaining.toFixed(2)}</span></div>` : ''}
      </div>
      ${invoiceData.notes || invoiceData.Notes ? `<div class="invoice-notes">ملاحظات: ${invoiceData.notes || invoiceData.Notes}</div>` : ''}
    `;
  }

  const partyInfo = showCustomer && invoiceData ? `
    <div class="party-info">
      ${invoiceData.customerName || invoiceData.CustomerName ? `<div>العميل: ${invoiceData.customerName || invoiceData.CustomerName}</div>` : ''}
      ${invoiceData.customerPhone || invoiceData.CustomerPhone ? `<div>هاتف: ${invoiceData.customerPhone || invoiceData.CustomerPhone}</div>` : ''}
    </div>
  ` : '';

  const primaryColor = template === '2' ? '#059669' : template === '3' ? '#7c3aed' : template === '4' ? '#475569' : template === '5' ? '#dc2626' : '#2563eb';

  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${titles[type] || 'فاتورة'}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; font-size: ${font}; color: #333; padding: ${bodyPad}; width: ${isThermal ? width : 'auto'}; max-width: ${isThermal ? width : '210mm'}; margin: 0 auto; }
        @media print { body { width: auto; padding: 0; } @page { margin: ${pageMargin}; size: ${isThermal ? width + ' auto' : 'A4'}; } .no-print { display: none !important; } }
        .invoice-header { text-align: center; margin-bottom: 8px; }
        .logo { max-height: 50px; max-width: 150px; margin-bottom: 5px; }
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
      <div class="invoice-title">${titles[type] || 'فاتورة'}</div>
      <div class="invoice-meta">
        <span>رقم: ${invoiceData?.saleNumber || invoiceData?.purchaseNumber || invoiceData?.ticketNumber || invoiceData?.voucherNumber || '—'}</span>
        <span>التاريخ: ${invoiceData?.date || invoiceData?.Date || new Date().toISOString().split('T')[0]}</span>
      </div>
      ${partyInfo}
      ${itemsHTML}
      ${totalsHTML}
      <div class="thank-you">شكراً لتعاملكم معنا</div>
      <div class="footer">
        ${companyInfo.owner_name ? `المالك: ${companyInfo.owner_name} | ` : ''}
        ${companyInfo.phone ? `هاتف: ${companyInfo.phone}` : ''}
      </div>
      <button class="print-btn no-print" onclick="window.print()">🖨️ طباعة</button>
    </body>
    </html>
  `;
}
