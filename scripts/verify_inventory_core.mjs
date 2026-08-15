#!/usr/bin/env node
// SECTION 15 — INVENTORY: warehouses, items and warehouse-to-warehouse
// transfers on the REAL stack. Same harness as sections 7-14.
//
// The accounting claim under test: a transfer moves goods without creating or
// destroying value (quantity conserved, inventory value conserved, the
// destination re-averages at the moved cost), serialised devices actually move
// with the pool, refusals are soft (negative/zero quantity, same warehouse,
// ghost warehouses, insufficient stock), the registries refuse ghosts, and the
// balance sheet identity holds after every move.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerInventoryHandlers } from './src/main/ipc/inventory.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_inv_entry.ts');
writeFileSync(entryFile, ENTRY);

const electronStub = `
const path = require('path');
const { EventEmitter } = require('events');
const emitter = new EventEmitter();
emitter.getPath = (k) => process.env.PAYROOT + '/data';
emitter.dirname = path.dirname;
module.exports = {
  app: emitter,
  ipcMain: {
    emitter,
    handle(channel, fn) {
      if (!globalThis.__FOUND_HANDLERS__) globalThis.__FOUND_HANDLERS__ = new Map();
      globalThis.__FOUND_HANDLERS__.set(channel, fn);
    },
  },
  BrowserWindow: class { constructor() {} loadURL() {} on() { return this; } },
};\n`;

let userData;
try {
  userData = mkdtempSync(join(tmpdir(), 'rn-user-'));
  process.env.PAYROOT = userData;
  console.log('Building the real inventory bundle…');
  const out = await build({
    entryPoints: [entryFile],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
    external: ['better-sqlite3', 'bcryptjs'],
    plugins: [{
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: electronStub, loader: 'js' }));
      },
    }],
  });
  const bundleFile = join(PROJECT_ROOT, '_inv_bundle.cjs');
  writeFileSync(bundleFile, out.outputFiles[0].text);
  const require = createRequire(import.meta.url);
  const mod = require(bundleFile);

  const PASS = [];
  const FAIL = [];
  const t = (name, ok, diag) => {
    if (ok) PASS.push(name); else FAIL.push(name);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        ${diag}`);
  };
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.01;

  const DB_FILES = ['mobile_shop.db', 'mobile_shop.db-wal', 'mobile_shop.db-shm'];
  const wipeDb = () => {
    for (const f of DB_FILES) {
      try { rmSync(join(userData, 'data', f), { force: true }); } catch { /* not open */ }
    }
  };
  const scenario = async (fn) => {
    mod.closeDb();
    wipeDb();
    globalThis.__FOUND_HANDLERS__ = new Map();
    for (const [name, exp] of Object.entries(mod)) {
      if (typeof exp === 'function' && name.startsWith('register')) exp();
    }
    const db = mod.getDb();
    mod.runMigrations(db);
    const call = (channel, ...args) => {
      const handler = globalThis.__FOUND_HANDLERS__.get(channel);
      if (!handler) throw new Error(`channel not registered: ${channel}`);
      return handler({ sender: { id: 1 } }, ...args);
    };
    await fn({ db, call });
  };

  const q = (db, sql, ...p) => db.prepare(sql).get(...p);
  const qa = (db, sql, ...p) => db.prepare(sql).all(...p);

  // Opening net worth: cash 100000 + inventory
  // (100x60 + 10x50 + 40x20 + serials 16500 + 17500) = 141300.
  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO items (ItemID, ItemName, ItemType, IsSerialized, CostPrice, SalePrice, IsActive)
      VALUES (1, 'شاحن', 'accessory', 0, 60, 90, 1),
             (2, 'كابل', 'accessory', 0, 20, 40, 1),
             (3, 'موبايل', 'phone', 1, 16500, 20000, 1);
    INSERT INTO stock_quantities (ItemID, WarehouseID, Quantity, CostPrice)
      VALUES (1, 1, 100, 60), (1, 2, 10, 50), (2, 1, 40, 20), (3, 1, 2, 16500);
    INSERT INTO item_serials (SerialID, ItemID, IMEI, Status, CostPrice, WarehouseID)
      VALUES (1, 3, '123456789012345', 'available', 16500, 1),
             (2, 3, '223456789012345', 'available', 17500, 1);
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '141300')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const qty = (db, item, wh) => q(db, 'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?', item, wh).v;
  const cost = (db, item, wh) => q(db, 'SELECT CostPrice v FROM stock_quantities WHERE ItemID = ? AND WarehouseID = ?', item, wh).v;
  const totalQty = (db, item) => q(db, 'SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID = ?', item).v;
  const totalValue = (db, item) => q(db, 'SELECT COALESCE(SUM(Quantity * CostPrice),0) v FROM stock_quantities WHERE ItemID = ?', item).v;
  const serialsAt = (db, wh) => qa(db, "SELECT SerialID FROM item_serials WHERE ItemID = 3 AND WarehouseID = ? AND Status = 'available'", wh).map(r => r.SerialID);
  const fp = async (call) => await call('reports:financialPosition');
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;
  const transfer = (call, o) => call('warehouseTransfers:create', {
    FromWarehouseID: 1, ToWarehouseID: 2, items: [{ ItemID: 1, Quantity: 10 }], userId: 1, ...o,
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A transfer conserves quantity and value');
  await scenario(async ({ db, call }) => {
    seed(db);
    const beforeQ = totalQty(db, 1), beforeV = totalValue(db, 1);
    const r = await transfer(call, { items: [{ ItemID: 1, Quantity: 25 }] });
    t('the transfer succeeds', r?.success === true, JSON.stringify(r));
    t('the source gave up the goods', near(qty(db, 1, 1), 75), `src ${qty(db, 1, 1)}`);
    t('the destination received them', near(qty(db, 1, 2), 35), `dst ${qty(db, 1, 2)}`);
    t('the total quantity is conserved', near(totalQty(db, 1), beforeQ), `${totalQty(db, 1)} vs ${beforeQ}`);
    t('the total value is conserved', near(totalValue(db, 1), beforeV), `${totalValue(db, 1)} vs ${beforeV}`);
    t('the destination re-averaged at the moved cost', near(cost(db, 1, 2), (50 * 10 + 60 * 25) / 35), `cost ${cost(db, 1, 2)}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] Transfers are refused, softly');
  await scenario(async ({ db, call }) => {
    seed(db);
    const neg = await transfer(call, { items: [{ ItemID: 1, Quantity: -5 }] });
    t('a negative quantity is refused', neg?.success === false, neg?.message ?? '');
    const zero = await transfer(call, { items: [{ ItemID: 1, Quantity: 0 }] });
    t('a zero quantity is refused', zero?.success === false, zero?.message ?? '');
    const same = await transfer(call, { FromWarehouseID: 1, ToWarehouseID: 1, items: [{ ItemID: 1, Quantity: 1 }] });
    t('a transfer to itself is refused', same?.success === false, same?.message ?? '');
    const empty = await transfer(call, { items: [] });
    t('an empty item list is refused', empty?.success === false, empty?.message ?? '');
    const over = await transfer(call, { items: [{ ItemID: 1, Quantity: 999 }] });
    t('an overdraw is refused', over?.success === false, over?.message ?? '');
    const ghost = await transfer(call, { FromWarehouseID: 99999, ToWarehouseID: 2, items: [{ ItemID: 1, Quantity: 1 }] });
    t('a ghost source warehouse is refused', ghost?.success === false, ghost?.message ?? '');
    const ghostTo = await transfer(call, { FromWarehouseID: 1, ToWarehouseID: 99999, items: [{ ItemID: 1, Quantity: 1 }] });
    t('a ghost destination warehouse is refused', ghostTo?.success === false, ghostTo?.message ?? '');
    t('nothing moved', near(qty(db, 1, 1), 100) && near(qty(db, 1, 2), 10) && q(db, 'SELECT COUNT(*) v FROM warehouse_transfers').v === 0,
      `transfers ${q(db, 'SELECT COUNT(*) v FROM warehouse_transfers').v}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Serialised devices travel with the pool');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await transfer(call, { items: [{ ItemID: 3, Quantity: 1 }] });
    t('a phone transfer succeeds', r?.success === true, JSON.stringify(r));
    t('the pool moved one of two', near(qty(db, 3, 1), 1) && near(qty(db, 3, 2), 1), `src ${qty(db, 3, 1)} dst ${qty(db, 3, 2)}`);
    t('exactly one device moved with it', serialsAt(db, 1).length === 1 && serialsAt(db, 2).length === 1, `at1 ${serialsAt(db, 1).length} at2 ${serialsAt(db, 2).length}`);
    const two = await transfer(call, { items: [{ ItemID: 3, Quantity: 1 }] });
    t('the second phone travels too', two?.success === true && serialsAt(db, 2).length === 2, JSON.stringify(two));
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] The registries refuse ghosts and junk');
  await scenario(async ({ db, call }) => {
    seed(db);
    const ok = await call('warehouses:create', { WarehouseName: 'مخزن فرعي', WarehouseType: 'main' });
    t('a warehouse is created', ok?.success === true, JSON.stringify(ok));
    t('an unnamed warehouse is refused', (await call('warehouses:create', { WarehouseName: '', WarehouseType: 'main' }))?.success === false);
    t('an alien warehouse type is refused', (await call('warehouses:create', { WarehouseName: 'x', WarehouseType: 'HANGAR' }))?.success === false);
    const ghostDel = await call('warehouses:delete', 99999);
    t('a ghost warehouse delete is refused', ghostDel?.success === false, ghostDel?.message ?? '');
    const ghostUpd = await call('warehouses:update', 99999, { WarehouseName: 'x', WarehouseType: 'main' });
    t('a ghost warehouse update is refused', ghostUpd?.success === false, ghostUpd?.message ?? '');
    const dup = await call('items:create', { ItemName: 'شاحن', ItemType: 'accessory', SalePrice: 10, Barcode: 'B1' });
    t('an item with a barcode is created', dup?.success === true, JSON.stringify(dup));
    const dup2 = await call('items:create', { ItemName: 'شاحن آخر', ItemType: 'accessory', SalePrice: 10, Barcode: 'B1' });
    t('a duplicate barcode is refused', dup2?.success === false, dup2?.message ?? '');
    const negPrice = await call('items:create', { ItemName: 'x', ItemType: 'accessory', SalePrice: -5 });
    t('a negative sale price is refused', negPrice?.success === false, negPrice?.message ?? '');
    const alienType = await call('items:create', { ItemName: 'x', ItemType: 'WEAPON', SalePrice: 5 });
    t('an alien item type is refused', alienType?.success === false, alienType?.message ?? '');
    const noName = await call('items:create', { ItemName: '', ItemType: 'accessory', SalePrice: 5 });
    t('an unnamed item is refused', noName?.success === false, noName?.message ?? '');
    const ghostItem = await call('items:delete', 99999);
    t('a ghost item delete is refused', ghostItem?.success === false, ghostItem?.message ?? '');
    const delSafe = await call('items:deleteSafe', 1);
    t('a safe delete refuses an item with history', delSafe?.success === false, delSafe?.message ?? '');
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] allow_negative_stock opens the door, refusals stay soft');
  await scenario(async ({ db, call }) => {
    seed(db);
    db.exec("INSERT INTO settings (Key, Value) VALUES ('allow_negative_stock', '1') ON CONFLICT(Key) DO UPDATE SET Value = '1'");
    const over = await transfer(call, { items: [{ ItemID: 2, Quantity: 999 }] });
    t('with negative stock allowed, an overdraw transfers', over?.success === true, JSON.stringify(over));
    t('the source went negative', near(qty(db, 2, 1), -959), `src ${qty(db, 2, 1)}`);
    t('the destination holds the goods', near(qty(db, 2, 2), 999), `dst ${qty(db, 2, 2)}`);
    const neg = await transfer(call, { items: [{ ItemID: 2, Quantity: -5 }] });
    t('a negative quantity is STILL refused', neg?.success === false, neg?.message ?? '');
    db.exec("UPDATE settings SET Value = '0' WHERE Key = 'allow_negative_stock'");
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] A deactivated warehouse still refuses fresh transfers');
  await scenario(async ({ db, call }) => {
    seed(db);
    await call('warehouses:delete', 1);
    t('the seeded warehouse is deactivated', q(db, 'SELECT IsActive v FROM warehouses WHERE WarehouseID = 1').v === 0, '');
    const r = await transfer(call, { items: [{ ItemID: 1, Quantity: 1 }] });
    t('a transfer FROM a deactivated warehouse is refused', r?.success === false, r?.message ?? '');
    const r2 = await transfer(call, { FromWarehouseID: 2, ToWarehouseID: 1, items: [{ ItemID: 1, Quantity: 1 }] });
    t('a transfer TO a deactivated warehouse is refused', r2?.success === false, r2?.message ?? '');
    t('nothing moved', near(qty(db, 1, 1), 100) && near(qty(db, 1, 2), 10), '');
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 260));
  });

  console.log(`\nSECTION 15 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_inv_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}