import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { restoreStock, resolveSourceWarehouse, restoreStockAtCost, deductStockAtCost, recordValuationResidual } from '../database/stock';
import { businessToday } from '../../shared/businessDate';

/**
 * Refuses a delete when other documents still reference the record.
 *
 * Deleting a parent row used to silently orphan its children: a sale with a
 * registered return left the return pointing at a missing invoice, so the
 * return kept affecting reports while its source was gone, and every balance
 * derived from the pair drifted permanently. Blocking the delete (rather than
 * cascading) is the safe choice for accounting data — the user reverses the
 * dependent document first, which keeps a visible audit trail.
 */
function blockIfReferenced(
  db: ReturnType<typeof getDb>,
  checks: { sql: string; params: unknown[]; label: string }[],
): string | null {
  for (const c of checks) {
    const row = db.prepare(c.sql).get(...(c.params as any[])) as any;
    const n = row ? (row.n ?? 0) : 0;
    if (n > 0) return `${c.label} (${n})`;
  }
  return null;
}

export function registerDeleteHandlers() {
  // Delete sale - reverse all effects
  ipcMain.handle('delete:sale', async (_event, saleId: number) => {
    const db = getDb();
    try {
      const sale = db.prepare('SELECT * FROM sales WHERE SaleID = ?').get(saleId) as any;
      if (!sale) return { success: false, message: 'الفاتورة غير موجودة' };

      const blocked = blockIfReferenced(db, [
        { sql: 'SELECT COUNT(*) as n FROM sale_returns WHERE SaleID = ?', params: [saleId], label: 'مرتجعات مرتبطة' },
        { sql: 'SELECT COUNT(*) as n FROM maintenance_deliveries WHERE SaleID = ?', params: [saleId], label: 'تسليم صيانة مرتبط' },
        { sql: "SELECT COUNT(*) as n FROM vouchers WHERE ReferenceType = 'sale' AND ReferenceID = ?", params: [saleId], label: 'سندات مرتبطة' },
      ]);
      if (blocked) {
        return { success: false, message: `لا يمكن حذف الفاتورة - توجد ${blocked}. احذفها أولاً.` };
      }

      const tx = db.transaction(() => {
        // Get sale details
        const details = db.prepare('SELECT * FROM sale_details WHERE SaleID = ?').all(saleId) as any[];

        // Reverse stock changes into the warehouse the sale deducted from
        for (const item of details) {
          if (item.SerialID) {
            db.prepare("UPDATE item_serials SET Status = 'available' WHERE SerialID = ?").run(item.SerialID);
          }
          // Quantity is restored for serialised lines as well: the sale now
          // deducts it for them, so deleting the sale has to give it back or
          // the warehouse count stays permanently one short.
          if (item.ItemID) {
            const wh = item.WarehouseID ?? resolveSourceWarehouse(db, item.ItemID, 0, null);
            // Put the value back, not just the count. `restoreStock` leaves the
            // existing CostPrice untouched when a row already exists, so goods
            // sold at 10 and un-sold into a pool now averaging 20 re-entered
            // valued at 20 — inventing value on every deletion.
            if (wh) restoreStockAtCost(db, item.ItemID, wh, item.Quantity, item.UnitCost || 0);
          }
        }

        // Reverse customer balance
        if (sale.CustomerID && sale.RemainingAmount > 0) {
          db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(sale.RemainingAmount, sale.CustomerID);
        } else if (sale.CustomerID && sale.RemainingAmount < 0) {
          db.prepare('UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?').run(Math.abs(sale.RemainingAmount), sale.CustomerID);
        }

        // Reverse the payment. The sale credited the amount NET of the
        // machine's commission, so the reversal must remove the same net
        // figure — subtracting the gross would destroy the fee's worth of cash
        // on every deleted card sale.
        const shopBorneFee = (sale.TransferCostBearer ?? 'shop') === 'shop'
          ? (sale.TransferCost || 0)
          : 0;
        const netReceived = +((sale.PaidAmount || 0) - shopBorneFee).toFixed(2);

        if (sale.CashAccountID && sale.PaidAmount > 0) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?').run(netReceived, sale.CashAccountID);
        }

        if (sale.PaymentMethodID && sale.PaidAmount > 0) {
          db.prepare('UPDATE payment_methods SET Balance = Balance - ? WHERE PaymentMethodID = ?').run(netReceived, sale.PaymentMethodID);
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

      const blockedPur = blockIfReferenced(db, [
        { sql: 'SELECT COUNT(*) as n FROM purchase_returns WHERE PurchaseID = ?', params: [purchaseId], label: 'مرتجعات مرتبطة' },
        { sql: "SELECT COUNT(*) as n FROM vouchers WHERE ReferenceType = 'purchase' AND ReferenceID = ?", params: [purchaseId], label: 'سندات مرتبطة' },
      ]);
      if (blockedPur) {
        return { success: false, message: `لا يمكن حذف فاتورة الشراء - توجد ${blockedPur}. احذفها أولاً.` };
      }

      // The goods must still be on the shelf to be un-received.
      //
      // Deleting a purchase subtracts the quantity it brought in. If those
      // units have since been sold or moved, they are not there to remove and
      // the subtraction drives the warehouse negative — inventing negative
      // inventory, and with it negative value that breaks the accounting
      // identity. Buying 2 phones into the branch, selling them, then deleting
      // the purchase left the branch at -2 and the books out by 1,200.
      //
      // Availability is checked per WAREHOUSE, because that is where the
      // reversal actually applies; stock of the same item in another branch
      // cannot be un-received on this invoice's behalf.
      const shortages: string[] = [];
      const lines = db.prepare(
        'SELECT ItemID, Quantity, WarehouseID, IMEI FROM purchase_details WHERE PurchaseID = ?',
      ).all(purchaseId) as any[];
      for (const line of lines) {
        if (!line.ItemID || !line.WarehouseID) continue;
        const held = (db.prepare(
          'SELECT COALESCE(SUM(Quantity),0) AS qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
        ).get(line.ItemID, line.WarehouseID) as any)?.qty || 0;
        if (held < line.Quantity - 0.001) {
          const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
          shortages.push(`"${info?.ItemName || line.ItemID}" (المطلوب ${line.Quantity}، المتاح ${held})`);
          continue;
        }
        // For a handset, having "enough units" is not enough: THIS phone must
        // still be on the shelf. A pool of three other devices satisfied the
        // quantity check while the IMEI on this invoice had already been sold,
        // so the deletion removed a unit of value and left the sold device's
        // record behind — the count and the IMEI list disagreed from then on.
        if (line.IMEI) {
          const serial = db.prepare(
            'SELECT Status FROM item_serials WHERE IMEI = ?',
          ).get(line.IMEI) as any;
          if (serial && serial.Status !== 'available') {
            const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
            shortages.push(`"${info?.ItemName || line.ItemID}" (IMEI ${line.IMEI} — الحالة: ${serial.Status})`);
          }
        }
      }
      if (shortages.length) {
        return {
          success: false,
          message: `لا يمكن حذف فاتورة الشراء - تم بيع أو نقل بعض الأصناف ولم تعد بالمخزن: ${shortages.join('، ')}. `
            + `احذف عمليات البيع أولاً أو استخدم مرتجع مشتريات.`,
        };
      }

      const tx = db.transaction(() => {
        // === RE-CHECK AVAILABILITY, NOW THAT THE WRITE LOCK IS HELD ===
        //
        // The shortage check above ran before this transaction opened, so the
        // goods could have been sold in between. On a shared network database
        // every till is a separate process, and this was verified to drive a
        // warehouse to -5. Re-reading under the write lock cannot be overtaken.
        for (const line of lines) {
          if (!line.ItemID || !line.WarehouseID) continue;
          const held = (db.prepare(
            'SELECT COALESCE(SUM(Quantity),0) AS qty FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?',
          ).get(line.ItemID, line.WarehouseID) as any)?.qty || 0;
          if (held < line.Quantity - 0.001) {
            const info = db.prepare('SELECT ItemName FROM items WHERE ItemID = ?').get(line.ItemID) as any;
            const refusal = new Error(
              `لا يمكن حذف فاتورة الشراء - "${info?.ItemName || line.ItemID}" لم تعد بالمخزن `
              + `(المطلوب ${line.Quantity}، المتاح ${held})`);
            (refusal as any).userRefusal = true;
            throw refusal;
          }
        }

        const details = db.prepare('SELECT * FROM purchase_details WHERE PurchaseID = ?').all(purchaseId) as any[];

        // Reverse stock changes (recalculate weighted average cost)
        for (const item of details) {
          // Read the device's CURRENT cost before its record is removed — it is
          // needed below to reverse the right value, and reading it afterwards
          // always returned nothing.
          const deviceCost = item.IMEI
            ? (db.prepare('SELECT CostPrice FROM item_serials WHERE IMEI = ?')
                .get(item.IMEI) as any)?.CostPrice ?? null
            : null;
          if (item.IMEI) {
            // No `Status = 'available'` filter: the guard above already refused
            // the deletion if this handset had left the shelf. Filtering here
            // meant a sold or returned device silently survived while its unit
            // of stock was removed anyway.
            db.prepare('DELETE FROM item_serials WHERE IMEI = ?').run(item.IMEI);
          }
          if (item.ItemID) {
            const stock = db.prepare('SELECT ID, Quantity, CostPrice FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?').get(item.ItemID, item.WarehouseID) as any;
            if (stock) {
              const oldTotal = stock.CostPrice * stock.Quantity;
              // Reverse the LANDED cost, which is what was capitalised into
              // stock. Using the bare supplier price left this line's share of
              // shipping and fees behind, inflating the cost of the stock that
              // remained. `EffectiveUnitCost` is null on rows written before it
              // existed, so fall back to the base figure for those.
              let unitLanded = item.EffectiveUnitCost ?? item.UnitCost;

              // For a handset, use the cost the DEVICE actually carries.
              //
              // Its value can have moved since it arrived: when another return
              // emptied its line, that line's unrecoverable freight was loaded
              // onto the devices left on the shelf, and this one is now worth
              // more than the invoice says. Reversing the invoice figure left
              // the difference stranded — deleting the purchase destroyed the
              // absorbed freight and the books fell by exactly that amount.
              if (deviceCost != null) unitLanded = deviceCost;
              const removedTotal = unitLanded * item.Quantity;

              // Value the device picked up AFTER it was received has no home
              // once the receipt is undone.
              //
              // Deleting a purchase reverses what the supplier charged. If an
              // earlier return had loaded its unrecoverable freight onto this
              // handset, the device is now worth more than the invoice — and
              // that extra came from a delivery the shop really paid for. It is
              // written off rather than silently destroyed, so assets and
              // liabilities fall by the same amount and the difference is
              // reported instead of quietly reducing net worth.
              const invoiceLanded = (item.EffectiveUnitCost ?? item.UnitCost ?? 0) * item.Quantity;
              const strandedOnDevice = removedTotal - invoiceLanded;
              if (Math.abs(strandedOnDevice) > 1e-9) {
                recordValuationResidual(db, {
                  date: businessToday(),
                  itemId: item.ItemID,
                  warehouseId: item.WarehouseID ?? null,
                  amount: strandedOnDevice,
                  reason: 'حذف فاتورة شراء لجهاز يحمل مصاريف شحن مُحمَّلة',
                  refType: 'purchase_delete',
                  refId: purchaseId,
                });
              }
              const newQty = stock.Quantity - item.Quantity;
              const newCost = newQty > 0 ? ((oldTotal - removedTotal) / newQty) : 0;
              db.prepare('UPDATE stock_quantities SET Quantity = ?, CostPrice = ? WHERE ID = ?').run(newQty, newCost, stock.ID);

              // Emptying the pool strands whatever value is left in it.
              //
              // The invoice is reversed at what the supplier charged, but the
              // pool can be carrying more than that — most often the
              // unrecoverable freight from an earlier return, pushed onto the
              // units that stayed behind. While units remain that difference
              // simply re-spreads over them; at zero quantity there is nothing
              // to hold it, and forcing the cost to 0 destroyed it silently.
              // Recording it keeps assets and liabilities falling together and
              // makes the loss reportable.
              if (newQty <= 0) {
                const stranded = oldTotal - removedTotal;
                if (Math.abs(stranded) > 1e-9) {
                  recordValuationResidual(db, {
                    date: businessToday(),
                    itemId: item.ItemID,
                    warehouseId: item.WarehouseID ?? null,
                    amount: stranded,
                    reason: 'حذف فاتورة شراء أفرغ المخزن وترك قيمة بلا رصيد',
                    refType: 'purchase_delete',
                    refId: purchaseId,
                  });
                }
              }
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

      // An advance already recovered from a salary is part of that salary's
      // arithmetic and cannot be unpicked from here.
      //
      // The delete puts the cash back in the drawer, but the employee has
      // ALREADY had the same amount withheld from their pay — so the shop ends
      // up holding the money twice and the employee is short. Measured by the
      // fuzzer: 221.61 appearing from nowhere after deleting a settled advance.
      if (advance.IsDeducted) {
        return {
          success: false,
          message: 'لا يمكن حذف سلفية تم خصمها من راتب بالفعل — '
            + 'احذف الراتب أولاً أو أصدر تسوية.',
        };
      }

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

      // A settlement variance is not a document the user created, it is the
      // RECORD of a stocktake result. `settlements:apply` writes the counted
      // balance straight to the account and then raises this voucher purely so
      // the shortage or surplus reaches the income statement.
      //
      // Deleting it therefore deletes only the evidence: measured, a 192 cash
      // shortage left the drawer at 499,808 while the expense vanished from
      // the books, so the shop's own profit figure claimed 192 it did not
      // have. Nothing here can put the money back, because nothing here took
      // it. The settlement itself is the thing to reverse.
      if (voucher.ReferenceType === 'settlement') {
        return {
          success: false,
          message: 'لا يمكن حذف سند تسوية جردية — هذا السند هو سجل فرق الجرد. '
            + 'لتصحيحه أنشئ تسوية جديدة بالرصيد الصحيح.',
        };
      }

      const tx = db.transaction(() => {
        // Give back exactly what was taken — from ONE account.
        //
        // Mirrors the fix in `vouchers:create`. This reversal used to credit
        // the cash box AND the wallet whenever the voucher named both, so
        // deleting a 300 receipt removed 600. Left as it was, it would also
        // have "corrected" the create-side double count by accident on delete
        // and left a real one-account voucher short. The reversal must undo
        // precisely what the create did: the wallet when there is one,
        // otherwise the cash box.
        const back = voucher.VoucherType === 'receipt' ? -1 : 1;
        if (voucher.PaymentMethodID) {
          db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?')
            .run(back * voucher.Amount, voucher.PaymentMethodID);
        } else if (voucher.CashAccountID) {
          db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?')
            .run(back * voucher.Amount, voucher.CashAccountID);
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

        // Put the transferred principal back where it came from.
        //
        // Mirrors `serviceSales:create`, which debits the principal from the
        // wallet when there is one and from the cash drawer otherwise. This
        // reversal used to credit the wallet only, so a cash-funded transfer
        // that was cancelled never got its principal back.
        if (sale.Amount > 0) {
          if (sale.PaymentMethodID) {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(sale.Amount, sale.PaymentMethodID);
          } else if (sale.CashAccountID) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(sale.Amount, sale.CashAccountID);
          }
        }

        // Give back the provider and transfer fees.
        //
        // `serviceSales:create` debits `ServiceCost + TransferCost` from the
        // funding source as a REAL outflow — that was itself a fix for cash
        // being invented out of nothing. The deletion never returned it, so
        // cancelling a service quietly kept the fee.
        //
        // Measured on a 1,000 transfer charged 1,020 with a 5 fee: creating
        // then deleting left the cash box 5 SHORT of where it started when the
        // fee came out of cash, and 5 OVER when it came out of the wallet —
        // value destroyed in one direction and invented in the other, from an
        // operation that is supposed to be perfectly neutral.
        //
        // The refund must follow the same account the charge did, in the same
        // order of preference, or the money reappears in the wrong pocket.
        const feesPaid = (sale.ServiceCost || 0) + (sale.TransferCost || 0);
        if (feesPaid > 0) {
          if (sale.PaymentMethodID) {
            db.prepare('UPDATE payment_methods SET Balance = Balance + ? WHERE PaymentMethodID = ?').run(feesPaid, sale.PaymentMethodID);
          } else if (sale.CashAccountID) {
            db.prepare('UPDATE cash_accounts SET Balance = Balance + ? WHERE CashAccountID = ?').run(feesPaid, sale.CashAccountID);
          }
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

      const blockedMd = blockIfReferenced(db, [
        { sql: 'SELECT COUNT(*) as n FROM maintenance_returns WHERE DeliveryID = ?', params: [deliveryId], label: 'مرتجع صيانة مرتبط' },
      ]);
      if (blockedMd) {
        return { success: false, message: `لا يمكن حذف التسليم - يوجد ${blockedMd}. احذفه أولاً.` };
      }

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
                // At the cost the goods left at, so the value restored matches
                // the value removed rather than the pool's current average.
                restoreStockAtCost(db, sd.ItemID, sd.WarehouseID, sd.Quantity, sd.UnitCost || 0);
              }
            }
            // NO customer/cash reversal from the mirror invoice.
            //
            // `maintenance:deliver` charges the customer and banks the payment
            // exactly ONCE, from the DELIVERY record (steps 5 and 6 of that
            // handler). The `sales` row it also writes is a MIRROR whose only
            // purpose is to print an invoice and feed the sales reports: it
            // repeats the same PaidAmount and RemainingAmount figures, but no
            // money was ever moved on its behalf.
            //
            // Reversing it here as if it were a normal sale undid the same
            // debt twice. Measured on a 1,000 repair with 400 paid: the
            // customer owed 600 before the delete and was left at -600 after
            // it, so the shop's books said it OWED the customer 600 for a
            // repair that had simply been cancelled. On a fully-unpaid 800
            // repair the swing was the full 1,600.
            //
            // The cash legs happened to be harmless only because `deliver`
            // deliberately stores CashAccountID/PaymentMethodID on the mirror
            // as NULL when the other one is used — an accident of that
            // defence, not a guarantee. They are removed for the same reason:
            // the money is already reversed above from `delivery.PaidAmount`.
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

        // The transfer wrote a 'TRC-' expense voucher for its commission; remove
        // it too, otherwise the fee stays on the P&L after the transfer is gone.
        if (transfer.TransferCost > 0) {
          const trcNumber = `TRC-${String(transfer.Date || '').replace(/-/g, '')}`;
          db.prepare(`
            DELETE FROM vouchers
            WHERE VoucherType = 'payment' AND PartyType = 'general'
              AND Date = ? AND Amount = ? AND VoucherNumber LIKE ?
          `).run(transfer.Date, transfer.TransferCost, `${trcNumber}%`);
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
