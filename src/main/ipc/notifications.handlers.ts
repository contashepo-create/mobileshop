import { ipcMain } from 'electron';
import { getDb } from '../database/connection';

function getNotifKey(notif: any): string {
  return `${notif.category}:${notif.action || ''}:${notif.actionId || ''}:${(notif.title || '').substring(0, 40)}`;
}

export function registerSmartNotificationsHandlers() {
  // Dismiss a notification
  ipcMain.handle('notifications:dismiss', async (_event, key: string) => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO dismissed_notifications (NotifKey) VALUES (?)").run(key);
    return { success: true };
  });

  // Dismiss all current notifications
  ipcMain.handle('notifications:dismissAll', async (_event, keys: string[]) => {
    const db = getDb();
    const stmt = db.prepare("INSERT OR IGNORE INTO dismissed_notifications (NotifKey) VALUES (?)");
    const tx = db.transaction(() => { for (const k of keys) stmt.run(k); });
    tx();
    return { success: true };
  });

  // Snooze a notification category for N hours
  ipcMain.handle('notifications:snooze', async (_event, key: string, hours: number) => {
    const db = getDb();
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT OR IGNORE INTO dismissed_notifications (NotifKey, SnoozedUntil) VALUES (?, ?)").run(key, until);
    return { success: true };
  });

  // Get dismissed keys
  ipcMain.handle('notifications:dismissed', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT NotifKey, SnoozedUntil FROM dismissed_notifications
      WHERE SnoozedUntil IS NULL OR SnoozedUntil > datetime('now')
    `).all() as any[];
    const dismissed = new Set<string>();
    for (const r of rows) {
      if (!r.SnoozedUntil) dismissed.add(r.NotifKey);
      else if (new Date(r.SnoozedUntil + 'Z') > new Date()) dismissed.add(r.NotifKey);
    }
    return { dismissed: Array.from(dismissed) };
  });

  // Clear expired snoozes
  ipcMain.handle('notifications:clearExpired', async () => {
    const db = getDb();
    db.prepare("DELETE FROM dismissed_notifications WHERE SnoozedUntil IS NOT NULL AND SnoozedUntil <= datetime('now')").run();
    return { success: true };
  });

  // Smart notifications system - analyzes all data and generates alerts
  ipcMain.handle('notifications:smart', async () => {
    const db = getDb();
    const notifications: any[] = [];
    const today = new Date().toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // ====== CUSTOMERS ======
    // 1. Overdue customer payments (balance > 0 for > 30 days since last sale)
    const overdueCustomers = db.prepare(`
      SELECT c.CustomerID, c.Name, c.Phone, c.Balance,
        (SELECT MAX(Date) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) as LastSaleDate
      FROM customers c
      WHERE c.Balance > 0 AND c.Status = 'active'
      AND (SELECT MAX(Date) FROM sales WHERE CustomerID = c.CustomerID AND IsVoided = 0) <= ?
      ORDER BY c.Balance DESC
    `).all(monthAgo) as any[];

    for (const c of overdueCustomers) {
      const daysSince = c.LastSaleDate ? Math.floor((Date.now() - new Date(c.LastSaleDate).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      notifications.push({
        type: 'danger', category: 'customer', icon: 'users',
        title: `عميل متأخر عن السداد: ${c.Name}`,
        message: `رصيد مستحق: ${c.Balance.toFixed(2)} | آخر تعامل: ${c.LastSaleDate || '—'} (${daysSince} يوم)`,
        action: 'view_customer', actionId: c.CustomerID,
        priority: daysSince > 60 ? 'critical' : daysSince > 45 ? 'high' : 'medium',
      });
    }

    // 2. Customers with high balance approaching danger threshold
    const highBalanceCustomers = db.prepare(`
      SELECT c.CustomerID, c.Name, c.Balance FROM customers c
      WHERE c.Balance > 3000 AND c.Status = 'active'
      ORDER BY c.Balance DESC LIMIT 10
    `).all() as any[];

    for (const c of highBalanceCustomers) {
      notifications.push({
        type: 'warning', category: 'customer', icon: 'users',
        title: `رصيد مرتفع: ${c.Name}`,
        message: `الرصيد المستحق: ${c.Balance.toFixed(2)}`,
        action: 'view_customer', actionId: c.CustomerID,
        priority: 'medium',
      });
    }

    // 3. Suspended customers
    const suspendedCustomers = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE Status = 'suspended'
    `).get() as any;
    if (suspendedCustomers.count > 0) {
      notifications.push({
        type: 'info', category: 'customer', icon: 'users',
        title: `عملاء محظورون`,
        message: `يوجد ${suspendedCustomers.count} عميل محظور`,
        priority: 'low',
      });
    }

    // ====== SUPPLIERS ======
    // 4. Overdue supplier payments
    const overdueSuppliers = db.prepare(`
      SELECT s.SupplierID, s.Name, s.Balance,
        (SELECT MAX(Date) FROM purchases WHERE SupplierID = s.SupplierID) as LastPurchaseDate
      FROM suppliers s
      WHERE s.Balance > 0 AND s.Status = 'active'
      AND (SELECT MAX(Date) FROM purchases WHERE SupplierID = s.SupplierID) <= ?
      ORDER BY s.Balance DESC
    `).all(monthAgo) as any[];

    for (const s of overdueSuppliers) {
      const daysSince = s.LastPurchaseDate ? Math.floor((Date.now() - new Date(s.LastPurchaseDate).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      notifications.push({
        type: 'warning', category: 'supplier', icon: 'truck',
        title: `مورد مستحق الدفع: ${s.Name}`,
        message: `مستحق له: ${s.Balance.toFixed(2)} | آخر شراء: ${s.LastPurchaseDate || '—'} (${daysSince} يوم)`,
        action: 'view_supplier', actionId: s.SupplierID,
        priority: daysSince > 45 ? 'high' : 'medium',
      });
    }

    // ====== MAINTENANCE ======
    // 5. Overdue maintenance tickets
    const overdueMaintenance = db.prepare(`
      SELECT TicketID, TicketNumber, CustomerName, CustomerPhone, DeviceModel,
             AgreedDeliveryDate, AgreedCost, Status
      FROM maintenance_tickets
      WHERE Status NOT IN ('delivered', 'cancelled', 'returned')
      AND AgreedDeliveryDate IS NOT NULL AND AgreedDeliveryDate < ?
      ORDER BY AgreedDeliveryDate ASC
    `).all(today) as any[];

    for (const t of overdueMaintenance) {
      const daysLate = Math.floor((Date.now() - new Date(t.AgreedDeliveryDate).getTime()) / (1000 * 60 * 60 * 24));
      notifications.push({
        type: 'danger', category: 'maintenance', icon: 'wrench',
        title: `صيانة متأخرة: ${t.TicketNumber}`,
        message: `${t.CustomerName} - ${t.DeviceModel} | متأخرة ${daysLate} يوم عن ${t.AgreedDeliveryDate}`,
        action: 'view_maintenance', actionId: t.TicketID,
        priority: daysLate > 7 ? 'critical' : daysLate > 3 ? 'high' : 'medium',
      });
    }

    // 6. Maintenance tickets with no status change for > 3 days
    const staleMaintenance = db.prepare(`
      SELECT t.TicketID, t.TicketNumber, t.CustomerName, t.DeviceModel, t.Status, t.Date
      FROM maintenance_tickets t
      WHERE t.Status IN ('received', 'inspecting')
      AND t.Date <= ?
      ORDER BY t.Date ASC
    `).all(weekAgo) as any[];

    for (const t of staleMaintenance) {
      const daysSince = Math.floor((Date.now() - new Date(t.Date).getTime()) / (1000 * 60 * 60 * 24));
      notifications.push({
        type: 'warning', category: 'maintenance', icon: 'wrench',
        title: `صيانة معلّقة: ${t.TicketNumber}`,
        message: `${t.CustomerName} - ${t.DeviceModel} | بدون تحديث منذ ${daysSince} يوم`,
        action: 'view_maintenance', actionId: t.TicketID,
        priority: 'medium',
      });
    }

    // ====== INVENTORY ======
    // 7. Low stock items
    const lowStockItems = db.prepare(`
      SELECT i.ItemID, i.ItemName, i.ItemType, i.MinStock, i.Unit,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
        i.IsSerialized
      FROM items i WHERE i.IsActive = 1 AND i.MinStock > 0
      AND ((i.IsSerialized = 0 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) < i.MinStock)
           OR (i.IsSerialized = 1 AND (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') < i.MinStock))
      ORDER BY i.ItemName ASC
    `).all() as any[];

    for (const i of lowStockItems) {
      const stock = i.IsSerialized ? i.AvailableSerials : i.TotalStock;
      notifications.push({
        type: 'danger', category: 'inventory', icon: 'package',
        title: `مخزون منخفض: ${i.ItemName}`,
        message: `المتاح: ${stock} ${i.Unit || ''} | الحد الأدنى: ${i.MinStock}`,
        action: 'view_item', actionId: i.ItemID,
        priority: stock === 0 ? 'critical' : 'high',
      });
    }

    // 8. Out of stock items
    const outOfStockItems = db.prepare(`
      SELECT i.ItemID, i.ItemName, i.Unit,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials,
        i.IsSerialized
      FROM items i WHERE i.IsActive = 1
      AND ((i.IsSerialized = 0 AND (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) = 0)
           OR (i.IsSerialized = 1 AND (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') = 0))
      ORDER BY i.ItemName ASC LIMIT 20
    `).all() as any[];

    for (const i of outOfStockItems) {
      notifications.push({
        type: 'danger', category: 'inventory', icon: 'package',
        title: `نفاد مخزون: ${i.ItemName}`,
        message: `الصنف غير متوفر في المخزون`,
        action: 'view_item', actionId: i.ItemID,
        priority: 'high',
      });
    }

    // 9. Items not sold in last 2 months (slow moving)
    const slowItems = db.prepare(`
      SELECT i.ItemID, i.ItemName,
        (SELECT MAX(s.Date) FROM sale_details sd JOIN sales s ON sd.SaleID = s.SaleID WHERE sd.ItemID = i.ItemID AND s.IsVoided = 0) as LastSaleDate,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock
      FROM items i WHERE i.IsActive = 1 AND i.IsSerialized = 0 AND TotalStock > 0
      AND (SELECT MAX(s.Date) FROM sale_details sd JOIN sales s ON sd.SaleID = s.SaleID WHERE sd.ItemID = i.ItemID AND s.IsVoided = 0) <= ?
      ORDER BY LastSaleDate ASC LIMIT 10
    `).all(twoWeeksAgo) as any[];

    for (const i of slowItems) {
      const daysSince = i.LastSaleDate ? Math.floor((Date.now() - new Date(i.LastSaleDate).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      notifications.push({
        type: 'info', category: 'inventory', icon: 'package',
        title: `صنف بطيء الحركة: ${i.ItemName}`,
        message: `آخر بيع: ${i.LastSaleDate || 'أبداً'} (${daysSince} يوم) | مخزون: ${i.TotalStock}`,
        action: 'view_item', actionId: i.ItemID,
        priority: 'low',
      });
    }

    // ====== EMPLOYEES ======
    // 10. Unpaid salaries
    const pendingSalaries = db.prepare(`
      SELECT e.Name, e.BaseSalary, e.Balance,
        (SELECT MAX(Month) FROM salaries WHERE EmployeeID = e.EmployeeID) as LastSalaryMonth
      FROM employees e WHERE e.IsActive = 1 AND e.Balance > 0
    `).all() as any[];

    for (const e of pendingSalaries) {
      notifications.push({
        type: 'warning', category: 'employee', icon: 'user',
        title: `راتب معلّق: ${e.Name}`,
        message: `مستحق: ${e.Balance.toFixed(2)} | آخر راتب: ${e.LastSalaryMonth || '—'}`,
        action: 'view_employee', actionId: 0,
        priority: 'medium',
      });
    }

    // 11. Unpaid commissions
    const unpaidCommissions = db.prepare(`
      SELECT e.Name, COUNT(c.CommissionID) as count, COALESCE(SUM(c.Amount),0) as total
      FROM employees e
      LEFT JOIN commissions c ON e.EmployeeID = c.EmployeeID AND c.IsPaid = 0
      WHERE e.IsActive = 1
      GROUP BY e.EmployeeID
      HAVING count > 0
    `).all() as any[];

    for (const e of unpaidCommissions) {
      notifications.push({
        type: 'info', category: 'employee', icon: 'user',
        title: `عمولات غير مدفوعة: ${e.Name}`,
        message: `${e.count} عمولة بقيمة ${e.total.toFixed(2)}`,
        priority: 'low',
      });
    }

    // ====== FINANCIAL ======
    // 12. Low cash balance
    const lowCash = db.prepare(`
      SELECT AccountName, Balance FROM cash_accounts WHERE IsActive = 1 AND Balance < 1000 ORDER BY Balance ASC
    `).all() as any[];

    for (const c of lowCash) {
      notifications.push({
        type: 'warning', category: 'financial', icon: 'wallet',
        title: `رصيد منخفض: ${c.AccountName}`,
        message: `الرصيد الحالي: ${c.Balance.toFixed(2)}`,
        priority: 'medium',
      });
    }

    // Filter out dismissed/snoozed notifications
    const dismissedRows = db.prepare(`
      SELECT NotifKey, SnoozedUntil FROM dismissed_notifications
      WHERE SnoozedUntil IS NULL OR SnoozedUntil > datetime('now')
    `).all() as any[];
    const dismissedKeys = new Set<string>();
    for (const r of dismissedRows) {
      if (!r.SnoozedUntil) dismissedKeys.add(r.NotifKey);
      else dismissedKeys.add(r.NotifKey);
    }

    const filtered = notifications.filter(n => !dismissedKeys.has(getNotifKey(n)));

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder]);

    return {
      notifications: filtered,
      keys: filtered.map(n => getNotifKey(n)),
      counts: {
        critical: filtered.filter(n => n.priority === 'critical').length,
        high: filtered.filter(n => n.priority === 'high').length,
        medium: filtered.filter(n => n.priority === 'medium').length,
        low: filtered.filter(n => n.priority === 'low').length,
        total: filtered.length,
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
