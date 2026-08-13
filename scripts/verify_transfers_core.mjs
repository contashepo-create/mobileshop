#!/usr/bin/env node
// SECTION 9 — MONEY TRANSFERS: moving cash between the till, the bank safe
// and the card machine, with a commission charged either from the amount or
// separately, executed against the REAL bundle on the REAL schema.
//
// Same harness as section 8: an ESM entry re-exporting only the handler
// registration functions, esbuild CJS bundle, an electron stub, and a scratch
// userData directory. Every channel below runs the actual production code.
//
// The accounting claim under test: a transfer is a movement, not a transaction
// — the combined balance never changes except by the commission, the fee is an
// expense charged exactly once wherever it was taken from, the statements of
// BOTH accounts foot to their real balances (no phantom legs, no double
// counts), deletion reverses every leg by reference, and the balance sheet
// identity survives every direction and fee source.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

const ENTRY = `
export { getDb, closeDb } from './src/main/database/connection.ts';
export { runMigrations } from './src/main/database/migrations/index.ts';
export { registerTransfersHandlers } from './src/main/ipc/transfers.handlers.ts';
export { registerDeleteHandlers } from './src/main/ipc/delete.handlers.ts';
export { registerVouchersHandlers } from './src/main/ipc/vouchers.handlers.ts';
export { registerStatementHandlers } from './src/main/ipc/statement.handlers.ts';
export { registerReportsHandlers } from './src/main/ipc/reports.handlers.ts';
`;

const entryFile = join(PROJECT_ROOT, '_transfer_entry.ts');
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
  console.log('Building the real transfers bundle…');
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
  const bundleFile = join(PROJECT_ROOT, '_transfer_bundle.cjs');
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

  // -------------------------------------------------- per-scenario isolation
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

  // ---------------------------------------------------------------- helpers
  const q = (db, sql, ...p) => db.prepare(sql).get(...p);
  const qa = (db, sql, ...p) => db.prepare(sql).all(...p);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

  const seed = (db, extra = '') => db.exec(`
    UPDATE cash_accounts SET Balance = 100000, IsActive = 1 WHERE CashAccountID = 1;
    INSERT INTO payment_methods (PaymentMethodID, MethodName, MethodType, Balance, IsActive)
      VALUES (1, 'ماكينة', 'card', 5000, 1);
    INSERT INTO settings (Key, Value) VALUES ('allow_negative_cash', '0')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    INSERT INTO settings (Key, Value) VALUES ('owner_capital', '105000')
      ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
    ${extra}
  `);

  const cash = (db) => q(db, 'SELECT Balance v FROM cash_accounts WHERE CashAccountID = 1').v;
  const wallet = (db) => q(db, 'SELECT Balance v FROM payment_methods WHERE PaymentMethodID = 1').v;
  const combined = (db) => cash(db) + wallet(db);
  const transfer = (call, o) => call('transfers:create', {
    FromType: 'cash_account', FromID: 1,
    ToType: 'payment_method', ToID: 1,
    Amount: 1000, TransferCost: 0, TransferCostSource: 'separate',
    Notes: 't', userId: 1, fiscalYearId: 1,
    ...o,
  });
  const fp = async (call) => await call('reports:financialPosition');
  const pl = async (call) => await call('reports:profitLoss', {
    fromDate: daysAgo(30), toDate: fmt(new Date()),
  });
  const balanced = (r) => Math.abs((r?.capital?.difference ?? 1)) < 0.01;
  const feeVouchers = (db) => qa(db, `SELECT v.* FROM vouchers v
    WHERE v.ReferenceType = 'transfer' OR (v.VoucherType = 'payment' AND v.PartyType = 'general' AND v.Description = 'عمولة تحويل بين الحسابات')
    ORDER BY v.VoucherID`);

  // ---------------------------------------------------------------- 1
  console.log('\n[1] A plain transfer moves the money and nothing else');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await transfer(call, { Amount: 2000 });
    t('the transfer is accepted', r?.success === true, r?.message ?? '');
    t('the drawer lost exactly the amount', near(cash(db), 98000), `cash ${cash(db)}`);
    t('the machine gained exactly the amount', near(wallet(db), 7000), `wallet ${wallet(db)}`);
    t('the combined balance is untouched', near(combined(db), 105000), `combined ${combined(db)}`);
    const row = q(db, 'SELECT * FROM asset_transfers WHERE TransferID = ?', r.transferId ?? q(db, 'SELECT MAX(TransferID) v FROM asset_transfers').v);
    t('the document records the received amount',
      near(row.ReceivedAmount, 2000) && near(row.Amount, 2000) && row.TransferCostSource === 'separate',
      JSON.stringify(row).slice(0, 140));
    t('a fee-less transfer writes no voucher', feeVouchers(db).length === 0, `vouchers ${feeVouchers(db).length}`);
    const p = await pl(call);
    t('no fee means no expense on the P&L', near(p?.expenses?.general ?? 0, 0), `general ${p?.expenses?.general}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement shows the outgoing leg',
      cs?.success === true && cs?.operations?.some(o => o.OpType === 'transfer_out' && near(o.OutAmount, 2000)),
      JSON.stringify(cs?.operations ?? []).slice(0, 140));
    t('the drawer statement foots to the drawer',
      near((cs?.totalOut ?? 0) - (cs?.totalIn ?? 0), 2000), `net ${(cs?.totalOut ?? 0) - (cs?.totalIn ?? 0)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement shows the incoming leg',
      ms?.success === true && ms?.operations?.some(o => o.OpType === 'transfer_in' && near(o.InAmount, 2000)),
      JSON.stringify(ms?.operations ?? []).slice(0, 140));
    t('the machine statement foots to the machine',
      near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), 2000), `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the books balance to the penny', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
    const list = await call('transfers:list');
    t('the transfer is listed with both names',
      Array.isArray(list) && list.length === 1 && list[0].FromName && list[0].ToName,
      JSON.stringify(list).slice(0, 140));
  });

  // ---------------------------------------------------------------- 2
  console.log('\n[2] A fee taken FROM the amount stays inside the drawer leg');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await transfer(call, { Amount: 3000, TransferCost: 40, TransferCostSource: 'from_amount' });
    t('the transfer is accepted', r?.success === true, r?.message ?? '');
    t('the drawer lost the full amount', near(cash(db), 97000), `cash ${cash(db)}`);
    t('the machine received net of the fee', near(wallet(db), 7960), `wallet ${wallet(db)}`);
    t('the document records the net received', near(q(db, 'SELECT ReceivedAmount v FROM asset_transfers').v, 2960), `received ${q(db, 'SELECT ReceivedAmount v FROM asset_transfers').v}`);
    const vs = feeVouchers(db);
    t('the fee is expensed once', vs.length === 1 && near(vs[0].Amount, 40), JSON.stringify(vs).slice(0, 140));
    const p = await pl(call);
    t('the P&L charges the fee once', near(p?.expenses?.general ?? 0, 40), `general ${p?.expenses?.general}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement shows ONE leg of the full amount',
      near(cs?.totalOut ?? 0, 3000) && cs?.operations?.filter(o => o.OpType === 'transfer_out').length === 1,
      `out ${cs?.totalOut} of ${JSON.stringify(cs?.operations ?? []).slice(0, 200)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots to the net received', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), 2960),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the books balance with the fee spent', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 3
  console.log('\n[3] A SEPARATE fee comes out of the drawer as its own leg');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await transfer(call, { Amount: 3000, TransferCost: 40, TransferCostSource: 'separate' });
    t('the transfer is accepted', r?.success === true, r?.message ?? '');
    t('the drawer lost amount plus fee', near(cash(db), 96960), `cash ${cash(db)}`);
    t('the machine received the full amount', near(wallet(db), 8000), `wallet ${wallet(db)}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement splits the fee into its own voucher leg',
      near(cs?.totalOut ?? 0, 3040) && cs?.operations?.some(o => o.OpType === 'voucher_payment' && near(o.OutAmount, 40)),
      `out ${cs?.totalOut} of ${JSON.stringify(cs?.operations ?? []).slice(0, 240)}`);
    t('the machine statement shows only the received amount',
      near((ms => (ms?.totalIn ?? 0) - (ms?.totalOut ?? 0))(await call('paymentMethod:statement', 1, {})), 3000));
    const p = await pl(call);
    t('the P&L charges the fee once', near(p?.expenses?.general ?? 0, 40), `general ${p?.expenses?.general}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 4
  console.log('\n[4] The reverse direction with a separate fee leaves no phantom leg');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r = await transfer(call, {
      FromType: 'payment_method', FromID: 1,
      ToType: 'cash_account', ToID: 1,
      Amount: 1000, TransferCost: 20, TransferCostSource: 'separate',
    });
    t('the transfer is accepted', r?.success === true, r?.message ?? '');
    t('the machine lost amount plus fee', near(wallet(db), 3980), `wallet ${wallet(db)}`);
    t('the drawer gained the full amount', near(cash(db), 101000), `cash ${cash(db)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement folds the fee into ONE outgoing leg',
      near(ms?.totalOut ?? 0, 1020) && ms?.operations?.filter(o => o.OpType === 'transfer' || o.OpType === 'transfer_out').length === 1,
      `out ${ms?.totalOut} of ${JSON.stringify(ms?.operations ?? []).slice(0, 240)}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement shows the incoming leg with no ghost fee',
      near(ms?.totalOut ?? 0, 1020) && (cs?.operations ?? []).filter(o => o.OpType !== 'transfer_in').length === 0,
      `in ${cs?.totalIn}, legs ${JSON.stringify(cs?.operations ?? []).slice(0, 240)}`);
    t('the drawer statement foots to the drawer', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), 1000),
      `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const p = await pl(call);
    t('the P&L charges the fee once', near(p?.expenses?.general ?? 0, 20), `general ${p?.expenses?.general}`);
    const f = await fp(call);
    t('the books balance', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 5
  console.log('\n[5] The engine refuses the degenerate cases');
  await scenario(async ({ db, call }) => {
    seed(db);
    const z = await transfer(call, { Amount: 0 });
    t('a zero amount is refused', z?.success === false, z?.message ?? '');
    const neg = await transfer(call, { Amount: -500 });
    t('a negative amount is refused', neg?.success === false, neg?.message ?? '');
    const negFee = await transfer(call, { Amount: 500, TransferCost: -10, TransferCostSource: 'separate' });
    t('a negative fee is refused', negFee?.success === false, negFee?.message ?? '');
    const same = await transfer(call, { FromType: 'cash_account', FromID: 1, ToType: 'cash_account', ToID: 1 });
    t('a transfer to the same account is refused', same?.success === false, same?.message ?? '');
    const sameMach = await transfer(call, { FromType: 'payment_method', FromID: 1, ToType: 'payment_method', ToID: 1 });
    t('a machine-to-same-machine transfer is refused', sameMach?.success === false, sameMach?.message ?? '');
    const alienCost = await transfer(call, { Amount: 500, TransferCost: 10, TransferCostSource: 'ALIEN' });
    t('an alien cost source is refused', alienCost?.success === false, alienCost?.message ?? '');
    const ghostFrom = await transfer(call, { FromID: 99999 });
    t('a ghost source is refused', ghostFrom?.success === false, ghostFrom?.message ?? '');
    const ghostTo = await transfer(call, { ToType: 'cash_account', ToID: 99999 });
    t('a ghost destination is refused', ghostTo?.success === false, ghostTo?.message ?? '');
    const alienType = await transfer(call, { FromType: 'ALIEN', FromID: 1 });
    t('an alien account type is refused', alienType?.success === false, alienType?.message ?? '');
    t('nothing moved anywhere', near(cash(db), 100000) && near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM asset_transfers').v === 0,
      `cash ${cash(db)}, wallet ${wallet(db)}`);
  });

  // ---------------------------------------------------------------- 6
  console.log('\n[6] An overdraft is refused with its numbers, nothing is saved');
  await scenario(async ({ db, call }) => {
    seed(db);
    const over = await transfer(call, { Amount: 100001 });
    t('an overdrawn drawer is refused', over?.success === false, over?.message ?? '');
    const overMach = await transfer(call, { FromType: 'payment_method', FromID: 1, Amount: 5000.5 });
    t('an overdrawn machine is refused', overMach?.success === false, overMach?.message ?? '');
    t('nothing moved, no document', near(cash(db), 100000) && near(wallet(db), 5000) && q(db, 'SELECT COUNT(*) v FROM asset_transfers').v === 0,
      `cash ${cash(db)}, wallet ${wallet(db)}`);
  });

  // ---------------------------------------------------------------- 7
  console.log('\n[7] allow_negative_cash lets the drawer overdraw; the machine floor holds');
  await scenario(async ({ db, call }) => {
    seed(db);
    db.exec("UPDATE settings SET Value = '1' WHERE Key = 'allow_negative_cash'");
    const overMach = await transfer(call, { FromType: 'payment_method', FromID: 1, Amount: 5200 });
    t('the machine floor does not bend for the setting', overMach?.success === false, overMach?.message ?? '');
    t('the machine balance is untouched', near(wallet(db), 5000), `wallet ${wallet(db)}`);
    const over = await transfer(call, { Amount: 100500 });
    t('a drawer allowed to go negative may overdraw', over?.success === true, over?.message ?? '');
    t('the drawer actually went negative', near(cash(db), -500), `cash ${cash(db)}`);
    t('the machine received the full amount', near(wallet(db), 105500), `wallet ${wallet(db)}`);
    const fine = await transfer(call, { FromType: 'payment_method', FromID: 1, ToType: 'cash_account', ToID: 1, Amount: 1000 });
    t('a machine transfer within its funds still works', fine?.success === true, fine?.message ?? '');
    t('the machine pays that one', near(wallet(db), 104500), `wallet ${wallet(db)}`);
    const f = await fp(call);
    t('the books balance with the till in the red', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
    db.exec("UPDATE settings SET Value = '0' WHERE Key = 'allow_negative_cash'");
    const again = await transfer(call, { Amount: 1000 });
    t('switching off re-locks the drawer at once',
      again?.success === false && near(cash(db), 500), again?.message ?? '');
  });

  // ---------------------------------------------------------------- 8
  console.log('\n[8] The fee cannot exceed the money, and the accounts are real');
  await scenario(async ({ db, call }) => {
    seed(db);
    const big = await transfer(call, { Amount: 500, TransferCost: 700, TransferCostSource: 'from_amount' });
    t('a fee bigger than the amount is refused', big?.success === false, big?.message ?? '');
    const bigSep = await transfer(call, { Amount: 500, TransferCost: 700, TransferCostSource: 'separate' });
    t('a separate fee beyond the amount is a legitimate spend',
      bigSep?.success === true && near(cash(db), 100000 - 1200) && near(wallet(db), 5500),
      `cash ${cash(db)}, wallet ${wallet(db)}`);
    const p = await pl(call);
    t('that fee is expensed once', near(p?.expenses?.general ?? 0, 700), `general ${p?.expenses?.general}`);
  });

  // ---------------------------------------------------------------- 9
  console.log('\n[9] Penny-exact transfers foot to the piastre');
  await scenario(async ({ db, call }) => {
    seed(db);
    await transfer(call, { Amount: 2000.1, TransferCost: 0.3, TransferCostSource: 'from_amount' });
    await transfer(call, { Amount: 0.2, TransferCost: 0, TransferCostSource: 'separate' });
    await transfer(call, {
      FromType: 'payment_method', FromID: 1, ToType: 'cash_account', ToID: 1,
      Amount: 1999.6, TransferCost: 0, TransferCostSource: 'separate',
    });
    t('the drawer foots exactly', near(cash(db), 100000 - 2000.1 - 0.2 + 1999.6), `cash ${cash(db)}`);
    t('the machine foots exactly', near(wallet(db), 5000 + 2000.1 - 0.3 + 0.2 - 1999.6), `wallet ${wallet(db)}`);
    const p = await pl(call);
    t('the P&L charges the fee exactly', near(p?.expenses?.general ?? 0, 0.3), `general ${p?.expenses?.general}`);
    const f = await fp(call);
    t('the books balance to the piastre', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement foots to the drawer', near((cs?.totalOut ?? 0) - (cs?.totalIn ?? 0), 2000.1 + 0.2 - 1999.6),
      `net ${(cs?.totalOut ?? 0) - (cs?.totalIn ?? 0)}`);
  });

  // ---------------------------------------------------------------- 10
  console.log('\n[10] Deleting reverses every leg by reference, exactly once');
  await scenario(async ({ db, call }) => {
    seed(db);
    const r1 = await transfer(call, { Amount: 3000, TransferCost: 40, TransferCostSource: 'separate' });
    const t1 = q(db, 'SELECT TransferID v FROM asset_transfers').v;
    t('the transfer is recorded', r1?.success === true && !!t1, r1?.message ?? '');
    const del = await call('delete:transfer', t1);
    t('the delete reports success', del?.success === true, del?.message ?? '');
    t('both accounts are restored', near(cash(db), 100000) && near(wallet(db), 5000), `cash ${cash(db)}, wallet ${wallet(db)}`);
    t('the fee voucher is gone', feeVouchers(db).length === 0, `vouchers ${feeVouchers(db).length}`);
    const p = await pl(call);
    t('the P&L is silent again', near(p?.expenses?.general ?? 0, 0), `general ${p?.expenses?.general}`);
    t('the document is gone', q(db, 'SELECT COUNT(*) v FROM asset_transfers').v === 0);
    const del2 = await call('delete:transfer', t1);
    t('deleting it again is refused', del2?.success === false, del2?.message ?? '');
    const delGhost = await call('delete:transfer', 99999);
    t('deleting a ghost is refused', delGhost?.success === false, delGhost?.message ?? '');
    const f = await fp(call);
    t('the books balance after the reversals', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 200));
  });

  // ---------------------------------------------------------------- 11
  console.log('\n[11] A mixed day — both statements foot and the reports agree');
  await scenario(async ({ db, call }) => {
    seed(db);
    await transfer(call, { Amount: 2000, TransferCost: 30, TransferCostSource: 'from_amount' });
    await transfer(call, {
      FromType: 'payment_method', FromID: 1, ToType: 'cash_account', ToID: 1,
      Amount: 1500, TransferCost: 25, TransferCostSource: 'separate',
    });
    await transfer(call, { Amount: 700, TransferCost: 0, TransferCostSource: 'separate' });
    await call('vouchers:create', {
      VoucherType: 'receipt', Amount: 900, Date: fmt(new Date()), PartyType: 'general',
      PartyName: '', Description: 'وارد', CashAccountID: 1, userId: 1, fiscalYearId: 1,
    });
    await call('vouchers:create', {
      VoucherType: 'payment', Amount: 300, Date: fmt(new Date()), PartyType: 'general',
      PartyName: '', Description: 'منصرف', CashAccountID: 1, userId: 1, fiscalYearId: 1,
    });
    const expectedCash = 100000 - 2000 + 1500 - 700 + 900 - 300;
    t('the drawer is exactly where the day put it', near(cash(db), expectedCash), `cash ${cash(db)}`);
    t('the machine is exactly where the day put it', near(wallet(db), 5000 + 2000 - 30 - 1500 - 25 + 700), `wallet ${wallet(db)}`);
    const p = await pl(call);
    t('the P&L charges both fees and the payment voucher once', near(p?.expenses?.general ?? 0, 30 + 25 + 300), `general ${p?.expenses?.general}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement foots to the drawer', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), cash(db) - 100000),
      `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots to the machine', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), wallet(db) - 5000),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the balance sheet holds the whole day', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
    const list = await call('transfers:list');
    t('all three transfers are listed newest first', Array.isArray(list) && list.length === 3, `rows ${list?.length}`);
  });

  // ---------------------------------------------------------------- 12
  console.log('\n[12] A hundred random moves never drift a piastre');
  await scenario(async ({ db, call }) => {
    seed(db);
    let fees = 0;
    for (let i = 0; i < 100; i++) {
      const dir = i % 2 === 0;
      const sourceNow = dir ? cash(db) : wallet(db);
      const amount = Math.round(Math.min(Math.random() * 900 + 0.05, Math.max(0.05, sourceNow * 0.4)) * 100) / 100;
      const isFee = i % 3 === 2;
      const fee = isFee ? Math.round(Math.random() * (amount / 2 - 0.01) * 100) / 100 : 0;
      const source = isFee && i % 4 === 3 ? 'from_amount' : 'separate';
      if (isFee) fees += fee;
      const r = await transfer(call, {
        FromType: dir ? 'cash_account' : 'payment_method', FromID: 1,
        ToType: dir ? 'payment_method' : 'cash_account', ToID: 1,
        Amount: amount, TransferCost: fee, TransferCostSource: source,
      });
      t(`random move ${i + 1} is accepted`, r?.success === true, r?.message ?? '');
    }
    t('the combined balance lost exactly the fees', near(combined(db), 105000 - fees), `combined ${combined(db)} vs ${105000 - fees}`);
    const p = await pl(call);
    t('the P&L charges exactly the fees paid', near(p?.expenses?.general ?? 0, fees), `general ${p?.expenses?.general}`);
    const cs = await call('cashAccount:statement', 1, {});
    t('the drawer statement foots to the drawer', near((cs?.totalIn ?? 0) - (cs?.totalOut ?? 0), cash(db) - 100000),
      `net ${(cs?.totalIn ?? 0) - (cs?.totalOut ?? 0)}`);
    const ms = await call('paymentMethod:statement', 1, {});
    t('the machine statement foots to the machine', near((ms?.totalIn ?? 0) - (ms?.totalOut ?? 0), wallet(db) - 5000),
      `net ${(ms?.totalIn ?? 0) - (ms?.totalOut ?? 0)}`);
    const f = await fp(call);
    t('the books balance after a hundred moves', balanced(f), JSON.stringify(f?.capital ?? {}).slice(0, 240));
  });

  console.log(`\nSECTION 9 RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('\nFAILED:');
    for (const name of FAIL) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('SUITE CRASHED:', err);
  process.exitCode = 1;
} finally {
  try { rmSync(entryFile, { force: true }); rmSync(join(PROJECT_ROOT, '_transfer_bundle.cjs'), { force: true }); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}