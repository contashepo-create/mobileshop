import { buildDatabase, loadHandlers, call, currentDb } from './lib/handlerHarness.mjs';
await loadHandlers();
const q1=(s,...a)=>currentDb().prepare(s).get(...a);
const db=buildDatabase();
db.exec(`INSERT INTO roles(RoleID,RoleName,IsSystem) VALUES(1,'a',1)`);
db.exec(`INSERT INTO users(UserID,Username,PasswordHash,RoleID,IsActive) VALUES(1,'a','x',1,1)`);
db.exec(`INSERT INTO fiscal_years(FiscalYearID,YearName,StartDate,EndDate,Status) VALUES(1,'26','2026-01-01','2026-12-31','open')`);
db.exec(`INSERT INTO warehouses(WarehouseID,WarehouseName) VALUES(1,'Main')`);
db.exec(`INSERT INTO cash_accounts(CashAccountID,AccountName,AccountType,Balance,IsActive) VALUES(1,'S','safe',100000,1)`);
db.exec(`INSERT INTO customers(CustomerID,Name,Balance,Status) VALUES(1,'A',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,100,10)`);

// ONE invoice, TWO lines of the SAME item (the fuzzer does this naturally)
await call('sales:create',{CustomerID:1,
  items:[{ItemID:1,Quantity:1,UnitPrice:20},{ItemID:1,Quantity:1,UnitPrice:20}],
  Discount:0,TaxRate:0,TaxAmount:0,PaymentMethod:'cash',PaidAmount:40,CashAccountID:1,fiscalYearId:1});
const sid=q1('SELECT SaleID FROM sales ORDER BY SaleID DESC LIMIT 1').SaleID;
console.log('invoice lines:',JSON.stringify(currentDb().prepare('SELECT ItemID,Quantity FROM sale_details WHERE SaleID=?').all(sid)));
const sold=currentDb().prepare('SELECT SUM(Quantity) t FROM sale_details WHERE SaleID=? AND ItemID=1').get(sid).t;
console.log('total sold of item 1 =',sold);

for(let i=1;i<=4;i++){
  const r=await call('saleReturns:create',{SaleID:sid,items:[{ItemID:1,Quantity:1,UnitPrice:20}],
    AccountCredit:20,CashRefund:0});
  const back=currentDb().prepare(`SELECT COALESCE(SUM(rd.Quantity),0) t FROM sale_return_details rd
    JOIN sale_returns r ON rd.ReturnID=r.ReturnID WHERE r.SaleID=?`).get(sid).t;
  console.log(`return #${i}: ${r.success?'ACCEPTED':'refused'}  total returned now = ${back} (sold ${sold})`);
  if(back>sold){console.log('  >>> BUG: returned more than sold');break;}
}
console.log();
console.log('CAUSE: AlreadyReturned SUMs returns for the item across the whole');
console.log('invoice, but it is compared against ONE line\'s Quantity.');
console.log('With 2 lines of 1 each, line-1 allows 1 and line-2 allows 1 again,');
console.log('but the .find() always matches the FIRST line -> cap never advances.');
