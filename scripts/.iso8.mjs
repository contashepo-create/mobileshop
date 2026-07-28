import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q1=(s,...a)=>currentDb().prepare(s).get(...a);
const r=n=>Math.round(n*1000)/1000;
const db=buildDatabase();
db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)`);
db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)`);
db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')`);
db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'M')`);
db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)`);
db.exec(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'C','part',0,10,20,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,10,10)`);
const st=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=1');return{q:s.q,c:r(s.c),v:r(s.q*s.c)};};

// ONE invoice, SAME item twice at DIFFERENT prices -> different UnitCost? no, same cost.
// Instead: sell, then restock cheaper, then sell again -> two lines, two costs.
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:5,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
console.log('pool after 1st sale:',JSON.stringify(st()));
db.exec(`UPDATE stock_quantities SET Quantity=10, CostPrice=13 WHERE ItemID=1`);
console.log('pool re-priced to 13:',JSON.stringify(st()));

// second sale of same item on a NEW invoice at cost 13
await call('sales:create',{CustomerID:1,items:[{ItemID:1,Quantity:2,UnitPrice:20},{ItemID:1,Quantity:1,UnitPrice:25}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'credit',PaidAmount:0,fiscalYearId:1});
const sid=q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
console.log('invoice lines:',JSON.stringify(currentDb().prepare('SELECT ItemID,Quantity,UnitPrice,UnitCost FROM sale_details WHERE SaleID=?').all(sid)));
const before=st().v;
const rr=await call('saleReturns:create',{SaleID:sid,items:[{ItemID:1,Quantity:1,UnitPrice:25}],AccountCredit:25,CashRefund:0});
console.log('return 1 unit of the @25 line:',rr.success);
const after=st().v;
const rd=q1('SELECT UnitPrice FROM sale_return_details ORDER BY DetailID DESC LIMIT 1');
console.log('  return_detail UnitPrice recorded =',rd.UnitPrice,' (asked 25)');
console.log('  stock value rose by',r(after-before));
console.log();
console.log('>>> the handler picks the FIRST matching line via .find(), so a return');
console.log('>>> of the @25 line can be recorded at the @20 line price.');
