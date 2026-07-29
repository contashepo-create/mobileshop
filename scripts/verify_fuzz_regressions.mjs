// Confirms each fuzzer-found defect is fixed, in isolation.
import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q=(s,...a)=>currentDb().prepare(s).get(...a);
const r2=n=>Math.round(n*100)/100;
function seed(){const db=buildDatabase();
 db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
 db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
 db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
 db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'M'),(2,'B')");
 db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)");
 db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
 db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
 db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'C','part',0,10,20,1),(2,'P','device',0,600,1000,1)");
 db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,10),(2,1,10,600)");
}
let pass=0,fail=0;
const t=(n,ok,d='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${n}`);if(d)console.log('        '+d);};

console.log('REGRESSIONS FOR FUZZER-FOUND DEFECTS\n');

// 1 delete:purchase after the goods were sold
// The goods must be gone from the RECEIVING warehouse for the guard to bite,
// so the branch is the only place holding this item.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=2');
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:2,UnitCost:600,WarehouseID:2}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
const pid=q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
await call('sales:create',{items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:2000,CashAccountID:1,fiscalYearId:1});
let r=await call('delete:purchase',pid);
t('deleting a purchase whose goods were sold is refused',r.success===false,r.message);
t('no negative stock created',(q('SELECT Quantity v FROM stock_quantities WHERE ItemID=2 AND WarehouseID=2')?.v??0)>=0);

// 2 purchase return removes at landed cost, not blended average
seed();
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:10,UnitCost:5,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
const p2=q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
const v1=(x=>x.Quantity*x.CostPrice)(q('SELECT Quantity,CostPrice FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1'));
const s1=q('SELECT Balance b FROM suppliers WHERE SupplierID=1').b;
await call('purchaseReturns:create',{PurchaseID:p2,items:[{ItemID:1,Quantity:10,UnitCost:5}],AccountCredit:50,CashRefund:0});
const v2=(x=>x.Quantity*x.CostPrice)(q('SELECT Quantity,CostPrice FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1'));
const s2=q('SELECT Balance b FROM suppliers WHERE SupplierID=1').b;
t('stock value removed equals the credit received',Math.abs((v1-v2)-(s1-s2))<0.01,
  `stock -${r2(v1-v2)} vs debt -${r2(s1-s2)}`);

// 3 undoing a sale return removes exactly what it added
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:5,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:100,CashAccountID:1,fiscalYearId:1});
const sid=q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:5,UnitCost:30,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
const before=(x=>x.Quantity*x.CostPrice)(q('SELECT Quantity,CostPrice FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1'));
await call('saleReturns:create',{SaleID:sid,items:[{ItemID:1,Quantity:5,UnitPrice:20}],AccountCredit:0,CashRefund:100,CashAccountID:1});
const rid=q('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:saleReturn',rid);
const after=(x=>x.Quantity*x.CostPrice)(q('SELECT Quantity,CostPrice FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1'));
t('stock value returns exactly to its prior figure',Math.abs(before-after)<0.01,`${r2(before)} -> ${r2(after)}`);

// 4 same item on two lines can be fully returned
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:1,UnitPrice:20},{ItemID:1,Quantity:1,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:40,CashAccountID:1,fiscalYearId:1});
const sid2=q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
let ok=0;
for(let i=0;i<2;i++){const x=await call('saleReturns:create',{SaleID:sid2,
  items:[{ItemID:1,Quantity:1,UnitPrice:20}],AccountCredit:0,CashRefund:20,CashAccountID:1});if(x.success)ok++;}
const third=await call('saleReturns:create',{SaleID:sid2,items:[{ItemID:1,Quantity:1,UnitPrice:20}],AccountCredit:0,CashRefund:20,CashAccountID:1});
t('both units of a duplicated item line can be returned',ok===2,`accepted ${ok}/2`);
t('a third is refused',third.success===false,third.message);

// 5 freight write-off is recorded
seed();
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:15,UnitCost:12,WarehouseID:2}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:25,PaymentCost:0,fiscalYearId:1});
const p5=q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
await call('purchaseReturns:create',{PurchaseID:p5,items:[{ItemID:1,Quantity:15,UnitCost:12}],AccountCredit:180,CashRefund:0});
// Compared with a tolerance, not for exact equality: the figure is stored at
// full precision on purpose, so that it equals the value that actually left the
// warehouse. Rounding it to piastres made the write-off disagree with the stock
// movement it explains, and leaked the difference on every partial return.
t('unrecoverable freight is recorded, not silently lost',
  Math.abs(q('SELECT FreightWrittenOff f FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').f - 25) < 0.005,
  'FreightWrittenOff = '+q('SELECT FreightWrittenOff f FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').f);


// 6 the cost credited back is RECORDED, not re-derived
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:2,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
const s6=q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
await call('saleReturns:create',{SaleID:s6,items:[{ItemID:1,Quantity:2,UnitPrice:20}],AccountCredit:40,CashRefund:0});
const rl=q('SELECT UnitCost c FROM sale_return_details ORDER BY DetailID DESC LIMIT 1');
t('the cost restored to stock is recorded on the return line',rl.c===10,'UnitCost = '+rl.c);

// 7 an invoice with one item on two lines at different prices returns at the
//   weighted average, not the dearest
seed();
await call('sales:create',{CustomerID:1,
  items:[{ItemID:1,Quantity:2,UnitPrice:10},{ItemID:1,Quantity:2,UnitPrice:30}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
const s7=q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
const avail=await call('saleReturns:returnable',s7);
const line7=avail.find(l=>l.ItemID===1);
t('a duplicated item line is offered at its weighted average price',
  Math.abs(line7.UnitPrice-20)<0.01,'UnitPrice = '+line7.UnitPrice+' (10 and 30 -> 20)');

// 8 value conservation: a purchase return never changes net worth
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=1');
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:12,UnitCost:8,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:50,PaymentCost:0,fiscalYearId:1});
const p8=q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
const NW=()=>{const d=currentDb();const g=x=>d.prepare(x).get()?.v??0;
  return g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    +g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    -g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance>0');};
const nwB=NW();
await call('purchaseReturns:create',{PurchaseID:p8,items:[{ItemID:1,Quantity:4,UnitCost:8}],
  AccountCredit:32,CashRefund:0});
const nwA=NW();
t('a partial purchase return leaves net worth unchanged',Math.abs(nwA-nwB)<0.001,
  `${r2(nwB)} -> ${r2(nwA)} (freight follows the surviving units)`);


// ===================================================================
// Round 2 — defects found by running the fuzzer across MANY seeds.
//
// The previous round ran one seed and called the leftovers "IEEE-754 noise".
// They were not. Every one of these moved real money.
// ===================================================================

const netWorth = () => {
  const g = s => currentDb().prepare(s).get()?.v ?? 0;
  return g('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM payment_methods')
    + g('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
    + g('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance>0')
    + g('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance<0')
    - g('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance>0')
    - g('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance<0');
};

// 11 A per-unit cost must never be rounded to piastres.
//   Spreading 5.00 of freight over 96 units gives 10.052083...; storing 10.05
//   and re-multiplying valued the stock 0.20 lower with no entry anywhere.
//   The loss scales with the holding (0.005 x N).
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=1');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,96,10)');
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:7,UnitCost:9,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:5,PaymentCost:0,fiscalYearId:1});
const w11 = netWorth();
const p11 = q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
await call('purchaseReturns:create',{PurchaseID:p11,items:[{ItemID:1,Quantity:7,UnitCost:9}],
  AccountCredit:63,CashRefund:0});
t('returning goods whose freight spreads unevenly loses nothing',
  Math.abs(netWorth()-w11) < 0.0005, `net worth moved ${(netWorth()-w11).toFixed(6)}`);

// 12 Cancelling a purchase return restores the LANDED cost, including the
//    freight that was written off when the pool emptied.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=1');
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:7,UnitCost:9,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:5,PaymentCost:0,fiscalYearId:1});
const w12 = netWorth();
const p12 = q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
await call('purchaseReturns:create',{PurchaseID:p12,items:[{ItemID:1,Quantity:7,UnitCost:9}],
  AccountCredit:63,CashRefund:0});
const r12 = q('SELECT ReturnID FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:purchaseReturn',r12);
t('cancelling a purchase return restores the written-off freight',
  Math.abs(netWorth()-w12) < 0.0005, `net worth moved ${(netWorth()-w12).toFixed(6)}`);

// 13 A sale may not be built from stock scattered across warehouses.
//    Validation summed every warehouse while the deduction hits one, so
//    3 in the main store + 2 in the branch satisfied a request for 5 and
//    left the main store at -2.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=2');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,3,600),(2,2,2,600)');
const r13 = await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:5,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:5000,CashAccountID:1,fiscalYearId:1});
t('a sale spanning two warehouses is refused, not silently split',
  r13.success===false, r13.message);
t('no warehouse was driven negative',
  (q('SELECT MIN(Quantity) v FROM stock_quantities WHERE ItemID=2').v) >= 0,
  'min qty '+q('SELECT MIN(Quantity) v FROM stock_quantities WHERE ItemID=2').v);

// 14 The same item twice on one invoice is checked against the running total.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=2');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,5,600)');
const r14 = await call('sales:create',{CustomerID:1,
  items:[{ItemID:2,Quantity:3,UnitPrice:1000},{ItemID:2,Quantity:3,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:6000,CashAccountID:1,fiscalYearId:1});
t('two lines of one item cannot together exceed the holding',
  r14.success===false, r14.message);
t('stock untouched by the refused invoice',
  q('SELECT Quantity v FROM stock_quantities WHERE ItemID=2 AND WarehouseID=1').v===5);

// 15 sales:update had NO stock check at all.
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:1,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:1000,CashAccountID:1,fiscalYearId:1});
const s15 = q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
const r15 = await call('sales:update',{SaleID:s15,CustomerID:1,
  items:[{ItemID:2,Quantity:500,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0});
t('editing an invoice beyond available stock is refused',
  r15.success===false, r15.message);
t('the original invoice is left intact',
  q('SELECT Quantity v FROM sale_details WHERE SaleID=?',s15).v===1,
  'qty '+q('SELECT Quantity v FROM sale_details WHERE SaleID=?',s15).v);

// 16 Cancelling a sale return whose goods were re-sold is refused.
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:2000,CashAccountID:1,fiscalYearId:1});
const s16 = q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
await call('saleReturns:create',{SaleID:s16,items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  AccountCredit:0,CashRefund:2000,CashAccountID:1});
const ret16 = q('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
currentDb().exec('UPDATE stock_quantities SET Quantity=0 WHERE ItemID=2 AND WarehouseID=1');
const r16 = await call('delete:saleReturn',ret16);
t('cancelling a return whose goods are gone is refused',
  r16.success===false, r16.message);
t('no negative stock from the refused reversal',
  q('SELECT Quantity v FROM stock_quantities WHERE ItemID=2 AND WarehouseID=1').v >= 0);

// 17 A purchase return may not credit the supplier more than the invoice owed
//    without that credit being tracked separately from the invoice balance.
seed();
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:5,UnitCost:636,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:3180,PaymentSourceType:'cash_account',PaymentSourceID:1,
  AdditionalCost:4,PaymentCost:0,fiscalYearId:1});
const p17 = q('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
await call('purchaseReturns:create',{PurchaseID:p17,items:[{ItemID:2,Quantity:1,UnitCost:636}],
  AccountCredit:636,CashRefund:0});
const r17id = q('SELECT ReturnID FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:purchaseReturn',r17id);
const h17 = q('SELECT TotalAmount,PaidAmount,RemainingAmount FROM purchases WHERE PurchaseID=?',p17);
t('cancelling a return restores only what the invoice actually owed',
  Math.abs(h17.RemainingAmount - (h17.TotalAmount - h17.PaidAmount)) < 0.005,
  `remaining ${h17.RemainingAmount}, owed ${h17.TotalAmount - h17.PaidAmount}`);

// 18 A settled invoice must not stay "partial" because of floating-point dust.
seed();
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:3,UnitPrice:1000/3}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
const s18 = q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
const tot18 = q('SELECT TotalAmount v FROM sales WHERE SaleID=?',s18).v;
await call('saleReturns:create',{SaleID:s18,items:[{ItemID:2,Quantity:3,UnitPrice:1000/3}],
  AccountCredit:tot18,CashRefund:0});
const h18 = q('SELECT RemainingAmount,Status FROM sales WHERE SaleID=?',s18);
t('a fully settled invoice is marked completed, not left "partial" by dust',
  !(h18.RemainingAmount <= 0.011 && (h18.Status==='partial'||h18.Status==='unpaid')),
  `remaining ${h18.RemainingAmount} status ${h18.Status}`);

// 19 Emptying a pool must book the leftover valuation, not discard it.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=2');
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:2,UnitCost:600,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:2000,CashAccountID:1,fiscalYearId:1});
const s19 = q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:1,UnitCost:552,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
await call('saleReturns:create',{SaleID:s19,items:[{ItemID:2,Quantity:1,UnitPrice:1000}],
  AccountCredit:0,CashRefund:1000,CashAccountID:1});
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:1,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:1000,CashAccountID:1,fiscalYearId:1});
const ret19 = q('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:saleReturn',ret19);
const adj19 = q('SELECT COALESCE(SUM(Amount),0) v FROM inventory_adjustments').v;
t('value stranded by an emptied pool is recorded, not lost',
  Math.abs(adj19) > 0.005,
  `inventory_adjustments total ${adj19}`);
t('the recorded adjustment has the right sign (negative = a gain)',
  adj19 < 0, `amount ${adj19}`);

// 20 The profit report must reconcile to the books it is derived from.
//
// Every earlier fix was verified against balances measured directly from the
// tables. That is the right test, but it is not what the owner sees: he sees
// the profit report. If a valuation adjustment is booked into inventory and
// NOT charged in the P&L, the two disagree and the report overstates profit
// by exactly the amount that was written off.
seed();
currentDb().exec('DELETE FROM stock_quantities WHERE ItemID=2');
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:2,UnitCost:600,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:2000,CashAccountID:1,fiscalYearId:1});
const s20 = q('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:1,UnitCost:552,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
await call('saleReturns:create',{SaleID:s20,items:[{ItemID:2,Quantity:1,UnitPrice:1000}],
  AccountCredit:0,CashRefund:1000,CashAccountID:1});
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:1,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:1000,CashAccountID:1,fiscalYearId:1});
const ret20 = q('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:saleReturn',ret20);

// The opening position of seed(): cash 100000 plus the stock it creates.
// ItemID 2 was cleared above, so only the cables remain: 10 @ 10.
const OPENING = 100000 + 10 * 10;
const pl = await call('reports:profitLoss', {});
const gg = s => currentDb().prepare(s).get()?.v ?? 0;
const measured = gg('SELECT COALESCE(SUM(Balance),0) v FROM cash_accounts')
  + gg('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities')
  + gg('SELECT COALESCE(SUM(Balance),0) v FROM customers WHERE Balance>0')
  - gg('SELECT COALESCE(SUM(Balance),0) v FROM suppliers WHERE Balance>0')
  - gg('SELECT COALESCE(SUM(-Balance),0) v FROM customers WHERE Balance<0')
  + gg('SELECT COALESCE(SUM(-Balance),0) v FROM suppliers WHERE Balance<0');
t('the stranded valuation is charged in the profit report',
  Math.abs((pl?.costs?.valuationAdjustments ?? 0)) > 0.005,
  `costs.valuationAdjustments = ${pl?.costs?.valuationAdjustments}`);
t('gross profit reconciles to the balances it came from',
  Math.abs(measured - (OPENING + pl.grossProfit)) < 0.005,
  `measured ${r2(measured)} vs opening+profit ${r2(OPENING + pl.grossProfit)}`);

// ===================================================================
// Round 3 — SERIALISED handsets.
//
// Both fuzzer items were IsSerialized = 0, so ~58 lines of IMEI handling had
// never been executed by any test. In a mobile phone shop that is the main
// business. Every defect below was found the moment a serialised item was
// added, and the first is the most serious found in the whole audit.
// ===================================================================

function seedSerial() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'iPhone','device',1,600,1000,1)");
  return db;
}
const buyPhone = (imei, cost, wh = 1) => call('purchases:create', {
  SupplierID: 1, items: [{ ItemID: 1, Quantity: 1, UnitCost: cost, WarehouseID: wh, IMEI: imei }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1,
});
const serialOf = imei => q('SELECT SerialID v FROM item_serials WHERE IMEI = ?', imei).v;
// Warehouse quantity/value must equal the devices actually on the shelf.
const agree = () => {
  const a = q('SELECT COALESCE(SUM(Quantity),0) v FROM stock_quantities WHERE ItemID=1').v;
  const b = q("SELECT COUNT(*) v FROM item_serials WHERE ItemID=1 AND Status='available'").v;
  const av = q('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities WHERE ItemID=1').v;
  const bv = q("SELECT COALESCE(SUM(CostPrice),0) v FROM item_serials WHERE ItemID=1 AND Status='available'").v;
  return { ok: Math.abs(a - b) < 1e-9 && Math.abs(av - bv) < 0.011, a, b, av, bv };
};

// 21 Selling a handset must remove it from the warehouse, not just flag the
//    IMEI. Inventory was overstated by the cost of every phone ever sold.
seedSerial();
await buyPhone('111', 600);
await buyPhone('222', 900);
await call('sales:create', { CustomerID: 1,
  items: [{ ItemID: 1, SerialID: serialOf('111'), Quantity: 1, UnitPrice: 1000 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 1000,
  CashAccountID: 1, fiscalYearId: 1 });
let ag = agree();
t('selling a handset removes it from the warehouse too', ag.ok,
  `warehouse ${ag.a} units worth ${ag.av}, devices ${ag.b} worth ${ag.bv}`);

// 22 Returning it puts both records back.
await call('saleReturns:create', { SaleID: q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v,
  items: [{ ItemID: 1, SerialID: serialOf('111'), Quantity: 1, UnitPrice: 1000 }],
  AccountCredit: 0, CashRefund: 1000, CashAccountID: 1 });
ag = agree();
t('returning it restores both the count and the device', ag.ok,
  `warehouse ${ag.a}/${ag.av}, devices ${ag.b}/${ag.bv}`);

// 23 One IMEI is one physical phone: it cannot be received twice.
seedSerial();
await buyPhone('SAME', 661);
const dup = await buyPhone('SAME', 641);
t('receiving an IMEI already in stock is refused', dup.success === false, dup.message);
t('the duplicate did not inflate the warehouse',
  q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 1,
  'qty ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);

// 24 A device already sold cannot be handed back to the supplier.
seedSerial();
await buyPhone('AAA', 600);
const pOnly = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v;
await call('sales:create', { CustomerID: 1,
  items: [{ ItemID: 1, SerialID: serialOf('AAA'), Quantity: 1, UnitPrice: 1000 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 1000,
  CashAccountID: 1, fiscalYearId: 1 });
const badRet = await call('purchaseReturns:create', { PurchaseID: pOnly,
  items: [{ ItemID: 1, Quantity: 1, UnitCost: 600 }], AccountCredit: 600, CashRefund: 0 });
t('returning a sold handset to the supplier is refused', badRet.success === false, badRet.message);

// 25 A purchase return with no SerialID still takes a device off the shelf.
seedSerial();
await buyPhone('BBB', 600);
const pB = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v;
await call('purchaseReturns:create', { PurchaseID: pB,
  items: [{ ItemID: 1, Quantity: 1, UnitCost: 600 }], AccountCredit: 600, CashRefund: 0 });
ag = agree();
t('a debit note without an IMEI still removes the device', ag.ok,
  `warehouse ${ag.a}/${ag.av}, devices ${ag.b}/${ag.bv}`);

// 26 ...and cancelling it puts the device back.
await call('delete:purchaseReturn', q('SELECT ReturnID v FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').v);
ag = agree();
t('cancelling that debit note restores the device', ag.ok && ag.b === 1,
  `warehouse ${ag.a}/${ag.av}, devices ${ag.b}/${ag.bv}`);

// 27 A unit cost can never be negative — weighted average cannot express which
//    specific units left, and repeated returns drove it below zero.
seedSerial();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(2,'Loose','part',0,10,20,1)");
await call('purchases:create', { SupplierID: 1, items: [{ ItemID: 2, Quantity: 2, UnitCost: 900, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
const pExp = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v;
await call('purchases:create', { SupplierID: 1, items: [{ ItemID: 2, Quantity: 2, UnitCost: 100, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 2, Quantity: 1, UnitPrice: 1200 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 1200, CashAccountID: 1, fiscalYearId: 1 });
await call('purchaseReturns:create', { PurchaseID: pExp,
  items: [{ ItemID: 2, Quantity: 1, UnitCost: 900 }], AccountCredit: 900, CashRefund: 0 });
const cp = q('SELECT MIN(CostPrice) v FROM stock_quantities WHERE ItemID=2').v;
t('a unit cost is never driven negative', cp >= 0, 'lowest unit cost ' + cp);

// ===================================================================
// Round 4 — the BALANCE SHEET, checked through the report the owner reads.
//
// Everything until now was verified against balances measured straight from
// the tables. That is the right test of the engine, but it is not what the
// owner sees. `reports:financialPosition` computes its own `isBalanced` flag
// and nothing was reading it, so the report could say "does not balance" and
// no test would notice.
// ===================================================================

function seedBS(capital) {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'iPhone','device',1,600,1000,1),(2,'Cable','part',0,10,20,1)");
  db.exec(`INSERT INTO settings(Key,Value) VALUES('owner_capital','${capital}')`);
  return db;
}
const bsDiff = async () => (await call('reports:financialPosition'))?.capital?.difference;

// 28 A handset is valued at ITS OWN cost, not the item's average.
//    Buying at 600 and 1000 averages 800; after selling the cheap one the
//    balance sheet valued the remaining 1000 phone at 800 and stopped
//    balancing.
seedBS(100000);
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 1, Quantity: 1, UnitCost: 600, WarehouseID: 1, IMEI: 'X1' }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 1, Quantity: 1, UnitCost: 1000, WarehouseID: 1, IMEI: 'X2' }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
await call('sales:create', { CustomerID: 1,
  items: [{ ItemID: 1, SerialID: q("SELECT SerialID v FROM item_serials WHERE IMEI='X1'").v, Quantity: 1, UnitPrice: 1500 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 1500, CashAccountID: 1, fiscalYearId: 1 });
const inv28 = (await call('reports:financialPosition')).assets.inventory;
t('the remaining handset is valued at its own cost, not the average',
  Math.abs((inv28[0]?.Value ?? 0) - 1000) < 0.011, `balance sheet shows ${inv28[0]?.Value}`);
t('the balance sheet balances after selling one of two handsets',
  Math.abs(await bsDiff()) < 0.011, 'difference ' + await bsDiff());

// 29 A supplier who owes US money is an asset.
//    Over-refunding on a paid invoice drives the balance negative; only
//    `Balance > 0` was read, so that value appeared nowhere at all.
seedBS(100000);
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 2, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 100, PaymentSourceType: 'cash_account',
  PaymentSourceID: 1, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
currentDb().exec('UPDATE suppliers SET Balance = -250 WHERE SupplierID = 1');
const fp29 = await call('reports:financialPosition');
t('a supplier credit is reported as an asset',
  Math.abs((fp29.assets.totalSupplierCredits ?? 0) - 250) < 0.011,
  'totalSupplierCredits ' + fp29.assets.totalSupplierCredits);

// 30 The two reports must agree: cost of returned goods is credited in BOTH.
seedBS(100000);
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 2, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 2, Quantity: 5, UnitPrice: 30 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 150,
  CashAccountID: 1, fiscalYearId: 1 });
await call('saleReturns:create', { SaleID: q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v,
  items: [{ ItemID: 2, Quantity: 5, UnitPrice: 30 }],
  AccountCredit: 0, CashRefund: 150, CashAccountID: 1 });
const pl30 = await call('reports:profitLoss', {});
const fp30 = await call('reports:financialPosition');
t('the profit report credits the cost of returned goods',
  Math.abs(pl30.costs.cogsReturns - 50) < 0.011, 'cogsReturns ' + pl30.costs.cogsReturns);
t('both reports agree on profit after a full return',
  Math.abs(pl30.grossProfit - fp30.capital.netProfit) < 0.011,
  `P&L ${pl30.grossProfit} vs balance sheet ${fp30.capital.netProfit}`);
t('the balance sheet balances after a full sale return',
  Math.abs(fp30.capital.difference) < 0.011, 'difference ' + fp30.capital.difference);

// 31 A write-off must be charged ONCE, not by two separate columns.
seedBS(100000);
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 2, Quantity: 10, UnitCost: 10, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 50, PaymentCost: 0, fiscalYearId: 1 });
await call('purchaseReturns:create', {
  PurchaseID: q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v,
  items: [{ ItemID: 2, Quantity: 10, UnitCost: 10 }], AccountCredit: 100, CashRefund: 0 });
const pl31 = await call('reports:profitLoss', {});
const fp31 = await call('reports:financialPosition');
t('the 50 of lost freight is charged exactly once',
  Math.abs(pl31.costs.total - 50) < 0.011, 'total direct costs ' + pl31.costs.total);
t('the balance sheet still balances after a freight write-off',
  Math.abs(fp31.capital.difference) < 0.011, 'difference ' + fp31.capital.difference);

// ===================================================================
// Round 5 — DISCOUNTS. A discounted invoice is paid at less than the sum of
// its lines, so a return must refund the discounted price, not the list price.
// ===================================================================

function seedDisc() {
  const db = buildDatabase();
  db.exec("INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)");
  db.exec("INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)");
  db.exec("INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')");
  db.exec("INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')");
  db.exec("INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)");
  db.exec("INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')");
  db.exec("INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')");
  db.exec("INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)");
  db.exec("INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)");
  return db;
}

// 32 A partial return on a discounted invoice refunds the discounted price.
//    10 cables at 100 with a 200 discount is paid at 800, i.e. 80 a unit.
//    Returning 8 used to hand back the whole 800 while the customer kept 2.
seedDisc();
await call('sales:create', { CustomerID: 1,
  items: [{ ItemID: 1, Quantity: 10, UnitPrice: 100 }],
  Discount: 200, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash',
  PaidAmount: 800, CashAccountID: 1, fiscalYearId: 1 });
const sidD = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v;
const offer = (await call('saleReturns:returnable', sidD))[0];
t('the screen offers the discounted price, not the list price',
  Math.abs(offer.UnitPrice - 80) < 0.011, `offered ${offer.UnitPrice}, expected 80`);

const cashBeforeD = q('SELECT Balance v FROM cash_accounts').v;
let refunded = 0;
for (let i = 0; i < 8; i++) {
  const o = (await call('saleReturns:returnable', sidD))[0];
  const rr = await call('saleReturns:create', { SaleID: sidD,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: o.UnitPrice }],
    AccountCredit: 0, CashRefund: o.UnitPrice, CashAccountID: 1 });
  if (rr?.success) refunded += o.UnitPrice;
}
t('returning 8 of 10 refunds 640, not the whole 800',
  Math.abs(refunded - 640) < 0.011, `refunded ${refunded}`);
t('the drawer fell by exactly that',
  Math.abs((cashBeforeD - q('SELECT Balance v FROM cash_accounts').v) - 640) < 0.011,
  `drawer moved ${cashBeforeD - q('SELECT Balance v FROM cash_accounts').v}`);
t('refunding the LIST price is refused',
  (await call('saleReturns:create', { SaleID: sidD,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: 100 }],
    AccountCredit: 0, CashRefund: 100, CashAccountID: 1 }))?.success === false);

// 33 The same on the purchase side, and the discount must reduce stock value.
seedDisc();
currentDb().exec('DELETE FROM stock_quantities');
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 1, Quantity: 10, UnitCost: 100, WarehouseID: 1 }],
  Discount: 200, TaxAmount: 0, PaidAmount: 0,
  AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
t('a purchase discount reduces the value put into stock',
  Math.abs(q('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').v - 800) < 0.011,
  `stock valued ${q('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').v}, invoice was 800`);

const pidD = q('SELECT PurchaseID v FROM purchases ORDER BY PurchaseID DESC LIMIT 1').v;
const offerP = (await call('purchaseReturns:returnable', pidD))[0];
t('the debit-note screen offers the discounted cost',
  Math.abs(offerP.UnitCost - 80) < 0.011, `offered ${offerP.UnitCost}, expected 80`);

let credited = 0;
for (let i = 0; i < 8; i++) {
  const o = (await call('purchaseReturns:returnable', pidD))[0];
  const rr = await call('purchaseReturns:create', { PurchaseID: pidD,
    items: [{ ItemID: 1, Quantity: 1, UnitCost: o.UnitCost }],
    AccountCredit: o.UnitCost, CashRefund: 0 });
  if (rr?.success) credited += o.UnitCost;
}
t('returning 8 of 10 credits 640, not the whole 800',
  Math.abs(credited - 640) < 0.011, `credited ${credited}`);
t('the supplier is still owed 160 for the two kept',
  Math.abs(q('SELECT Balance v FROM suppliers').v - 160) < 0.011,
  `supplier owed ${q('SELECT Balance v FROM suppliers').v}`);
t('the two units left are worth 160',
  Math.abs(q('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').v - 160) < 0.011,
  `stock worth ${q('SELECT COALESCE(SUM(Quantity*CostPrice),0) v FROM stock_quantities').v}`);

// 34 A total that divides unevenly must not strand a sub-piastre debt.
//    55.00 over 3 units is 18.3333 each; rounded shares give 54.99 and the
//    invoice stayed "partial" for ever, owing a hundredth of a piastre.
seedDisc();
await call('sales:create', { CustomerID: 1,
  items: [{ ItemID: 1, Quantity: 1, UnitPrice: 21 }, { ItemID: 1, Quantity: 2, UnitPrice: 17 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit',
  PaidAmount: 0, fiscalYearId: 1 });
const sidR = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v;
for (let i = 0; i < 3; i++) {
  const o = (await call('saleReturns:returnable', sidR))[0];
  if (!o || o.Returnable <= 0) break;
  await call('saleReturns:create', { SaleID: sidR,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: o.UnitPrice }],
    AccountCredit: o.UnitPrice, CashRefund: 0 });
}
const hdrR = q('SELECT RemainingAmount rem, Status st FROM sales WHERE SaleID = ?', sidR);
t('returning every unit leaves no stranded piastre',
  Math.abs(hdrR.rem) < 0.011 && hdrR.st === 'completed',
  `remaining ${hdrR.rem}, status ${hdrR.st}`);

// ===================================================================
// Round 5 — a blind spot found by MUTATION TESTING.
//
// Breaking `restoreStockAtCost` on purpose — so returned goods re-enter at
// whatever stale price the empty pool still carried, instead of the cost they
// actually left at — was not detected by ANY suite. The fault inflated
// inventory from 100 to 300 in the scenario below, so it was well worth
// catching. The gap existed because every earlier test returned goods into a
// pool that still held stock, where the weighted average hides the difference.
// ===================================================================
seed();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,10)');
// Sell the pool EMPTY, so the row survives with a stale unit cost.
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 200,
  CashAccountID: 1, fiscalYearId: 1 });
const sidStale = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v;
// Restock at a very different price and clear it out again, so the leftover
// CostPrice on the empty row is now 30 while the goods to be returned cost 10.
await call('purchases:create', { SupplierID: 1,
  items: [{ ItemID: 1, Quantity: 5, UnitCost: 30, WarehouseID: 1 }],
  Discount: 0, TaxAmount: 0, PaidAmount: 0, AdditionalCost: 0, PaymentCost: 0, fiscalYearId: 1 });
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 50 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 250,
  CashAccountID: 1, fiscalYearId: 1 });
t('the emptied pool is left carrying a stale unit cost',
  Math.abs(q('SELECT CostPrice v FROM stock_quantities WHERE ItemID=1').v - 30) < 0.011,
  'stale cost ' + q('SELECT CostPrice v FROM stock_quantities WHERE ItemID=1').v);
// Return the ORIGINAL goods, which cost 10 each, into that empty pool.
await call('saleReturns:create', { SaleID: sidStale,
  items: [{ ItemID: 1, Quantity: 10, UnitPrice: 20 }],
  AccountCredit: 0, CashRefund: 200, CashAccountID: 1 });
const backVal = q('SELECT ROUND(Quantity*CostPrice,2) v FROM stock_quantities WHERE ItemID=1').v;
t('goods return at the cost they left at, not the stale pool price',
  Math.abs(backVal - 100) < 0.011,
  `inventory ${backVal}, expected 100 (10 units at 10)`);

// ===================================================================
// Round 6 — goods given away at a full discount could never come back.
//
// A 100% discount is a real transaction: a replacement, a goodwill item, a
// promotion. `sales:create` accepts it and the goods leave the shelf. But the
// settlement validator refused any return whose value was not strictly
// positive, so those units were stranded outside inventory for ever — the shop
// physically held them and no document could put them back.
// ===================================================================
seed();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)');
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
  Discount: 100, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 0,
  CashAccountID: 1, fiscalYearId: 1 });
const sidFree = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v;
t('goods given away at a full discount do leave the shelf',
  q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 95,
  'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);

const freeRet = await call('saleReturns:create', { SaleID: sidFree,
  items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }], AccountCredit: 0, CashRefund: 0 });
t('a zero-value return is accepted so the goods can come back',
  freeRet.success === true, freeRet.message);
t('the goods are back in stock',
  q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v === 100,
  'stock ' + q('SELECT Quantity v FROM stock_quantities WHERE ItemID=1').v);
t('no cash moved on a zero-value return',
  Math.abs(q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v - 100000) < 0.011,
  'cash ' + q('SELECT Balance v FROM cash_accounts WHERE CashAccountID=1').v);

// ...and it must not become a way to take money out.
seed();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)');
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
  Discount: 100, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 0,
  CashAccountID: 1, fiscalYearId: 1 });
const abuse = await call('saleReturns:create',
  { SaleID: q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v,
    items: [{ ItemID: 1, Quantity: 5, UnitPrice: 20 }],
    AccountCredit: 0, CashRefund: 50, CashAccountID: 1 });
t('a zero-value return cannot pay out cash', abuse.success === false, abuse.message);

// ===================================================================
// Round 7 — the last unit of a discounted invoice could not be returned.
//
// The returnable list prices each unit at the line price scaled by the
// invoice's discount ratio, and that quotient rarely lands on a whole piastre.
// Three units of 100 on an invoice discounted by 0.01 are 99.996666... each,
// which rounds to 100.00. Two returns of 100.00 were accepted; the third was
// refused for exceeding 299.99 by ONE piastre.
//
// The customer was left owing 99.99 for goods already back on the shelf, and no
// document could close the invoice.
// ===================================================================
seed();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,1000,10)');
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 3, UnitPrice: 100 }],
  Discount: 0.01, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'credit', PaidAmount: 0, fiscalYearId: 1 });
const sidRound = q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v;
let accepted = 0;
for (let i = 0; i < 3; i++) {
  const line = (await call('saleReturns:returnable', sidRound)).find(x => x.Returnable > 0);
  if (!line) break;
  const amt = Math.round(line.UnitPrice * 100) / 100;
  const rr = await call('saleReturns:create', { SaleID: sidRound,
    items: [{ ItemID: 1, Quantity: 1, UnitPrice: line.UnitPrice }],
    AccountCredit: amt, CashRefund: 0 });
  if (rr.success) accepted++;
}
t('every unit of a discounted invoice can be returned one at a time',
  accepted === 3, `${accepted} of 3 accepted`);
const hdrRound = q('SELECT ROUND(RemainingAmount,2) rem, ROUND(TotalAmount,2) tot FROM sales WHERE SaleID=?', sidRound);
const retRound = q('SELECT ROUND(COALESCE(SUM(TotalAmount),0),2) v FROM sale_returns WHERE SaleID=?', sidRound).v;
t('the returns sum to exactly the amount charged',
  Math.abs(retRound - hdrRound.tot) < 0.011, `returned ${retRound} vs charged ${hdrRound.tot}`);
t('the invoice closes at zero, not at a stray piastre',
  Math.abs(hdrRound.rem) < 0.011, 'remaining ' + hdrRound.rem);
t('the customer owes nothing once everything is back',
  Math.abs(q('SELECT ROUND(Balance,2) v FROM customers WHERE CustomerID=1').v) < 0.011,
  'balance ' + q('SELECT ROUND(Balance,2) v FROM customers WHERE CustomerID=1').v);

// The trim must not become a way to over-refund.
seed();
currentDb().exec('DELETE FROM stock_quantities');
currentDb().exec('INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,1000,10)');
await call('sales:create', { CustomerID: 1, items: [{ ItemID: 1, Quantity: 2, UnitPrice: 100 }],
  Discount: 0, TaxRate: 0, TaxAmount: 0, PaymentMethod: 'cash', PaidAmount: 200,
  CashAccountID: 1, fiscalYearId: 1 });
const bigOver = await call('saleReturns:create',
  { SaleID: q('SELECT SaleID v FROM sales ORDER BY SaleID DESC LIMIT 1').v,
    items: [{ ItemID: 1, Quantity: 2, UnitPrice: 100 }],
    AccountCredit: 0, CashRefund: 500, CashAccountID: 1 });
t('a genuine over-refund is still refused', bigOver.success === false, bigOver.message);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
