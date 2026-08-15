#!/usr/bin/env node
/**
 * MUTATION TESTING — does the test suite actually catch a broken handler?
 *
 * WHY THIS EXISTS
 * ---------------
 * Every suite in this repository reports "passed". None of them proved they
 * are capable of reporting anything else. A test that cannot fail is not
 * evidence, and this audit has already produced two of them:
 *
 *   - the metamorphic discount pair compared two SALES, so it stayed green
 *     when the discount was deliberately dropped from the return leg;
 *   - `verify_fuzz_sweep` matched the literal text "all 14 invariants held",
 *     so a fifteenth invariant made every seed report as failed.
 *
 * Both were found by breaking the code ON PURPOSE and checking the suite
 * noticed. This file automates that: it introduces a specific, realistic fault
 * into a trading handler, runs the suites, and asserts that at least one of
 * them fails. Then it puts the file back.
 *
 * A mutant that SURVIVES is the finding. It means that if a future change
 * introduces that same fault for real — a wrong sign, a dropped discount, a
 * missing stock deduction — nothing in this repository would tell anybody.
 *
 * Every mutation below is a plausible mistake, not a nonsense edit.
 *
 * Run with:  node --experimental-strip-types scripts/verify_trade_mutation.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SALES = join(ROOT, 'src/main/ipc/sales.handlers.ts');
const PURCHASES = join(ROOT, 'src/main/ipc/purchases.handlers.ts');
const STOCK = join(ROOT, 'src/main/database/stock.ts');
const MAINT = join(ROOT, 'src/main/ipc/maintenance.handlers.ts');
const INV = join(ROOT, 'src/main/ipc/inventory.handlers.ts');
const DATATABLE = join(ROOT, 'src/renderer/src/components/shared/DataTable.tsx');
const REPORTSPAGE = join(ROOT, 'src/renderer/src/pages/reports/ReportsPage.tsx');
const DBH = join(ROOT, 'src/main/ipc/database.handlers.ts');
const CONN = join(ROOT, 'src/main/database/connection.ts');
const DEL = join(ROOT, 'src/main/ipc/delete.handlers.ts');
const VOU = join(ROOT, 'src/main/ipc/vouchers.handlers.ts');
const SET = join(ROOT, 'src/main/ipc/settlement.handlers.ts');
const SVC = join(ROOT, 'src/main/ipc/services.handlers.ts');
const STMT = join(ROOT, 'src/main/ipc/statement.handlers.ts');
const REPORTS = join(ROOT, 'src/main/ipc/reports.handlers.ts');
const PAY = join(ROOT, 'src/main/ipc/payroll.handlers.ts');
const OPB = join(ROOT, 'src/main/ipc/openingBalance.handlers.ts');
const ASSETS = join(ROOT, 'src/main/ipc/assets.handlers.ts');
const USERS = join(ROOT, 'src/main/ipc/users.handlers.ts');
const FY = join(ROOT, 'src/main/ipc/fiscalYear.handlers.ts');
const TRF = join(ROOT, 'src/main/ipc/transfers.handlers.ts');
const RENT = join(ROOT, 'src/main/ipc/rent.handlers.ts');
const SCHEMA = join(ROOT, 'src/main/database/schemaVersion.ts');
const MAIN = join(ROOT, 'src/main/index.ts');

/**
 * The suites a mutant is checked against.
 *
 * Deliberately the FAST ones that cover trading. A mutant only has to be caught
 * by one of them; running the whole verify for every mutant would take minutes
 * and add nothing.
 */
const SUITES = [
  'scripts/verify_trade_metamorphic.mjs',
  'scripts/verify_fuzz_regressions.mjs',
  'scripts/verify_trade_behaviour.mjs',
  'scripts/verify_trade_ledger_model.mjs',
  'scripts/verify_trade_reports_agree.mjs',
  'scripts/verify_maintenance.mjs',
  'scripts/verify_transfers.mjs',
  'scripts/verify_renderer_crash.mjs',
  'scripts/verify_renderer_crash.mjs',
  'scripts/verify_backup_integrity.mjs',
  'scripts/verify_back_office.mjs',
  'scripts/verify_statements.mjs',
  'scripts/verify_fuzz_back_office.mjs',
  'scripts/verify_upgrade_safety.mjs',
  'scripts/verify_serial_costing.mjs',
  'scripts/verify_stock_lots.mjs',
  'scripts/verify_reports_money.mjs',
  'scripts/verify_master_data.mjs',
  'scripts/verify_users_access.mjs',
  'scripts/verify_transfers_deletes.mjs',
];

/** One realistic fault each. `find` must appear EXACTLY once, or the run aborts. */
const MUTANTS = [
  {
    // `sales:create` and `sales:update` share this line verbatim, so the text
    // is not unique. Targeting the first occurrence mutates the CREATE path,
    // which is the one every sale goes through.
    name: 'a sale does not reduce stock at all',
    file: SALES,
    find: 'deductStock(db, item.ItemID, lineWarehouse, item.Quantity);',
    replace: '/* mutant: stock not deducted */;',
    occurrence: 1,
    why: 'the single most damaging inventory fault there is',
  },
  {
    name: 'a discount is ignored when goods are returned',
    file: SALES,
    find: 'UnitPrice: money((line.UnitPrice || 0) * priceRatio),',
    replace: 'UnitPrice: money(line.UnitPrice || 0),',
    why: 'refunds more than the customer ever paid',
  },
  {
    name: 'a supplier discount is ignored on a debit note',
    file: PURCHASES,
    find: 'UnitCost: money((line.UnitCost || 0) * costRatio),',
    replace: 'UnitCost: money(line.UnitCost || 0),',
    why: 'claims more credit from the supplier than is owed',
  },
  {
    name: 'freight is left out of the landed cost',
    file: PURCHASES,
    find: '? (item.UnitCost - discountPerUnit) + (allocatedOverhead / item.Quantity)',
    replace: '? (item.UnitCost - discountPerUnit)',
    why: 'understates inventory by the whole delivery charge',
  },
  {
    name: 'returned goods come back at the pool average, not their own cost',
    file: STOCK,
    find: '    : unitCost;',
    replace: '    : (row.CostPrice || 0);',
    why: 're-values stock on every return',
  },
  {
    name: 'a repair does not take its parts out of stock',
    file: MAINT,
    find: 'deductStock(db, data.ItemID, data.WarehouseID, data.Quantity);',
    replace: '/* mutant */;',
    why: 'parts consumed by repairs would stay on the shelf for ever',
  },
  {
    name: 'the same repair can be delivered twice',
    file: MAINT,
    find: "if (ticket.Status === 'delivered') {",
    replace: 'if (false) {',
    why: 'takes the customer\'s money twice and issues two invoices',
  },
  {
    name: 'returning a repair leaves the debt on the customer',
    file: MAINT,
    find: 'const owedOnDelivery = Math.max(0, delivery.RemainingAmount || 0);',
    replace: 'const owedOnDelivery = 0;',
    why: 'the customer keeps owing for a repair that was undone',
  },
  {
    name: 'removing a part leaves its price on the ticket',
    file: MAINT,
    find: 'const chargedBack = (part.SalePrice ? part.SalePrice * part.Quantity : part.TotalCost) || 0;',
    replace: 'const chargedBack = part.TotalCost || 0;',
    why: 'the customer is billed for a part that is no longer fitted',
  },
  {
    name: 'a repair trusts the cost the caller claims',
    file: MAINT,
    find: 'const unitCost = (stockCost !== null && stockCost > 0)',
    replace: 'const unitCost = (false)',
    why: 'the ticket is charged one figure while stock loses another',
  },
  {
    name: 'a discounted repair invoice contradicts itself',
    file: MAINT,
    find: 'isWarranty ? 0 : grossTotal, isWarranty ? 0 : (grossTotal - totalCost),',
    replace: 'totalCost, discount,',
    why: 'Subtotal - Discount no longer equals the total, and the lines do not sum to it',
  },
  {
    name: 'negative money is accepted on a repair',
    file: MAINT,
    find: "      if (!Number.isFinite(v) || v < 0) {\n        return { success: false, message: `${label} يجب أن يكون رقماً غير سالب` };",
    replace: '      if (false) {\n        return { success: false, message: `${label}` };',
    why: 'a bill of -500 flows into the customer balance and the profit report',
  },
  {
    name: 'a negative transfer quantity is accepted',
    file: INV,
    find: '      if (!Number.isFinite(qty) || qty <= 0) {',
    replace: '      if (false) {',
    why: 'invents stock in one warehouse and phantom stock in another',
  },
  {
    name: 'a transfer keeps the destination price instead of the source cost',
    file: INV,
    find: 'const movedCost = existingFrom?.CostPrice ?? item.UnitCost ?? 0;',
    replace: 'const movedCost = item.UnitCost ?? 0;',
    why: 'moving goods silently writes off the difference in value',
  },
  {
    name: 'the cash refund cap is removed',
    file: SALES,
    find: 'paidSoFar: refundableCash,',
    replace: 'paidSoFar: undefined,',
    why: 'hands back money that was never received',
  },
  // ---- the blank-screen class ------------------------------------------
  // These reinstate the two faults the shop actually reported. They are here
  // because a crash that unmounts the whole application is a data-loss event,
  // not a cosmetic one: there is no error boundary to fall back to.
  {
    name: 'the table dereferences the raw prop again (the reported crash)',
    file: DATATABLE,
    find: 'const rows = asRows<T>(data);',
    replace: 'const rows = data as T[];',
    why: 'restores "Cannot read properties of undefined (reading \'length\')" and blanks the app',
  },
  {
    name: 'a report is rendered against another report\'s payload',
    file: REPORTSPAGE,
    find: 'data={report && report.type === activeReport ? report.data : null}',
    replace: 'data={report ? report.data : null}',
    why: 'the stale-tab render that produced the reported stack trace',
  },
  {
    name: 'a refused report is rendered as if it were data',
    file: REPORTSPAGE,
    find: 'if (isFailure(result)) {',
    replace: 'if (false) {',
    why: 'a permission refusal is truthy, so it reaches the table as a payload',
  },
  // ---- backup integrity -------------------------------------------------
  // Measured, not assumed: a 500-sale WAL database copied with copyFileSync
  // read back as "no such table". These mutants reinstate that.
  {
    name: 'the daily backup copies a live WAL database again',
    file: DBH,
    find: 'await db.backup(backupPath);\n\n      // Clean old backups (keep last 7 days).',
    replace: 'fs.copyFileSync(dbPath, backupPath);\n\n      // Clean old backups (keep last 7 days).',
    why: 'produces an unreadable backup while reporting success',
  },
  {
    name: 'the backup pruner deletes unrelated files again',
    file: DBH,
    find: "if (!/^auto_backup_\\d{4}-\\d{2}-\\d{2}\\.db$/.test(file)) continue;",
    replace: '',
    why: 'wipes anything older than 7 days the owner kept in that folder',
  },
  {
    name: 'the database path accepts a file that is not SQLite',
    file: DBH,
    find: "if (read < 16 || header.toString('utf-8', 0, 15) !== 'SQLite format 3') {",
    replace: 'if (false) {',
    why: 'the app only fails at the NEXT startup, and then will not open at all',
  },
  {
    name: 'the whole database may be uploaded over plain http',
    file: DBH,
    find: "if (target.protocol !== 'https:') {",
    replace: 'if (false) {',
    why: 'customers, balances and password hashes cross the network in clear',
  },
  {
    name: 'a restore targets a different file from the one the app opened',
    file: CONN,
    find: '  if (db) return db.name;',
    replace: '',
    why: 'an offline network share made the app silently use another database while the restore wrote to the unreachable one',
  },
  {
    name: 'a supplier statement ignores what was paid at the counter',
    file: STMT,
    find: '             COALESCE(PaidAmount,0) as Debit, TotalAmount as Credit,',
    replace: '             0 as Debit, TotalAmount as Credit,',
    why: 'the page the owner pays from overstated the debt, so a supplier gets paid twice',
  },
  {
    name: 'a cash-funded transfer never sends the principal out',
    file: SVC,
    find: "        if (data.Amount > 0) {\n          if (data.PaymentMethodID) {",
    replace: "        if (data.Amount > 0) {\n          if (false) {",
    why: 'the shop booked a 1,020 gain on a 1,000 transfer, inventing 1,000 per operation',
  },
  {
    name: 'a stocktake expenses a quantity as if it were money',
    file: SET,
    find: '          diff = +(diff * adjustedUnitCost).toFixed(2);',
    replace: '          diff = +(diff * 1).toFixed(2);',
    why: 'five handsets lost at cost 100 were written off as an expense of five',
  },
  {
    name: 'a salary can go negative when advances exceed the pay',
    file: PAY,
    find: '    const advancesApplied = Math.min(advancesTotal, payAfterDeductions);',
    replace: '    const advancesApplied = advancesTotal;',
    why: 'paying a negative salary ran the whole transaction backwards',
  },
  {
    name: 'the same deduction is taken every month for ever',
    file: PAY,
    find: "          UPDATE employee_deductions SET IsDeducted = 1, DeductedFromSalaryID = ?",
    replace: "          UPDATE employee_deductions SET IsDeducted = 0, DeductedFromSalaryID = ?",
    why: 'a 300 absence penalty reduced July, August and every month after',
  },
  {
    name: 'an advance already recovered can be deleted for cash',
    file: DEL,
    find: '      if (advance.IsDeducted) {',
    replace: '      if (false) {',
    why: 'the shop keeps the money twice and the employee is short',
  },
  {
    name: 'an opening balance may be negative again',
    file: OPB,
    find: "    const res = checkAmount(balance, 'الرصيد الافتتاحي للخزينة');\n    if (!res.ok) return { success: false, message: res.message };",
    replace: '',
    why: 'a wrong opening figure is permanently baked into every later balance',
  },
  {
    name: 'a warehouse transfer leaves the handsets behind',
    file: INV,
    find: '        } else if (isSerialised) {',
    replace: '        } else if (false) {',
    why: 'the pool moves but every device stays in the source warehouse',
  },
  {
    name: 'a return re-enters stock at the blended average, not its own cost',
    file: STOCK,
    find: "  returnToLots(db, itemId, warehouseId, qty, unitCost, { type: 'return' });",
    replace: '',
    why: 'buy 10@100, sell 8, buy 10@60, return the 8 -> 266.67 of value evaporates',
  },
  {
    name: 'a sale does not draw from the cost layers',
    file: STOCK,
    find: '  consumeLots(db, itemId, warehouseId, qty);\n\n  const row = db.prepare',
    replace: '  const row = db.prepare',
    why: 'the layers claim stock that has already been sold',
  },
  {
    name: 'a customer receipt is counted as income as well as collection',
    file: REPORTS,
    find: "WHERE VoucherType = 'receipt' AND (PartyType = 'general' OR PartyType IS NULL)",
    replace: "WHERE VoucherType = 'receipt'",
    why: 'collecting an old debt would be reported as fresh profit',
  },
  {
    name: 'a cash box can be created holding a negative balance',
    file: ASSETS,
    find: "    const bal = checkAmount(data?.Balance ?? 0, 'الرصيد الافتتاحي للخزينة');\n    if (!bal.ok) return { success: false, message: bal.message };",
    replace: '',
    why: 'a safe opened at -99,999 poisons every later report permanently',
  },
  {
    name: 'an item can be sold at a negative price',
    file: INV,
    find: "    const price = checkAmount(data.SalePrice, 'سعر البيع');\n    if (!price.ok) return { success: false, message: price.message };",
    replace: '',
    why: 'the shop would pay the customer to take the goods',
  },
  {
    name: 'rent can be a negative amount',
    file: RENT,
    // Anchored on the CREATE path specifically. The same two lines now also
    // guard `rents:update`, so the shorter anchor matched twice and the mutant
    // could not be placed. Including the line above it makes it unique again.
    find: "    if (!amt.ok) return { success: false, message: amt.message };\n\n    const start = String(data?.StartDate ?? '').trim();",
    replace: "\n    const start = String(data?.StartDate ?? '').trim();",
    why: 'direction is the RentType, never the sign of the money',
  },
  {
    name: 'the last administrator can be deactivated',
    file: USERS,
    find: "    if (target.RoleID === ADMIN_ROLE_ID && target.IsActive && otherActiveAdmins(db, id) === 0) {",
    replace: '    if (false) {',
    why: 'the shop is locked out of its own books with no way back but hand-editing the database',
  },
  {
    name: 'a user can be created with no password',
    file: USERS,
    find: "    const pwProblem = checkPassword(data?.password);\n    if (pwProblem) return { success: false, message: pwProblem };",
    replace: '',
    why: 'the account exists, fills a seat, and can never sign in',
  },
  {
    name: 'two fiscal years can be open over the same dates',
    file: FY,
    find: '    if (overlapping) {',
    replace: '    if (false) {',
    why: 'two open years covering the same day make the posting year ambiguous',
  },
  {
    name: 'a negative money transfer runs the movement backwards',
    file: TRF,
    find: "    if (badMoney) return { success: false, message: badMoney };",
    replace: '',
    why: '-5,000 from the safe to the bank ADDED 5,000 to the safe',
  },
  {
    name: 'money can be transferred to the account it is already in',
    file: TRF,
    find: "    if (data.FromType === data.ToType && Number(data.FromID) === Number(data.ToID)) {",
    replace: '    if (false) {',
    why: 'a no-op document that still charges the commission',
  },
  {
    name: 'a deduction already taken from a salary can be deleted',
    file: DEL,
    find: '      if (ded.IsDeducted) {',
    replace: '      if (false) {',
    why: 'the employee stays short with nothing on file to explain it',
  },
  // ---- upgrade safety ----------------------------------------------------
  {
    name: 'the pre-upgrade snapshot is taken after migrating, not before',
    file: SCHEMA,
    find: '    db.exec(`VACUUM INTO \'${snapshot.replace(/\'/g, "\'\'")}\'`);',
    replace: '    /* mutant: snapshot skipped */',
    why: 'a backup of the damage is not a backup',
  },
  {
    name: 'a failed migration is not rolled back',
    file: SCHEMA,
    find: '      fs.copyFileSync(snapshot, live);',
    replace: '      /* mutant: no restore */',
    why: 'the customer is left with a half-migrated database and no way back',
  },
  {
    name: 'the schema version is stamped before the migration runs',
    file: SCHEMA,
    find: '  writeSchemaVersion(db, to);\n  pruneSnapshots',
    replace: '  pruneSnapshots',
    why: 'an interrupted upgrade would look finished and never be retried',
  },
  {
    name: 'an older build happily opens a newer database',
    file: SCHEMA,
    find: '  if (from > to) throw new SchemaTooNewError(from, to);',
    replace: '',
    why: 'the old build writes rows missing whatever the newer schema added',
  },
  {
    name: 'start-up migrates without the safety net',
    file: MAIN,
    find: '    const upgrade = migrateWithSafetyNet(db, app.getPath(\'userData\'), runMigrations, {',
    replace: '    runMigrations(db);\n    const upgrade = ((): any => ({ upgraded: false }))() || migrateWithSafetyNet(db, app.getPath(\'userData\'), runMigrations, {',
    why: 'the snapshot would be skipped entirely on every customer upgrade',
  },
  // ---- back office ------------------------------------------------------
  {
    // Retargeted. The old mutant added a second balance update guarded by
    // `PaymentMethodID && CashAccountID`, and that combination is now REFUSED
    // before any money moves — so the injected line became unreachable and the
    // mutant survived by being impossible rather than by being undetected.
    // The rule worth protecting is the refusal itself: allow "both" again and
    // the double-banking it used to cause becomes reachable once more.
    name: 'a voucher may name both a safe and a wallet',
    file: VOU,
    find: "    if (data.CashAccountID && data.PaymentMethodID) {",
    replace: "    if (false) {",
    why: 'naming two assets let one of them move while the document named the other',
  },
  {
    name: 'a negative amount is accepted again',
    file: VOU,
    find: "    if (badAmount) return { success: false, message: badAmount };",
    replace: '',
    why: 'a receipt of -9999 took money out of the till and called it income',
  },
  {
    name: 'cancelling a service keeps the provider fee',
    file: DEL,
    find: '        const feesPaid = (sale.ServiceCost || 0) + (sale.TransferCost || 0);',
    replace: '        const feesPaid = 0;',
    why: 'a neutral operation destroyed value in one direction and invented it in the other',
  },
  {
    name: 'a stocktake writes the item total into one warehouse row',
    file: SET,
    find: '            const delta = Number(item.ActualBalance) - Number(item.RecordedBalance);\n            const adjusted = Number(target.Quantity || 0) + delta;',
    replace: '            const adjusted = Number(item.ActualBalance);',
    why: 'counting 12 across two warehouses ended with 16',
  },
  {
    name: 'a negative counted balance is accepted',
    file: SET,
    find: '      if (countable && !res.ok) {',
    replace: '      if (false) {',
    why: 'stock and cash could be counted as negative',
  },
  {
    name: 'a negative service is stored again',
    file: SVC,
    find: '    if (badMoney) return { success: false, message: badMoney };',
    replace: '',
    why: 'a negative transfer reported phantom profit in the income statement',
  },
  {
    name: 'deleting a delivery reverses the customer debt twice',
    file: DEL,
    find: '            // NO customer/cash reversal from the mirror invoice.',
    replace: `            if (sale.CustomerID && sale.RemainingAmount > 0) {
              db.prepare('UPDATE customers SET Balance = Balance - ? WHERE CustomerID = ?').run(sale.RemainingAmount, sale.CustomerID);
            }
            //`,
    why: 'a cancelled repair left the shop owing the customer what they had owed it',
  },
];

let caught = 0, survived = 0;
const survivors = [];

function runSuite(rel) {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', join(ROOT, rel)],
      { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8', timeout: 180_000 });
    return true;                 // exit code 0 -> suite passed
  } catch {
    return false;                // non-zero -> suite failed (mutant caught)
  }
}

console.log('MUTATION TESTING — can the suites detect a broken handler?\n');
console.log('Each mutation is a realistic mistake. A mutant that SURVIVES means');
console.log('nothing in this repository would notice that fault in real code.\n');

for (const m of MUTANTS) {
  const backup = m.file + '.mutbak';
  const original = readFileSync(m.file, 'utf-8');

  // Anchors are matched against LINE-ENDING-NORMALISED text.
  //
  // Every `find` string in this file is written with \n. Git checks the
  // repository out with CRLF on Windows, so the source holds \r\n and NONE of
  // the anchors matched. MEASURED on the owner's machine: eleven mutants
  // reported as "(anchor not unique)" — a doubly false message, because the
  // anchors ARE unique and the mutation was never applied at all. They were
  // then counted as SURVIVORS, which reads as eleven blind spots in the test
  // suite when the truth is that eleven mutation attempts silently did not run.
  //
  // A mutation tool that cannot apply its mutation must not report the result
  // as a property of the tests.
  const nl = (t) => t.replace(/\r\n/g, '\n');
  const originalNl = nl(original);
  const findNl = nl(m.find);
  const replaceNl = nl(m.replace);
  const hadCRLF = original.includes('\r\n');
  // Restore the file's own convention after mutating, so the mutated source is
  // byte-comparable with what the developer sees.
  const back = (t) => (hadCRLF ? t.replace(/\n/g, '\r\n') : t);

  const occurrences = originalNl.split(findNl).length - 1;
  const wanted = m.occurrence ?? 0;          // 0 = must be unique, N = the Nth
  if (occurrences === 0 || (!m.occurrence && occurrences !== 1)) {
    console.log(`  SKIP  ${m.name}`);
    // The two cases are different faults and must not share a message.
    // "not unique" for a MISSING anchor sent a reader looking for duplicate
    // code that does not exist.
    console.log(occurrences === 0
      ? '        anchor NOT FOUND — the code moved or was rewritten; update this mutant'
      : `        anchor appears ${occurrences} times — the mutation would be ambiguous`);
    survived++;
    survivors.push(`${m.name} (${occurrences === 0 ? 'anchor missing' : 'anchor not unique'})`);
    continue;
  }

  copyFileSync(m.file, backup);
  try {
    // Replace either the unique match or the Nth one, never all of them: a
    // blanket replace would mutate several code paths at once and the result
    // would not identify which one the suites can see.
    let mutated;
    if (wanted > 0) {
      let seen = 0;
      mutated = originalNl.split(findNl).reduce((acc, part, i) =>
        i === 0 ? part : acc + ((++seen === wanted) ? replaceNl : findNl) + part, '');
    } else {
      mutated = originalNl.replace(findNl, replaceNl);
    }
    writeFileSync(m.file, back(mutated));

    // The mutation must have CHANGED something. Without this, a `find` that
    // stops matching after a refactor would leave the file untouched and the
    // suites would pass — reported as a survivor, blaming the tests for a
    // stale anchor.
    // `continue` is NOT used here: this block sits inside a try/finally that
    // already restores and deletes the backup, so leaving early would restore
    // twice and then unlink a file that is gone. The flag is read after the
    // suites instead.
    const applied = nl(readFileSync(m.file, 'utf-8')) !== originalNl;
    if (!applied) {
      console.log(`  SKIP  ${m.name}`);
      console.log('        the mutation produced no change — the anchor is stale');
      survived++;
      survivors.push(`${m.name} (mutation did not apply)`);
    }

    let detectedBy = null;
    if (applied) {
      for (const s of SUITES) {
        if (!runSuite(s)) { detectedBy = s.replace('scripts/', ''); break; }
      }
    }

    if (!applied) {
      // Already reported above; running the suites would only measure the
      // unmutated tree.
    } else if (detectedBy) {
      caught++;
      console.log(`  CAUGHT   ${m.name}`);
      console.log(`           by ${detectedBy}`);
    } else {
      survived++;
      survivors.push(m.name);
      console.log(`  SURVIVED ${m.name}`);
      console.log(`           ${m.why}`);
      console.log(`           NO SUITE DETECTED THIS`);
    }
  } finally {
    copyFileSync(backup, m.file);
    unlinkSync(backup);
  }
}

// Prove the restore worked, so a crashed run cannot leave the tree mutated.
for (const f of [SALES, PURCHASES, STOCK]) {
  const src = readFileSync(f, 'utf-8');
  if (src.includes('mutant:')) {
    console.log(`\n!!! ${f} still contains a mutation — restore it from git !!!`);
    process.exit(2);
  }
}

console.log(`\nRESULT: ${caught} caught, ${survived} survived`);
if (survivors.length) {
  console.log('\nsurviving mutants (each is a blind spot in the test suite):');
  survivors.forEach(s => console.log('  - ' + s));
}
process.exit(survived ? 1 : 0);
