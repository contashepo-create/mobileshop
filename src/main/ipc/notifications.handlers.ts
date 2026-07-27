import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import {
  NOTIFICATION_RULES, CATEGORY_LABELS, PRIORITY_ORDER, normalisePrefs, defaultPrefs,
  evaluateSuppression, ruleState, param, daysAgoIso, type Prefs, type Priority,
} from '../notifications/prefs';

function getNotifKey(notif: any): string {
  return `${notif.category}:${notif.action || ''}:${notif.actionId || ''}:${(notif.title || '').substring(0, 40)}`;
}

/**
 * Reads the shop's preferences, falling back to defaults on anything unusable.
 *
 * Never throws: the bell must keep working even if the row is missing, empty,
 * or contains malformed JSON left behind by a manual edit.
 */
function loadPrefs(): Prefs {
  try {
    const row = getDb()
      .prepare("SELECT Value FROM settings WHERE Key = 'notif_prefs'")
      .get() as any;
    return normalisePrefs(row?.Value ? JSON.parse(row.Value) : null);
  } catch {
    return defaultPrefs();
  }
}

export function registerSmartNotificationsHandlers() {
  // Dismiss a notification permanently.
  //
  // Uses an explicit upsert rather than INSERT OR IGNORE: the key may already
  // exist with a SnoozedUntil from an earlier "mute for a day". With OR IGNORE
  // the row was left untouched, so asking to hide something permanently after
  // snoozing it did nothing at all, and the alert returned when the snooze
  // lapsed. Clearing SnoozedUntil is what makes the dismissal permanent.
  ipcMain.handle('notifications:dismiss', async (_event, key: string) => {
    const db = getDb();
    db.prepare(`
      INSERT INTO dismissed_notifications (NotifKey, SnoozedUntil) VALUES (?, NULL)
      ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = NULL
    `).run(key);
    return { success: true };
  });

  // Dismiss all currently visible notifications.
  ipcMain.handle('notifications:dismissAll', async (_event, keys: string[]) => {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO dismissed_notifications (NotifKey, SnoozedUntil) VALUES (?, NULL)
      ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = NULL
    `);
    const tx = db.transaction(() => { for (const k of keys) stmt.run(k); });
    tx();
    return { success: true };
  });

  // Snooze one notification for N hours.
  //
  // Also an upsert: re-snoozing an already-snoozed key previously hit OR IGNORE
  // and kept the OLD expiry, so pressing "mute for a day" a second time
  // extended nothing.
  ipcMain.handle('notifications:snooze', async (_event, key: string, hours: number) => {
    const db = getDb();
    const safeHours = Number.isFinite(hours) ? Math.min(8760, Math.max(1, hours)) : 24;
    const until = new Date(Date.now() + safeHours * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO dismissed_notifications (NotifKey, SnoozedUntil) VALUES (?, ?)
      ON CONFLICT(NotifKey) DO UPDATE SET SnoozedUntil = excluded.SnoozedUntil
    `).run(key, until);
    return { success: true };
  });

  // Get dismissed keys
  ipcMain.handle('notifications:dismissed', async () => {
    const db = getDb();
    // SnoozedUntil is written as a full ISO-8601 UTC string (see
    // notifications:snooze), so compare it as UTC in SQL. The previous version
    // compared against localtime `datetime('now')` and then re-filtered in JS
    // by appending a second 'Z' to an already-UTC string, which produced an
    // Invalid Date and silently dropped snoozes.
    const rows = db.prepare(`
      SELECT NotifKey, SnoozedUntil FROM dismissed_notifications
      WHERE SnoozedUntil IS NULL OR SnoozedUntil > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).all() as any[];
    const dismissed = new Set<string>();
    for (const r of rows) dismissed.add(r.NotifKey);
    return { dismissed: Array.from(dismissed) };
  });

  // Clear expired snoozes
  ipcMain.handle('notifications:clearExpired', async () => {
    const db = getDb();
    db.prepare("DELETE FROM dismissed_notifications WHERE SnoozedUntil IS NOT NULL AND SnoozedUntil <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
    return { success: true };
  });

  /**
   * The shop's own notification preferences.
   *
   * Read-only here: writing goes through `notifications:setPrefs`, which
   * validates before storing. Returning the catalogue alongside the values
   * lets the settings screen render itself without duplicating the rule list.
   */
  ipcMain.handle('notifications:getPrefs', async () => {
    return {
      prefs: loadPrefs(),
      catalogue: NOTIFICATION_RULES,
      categories: CATEGORY_LABELS,
    };
  });

  ipcMain.handle('notifications:setPrefs', async (_event, incoming: unknown) => {
    // Normalise BEFORE storing so an out-of-range threshold can never be
    // persisted, and a corrupted payload degrades to defaults instead of
    // silently switching an alert off.
    const clean = normalisePrefs(incoming);
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('notif_prefs', ?)")
      .run(JSON.stringify(clean));
    return { success: true, prefs: clean };
  });

  ipcMain.handle('notifications:resetPrefs', async () => {
    const clean = defaultPrefs();
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (Key, Value) VALUES ('notif_prefs', ?)")
      .run(JSON.stringify(clean));
    return { success: true, prefs: clean };
  });

  // Smart notifications system — analyses the shop's data and raises alerts.
  //
  // Every rule below is driven by the owner's preferences: whether it runs at
  // all, the numbers it compares against, and the priority it reports. A
  // disabled rule does not merely have its output filtered — its query is never
  // executed, so switching alerts off also makes the bell cheaper.
  ipcMain.handle('notifications:smart', async () => {
    const db = getDb();
    const prefs = loadPrefs();
    const now = new Date();
    const notifications: any[] = [];
    const today = now.toISOString().split('T')[0];

    const on = (id: string) => ruleState(prefs, id).enabled;
    const prio = (id: string): Priority => ruleState(prefs, id).priority;
    const num = (id: string, key: string) => param(prefs, id, key);

    /**
     * Escalates a rule's configured priority when a threshold is passed.
     * Never downgrades below what the owner chose, so raising a rule to
     * "critical" keeps it critical even when the escalation does not apply.
     */
    const escalate = (id: string, ...steps: Array<[boolean, Priority]>): Priority => {
      const base = prio(id);
      let best = base;
      for (const [cond, level] of steps) {
        if (cond && PRIORITY_ORDER[level] < PRIORITY_ORDER[best]) best = level;
      }
      return best;
    };

    // ====== CUSTOMERS ======
    if (on('customer_overdue')) {
      const cutoff = daysAgoIso(now, num('customer_overdue', 'days'));
      const minBalance = num('customer_overdue', 'minBalance');
      const overdueCustomers = db.prepare(`
        SELECT c.CustomerID, c.Name, c.Phone, c.Balance,
          (SELECT MAX(Date) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) as LastSaleDate
        FROM customers c
        WHERE c.Balance >= ? AND c.Balance > 0 AND c.Status = 'active'
        AND (SELECT MAX(Date) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) <= ?
        ORDER BY c.Balance DESC
      `).all(minBalance, cutoff) as any[];

      const high = num('customer_overdue', 'highAfter');
      const critical = num('customer_overdue', 'criticalAfter');
      for (const c of overdueCustomers) {
        const daysSince = c.LastSaleDate
          ? Math.floor((now.getTime() - new Date(c.LastSaleDate).getTime()) / 86_400_000)
          : 999;
        notifications.push({
          type: 'danger', category: 'customer', icon: 'users', rule: 'customer_overdue',
          title: `عميل متأخر عن السداد: ${c.Name}`,
          message: `رصيد مستحق: ${c.Balance.toFixed(2)} | آخر تعامل: ${c.LastSaleDate || '—'} (${daysSince} يوم)`,
          action: 'view_customer', actionId: c.CustomerID,
          priority: escalate('customer_overdue',
            [daysSince > high, 'high'], [daysSince > critical, 'critical']),
        });
      }
    }

    if (on('customer_high_balance')) {
      const threshold = num('customer_high_balance', 'threshold');
      const limit = num('customer_high_balance', 'limit');
      const highBalanceCustomers = db.prepare(`
        SELECT c.CustomerID, c.Name, c.Balance FROM customers c
        WHERE c.Balance > ? AND c.Status = 'active'
        ORDER BY c.Balance DESC LIMIT ?
      `).all(threshold, limit) as any[];

      for (const c of highBalanceCustomers) {
        notifications.push({
          type: 'warning', category: 'customer', icon: 'users', rule: 'customer_high_balance',
          title: `رصيد مرتفع: ${c.Name}`,
          message: `الرصيد المستحق: ${c.Balance.toFixed(2)}`,
          action: 'view_customer', actionId: c.CustomerID,
          priority: prio('customer_high_balance'),
        });
      }
    }

    if (on('customer_suspended')) {
      const suspended = db.prepare(
        `SELECT COUNT(*) as count FROM customers WHERE Status = 'suspended'`,
      ).get() as any;
      if (suspended.count > 0) {
        notifications.push({
          type: 'info', category: 'customer', icon: 'users', rule: 'customer_suspended',
          title: 'عملاء محظورون',
          message: `يوجد ${suspended.count} عميل محظور`,
          priority: prio('customer_suspended'),
        });
      }
    }

    // ====== SUPPLIERS ======
    if (on('supplier_overdue')) {
      const cutoff = daysAgoIso(now, num('supplier_overdue', 'days'));
      const minBalance = num('supplier_overdue', 'minBalance');
      const overdueSuppliers = db.prepare(`
        SELECT s.SupplierID, s.Name, s.Balance,
          (SELECT MAX(Date) FROM purchases WHERE SupplierID = s.SupplierID) as LastPurchaseDate
        FROM suppliers s
        WHERE s.Balance >= ? AND s.Balance > 0 AND s.Status = 'active'
        AND (SELECT MAX(Date) FROM purchases WHERE SupplierID = s.SupplierID) <= ?
        ORDER BY s.Balance DESC
      `).all(minBalance, cutoff) as any[];

      const high = num('supplier_overdue', 'highAfter');
      for (const s of overdueSuppliers) {
        const daysSince = s.LastPurchaseDate
          ? Math.floor((now.getTime() - new Date(s.LastPurchaseDate).getTime()) / 86_400_000)
          : 999;
        notifications.push({
          type: 'warning', category: 'supplier', icon: 'truck', rule: 'supplier_overdue',
          title: `مورد مستحق الدفع: ${s.Name}`,
          message: `مستحق له: ${s.Balance.toFixed(2)} | آخر شراء: ${s.LastPurchaseDate || '—'} (${daysSince} يوم)`,
          action: 'view_supplier', actionId: s.SupplierID,
          priority: escalate('supplier_overdue', [daysSince > high, 'high']),
        });
      }
    }

    // ====== MAINTENANCE ======
    if (on('maintenance_overdue')) {
      const overdueMaintenance = db.prepare(`
        SELECT TicketID, TicketNumber, CustomerName, CustomerPhone, DeviceModel,
               AgreedDeliveryDate, AgreedCost, Status
        FROM maintenance_tickets
        WHERE Status NOT IN ('delivered', 'cancelled', 'returned')
        AND AgreedDeliveryDate IS NOT NULL AND AgreedDeliveryDate < ?
        ORDER BY AgreedDeliveryDate ASC
      `).all(today) as any[];

      const high = num('maintenance_overdue', 'highAfter');
      const critical = num('maintenance_overdue', 'criticalAfter');
      for (const t of overdueMaintenance) {
        const daysLate = Math.floor(
          (now.getTime() - new Date(t.AgreedDeliveryDate).getTime()) / 86_400_000);
        notifications.push({
          type: 'danger', category: 'maintenance', icon: 'wrench', rule: 'maintenance_overdue',
          title: `صيانة متأخرة: ${t.TicketNumber}`,
          message: `${t.CustomerName} - ${t.DeviceModel} | متأخرة ${daysLate} يوم عن ${t.AgreedDeliveryDate}`,
          action: 'view_maintenance', actionId: t.TicketID,
          priority: escalate('maintenance_overdue',
            [daysLate > high, 'high'], [daysLate > critical, 'critical']),
        });
      }
    }

    if (on('maintenance_stale')) {
      const cutoff = daysAgoIso(now, num('maintenance_stale', 'days'));
      const staleMaintenance = db.prepare(`
        SELECT t.TicketID, t.TicketNumber, t.CustomerName, t.DeviceModel, t.Status, t.Date
        FROM maintenance_tickets t
        WHERE t.Status IN ('received', 'inspecting')
        AND t.Date <= ?
        ORDER BY t.Date ASC
      `).all(cutoff) as any[];

      for (const t of staleMaintenance) {
        const daysSince = Math.floor((now.getTime() - new Date(t.Date).getTime()) / 86_400_000);
        notifications.push({
          type: 'warning', category: 'maintenance', icon: 'wrench', rule: 'maintenance_stale',
          title: `صيانة معلّقة: ${t.TicketNumber}`,
          message: `${t.CustomerName} - ${t.DeviceModel} | بدون تحديث منذ ${daysSince} يوم`,
          action: 'view_maintenance', actionId: t.TicketID,
          priority: prio('maintenance_stale'),
        });
      }
    }

    // ====== INVENTORY ======
    if (on('inventory_low_stock')) {
      const lowStockItems = db.prepare(`
        SELECT i.ItemID, i.ItemName, i.ItemType, i.MinStock, i.Unit,
          (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
          (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
          i.IsSerialized
        FROM items i WHERE i.IsActive = 1 AND i.MinStock > 0
        AND ((i.IsSerialized = 0 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) < i.MinStock)
             OR (i.IsSerialized = 1 AND (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') < i.MinStock))
        ORDER BY i.ItemName ASC LIMIT ?
      `).all(num('inventory_low_stock', 'limit')) as any[];

      for (const i of lowStockItems) {
        const stock = i.IsSerialized ? i.AvailableSerials : i.TotalStock;
        notifications.push({
          type: 'danger', category: 'inventory', icon: 'package', rule: 'inventory_low_stock',
          title: `مخزون منخفض: ${i.ItemName}`,
          message: `المتاح: ${stock} ${i.Unit || ''} | الحد الأدنى: ${i.MinStock}`,
          action: 'view_item', actionId: i.ItemID,
          priority: escalate('inventory_low_stock', [stock === 0, 'critical']),
        });
      }
    }

    if (on('inventory_out_of_stock')) {
      const outOfStockItems = db.prepare(`
        SELECT i.ItemID, i.ItemName, i.Unit,
          (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
          (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
          i.IsSerialized
        FROM items i WHERE i.IsActive = 1
        AND ((i.IsSerialized = 0 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) = 0)
             OR (i.IsSerialized = 1 AND (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') = 0))
        ORDER BY i.ItemName ASC LIMIT ?
      `).all(num('inventory_out_of_stock', 'limit')) as any[];

      for (const i of outOfStockItems) {
        notifications.push({
          type: 'danger', category: 'inventory', icon: 'package', rule: 'inventory_out_of_stock',
          title: `نفاد مخزون: ${i.ItemName}`,
          message: 'الصنف غير متوفر في المخزون',
          action: 'view_item', actionId: i.ItemID,
          priority: prio('inventory_out_of_stock'),
        });
      }
    }

    if (on('inventory_slow_moving')) {
      const cutoff = daysAgoIso(now, num('inventory_slow_moving', 'days'));
      // The stock filter is repeated in full rather than referencing the
      // TotalStock alias: SQLite tolerates an alias in WHERE, but the original
      // form silently excluded items with no stock row at all. Spelling the
      // subquery out keeps the intent explicit and portable.
      const slowItems = db.prepare(`
        SELECT i.ItemID, i.ItemName,
          (SELECT MAX(s.Date) FROM sale_details sd JOIN sales s ON sd.SaleID = s.SaleID
             WHERE sd.ItemID = i.ItemID AND s.IsVoided = 0) as LastSaleDate,
          (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock
        FROM items i
        WHERE i.IsActive = 1 AND i.IsSerialized = 0
        AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) >= ?
        AND (SELECT MAX(s.Date) FROM sale_details sd JOIN sales s ON sd.SaleID = s.SaleID
               WHERE sd.ItemID = i.ItemID AND s.IsVoided = 0) <= ?
        ORDER BY LastSaleDate ASC LIMIT ?
      `).all(num('inventory_slow_moving', 'minStock'), cutoff,
        num('inventory_slow_moving', 'limit')) as any[];

      for (const i of slowItems) {
        const daysSince = i.LastSaleDate
          ? Math.floor((now.getTime() - new Date(i.LastSaleDate).getTime()) / 86_400_000)
          : 999;
        notifications.push({
          type: 'info', category: 'inventory', icon: 'package', rule: 'inventory_slow_moving',
          title: `صنف بطيء الحركة: ${i.ItemName}`,
          message: `آخر بيع: ${i.LastSaleDate || 'أبداً'} (${daysSince} يوم) | مخزون: ${i.TotalStock}`,
          action: 'view_item', actionId: i.ItemID,
          priority: prio('inventory_slow_moving'),
        });
      }
    }

    // ====== EMPLOYEES ======
    if (on('employee_salary_due')) {
      const pendingSalaries = db.prepare(`
        SELECT e.Name, e.BaseSalary, e.Balance,
          (SELECT MAX(Month) FROM salaries WHERE EmployeeID = e.EmployeeID) as LastSalaryMonth
        FROM employees e WHERE e.IsActive = 1 AND e.Balance >= ? AND e.Balance > 0
      `).all(num('employee_salary_due', 'minBalance')) as any[];

      for (const e of pendingSalaries) {
        notifications.push({
          type: 'warning', category: 'employee', icon: 'user', rule: 'employee_salary_due',
          title: `راتب معلّق: ${e.Name}`,
          message: `مستحق: ${e.Balance.toFixed(2)} | آخر راتب: ${e.LastSalaryMonth || '—'}`,
          action: 'view_employee', actionId: 0,
          priority: prio('employee_salary_due'),
        });
      }
    }

    if (on('employee_commissions')) {
      const unpaidCommissions = db.prepare(`
        SELECT e.Name, COUNT(c.CommissionID) as count, COALESCE(SUM(c.Amount),0) as total
        FROM employees e
        LEFT JOIN commissions c ON e.EmployeeID = c.EmployeeID AND c.IsPaid = 0
        WHERE e.IsActive = 1
        GROUP BY e.EmployeeID
        HAVING count > 0 AND total >= ?
      `).all(num('employee_commissions', 'minTotal')) as any[];

      for (const e of unpaidCommissions) {
        notifications.push({
          type: 'info', category: 'employee', icon: 'user', rule: 'employee_commissions',
          title: `عمولات غير مدفوعة: ${e.Name}`,
          message: `${e.count} عمولة بقيمة ${e.total.toFixed(2)}`,
          priority: prio('employee_commissions'),
        });
      }
    }

    // ====== FINANCIAL ======
    if (on('cash_low')) {
      const lowCash = db.prepare(`
        SELECT AccountName, Balance FROM cash_accounts
        WHERE IsActive = 1 AND Balance < ? ORDER BY Balance ASC
      `).all(num('cash_low', 'threshold')) as any[];

      for (const c of lowCash) {
        notifications.push({
          type: 'warning', category: 'financial', icon: 'wallet', rule: 'cash_low',
          title: `رصيد منخفض: ${c.AccountName}`,
          message: `الرصيد الحالي: ${c.Balance.toFixed(2)}`,
          priority: prio('cash_low'),
        });
      }
    }

    // ---- Dismissed and snoozed entries.
    //
    // The comparison uses the SAME ISO-8601 UTC format that `notifications:snooze`
    // writes. The previous version compared an ISO string against
    // `datetime('now')` ("2026-07-27 23:48:35"): because 'T' (0x54) sorts above
    // ' ' (0x20), EVERY snoozed key compared as still-future, so a snooze never
    // expired and the alert was hidden permanently.
    const dismissedRows = db.prepare(`
      SELECT NotifKey FROM dismissed_notifications
      WHERE SnoozedUntil IS NULL
         OR SnoozedUntil > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).all() as any[];
    const dismissedKeys = new Set<string>(dismissedRows.map(r => r.NotifKey));

    // ---- Global gating: master switch, active days, quiet hours, priority floor.
    const gate = evaluateSuppression(prefs, now);

    const filtered = notifications
      .filter(n => !dismissedKeys.has(getNotifKey(n)))
      .filter(n => gate.allowed(n.priority as Priority));

    filtered.sort((a, b) =>
      PRIORITY_ORDER[a.priority as Priority] - PRIORITY_ORDER[b.priority as Priority]);

    const capped = filtered.slice(0, prefs.global.maxItems);

    return {
      notifications: capped,
      keys: capped.map(n => getNotifKey(n)),
      // Surfaced so the header can explain an empty bell ("quiet hours") rather
      // than implying everything is fine.
      suppressed: gate.suppressed,
      suppressionReason: gate.reason,
      refreshMinutes: prefs.global.refreshMinutes,
      totalBeforeCap: filtered.length,
      counts: {
        critical: capped.filter(n => n.priority === 'critical').length,
        high: capped.filter(n => n.priority === 'high').length,
        medium: capped.filter(n => n.priority === 'medium').length,
        low: capped.filter(n => n.priority === 'low').length,
        total: capped.length,
      },
    };
  });

  // Get maintenance ticket details for editing
  ipcMain.handle('maintenance:getForEdit', async (_event, ticketId: number) => {
    const db = getDb();
    const ticket = db.prepare(`
      SELECT t.*, e.Name as TechnicianName
      FROM maintenance_tickets t
      LEFT JOIN employees e ON t.TechnicianID = e.EmployeeID
      WHERE t.TicketID = ?
    `).get(ticketId);
    return ticket;
  });

  // Update maintenance ticket (edit)
  ipcMain.handle('maintenance:update', async (_event, ticketId: number, data: {
    CustomerName?: string; CustomerPhone?: string; DeviceModel?: string;
    DeviceIMEI?: string; ProblemDesc?: string; Accessories?: string;
    DevicePassword?: string; AgreedDeliveryDate?: string; AgreedCost?: number;
    TechnicianID?: number; Status?: string;
  }) => {
    const db = getDb();
    db.prepare(`
      UPDATE maintenance_tickets SET
        CustomerName = @CustomerName, CustomerPhone = @CustomerPhone,
        DeviceModel = @DeviceModel, DeviceIMEI = @DeviceIMEI,
        ProblemDesc = @ProblemDesc, Accessories = @Accessories,
        DevicePassword = @DevicePassword, AgreedDeliveryDate = @AgreedDeliveryDate,
        AgreedCost = @AgreedCost, TechnicianID = @TechnicianID, Status = @Status
      WHERE TicketID = ?
    `).run({ ...data, id: ticketId });
    return { success: true };
  });
}
