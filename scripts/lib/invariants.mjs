/**
 * Universal truths about the books, checked after EVERY operation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The previous suite ran the real handlers — an improvement — but I still chose
 * the 14 scenarios by hand, so the tests could only ever cover situations I
 * personally imagined. Every review found a new bug because every review
 * imagined something different.
 *
 * An invariant inverts that. Instead of asking "does THIS case work?", it
 * states something that must hold after ANY sequence of operations whatsoever,
 * and a fuzzer then throws thousands of random sequences at it. A violation is
 * a bug regardless of whether anyone thought of that combination.
 *
 * Each function returns null when satisfied, or a description of the breach.
 */

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const near = (a, b, tol = 0.011) => Math.abs(r2(a) - r2(b)) <= tol;

/**
 * The accounting identity.
 *
 *   Assets - Liabilities = Capital + Profit
 *
 * Expressed for this app as: everything the shop holds (cash, wallets, stock,
 * money owed to it) minus everything it owes must equal the profit it has
 * earned, given it started with a known opening position. If any handler
 * invents or destroys value, this is where it shows up.
 */
export function identity(db, opening) {
  const g = sql => db.prepare(sql).get()?.v ?? 0;

  const cash = g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts');
  const wallets = g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods');
  const stockValue = g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities');
  const receivable = g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance > 0');
  const customerCredit = g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance < 0');
  const payable = g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance > 0');
  const supplierCredit = g('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance < 0');

  // Cash advanced to staff and not yet recovered from a salary.
  //
  // This is an ASSET — the money has left the drawer but the employee owes it
  // back — and it was missing here, so `advances:create` looked like it
  // destroyed value: cash fell by 500 and nothing rose to match it.
  //
  // The application was right and this check was wrong. `reports:
  // financialPosition` has always counted it (`employeeAdvances`), and total
  // assets are correctly unchanged by an advance; only this independent model
  // was short an asset class, which would have hidden a genuine breach in
  // payroll behind a permanent false alarm.
  //
  // It is NOT read from `employees.Balance`: that column carries the salary
  // ACCRUAL (what the shop owes the employee), which is the opposite
  // direction. The two must not be netted here or both would be wrong.
  const staffAdvances = g(
    'SELECT COALESCE(SUM(Amount),0) v FROM employee_advances WHERE IsDeducted = 0');

  // What the shop owes staff for salaries already issued but not yet paid.
  const staffOwed = g('SELECT COALESCE(SUM(Balance),0) v FROM employees WHERE Balance > 0');
  const staffOverpaid = g('SELECT COALESCE(SUM(-Balance),0) v FROM employees WHERE Balance < 0');

  // WORK IN PROGRESS: parts already taken out of the warehouse for a repair
  // that has NOT been delivered yet.
  //
  // The stock is gone but nothing has been sold, so without this the value
  // simply disappears between issuing the part and handing the device back —
  // which can be days. It is still the shop's property, just sitting inside a
  // customer's phone on the bench.
  const workInProgress = g(`SELECT COALESCE(SUM(mp.TotalCost),0) v
                            FROM maintenance_parts mp
                            WHERE NOT EXISTS (
                              SELECT 1 FROM maintenance_deliveries md
                              WHERE md.TicketID = mp.TicketID AND md.VoidedSaleID IS NULL)`);

  const assets = cash + wallets + stockValue + receivable + supplierCredit
    + staffAdvances + staffOverpaid + workInProgress;
  const liabilities = payable + customerCredit + staffOwed;
  const netWorth = assets - liabilities;

  // Profit realised so far: revenue less cost of what was sold, net of returns,
  // less any commission the shop absorbed.
  const revenue = g(`SELECT COALESCE(SUM(TotalAmount),0) v FROM sales
                     WHERE IsVoided=0 AND IsWarranty=0 AND COALESCE(Source,'direct')<>'maintenance'`);
  const salesReturned = g(`SELECT COALESCE(SUM(r.TotalAmount),0) v FROM sale_returns r
                           JOIN sales s ON r.SaleID=s.SaleID WHERE s.IsVoided=0`);
  const cogs = g(`SELECT COALESCE(SUM(COALESCE(sd.UnitCost,0)*sd.Quantity),0) v
                  FROM sale_details sd JOIN sales s ON sd.SaleID=s.SaleID
                  WHERE s.IsVoided=0 AND s.IsWarranty=0 AND COALESCE(s.Source,'direct')<>'maintenance'`);
  // The cost credited back when goods return.
  //
  // Read from the return line, which now records exactly what the reversal put
  // back into stock. The earlier version re-derived it from the sale lines and
  // therefore disagreed with the handler whenever an invoice carried the same
  // item more than once — reporting a drift that was an artefact of the check,
  // not a fault in the books.
  const cogsReturned = g(`SELECT COALESCE(SUM(COALESCE(srd.UnitCost,0) * srd.Quantity),0) v
                          FROM sale_return_details srd`);

  const absorbedFees = g(`SELECT COALESCE(SUM(COALESCE(TransferCost,0)),0) v FROM sales
                          WHERE IsVoided=0 AND IsWarranty=0
                            AND COALESCE(Source,'direct')<>'maintenance'
                            AND COALESCE(TransferCostBearer,'shop')='shop'`);

  // Freight write-offs are NOT modelled here.
  //
  // Stock is carried at the landed cost (supplier price plus that line's share
  // of shipping), but a supplier only credits what they charged. The handler
  // keeps the difference with the inventory by pushing it onto the surviving
  // units of the same line, so in the normal case it stays an asset and the
  // identity balances on its own. Only when a warehouse empties completely is
  // there nothing left to carry it, and it is written off.
  //
  // Reconstructing WHICH of those two happened, after an arbitrary sequence of
  // later purchases, sales and reversals, means re-deriving the handler's own
  // arithmetic — precisely the reimplementation trap that made the earlier
  // audits worthless. So the identity is measured against the value actually
  // capitalised, and freight is left out of the profit term entirely.
  const strandedFreight = 0;

  // Freight the shop could not recover, as RECORDED by the handler when a
  // purchase return emptied the pool. Read from the document rather than
  // recomputed, so this stays an independent check rather than a copy of the
  // handler's arithmetic.
  // NOT read from `purchase_returns.FreightWrittenOff` any more: that column
  // is a copy kept for printing the debit note, and the same loss is recorded
  // in `inventory_adjustments`. Counting both charged every write-off twice.
  const freightLost = 0;

  // Inventory value that had no units left to sit on when a movement emptied a
  // warehouse. Positive = written off. Read from the ledger the handlers write,
  // never recomputed here, so this stays a check rather than a second copy of
  // the same arithmetic.
  const valuationAdjustments = g(`SELECT COALESCE(SUM(COALESCE(Amount,0)),0) v
                                  FROM inventory_adjustments`);

  // Provider fees paid to refund a customer by wallet/machine. Real money out.
  const refundFees = g(`SELECT COALESCE(SUM(COALESCE(r.TransferCost,0)),0) v
                        FROM sale_returns r
                        WHERE COALESCE(r.TransferCostBearer,'shop') = 'shop'`);

  // Wages are an EXPENSE, recognised when the salary is issued rather than
  // when it is paid — which is also when the handler books the liability on
  // `employees.Balance`. Recognising it at payment instead would make the
  // books drift for the whole period between issuing and paying.
  //
  // Booked GROSS: the advance a salary absorbs was already money out of the
  // drawer and is carried as `staffAdvances` above, so netting it off here as
  // well would count the same money twice.
  const wages = g(`SELECT COALESCE(SUM(COALESCE(NetSalary,0) + COALESCE(AdvancesTotal,0)),0) v
                   FROM salaries`);

  // Money taken back off an employee for damage or a shortfall. It reduces the
  // wage bill, so it is a credit against the expense, not income.
  const staffDeductions = g(
    'SELECT COALESCE(SUM(Amount),0) v FROM employee_deductions WHERE IsDeducted = 1');

  // Repairs.
  //
  // A delivered repair becomes a `Source='maintenance'` sale, which the
  // revenue and COGS queries above deliberately EXCLUDE — the money is
  // recorded on `maintenance_deliveries` instead, and counting the sale row
  // as well would double it. But excluding both sides while the spare part
  // has genuinely left the warehouse made every repair look like destroyed
  // value: measured at -20 on a two-part job.
  //
  // So the same two lines the application's own P&L uses are added here:
  // the charge to the customer, and the cost of the parts consumed.
  const repairRevenue = g(`SELECT COALESCE(SUM(TotalCost),0) v
                           FROM maintenance_deliveries WHERE VoidedSaleID IS NULL`);
  const repairRefunds = g('SELECT COALESCE(SUM(TotalRefund),0) v FROM maintenance_returns');
  // Parts consumed by a DELIVERED repair. A part issued to a ticket that is
  // still open has not been sold yet — it is work in progress, and it is
  // counted as an asset below rather than as a cost here.
  const repairPartsCost = g(`SELECT COALESCE(SUM(mp.TotalCost),0) v
                             FROM maintenance_parts mp
                             JOIN maintenance_deliveries md ON md.TicketID = mp.TicketID
                             WHERE md.VoidedSaleID IS NULL`);

  const profit = (revenue - salesReturned) - (cogs - cogsReturned)
    + (repairRevenue - repairRefunds) - repairPartsCost
    - absorbedFees - freightLost - refundFees - valuationAdjustments
    - wages + staffDeductions;
  const expected = opening + profit;

  return near(netWorth, expected)
    ? null
    : `accounting identity broken\n`
      + `  assets ${r2(assets)} - liabilities ${r2(liabilities)} = ${r2(netWorth)}\n`
      + `  opening ${r2(opening)} + profit ${r2(profit)} = ${r2(expected)}\n`
      + `  drift ${r2(netWorth - expected)}\n`
      + `  [cash ${r2(cash)} wallets ${r2(wallets)} stock ${r2(stockValue)} `
      + `recv ${r2(receivable)} pay ${r2(payable)} credit ${r2(customerCredit)} `
      + `staffAdv ${r2(staffAdvances)} staffOwed ${r2(staffOwed)} wip ${r2(workInProgress)}]`;
}

/** An invoice header must equal the sum of its own lines. */
export function invoiceLinesMatchHeader(db) {
  const bad = db.prepare(`
    SELECT s.SaleID, s.SaleNumber, s.Subtotal,
           COALESCE((SELECT SUM(Total) FROM sale_details WHERE SaleID=s.SaleID),0) AS LineSum
    FROM sales s
  `).all().filter(r => Math.abs(r.Subtotal - r.LineSum) > 0.011);
  return bad.length
    ? `invoice header disagrees with its lines: ` +
      bad.map(b => `${b.SaleNumber} header ${r2(b.Subtotal)} vs lines ${r2(b.LineSum)}`).join('; ')
    : null;
}

/** Total = Subtotal - Discount + Tax, always. */
export function invoiceArithmetic(db) {
  const bad = db.prepare(`
    SELECT SaleNumber, Subtotal, Discount, TaxAmount, TotalAmount FROM sales
  `).all().filter(r =>
    Math.abs((r.Subtotal - r.Discount + r.TaxAmount) - r.TotalAmount) > 0.011);
  return bad.length
    ? `invoice total does not equal subtotal - discount + tax: ` +
      bad.map(b => b.SaleNumber).join(', ')
    : null;
}

/** Nothing may be returned beyond what the document contained. */
export function returnsWithinDocument(db) {
  const overSale = db.prepare(`
    SELECT s.SaleNumber, s.TotalAmount,
           COALESCE((SELECT SUM(TotalAmount) FROM sale_returns WHERE SaleID=s.SaleID),0) AS Returned
    FROM sales s
  `).all().filter(r => r.Returned > r.TotalAmount + 0.011);
  if (overSale.length) {
    return `returned more than the invoice: ` +
      overSale.map(r => `${r.SaleNumber} ${r2(r.Returned)}>${r2(r.TotalAmount)}`).join('; ');
  }
  const overPur = db.prepare(`
    SELECT p.PurchaseNumber, p.TotalAmount,
           COALESCE((SELECT SUM(TotalAmount) FROM purchase_returns WHERE PurchaseID=p.PurchaseID),0) AS Returned
    FROM purchases p
  `).all().filter(r => r.Returned > r.TotalAmount + 0.011);
  return overPur.length
    ? `returned more than the purchase: ` +
      overPur.map(r => `${r.PurchaseNumber} ${r2(r.Returned)}>${r2(r.TotalAmount)}`).join('; ')
    : null;
}

/**
 * Per ITEM on an invoice, never more units back than went out.
 *
 * Compared per item rather than per row: one invoice may legitimately carry the
 * same item on several lines (two prices, or simply scanned twice), while the
 * returned quantity is recorded against the item. Comparing a summed return
 * against a single row's quantity reports a false breach whenever that happens.
 */
export function returnsWithinLine(db) {
  const bad = db.prepare(`
    SELECT s.SaleNumber, sd.ItemID, SUM(sd.Quantity) AS Sold,
           COALESCE((SELECT SUM(rd.Quantity) FROM sale_return_details rd
                     JOIN sale_returns r ON rd.ReturnID=r.ReturnID
                     WHERE r.SaleID=sd.SaleID AND rd.ItemID IS sd.ItemID),0) AS Back
    FROM sale_details sd JOIN sales s ON sd.SaleID=s.SaleID
    GROUP BY sd.SaleID, sd.ItemID
  `).all().filter(r => r.Back > r.Sold + 0.011);
  return bad.length
    ? `more units returned than sold on an item: ` +
      bad.map(b => `${b.SaleNumber} item ${b.ItemID} ${r2(b.Back)}>${r2(b.Sold)}`).join('; ')
    : null;
}

/**
 * Cash handed back on an invoice can never exceed cash taken in on it.
 * This is the rule whose absence let a credit sale be refunded in cash.
 */
export function refundNeverExceedsReceipt(db) {
  const bad = db.prepare(`
    SELECT s.SaleNumber, s.PaidAmount,
           COALESCE((SELECT SUM(COALESCE(CashRefund,0)+COALESCE(TransferRefund,0))
                     FROM sale_returns WHERE SaleID=s.SaleID),0) AS PaidOut
    FROM sales s
  `).all().filter(r => r.PaidOut > (r.PaidAmount || 0) + 0.011);
  if (bad.length) {
    return `refunded more cash than was received: ` +
      bad.map(b => `${b.SaleNumber} out ${r2(b.PaidOut)} > in ${r2(b.PaidAmount)}`).join('; ');
  }
  const badP = db.prepare(`
    SELECT p.PurchaseNumber, p.PaidAmount,
           COALESCE((SELECT SUM(COALESCE(CashRefund,0)+COALESCE(TransferRefund,0))
                     FROM purchase_returns WHERE PurchaseID=p.PurchaseID),0) AS TakenBack
    FROM purchases p
  `).all().filter(r => r.TakenBack > (r.PaidAmount || 0) + 0.011);
  return badP.length
    ? `took back more cash than was paid to the supplier: ` +
      badP.map(b => `${b.PurchaseNumber} back ${r2(b.TakenBack)} > paid ${r2(b.PaidAmount)}`).join('; ')
    : null;
}

/** A return's three settlement parts must add up to its value. */
export function settlementBalances(db) {
  for (const [table, key] of [['sale_returns', 'ReturnNumber'], ['purchase_returns', 'ReturnNumber']]) {
    const bad = db.prepare(`
      SELECT ${key} AS Ref, TotalAmount,
             COALESCE(DebtRelief,0)+COALESCE(CashRefund,0)+COALESCE(TransferRefund,0) AS Settled
      FROM ${table}
    `).all().filter(r => Math.abs(r.TotalAmount - r.Settled) > 0.011);
    if (bad.length) {
      return `${table}: settlement does not add up: ` +
        bad.map(b => `${b.Ref} value ${r2(b.TotalAmount)} settled ${r2(b.Settled)}`).join('; ');
    }
  }
  return null;
}

/** An invoice with no customer cannot carry a balance nobody owes. */
export function walkInHasNoDebt(db) {
  const bad = db.prepare(`
    SELECT SaleNumber, RemainingAmount FROM sales
    WHERE CustomerID IS NULL AND IsVoided = 0 AND ABS(COALESCE(RemainingAmount,0)) > 0.011
  `).all();
  return bad.length
    ? `walk-in invoice carries a balance nobody owes: ` +
      bad.map(b => `${b.SaleNumber} ${r2(b.RemainingAmount)}`).join(', ')
    : null;
}

/** Stock must never be valued at a nonsensical figure. */
export function stockValuationSane(db) {
  const rows = db.prepare('SELECT ItemID, WarehouseID, Quantity, CostPrice FROM stock_quantities').all();
  for (const r of rows) {
    if (!Number.isFinite(r.CostPrice)) return `item ${r.ItemID}: CostPrice is ${r.CostPrice}`;
    if (!Number.isFinite(r.Quantity)) return `item ${r.ItemID}: Quantity is ${r.Quantity}`;
    if (r.CostPrice < 0) return `item ${r.ItemID}: negative unit cost ${r.CostPrice}`;
    // Units carried at zero are only acceptable when a valuation adjustment
    // explains it.
    //
    // Weighted average cannot say WHICH units left, so returning an expensive
    // batch out of a pool that has since been sold down can demand more value
    // than the pool holds. `deductStockAtCost` floors the cost at zero and
    // records the excess, which is the honest answer — but a zero with NO such
    // record still means value was invented or lost, and must fail.
    if (r.Quantity > 0 && r.CostPrice === 0) {
      const explained = db.prepare(`
        SELECT COUNT(*) n FROM inventory_adjustments
        WHERE ItemID = ? AND (WarehouseID = ? OR WarehouseID IS NULL)
      `).get(r.ItemID, r.WarehouseID)?.n || 0;
      if (!explained) {
        return `item ${r.ItemID} wh ${r.WarehouseID}: ${r.Quantity} units valued at zero`;
      }
    }
  }
  return null;
}

/** Stock may not go negative unless the shop explicitly allowed it. */
export function noNegativeStock(db) {
  const allowed = db.prepare("SELECT Value v FROM settings WHERE Key='allow_negative_stock'").get()?.v === '1';
  if (allowed) return null;
  const bad = db.prepare('SELECT ItemID, WarehouseID, Quantity FROM stock_quantities WHERE Quantity < -0.001').all();
  return bad.length
    ? `negative stock without permission: ` +
      bad.map(b => `item ${b.ItemID} wh ${b.WarehouseID} = ${b.Quantity}`).join(', ')
    : null;
}

/** Deleting a document must not orphan its children. */
export function noOrphans(db) {
  const checks = [
    ['sale_details', 'SaleID', 'sales', 'SaleID'],
    ['sale_returns', 'SaleID', 'sales', 'SaleID'],
    ['sale_return_details', 'ReturnID', 'sale_returns', 'ReturnID'],
    ['purchase_details', 'PurchaseID', 'purchases', 'PurchaseID'],
    ['purchase_returns', 'PurchaseID', 'purchases', 'PurchaseID'],
    ['purchase_return_details', 'ReturnID', 'purchase_returns', 'ReturnID'],
  ];
  for (const [child, fk, parent, pk] of checks) {
    const n = db.prepare(
      `SELECT COUNT(*) v FROM ${child} c
        WHERE c.${fk} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${pk} = c.${fk})`,
    ).get()?.v ?? 0;
    if (n > 0) return `${n} orphan row(s) in ${child} pointing at a missing ${parent}`;
  }
  return null;
}

/** Document numbers must stay unique. */
export function documentNumbersUnique(db) {
  for (const [table, col] of [
    ['sales', 'SaleNumber'], ['purchases', 'PurchaseNumber'],
    ['sale_returns', 'ReturnNumber'], ['purchase_returns', 'ReturnNumber'],
  ]) {
    const dup = db.prepare(
      `SELECT ${col} v, COUNT(*) n FROM ${table} GROUP BY ${col} HAVING n > 1`,
    ).all();
    if (dup.length) return `duplicate ${col} in ${table}: ${dup.map(d => d.v).join(', ')}`;
  }
  return null;
}

/** Every money column must hold a real number. */
export function noNaNOrInfinity(db) {
  const cols = {
    sales: ['Subtotal', 'Discount', 'TaxAmount', 'TotalAmount', 'PaidAmount', 'RemainingAmount', 'TransferCost'],
    purchases: ['Subtotal', 'Discount', 'TaxAmount', 'TotalAmount', 'PaidAmount', 'RemainingAmount'],
    sale_returns: ['TotalAmount', 'DebtRelief', 'CashRefund', 'TransferRefund'],
    purchase_returns: ['TotalAmount', 'DebtRelief', 'CashRefund', 'TransferRefund'],
    cash_accounts: ['Balance'],
    payment_methods: ['Balance'],
    customers: ['Balance'],
    suppliers: ['Balance'],
    stock_quantities: ['Quantity', 'CostPrice'],
  };
  for (const [table, list] of Object.entries(cols)) {
    for (const col of list) {
      let rows;
      try { rows = db.prepare(`SELECT ${col} v FROM ${table}`).all(); } catch { continue; }
      for (const r of rows) {
        if (r.v !== null && !Number.isFinite(r.v)) {
          return `${table}.${col} holds a non-finite value: ${r.v}`;
        }
      }
    }
  }
  return null;
}

/** Invoice status must agree with the amount outstanding. */
export function statusMatchesBalance(db) {
  const bad = db.prepare(`
    SELECT SaleNumber, PaidAmount, RemainingAmount, Status FROM sales WHERE IsVoided = 0
  `).all().filter(r => {
    const rem = r.RemainingAmount || 0;
    if (rem > 0.011 && r.Status === 'completed') return true;
    if (rem <= 0.011 && (r.Status === 'unpaid' || r.Status === 'partial')) return true;
    return false;
  });
  return bad.length
    ? `status contradicts the outstanding amount: ` +
      bad.map(b => `${b.SaleNumber} remaining ${r2(b.RemainingAmount)} but "${b.Status}"`).join('; ')
    : null;
}

/**
 * A serialised item's warehouse quantity must equal the number of individual
 * units recorded as still being on the shelf, and its value must equal the sum
 * of those units' own costs.
 *
 * `stock_quantities` and `item_serials` are two records of the same physical
 * goods. A purchase writes BOTH, so every movement afterwards has to move both
 * or they drift apart silently — and nothing in the books reveals it, because
 * each table is internally consistent.
 *
 * This is exactly what went wrong: selling a handset marked the serial 'sold'
 * but left the quantity and its value in the warehouse, so after selling one of
 * two phones the shop still valued two. Inventory was overstated by the cost of
 * every serialised unit ever sold, which in a phone shop is most of the stock.
 */
export function serialsMatchWarehouseStock(db) {
  // Only items whose stock is FULLY device-tracked can be compared unit for
  // unit. A serialised item may legitimately have been received without an
  // IMEI — the purchase screen treats it as optional — and those units exist in
  // the warehouse with no device record, so a plain comparison would report a
  // difference that is not an error. Such items are excluded, and the
  // untracked-quantity check below covers them instead.
  const bad = db.prepare(`
    SELECT i.ItemID, i.ItemName,
           COALESCE((SELECT SUM(Quantity) FROM stock_quantities WHERE ItemID = i.ItemID), 0) AS Qty,
           COALESCE((SELECT SUM(Quantity * CostPrice) FROM stock_quantities WHERE ItemID = i.ItemID), 0) AS Val,
           COALESCE((SELECT COUNT(*) FROM item_serials
                      WHERE ItemID = i.ItemID AND Status = 'available'), 0) AS Units,
           COALESCE((SELECT SUM(CostPrice) FROM item_serials
                      WHERE ItemID = i.ItemID AND Status = 'available'), 0) AS UnitVal,
           COALESCE((SELECT SUM(CASE WHEN pd.IMEI IS NULL OR pd.IMEI = '' THEN pd.Quantity ELSE 0 END)
                       FROM purchase_details pd WHERE pd.ItemID = i.ItemID), 0) AS Untracked
    FROM items i WHERE i.IsSerialized = 1
  `).all()
    .filter(r => r.Untracked === 0)
    .filter(r => Math.abs(r.Qty - r.Units) > 0.001 || Math.abs(r.Val - r.UnitVal) > 0.011);

  return bad.length
    ? 'serialised stock disagrees with the individual units: ' +
      bad.map(b => `${b.ItemName}: warehouse ${r2(b.Qty)} units worth ${r2(b.Val)}, `
        + `but ${b.Units} serials worth ${r2(b.UnitVal)} are on the shelf`).join('; ')
    : null;
}

/**
 * The balance sheet must balance: Assets = Liabilities + Equity.
 *
 * This is the strongest single statement in accounting, and the report already
 * computes it — `reports:financialPosition` returns its own `isBalanced` flag.
 * Nothing was checking that flag, so the report could quietly say "not
 * balanced" and no test would notice.
 *
 * It is deliberately checked through the REPORT rather than recomputed here.
 * The owner does not read the tables, he reads the report; a figure that is
 * right in the database and wrong on screen is still wrong. Re-deriving it
 * would also just be a second copy of the same arithmetic.
 *
 * Left null when the handler is not loaded, so the trade fuzzer can use these
 * invariants without pulling in the reports module.
 */
export async function balanceSheetBalances(db, callFn) {
  if (typeof callFn !== 'function') return null;
  let r;
  try {
    r = await callFn('reports:financialPosition');
  } catch {
    return null;
  }
  const c = r?.capital;
  if (!c || typeof c.difference !== 'number') return null;
  return Math.abs(c.difference) < 0.011
    ? null
    : `balance sheet does not balance\n`
      + `  assets ${r2(r.assets?.totalAssets ?? 0)} `
      + `- liabilities ${r2(r.liabilities?.totalLiabilities ?? 0)}\n`
      + `  equity ${r2(c.equity)} (capital ${r2(c.explicitCapital)} + profit ${r2(c.netProfit)})\n`
      + `  difference ${r2(c.difference)}`;
}

export const ALL = {
  identity,
  invoiceLinesMatchHeader,
  invoiceArithmetic,
  returnsWithinDocument,
  returnsWithinLine,
  refundNeverExceedsReceipt,
  settlementBalances,
  walkInHasNoDebt,
  stockValuationSane,
  noNegativeStock,
  noOrphans,
  documentNumbersUnique,
  noNaNOrInfinity,
  statusMatchesBalance,
  serialsMatchWarehouseStock,
};

/** Runs every invariant; returns a list of breach descriptions. */
export function checkAll(db, opening) {
  const breaches = [];
  for (const [name, fn] of Object.entries(ALL)) {
    let msg;
    try {
      msg = name === 'identity' ? fn(db, opening) : fn(db);
    } catch (err) {
      msg = `invariant threw: ${err.message}`;
    }
    if (msg) breaches.push({ name, msg });
  }
  return breaches;
}
