import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q1=(s,...a)=>currentDb().prepare(s).get(...a);
const r=n=>Math.round(n*100)/100;
const db=buildDatabase();
db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)`);
db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)`);
db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')`);
db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'M')`);
db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)`);
db.exec(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')`);
db.exec(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(2,'Phone','device',0,600,1000,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(2,1,3,600)`);

// 3 units, cost that does NOT divide evenly
await call('purchases:create',{SupplierID:1,items:[{ItemID:2,Quantity:3,UnitCost:610,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:10,PaymentCost:0,fiscalYearId:1});
const st=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=2');return{q:s.q,c:s.c,v:s.q*s.c};};
console.log('pool:',JSON.stringify(st()),' cost has repeating decimals?',st().c);
await call('sales:create',{CustomerID:1,items:[{ItemID:2,Quantity:1,UnitPrice:1108}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
const sid=q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
const cost=q1('SELECT UnitCost FROM sale_details WHERE SaleID=?',sid).UnitCost;
console.log('sold 1, COGS booked =',cost,' (full precision)');
console.log('pool after sale:',JSON.stringify(st()));
const before=st().v;
await call('saleReturns:create',{SaleID:sid,items:[{ItemID:2,Quantity:1,UnitPrice:1108}],AccountCredit:1108,CashRefund:0});
const after=st().v;
console.log('pool after return:',JSON.stringify(st()));
console.log('value added back =',after-before,' COGS reversed =',cost);
console.log('difference =',after-before-cost);
console.log();
console.log('If tiny (<0.01) this is float rounding in the average, not a leak.');
