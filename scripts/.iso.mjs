import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q1=(s,...a)=>currentDb().prepare(s).get(...a);
const db=buildDatabase();
db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)`);
db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)`);
db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')`);
db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main'),(2,'Branch')`);
db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)`);
db.exec(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(2,'Phone','device',0,600,1000,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,20,600)`);

const st=()=>({main:q1('SELECT Quantity q FROM stock_quantities WHERE ItemID=2 AND WarehouseID=1')?.q,
               branch:q1('SELECT Quantity q FROM stock_quantities WHERE ItemID=2 AND WarehouseID=2')?.q ?? 'no row'});
console.log('start:',JSON.stringify(st()));

// buy 2 phones INTO BRANCH
let r=await call('purchases:create',{SupplierID:1,
  items:[{ItemID:2,Quantity:2,UnitCost:600,WarehouseID:2}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
console.log('purchase into branch:',r.success, JSON.stringify(st()));
const pid=q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;

// sell them (sale takes from wherever stock is)
r=await call('sales:create',{items:[{ItemID:2,Quantity:2,UnitPrice:1000}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:2000,CashAccountID:1,fiscalYearId:1});
console.log('sale 2 phones:',r.success, JSON.stringify(st()));

// now DELETE the purchase -> stock should be blocked or handled
r=await call('delete:purchase',pid);
console.log('delete purchase:',r.success, r.message||'');
console.log('AFTER:',JSON.stringify(st()));
console.log();
console.log('>>> the goods were already SOLD, yet the purchase was deleted,');
console.log('>>> driving the branch negative. Stock that was sold is gone —');
console.log('>>> you cannot un-receive it.');
