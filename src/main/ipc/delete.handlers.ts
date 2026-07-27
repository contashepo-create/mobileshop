import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { restoreStock, resolveSourceWarehouse } from '../database/stock';

export function registerDeleteHandlers() {
  // Delete sale - reverse all effects
  ipcMain.handle('delete:sale', async (_event, saleId: number) => {
    const db = getDb();
    try {
      const sale = db.prepare('SELECT * FROM sales WHERE SaleID = ?').get(saleId) as any;
      if (!sale) return { success: false, message: 'الفاتورة غير موجودة' };

      const tx = db.transaction(() => {
        // Get sale details
        const details = db.prepare('SELECT * FROM sale_details WHERE SaleID = ?').all(saleId) as any[];

        // Reverse stock changes into the warehouse the sale deducted from
        for (const item of details) {
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(item.SerialID);
          }
          if (item.ItemID && !item.SerialID) {
            const wh = item.WarehouseID ?? resolveSourceWarehouse(db, item.ItemID, 0, null);
            if (wh) restoreStock(db, item.ItemID, wh, item.Quantity, item.UnitCost || 0);
          }
        }

        // Reverse customer balance
        if (sale.CustomerID && sale.RemainingAmount > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(sale.RemainingAmount, sale.CustomerID);
        } else if (sale.CustomerID && sale.RemainingAmount < 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(sale.RemainingAmount), sale.CustomerID);
        }

        // Reverse cash account
        if (sale.CashAccountID && sale.PaidAmount > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(sale.PaidAmount, sale.CashAccountID);
        }

        // Reverse payment method
        if (sale.PaymentMethodID && sale.PaidAmount > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(sale.PaidAmount, sale.PaymentMethodID);
        }

        // Delete sale details and sale
        db.prepare('DELETE FROM sale_details WHERE SaleID = ?').run(saleId);
        db.prepare('DELETE FROM sales WHERE SaleID = ?').run(saleId);
      });
      tx();
      return { success: true, message: 'تم حذف الفاتورة وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete purchase - reverse all effects
  ipcMain.handle('delete:purchase', async (_event, purchaseId: number) => {
    const db = getDb();
    try {
      const purchase = db.prepare('SELECT * FROM purchases WHERE PurchaseID = ?').get(purchaseId) as any;
      if (!purchase) return { success: false, message: 'الفاتورة غير موجودة' };

      const tx = db.transaction(() => {
        const details = db.prepare('SELECT * FROM purchase_details WHERE PurchaseID = ?').all(purchaseId) as any[];

        // Reverse stock changes (recalculate weighted average cost)
        for (const item of details) {
          if (item.IMEI) {
            db.prepare("DELETE FROM item_serials WHERE IMEI = ? AND Status = 'available'").run(item.IMEI);
          }
          if (item.ItemID) {
            const stock = db.prepare('SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, item.WarehouseID) as any;
            if (stock) {
              const oldTotal = stock.CostPrice * stock.Quantity;
              const removedTotal = item.UnitCost * item.Quantity;
              const newQty = stock.Quantity - item.Quantity;
              const newCost = newQty > 0 ? ((oldTotal - removedTotal) / newQty) : 0;
              db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?').run(newQty, newCost, stock.ID);
            }
          }
        }

        // Reverse supplier balance
        if (purchase.RemainingAmount > 0) {
          db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(purchase.RemainingAmount, purchase.SupplierID);
        } else if (purchase.RemainingAmount < 0) {
          db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?').run(Math.abs(purchase.RemainingAmount), purchase.SupplierID);
        }

        // Reverse payment source
        const paymentSourceType = purchase.PaymentSource;
        const paymentSourceID = purchase.PaymentSourceID;
        if (purchase.PaidAmount > 0 && paymentSourceID) {
          if (paymentSourceType === 'cash_account') {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(purchase.PaidAmount, paymentSourceID);
          } else if (paymentSourceType === 'payment_method') {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(purchase.PaidAmount, paymentSourceID);
          }
        }

        // Update item cost prices after removal
        for (const item of details) {
          if (item.ItemID) {
            const allStock = db.prepare('SELECT SUM(Quantity) as totalQty, SUM(CostPrice * Quantity) as totalValue FROM stock_quantities WHERE ItemID = ?').get(item.ItemID) as any;
            if (allStock && allStock.totalQty > 0) {
              db.prepare('UPDATE items SET CostPrice = ? WHERE ItemID = ?').run(allStock.totalValue / allStock.totalQty, item.ItemID);
            } else {
              db.prepare('UPDATE items SET CostPrice = 0 WHERE ItemID = ?').run(item.ItemID);
            }
          }
        }

        // Delete details and purchase
        db.prepare('DELETE FROM purchase_details WHERE PurchaseID = ?').run(purchaseId);
        db.prepare('DELETE FROM purchases WHERE PurchaseID = ?').run(purchaseId);
      });
      tx();
      return { success: true, message: 'تم حذف فاتورة الشراء وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete advance - reverse employee balance + cash
  ipcMain.handle('delete:advance', async (_event, advanceId: number) => {
    const db = getDb();
    try {
      const advance = db.prepare('SELECT * FROM employee_advances WHERE AdvanceID = ?').get(advanceId) as any;
      if (!advance) return { success: false, message: 'السلفية غير موجودة' };

      const tx = db.transaction(() => {
        if (advance.CashAccountID) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(advance.Amount, advance.CashAccountID);
        }
        db.prepare('DELETE FROM employee_advances WHERE AdvanceID = ?').run(advanceId);
      });
      tx();
      return { success: true, message: 'تم حذف السلفية وعكس التأثير' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete deduction - reverse
  ipcMain.handle('delete:deduction', async (_event, deductionId: number) => {
    const db = getDb();
    try {
      db.prepare('DELETE FROM employee_deductions WHERE DeductionID = ?').run(deductionId);
      return { success: true, message: 'تم حذف الخصم' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete voucher - reverse cash + party balance
  ipcMain.handle('delete:voucher', async (_event, voucherId: number) => {
    const db = getDb();
    try {
      const voucher = db.prepare('SELECT * FROM vouchers WHERE VoucherID = ?').get(voucherId) as any;
      if (!voucher) return { success: false, message: 'السند غير موجود' };

      const tx = db.transaction(() => {
        // Reverse cash account
        if (voucher.VoucherType === 'receipt') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(voucher.Amount, voucher.CashAccountID);
        } else {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(voucher.Amount, voucher.CashAccountID);
        }

        // Reverse payment method
        if (voucher.PaymentMethodID) {
          if (voucher.VoucherType === 'receipt') {
            db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(voucher.Amount, voucher.PaymentMethodID);
          } else {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(voucher.Amount, voucher.PaymentMethodID);
          }
        }

        // Reverse party balance
        if (voucher.PartyType === 'customer' && voucher.PartyID) {
          if (voucher.VoucherType === 'receipt') {
            db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(voucher.Amount, voucher.PartyID);
          } else {
            db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(voucher.Amount, voucher.PartyID);
          }
        } else if (voucher.PartyType === 'supplier' && voucher.PartyID) {
          if (voucher.VoucherType === 'payment') {
            db.prepare('UPDATE suppliers SET Balance = Balance + ? WHERE SupplierID = ?').run(voucher.Amount, voucher.PartyID);
          } else {
            db.prepare('UPDATE suppliers SET Balance = Balance - ? WHERE SupplierID = ?').run(voucher.Amount, voucher.PartyID);
          }
        } else if (voucher.PartyType === 'employee' && voucher.PartyID) {
          if (voucher.VoucherType === 'payment') {
            db.prepare('UPDATE employees SET Balance = Balance + ? WHERE EmployeeID = ?').run(voucher.Amount, voucher.PartyID);
          } else {
            db.prepare('UPDATE employees SET Balance = Balance - ? WHERE EmployeeID = ?').run(voucher.Amount, voucher.PartyID);
          }
        }

        db.prepare('DELETE FROM vouchers WHERE VoucherID = ?').run(voucherId);
      });
      tx();
      return { success: true, message: 'تم حذف السند وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete service sale - reverse
  ipcMain.handle('delete:serviceSale', async (_event, id: number) => {
    const db = getDb();
    try {
      const sale = db.prepare('SELECT * FROM service_sales WHERE ServiceSaleID = ?').get(id) as any;
      if (!sale) return { success: false, message: 'العملية غير موجودة' };

      const tx = db.transaction(() => {
        // Reverse customer balance
        if (sale.CustomerID && sale.RemainingAmount > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(sale.RemainingAmount, sale.CustomerID);
        } else if (sale.CustomerID && sale.RemainingAmount < 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(sale.RemainingAmount), sale.CustomerID);
        }

        // Reverse cash account
        if (sale.CashAccountID && sale.PaidAmount > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(sale.PaidAmount, sale.CashAccountID);
        }

        // Reverse payment method (machine balance - add back the transferred amount)
        if (sale.PaymentMethodID && sale.Amount > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(sale.Amount, sale.PaymentMethodID);
        }

        db.prepare('DELETE FROM service_sales WHERE ServiceSaleID = ?').run(id);
      });
      tx();
      return { success: true, message: 'تم حذف العملية وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete maintenance delivery - reverse
  ipcMain.handle('delete:maintenanceDelivery', async (_event, deliveryId: number) => {
    const db = getDb();
    try {
      const delivery = db.prepare('SELECT * FROM maintenance_deliveries WHERE DeliveryID = ?').get(deliveryId) as any;
      if (!delivery) return { success: false, message: 'التسليم غير موجود' };

      const tx = db.transaction(() => {
        // Reverse customer balance
        if (delivery.CustomerID && delivery.RemainingAmount > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(delivery.RemainingAmount, delivery.CustomerID);
        } else if (delivery.CustomerID && delivery.RemainingAmount < 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(delivery.RemainingAmount), delivery.CustomerID);
        }

        // Reverse cash account
        if (delivery.CashAccountID && delivery.PaidAmount > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(delivery.PaidAmount, delivery.CashAccountID);
        }

        // Reverse ticket status back
        db.prepare("UPDATE maintenance_tickets SET Status = 'ready', TotalCost = 0 WHERE TicketID = ?").run(delivery.TicketID);

        // Reverse commission
        db.prepare("UPDATE commissions SET IsPaid = 0, PaidInSalaryID = NULL, PaidAmount = 0 WHERE ReferenceType = 'maintenance_delivery' AND ReferenceID = ?").run(deliveryId);

        // Delete associated sale (reverse all effects)
        if (delivery.SaleID) {
          const sale = db.prepare('SELECT * FROM sales WHERE SaleID = ?').get(delivery.SaleID) as any;
          if (sale) {
            const saleDetails = db.prepare('SELECT * FROM sale_details WHERE SaleID = ?').all(delivery.SaleID) as any[];
            for (const sd of saleDetails) {
              if (sd.SerialID) {
                db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(sd.SerialID);
              }
              // NOTE: parts consumed by a maintenance ticket were already
              // deducted by maintenance:issuePart and are restored from
              // `maintenance_parts` by maintenance:cancel/return. Restoring them
              // again from the generated sale_details would double-credit stock,
              // so only genuinely sale-sourced lines are reversed here.
              if (sd.ItemID && !sd.SerialID && sd.WarehouseID) {
                restoreStock(db, sd.ItemID, sd.WarehouseID, sd.Quantity, sd.UnitCost || 0);
              }
            }
            if (sale.CustomerID && sale.RemainingAmount > 0) {
              db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(sale.RemainingAmount, sale.CustomerID);
            } else if (sale.CustomerID && sale.RemainingAmount < 0) {
              db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(sale.RemainingAmount), sale.CustomerID);
            }
            if (sale.CashAccountID && sale.PaidAmount > 0) {
              db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(sale.PaidAmount, sale.CashAccountID);
            }
            if (sale.PaymentMethodID && sale.PaidAmount > 0) {
              db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(sale.PaidAmount, sale.PaymentMethodID);
            }
            db.prepare('DELETE FROM sale_details WHERE SaleID = ?').run(delivery.SaleID);
            db.prepare('DELETE FROM sales WHERE SaleID = ?').run(delivery.SaleID);
          }
        }

        // Delete delivery
        db.prepare('DELETE FROM maintenance_additional_costs WHERE DeliveryID = ?').run(deliveryId);
        db.prepare('DELETE FROM maintenance_deliveries WHERE DeliveryID = ?').run(deliveryId);
      });
      tx();
      return { success: true, message: 'تم حذف التسليم وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // Delete asset transfer - reverse
  ipcMain.handle('delete:transfer', async (_event, transferId: number) => {
    const db = getDb();
    try {
      const transfer = db.prepare('SELECT * FROM asset_transfers WHERE TransferID = ?').get(transferId) as any;
      if (!transfer) return { success: false, message: 'التحويل غير موجود' };

      const tx = db.transaction(() => {
        const totalDeduction = transfer.Amount + (transfer.TransferCostSource === 'separate' ? transfer.TransferCost : 0);

        // Add back to source
        if (transfer.FromType === 'cash_account') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(totalDeduction, transfer.FromID);
        } else {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(totalDeduction, transfer.FromID);
        }

        // Remove from destination
        if (transfer.ToType === 'cash_account') {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(transfer.ReceivedAmount, transfer.ToID);
        } else {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(transfer.ReceivedAmount, transfer.ToID);
        }

        db.prepare('DELETE FROM asset_transfers WHERE TransferID = ?').run(transferId);
      });
      tx();
      return { success: true, message: 'تم حذف التحويل وعكس كل التأثيرات' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });
}
