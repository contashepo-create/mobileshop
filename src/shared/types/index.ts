// Shared types between Main and Renderer

export interface User {
  userId: number;
  username: string;
  employeeId?: number;
  employeeName?: string;
  roleId: number;
  roleName: string;
}

export interface Customer {
  CustomerID: number;
  Name: string;
  Phone: string;
  Email?: string;
  Address?: string;
  Balance: number;
  Status: 'active' | 'warned' | 'suspended';
  CreditLimit?: number;
  CreatedAt: string;
}

export interface Supplier {
  SupplierID: number;
  Name: string;
  Phone: string;
  Email?: string;
  Address?: string;
  Balance: number;
  Status: 'active' | 'warned' | 'suspended';
  CreditLimit?: number;
  CreatedAt: string;
}

export interface Employee {
  EmployeeID: number;
  Name: string;
  Phone?: string;
  Position?: string;
  Department?: string;
  BaseSalary: number;
  Allowances: number;
  HireDate?: string;
  IsActive: number;
  Balance: number;
  Notes?: string;
}

export interface Item {
  ItemID: number;
  ItemName: string;
  CategoryID?: number;
  Barcode?: string;
  ItemType?: 'phone' | 'accessory' | 'spare_part';
  IsSerialized: number;
  SalePrice?: number;
  CostPrice?: number;
  IsActive: number;
  MinStock: number;
  Unit: string;
}

export const UNIT_OPTIONS = [
  'قطعة', 'حبة', 'كجم', 'جرام', 'لتر', 'مل', 'متر', 'سم',
  'طقم', 'علبة', 'كرتونة', 'زوج', 'دستة', 'رول', 'شريط'
];

export interface Warehouse {
  WarehouseID: number;
  WarehouseName: string;
  WarehouseType: 'main' | 'maintenance' | 'other';
  IsActive: number;
}

export interface CashAccount {
  CashAccountID: number;
  AccountName: string;
  AccountType: 'safe' | 'bank';
  Balance: number;
  IsActive: number;
  BankName?: string;
  AccountNumber?: string;
}

export interface PaymentMethod {
  PaymentMethodID: number;
  MethodName: string;
  MethodType: 'pos_machine' | 'digital_wallet' | 'transfer';
  Provider?: string;
  PhoneNumber?: string;
  Balance: number;
  IsActive: number;
}

export interface FiscalYear {
  FiscalYearID: number;
  YearName: string;
  StartDate: string;
  EndDate: string;
  Status: 'open' | 'closed';
}

export interface OperationNote {
  NoteID: number;
  OperationType: string;
  OperationID: number;
  Content: string;
  UserID: number;
  Username?: string;
  CreatedAt: string;
}

// Customer/Supplier color helper
export function getPartyColor(balance: number, status: string, warnThreshold: number, dangerThreshold: number) {
  if (status === 'suspended') return 'red';
  if (balance <= 0) return 'green';
  if (balance < warnThreshold) return 'yellow';
  if (balance < dangerThreshold) return 'orange';
  return 'red';
}
