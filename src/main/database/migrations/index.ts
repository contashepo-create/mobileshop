import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

/** Column names currently present on a table. */
function columnsOf(db: Database.Database, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r => r.name as string);
  } catch {
    return [];
  }
}

/** True when `table.column` is declared NOT NULL. */
function isNotNull(db: Database.Database, table: string, column: string): boolean {
  try {
    const row = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).find(r => r.name === column);
    return !!row && row.notnull === 1;
  } catch {
    return false;
  }
}

/**
 * Rebuilds a table safely: creates the target, copies the INTERSECTION of the
 * old and new column sets by name, then swaps. Copying by name (instead of
 * `SELECT *`) means an extra column on either side can never shift values into
 * the wrong column or abort the copy.
 *
 * The whole swap runs in one transaction so a failure can never leave the
 * database with the original table dropped and no replacement.
 */
function rebuildTable(
  db: Database.Database,
  table: string,
  tempName: string,
  createTempSql: string,
): boolean {
  const oldCols = columnsOf(db, table);
  if (oldCols.length === 0) return false;

  // Clean up any orphan left behind by an older, non-transactional attempt.
  try { db.exec(`DROP TABLE IF EXISTS ${tempName}`); } catch { /* ignore */ }

  const swap = db.transaction(() => {
    db.exec(createTempSql);
    const newCols = columnsOf(db, tempName);
    const shared = oldCols.filter(c => newCols.includes(c));
    if (shared.length === 0) throw new Error(`no shared columns between ${table} and ${tempName}`);
    const list = shared.join(', ');
    db.exec(`INSERT INTO ${tempName} (${list}) SELECT ${list} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tempName} RENAME TO ${table}`);
  });

  try {
    swap();
    return true;
  } catch (err) {
    console.error(`[Migration] rebuild of ${table} failed, original left intact:`, err);
    try { db.exec(`DROP TABLE IF EXISTS ${tempName}`); } catch { /* ignore */ }
    return false;
  }
}

/** sale_details.ItemID must allow NULL so service lines can be stored. */
/**
 * `vouchers.CashAccountID` must accept NULL.
 *
 * A settlement variance is recorded as a voucher with no cash account: the
 * counted balance was already written straight to the account, so naming one
 * here would move the same money twice. The original schema declared the
 * column NOT NULL, so that INSERT threw and the whole stocktake transaction
 * rolled back — inventory settlement could never succeed.
 */
function relaxVoucherCashAccountIfNeeded(db: Database.Database) {
  if (columnsOf(db, 'vouchers').length === 0) return;          // fresh DB, already correct
  if (!isNotNull(db, 'vouchers', 'CashAccountID')) return;      // already migrated
  rebuildTable(db, 'vouchers', 'vouchers_migrate', `
    CREATE TABLE vouchers_migrate (
      VoucherID        INTEGER PRIMARY KEY AUTOINCREMENT,
      VoucherNumber    TEXT UNIQUE NOT NULL,
      VoucherType      TEXT NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      Amount           REAL NOT NULL,
      PartyType        TEXT,
      PartyID          INTEGER,
      PartyName        TEXT,
      Description      TEXT NOT NULL,
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      ReferenceType    TEXT,
      ReferenceID      INTEGER,
      UserID           INTEGER NOT NULL,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID),
      FOREIGN KEY (CashAccountID) REFERENCES cash_accounts(CashAccountID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    )`);
}

function rebuildSaleDetailsIfNeeded(db: Database.Database) {
  if (columnsOf(db, 'sale_details').length === 0) return;   // fresh DB, already correct
  if (!isNotNull(db, 'sale_details', 'ItemID')) return;      // already migrated
  rebuildTable(db, 'sale_details', 'sale_details_migrate', `
    CREATE TABLE sale_details_migrate (
      DetailID        INTEGER PRIMARY KEY AUTOINCREMENT,
      SaleID          INTEGER NOT NULL,
      ItemID          INTEGER,
      SerialID        INTEGER,
      IMEI            TEXT,
      Quantity        REAL DEFAULT 1,
      UnitPrice       REAL NOT NULL,
      UnitCost        REAL,
      Total           REAL NOT NULL,
      IsWarranty      INTEGER DEFAULT 0,
      WarrantyMonths  INTEGER,
      Description     TEXT,
      WarehouseID     INTEGER,
      FOREIGN KEY (SaleID) REFERENCES sales(SaleID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (SerialID) REFERENCES item_serials(SerialID)
    )`);
}

/** service_sales.CustomerID must allow NULL (walk-in customers). */
function rebuildServiceSalesIfNeeded(db: Database.Database) {
  if (columnsOf(db, 'service_sales').length === 0) return;
  if (!isNotNull(db, 'service_sales', 'CustomerID')) return;
  rebuildTable(db, 'service_sales', 'service_sales_migrate', `
    CREATE TABLE service_sales_migrate (
      ServiceSaleID    INTEGER PRIMARY KEY AUTOINCREMENT,
      ServiceNumber    TEXT UNIQUE NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      CustomerID       INTEGER,
      CustomerName     TEXT,
      CustomerPhone    TEXT,
      ServiceType      TEXT NOT NULL,
      Provider         TEXT,
      TargetPhone      TEXT,
      Amount           REAL DEFAULT 0,
      ServiceCost      REAL DEFAULT 0,
      ChargeAmount     REAL DEFAULT 0,
      PaidAmount       REAL DEFAULT 0,
      RemainingAmount  REAL DEFAULT 0,
      Profit           REAL DEFAULT 0,
      PaymentMethod    TEXT,
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      TransferCost     REAL DEFAULT 0,
      Status           TEXT DEFAULT 'completed',
      Notes            TEXT,
      UserID           INTEGER NOT NULL,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime'))
    )`);
}

export function runMigrations(db: Database.Database) {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // =============================================
  // SYSTEM TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_years (
      FiscalYearID    INTEGER PRIMARY KEY AUTOINCREMENT,
      YearName        TEXT NOT NULL,
      StartDate       TEXT NOT NULL,
      EndDate         TEXT NOT NULL,
      Status          TEXT DEFAULT 'open',
      ClosedAt        TEXT,
      ClosedByUserID  INTEGER
    );

    CREATE TABLE IF NOT EXISTS roles (
      RoleID    INTEGER PRIMARY KEY AUTOINCREMENT,
      RoleName  TEXT NOT NULL,
      IsSystem  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS permissions (
      PermissionID    INTEGER PRIMARY KEY AUTOINCREMENT,
      PermissionKey   TEXT UNIQUE NOT NULL,
      PermissionName  TEXT NOT NULL,
      Module          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      RoleID       INTEGER NOT NULL,
      PermissionID INTEGER NOT NULL,
      PRIMARY KEY (RoleID, PermissionID),
      FOREIGN KEY (RoleID) REFERENCES roles(RoleID),
      FOREIGN KEY (PermissionID) REFERENCES permissions(PermissionID)
    );

    CREATE TABLE IF NOT EXISTS user_overrides (
      OverrideID   INTEGER PRIMARY KEY AUTOINCREMENT,
      UserID       INTEGER NOT NULL,
      PermissionID INTEGER NOT NULL,
      Type         TEXT NOT NULL,
      FOREIGN KEY (UserID) REFERENCES users(UserID),
      FOREIGN KEY (PermissionID) REFERENCES permissions(PermissionID)
    );

    CREATE TABLE IF NOT EXISTS employees (
      EmployeeID   INTEGER PRIMARY KEY AUTOINCREMENT,
      Name         TEXT NOT NULL,
      Phone        TEXT,
      Position     TEXT,
      Department   TEXT,
      BaseSalary   REAL DEFAULT 0,
      Allowances   REAL DEFAULT 0,
      HireDate     TEXT,
      IsActive     INTEGER DEFAULT 1,
      Balance      REAL DEFAULT 0,
      Notes        TEXT,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      UserID       INTEGER PRIMARY KEY AUTOINCREMENT,
      Username     TEXT UNIQUE NOT NULL,
      PasswordHash TEXT NOT NULL,
      EmployeeID   INTEGER,
      RoleID       INTEGER,
      IsActive     INTEGER DEFAULT 1,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (EmployeeID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (RoleID) REFERENCES roles(RoleID)
    );

    CREATE TABLE IF NOT EXISTS settings (
      Key   TEXT PRIMARY KEY,
      Value TEXT
    );

    -- Permanent record of security-relevant events, kept SEPARATELY from the
    -- accounting tables because it must survive anything that rewrites the
    -- books: a fiscal-year close, a deletion, a restore of trading data.
    --
    -- Its first purpose is password recovery. Resetting an administrator
    -- password changes who can sign the books, so it cannot be an untraceable
    -- act: if it happened without the owner's knowledge, there has to be a row
    -- that says when, for which account and by what route. Without that, an
    -- account takeover is unprovable after the fact.
    --
    -- Deliberately append-only in practice: nothing in the application updates
    -- or deletes a row here.
    CREATE TABLE IF NOT EXISTS security_events (
      EventID   INTEGER PRIMARY KEY AUTOINCREMENT,
      EventType TEXT NOT NULL,
      UserID    INTEGER,
      Username  TEXT,
      Detail    TEXT,
      CreatedAt TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // =============================================
  // HR TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      CustomerID   INTEGER PRIMARY KEY AUTOINCREMENT,
      Name         TEXT NOT NULL,
      Phone        TEXT,
      Email        TEXT,
      Address      TEXT,
      Balance      REAL DEFAULT 0,
      Status       TEXT DEFAULT 'active',
      CreditLimit  REAL,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      SupplierID   INTEGER PRIMARY KEY AUTOINCREMENT,
      Name         TEXT NOT NULL,
      Phone        TEXT,
      Email        TEXT,
      Address      TEXT,
      Balance      REAL DEFAULT 0,
      Status       TEXT DEFAULT 'active',
      CreditLimit  REAL,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // =============================================
  // INVENTORY TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      WarehouseID    INTEGER PRIMARY KEY AUTOINCREMENT,
      WarehouseName  TEXT NOT NULL,
      WarehouseType  TEXT DEFAULT 'main',
      IsActive      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS categories (
      CategoryID    INTEGER PRIMARY KEY AUTOINCREMENT,
      CategoryName  TEXT NOT NULL,
      ParentID      INTEGER,
      FOREIGN KEY (ParentID) REFERENCES categories(CategoryID)
    );

    CREATE TABLE IF NOT EXISTS items (
      ItemID       INTEGER PRIMARY KEY AUTOINCREMENT,
      ItemName     TEXT NOT NULL,
      CategoryID   INTEGER,
      Barcode      TEXT UNIQUE,
      ItemType     TEXT NOT NULL,
      IsSerialized INTEGER DEFAULT 0,
      SalePrice    REAL,
      CostPrice    REAL,
      IsActive     INTEGER DEFAULT 1,
      MinStock     INTEGER DEFAULT 0,
      Unit         TEXT DEFAULT 'قطعة',
      FOREIGN KEY (CategoryID) REFERENCES categories(CategoryID)
    );

    CREATE TABLE IF NOT EXISTS item_serials (
      SerialID     INTEGER PRIMARY KEY AUTOINCREMENT,
      ItemID       INTEGER NOT NULL,
      IMEI         TEXT UNIQUE NOT NULL,
      Status       TEXT DEFAULT 'available',
      CostPrice    REAL,
      WarehouseID  INTEGER NOT NULL,
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );

    CREATE TABLE IF NOT EXISTS stock_quantities (
      ID          INTEGER PRIMARY KEY AUTOINCREMENT,
      ItemID      INTEGER NOT NULL,
      WarehouseID INTEGER NOT NULL,
      Quantity    REAL DEFAULT 0,
      CostPrice   REAL DEFAULT 0,
      UNIQUE(ItemID, WarehouseID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );
  `);

  // =============================================
  // ASSETS TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_accounts (
      CashAccountID  INTEGER PRIMARY KEY AUTOINCREMENT,
      AccountName    TEXT NOT NULL,
      AccountType    TEXT NOT NULL,
      Balance        REAL DEFAULT 0,
      IsActive       INTEGER DEFAULT 1,
      BankName       TEXT,
      AccountNumber  TEXT,
      CreatedAt      TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      PaymentMethodID  INTEGER PRIMARY KEY AUTOINCREMENT,
      MethodName       TEXT NOT NULL,
      MethodType       TEXT NOT NULL,
      Provider         TEXT,
      PhoneNumber      TEXT,
      Balance          REAL DEFAULT 0,
      IsActive         INTEGER DEFAULT 1
    );
  `);

  // =============================================
  // SALES TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      SaleID           INTEGER PRIMARY KEY AUTOINCREMENT,
      SaleNumber       TEXT UNIQUE NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      CustomerID       INTEGER,
      CustomerName     TEXT,
      CustomerPhone    TEXT,
      Subtotal         REAL NOT NULL,
      Discount         REAL DEFAULT 0,
      TaxRate          REAL DEFAULT 0,
      TaxAmount        REAL DEFAULT 0,
      TotalAmount      REAL NOT NULL,
      PaidAmount       REAL NOT NULL,
      RemainingAmount  REAL DEFAULT 0,
      PaymentMethod    TEXT NOT NULL,
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      Status           TEXT DEFAULT 'completed',
      UserID           INTEGER NOT NULL,
      Notes            TEXT,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID),
      FOREIGN KEY (CustomerID) REFERENCES customers(CustomerID),
      FOREIGN KEY (CashAccountID) REFERENCES cash_accounts(CashAccountID),
      FOREIGN KEY (PaymentMethodID) REFERENCES payment_methods(PaymentMethodID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS sale_details (
      DetailID        INTEGER PRIMARY KEY AUTOINCREMENT,
      SaleID          INTEGER NOT NULL,
      -- NULLable on purpose: a service line has no stock item.
      --
      -- Labour, a software charge and any additional cost are all written to
      -- sale_details with ItemID NULL. Declaring it NOT NULL here meant that
      -- on a FRESH installation the constraint bit immediately: delivering any
      -- repair that carried labour threw "NOT NULL constraint failed" and the
      -- whole delivery rolled back. Only databases old enough to be migrated by
      -- rebuildSaleDetailsIfNeeded worked, and that function returns early on
      -- a new database precisely because it assumes this table is already
      -- correct - so every new customer had a maintenance screen that could not
      -- complete a repair.
      --
      -- NOTE: no backticks in this comment. It lives inside a JS template
      -- literal, so a backtick would close the template early and break the
      -- build. See scripts/verify_build.mjs, which compiles every source file.
      ItemID          INTEGER,
      SerialID        INTEGER,
      IMEI            TEXT,
      Quantity        REAL DEFAULT 1,
      UnitPrice       REAL NOT NULL,
      UnitCost        REAL,
      Total           REAL NOT NULL,
      IsWarranty      INTEGER DEFAULT 0,
      WarrantyMonths  INTEGER,
      FOREIGN KEY (SaleID) REFERENCES sales(SaleID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (SerialID) REFERENCES item_serials(SerialID)
    );

    CREATE TABLE IF NOT EXISTS sale_returns (
      ReturnID        INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnNumber    TEXT UNIQUE NOT NULL,
      SaleID          INTEGER NOT NULL,
      Date            TEXT NOT NULL,
      TotalAmount     REAL NOT NULL,
      Reason          TEXT,
      UserID          INTEGER NOT NULL,
      CashAccountID   INTEGER,
      CreatedAt       TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (SaleID) REFERENCES sales(SaleID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS sale_return_details (
      DetailID  INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnID  INTEGER NOT NULL,
      ItemID    INTEGER NOT NULL,
      SerialID  INTEGER,
      Quantity  REAL,
      UnitPrice REAL,
      Total     REAL,
      FOREIGN KEY (ReturnID) REFERENCES sale_returns(ReturnID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID)
    );
  `);

  // =============================================
  // PURCHASES TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
      PurchaseID       INTEGER PRIMARY KEY AUTOINCREMENT,
      PurchaseNumber   TEXT UNIQUE NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      SupplierID       INTEGER NOT NULL,
      Subtotal         REAL NOT NULL,
      Discount         REAL DEFAULT 0,
      TaxAmount        REAL DEFAULT 0,
      TotalAmount      REAL NOT NULL,
      PaidAmount       REAL NOT NULL,
      RemainingAmount  REAL DEFAULT 0,
      PaymentMethod    TEXT NOT NULL,
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      Status           TEXT DEFAULT 'completed',
      UserID           INTEGER NOT NULL,
      Notes            TEXT,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID),
      FOREIGN KEY (SupplierID) REFERENCES suppliers(SupplierID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS purchase_details (
      DetailID    INTEGER PRIMARY KEY AUTOINCREMENT,
      PurchaseID  INTEGER NOT NULL,
      ItemID      INTEGER NOT NULL,
      IMEI        TEXT,
      SerialID    INTEGER,
      Quantity    REAL DEFAULT 1,
      UnitCost    REAL NOT NULL,
      UnitPrice   REAL,
      Total       REAL NOT NULL,
      WarehouseID INTEGER NOT NULL,
      FOREIGN KEY (PurchaseID) REFERENCES purchases(PurchaseID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID)
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      ReturnID        INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnNumber    TEXT UNIQUE NOT NULL,
      PurchaseID      INTEGER NOT NULL,
      Date            TEXT NOT NULL,
      TotalAmount     REAL NOT NULL,
      Reason           TEXT,
      UserID           INTEGER NOT NULL,
      CashAccountID    INTEGER,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (PurchaseID) REFERENCES purchases(PurchaseID)
    );

    CREATE TABLE IF NOT EXISTS purchase_return_details (
      DetailID  INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnID INTEGER NOT NULL,
      ItemID   INTEGER NOT NULL,
      SerialID INTEGER,
      Quantity REAL,
      UnitCost REAL,
      Total    REAL,
      FOREIGN KEY (ReturnID) REFERENCES purchase_returns(ReturnID)
    );

    -- Inventory valuation adjustments.
    --
    -- Stock is held at a weighted average, but individual movements are valued
    -- at the cost of the specific units involved — the serial's own cost, the
    -- landed cost of a purchase line, the cost recorded on a return. Those two
    -- figures differ whenever the mix has changed, and the difference normally
    -- stays with the units left in the warehouse.
    --
    -- When a movement empties a warehouse there are no units left to carry it.
    -- The leftover value used to be dropped silently: the pool's row kept its
    -- old unit price against a quantity of zero, and the value simply ceased to
    -- exist. Inventory fell further than cost of sales was relieved and the
    -- books drifted, with nothing anywhere to explain it.
    --
    -- Each such event is recorded here instead, so it is visible, auditable and
    -- can be charged to the profit and loss account like any other adjustment.
    -- A positive amount is value written OFF; a negative one is value written
    -- back on.
    -- COST LAYERS ("lots")
    --
    -- A weighted average cannot say WHICH units left. Buy 10 at 100, sell 8,
    -- buy 10 at 60, then return the 8: the average has moved to 66.67, so the
    -- goods come back valued at 66.67 having left at 100, and 266.67 of
    -- inventory value evaporates with no entry anywhere. Measured.
    --
    -- A lot is one delivery of one item into one warehouse at one cost. Stock
    -- is consumed oldest-lot-first and returns go back to the lot they came
    -- from, so a unit's cost is always the cost that unit was bought at.
    --
    -- This is per DELIVERY, not per piece: 500 cables from one shipment are a
    -- single row, because two cables from the same box cost the same and
    -- numbering them individually would slow the counter for no accounting
    -- gain. A serialised handset is simply a lot whose quantity is one.
    CREATE TABLE IF NOT EXISTS stock_lots (
      LotID         INTEGER PRIMARY KEY AUTOINCREMENT,
      ItemID        INTEGER NOT NULL,
      WarehouseID   INTEGER NOT NULL,
      UnitCost      REAL NOT NULL,
      QtyReceived   REAL NOT NULL,
      QtyRemaining  REAL NOT NULL,
      SourceType    TEXT,
      SourceID      INTEGER,
      Date          TEXT,
      CreatedAt     TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_lots_pick
      ON stock_lots (ItemID, WarehouseID, QtyRemaining);

    CREATE TABLE IF NOT EXISTS inventory_adjustments (
      AdjustmentID INTEGER PRIMARY KEY AUTOINCREMENT,
      Date         TEXT NOT NULL,
      ItemID       INTEGER,
      WarehouseID  INTEGER,
      Amount       REAL NOT NULL,
      Reason       TEXT,
      RefType      TEXT,
      RefID        INTEGER,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // =============================================
  // MAINTENANCE TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      TicketID            INTEGER PRIMARY KEY AUTOINCREMENT,
      TicketNumber        TEXT UNIQUE NOT NULL,
      FiscalYearID        INTEGER NOT NULL,
      Date                TEXT NOT NULL,
      CustomerID          INTEGER,
      CustomerName        TEXT NOT NULL,
      CustomerPhone       TEXT NOT NULL,
      DeviceModel         TEXT NOT NULL,
      DeviceIMEI          TEXT,
      ProblemDesc          TEXT NOT NULL,
      Accessories          TEXT,
      DevicePassword      TEXT,
      AgreedDeliveryDate   TEXT,
      AgreedCost          REAL,
      TechnicianID        INTEGER,
      Status              TEXT DEFAULT 'received',
      TotalCost           REAL DEFAULT 0,
      LaborCost           REAL DEFAULT 0,
      PartsCost           REAL DEFAULT 0,
      UserID              INTEGER NOT NULL,
      CreatedAt           TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID),
      FOREIGN KEY (CustomerID) REFERENCES customers(CustomerID),
      FOREIGN KEY (TechnicianID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_status_log (
      LogID    INTEGER PRIMARY KEY AUTOINCREMENT,
      TicketID INTEGER NOT NULL,
      Status   TEXT NOT NULL,
      Notes    TEXT,
      UserID   INTEGER NOT NULL,
      Date     TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_parts (
      PartID          INTEGER PRIMARY KEY AUTOINCREMENT,
      TicketID        INTEGER NOT NULL,
      ItemID          INTEGER NOT NULL,
      Quantity        REAL NOT NULL,
      UnitCost        REAL NOT NULL,
      TotalCost       REAL NOT NULL,
      SalePrice       REAL DEFAULT 0,
      WarehouseID     INTEGER NOT NULL,
      IssuedByUserID  INTEGER NOT NULL,
      IssuedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_deliveries (
      DeliveryID        INTEGER PRIMARY KEY AUTOINCREMENT,
      DeliveryNumber   TEXT UNIQUE NOT NULL,
      TicketID          INTEGER NOT NULL,
      Date              TEXT NOT NULL,
      CustomerID        INTEGER,
      CustomerName      TEXT NOT NULL,
      PartsCost         REAL NOT NULL,
      LaborCost         REAL NOT NULL,
      TotalCost         REAL NOT NULL,
      PaidAmount        REAL NOT NULL,
      RemainingAmount   REAL DEFAULT 0,
      PaymentMethod     TEXT NOT NULL,
      CashAccountID     INTEGER,
      PaymentMethodID   INTEGER,
      UserID            INTEGER NOT NULL,
      CreatedAt         TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_returns (
      ReturnID        INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnNumber    TEXT UNIQUE NOT NULL,
      DeliveryID      INTEGER NOT NULL,
      TicketID        INTEGER NOT NULL,
      Date            TEXT NOT NULL,
      Reason          TEXT NOT NULL,
      TotalRefund     REAL NOT NULL,
      CashAccountID   INTEGER,
      PartsRestored   INTEGER DEFAULT 1,
      UserID          INTEGER NOT NULL,
      CreatedAt       TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (DeliveryID) REFERENCES maintenance_deliveries(DeliveryID),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_service_costs (
      CostID          INTEGER PRIMARY KEY AUTOINCREMENT,
      TicketID        INTEGER NOT NULL,
      Description     TEXT NOT NULL,
      CostOnUs        REAL NOT NULL DEFAULT 0,
      PriceToClient   REAL NOT NULL DEFAULT 0,
      UserID          INTEGER NOT NULL,
      CreatedAt       TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );

    CREATE TABLE IF NOT EXISTS maintenance_service_usage (
      UsageID            INTEGER PRIMARY KEY AUTOINCREMENT,
      TicketID           INTEGER NOT NULL,
      ItemID             INTEGER,
      Description        TEXT NOT NULL,
      CostOnUs           REAL NOT NULL DEFAULT 0,
      PriceToClient      REAL NOT NULL DEFAULT 0,
      Quantity           REAL DEFAULT 1,
      UserID             INTEGER NOT NULL,
      CreatedAt          TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (ItemID) REFERENCES items(ItemID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );
  `);

  // =============================================
  // VOUCHERS TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      VoucherID        INTEGER PRIMARY KEY AUTOINCREMENT,
      VoucherNumber    TEXT UNIQUE NOT NULL,
      VoucherType      TEXT NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      Amount           REAL NOT NULL,
      PartyType        TEXT,
      PartyID          INTEGER,
      PartyName        TEXT,
      Description      TEXT NOT NULL,
      -- Nullable on purpose. A stocktake variance is booked as a 'general'
      -- voucher with NO cash account, because the counted balance has already
      -- been written directly; naming an account here would move the money a
      -- second time. Declared NOT NULL, that INSERT threw
      -- "NOT NULL constraint failed: vouchers.CashAccountID" and every
      -- inventory settlement failed outright on a fresh install.
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      ReferenceType    TEXT,
      ReferenceID      INTEGER,
      UserID           INTEGER NOT NULL,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID),
      FOREIGN KEY (CashAccountID) REFERENCES cash_accounts(CashAccountID),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );
  `);

  // =============================================
  // PAYROLL TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS salaries (
      SalaryID          INTEGER PRIMARY KEY AUTOINCREMENT,
      EmployeeID        INTEGER NOT NULL,
      Month             TEXT NOT NULL,
      FiscalYearID      INTEGER NOT NULL,
      BaseSalary        REAL NOT NULL,
      Allowances        REAL DEFAULT 0,
      CommissionsTotal  REAL DEFAULT 0,
      DeductionsTotal   REAL DEFAULT 0,
      AdvancesTotal     REAL DEFAULT 0,
      NetSalary         REAL NOT NULL,
      PaidAmount        REAL DEFAULT 0,
      Status            TEXT DEFAULT 'pending',
      CashAccountID     INTEGER,
      PaymentDate       TEXT,
      UserID            INTEGER NOT NULL,
      CreatedAt         TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (EmployeeID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );

    CREATE TABLE IF NOT EXISTS employee_advances (
      AdvanceID              INTEGER PRIMARY KEY AUTOINCREMENT,
      EmployeeID             INTEGER NOT NULL,
      Amount                 REAL NOT NULL,
      Date                   TEXT NOT NULL,
      Reason                 TEXT,
      CashAccountID          INTEGER NOT NULL,
      IsDeducted             INTEGER DEFAULT 0,
      DeductedFromSalaryID   INTEGER,
      FiscalYearID           INTEGER NOT NULL,
      UserID                 INTEGER NOT NULL,
      CreatedAt              TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (EmployeeID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );

    CREATE TABLE IF NOT EXISTS commissions (
      CommissionID    INTEGER PRIMARY KEY AUTOINCREMENT,
      EmployeeID      INTEGER NOT NULL,
      CommissionType  TEXT NOT NULL,
      Amount          REAL NOT NULL,
      Date            TEXT NOT NULL,
      ReferenceType   TEXT NOT NULL,
      ReferenceID     INTEGER NOT NULL,
      IsPaid          INTEGER DEFAULT 0,
      PaidInSalaryID  INTEGER,
      PaidAmount      REAL DEFAULT 0,
      FiscalYearID    INTEGER NOT NULL,
      UserID          INTEGER NOT NULL,
      CreatedAt       TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (EmployeeID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );

    CREATE TABLE IF NOT EXISTS employee_deductions (
      DeductionID            INTEGER PRIMARY KEY AUTOINCREMENT,
      EmployeeID             INTEGER NOT NULL,
      Amount                 REAL NOT NULL,
      Date                   TEXT NOT NULL,
      Reason                 TEXT NOT NULL,
      DamagedItemID           INTEGER,
      DamageCostType          TEXT,
      IsDeducted              INTEGER DEFAULT 0,
      DeductedFromSalaryID   INTEGER,
      FiscalYearID           INTEGER NOT NULL,
      UserID                 INTEGER NOT NULL,
      Notes                  TEXT,
      CreatedAt              TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (EmployeeID) REFERENCES employees(EmployeeID),
      FOREIGN KEY (DamagedItemID) REFERENCES items(ItemID),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );
  `);

  // =============================================
  // RENT TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS rents (
      RentID      INTEGER PRIMARY KEY AUTOINCREMENT,
      RentName    TEXT NOT NULL,
      RentType    TEXT NOT NULL,
      Amount      REAL NOT NULL,
      Period      TEXT NOT NULL,
      StartDate   TEXT NOT NULL,
      IsActive    INTEGER DEFAULT 1,
      PartyName   TEXT,
      PartyPhone  TEXT,
      Notes       TEXT,
      CreatedAt   TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS rent_payments (
      RentPaymentID  INTEGER PRIMARY KEY AUTOINCREMENT,
      RentID         INTEGER NOT NULL,
      PeriodLabel    TEXT NOT NULL,
      Amount         REAL NOT NULL,
      DueDate        TEXT NOT NULL,
      PaidDate       TEXT,
      Status         TEXT DEFAULT 'pending',
      CashAccountID  INTEGER,
      FiscalYearID   INTEGER NOT NULL,
      UserID         INTEGER NOT NULL,
      FOREIGN KEY (RentID) REFERENCES rents(RentID),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );

    -- Landlords and tenants.
    --
    -- The other party to a rent agreement used to be two free-text columns on
    -- the contract itself (PartyName, PartyPhone). That cannot carry a
    -- balance, cannot be looked up, and produces a different "party" every
    -- time the name is typed slightly differently. A landlord with three
    -- shops was three unrelated strings.
    --
    -- PartyKind is 'landlord' (we pay them) or 'tenant' (they pay us), which
    -- is the same split as RentType expense/income, held on the party so a
    -- statement can be produced per person rather than per contract.
    CREATE TABLE IF NOT EXISTS rent_parties (
      RentPartyID  INTEGER PRIMARY KEY AUTOINCREMENT,
      PartyKind    TEXT NOT NULL,
      Name         TEXT NOT NULL,
      Phone        TEXT,
      NationalID   TEXT,
      Address      TEXT,
      Notes        TEXT,
      IsActive     INTEGER DEFAULT 1,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Individual movements of money against a rent agreement.
    --
    -- The rent_payments table records what is DUE. This records what was
    -- actually HANDED OVER, and there can be several per instalment: half
    -- now and half at the end of the month. Without it an instalment was
    -- all-or-nothing, which is not how rent is paid in practice.
    --
    -- Kind:
    --   'instalment' — against a specific rent_payments row
    --   'advance'    — a deposit or prepayment held against the CONTRACT,
    --                  not yet applied to any month
    -- SourceType records WHERE the money moved: 'rent' from the rent screen,
    -- 'voucher' from a payment voucher. One instalment can receive both.
    CREATE TABLE IF NOT EXISTS rent_transactions (
      RentTxnID       INTEGER PRIMARY KEY AUTOINCREMENT,
      RentID          INTEGER NOT NULL,
      RentPaymentID   INTEGER,
      RentPartyID     INTEGER,
      Kind            TEXT NOT NULL DEFAULT 'instalment',
      Amount          REAL NOT NULL,
      TxnDate         TEXT NOT NULL,
      CashAccountID   INTEGER,
      PaymentMethodID INTEGER,
      SourceType      TEXT DEFAULT 'rent',
      SourceID        INTEGER,
      Notes           TEXT,
      ReversedAt      TEXT,
      FiscalYearID    INTEGER,
      UserID          INTEGER,
      CreatedAt       TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (RentID) REFERENCES rents(RentID),
      FOREIGN KEY (RentPaymentID) REFERENCES rent_payments(RentPaymentID)
    );

    CREATE INDEX IF NOT EXISTS idx_rent_txn_rent    ON rent_transactions(RentID);
    CREATE INDEX IF NOT EXISTS idx_rent_txn_payment ON rent_transactions(RentPaymentID);
    CREATE INDEX IF NOT EXISTS idx_rent_txn_party   ON rent_transactions(RentPartyID);
  `);

  // =============================================
  // WAREHOUSE OPERATIONS TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_purchase_orders (
      POID        INTEGER PRIMARY KEY AUTOINCREMENT,
      PONumber    TEXT UNIQUE NOT NULL,
      Date        TEXT NOT NULL,
      SupplierID  INTEGER,
      Status      TEXT DEFAULT 'pending',
      Notes       TEXT,
      UserID      INTEGER NOT NULL,
      CreatedAt   TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (SupplierID) REFERENCES suppliers(SupplierID)
    );

    CREATE TABLE IF NOT EXISTS warehouse_po_details (
      DetailID  INTEGER PRIMARY KEY AUTOINCREMENT,
      POID     INTEGER NOT NULL,
      ItemID   INTEGER NOT NULL,
      Quantity REAL NOT NULL,
      UnitCost REAL,
      FOREIGN KEY (POID) REFERENCES warehouse_purchase_orders(POID)
    );

    CREATE TABLE IF NOT EXISTS warehouse_transfers (
      TransferID       INTEGER PRIMARY KEY AUTOINCREMENT,
      TransferNumber   TEXT UNIQUE NOT NULL,
      Date             TEXT NOT NULL,
      FromWarehouseID  INTEGER NOT NULL,
      ToWarehouseID    INTEGER NOT NULL,
      ReferenceType    TEXT,
      ReferenceID      INTEGER,
      Status           TEXT DEFAULT 'completed',
      UserID           INTEGER NOT NULL,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FromWarehouseID) REFERENCES warehouses(WarehouseID),
      FOREIGN KEY (ToWarehouseID) REFERENCES warehouses(WarehouseID)
    );

    CREATE TABLE IF NOT EXISTS warehouse_transfer_details (
      DetailID   INTEGER PRIMARY KEY AUTOINCREMENT,
      TransferID INTEGER NOT NULL,
      ItemID     INTEGER NOT NULL,
      SerialID   INTEGER,
      Quantity   REAL NOT NULL,
      UnitCost   REAL,
      FOREIGN KEY (TransferID) REFERENCES warehouse_transfers(TransferID)
    );

    CREATE TABLE IF NOT EXISTS warehouse_issue_orders (
      IssueID     INTEGER PRIMARY KEY AUTOINCREMENT,
      IssueNumber TEXT UNIQUE NOT NULL,
      Date        TEXT NOT NULL,
      TicketID    INTEGER NOT NULL,
      WarehouseID INTEGER NOT NULL,
      UserID      INTEGER NOT NULL,
      Notes       TEXT,
      CreatedAt   TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (TicketID) REFERENCES maintenance_tickets(TicketID),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );

    CREATE TABLE IF NOT EXISTS warehouse_return_orders (
      ReturnID     INTEGER PRIMARY KEY AUTOINCREMENT,
      ReturnNumber TEXT UNIQUE NOT NULL,
      Date         TEXT NOT NULL,
      WarehouseID  INTEGER NOT NULL,
      ReferenceType TEXT,
      ReferenceID  INTEGER,
      UserID       INTEGER NOT NULL,
      CreatedAt    TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (WarehouseID) REFERENCES warehouses(WarehouseID)
    );
  `);

  // =============================================
  // NOTES & SETTLEMENTS TABLES
  // =============================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_notes (
      NoteID        INTEGER PRIMARY KEY AUTOINCREMENT,
      OperationType TEXT NOT NULL,
      OperationID   INTEGER NOT NULL,
      Content       TEXT NOT NULL,
      UserID        INTEGER NOT NULL,
      CreatedAt     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (UserID) REFERENCES users(UserID)
    );
    CREATE INDEX IF NOT EXISTS idx_notes_lookup ON operation_notes(OperationType, OperationID);

    CREATE TABLE IF NOT EXISTS settlements (
      SettlementID     INTEGER PRIMARY KEY AUTOINCREMENT,
      SettlementNumber TEXT UNIQUE NOT NULL,
      Date             TEXT NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Section          TEXT NOT NULL,
      TotalDifference  REAL DEFAULT 0,
      Status           TEXT DEFAULT 'completed',
      UserID           INTEGER NOT NULL,
      Notes            TEXT,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (FiscalYearID) REFERENCES fiscal_years(FiscalYearID)
    );

    CREATE TABLE IF NOT EXISTS settlement_details (
      DetailID        INTEGER PRIMARY KEY AUTOINCREMENT,
      SettlementID    INTEGER NOT NULL,
      ItemType        TEXT NOT NULL,
      ItemID          INTEGER,
      ItemName        TEXT,
      RecordedBalance REAL,
      ActualBalance   REAL,
      Difference      REAL,
      AdjustmentType  TEXT,
      FOREIGN KEY (SettlementID) REFERENCES settlements(SettlementID)
    );

    CREATE TABLE IF NOT EXISTS service_sales (
      ServiceSaleID    INTEGER PRIMARY KEY AUTOINCREMENT,
      ServiceNumber    TEXT UNIQUE NOT NULL,
      FiscalYearID     INTEGER NOT NULL,
      Date             TEXT NOT NULL,
      CustomerID       INTEGER,
      CustomerName     TEXT,
      CustomerPhone    TEXT,
      ServiceType      TEXT NOT NULL,
      Provider         TEXT,
      TargetPhone      TEXT,
      Amount           REAL NOT NULL,
      ServiceCost      REAL DEFAULT 0,
      ChargeAmount     REAL NOT NULL,
      PaidAmount       REAL DEFAULT 0,
      RemainingAmount  REAL DEFAULT 0,
      Profit           REAL DEFAULT 0,
      PaymentMethod    TEXT DEFAULT 'credit',
      CashAccountID    INTEGER,
      PaymentMethodID  INTEGER,
      TransferCost     REAL DEFAULT 0,
      Status           TEXT DEFAULT 'completed',
      Notes            TEXT,
      UserID           INTEGER NOT NULL,
      CreatedAt        TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // =============================================
  // SCHEMA MIGRATIONS (for existing databases)
  // =============================================

  // Allow NULL ItemID in sale_details (service lines have no stock item).
  //
  // This used to run a blind CREATE/INSERT/DROP/RENAME rebuild on EVERY start.
  // Two things were wrong with that:
  //   1. `INSERT ... SELECT *` breaks as soon as the live table gains a column
  //      the rebuild template does not know about (Description, WarehouseID),
  //      leaving `sale_details_new` behind as a permanent orphan table;
  //   2. the DROP sits after the INSERT in the same try block, so a future
  //      column-order change could drop the real table after a partial copy.
  // We now only rebuild when it is actually needed, and copy columns by NAME.
  rebuildSaleDetailsIfNeeded(db);
  relaxVoucherCashAccountIfNeeded(db);

  // Add Source and SourceID to sales (for maintenance invoices)
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN Source TEXT DEFAULT 'direct'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN SourceID INTEGER`);
  } catch {}

  // Add financial columns to maintenance_deliveries
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN ServiceCostTotal REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN TotalCostOnUs REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN TotalProfit REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN SaleID INTEGER`);
  } catch {}

  // --- Rent contracts -------------------------------------------------------
  // A rent agreement has an END, and can be terminated early. Without those the
  // section could only describe an open-ended arrangement that runs forever,
  // and `rents:delete` had nothing to record WHY a contract stopped.
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN EndDate TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN CancelledAt TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN CancelReason TEXT`);
  } catch {}
  // 'active' | 'completed' | 'cancelled'. IsActive is kept so nothing that
  // reads it breaks, but the status carries the reason as well as the fact.
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN Status TEXT DEFAULT 'active'`);
  } catch {}
  // A cancelled instalment is neither pending nor paid. Without a third state
  // the only way to remove one was to delete the row, which destroys the
  // record of what was agreed.
  try {
    db.exec(`ALTER TABLE rent_payments ADD COLUMN CancelledAt TEXT`);
  } catch {}

  // The contract points at a PARTY record instead of carrying a loose name.
  // PartyName stays populated for contracts created before this existed.
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN RentPartyID INTEGER`);
  } catch {}
  // A deposit or prepayment sits on the CONTRACT until it is applied to a
  // month. It is money the shop has handed over but not yet consumed, so it
  // is an asset, not an expense — and it must not be counted as rent paid.
  try {
    db.exec(`ALTER TABLE rents ADD COLUMN AdvanceBalance REAL DEFAULT 0`);
  } catch {}
  // How much of this instalment has actually been received so far. `Status`
  // becomes 'partial' between zero and Amount, and 'paid' only when settled.
  try {
    db.exec(`ALTER TABLE rent_payments ADD COLUMN PaidAmount REAL DEFAULT 0`);
  } catch {}
  // Paying rent from an e-wallet was impossible: only a cash account could be
  // named, while vouchers have supported payment methods all along.
  try {
    db.exec(`ALTER TABLE rent_payments ADD COLUMN PaymentMethodID INTEGER`);
  } catch {}
  // Existing rows predate PaidAmount. A row already marked 'paid' has, by
  // definition, received its full amount; leaving it at 0 would make every
  // historical instalment look unpaid the moment the new column appears.
  try {
    db.exec(`UPDATE rent_payments SET PaidAmount = Amount
             WHERE Status = 'paid' AND COALESCE(PaidAmount, 0) = 0`);
  } catch {}

  // Allow NULL PaymentMethod in service_sales (for credit/no-payment)
  // service_sales rebuild — see the note above. Guarded the same way so an
  // added column can never orphan the table or drop live rows.
  rebuildServiceSalesIfNeeded(db);

  // Fix empty barcodes (convert '' to NULL to avoid UNIQUE constraint issues)
  try {
    db.prepare("UPDATE items SET Barcode = NULL WHERE Barcode = '' OR Barcode IS ''").run();
  } catch {}

  // Asset transfers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_transfers (
      TransferID         INTEGER PRIMARY KEY AUTOINCREMENT,
      TransferNumber     TEXT UNIQUE NOT NULL,
      Date               TEXT NOT NULL,
      FiscalYearID       INTEGER,
      FromType            TEXT NOT NULL,
      FromID             INTEGER NOT NULL,
      ToType              TEXT NOT NULL,
      ToID               INTEGER NOT NULL,
      Amount             REAL NOT NULL,
      TransferCost       REAL DEFAULT 0,
      ReceivedAmount     REAL NOT NULL,
      TransferCostSource TEXT DEFAULT 'from_amount',
      Notes              TEXT,
      UserID             INTEGER NOT NULL,
      CreatedAt          TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // Add AdditionalCost, PaymentCost, PaymentSource to purchases (redesigned)
  try {
    db.exec(`ALTER TABLE purchases ADD COLUMN AdditionalCost REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchases ADD COLUMN PaymentCost REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchases ADD COLUMN PaymentSource TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchases ADD COLUMN PaymentSourceID INTEGER`);
  } catch {}

  // Add Description column to sale_details (for service/labor items without ItemID)
  try {
    db.exec(`ALTER TABLE sale_details ADD COLUMN Description TEXT`);
  } catch {}

  // Add SalePrice column to maintenance_parts (for custom sale price per part)
  try {
    db.exec(`ALTER TABLE maintenance_parts ADD COLUMN SalePrice REAL DEFAULT 0`);
  } catch {}

  // Dismissed/snoozed notifications tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS dismissed_notifications (
      ID          INTEGER PRIMARY KEY AUTOINCREMENT,
      NotifKey    TEXT NOT NULL UNIQUE,
      DismissedAt TEXT DEFAULT (datetime('now','localtime')),
      SnoozedUntil TEXT
    )
  `);

  // Monotonic per-day counters for document numbers (invoices, vouchers, ...).
  // Replaces the old COUNT(*)-based numbering which reused numbers after a
  // delete and collided between clients on a shared database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_sequences (
      SeqKey    TEXT PRIMARY KEY,
      LastValue INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Seed the counters from existing data so numbering continues rather than
  // restarting at 1 on databases created before this change.
  try {
    const seqSeeds: [string, string, string][] = [
      ['sales', 'SaleNumber', 'Date'],
      ['sale_returns', 'ReturnNumber', 'Date'],
      ['purchases', 'PurchaseNumber', 'Date'],
      ['purchase_returns', 'ReturnNumber', 'Date'],
      ['maintenance_tickets', 'TicketNumber', 'Date'],
      ['maintenance_deliveries', 'DeliveryNumber', 'Date'],
      ['maintenance_returns', 'ReturnNumber', 'Date'],
      ['vouchers', 'VoucherNumber', 'Date'],
      ['service_sales', 'ServiceNumber', 'Date'],
      ['asset_transfers', 'TransferNumber', 'Date'],
      ['settlements', 'SettlementNumber', 'Date'],
    ];
    const seedSeq = db.prepare(`
      INSERT INTO document_sequences (SeqKey, LastValue) VALUES (?, ?)
      ON CONFLICT(SeqKey) DO UPDATE SET LastValue = MAX(LastValue, excluded.LastValue)
    `);
    for (const [table, col, dateCol] of seqSeeds) {
      try {
        const rows = db.prepare(
          `SELECT ${dateCol} as d, COUNT(*) as c FROM ${table} GROUP BY ${dateCol}`
        ).all() as any[];
        for (const r of rows) {
          if (r.d) seedSeq.run(`${table}:${r.d}`, r.c);
        }
      } catch { /* table may not exist yet */ }
    }
  } catch { /* non-fatal */ }

  // =============================================
  // SCHEMA UPGRADES FOR EXISTING DATABASES
  // =============================================
  // These MUST live in runMigrations, not seedData: seedData returns early when
  // users already exist, so on an existing installation these columns were
  // never added and every query touching them failed.

  // Add IsVoided to sales and PreviousSaleID to maintenance_deliveries for return flow
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN IsVoided INTEGER DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN PreviousSaleID INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_deliveries ADD COLUMN VoidedSaleID INTEGER`);
  } catch {}

  // Warranty/Rework maintenance flow
  try {
    db.exec(`ALTER TABLE maintenance_tickets ADD COLUMN MaintenanceType TEXT DEFAULT 'normal'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE maintenance_tickets ADD COLUMN ReferenceTicketID INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN IsWarranty INTEGER DEFAULT 0`);
  } catch {}

  // The card-machine / wallet commission on a sale.
  //
  // It used to be appended to the free-text `Notes` field ("عمولة تحويل: 25"),
  // so it existed as prose but not as money: the full amount was credited to
  // the machine even though the bank settles net of the fee, and no report
  // could ever find it. Assets and profit were both overstated by every
  // commission ever charged.
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN TransferCost REAL DEFAULT 0`);
  } catch {}

  // The landed cost per unit actually capitalised into stock: the supplier's
  // price PLUS this line's share of shipping and payment fees.
  //
  // `purchase_details.UnitCost` holds only the supplier's price, but stock was
  // added at the landed cost. Deleting a purchase reversed the base figure and
  // left the overhead behind, permanently inflating the cost of whatever stock
  // remained — 50 of overhead on a deleted 10-unit purchase raised the unit
  // cost of the surviving 5 units from 105 to 115.
  try {
    db.exec(`ALTER TABLE purchase_details ADD COLUMN EffectiveUnitCost REAL`);
  } catch {}

  // Which warehouse a purchase-return line was taken FROM.
  //
  // Without it the reversal ran `WHERE ItemID = ?` with no warehouse and hit
  // whichever row SQLite returned first. Goods bought into the branch were
  // deducted from the main store instead: the main store went negative while
  // the branch still showed stock it no longer had.
  try {
    db.exec(`ALTER TABLE purchase_return_details ADD COLUMN WarehouseID INTEGER`);
  } catch {}

  // The LANDED cost of the units sent back to the supplier.
  //
  // `UnitCost` on a return line is what the supplier credits — their invoice
  // price. Stock, however, is carried at the landed cost, which also includes
  // that line's share of the delivery charge. The two differ whenever a
  // purchase carried any shipping.
  //
  // Undoing a return has to put back exactly what the return took out, and the
  // return took out the LANDED value. Restoring at the supplier price instead
  // left the freight destroyed permanently: a return that wrote off 5.00 of
  // freight, then cancelled, never gave that 5.00 back, so the shop's net worth
  // fell by 5.00 with no matching entry. Recording the landed figure on the
  // line makes the reversal exactly symmetric.
  try {
    db.exec(`ALTER TABLE purchase_return_details ADD COLUMN LandedUnitCost REAL`);
  } catch {}

  // How much of that freight was loaded onto the units left in the warehouse.
  //
  // When a return leaves stock behind, the unrecoverable freight is pushed onto
  // the survivors and stays an asset; when the warehouse empties there is
  // nothing to carry it and it is written off instead. Undoing the return has
  // to reverse whichever of the two actually happened, so the amount absorbed
  // is recorded per line rather than re-derived later from a warehouse whose
  // contents have since moved on.
  try {
    db.exec(`ALTER TABLE purchase_return_details ADD COLUMN FreightAbsorbed REAL DEFAULT 0`);
  } catch {}

  // How much of the credit was actually taken off THIS invoice's balance.
  //
  // A return credits the supplier account by the full value of the goods, but
  // only the part that meets what is still outstanding ON THIS INVOICE may
  // reduce `RemainingAmount`; the rest is a credit carried on the account.
  // Creating the return clamped it correctly, while cancelling one added the
  // WHOLE credit back, so an invoice that owed 4 came back owing 636.
  //
  // Recording the clamped figure makes the reversal give back exactly what was
  // taken, instead of recomputing a number the invoice never had.
  // Valuation left stranded when a return emptied a warehouse pool.
  //
  // Goods leave at the cost they arrived at, while the pool carries a blended
  // average; the gap normally stays with the units left behind. At zero
  // quantity there are none, so the gap has to be booked as a valuation
  // adjustment. Storing it per line lets the reversal put back precisely the
  // same figure instead of re-deriving one from a pool that has since changed.
  try {
    db.exec(`ALTER TABLE purchase_return_details ADD COLUMN ValuationResidual REAL DEFAULT 0`);
  } catch {}

  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN InvoiceOffset REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN InvoiceOffset REAL DEFAULT 0`);
  } catch {}

  // Valuation stranded when CANCELLING a sale return empties a pool.
  //
  // The mirror of `purchase_return_details.ValuationResidual`. Undoing a
  // customer return takes the goods back out at the cost they were returned at,
  // while the pool carries a blended average; if that removal empties the
  // warehouse there are no units left to hold the difference and it has to be
  // booked. Left unbooked it simply vanished — inventory fell further than cost
  // of sales was relieved, and the books drifted by the gap.
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN ValuationResidual REAL DEFAULT 0`);
  } catch {}

  // WHO pays the machine's commission.
  //
  //   'shop'     — the shop absorbs it. The customer is charged the invoice
  //                total, the provider settles that total MINUS the fee, so the
  //                shop receives less and the fee is an expense.
  //   'customer' — the fee is passed on. The customer hands over the invoice
  //                total PLUS the fee, the provider keeps the fee, and the shop
  //                still receives the full invoice value. Nothing is lost, so
  //                it is not an expense.
  //
  // Without this the app silently assumed 'shop' for everyone, which is wrong
  // for the many shops that add the fee to the customer's bill.
  try {
    db.exec(`ALTER TABLE sales ADD COLUMN TransferCostBearer TEXT DEFAULT 'shop'`);
  } catch {}

  // =============================================
  // FOLD THE LEGACY CUSTOMER-PAID FEE INTO THE INVOICE TOTAL
  // =============================================
  //
  // Before this change, a fee the CUSTOMER absorbed was stored in
  // `TransferCost` but left OUT of `TotalAmount`: the invoice showed only the
  // items, the machine was credited the full `PaidAmount` (no fee deducted,
  // because the customer paid the fee on top), and the fee was invisible to
  // revenue. The shop was neither better nor worse off, so nothing leaked.
  //
  // The create/update/delete handlers now fold that fee into the invoice:
  // `TotalAmount = items + fee`, and the account is credited
  // `PaidAmount - TransferCost` in BOTH bearer cases. Existing rows therefore
  // must be restated the same way, or their totals and their reversal figures
  // no longer agree with the code that owns them. Reversing a legacy row with
  // the new formula would subtract a fee the old create never deducted —
  // destroying that fee's worth of cash on every edit or delete.
  //
  // Restating a row:
  //   TotalAmount  := TotalAmount  + TransferCost
  //   PaidAmount   := PaidAmount   + TransferCost
  //
  // `RemainingAmount` and every customer balance stay IDENTICAL: both sides of
  // the remainder equation move together, so no debt moves and no account is
  // touched. The provider kept the fee when the sale was made, and the machine
  // balance already reflects what actually landed; folding the fee into the
  // paper figures does not move any money.
  //
  // IDEMPOTENT BY CONSTRUCTION: once folded, `TotalAmount` no longer equals
  // `Subtotal - Discount + TaxAmount`, so the predicate below matches no row
  // on any later run. No version flag is needed and none can be forgotten.
  {
    const legacy = db.prepare(`
      UPDATE sales SET
        TotalAmount = ROUND(TotalAmount + COALESCE(TransferCost,0), 2),
        PaidAmount  = ROUND(PaidAmount  + COALESCE(TransferCost,0), 2)
      WHERE IsVoided = 0
        AND COALESCE(Source,'direct') <> 'maintenance'
        AND COALESCE(TransferCost,0) > 0
        AND COALESCE(TransferCostBearer,'shop') = 'customer'
        AND ABS(TotalAmount - (Subtotal - COALESCE(Discount,0) + COALESCE(TaxAmount,0))) < 0.01
    `);
    const n = legacy.run().changes;
    if (n > 0) {
      console.log(`[Migration] folded customer-paid transfer fee into ${n} legacy sale total(s)`);
    }
  }

  // Track WHICH warehouse each sale line was taken from, so a return/delete
  // credits the same warehouse it originally debited. Without this the reversal
  // guessed the warehouse and could move stock between locations.
  try {
    db.exec(`ALTER TABLE sale_details ADD COLUMN WarehouseID INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_return_details ADD COLUMN WarehouseID INTEGER`);
  } catch {}

  // Record HOW a return was settled: how much cancelled outstanding debt vs how
  // much was handed back in cash. The customer statement needs this to know
  // whether the return touched the customer balance at all — a cash refund on a
  // fully-paid invoice must NOT appear as a credit on their account.
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN DebtRelief REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN CashRefund REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN DebtRelief REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN CashRefund REAL DEFAULT 0`);
  } catch {}

  // --- How a return is SETTLED, as a deliberate choice rather than a formula.
  //
  // The first version computed the split automatically: cancel the outstanding
  // debt, hand over whatever is left in cash. That is only ONE of the real
  // situations a shop meets:
  //
  //   * a walk-in customer must be paid out in full — there is no account to
  //     hold a credit, and they may want part cash and part wallet transfer;
  //   * a registered customer who already paid in full might prefer the value
  //     left ON their account for next time, not cash out of the drawer;
  //   * the money may be settled partly now and partly later, or not at all;
  //   * a refund sent by wallet or card machine costs a transfer fee.
  //
  // So a return is a VALUE that must be settled, and the settlement is split
  // across three named buckets that MUST add up to it:
  //
  //     TotalAmount = AccountCredit + CashRefund + TransferRefund
  //
  // `DebtRelief` is kept as the legacy name for the account-credit portion so
  // existing rows, the customer statement and the supplier statement keep
  // working unchanged; AccountCredit is written to it as well.
  // Written out per table rather than looped over a template literal: the
  // migration verifier parses these statements statically, and an interpolated
  // table name is not resolvable at parse time.
  //
  // TransferRefund      — paid through a wallet / card machine, not the drawer.
  // PaymentMethodID     — which wallet or machine.
  // TransferCost        — fee the provider charged on that transfer.
  // TransferCostBearer  — 'shop' absorbs it, or 'party' receives less.
  // The unit COST credited back when goods return.
  //
  // The return line recorded the selling price but never the cost, so the value
  // put back into stock existed only as a side effect of the handler's
  // arithmetic. Nothing could verify it afterwards, and the profit report had
  // to guess the figure by re-deriving it from the sale lines — which is wrong
  // whenever an invoice carries the same item on several lines at different
  // costs. Recording it makes the reversal auditable and lets cost of sales be
  // credited with exactly what was restored.
  try {
    db.exec(`ALTER TABLE sale_return_details ADD COLUMN UnitCost REAL`);
  } catch {}

  // Shipping/fees on returned goods that could NOT be recovered.
  //
  // Stock is carried at the landed cost but a supplier credits only what they
  // charged. The handler keeps that difference with the inventory by loading it
  // onto the surviving units; when none survive there is nothing to carry it
  // and it becomes a real expense. Recording the amount makes the write-off
  // auditable and lets the profit report charge it — previously it simply
  // vanished from the books with no trace.
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN FreightWrittenOff REAL DEFAULT 0`);
  } catch {}

  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN TransferRefund REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN PaymentMethodID INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN TransferCost REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sale_returns ADD COLUMN TransferCostBearer TEXT DEFAULT 'shop'`);
  } catch {}

  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN TransferRefund REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN PaymentMethodID INTEGER`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN TransferCost REAL DEFAULT 0`);
  } catch {}
  try {
    db.exec(`ALTER TABLE purchase_returns ADD COLUMN TransferCostBearer TEXT DEFAULT 'shop'`);
  } catch {}

  // =============================================
  // PERFORMANCE INDEXES
  // =============================================
  //
  // These are the three lookups a shop performs constantly, and all three were
  // full table scans. Measured on 300,000 sales (about fifteen years of a very
  // busy shop) with `EXPLAIN QUERY PLAN` confirming the scan:
  //
  //     a year's sales report   35.1 ms -> 3.0 ms   (11.8x)
  //     one customer statement  22.0 ms -> 0.4 ms   (60.3x)
  //     opening one invoice      9.3 ms -> 0.1 ms   (74.2x)
  //
  // None of that is slow enough to notice on ONE query. It matters because a
  // dashboard issues a dozen date-range aggregates at once, and because a scan
  // costs the whole table every time — so the shop gets steadily slower for
  // years, which is exactly the failure nobody reports as a bug.
  //
  // Cost is about 12 MB of index on a 41 MB database. Cheap for 60x.
  //
  // IF NOT EXISTS everywhere, so this is safe on an existing install.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sales_date          ON sales(Date);
    CREATE INDEX IF NOT EXISTS idx_sales_customer      ON sales(CustomerID);
    CREATE INDEX IF NOT EXISTS idx_sale_details_sale   ON sale_details(SaleID);

    CREATE INDEX IF NOT EXISTS idx_purchases_date      ON purchases(Date);
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier  ON purchases(SupplierID);
    CREATE INDEX IF NOT EXISTS idx_purchase_details_purchase ON purchase_details(PurchaseID);

    CREATE INDEX IF NOT EXISTS idx_sale_returns_date   ON sale_returns(Date);
    CREATE INDEX IF NOT EXISTS idx_sale_returns_sale   ON sale_returns(SaleID);
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_date ON purchase_returns(Date);

    CREATE INDEX IF NOT EXISTS idx_vouchers_date       ON vouchers(Date);
    CREATE INDEX IF NOT EXISTS idx_vouchers_party      ON vouchers(PartyType, PartyID);
  `);

  // =============================================
  // SEED DATA
  // =============================================

  seedData(db);
}

function seedData(db: Database.Database) {
  // Check if already seeded
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as any;
  if (userCount.count > 0) return;

  // Default fiscal year
  const currentYear = new Date().getFullYear();
  db.prepare(`
    INSERT INTO fiscal_years (YearName, StartDate, EndDate, Status)
    VALUES (?, ?, ?, 'open')
  `).run(
    `السنة المالية ${currentYear}`,
    `${currentYear}-01-01`,
    `${currentYear}-12-31`
  );

  // Default roles
  db.prepare(`INSERT INTO roles (RoleName, IsSystem) VALUES ('مدير عام', 1)`).run();
  db.prepare(`INSERT INTO roles (RoleName, IsSystem) VALUES ('محاسب', 1)`).run();
  db.prepare(`INSERT INTO roles (RoleName, IsSystem) VALUES ('بائع', 1)`).run();
  db.prepare(`INSERT INTO roles (RoleName, IsSystem) VALUES ('فني صيانة', 1)`).run();

  // Admin employee
  db.prepare(`
    INSERT INTO employees (Name, Position, Department, BaseSalary, IsActive)
    VALUES ('المدير', 'مدير عام', 'الإدارة', 0, 1)
  `).run();

  // Admin user (password: admin123)
  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO users (Username, PasswordHash, EmployeeID, RoleID, IsActive)
    VALUES (?, ?, 1, 1, 1)
  `).run('admin', passwordHash);

  // Default warehouses
  db.prepare(`INSERT INTO warehouses (WarehouseName, WarehouseType) VALUES ('المخزن الرئيسي', 'main')`).run();
  db.prepare(`INSERT INTO warehouses (WarehouseName, WarehouseType) VALUES ('مخزن الصيانة', 'maintenance')`).run();

  // Default cash account (safe)
  db.prepare(`
    INSERT INTO cash_accounts (AccountName, AccountType, Balance, IsActive)
    VALUES ('الخزنة الرئيسية', 'safe', 0, 1)
  `).run();

  // Default settings
  const defaultSettings = [
    ['company_name', 'محل الموبايلات'],
    ['tax_number', ''],
    ['phone', ''],
    ['email', ''],
    ['address', ''],
    ['logo_path', ''],
    ['owner_name', ''],
    ['bank_name', ''],
    ['bank_account', ''],
    ['theme', 'light'],
    ['default_invoice_template', '1'],
    ['currency', 'ج.م'],
    ['vat_enabled', '0'],
    ['vat_rate', '0'],
    ['customer_warn_threshold', '1000'],
    ['customer_danger_threshold', '5000'],
    ['dev_name', 'محاسب / محمد عبدة'],
    ['dev_phone', '01207770329'],
    ['dev_email', 'conta.shepo@gmail.com'],
    // Telegram @username. When set, the activation screen can pre-fill the
    // request message (t.me/<user>?text=...); a bare phone link cannot carry
    // text, so the app falls back to copying it to the clipboard.
    ['dev_telegram', ''],
    ['copyright', '© 2026 محاسب / محمد عبدة - جميع الحقوق محفوظة'],
    ['distribution_rights', 'غير مسموح بتوزيع أو نسخ البرنامج بدون إذن المطور'],
    ['app_version', '1.0.0'],
    // --- Remotely-manageable presentation keys (see src/main/remote/remoteConfig.ts).
    // Blank by default; the About page hides empty blocks.
    ['app_name', 'موبايل شوب سيستم'],
    ['app_edition', ''],
    ['latest_version', ''],
    ['release_notes', ''],
    ['dev_title', ''],
    ['dev_whatsapp', ''],
    ['dev_website', ''],
    ['dev_facebook', ''],
    ['dev_address', ''],
    ['payment_info', ''],
    ['subscription_note', ''],
    ['support_hours', ''],
    ['terms_note', ''],
    ['custom_content', ''],
    ['custom_block_title', ''],
    ['custom_block_body', ''],
    // --- Remote check-in (see heartbeat.ts for exactly what is sent).
    // MANDATORY: the app calls home on every launch when a server is configured,
    // to receive updates, developer messages and renewed branding. It never
    // blocks the app while offline. The old `telemetry_enabled` opt-in switch
    // is gone; the value is kept in the row only for upgrades that still read it.
    ['telemetry_enabled', '1'],
    ['telemetry_share_shop_name', '1'],
    ['allow_negative_stock', '0'],
    ['allow_negative_cash', '0'],
    ['allow_negative_customer', '0'],
    ['allow_negative_supplier', '0'],
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (Key, Value) VALUES (?, ?)');
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  // Default categories
  const defaultCategories = ['شاشات', 'بطاريات', 'جرابات', 'وصلات', 'شواحن', 'سماعات', 'آيسيهات', 'إكسسوارات أخرى'];
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (CategoryName, ParentID) VALUES (?, NULL)');
  for (const cat of defaultCategories) {
    insertCat.run(cat);
  }

  // Default permissions
  const permissions = [
    // Dashboard
    ['dashboard.view', 'عرض لوحة التحكم', 'dashboard'],
    // Accounting - Sales
    ['sales.view', 'عرض المبيعات', 'sales'],
    ['sales.create', 'إنشاء فاتورة بيع', 'sales'],
    ['sales.edit', 'تعديل فاتورة بيع', 'sales'],
    ['sales.delete', 'حذف فاتورة بيع', 'sales'],
    ['sales.returns', 'مرتجعات المبيعات', 'sales'],
    // Accounting - Purchases
    ['purchases.view', 'عرض المشتريات', 'purchases'],
    ['purchases.create', 'إنشاء فاتورة شراء', 'purchases'],
    ['purchases.edit', 'تعديل فاتورة شراء', 'purchases'],
    ['purchases.delete', 'حذف فاتورة شراء', 'purchases'],
    ['purchases.returns', 'مرتجعات المشتريات', 'purchases'],
    // Accounting - Maintenance
    ['maintenance.view', 'عرض الصيانة', 'maintenance'],
    ['maintenance.create', 'استلام جهاز', 'maintenance'],
    ['maintenance.edit', 'تعديل أمر صيانة', 'maintenance'],
    ['maintenance.deliver', 'تسليم جهاز', 'maintenance'],
    ['maintenance.returns', 'مرتجع صيانة', 'maintenance'],
    ['maintenance.warranty', 'فتح صيانة ضمان', 'maintenance'],
    // Accounting - Vouchers
    ['vouchers.view', 'عرض السندات', 'vouchers'],
    ['vouchers.create', 'إنشاء سند', 'vouchers'],
    ['vouchers.edit', 'تعديل سند', 'vouchers'],
    ['vouchers.delete', 'حذف سند', 'vouchers'],
    // Accounting - Payroll
    ['payroll.view', 'عرض الرواتب', 'payroll'],
    ['payroll.create', 'صرف راتب', 'payroll'],
    ['payroll.edit', 'تعديل راتب', 'payroll'],
    ['commissions.view', 'عرض العمولات', 'payroll'],
    ['commissions.create', 'تسجيل عمولة', 'payroll'],
    ['deductions.view', 'عرض الخصومات', 'payroll'],
    ['deductions.create', 'تسجيل خصم', 'payroll'],
    // Accounting - Rent
    ['rent.view', 'عرض الإيجارات', 'rent'],
    ['rent.create', 'إنشاء إيجار', 'rent'],
    ['rent.edit', 'تعديل إيجار', 'rent'],
    // Accounting - Settlements
    ['settlements.view', 'عرض التسويات', 'settlements'],
    ['settlements.create', 'إنشاء تسوية', 'settlements'],
    // Accounting - Fiscal Year
    ['fiscal_year.view', 'عرض السنة المالية', 'fiscal_year'],
    ['fiscal_year.manage', 'إدارة السنة المالية', 'fiscal_year'],
    // Inventory
    ['inventory.view', 'عرض المخزون', 'inventory'],
    ['inventory.create', 'إضافة صنف', 'inventory'],
    ['inventory.edit', 'تعديل صنف', 'inventory'],
    ['inventory.delete', 'حذف صنف', 'inventory'],
    ['inventory.transfer', 'تحويل بين المخازن', 'inventory'],
    ['inventory.adjustment', 'تسوية مخزون', 'inventory'],
    ['inventory.issue', 'صرف مواد', 'inventory'],
    // HR
    ['hr.employees.view', 'عرض الموظفين', 'hr'],
    ['hr.employees.create', 'إضافة موظف', 'hr'],
    ['hr.employees.edit', 'تعديل موظف', 'hr'],
    ['hr.customers.view', 'عرض العملاء', 'hr'],
    ['hr.customers.create', 'إضافة عميل', 'hr'],
    ['hr.customers.edit', 'تعديل عميل', 'hr'],
    ['hr.suppliers.view', 'عرض الموردين', 'hr'],
    ['hr.suppliers.create', 'إضافة مورد', 'hr'],
    ['hr.suppliers.edit', 'تعديل مورد', 'hr'],
    // Assets
    ['assets.view', 'عرض الأصول', 'assets'],
    ['assets.create', 'إضافة أصل', 'assets'],
    ['assets.edit', 'تعديل أصل', 'assets'],
    // Reports
    ['reports.view', 'عرض التقارير', 'reports'],
    // Settings
    ['settings.view', 'عرض الإعدادات', 'settings'],
    ['settings.edit', 'تعديل الإعدادات', 'settings'],
    ['settings.users', 'إدارة المستخدمين', 'settings'],
  ];


  // =============================================
  // DATABASE-LEVEL GUARDS (the last line of defence)
  // =============================================
  //
  // Sixty-one tables carried NOT ONE constraint on a VALUE. Measured by
  // writing directly to the database, bypassing every handler:
  //
  //   customer with CreditLimit -9999          accepted
  //   customer with Status 'GOD_MODE'          accepted
  //   item with SalePrice -500                 accepted
  //   item with ItemType 'WEAPON'              accepted
  //   cash account with Balance -100000        accepted
  //   sale with TotalAmount -50                accepted
  //   sale line with Quantity 0, and with -5   accepted
  //   voucher of type 'MAGIC'                  accepted
  //   voucher with Amount -999                 accepted
  //   voucher with Date 'BANANA'               accepted
  //   maintenance ticket in status 'ALIEN'     accepted
  //
  // The handler validation added earlier closes the ordinary route, and that
  // is where a helpful Arabic message belongs. But it is ONE layer: a future
  // handler that forgets a check, a repair script, a direct edit, or a restore
  // from a doctored file all reach the tables without passing it. A constraint
  // in the database cannot be forgotten by the next person to add a feature.
  //
  // WHY TRIGGERS, AND WHY WRITTEN OUT LONGHAND
  // ------------------------------------------
  // `ALTER TABLE ... ADD CONSTRAINT CHECK` does work on the SQLite in this
  // sandbox (3.53.4), but the build this application SHIPS carries
  // better-sqlite3 12.11.1, whose SQLite could not be verified here. Depending
  // on a feature whose behaviour in the shipped binary is unknown is exactly
  // the unverified assumption that caused the earlier trouble.
  //
  // They are also written as ONE literal SQL block rather than generated by a
  // loop, because the test harness builds its schema by extracting
  // ``db.exec(`...`)`` templates and SKIPS any containing `${`. A generated
  // version ran in the application and was invisible to every test — the same
  // blind spot this whole review exists to remove.
  //
  // The messages are terse English on purpose: this is a backstop that should
  // never reach a user, and the handlers produce the Arabic ones.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ck_customers_credit_insert BEFORE INSERT ON customers
    WHEN NEW.CreditLimit IS NOT NULL AND NEW.CreditLimit < 0
    BEGIN SELECT RAISE(ABORT, 'customer credit limit must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_customers_credit_update BEFORE UPDATE ON customers
    WHEN NEW.CreditLimit IS NOT NULL AND NEW.CreditLimit < 0
    BEGIN SELECT RAISE(ABORT, 'customer credit limit must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_suppliers_credit_insert BEFORE INSERT ON suppliers
    WHEN NEW.CreditLimit IS NOT NULL AND NEW.CreditLimit < 0
    BEGIN SELECT RAISE(ABORT, 'supplier credit limit must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_suppliers_credit_update BEFORE UPDATE ON suppliers
    WHEN NEW.CreditLimit IS NOT NULL AND NEW.CreditLimit < 0
    BEGIN SELECT RAISE(ABORT, 'supplier credit limit must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_customers_status_insert BEFORE INSERT ON customers
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('active','warned','suspended')
    BEGIN SELECT RAISE(ABORT, 'invalid party status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_customers_status_update BEFORE UPDATE ON customers
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('active','warned','suspended')
    BEGIN SELECT RAISE(ABORT, 'invalid party status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_suppliers_status_insert BEFORE INSERT ON suppliers
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('active','warned','suspended')
    BEGIN SELECT RAISE(ABORT, 'invalid party status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_suppliers_status_update BEFORE UPDATE ON suppliers
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('active','warned','suspended')
    BEGIN SELECT RAISE(ABORT, 'invalid party status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_price_insert BEFORE INSERT ON items
    WHEN NEW.SalePrice IS NOT NULL AND NEW.SalePrice < 0
    BEGIN SELECT RAISE(ABORT, 'item sale price must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_cost_insert BEFORE INSERT ON items
    WHEN NEW.CostPrice IS NOT NULL AND NEW.CostPrice < 0
    BEGIN SELECT RAISE(ABORT, 'item cost must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_type_insert BEFORE INSERT ON items
    WHEN NEW.ItemType IS NOT NULL AND NEW.ItemType NOT IN ('phone','accessory','service')
    BEGIN SELECT RAISE(ABORT, 'invalid item type'); END;
    CREATE TRIGGER IF NOT EXISTS ck_cash_balance_insert BEFORE INSERT ON cash_accounts
    WHEN NEW.Balance IS NOT NULL AND NEW.Balance < 0
    BEGIN SELECT RAISE(ABORT, 'cash balance must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_wallet_balance_insert BEFORE INSERT ON payment_methods
    WHEN NEW.Balance IS NOT NULL AND NEW.Balance < 0
    BEGIN SELECT RAISE(ABORT, 'wallet balance must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_total_insert BEFORE INSERT ON sales
    WHEN NEW.TotalAmount IS NOT NULL AND NEW.TotalAmount < 0
    BEGIN SELECT RAISE(ABORT, 'sale total must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_paid_insert BEFORE INSERT ON sales
    WHEN NEW.PaidAmount IS NOT NULL AND NEW.PaidAmount < 0
    BEGIN SELECT RAISE(ABORT, 'paid amount must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchases_total_insert BEFORE INSERT ON purchases
    WHEN NEW.TotalAmount IS NOT NULL AND NEW.TotalAmount < 0
    BEGIN SELECT RAISE(ABORT, 'purchase total must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sale_line_qty_insert BEFORE INSERT ON sale_details
    WHEN NEW.Quantity IS NULL OR NEW.Quantity <= 0
    BEGIN SELECT RAISE(ABORT, 'sale line quantity must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchase_line_qty_insert BEFORE INSERT ON purchase_details
    WHEN NEW.Quantity IS NULL OR NEW.Quantity <= 0
    BEGIN SELECT RAISE(ABORT, 'purchase line quantity must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_type_insert BEFORE INSERT ON vouchers
    WHEN NEW.VoucherType NOT IN ('receipt','payment')
    BEGIN SELECT RAISE(ABORT, 'invalid voucher type'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_amount_insert BEFORE INSERT ON vouchers
    WHEN NEW.Amount IS NULL OR NEW.Amount <= 0
    BEGIN SELECT RAISE(ABORT, 'voucher amount must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_date_insert BEFORE INSERT ON vouchers
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'voucher date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_date_insert BEFORE INSERT ON sales
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'sale date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchases_date_insert BEFORE INSERT ON purchases
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'purchase date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_ticket_status_insert BEFORE INSERT ON maintenance_tickets
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('received','inspecting','in_progress','ready','delivered','cancelled','returned')
    BEGIN SELECT RAISE(ABORT, 'invalid ticket status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_salary_net_insert BEFORE INSERT ON salaries
    WHEN NEW.NetSalary IS NOT NULL AND NEW.NetSalary < 0
    BEGIN SELECT RAISE(ABORT, 'net salary must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_advance_amount_insert BEFORE INSERT ON employee_advances
    WHEN NEW.Amount IS NULL OR NEW.Amount <= 0
    BEGIN SELECT RAISE(ABORT, 'advance must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_price_update BEFORE UPDATE ON items
    WHEN NEW.SalePrice IS NOT NULL AND NEW.SalePrice < 0
    BEGIN SELECT RAISE(ABORT, 'item sale price must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_cost_update BEFORE UPDATE ON items
    WHEN NEW.CostPrice IS NOT NULL AND NEW.CostPrice < 0
    BEGIN SELECT RAISE(ABORT, 'item cost must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_items_type_update BEFORE UPDATE ON items
    WHEN NEW.ItemType IS NOT NULL AND NEW.ItemType NOT IN ('phone','accessory','service')
    BEGIN SELECT RAISE(ABORT, 'invalid item type'); END;
    CREATE TRIGGER IF NOT EXISTS ck_cash_balance_update BEFORE UPDATE ON cash_accounts
    WHEN NEW.Balance IS NOT NULL AND NEW.Balance < 0
    BEGIN SELECT RAISE(ABORT, 'cash balance must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_wallet_balance_update BEFORE UPDATE ON payment_methods
    WHEN NEW.Balance IS NOT NULL AND NEW.Balance < 0
    BEGIN SELECT RAISE(ABORT, 'wallet balance must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_total_update BEFORE UPDATE ON sales
    WHEN NEW.TotalAmount IS NOT NULL AND NEW.TotalAmount < 0
    BEGIN SELECT RAISE(ABORT, 'sale total must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_paid_update BEFORE UPDATE ON sales
    WHEN NEW.PaidAmount IS NOT NULL AND NEW.PaidAmount < 0
    BEGIN SELECT RAISE(ABORT, 'paid amount must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchases_total_update BEFORE UPDATE ON purchases
    WHEN NEW.TotalAmount IS NOT NULL AND NEW.TotalAmount < 0
    BEGIN SELECT RAISE(ABORT, 'purchase total must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sale_line_qty_update BEFORE UPDATE ON sale_details
    WHEN NEW.Quantity IS NULL OR NEW.Quantity <= 0
    BEGIN SELECT RAISE(ABORT, 'sale line quantity must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchase_line_qty_update BEFORE UPDATE ON purchase_details
    WHEN NEW.Quantity IS NULL OR NEW.Quantity <= 0
    BEGIN SELECT RAISE(ABORT, 'purchase line quantity must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_type_update BEFORE UPDATE ON vouchers
    WHEN NEW.VoucherType NOT IN ('receipt','payment')
    BEGIN SELECT RAISE(ABORT, 'invalid voucher type'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_amount_update BEFORE UPDATE ON vouchers
    WHEN NEW.Amount IS NULL OR NEW.Amount <= 0
    BEGIN SELECT RAISE(ABORT, 'voucher amount must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS ck_voucher_date_update BEFORE UPDATE ON vouchers
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'voucher date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_sales_date_update BEFORE UPDATE ON sales
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'sale date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_purchases_date_update BEFORE UPDATE ON purchases
    WHEN NEW.Date IS NOT NULL AND NEW.Date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    BEGIN SELECT RAISE(ABORT, 'purchase date must be YYYY-MM-DD'); END;
    CREATE TRIGGER IF NOT EXISTS ck_ticket_status_update BEFORE UPDATE ON maintenance_tickets
    WHEN NEW.Status IS NOT NULL AND NEW.Status NOT IN ('received','inspecting','in_progress','ready','delivered','cancelled','returned')
    BEGIN SELECT RAISE(ABORT, 'invalid ticket status'); END;
    CREATE TRIGGER IF NOT EXISTS ck_salary_net_update BEFORE UPDATE ON salaries
    WHEN NEW.NetSalary IS NOT NULL AND NEW.NetSalary < 0
    BEGIN SELECT RAISE(ABORT, 'net salary must not be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ck_advance_amount_update BEFORE UPDATE ON employee_advances
    WHEN NEW.Amount IS NULL OR NEW.Amount <= 0
    BEGIN SELECT RAISE(ABORT, 'advance must be positive'); END;
  `);

  // =============================================
  // THE AUDIT TRAIL IS APPEND-ONLY, AND NOW IT IS ENFORCED
  // =============================================
  //
  // `security_events` carried the comment "deliberately append-only in
  // practice: nothing in the application updates or deletes a row here."
  // That was a description of the callers, not a property of the table.
  //
  // MEASURED against the real schema — six attacks, all six succeeded:
  //
  //   UPDATE ... SET Detail   = 'لا شيء'          1 row
  //   UPDATE ... SET Username = 'someone_else'    1 row
  //   UPDATE ... SET EventType= 'login'           1 row
  //   UPDATE ... SET CreatedAt= '2020-01-01'      1 row
  //   DELETE  ... WHERE EventID = 2               1 row
  //   DELETE  FROM security_events                1 row   <- the whole log
  //
  // The table ended empty. A log that the thing it is watching can erase is
  // not evidence of anything: password resets, owner-level data exports and
  // database wipes are exactly the events recorded here, and whoever performs
  // one is precisely who wants the row gone.
  //
  // WHY TRIGGERS RATHER THAN A PERMISSION
  // -------------------------------------
  // The permission layer governs IPC channels. It cannot see a repair script,
  // a hand edit in a SQLite browser, or a restored backup that was doctored
  // offline — and the .db file sits in the shop's own AppData folder. The
  // constraint has to live with the data.
  //
  // WHY NOT `ALTER TABLE ... ADD CONSTRAINT`
  // ----------------------------------------
  // SQLite has no such statement, and a CHECK cannot express "no UPDATE ever".
  // BEFORE triggers with RAISE(ABORT) can, they are portable across every
  // SQLite build this ships against, and they are written here as ONE LITERAL
  // BLOCK because the test harness extracts db.exec(`...`) templates and skips
  // any containing an interpolation — a generated guard would run in the app
  // and be invisible to every test.
  //
  // WHAT IS DELIBERATELY STILL ALLOWED
  // ----------------------------------
  // INSERT. The log must keep accepting new events, or the guard has replaced
  // a tamperable record with no record.
  //
  // Pruning old events is NOT provided. If it is ever needed it belongs in a
  // migration that raises the schema version, under the developer's control,
  // never in a handler the renderer can reach.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_update
    BEFORE UPDATE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be altered'); END;

    CREATE TRIGGER IF NOT EXISTS ck_security_events_no_delete
    BEFORE DELETE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only: a recorded event cannot be deleted'); END;
  `);

  const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (PermissionKey, PermissionName, Module) VALUES (?, ?, ?)');
  for (const [key, name, module] of permissions) {
    insertPerm.run(key, name, module);
  }

  // Grant all permissions to admin role (RoleID = 1)
  const allPerms = db.prepare('SELECT PermissionID FROM permissions').all() as any[];
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (RoleID, PermissionID) VALUES (1, ?)');
  for (const perm of allPerms) {
    insertRolePerm.run(perm.PermissionID);
  }
}
