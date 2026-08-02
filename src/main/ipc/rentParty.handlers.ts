import { ipcMain } from 'electron';
import { getDb } from '../database/connection';
import { businessToday } from '../../shared/businessDate';

/**
 * LANDLORDS AND TENANTS.
 *
 * WHY THIS SECTION EXISTS
 * -----------------------
 * The other party to a rent agreement was two free-text columns on the
 * contract: PartyName and PartyPhone. That cannot carry a balance, cannot be
 * looked up, and produces a different "party" every time the name is typed
 * with a different spacing. A landlord renting three units to the shop was
 * three unrelated strings, and there was no way to answer the only questions
 * that matter about them:
 *
 *     how much have I paid this person in total?
 *     how much do I still owe?
 *     which months are settled, and which are still due?
 *
 * Customers, suppliers and employees all have a statement. Landlords and
 * tenants had none.
 *
 * PartyKind is 'landlord' (the shop pays them) or 'tenant' (they pay the
 * shop), matching RentType expense/income.
 */
export function registerRentPartyHandlers() {
  ipcMain.handle('rentParties:list', async (_event, kind?: string) => {
    const db = getDb();
    // The roll-up is computed here rather than in the screen: a total that is
    // calculated in the renderer can disagree with the statement that prints,
    // and only one of the two would be right.
    let sql = `
      SELECT p.*,
        (SELECT COUNT(*) FROM rents r
          WHERE r.RentPartyID = p.RentPartyID
            AND COALESCE(r.Status,'active') <> 'cancelled') AS ContractCount,
        (SELECT COALESCE(SUM(t.Amount),0) FROM rent_transactions t
          WHERE t.RentPartyID = p.RentPartyID AND t.ReversedAt IS NULL) AS TotalPaid,
        (SELECT COALESCE(SUM(rp.Amount - COALESCE(rp.PaidAmount,0)),0)
           FROM rent_payments rp
           JOIN rents r ON r.RentID = rp.RentID
          WHERE r.RentPartyID = p.RentPartyID
            AND rp.Status <> 'paid' AND rp.CancelledAt IS NULL
            AND COALESCE(r.Status,'active') <> 'cancelled') AS Outstanding,
        (SELECT COALESCE(SUM(r.AdvanceBalance),0) FROM rents r
          WHERE r.RentPartyID = p.RentPartyID) AS AdvanceHeld
      FROM rent_parties p
      WHERE 1=1
    `;
    const params: any[] = [];
    if (kind === 'landlord' || kind === 'tenant') {
      sql += ' AND p.PartyKind = ?';
      params.push(kind);
    }
    sql += ' ORDER BY p.IsActive DESC, p.Name';
    return db.prepare(sql).all(...params);
  });

  ipcMain.handle('rentParties:create', async (_event, data: {
    PartyKind: string; Name: string; Phone?: string;
    NationalID?: string; Address?: string; Notes?: string;
  }) => {
    const db = getDb();
    const name = String(data?.Name ?? '').trim();
    if (name.length < 2) return { success: false, message: 'الاسم مطلوب' };
    if (data?.PartyKind !== 'landlord' && data?.PartyKind !== 'tenant') {
      return { success: false, message: 'حدد النوع: مؤجر أم مستأجر' };
    }
    // Two records with the same name and kind are almost certainly the same
    // person entered twice, and the balances would then be split across both.
    const clash = db.prepare(
      'SELECT RentPartyID FROM rent_parties WHERE PartyKind = ? AND Name = ?',
    ).get(data.PartyKind, name);
    if (clash) return { success: false, message: 'يوجد طرف بنفس الاسم والنوع' };

    const res = db.prepare(`
      INSERT INTO rent_parties (PartyKind, Name, Phone, NationalID, Address, Notes, IsActive)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      data.PartyKind, name, data.Phone ?? null,
      data.NationalID ?? null, data.Address ?? null, data.Notes ?? null,
    );
    return { success: true, id: res.lastInsertRowid };
  });

  ipcMain.handle('rentParties:update', async (_event, id: number, data: any) => {
    const db = getDb();
    const name = String(data?.Name ?? '').trim();
    if (name.length < 2) return { success: false, message: 'الاسم مطلوب' };
    const clash = db.prepare(
      'SELECT RentPartyID FROM rent_parties WHERE PartyKind = ? AND Name = ? AND RentPartyID <> ?',
    ).get(data.PartyKind, name, id);
    if (clash) return { success: false, message: 'يوجد طرف بنفس الاسم والنوع' };

    db.prepare(`
      UPDATE rent_parties SET Name = ?, Phone = ?, NationalID = ?, Address = ?,
        Notes = ?, IsActive = ?
      WHERE RentPartyID = ?
    `).run(
      name, data.Phone ?? null, data.NationalID ?? null, data.Address ?? null,
      data.Notes ?? null, data.IsActive ?? 1, id,
    );
    return { success: true };
  });

  ipcMain.handle('rentParties:delete', async (_event, id: number) => {
    const db = getDb();
    // Deactivated, never deleted: the statement of a past landlord is still a
    // record of money that moved, and removing the row would orphan it.
    const live = db.prepare(`
      SELECT COUNT(*) c FROM rents
       WHERE RentPartyID = ? AND COALESCE(Status,'active') = 'active'
    `).get(id) as any;
    if (Number(live?.c) > 0) {
      return { success: false, message: 'لا يمكن الإخفاء - يوجد عقد ساري مرتبط بهذا الطرف' };
    }
    db.prepare('UPDATE rent_parties SET IsActive = 0 WHERE RentPartyID = ?').run(id);
    return { success: true };
  });

  /**
   * A full account for one landlord or tenant.
   *
   * Answers, in one place: every contract with them, every month and whether
   * it is settled, every movement of money, what is still owed and what is
   * held as an advance.
   */
  ipcMain.handle('rentParty:statement', async (_event, partyId: number, filters?: {
    fromDate?: string; toDate?: string;
  }) => {
    const db = getDb();
    const party = db.prepare('SELECT * FROM rent_parties WHERE RentPartyID = ?').get(partyId) as any;
    if (!party) return { success: false, message: 'الطرف غير موجود' };

    const contracts = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.CancelledAt IS NULL) AS TotalInstalments,
        (SELECT COUNT(*) FROM rent_payments p
          WHERE p.RentID = r.RentID AND p.Status = 'paid') AS PaidInstalments
      FROM rents r
      WHERE r.RentPartyID = ?
      ORDER BY r.StartDate DESC
    `).all(partyId) as any[];

    const from = filters?.fromDate;
    const to = filters?.toDate;

    // Every month, with what it owes and what it has received.
    let instalmentSql = `
      SELECT rp.*, r.RentName, r.RentType,
             (rp.Amount - COALESCE(rp.PaidAmount,0)) AS Remaining
      FROM rent_payments rp
      JOIN rents r ON r.RentID = rp.RentID
      WHERE r.RentPartyID = ?
    `;
    const iParams: any[] = [partyId];
    if (from) { instalmentSql += ' AND rp.DueDate >= ?'; iParams.push(from); }
    if (to) { instalmentSql += ' AND rp.DueDate <= ?'; iParams.push(to); }
    instalmentSql += ' ORDER BY rp.DueDate';
    const instalments = db.prepare(instalmentSql).all(...iParams) as any[];

    // Every movement of money, whichever screen it came from.
    let txnSql = `
      SELECT t.*, r.RentName, rp.PeriodLabel,
             ca.AccountName AS CashAccountName, pm.MethodName AS PaymentMethodName
      FROM rent_transactions t
      JOIN rents r ON r.RentID = t.RentID
      LEFT JOIN rent_payments rp ON rp.RentPaymentID = t.RentPaymentID
      LEFT JOIN cash_accounts ca ON ca.CashAccountID = t.CashAccountID
      LEFT JOIN payment_methods pm ON pm.PaymentMethodID = t.PaymentMethodID
      WHERE r.RentPartyID = ? AND t.ReversedAt IS NULL
    `;
    const tParams: any[] = [partyId];
    if (from) { txnSql += ' AND t.TxnDate >= ?'; tParams.push(from); }
    if (to) { txnSql += ' AND t.TxnDate <= ?'; tParams.push(to); }
    txnSql += ' ORDER BY t.TxnDate, t.RentTxnID';
    const transactions = db.prepare(txnSql).all(...tParams) as any[];

    const today = businessToday();
    const totalDue = instalments
      .filter(i => !i.CancelledAt)
      .reduce((s, i) => s + (i.Amount || 0), 0);
    const totalPaid = instalments
      .filter(i => !i.CancelledAt)
      .reduce((s, i) => s + (i.PaidAmount || 0), 0);
    const outstanding = instalments
      .filter(i => !i.CancelledAt && i.Status !== 'paid')
      .reduce((s, i) => s + (i.Remaining || 0), 0);
    const overdue = instalments
      .filter(i => !i.CancelledAt && i.Status !== 'paid' && i.DueDate < today)
      .reduce((s, i) => s + (i.Remaining || 0), 0);
    const advanceHeld = contracts.reduce((s, c) => s + (c.AdvanceBalance || 0), 0);
    const nextDue = instalments
      .filter(i => !i.CancelledAt && i.Status !== 'paid')
      .map(i => i.DueDate).sort()[0] || null;

    return {
      success: true,
      party,
      contracts,
      instalments,
      transactions,
      totals: {
        totalDue, totalPaid, outstanding, overdue, advanceHeld, nextDue,
        paidCount: instalments.filter(i => i.Status === 'paid').length,
        pendingCount: instalments.filter(i => !i.CancelledAt && i.Status !== 'paid').length,
      },
    };
  });
}
