import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { getCallerUserId } from '../security/ipcGuard';
import { nextDocNumber } from '../database/docNumber';
import { deductStock, restoreStock, restoreStockAtCost } from '../database/stock';
import { businessToday, resolveDocDate } from '../../shared/businessDate';
import {
  oneOf, requireText, optionalText, optionalNote, optionalDate, optionalId, requireId,
  LIMITS, MAINTENANCE_WORKFLOW_STATUSES,
} from '../../shared/validate';
import { checkAmount, checkAmounts } from '../../shared/money';

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
    AgreedDeliveryDate?: string; AgreedCost?: number | string;
    TechnicianID?: number; userId: number; fiscalYearId: number;
    MaintenanceType?: string; ReferenceTicketID?: number;
  }) => {
    const db = getDb();

    // Validated at the door, because everything below binds straight into SQL.
    //
    // MEASURED before this: `CustomerID: {}` threw
    // "Provided value cannot be bound to SQLite parameter 4." OUT of the
    // handler. That is a better-sqlite3 diagnostic naming a parameter
    // position — useless to the shopkeeper, and it describes the statement to
    // anyone else. Rejecting the value is better than catching the error it
    // causes.
    const rcvCustomerId = optionalId(data?.CustomerID, 'العميل');
    if (!rcvCustomerId.ok) return { success: false, message: rcvCustomerId.message };
    if (rcvCustomerId.value !== null) {
      const exists = db.prepare('SELECT 1 AS ok FROM customers WHERE CustomerID = ?').get(rcvCustomerId.value);
      if (!exists) return { success: false, message: 'العميل غير موجود' };
    }
    const rcvTechId = optionalId(data?.TechnicianID, 'الفني');
    if (!rcvTechId.ok) return { success: false, message: rcvTechId.message };
    const rcvRefTicket = optionalId(data?.ReferenceTicketID, 'التذكرة المرجعية');
    if (!rcvRefTicket.ok) return { success: false, message: rcvRefTicket.message };

    const rcvName = requireText(data?.CustomerName, 'اسم العميل', LIMITS.NAME);
    if (!rcvName.ok) return { success: false, message: rcvName.message };
    const rcvPhone = optionalText(data?.CustomerPhone, 'هاتف العميل', LIMITS.PHONE);
    if (!rcvPhone.ok) return { success: false, message: rcvPhone.message };
    const rcvModel = requireText(data?.DeviceModel, 'موديل الجهاز', LIMITS.NAME);
    if (!rcvModel.ok) return { success: false, message: rcvModel.message };
    const rcvImei = optionalText(data?.DeviceIMEI, 'رقم IMEI', LIMITS.CODE);
    if (!rcvImei.ok) return { success: false, message: rcvImei.message };
    const rcvProblem = requireText(data?.ProblemDesc, 'وصف العطل', LIMITS.NOTES);
    if (!rcvProblem.ok) return { success: false, message: rcvProblem.message };
    const rcvAccessories = optionalNote(data?.Accessories, 'الملحقات', LIMITS.NOTES);
    if (!rcvAccessories.ok) return { success: false, message: rcvAccessories.message };
    const rcvPassword = optionalText(data?.DevicePassword, 'كلمة مرور الجهاز', LIMITS.CODE);
    if (!rcvPassword.ok) return { success: false, message: rcvPassword.message };
    const rcvDeliveryDate = optionalDate(data?.AgreedDeliveryDate, 'تاريخ التسليم المتفق عليه');
    if (!rcvDeliveryDate.ok) return { success: false, message: rcvDeliveryDate.message };

    // The agreed cost is bound straight into SQL below, so it is checked here
    // like every other amount in the program. Before this, a minus sign
    // (AgreedCost = -500) or a paste of garbage (NaN) travelled all the way
    // into the ticket: the negative price was stored and the NaN bound as NULL
    // via better-sqlite3's own coercion — both recorded as valid repairs.
    // An empty string from the form means "no agreement" and is treated as
    // absent, the same way every other optional field is handled here.
    let rcvAgreedCost: number | null = null;
    if (data?.AgreedCost !== undefined && data?.AgreedCost !== null
      && !(typeof data.AgreedCost === 'string' && data.AgreedCost.trim() === '')) {
      const chkCost = checkAmount(data.AgreedCost, 'التكلفة المتفق عليها');
      if (!chkCost.ok) return { success: false, message: chkCost.message };
      rcvAgreedCost = chkCost.value;
    }

    data = {
      ...data,
      CustomerID: rcvCustomerId.value ?? undefined,
      TechnicianID: rcvTechId.value ?? undefined,
      ReferenceTicketID: rcvRefTicket.value ?? undefined,
      CustomerName: rcvName.value,
      CustomerPhone: rcvPhone.value ?? '',
      DeviceModel: rcvModel.value,
      DeviceIMEI: rcvImei.value ?? undefined,
      ProblemDesc: rcvProblem.value,
      Accessories: rcvAccessories.value ?? undefined,
      DevicePassword: rcvPassword.value ?? undefined,
      AgreedDeliveryDate: rcvDeliveryDate.value ?? undefined,
      AgreedCost: rcvAgreedCost ?? undefined,
    };

    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
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
    // `notes.trim()` on a non-string threw a TypeError that the guard turned
    // into a generic "operation failed", hiding which field was wrong.
    const note = requireText(notes, 'الملاحظات', LIMITS.NOTES);
    if (!note.ok) {
      return { success: false, message: 'الملاحظات إجبارية عند تغيير الحالة' };
    }

    // The status is a workflow position, and this handler may only move the
    // ticket WITHIN the workshop.
    //
    // It accepted any string at all. Two separate failures came out of that:
    //
    //   1. An unrecognised value — measured with `'ANYTHING'` and with `''` —
    //      was stored, and the ticket then matched no filter on the
    //      maintenance screen. The device was in the shop and invisible.
    //
    //   2. Far worse, `'delivered'` was accepted. `maintenance:deliver` is the
    //      handler that raises the invoice, banks the payment, books the
    //      technician commission and consumes the parts, and it refuses a
    //      ticket whose status is already `delivered`. So one call to THIS
    //      channel marked the device handed over and permanently locked the
    //      only path that bills for it. MEASURED on a ticket with an agreed
    //      cost of 800: after `updateStatus(..., 'delivered', ...)`,
    //      `maintenance:deliver` answered "تم تسليم هذه التذكرة بالفعل",
    //      deliveries recorded 0, cash unchanged at 10,000, customer balance
    //      0. The repair was done, the phone was gone, and the 800 could never
    //      be charged.
    //
    // `delivered`, `cancelled` and `returned` are therefore reachable only
    // through `maintenance:deliver`, `:cancel` and `:return`, each of which
    // writes the money side in the same transaction as the status.
    const st = oneOf(status, 'حالة التذكرة', MAINTENANCE_WORKFLOW_STATUSES);
    if (!st.ok) {
      return {
        success: false,
        message: 'حالة التذكرة غير صالحة. التسليم والإلغاء والإرجاع تتم من '
          + 'أزرارها الخاصة حتى تُسجَّل الفاتورة والمبالغ معها.',
      };
    }
    status = st.value;
    notes = note.value;

    const db = getDb();

    // A ticket that has already been delivered, cancelled or returned is
    // finished. Moving it back to `in_progress` would let it be delivered a
    // SECOND time — a second invoice and a second payment for one repair.
    const current = db.prepare(
      'SELECT Status FROM maintenance_tickets WHERE TicketID = ?').get(ticketId) as any;
    if (!current) return { success: false, message: 'التذكرة غير موجودة' };
    if (current.Status === 'delivered' || current.Status === 'cancelled') {
      return {
        success: false,
        message: `التذكرة ${statusLabels[current.Status] || current.Status} - لا يمكن تغيير حالتها`,
      };
    }

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
    // Bound straight into SQL below; an absent id threw
    // "Provided value cannot be bound to SQLite parameter 1." out of the handler.
    for (const [val, label] of [[data?.TicketID, 'التذكرة'], [data?.ItemID, 'الصنف'], [data?.WarehouseID, 'المخزن']] as const) {
      const chk = requireId(val, label);
      if (!chk.ok) return { success: false, message: chk.message };
    }
    // Existence checks, before anything is read from stock. Before these,
    // a part issued against a non-existent TICKET blew up on the foreign key
    // (the raw "FOREIGN KEY constraint failed" escaped to the caller), and a
    // non-existent item or warehouse was refused with a misleading stock
    // message — "الكمية غير متوفرة في المخزن: المطلوب 1، المتاح 0" — even
    // though no such shelf exists to be short.
    if (!db.prepare('SELECT 1 AS ok FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID)) {
      return { success: false, message: 'التذكرة غير موجودة' };
    }
    if (!db.prepare('SELECT 1 AS ok FROM items WHERE ItemID = ?').get(data.ItemID)) {
      return { success: false, message: 'الصنف غير موجود' };
    }
    if (!db.prepare('SELECT WarehouseID FROM warehouses WHERE WarehouseID = ?').get(data.WarehouseID)) {
      return { success: false, message: 'المخزن المختار غير موجود' };
    }
    // The quantity is bound straight into SQL and fed to deductStock, so it is
    // checked like every quantity in the program. Before this, Quantity = 0
    // booked a zero-cost part row onto the ticket, and a negative Quantity
    // wrote a part the shop would be billed for backwards — while NaN, which
    // better-sqlite3 coerces to NULL, crashed on the column's NOT NULL.
    const badQty = checkAmounts([[data?.Quantity, 'الكمية', { allowZero: false }]]);
    if (badQty) return { success: false, message: badQty };
    const issueTicket = db.prepare('SELECT Status FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID) as any;
    if (!issueTicket) {
      return { success: false, message: 'التذكرة غير موجودة' };
    }
    // A terminal ticket can never be billed again: a part issued after
    // delivery leaves the shelf with no invoice to charge it on. Before this,
    // `maintenance:deliver` then `maintenance:issuePart` booked the part, and
    // the stock was gone with the only record of it sitting on a closed file.
    if (issueTicket.Status === 'delivered' || issueTicket.Status === 'cancelled' || issueTicket.Status === 'returned') {
      return { success: false, message: 'التذكرة منتهية - لا يمكن إضافة قطع' };
    }
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
    // What the CUSTOMER is charged for the part.
    //
    // This used to be `data.SalePrice ?? 0`, which stored a literal 0 whenever
    // the screen did not send a price — and the screen usually does not,
    // because the natural answer is "the item's normal selling price".
    //
    // A stored 0 then defeated the two places that try to recover from it:
    //
    //   1. `maintenance:deliver` computes the invoice total with
    //      `COALESCE(mp.SalePrice, i.SalePrice, 0)`. COALESCE only skips NULL,
    //      never 0, so the item's real price was never reached.
    //   2. the invoice LINE fell back to `p.SalePrice || p.UnitCost`, which
    //      does treat 0 as missing — and charged the customer the COST price.
    //
    // Two different fallbacks for the same missing value, disagreeing with
    // each other. MEASURED on a two-part repair with a part costing 10 and
    // selling at 20: the invoice header said 100 while its own lines added up
    // to 120, and the shop billed 10 for a part it sells for 20 — its entire
    // parts margin, on every repair, silently.
    //
    // Resolved at the source: fall back to the item's selling price here, so
    // both readers see one figure. NULL is stored only when the item genuinely
    // has no price, which is the case COALESCE was written for.
    const itemSalePrice = (db.prepare('SELECT SalePrice FROM items WHERE ItemID = ?')
      .get(data.ItemID) as any)?.SalePrice ?? null;
    const salePrice = (data.SalePrice !== undefined && data.SalePrice !== null)
      ? data.SalePrice
      : itemSalePrice;
    const totalCost = unitCost * data.Quantity;
    const totalSale = (salePrice ?? 0) * data.Quantity;

    // Check sufficient stock (unless negative stock allowed)
    const allowNegStock = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;

    // The availability check must run UNDER the write lock. The old check
    // read the shelf BEFORE the transaction bound the lock, so a rival flow
    // emptying the warehouse in between was never seen — the part was issued
    // anyway and the pool went negative even with negative stock switched off.
    // MEASURED with the race probe: shelf 100, rival empties it after the
    // check, issue of 2 succeeds and lands at -2.
    try {
      db.transaction(() => {
        if (allowNegStock?.Value !== '1') {
          const stockQty = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(data.ItemID, data.WarehouseID) as any;
          if ((stockQty?.qty || 0) < data.Quantity) {
            const e = new Error(`الكمية غير متوفرة في المخزن: المطلوب ${data.Quantity}، المتاح ${stockQty?.qty || 0}`);
            (e as any).userRefusal = true;
            throw e;
          }
        }

        db.prepare(`
          INSERT INTO maintenance_parts (TicketID, ItemID, Quantity, UnitCost, TotalCost, SalePrice, WarehouseID, IssuedByUserID)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(data.TicketID, data.ItemID, data.Quantity, unitCost, totalCost, salePrice, data.WarehouseID, data.userId);

        // Deduct from the exact warehouse the cost was read from.
        deductStock(db, data.ItemID, data.WarehouseID, data.Quantity);

        db.prepare('UPDATE maintenance_tickets SET PartsCost = PartsCost + ?, TotalCost = TotalCost + ? WHERE TicketID = ?')
          .run(totalCost, totalSale || totalCost, data.TicketID);
      })();
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      throw err;
    }

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

      // The units go back into the exact cost layers they were drawn from.
      // The old `restoreStock` only refilled the pool; the layers kept the
      // deduction, so every removed part left the books short by its own
      // cost — the inventory report said 100 units but the layers claimed
      // 98 still issued, and the missing value sat in no account anywhere.
      restoreStockAtCost(db, part.ItemID, part.WarehouseID, part.Quantity, part.UnitCost || 0);

      // `TotalCost` is what the CUSTOMER is charged, `PartsCost` is what the
      // part cost the shop. Issuing a part adds the SALE value to TotalCost and
      // the COST value to PartsCost, so removing it has to take those same two
      // figures back out.
      //
      // Both were previously reversed with `part.TotalCost`, which is the cost.
      // A part costing 200 and sold at 500 therefore left 300 behind on the
      // ticket every time it was removed — money charged to a customer for a
      // part that is no longer on the repair, and which nothing else ever
      // cleared.
      const chargedBack = (part.SalePrice ? part.SalePrice * part.Quantity : part.TotalCost) || 0;
      db.prepare('UPDATE maintenance_tickets SET PartsCost = MAX(0, PartsCost - ?), TotalCost = MAX(0, TotalCost - ?) WHERE TicketID = ?')
        .run(part.TotalCost, chargedBack, ticketId);
    })();
    return { success: true };
  });

  // ===== SERVICE COSTS (manual services like software) =====
  ipcMain.handle('maintenance:addServiceCost', async (_event, data: {
    TicketID: number; Description: string; CostOnUs: number; PriceToClient: number; userId: number;
  }) => {
    const svcDesc = requireText(data?.Description, 'وصف الخدمة', LIMITS.DESCRIPTION);
    if (!svcDesc.ok) return { success: false, message: 'وصف الخدمة مطلوب' };
    const svcTicket = requireId(data?.TicketID, 'التذكرة');
    if (!svcTicket.ok) return { success: false, message: svcTicket.message };
    // Both prices are bound straight into SQL and feed the profit summary, so
    // they are checked like every other amount. Before this, a negative
    // PriceToClient reduced the customer's bill while recording the service,
    // a negative CostOnUs inflated the profit, and NaN quietly bound as 0 —
    // all three accepted as successful rows.
    const badSvc = checkAmounts([
      [data?.CostOnUs, 'تكلفة الخدمة علينا'],
      [data?.PriceToClient, 'سعر الخدمة للعميل'],
    ]);
    if (badSvc) return { success: false, message: badSvc };
    data = { ...data, Description: svcDesc.value, TicketID: svcTicket.value };
    const db = getDb();
    // The TicketID is bound into an FK column below; a non-existent ticket
    // crashed with the raw "FOREIGN KEY constraint failed" instead of a reply.
    if (!db.prepare('SELECT 1 AS ok FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID)) {
      return { success: false, message: 'التذكرة غير موجودة' };
    }
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
    const useDesc = requireText(data?.Description, 'وصف الخدمة', LIMITS.DESCRIPTION);
    if (!useDesc.ok) return { success: false, message: 'وصف الخدمة مطلوب' };
    const useTicket = requireId(data?.TicketID, 'التذكرة');
    if (!useTicket.ok) return { success: false, message: useTicket.message };
    const badUse = checkAmounts([
      [data?.CostOnUs, 'تكلفة الخدمة علينا'],
      [data?.PriceToClient, 'سعر الخدمة للعميل'],
      [data?.Quantity ?? 1, 'الكمية', { allowZero: false }],
    ]);
    if (badUse) return { success: false, message: badUse };
    data = { ...data, Description: useDesc.value, TicketID: useTicket.value };
    const db = getDb();
    if (!db.prepare('SELECT 1 AS ok FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID)) {
      return { success: false, message: 'التذكرة غير موجودة' };
    }
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
    // `data.Content.trim()` threw "Cannot read properties of undefined"
    // when the key was absent — an uncaught TypeError across IPC rather than
    // a reply. requireText answers instead of throwing.
    const noteText = requireText(data?.Content, 'محتوى الملاحظة', LIMITS.NOTES);
    if (!noteText.ok) return { success: false, message: 'محتوى الملاحظة مطلوب' };
    const noteTicket = requireId(data?.TicketID, 'التذكرة');
    if (!noteTicket.ok) return { success: false, message: noteTicket.message };
    data = { ...data, Content: noteText.value, TicketID: noteTicket.value };
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
    LaborCost: number;
    PaymentMethod: string; PaidAmount: number;
    CashAccountID?: number; PaymentMethodID?: number;
    Discount?: number; FinalPrice?: number; FinalNotes?: string;
    userId: number; fiscalYearId: number;
  }) => {
    const db = getDb();
    const delTicket = requireId(data?.TicketID, 'التذكرة');
    if (!delTicket.ok) return { success: false, message: delTicket.message };

    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID) as any;
    if (!ticket) return { success: false, message: 'التذكرة غير موجودة' };

    // A ticket can only be handed over ONCE.
    //
    // Nothing checked the status, so calling this twice produced a second
    // delivery record, a second invoice, a second technician commission — and
    // banked the customer's payment again. The screen normally moves on after
    // the first delivery, but a double-click, a retry after a slow save, or any
    // direct call to the channel took the money twice, and the only trace was
    // two invoices the customer never received.
    if (ticket.Status === 'delivered') {
      return { success: false, message: 'تم تسليم هذه التذكرة بالفعل - لا يمكن تسليمها مرة أخرى' };
    }
    if (ticket.Status === 'cancelled') {
      return { success: false, message: 'التذكرة ملغاة - لا يمكن تسليمها' };
    }
    if (ticket.Status === 'returned') {
      return { success: false, message: 'التذكرة مرتجعة - لا يمكن تسليمها مرة أخرى' };
    }

    // Money may not be negative.
    //
    // Nothing validated these, so labour of -500 produced a bill of -500: the
    // shop "owed" the customer money for a repair it had just carried out, and
    // the negative flowed into the invoice, the customer balance and the profit
    // report. A discount is the supported way to reduce a bill.
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
    for (const [label, value] of [
      ['أجرة الصيانة', data.LaborCost],
      ['المدفوع', data.PaidAmount],
      ['الخصم', data.Discount ?? 0],
    ] as const) {
      const v = num(value ?? 0);
      if (!Number.isFinite(v) || v < 0) {
        return { success: false, message: `${label} يجب أن يكون رقماً غير سالب` };
      }
    }
    if (data.FinalPrice != null) {
      const fp = num(data.FinalPrice);
      if (!Number.isFinite(fp) || fp < 0) {
        return { success: false, message: 'السعر النهائي يجب أن يكون رقماً غير سالب' };
      }
    }

    const partsCost = ticket.PartsCost || 0;

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

    const grossTotal = isWarranty ? 0 : (partsSalePrice + serviceCostTotal + data.LaborCost);
    const discount = isWarranty ? 0 : (data.Discount || 0);
    // A discount larger than the goods turns the invoice negative, which the
    // sale trigger rejects with a raw "sale total must not be negative" crash.
    // Same rule as the sales/purchases handlers: the customer may be
    // discounted down to zero, never into the shop's pocket.
    if (!isWarranty && discount > grossTotal) {
      return {
        success: false,
        message: `الخصم (${discount.toFixed(2)}) أكبر من إجمالي الأصناف (${grossTotal.toFixed(2)})`,
      };
    }
    // `data.FinalPrice || (grossTotal - discount)` swallowed an explicit ZERO:
    // a free override ("استلم الجهاز بلا مقابل") fell through to the gross
    // total and the customer was billed the full repair. The explicit value
    // must win, whatever it is.
    const totalCost = isWarranty ? 0 : (data.FinalPrice != null ? data.FinalPrice : (grossTotal - discount));
    const paidAmount = isWarranty ? 0 : data.PaidAmount;
    const remaining = isWarranty ? 0 : (totalCost - paidAmount);
    const totalProfit = isWarranty ? (0 - totalCostOnUs) : (totalCost - totalCostOnUs);

    // The payment must land somewhere that exists and is active.
    //
    // Before this, `UPDATE ... WHERE CashAccountID = ?` against a missing or
    // inactive account affected zero rows and raised nothing: the customer
    // paid, the invoice said paid, and the money was nowhere. Crediting an
    // inactive account is just as bad — every report filters on IsActive = 1,
    // so the cash becomes invisible.
    if (!isWarranty && paidAmount > 0) {
      if (!data.PaymentMethodID && !data.CashAccountID) {
        return { success: false, message: 'اختر مصدر استلام المبلغ (خزنة أو ماكينة)' };
      }
      if (data.PaymentMethodID) {
        const pm = db.prepare('SELECT IsActive FROM payment_methods WHERE PaymentMethodID = ?').get(data.PaymentMethodID) as any;
        if (!pm) return { success: false, message: 'ماكينة الدفع المختارة غير موجودة' };
        if (!pm.IsActive) return { success: false, message: 'ماكينة الدفع المختارة غير مفعّلة' };
      } else if (data.CashAccountID) {
        const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
        if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
        if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
      }
    }

    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
    const deliveryNumber = nextDocNumber(db, 'maintenance_deliveries', 'DeliveryNumber', 'DLV', dateStr);

    // Sale number
    const saleNumber = nextDocNumber(db, 'sales', 'SaleNumber', 'INV', dateStr);

    const tx = db.transaction(() => {
      // 1. Create delivery record — use ticket.CustomerID as fallback
      const effectiveCustomerId = data.CustomerID ?? ticket.CustomerID ?? null;
      const effectiveCustomerName = data.CustomerName || ticket.CustomerName || 'عميل';
      const result = db.prepare(`
        INSERT INTO maintenance_deliveries (DeliveryNumber, TicketID, Date, CustomerID, CustomerName,
          PartsCost, LaborCost, TotalCost, PaidAmount, RemainingAmount,
          PaymentMethod, CashAccountID, PaymentMethodID, UserID,
          ServiceCostTotal, TotalCostOnUs, TotalProfit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliveryNumber, data.TicketID, dateStr, effectiveCustomerId, effectiveCustomerName,
        partsCost, isWarranty ? 0 : data.LaborCost, totalCost, paidAmount, remaining,
        isWarranty ? 'warranty' : data.PaymentMethod,
        data.PaymentMethodID ? null : (data.CashAccountID ?? null), data.PaymentMethodID ?? null, data.userId,
        serviceCostTotal, totalCostOnUs, totalProfit
      );

      const deliveryId = result.lastInsertRowid;

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
        // Subtotal is the GROSS, before the discount.
        //
        // It was passed `totalCost`, the figure AFTER the discount, so the
        // invoice contradicted itself: Subtotal - Discount no longer equalled
        // TotalAmount, and the printed lines (which are gross) added up to more
        // than the Subtotal they were supposed to sum to. Any report checking
        // an invoice against its own lines saw every discounted repair as
        // corrupt.
        //
        // When the user overrides with `FinalPrice` the discount is whatever
        // that override took off, so the identity still holds.
        isWarranty ? 0 : grossTotal, isWarranty ? 0 : (grossTotal - totalCost),
        totalCost, paidAmount, remaining,
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
      const parts = db.prepare(`SELECT mp.*, i.ItemName, i.SalePrice AS ItemSalePrice
        FROM maintenance_parts mp JOIN items i ON mp.ItemID = i.ItemID
        WHERE mp.TicketID = ?`).all(data.TicketID) as any[];
      for (const p of parts) {
        // The SAME fallback the invoice total uses — `COALESCE(mp.SalePrice,
        // i.SalePrice, 0)` — so the header and its lines cannot disagree.
        // `||` was used here and COALESCE there, which differ on 0, and that
        // difference charged the customer cost price on every repair.
        const grossUnit = p.SalePrice ?? p.ItemSalePrice ?? 0;
        const unitPrice = isWarranty ? 0 : grossUnit;
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
      isWarranty
    };
  });

  // ===== CANCEL ticket =====
  ipcMain.handle('maintenance:cancel', async (_event, data: {
    TicketID: number; Reason: string; userId: number;
  }) => {
    const cancelReason = requireText(data?.Reason, 'سبب الإلغاء', LIMITS.DESCRIPTION);
    if (!cancelReason.ok) return { success: false, message: 'سبب الإلغاء مطلوب' };
    const cancelTicket = requireId(data?.TicketID, 'التذكرة');
    if (!cancelTicket.ok) return { success: false, message: cancelTicket.message };
    data = { ...data, Reason: cancelReason.value, TicketID: cancelTicket.value };
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM maintenance_tickets WHERE TicketID = ?').get(data.TicketID) as any;
    if (!ticket) return { success: false, message: 'التذكرة غير موجودة' };
    if (ticket.Status === 'delivered') return { success: false, message: 'لا يمكن إلغاء تذكرة تم تسليمها - استخدم المرتجع' };
    // A returned ticket has already had its parts restored and its money
    // reversed — cancelling it too restored the SAME parts again and put the
    // books back on the wrong side. Measured: the double-restore put 98 units
    // back on a shelf that held 96.
    if (ticket.Status === 'returned') return { success: false, message: 'التذكرة مرتجعة - لا يمكن إلغاؤها' };
    if (ticket.Status === 'cancelled') return { success: false, message: 'التذكرة ملغاة بالفعل' };

    db.transaction(() => {
      // Restore parts to stock
      const parts = db.prepare('SELECT * FROM maintenance_parts WHERE TicketID = ?').all(data.TicketID) as any[];
      for (const p of parts) {
        // Into the exact cost layers they came out of — `restoreStock` only
        // refilled the pool and left the layers deducted (see removePart).
        restoreStockAtCost(db, p.ItemID, p.WarehouseID, p.Quantity, p.UnitCost || 0);
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
    const retReason = requireText(data?.Reason, 'سبب المرتجع', LIMITS.DESCRIPTION);
    if (!retReason.ok) return { success: false, message: 'سبب المرتجع مطلوب' };
    const retTicket = requireId(data?.TicketID, 'التذكرة');
    if (!retTicket.ok) return { success: false, message: retTicket.message };
    const retDelivery = requireId(data?.DeliveryID, 'التسليم');
    if (!retDelivery.ok) return { success: false, message: retDelivery.message };
    data = { ...data, Reason: retReason.value, TicketID: retTicket.value, DeliveryID: retDelivery.value };
    const dateStr = resolveDocDate(data as any);
    if (!dateStr) return { success: false, message: 'تاريخ المستند غير صالح' };
    const returnNumber = nextDocNumber(db, 'maintenance_returns', 'ReturnNumber', 'MRT', dateStr);

    // The return is a reversal of ONE specific delivery.
    const delivery = db.prepare('SELECT * FROM maintenance_deliveries WHERE DeliveryID = ?').get(data.DeliveryID) as any;
    if (!delivery) return { success: false, message: 'التسليم غير موجود' };
    if (delivery.TicketID !== data.TicketID) {
      return { success: false, message: 'هذا التسليم لا يتبع هذه التذكرة' };
    }
    // A delivery can only be returned once. Before this, calling the channel
    // again wrote a SECOND maintenance_returns row — the drawer refunded the
    // same job twice, and both rows summed into every returns report.
    const alreadyReturned = db.prepare('SELECT 1 AS ok FROM maintenance_returns WHERE DeliveryID = ?').get(data.DeliveryID);
    if (alreadyReturned) {
      return { success: false, message: 'هذا التسليم مرتجع بالفعل' };
    }
    // Refund money is checked like every other amount, and capped at what the
    // drawer actually received. Before this, a refund of 999,999 on a 255
    // delivery drained the till to cover money it never saw, and a negative
    // refund REVERSED into the till while recording a return.
    const refundMoney = checkAmount(data?.TotalRefund, 'قيمة المرتجع');
    if (!refundMoney.ok) return { success: false, message: refundMoney.message };
    const totalRefund = refundMoney.value;
    if (totalRefund > (delivery.PaidAmount || 0) + 0.001) {
      return { success: false, message: `قيمة المرتجع أكبر من المدفوع (${(delivery.PaidAmount || 0).toFixed(2)})` };
    }
    // A cash refund must name the drawer it leaves from; the machine leg is
    // served by the delivery's own payment method. Before this, a refund with
    // no destination recorded the return while the money stayed put.
    if (totalRefund > 0 && !delivery.PaymentMethodID) {
      if (!data.CashAccountID) {
        return { success: false, message: 'اختر الخزينة التي تخرج منها قيمة المرتجع' };
      }
      const acc = db.prepare('SELECT IsActive FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
      if (!acc) return { success: false, message: 'الخزنة المختارة غير موجودة' };
      if (!acc.IsActive) return { success: false, message: 'الخزنة المختارة غير مفعّلة' };
    }
    data.TotalRefund = totalRefund;

    // Check sufficient cash for refund (unless negative cash allowed)
    const allowNegCash = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_cash'").get() as any;

    try {
      const tx = db.transaction(() => {
        // The balance read above ran before the transaction bound the write
        // lock; a rival flow could drain the drawer in between, so the cash is
        // re-checked here under the lock (same defence as salaries:pay).
        if (allowNegCash?.Value !== '1' && data.CashAccountID && data.TotalRefund > 0) {
          const accTx = db.prepare('SELECT Balance FROM cash_accounts WHERE CashAccountID = ?').get(data.CashAccountID) as any;
          if (!accTx || (accTx.Balance || 0) < data.TotalRefund) {
            const e = new Error(`الرصيد غير كافٍ في الخزينة لرد المبلغ: المتاح ${(accTx?.Balance || 0).toFixed(2)}، المطلوب ${data.TotalRefund.toFixed(2)}`);
            (e as any).userRefusal = true;
            throw e;
          }
        }

        const result = db.prepare(`
          INSERT INTO maintenance_returns (ReturnNumber, DeliveryID, TicketID, Date, Reason, TotalRefund, CashAccountID, PartsRestored, UserID)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(returnNumber, data.DeliveryID, data.TicketID, dateStr, data.Reason, data.TotalRefund, data.CashAccountID ?? null, data.PartsRestored, data.userId);

        if (data.PartsRestored === 1) {
          const parts = db.prepare('SELECT * FROM maintenance_parts WHERE TicketID = ?').all(data.TicketID) as any[];
          for (const part of parts) {
            restoreStockAtCost(db, part.ItemID, part.WarehouseID, part.Quantity, part.UnitCost || 0);
          }
        }

        db.prepare("UPDATE maintenance_tickets SET Status = 'returned' WHERE TicketID = ?").run(data.TicketID);
        db.prepare(`
          INSERT INTO maintenance_status_log (TicketID, Status, Notes, UserID)
          VALUES (?, 'returned', ?, ?)
        `).run(data.TicketID, data.Reason, data.userId);

        // Reverse cash account
        if (data.CashAccountID && data.TotalRefund > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(data.TotalRefund, data.CashAccountID);
        }

        // Reverse payment method
        if (delivery?.PaymentMethodID && data.TotalRefund > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(data.TotalRefund, delivery.PaymentMethodID);
        }

        // Reverse the customer balance by what the DELIVERY put there, not by the
        // refund.
        //
        // The delivery adds only the UNPAID part of the bill to the customer's
        // account; the paid part went into the drawer. Subtracting the whole
        // refund here therefore removed money the customer never owed: a repair
        // charged 350 and paid in full left the balance at -350, so the shop
        // appeared to owe the customer 350 while also handing back the cash. The
        // full round trip cost the shop 350 out of nowhere.
        //
        // The two legs are now reversed independently: the drawer gives back what
        // it received (capped at the refund), and the account gives back only
        // what it was charged.
        // The debt the delivery created is cancelled IN FULL, independently of
        // the cash refund. They are two different legs of the same reversal:
        //
        //   the drawer  gives back what the customer actually paid   (TotalRefund)
        //   the account gives back what the customer was charged     (Remaining)
        //
        // Tying the account leg to the refund broke the commonest case of all —
        // a repair collected later. Nothing was paid, so nothing was refunded, so
        // nothing was cancelled, and the customer still owed 350 for a repair
        // that had been undone and whose parts were back on the shelf.
        if (delivery?.CustomerID) {
          const owedOnDelivery = Math.max(0, delivery.RemainingAmount || 0);
          if (owedOnDelivery > 0) {
            db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?')
              .run(owedOnDelivery, delivery.CustomerID);
          }
        }

        // A refunded job earns nothing. Resetting the commission to unpaid
        // (IsPaid = 0) left its Amount on the technician's account and the
        // employees report — the technician was still owed 300 for a job the
        // shop had taken back.
        db.prepare("DELETE FROM commissions WHERE ReferenceType = 'maintenance_delivery' AND ReferenceID = ?").run(data.DeliveryID);
      });

      tx();
    } catch (err: any) {
      if (err?.userRefusal) return { success: false, message: err.message };
      throw err;
    }
    return { success: true, returnNumber };
  });
}
