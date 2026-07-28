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
db.exec(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,10)`);
const S=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1');
  return {qty:s.q,cost:r2(s.c),value:r2(s.q*s.c)};};

await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:5,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:100,CashAccountID:1,fiscalYearId:1});
const sid=q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
console.log('sold 5 @cost10  ->',JSON.stringify(S()));

const p=await call('purchases:create',{SupplierID:1,items:[{ItemID:1,Quantity:5,UnitCost:30,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:0,PaymentCost:0,fiscalYearId:1});
console.log('bought 5 @30 ->',p.success,JSON.stringify(S()),' (5@10 + 5@30 = avg 20, value 200)');

await call('saleReturns:create',{SaleID:sid,items:[{ItemID:1,Quantity:5,UnitPrice:20}],
  AccountCredit:0,CashRefund:100,CashAccountID:1});
const A=S(); console.log('customer returns 5 (cost 10) ->',JSON.stringify(A),' (15 units: 5@10+5@30+5@10 = 250)');

const rid=q1('SELECT ReturnID FROM sale_returns ORDER BY ReturnID DESC LIMIT 1').ReturnID;
await call('delete:saleReturn',rid);
const B=S(); console.log('undo the return            ->',JSON.stringify(B),' (should be back to 200)');
console.log();
console.log('value removed =',r2(A.value-B.value),' should be 50 (5 units @ their cost 10)');
console.log('DRIFT =',r2((A.value-B.value)-50));
