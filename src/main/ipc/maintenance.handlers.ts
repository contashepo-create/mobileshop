import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { getCallerUserId } from '../security/ipcGuard';
import { nextDocNumber } from '../database/docNumber';
import { deductStock, restoreStock } from '../database/stock';

const statusLabels: Record<string, string> = {
  received: 'مستلم', inspecting: 'فحص', in_progress: 'قيد العمل',
  ready: 'جاهز للتسليم', delivered: 'تم التسليم', returned: 'مرتجع', cancelled: 'ملغي'
};

export function registerMaintenanceHandlers() {
  // ===== TICKETS =====
  ipcMain.handle('maintenance:list', async (_event, filters?: { status?: string; technicianId?: number; customerId?: number }) => {
    const db = getDb();
    let query = `
      SELECT t.*, e.Name as TechnicianName, u.Username,
             rt.TicketNumber as ReferenceTicketNumber
      FROM maintenance_tickets t
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      JOIN users u ON t.UserID = u.UserID
      LEFT JOIN maintenance_tickets rt ON t.ReferenceTicketID = rt.TicketID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.status && filters.status !== 'all') { query += ' AND t.Status = ?'; params.push(filters.status); }
    if (filters?.technicianId) { query += ' AND t.TechnicianID = ?'; params.push(filters.technicianId); }
    if (filters?.customerId) { query += ' AND t.CustomerID = ?'; params.push(filters.customerId); }
    query += ' ORDER BY t.Date DESC, t.TicketID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('maintenance:get', async (_event, ticketId: number) => {
    const db = getDb();
    const ticket = db.prepare(`
      SELECT t.*, e.Name as TechnicianName, c.Name as CustomerName, c.Phone as CustomerPhone, c.Balance as CustomerBalance, c.Status as CustomerStatus
      FROM maintenance_tickets t
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      LEFT JOIN customers c ON t.CustomerID = c.CustomerID
      WHERE t.TicketID = ?
    `).get(ticketId);
    const parts = db.prepare(`
      SELECT mp.*, i.ItemName
      FROM maintenance_parts mp
      JOIN items i ON mp.ItemID = i.ItemID
      WHERE mp.TicketID = ?
    `).all(ticketId);
    const log = db.prepare(`
      SELECT l.*, u.Username
      FROM maintenance_status_log l
      JOIN users u ON l.UserID = u.UserID
      WHERE l.TicketID = ?
      ORDER BY l.Date ASC
    `).all(ticketId);
    const serviceCosts = db.prepare(`
      SELECT sc.*, u.Username
      FROM maintenance_service_costs sc
      JOIN users u ON sc.UserID = u.UserID
      WHERE sc.TicketID = ?
      ORDER BY sc.CreatedAt ASC
    `).all(ticketId);
    const serviceUsage = db.prepare(`
      SELECT su.*, u.Username
      FROM maintenance_service_usage su
      JOIN users u ON su.UserID = u.UserID
      WHERE su.TicketID = ?
      ORDER BY su.CreatedAt ASC
    `).all(ticketId);
    const notes = db.prepare(`
      SELECT n.*, u.Username
      FROM operation_notes n
      JOIN users u ON n.UserID = u.UserID
      WHERE n.OperationType = 'maintenance' AND n.OperationID = ?
      ORDER BY n.CreatedAt ASC
    `).all(ticketId);
    return { ticket, parts, log, serviceCosts, serviceUsage, notes };
  });

  ipcMain.handle('maintenance:openTickets', async (_event, customerId?: number, customerName?: string) => {
    const db = getDb();
    let query = `
      SELECT t.*, e.Name as TechnicianName
      FROM maintenance_tickets t
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      WHERE t.Status NOT IN ('delivered', 'cancelled')
    `;
    const params: any[] = [];
    if (customerId) { query += ' AND t.CustomerID = ?'; params.push(customerId); }
    else if (customerName) { query += ' AND t.CustomerName = ?'; params.push(customerName); }
    query += ' ORDER BY t.Date DESC';
    return db.prepare(query).all(...params);
  });

  // Receive device
  ipcMain.handle('maintenance:receive', async (_event, data: {
    CustomerID?: number; CustomerName: string; CustomerPhone: string;
    DeviceModel: string; DeviceIMEI?: string; ProblemDesc: string;
    Accessories?: string; DevicePassword?: string;
    AgreedDeliveryDate?: string; AgreedCost?: number;
    TechnicianID?: number; userId: number; fiscalYearId: number;
    MaintenanceType?: string; ReferenceTicketID?: number;
  }) => {
    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];
    const ticketNumber = nextDocNumber(db, 'maintenance_tickets', 'TicketNumber', 'MNT', dateStr);
    const maintenanceType = data.MaintenanceType || 'normal';

    // Single transaction: customer creation, ticket and status log must all
    // succeed or all roll back. Previously these were three independent writes,
    // so a mid-way failure could leave an orphan customer or a ticket with no
    // status history.
    const tx = db.transaction(() => {
    // Auto-register customer if not selected but name is provided
    let customerId = data.CustomerID ?? null;
    if (!customerId && data.CustomerName?.trim()) {
      const existing = db.prepare('SELECT CustomerID FROM customers WHERE Name = ? AND Phone = ?').get(data.CustomerName.trim(), data.CustomerPhone?.trim() || '') as any;
      if (existing) {
        customerId = existing.CustomerID;
      } else {
        const ins = db.prepare('INSERT INTO customers (Name, Phone, Status) VALUES (?, ?, ?)').run(data.CustomerName.trim(), data.CustomerPhone?.trim() || null, 'active');
        customerId = ins.lastInsertRowid as number;
      }
    }

    const result = db.prepare(`
      INSERT INTO maintenance_tickets (TicketNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
        DeviceModel, DeviceIMEI, ProblemDesc, Accessories, DevicePassword,
        AgreedDeliveryDate, AgreedCost, TechnicianID, Status, UserID, MaintenanceType, ReferenceTicketID)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)
    `).run(
      ticketNumber, data.fiscalYearId, dateStr,
      customerId, data.CustomerName, data.CustomerPhone,
      data.DeviceModel, data.DeviceIMEI ?? null, data.ProblemDesc,
      data.Accessories ?? null, data.DevicePassword ?? null,
      data.AgreedDeliveryDate ?? null, data.AgreedCost ?? null,
      data.TechnicianID ?? null, data.userId, maintenanceType, data.ReferenceTicketID ?? null
    );

    const ticketId = result.lastInsertRowid;
    const receiveNote = maintenanceType === 'warranty'
      ? `استلام جهاز لصيانة ضمان${data.ReferenceTicketID ? ' - مرجع: التذكرة #' + data.ReferenceTicketID : ''}`
      : maintenanceType === 'rework'
        ? `استلام جهاز لاستكمال عمل${data.ReferenceTicketID ? ' - مرجع: التذكرة #' + data.ReferenceTicketID : ''}`
        : 'تم استلام الجهاز';
    db.prepare(`
      INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
      VALUES (?, 'received', ?, ?)
    `).run(ticketId, receiveNote, data.userId);

      return ticketId;
    });

    const ticketId2 = tx();
    return { success: true, ticketId: ticketId2, ticketNumber };
  });

  // Update ticket status - REQUIRES notes
  ipcMain.handle('maintenance:updateStatus', async (event, ticketId: number, status: string, notes: string, _userId?: number) => {
    const userId = getCallerUserId(event, _userId);
    if (!notes.trim()) {
      return { success: false, message: 'الملاحظات إجبارية عند تغيير الحالة' };
    }
    const db = getDb();
    db.transaction(() => {
      db.prepare('UPDATE maintenance_tickets SET Status = ? WHERE TicketID = ?').run(status, ticketId);
      db.prepare(`
        INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
        VALUES (?, ?, ?, ?)
      `).run(ticketId, status, notes, userId);
    })();
    return { success: true };
  });

  // Issue parts to maintenance ticket
  ipcMain.handle('maintenance:issuePart', async (_event, data: {
    TicketID: number; ItemID: number; Quantity: number;
    UnitCost?: number; SalePrice?: number; WarehouseID: number; userId: number;
  }) => {
    const db = getDb();
    // COST INTEGRITY: the cost booked against the ticket MUST equal the value
    // actually leaving inventory, otherwise the balance sheet silently drifts
    // by the difference on every repair (assets drop by CostPrice while P&L is
    // charged the caller-supplied UnitCost).
    // The caller may no longer override this; UnitCost is accepted only as a
    // fallback when the item has no costed stock row yet.
    const stockRow = db.prepare(
      'SELECT CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?'
    ).get(data.ItemID, data.WarehouseID) as any;
    const stockCost = stockRow?.CostPrice ?? null;
    const unitCost = (stockCost !== null && stockCost > 0)
      ? stockCost
      : (data.UnitCost ?? (db.prepare('SELECT CostPrice FROM items WHERE ItemID = ?').get(data.ItemID) as any)?.CostPrice ?? 0);
    const salePrice = data.SalePrice ?? 0;
    const totalCost = unitCost * data.Quantity;
    const totalSale = salePrice * data.Quantity;

    // Check sufficient stock (unless negative stock allowed)
    const allowNegStock = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;
    if (allowNegStock?.Value !== '1') {
      const stockQty = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(data.ItemID, data.WarehouseID) as any;
      if ((stockQty?.qty || 0) < data.Quantity) {
        return { success: false, message: `الكمية غير متوفرة في المخزن: المطلوب ${data.Quantity}، المتاح ${stockQty?.qty || 0}` };
      }
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO maintenance_parts (TicketID, ItemID, Quantity, UnitCost, TotalCost, SalePrice, WarehouseID, IssuedByUserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.TicketID, data.ItemID, data.Quantity, unitCost, totalCost, salePrice, data.WarehouseID, data.userId);

      // Deduct from the exact warehouse the cost was read from.
      deductStock(db, data.ItemID, data.WarehouseID, data.Quantity);

      db.prepare('UPDATE maintenance_tickets SET PartsCost = PartsCost + ?, TotalCost = TotalCost + ? WHERE TicketID = ?')
        .run(totalCost, totalSale || totalCost, data.TicketID);
    })();

    return { success: true, unitCost, totalCost };
  });

  // Remove a part from a ticket (restore stock)
  ipcMain.handle('maintenance:removePart', async (event, partId: number, ticketId: number, _userId?: number) => {
    const userId = getCallerUserId(event, _userId);
    const db = getDb();
    const part = db.prepare('SELECT * FROM maintenance_parts WHERE PartID = ?').get(partId) as any;
    if (!part) return { success: false, message: 'القطعة غير موجودة' };

    db.transaction(() => {
      db.prepare('DELETE FROM maintenance_parts WHERE PartID = ?').run(partId);

      restoreStock(db, part.ItemID, part.WarehouseID, part.Quantity, part.UnitCost || 0);

      db.prepare('UPDATE maintenance_tickets SET PartsCost = MAX(0, PartsCost - ?), TotalCost = MAX(0, TotalCost - ?) WHERE TicketID = ?')
        .run(part.TotalCost, part.TotalCost, ticketId);
    })();
    return { success: true };
  });

  // ===== SERVICE COSTS (manual services like software) =====
  ipcMain.handle('maintenance:addServiceCost', async (_event, data: {
    TicketID: number; Description: string; CostOnUs: number; PriceToClient: number; userId: number;
  }) => {
    if (!data.Description.trim()) return { success: false, message: 'وصف الخدمة مطلوب' };
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO maintenance_service_costs (TicketID, Description, CostOnUs, PriceToClient, UserID)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.TicketID, data.Description.trim(), data.CostOnUs || 0, data.PriceToClient || 0, data.userId);
    return { success: true, costId: result.lastInsertRowid };
  });

  ipcMain.handle('maintenance:removeServiceCost', async (_event, costId: number) => {
    const db = getDb();
    db.prepare('DELETE FROM maintenance_service_costs WHERE CostID = ?').run(costId);
    return { success: true };
  });

  ipcMain.handle('maintenance:listServiceCosts', async (_event, ticketId: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT sc.*, u.Username
      FROM maintenance_service_costs sc
      JOIN users u ON sc.UserID = u.UserID
      WHERE sc.TicketID = ?
      ORDER BY sc.CreatedAt ASC
    `).all(ticketId);
  });

  // ===== SERVICE USAGE (manual services with optional ItemID) =====
  ipcMain.handle('maintenance:addServiceUsage', async (_event, data: {
    TicketID: number; Description: string; CostOnUs: number; PriceToClient: number;
    Quantity: number; ItemID?: number; userId: number;
  }) => {
    if (!data.Description.trim()) return { success: false, message: 'وصف الخدمة مطلوب' };
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO maintenance_service_usage (TicketID, ItemID, Description, CostOnUs, PriceToClient, Quantity, UserID)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(data.TicketID, data.ItemID ?? null, data.Description.trim(), data.CostOnUs || 0, data.PriceToClient || 0, data.Quantity || 1, data.userId);
    return { success: true, usageId: result.lastInsertRowid };
  });

  ipcMain.handle('maintenance:removeServiceUsage', async (_event, usageId: number) => {
    const db = getDb();
    db.prepare('DELETE FROM maintenance_service_usage WHERE UsageID = ?').run(usageId);
    return { success: true };
  });

  // ===== NOTES =====
  ipcMain.handle('maintenance:addNote', async (_event, data: {
    TicketID: number; Content: string; userId: number;
  }) => {
    if (!data.Content.trim()) return { success: false, message: 'محتوى الملاحظة مطلوب' };
    const db = getDb();
    db.prepare(`
      INSERT INTO operation_notes (OperationType, OperationID, Content, UserID)
      VALUES ('maintenance', ?, ?, ?)
    `).run(data.TicketID, data.Content.trim(), data.userId);
    return { success: true };
  });

  // ===== FINANCIAL SUMMARY =====
  ipcMain.handle('maintenance:getFinancialSummary', async (_event, ticketId: number) => {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(ticketId) as any;
    if (!ticket) return { success: false, message: 'التذكرة غير موجودة' };

    const parts = db.prepare('SELECT SUM(TotalCost) as totalCost FROM maintenance_parts WHERE TicketID = ?').get(ticketId) as any;
    const partsCostOnUs = parts?.totalCost || 0;

    const serviceCostsData = db.prepare(`
      SELECT SUM(CostOnUs) as totalCostOnUs, SUM(PriceToClient) as totalPrice
      FROM maintenance_service_costs WHERE TicketID = ?
    `).get(ticketId) as any;
    const serviceCostOnUs = serviceCostsData?.totalCostOnUs || 0;
    const servicePriceToClient = serviceCostsData?.totalPrice || 0;

    const serviceUsageData = db.prepare(`
      SELECT SUM(CostOnUs * Quantity) as totalCostOnUs, SUM(PriceToClient * Quantity) as totalPrice
      FROM maintenance_service_usage WHERE TicketID = ?
    `).get(ticketId) as any;
    const usageCostOnUs = serviceUsageData?.totalCostOnUs || 0;
    const usagePriceToClient = serviceUsageData?.totalPrice || 0;

    const partsSalePrice = db.prepare(`
      SELECT COALESCE(SUM(i.SalePrice * mp.Quantity), 0) as total
      FROM maintenance_parts mp
      JOIN items i ON mp.ItemID = i.ItemID
      WHERE mp.TicketID = ?
    `).get(ticketId) as any;

    const totalCostOnUs = partsCostOnUs + serviceCostOnUs + usageCostOnUs;
    const totalPriceToClient = ticket.AgreedCost ||
      ((partsSalePrice?.total || 0) + servicePriceToClient + usagePriceToClient + (ticket.LaborCost || 0));
    const expectedProfit = totalPriceToClient - totalCostOnUs;

    return {
      success: true,
      partsCostOnUs,
      partsSalePrice: partsSalePrice?.total || 0,
      serviceCostOnUs,
      servicePriceToClient,
      usageCostOnUs,
      usagePriceToClient,
      laborCost: ticket.LaborCost || 0,
      totalCostOnUs,
      totalPriceToClient,
      expectedProfit,
      profitMargin: totalPriceToClient > 0 ? ((expectedProfit / totalPriceToClient) * 100).toFixed(1) : '0'
    };
  });

  // ===== DELIVER (also creates sale invoice) =====
  ipcMain.handle('maintenance:deliver', async (_event, data: {
    TicketID: number; CustomerID?: number; CustomerName: string; CustomerPhone?: string;
    LaborCost: number; AdditionalCosts: { Description: string; Amount: number }[];
    PaymentMethod: string; PaidAmount: number;
    CashAccountID?: number; PaymentMethodID?: number;
    Discount?: number; FinalPrice?: number; FinalNotes?: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();

    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID) as any;
    if (!ticket) return { success: false, message: 'التذكرة غير موجودة' };
    const partsCost = ticket.PartsCost || 0;
    const additionalTotal = data.AdditionalCosts.reduce((sum, a) => sum + a.Amount, 0);

    // Get service costs
    const svcCosts = db.prepare('SELECT SUM(PriceToClient) as total FROM maintenance_service_costs WHERE TicketID = ?').get(data.TicketID) as any;
    const svcUsage = db.prepare('SELECT SUM(PriceToClient * Quantity) as total FROM maintenance_service_usage WHERE TicketID = ?').get(data.TicketID) as any;
    const serviceCostTotal = (svcCosts?.total || 0) + (svcUsage?.total || 0);

    // Get cost on us
    const costOnUsParts = partsCost;
    const costOnUsSvc = (db.prepare('SELECT SUM(CostOnUs) as total FROM maintenance_service_costs WHERE TicketID = ?').get(data.TicketID) as any)?.total || 0;
    const costOnUsUsage = (db.prepare('SELECT SUM(CostOnUs * Quantity) as total FROM maintenance_service_usage WHERE TicketID = ?').get(data.TicketID) as any)?.total || 0;
    const totalCostOnUs = costOnUsParts + costOnUsSvc + costOnUsUsage;

    // Parts sale price (use mp.SalePrice if set, else fallback to i.SalePrice)
    const partsSalePrice = (db.prepare(`
      SELECT COALESCE(SUM(COALESCE(mp.SalePrice, i.SalePrice, 0) * mp.Quantity), 0) as total
      FROM maintenance_parts mp
      JOIN items i ON mp.ItemID = i.ItemID WHERE mp.TicketID = ?
    `).get(data.TicketID) as any)?.total || 0;

    const isWarranty = ticket.MaintenanceType === 'warranty' || ticket.MaintenanceType === 'rework';

    const grossTotal = isWarranty ? 0 : (partsSalePrice + serviceCostTotal + data.LaborCost + additionalTotal);
    const discount = isWarranty ? 0 : (data.Discount || 0);
    const totalCost = isWarranty ? 0 : (data.FinalPrice || (grossTotal - discount));
    const paidAmount = isWarranty ? 0 : data.PaidAmount;
    const remaining = isWarranty ? 0 : (totalCost - paidAmount);
    const totalProfit = isWarranty ? (0 - totalCostOnUs) : (totalCost - totalCostOnUs);

    const dateStr = new Date().toISOString().split('T')[0];
    const deliveryNumber = nextDocNumber(db, 'maintenance_deliveries', 'DeliveryNumber', 'DLV', dateStr);

    // Sale number
    const saleNumber = nextDocNumber(db, 'sales', 'SaleNumber', 'INV', dateStr);

    const tx = db.transaction(() => {
      // 1. Create delivery record — use ticket.CustomerID as fallback
      const effectiveCustomerId = data.CustomerID ?? ticket.CustomerID ?? null;
      const effectiveCustomerName = data.CustomerName || ticket.CustomerName || 'عميل';
      const result = db.prepare(`
        INSERT INTO maintenance_deliveries (DeliveryNumber, TicketID, Date, CustomerID, CustomerName,
          PartsCost, LaborCost, AdditionalCosts, TotalCost, PaidAmount, RemainingAmount,
          PaymentMethod, CashAccountID, PaymentMethodID, UserID,
          ServiceCostTotal, TotalCostOnUs, TotalProfit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliveryNumber, data.TicketID, dateStr, effectiveCustomerId, effectiveCustomerName,
        partsCost, isWarranty ? 0 : data.LaborCost, isWarranty ? 0 : additionalTotal, totalCost, paidAmount, remaining,
        isWarranty ? 'warranty' : data.PaymentMethod,
        data.PaymentMethodID ? null : (data.CashAccountID ?? null), data.PaymentMethodID ?? null, data.userId,
        serviceCostTotal, totalCostOnUs, totalProfit
      );

      const deliveryId = result.lastInsertRowid;

      for (const ac of data.AdditionalCosts) {
        db.prepare('INSERT INTO maintenance_additional_costs (DeliveryID, Description, Amount) VALUES (?, ?, ?)').run(deliveryId, ac.Description, ac.Amount);
      }

      // 2. Create sale invoice (for customer - no costs/profits shown)
      const customerName = effectiveCustomerName;
      const customerPhone = data.CustomerPhone || ticket.CustomerPhone;
      const saleNotes = isWarranty
        ? (data.FinalNotes || `صيانة على الضمان - ${ticket.DeviceModel}` + (ticket.ReferenceTicketID ? ` - مرجع: التذكرة #${ticket.ReferenceTicketID}` : ''))
        : (data.FinalNotes || `تسليم صيانة - ${ticket.DeviceModel}`);
      const saleResult = db.prepare(`
        INSERT INTO sales (SaleNumber, FiscalYearID, Date, CustomerID, CustomerName, CustomerPhone,
          Subtotal, Discount, TaxRate, TaxAmount, TotalAmount, PaidAmount, RemainingAmount,
          PaymentMethod, CashAccountID, PaymentMethodID, Status, UserID, Notes, Source, SourceID, IsWarranty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 'maintenance', ?, ?)
      `).run(
        saleNumber, data.fiscalYearId, dateStr, effectiveCustomerId, customerName, customerPhone,
        totalCost, discount, totalCost, paidAmount, remaining,
        isWarranty ? 'warranty' : data.PaymentMethod, null, null, data.userId,
        saleNotes, deliveryId, isWarranty ? 1 : 0
      );

      const saleId = saleResult.lastInsertRowid;

      // Add sale detail items.
      // These rows are for PRINTING the customer invoice only — the parts were
      // already deducted from stock by maintenance:issuePart, and are restored
      // from `maintenance_parts` by cancel/return. They intentionally carry a
      // NULL WarehouseID so the generic sale-reversal logic skips them and does
      // not credit the same parts to stock a second time.
      const parts = db.prepare('SELECT mp.*, i.ItemName FROM maintenance_parts mp JOIN items i ON mp.ItemID = i.ItemID WHERE mp.TicketID = ?').all(data.TicketID) as any[];
      for (const p of parts) {
        const unitPrice = isWarranty ? 0 : (p.SalePrice || p.UnitCost);
        db.prepare(`
          INSERT INTO sale_details (SaleID, ItemID, Quantity, UnitPrice, UnitCost, Total, Description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(saleId, p.ItemID, p.Quantity, unitPrice, p.UnitCost, unitPrice * p.Quantity, p.ItemName);
      }

      // Service costs as service line items
      const svcCosts2 = db.prepare('SELECT * FROM maintenance_service_costs WHERE TicketID = ?').all(data.TicketID) as any[];
      for (const sc of svcCosts2) {
        const priceToClient = isWarranty ? 0 : sc.PriceToClient;
        db.prepare(`
          INSERT INTO sale_details (SaleID, ItemID, Quantity, UnitPrice, UnitCost, Total, Description)
          VALUES (?, NULL, 1, ?, ?, ?, ?)
        `).run(saleId, priceToClient, sc.CostOnUs, priceToClient, sc.Description);
      }

      const svcUsage2 = db.prepare('SELECT * FROM maintenance_service_usage WHERE TicketID = ?').all(data.TicketID) as any[];
      for (const su of svcUsage2) {
        const priceToClient = isWarranty ? 0 : su.PriceToClient;
        db.prepare(`
          INSERT INTO sale_details (SaleID, ItemID, Quantity, UnitPrice, UnitCost, Total, Description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(saleId, su.ItemID ?? null, su.Quantity, priceToClient, su.CostOnUs, priceToClient * su.Quantity, su.Description);
      }

      // Labor as service line
      if (data.LaborCost > 0) {
        const laborPrice = isWarranty ? 0 : data.LaborCost;
        db.prepare(`
          INSERT INTO sale_details (SaleID, ItemID, Quantity, UnitPrice, UnitCost, Total, Description)
          VALUES (?, NULL, 1, ?, 0, ?, ?)
        `).run(saleId, laborPrice, laborPrice, 'أجرة صيانة');
      }

      // Additional costs
      for (const ac of data.AdditionalCosts) {
        const acPrice = isWarranty ? 0 : ac.Amount;
        db.prepare(`
          INSERT INTO sale_details (SaleID, ItemID, Quantity, UnitPrice, UnitCost, Total, Description)
          VALUES (?, NULL, 1, ?, ?, ?, ?)
        `).run(saleId, acPrice, 0, acPrice, ac.Description);
      }

      // 3. Update ticket
      db.prepare("UPDATE maintenance_tickets SET Status = 'delivered', TotalCost = ?, LaborCost = ? WHERE TicketID = ?")
        .run(totalCost, isWarranty ? 0 : data.LaborCost, data.TicketID);

      const deliveryNote = isWarranty
        ? `تم تسليم الجهاز (صيانة ضمان) - الفاتورة: ${saleNumber}`
        : `تم تسليم الجهاز - الفاتورة: ${saleNumber}`;
      db.prepare(`
        INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
        VALUES (?, 'delivered', ?, ?)
      `).run(data.TicketID, deliveryNote, data.userId);

      // 4. Update delivery with sale ID
      db.prepare('UPDATE maintenance_deliveries SET SaleID = ? WHERE DeliveryID = ?').run(saleId, deliveryId);

      // 5. Customer balance (skip for warranty — invoice is zero)
      if (!isWarranty && effectiveCustomerId && remaining > 0) {
        db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(remaining, effectiveCustomerId);
      } else if (!isWarranty && effectiveCustomerId && remaining < 0) {
        db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(Math.abs(remaining), effectiveCustomerId);
      }

      // 6. Cash account (skip for warranty — no payment)
      // The money lands in exactly ONE account. These used to be two separate
      // `if`s, so choosing both a cash account and a machine credited the paid
      // amount twice and invented cash.
      if (!isWarranty && paidAmount > 0) {
        if (data.PaymentMethodID) {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(paidAmount, data.PaymentMethodID);
        } else if (data.CashAccountID) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(paidAmount, data.CashAccountID);
        }
      }

      // 7. Technician commission (skip for warranty — no labor income)
      if (!isWarranty && ticket.TechnicianID && data.LaborCost > 0) {
        db.prepare(`
          INSERT INTO commissions (EmployeeID, CommissionType, Amount, Date, ReferenceType, ReferenceID, IsPaid, PaidAmount, FiscalYearID, UserID)
          VALUES (?, 'maintenance', ?, ?, 'maintenance_delivery', ?, 0, 0, ?, ?)
        `).run(ticket.TechnicianID, data.LaborCost, dateStr, deliveryId, data.fiscalYearId, data.userId);
      }
    });

    tx();
    return {
      success: true, deliveryNumber, saleNumber,
      totalCost, totalCostOnUs, totalProfit, remaining,
      totalPartsCost: partsCost,
      serviceCostTotal,
      totalAdditional: additionalTotal,
      isWarranty
    };
  });

  // ===== CANCEL ticket =====
  ipcMain.handle('maintenance:cancel', async (_event, data: {
    TicketID: number; Reason: string; userId: number;
  }) => {
    if (!data.Reason.trim()) return { success: false, message: 'سبب الإلغاء مطلوب' };
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID) as any;
    if (!ticket) return { success: false, message: 'التذكرة غير موجودة' };
    if (ticket.Status === 'delivered') return { success: false, message: 'لا يمكن إلغاء تذكرة تم تسليمها - استخدم المرتجع' };

    db.transaction(() => {
      // Restore parts to stock
      const parts = db.prepare('SELECT * FROM maintenance_parts WHERE TicketID = ?').all(data.TicketID) as any[];
      for (const p of parts) {
        restoreStock(db, p.ItemID, p.WarehouseID, p.Quantity, p.UnitCost || 0);
      }

      db.prepare("UPDATE maintenance_tickets SET Status = 'cancelled' WHERE TicketID = ?").run(data.TicketID);
      db.prepare(`
        INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
        VALUES (?, 'cancelled', ?, ?)
      `).run(data.TicketID, data.Reason, data.userId);
    })();
    return { success: true };
  });

  // ===== WARRANTY HISTORY — get all related tickets for a device =====
  ipcMain.handle('maintenance:getWarrantyHistory', async (_event, ticketId: number) => {
    const db = getDb();
    // Find the root ticket (either this is the root, or find the root via ReferenceTicketID)
    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(ticketId) as any;
    if (!ticket) return [];

    const rootId = ticket.ReferenceTicketID || ticketId;
    // Get root + all tickets referencing the root
    const history = db.prepare(`
      SELECT t.TicketID, t.TicketNumber, t.Date, t.Status, t.MaintenanceType, t.DeviceModel,
             t.ProblemDesc, t.TotalCost, t.PartsCost, t.LaborCost,
             c.Name as CustomerName, e.Name as TechnicianName
      FROM maintenance_tickets t
      LEFT JOIN customers c ON t.CustomerID = c.CustomerID
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      WHERE t.TicketID = ? OR t.ReferenceTicketID = ?
      ORDER BY t.Date ASC, t.TicketID ASC
    `).all(rootId, rootId) as any[];
    return history;
  });

  // ===== RETURN (existing, enhanced) =====
  ipcMain.handle('maintenance:return', async (_event, data: {
    DeliveryID: number; TicketID: number; Reason: string;
    TotalRefund: number; CashAccountID?: number; PartsRestored: number; userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    if (!data.Reason.trim()) return { success: false, message: 'سبب المرتجع مطلوب' };
    const dateStr = new Date().toISOString().split('T')[0];
    const returnNumber = nextDocNumber(db, 'maintenance_returns', 'ReturnNumber', 'MRT', dateStr);

    // Check sufficient cash for refund (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;
    if (allowNegCash?.Value !== '1' && data.CashAccountID && data.TotalRefund > 0) {
      const acc = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc || (acc.Balance || 0) < data.TotalRefund) {
        return { success: false, message: `الرصيد غير كافٍ في الخزينة لرد المبلغ: المتاح ${(acc?.Balance || 0).toFixed(2)}، المطلوب ${data.TotalRefund.toFixed(2)}` };
      }
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO maintenance_returns (ReturnNumber, DeliveryID, TicketID, Date, Reason, TotalRefund, CashAccountID, PartsRestored, UserID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnNumber, data.DeliveryID, data.TicketID, dateStr, data.Reason, data.TotalRefund, data.CashAccountID ?? null, data.PartsRestored, data.userId);

      if (data.PartsRestored === 1) {
        const parts = db.prepare('SELECT * FROM maintenance_parts WHERE TicketID = ?').all(data.TicketID) as any[];
        for (const part of parts) {
          restoreStock(db, part.ItemID, part.WarehouseID, part.Quantity, part.UnitCost || 0);
        }
      }

      db.prepare("UPDATE maintenance_tickets SET Status = 'returned' WHERE TicketID = ?").run(data.TicketID);
      db.prepare(`
        INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
        VALUES (?, 'returned', ?, ?)
      `).run(data.TicketID, data.Reason, data.userId);

      const delivery = db.prepare('SELECT * FROM maintenance_deliveries WHERE DeliveryID = ?').get(data.DeliveryID) as any;

      // Reverse cash account
      if (data.CashAccountID && data.TotalRefund > 0) {
        db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.TotalRefund, data.CashAccountID);
      }

      // Reverse payment method
      if (delivery?.PaymentMethodID && data.TotalRefund > 0) {
        db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(data.TotalRefund, delivery.PaymentMethodID);
      }

      // Reverse customer balance
      if (delivery?.CustomerID) {
        db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(data.TotalRefund, delivery.CustomerID);
      }

      db.prepare("UPDATE commissions SET IsPaid = 0, PaidAmount = 0 WHERE ReferenceType = 'maintenance_delivery' AND ReferenceID = ?").run(data.DeliveryID);
    });

    tx();
    return { success: true, returnNumber };
  });
}
