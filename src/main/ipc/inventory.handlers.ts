import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { nextDocNumber } from '../database/docNumber';
import { businessToday } from '../../shared/businessDate';
import { moveLots } from '../database/stock';

export function registerInventoryHandlers() {
  // ===== WAREHOUSES =====
  ipcMain.handle('warehouses:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM warehouses WHERE IsActive = 1 ORDER BY WarehouseName ASC').all();
  });

  ipcMain.handle('warehouses:create', async (_event, data: { WarehouseName: string; WarehouseType: string }) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO warehouses (WarehouseName, WarehouseType, IsActive) VALUES (?, ?, 1)').run(data.WarehouseName, data.WarehouseType || 'main');
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('warehouses:update', async (_event, id: number, data: { WarehouseName: string; WarehouseType: string }) => {
    const db = getDb();
    db.prepare('UPDATE warehouses SET WarehouseName = ?, WarehouseType = ? WHERE WarehouseID = ?').run(data.WarehouseName, data.WarehouseType, id);
    return { success: true };
  });

  ipcMain.handle('warehouses:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE warehouses SET IsActive = 0 WHERE WarehouseID = ?').run(id);
    return { success: true };
  });

  // ===== CATEGORIES =====
  ipcMain.handle('categories:list', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM categories ORDER BY CategoryName ASC').all();
  });

  ipcMain.handle('categories:create', async (_event, name: string, parentId?: number) => {
    const db = getDb();
    const result = db.prepare('INSERT INTO categories (CategoryName, ParentID) VALUES (?, ?)').run(name, parentId ?? null);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('categories:update', async (_event, id: number, name: string) => {
    const db = getDb();
    db.prepare('UPDATE categories SET CategoryName = ? WHERE CategoryID = ?').run(name, id);
    return { success: true };
  });

  ipcMain.handle('categories:delete', async (_event, id: number) => {
    const db = getDb();
    // Check if any items use this category
    const count = db.prepare('SELECT COUNT(*) as count FROM items WHERE CategoryID = ?').get(id) as any;
    if (count.count > 0) {
      return { success: false, message: `لا يمكن حذف الفئة - يوجد ${count.count} صنف مرتبط بها` };
    }
    db.prepare('DELETE FROM categories WHERE CategoryID = ?').run(id);
    return { success: true };
  });

  // ===== ITEMS =====
  ipcMain.handle('items:list', async (_event, filters?: { search?: string; type?: string; categoryId?: number; isActive?: number }) => {
    const db = getDb();
    let query = `
      SELECT i.*, c.CategoryName,
        (SELECT COUNT(*) FROM item_serials s WHERE s.ItemID = i.ItemID AND s.Status = 'available') as AvailableSerials,
        (SELECT SUM(Quantity) FROM stock_quantities sq WHERE sq.ItemID = i.ItemID) as TotalStock
      FROM items i
      LEFT JOIN categories c ON i.CategoryID = c.CategoryID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (filters?.search) {
      query += ' AND (i.ItemName LIKE ? OR i.Barcode LIKE ?)';
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }
    if (filters?.type && filters.type !== 'all') {
      query += ' AND i.ItemType = ?';
      params.push(filters.type);
    }
    if (filters?.categoryId && filters.categoryId > 0) {
      query += ' AND i.CategoryID = ?';
      params.push(filters.categoryId);
    }
    if (filters?.isActive !== undefined) {
      query += ' AND i.IsActive = ?';
      params.push(filters.isActive);
    }
    query += ' ORDER BY i.ItemName ASC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('items:listByWarehouse', async (_event, warehouseId: number) => {
    const db = getDb();
    return db.prepare(`
      SELECT sq.ItemID, sq.Quantity as StockQuantity, sq.CostPrice as StockCostPrice,
        i.ItemName, i.ItemType, i.SalePrice
      FROM stock_quantities sq
      JOIN items i ON sq.ItemID = i.ItemID
      WHERE sq.WarehouseID = ? AND sq.Quantity > 0 AND i.IsActive = 1
      ORDER BY i.ItemName
    `).all(warehouseId);
  });

  ipcMain.handle('items:get', async (_event, id: number) => {
    const db = getDb();
    return db.prepare('SELECT * FROM items WHERE ItemID = ?').get(id);
  });

  // Find item by exact barcode (for scanner)
  ipcMain.handle('items:findByBarcode', async (_event, barcode: string) => {
    const db = getDb();
    const item = db.prepare(`
      SELECT i.*, c.CategoryName,
        (SELECT COALESCE(SUM(Quantity),0) FROM stock_quantities WHERE ItemID = i.ItemID) as TotalStock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = i.ItemID AND Status = 'available') as AvailableSerials
      FROM items i
      LEFT JOIN categories c ON i.CategoryID = c.CategoryID
      WHERE i.Barcode = ? AND i.IsActive = 1
    `).get(barcode) as any;
    return item || null;
  });

  // Auto-create item from barcode (quick add) - CostPrice no longer required (auto-calculated from purchases)
  ipcMain.handle('items:quickCreate', async (_event, data: { Barcode: string; ItemName?: string; ItemType?: string; CostPrice?: number; SalePrice?: number }) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM items WHERE Barcode = ?').get(data.Barcode) as any;
    if (existing) return { success: false, message: 'الباركود موجود بالفعل', item: existing };

    const result = db.prepare(`
      INSERT INTO items (ItemName, Barcode, ItemType, IsSerialized, CostPrice, SalePrice, IsActive, Unit)
      VALUES (?, ?, ?, 0, 0, ?, 1, 'قطعة')
    `).run(
      data.ItemName || `صنف ${data.Barcode}`,
      data.Barcode,
      data.ItemType || 'accessory',
      data.SalePrice || 0,
    );
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('items:create', async (_event, data: any) => {
    const db = getDb();

    if (!data.Barcode || data.Barcode.trim() === '') {
      data.Barcode = null;
    } else {
      const existing = db.prepare('SELECT ItemID FROM items WHERE Barcode = ? AND IsActive = 1').get(data.Barcode) as any;
      if (existing) {
        return { success: false, message: 'الباركود موجود بالفعل - استخدم باركود آخر أو اتركه فارغاً' };
      }
    }

    // ItemType defaults to 'accessory' for backward compat, CostPrice auto-calculated from purchases
    // Ensure data has all required fields before constructing safeData
    if (data.ItemType === undefined || data.ItemType === null || data.ItemType === '') {
      data.ItemType = 'accessory';
    }
    if (data.IsSerialized === undefined || data.IsSerialized === null) {
      data.IsSerialized = data.ItemType === 'phone' ? 1 : 0;
    }
    if (!data.SalePrice) data.SalePrice = 0;
    if (!data.MinStock) data.MinStock = 0;
    if (!data.Unit) data.Unit = 'قطعة';

    const safeData = {
      ItemName: data.ItemName,
      CategoryID: data.CategoryID,
      Barcode: data.Barcode,
      ItemType: data.ItemType,
      IsSerialized: data.IsSerialized,
      SalePrice: data.SalePrice,
      CostPrice: 0,
      MinStock: data.MinStock,
      Unit: data.Unit,
    };

    try {
      const result = db.prepare(`
        INSERT INTO items (ItemName, CategoryID, Barcode, ItemType, IsSerialized, SalePrice, CostPrice, IsActive, MinStock, Unit)
        VALUES (@ItemName, @CategoryID, @Barcode, @ItemType, @IsSerialized, @SalePrice, @CostPrice, 1, @MinStock, @Unit)
      `).run(safeData);
      return { success: true, id: result.lastInsertRowid };
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint failed: items.Barcode')) {
        return { success: false, message: 'الباركود موجود بالفعل' };
      }
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });

  ipcMain.handle('items:update', async (_event, id: number, data: any) => {
    const db = getDb();

    if (!data.Barcode || data.Barcode.trim() === '') {
      data.Barcode = null;
    } else {
      const existing = db.prepare('SELECT ItemID FROM items WHERE Barcode = ? AND ItemID != ?').get(data.Barcode, id) as any;
      if (existing) {
        return { success: false, message: 'الباركود مستخدم بواسطة صنف آخر' };
      }
    }

    // Preserve existing ItemType and CostPrice if not provided (no longer in form)
    const current = db.prepare('SELECT ItemType, CostPrice FROM items WHERE ItemID = ?').get(id) as any;
    const params = {
      ItemName: data.ItemName,
      CategoryID: data.CategoryID,
      Barcode: data.Barcode,
      ItemType: data.ItemType ?? (current?.ItemType || 'accessory'),
      IsSerialized: data.IsSerialized ?? 0,
      SalePrice: data.SalePrice ?? 0,
      CostPrice: data.CostPrice ?? (current?.CostPrice || 0),
      IsActive: data.IsActive ?? 1,
      MinStock: data.MinStock ?? 0,
      Unit: data.Unit || 'قطعة',
      id: id,
    };

    try {
      db.prepare(`
        UPDATE items SET
          ItemName = @ItemName, CategoryID = @CategoryID, Barcode = @Barcode,
          ItemType = @ItemType, IsSerialized = @IsSerialized,
          SalePrice = @SalePrice, CostPrice = @CostPrice, IsActive = @IsActive, MinStock = @MinStock, Unit = @Unit
        WHERE ItemID = @id
      `).run(params);
      return { success: true };
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint failed: items.Barcode')) {
        return { success: false, message: 'الباركود مستخدم بواسطة صنف آخر' };
      }
      return { success: false, message: `خطأ: ${err.message || err}` };
    }
  });

  ipcMain.handle('items:delete', async (_event, id: number) => {
    const db = getDb();
    db.prepare('UPDATE items SET IsActive = 0 WHERE ItemID = ?').run(id);
    return { success: true };
  });

  // Safe delete — only hard-deletes if item has no linked transactions
  ipcMain.handle('items:deleteSafe', async (_event, id: number) => {
    const db = getDb();
    const checks = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_details WHERE ItemID = ?) as purchases,
        (SELECT COUNT(*) FROM sale_details WHERE ItemID = ?) as sales,
        (SELECT COUNT(*) FROM maintenance_parts WHERE ItemID = ?) as maintenance,
        (SELECT COUNT(*) FROM maintenance_service_usage WHERE ItemID = ?) as service_usage,
        (SELECT COUNT(*) FROM stock_quantities WHERE ItemID = ? AND Quantity > 0) as stock,
        (SELECT COUNT(*) FROM item_serials WHERE ItemID = ?) as serials,
        (SELECT COUNT(*) FROM warehouse_transfer_details WHERE ItemID = ?) as transfers,
        (SELECT COUNT(*) FROM warehouse_po_details WHERE ItemID = ?) as po
    `).get(id, id, id, id, id, id, id, id) as any;

    const linked = Object.entries(checks).filter(([_, v]) => (v as number) > 0);
    if (linked.length > 0) {
      const details = linked.map(([k, v]) => `${v} في ${k}`).join('، ');
      return { success: false, message: `لا يمكن حذف الصنف — لديه عمليات مرتبطة: ${details}` };
    }

    db.prepare('DELETE FROM items WHERE ItemID = ?').run(id);
    return { success: true, message: 'تم حذف الصنف نهائياً' };
  });

  // ===== ITEM SERIALS (IMEI) =====
  ipcMain.handle('serials:list', async (_event, itemId?: number, status?: string) => {
    const db = getDb();
    let query = `
      SELECT s.*, i.ItemName, w.WarehouseName
      FROM item_serials s
      JOIN items i ON s.ItemID = i.ItemID
      JOIN warehouses w ON s.WarehouseID = w.WarehouseID
      WHERE 1=1
    `;
    const params: any[] = [];
    if (itemId) { query += ' AND s.ItemID = ?'; params.push(itemId); }
    if (status && status !== 'all') { query += ' AND s.Status = ?'; params.push(status); }
    query += ' ORDER BY s.SerialID DESC';
    return db.prepare(query).all(...params);
  });

  ipcMain.handle('serials:add', async (_event, data: { ItemID: number; IMEI: string; WarehouseID: number; CostPrice?: number }) => {
    const db = getDb();
    const existing = db.prepare('SELECT SerialID FROM item_serials WHERE IMEI = ?').get(data.IMEI);
    if (existing) return { success: false, message: 'رقم IMEI موجود بالفعل' };
    const result = db.prepare(`
      INSERT INTO item_serials (ItemID, IMEI, Status, CostPrice, WarehouseID)
      VALUES (?, ?, 'available', ?, ?)
    `).run(data.ItemID, data.IMEI, data.CostPrice ?? 0, data.WarehouseID);
    return { success: true, id: result.lastInsertRowid };
  });

  ipcMain.handle('serials:getAvailable', async (_event, itemId: number, warehouseId?: number) => {
    const db = getDb();
    let query = 'SELECT * FROM item_serials WHERE ItemID = ? AND Status = ?';
    const params: any[] = [itemId, 'available'];
    if (warehouseId) { query += ' AND WarehouseID = ?'; params.push(warehouseId); }
    return db.prepare(query).all(...params);
  });

  // ===== STOCK QUANTITIES =====
  ipcMain.handle('stock:list', async (_event, warehouseId?: number) => {
    const db = getDb();
    let query = `
      SELECT sq.*, i.ItemName, i.Barcode, i.ItemType, w.WarehouseName
      FROM stock_quantities sq
      JOIN items i ON sq.ItemID = i.ItemID
      JOIN warehouses w ON sq.WarehouseID = w.WarehouseID
      WHERE i.IsActive = 1
    `;
    const params: any[] = [];
    if (warehouseId) { query += ' AND sq.WarehouseID = ?'; params.push(warehouseId); }
    query += ' ORDER BY i.ItemName ASC';
    return db.prepare(query).all(...params);
  });

  // ===== WAREHOUSE TRANSFERS =====
  ipcMain.handle('warehouseTransfers:list', async () => {
    const db = getDb();
    return db.prepare(`
      SELECT t.*, fw.WarehouseName as FromWarehouse, tw.WarehouseName as ToWarehouse
      FROM warehouse_transfers t
      JOIN warehouses fw ON t.FromWarehouseID = fw.WarehouseID
      JOIN warehouses tw ON t.ToWarehouseID = tw.WarehouseID
      ORDER BY t.Date DESC
    `).all();
  });

  ipcMain.handle('warehouseTransfers:create', async (_event, data: {
    FromWarehouseID: number; ToWarehouseID: number;
    items: { ItemID: number; SerialID?: number; Quantity: number; UnitCost?: number }[];
    userId: number;
  }) => {
    const db = getDb();
    const dateStr = businessToday();

    // === INPUT VALIDATION ===
    // A transfer moves goods; it cannot create them.
    //
    // The availability check below only asked whether `Quantity > available`,
    // which a NEGATIVE quantity passes trivially. Transferring -50 then added
    // 50 to the source and -50 to the destination: fifty units invented out of
    // nothing in one warehouse and fifty phantom units owed by another, with
    // the stock value of both silently wrong from then on.
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: 'حدد الأصناف المراد نقلها' };
    }
    if (!data.FromWarehouseID || !data.ToWarehouseID) {
      return { success: false, message: 'اختر المخزن المصدر والمخزن الوجهة' };
    }
    if (data.FromWarehouseID === data.ToWarehouseID) {
      return { success: false, message: 'لا يمكن النقل إلى نفس المخزن' };
    }
    for (const item of data.items) {
      const qty = typeof item.Quantity === 'number' ? item.Quantity : Number(item.Quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, message: 'الكمية المنقولة يجب أن تكون رقماً أكبر من صفر' };
      }
      if (!item.ItemID) {
        return { success: false, message: 'أحد الأصناف غير صالح' };
      }
    }

    const transferNumber = nextDocNumber(db, 'warehouse_transfers', 'TransferNumber', 'TR', dateStr);

    // Check sufficient stock before transfer (unless negative stock allowed)
    const allowNeg = db.prepare("SELECT Value FROM settings WHERE Key = 'allow_negative_stock'").get() as any;
    if (allowNeg?.Value !== '1') {
      for (const item of data.items) {
        const srcStock = db.prepare('SELECT COALESCE(SUM(Quantity),0) as qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, data.FromWarehouseID) as any;
        const availableQty = srcStock?.qty || 0;
        if (item.Quantity > availableQty) {
          return { success: false, message: `الكمية غير متوفرة في المخزن المصدر للصنف #${item.ItemID}: المطلوب ${item.Quantity}، المتاح ${availableQty}` };
        }
      }
    }

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO warehouse_transfers (TransferNumber, Date, FromWarehouseID, ToWarehouseID, Status, UserID)
        VALUES (?, ?, ?, ?, 'completed', ?)
      `).run(transferNumber, dateStr, data.FromWarehouseID, data.ToWarehouseID, data.userId);

      const transferId = result.lastInsertRowid;

      for (const item of data.items) {
        db.prepare(`
          INSERT INTO warehouse_transfer_details (TransferID, ItemID, SerialID, Quantity, UnitCost)
          VALUES (?, ?, ?, ?, ?)
        `).run(transferId, item.ItemID, item.SerialID ?? null, item.Quantity, item.UnitCost ?? null);

        // === VALUE-NEUTRAL TRANSFER ===
        // Moving stock between warehouses must not create or destroy value.
        // Previously the destination kept its own CostPrice, so goods worth 100
        // arriving in a warehouse valued at 60 silently wrote off the 40
        // difference on every transfer. The goods now carry their source cost
        // and the destination is re-averaged.
        const existingFrom = db.prepare('SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, data.FromWarehouseID) as any;
        const movedCost = existingFrom?.CostPrice ?? item.UnitCost ?? 0;
        if (existingFrom) {
          db.prepare('UPDATE stock_quantities SET Quantity = Quantity - ? WHERE ID = ?').run(item.Quantity, existingFrom.ID);
        }

        // Add to destination warehouse at a weighted-average cost
        const existingTo = db.prepare('SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, data.ToWarehouseID) as any;
        if (existingTo) {
          const newQty = (existingTo.Quantity || 0) + item.Quantity;
          // Average only against a genuine positive holding. A destination
          // sitting at a negative balance (sold before receipt) would otherwise
          // drag the incoming goods to an invented cost — the same defect that
          // was found in purchases:create.
          const canAverage = (existingTo.Quantity || 0) > 0 && newQty > 0;
          const newCost = canAverage
            ? (((existingTo.CostPrice || 0) * (existingTo.Quantity || 0)) + (movedCost * item.Quantity)) / newQty
            : movedCost;
          db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?').run(newQty, newCost, existingTo.ID);
        } else {
          db.prepare('INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice) VALUES (?, ?, ?, ?)').run(item.ItemID, data.ToWarehouseID, item.Quantity, movedCost);
        }

        // Move the cost layers too, so the receiving warehouse holds the goods
        // at what they really cost rather than at the destination's average.
        moveLots(db, item.ItemID, data.FromWarehouseID, data.ToWarehouseID,
                 item.Quantity, movedCost);

        // Move the actual devices, not just the pooled quantity.
        //
        // This only ran when the CALLER supplied a SerialID. The transfer
        // screen sends a quantity, not IMEIs, so for a serialised item the
        // pool moved to the destination while every handset stayed recorded in
        // the source warehouse. Measured: after moving one phone, warehouse 1
        // held 0 units but still listed the device, and warehouse 2 held one
        // unit worth 16,500 with no device behind it. Stock reports, the
        // stocktake screen and any "what is on this shelf" question all
        // disagreed with each other from that moment on.
        //
        // The devices are now selected explicitly when none were named, oldest
        // first, so the count that moves matches the quantity that moved.
        const isSerialised = (db.prepare(
          'SELECT IsSerialized FROM items WHERE ItemID = ?',
        ).get(item.ItemID) as any)?.IsSerialized;

        if (item.SerialID) {
          db.prepare('UPDATE item_serials SET WarehouseID = ? WHERE SerialID = ?')
            .run(data.ToWarehouseID, item.SerialID);
        } else if (isSerialised) {
          const movable = db.prepare(`
            SELECT SerialID FROM item_serials
            WHERE ItemID = ? AND WarehouseID = ? AND Status = 'available'
            ORDER BY SerialID LIMIT ?
          `).all(item.ItemID, data.FromWarehouseID, Math.floor(item.Quantity)) as any[];
          if (movable.length < Math.floor(item.Quantity)) {
            throw new Error(
              `لا توجد أجهزة كافية بالرقم التسلسلي في المخزن المصدر: `
              + `المطلوب ${Math.floor(item.Quantity)}، المتاح ${movable.length}`,
            );
          }
          const move = db.prepare('UPDATE item_serials SET WarehouseID = ? WHERE SerialID = ?');
          for (const s of movable) move.run(data.ToWarehouseID, s.SerialID);
        }
      }
    });
    tx();
    return { success: true, transferNumber };
  });
}
