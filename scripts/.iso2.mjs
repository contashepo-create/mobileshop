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

const S=()=>{const s=q1('SELECT Quantity q,CostPrice c FROM stock_quantities WHERE ItemID=1 AND WarehouseID=1');
  return {qty:s.q,cost:r2(s.c),value:r2(s.q*s.c),
    cash:q1('SELECT Balance b FROM cash_accounts WHERE CashAccountID=1').b,
    supp:q1('SELECT Balance b FROM suppliers WHERE SupplierID=1').b};};

// Purchase 20 @12 WITH 30 additional cost -> landed = 12 + 30/20 = 13.50
let r=await call('purchases:create',{SupplierID:1,
  items:[{ItemID:1,Quantity:20,UnitCost:12,WarehouseID:1}],
  Discount:0,TaxAmount:0,PaidAmount:0,AdditionalCost:30,PaymentCost:0,fiscalYearId:1});
console.log('purchase 20@12 +30 shipping:',r.success);
console.log('  ',JSON.stringify(S()),' landed cost should be 13.50, value 270');
const pid=q1('SELECT PurchaseID FROM purchases ORDER BY PurchaseID DESC LIMIT 1').PurchaseID;
console.log('  supplier owed:',S().supp,'(invoice total 270)');

// Return 19 to supplier at the INVOICE price (12), not the landed cost
const before=S();
r=await call('purchaseReturns:create',{PurchaseID:pid,
  items:[{ItemID:1,Quantity:19,UnitCost:12}],AccountCredit:228,CashRefund:0});
console.log('\nreturn 19 @12 =228:',r.success,r.message||'');
const after=S();
console.log('  before:',JSON.stringify(before));
console.log('  after :',JSON.stringify(after));
console.log();
console.log('  stock value fell by', r2(before.value-after.value));
console.log('  supplier debt fell by', r2(before.supp-after.supp));
console.log('  DRIFT =', r2((before.value-after.value)-(before.supp-after.supp)));
console.log();
console.log('  >>> goods left at LANDED cost 13.50 x19 = 256.50');
console.log('  >>> but only 228 of debt was cancelled (invoice price 12)');
console.log('  >>> the 1.50/unit of shipping on returned goods vanished:', r2(19*1.5));
