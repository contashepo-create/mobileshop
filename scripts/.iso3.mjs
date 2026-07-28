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
db.exec(`INSERT INTO suppliers(SupplierID,Name,Balance,Status) VALUES(1,'S',0,'active')`);
db.exec(`INSERT INTO items(ItemID,ItemName,ItemType,IsSerialized,CostPrice,SalePrice,IsActive) VALUES(1,'Cable','part',0,10,20,1)`);
db.exec(`INSERT INTO stock_quantities(ItemID,WarehouseID,Quantity,CostPrice) VALUES(1,1,0,10)`);

// buy 15 @12 + 25 shipping -> landed 13.6667
let r=await call('purchases:create',{SupplierID:1,
  items:[{ItemID:1,Quantity:15,UnitCost:12,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:25,PaymentCost:0,fiscalYearId:1});
const S=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1');
  return {qty:s.q,cost:r2(s.c),value:r2(s.q*s.c),supp:q1('SELECT Balance b FROM suppliers WHERE SupplierID=1').b};};
console.log('after purchase:',JSON.stringify(S()));
const pid=q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;

// return ALL 15 -> nothing left to absorb the 25 freight
const b=S();
r=await call('purchaseReturns:create',{PurchaseID:pid,items:[{ItemID:1,Quantity:15,UnitCost:12}],
  AccountCredit:180,CashRefund:0});
const a=S();
console.log('return ALL 15:',r.success);
console.log('  before',JSON.stringify(b),'\n  after ',JSON.stringify(a));
console.log('  stock value fell',r2(b.value-a.value),' supplier debt fell',r2(b.supp-a.supp));
console.log('  DRIFT',r2((b.value-a.value)-(b.supp-a.supp)),'<-- the 25 freight written off');
console.log();
console.log('  This is CORRECT accounting: the freight is a real expense.');
console.log('  But the invariant formula does not know about it yet.');
