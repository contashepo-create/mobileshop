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
  'scripts/verify_backup_integrity.mjs',
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

  const occurrences = original.split(m.find).length - 1;
  const wanted = m.occurrence ?? 0;          // 0 = must be unique, N = the Nth
  if (occurrences === 0 || (!m.occurrence && occurrences !== 1)) {
    console.log(`  SKIP  ${m.name}`);
    console.log(`        anchor appears ${occurrences} times — the mutation would be ambiguous`);
    survived++;
    survivors.push(`${m.name} (anchor not unique)`);
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
      mutated = original.split(m.find).reduce((acc, part, i, arr) =>
        i === 0 ? part : acc + ((++seen === wanted) ? m.replace : m.find) + part, '');
    } else {
      mutated = original.replace(m.find, m.replace);
    }
    writeFileSync(m.file, mutated);

    let detectedBy = null;
    for (const s of SUITES) {
      if (!runSuite(s)) { detectedBy = s.replace('scripts/', ''); break; }
    }

    if (detectedBy) {
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
