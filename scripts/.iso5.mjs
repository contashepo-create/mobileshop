import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q1=(s,...a)=>currentDb().prepare(s).get(...a);
const r2=n=>Math.round(n*100)/100;
const db=buildDatabase();
db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)`);
db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)`);
db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')`);
db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')`);
db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)`);
db.exec(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,10)`);

const S=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1');
  return {qty:s.q,cost:r2(s.c),value:r2(s.q*s.c)};};
console.log('start:',JSON.stringify(S()),' (10 @10 = 100)');

// sell 10 at cost 10
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:10,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:200,CashAccountID:1,fiscalYearId:1});
const sid=q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
console.log('after sale:',JSON.stringify(S()));

// buy 10 more at cost 20 -> warehouse now 10 @20
await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:10,UnitCost:20,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
db.exec(`INSERT OR IGNORE INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')`);
console.log('after restock @20:',JSON.stringify(S()));

// customer returns 10 (they left at cost 10) -> avg becomes (10*20+10*10)/20 = 15
await call('saleReturns:create',{SaleID:sid,items:[{ItemID:1,Quantity:10,UnitPrice:20}],
  AccountCredit:0,CashRefund:200,CashAccountID:1});
const afterRet=S();
console.log('after return:',JSON.stringify(afterRet),' expect 20 @15 = 300');

// now UNDO the return -> goods leave again
const rid=q1('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:saleReturn',rid);
const afterUndo=S();
console.log('after undo  :',JSON.stringify(afterUndo),' expect 10 @20 = 200');
console.log();
console.log('value removed by undo =',r2(afterRet.value-afterUndo.value),' should be 100 (the 10 units at their cost 10)');
console.log('DRIFT =',r2((afterRet.value-afterUndo.value)-100));
console.log();
console.log('CAUSE: deductStock() only subtracts QUANTITY and leaves CostPrice at');
console.log('the blended average, so the units removed are valued at 15 not 10.');
