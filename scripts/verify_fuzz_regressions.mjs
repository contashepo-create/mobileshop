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
t('unrecoverable freight is recorded, not silently lost',
  q('SELECT FreightWrittenOff f FROM purchase_returns ORDER BY ReturnID DESC LIMIT 1').f===25,
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
