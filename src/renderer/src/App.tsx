import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Login } from './pages/auth/Login';
import { LicenseActivationPage } from './pages/auth/LicenseActivationPage';
import { FirstRunWizard } from './pages/setup/FirstRunWizard';
import { MainLayout } from './components/layout/MainLayout';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { Dashboard } from './pages/dashboard/Dashboard';
import { SettingsPage } from './pages/settings/SettingsPage';
import { BackupPage } from './pages/settings/BackupPage';
import { DatabaseManagementPage } from './pages/settings/DatabaseManagementPage';
import { LicenseInfoSettings } from './pages/settings/LicenseInfoSettings';
import { CustomersPage } from './pages/hr/CustomersPage';
import { SuppliersPage } from './pages/hr/SuppliersPage';
import { EmployeesPage } from './pages/hr/EmployeesPage';
import { AssetsPage } from './pages/assets/AssetsPage';
import { PaymentMethodsPage } from './pages/assets/PaymentMethodsPage';
import { TransfersPage } from './pages/assets/TransfersPage';
import { SalesPage } from './pages/accounting/SalesPage';
import { PurchasesPage } from './pages/accounting/PurchasesPage';
import { MaintenancePage } from './pages/accounting/MaintenancePage';
import { VouchersPage } from './pages/accounting/VouchersPage';
import { PayrollPage } from './pages/accounting/PayrollPage';
import { RentPage } from './pages/accounting/RentPage';
import { RentPartiesPage } from './pages/accounting/RentPartiesPage';
import { FiscalYearPage } from './pages/accounting/FiscalYearPage';
import { SettlementPage } from './pages/accounting/SettlementPage';
import { OpeningBalancePage } from './pages/accounting/OpeningBalancePage';
import { InventoryPage } from './pages/inventory/InventoryPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { CustomerStatementPage } from './pages/reports/CustomerStatementPage';
import { SupplierStatementPage } from './pages/reports/SupplierStatementPage';
import { EmployeeStatementPage } from './pages/reports/EmployeeStatementPage';
import { DevConsolePage } from './pages/dev/DevConsolePage';
import { AboutPage } from './pages/settings/AboutPage';
import { ServicesPage } from './pages/accounting/ServicesPage';
import { ToastContainer } from './components/ui/Toast';
import { NoticeCenter } from './components/shared/NoticeCenter';
import { useAuthStore } from './stores/auth.store';
import { useThemeStore } from './stores/theme.store';

export default function App() {
  const { isAuthenticated, initAuth } = useAuthStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [licenseStatus, setLicenseStatus] = useState<any>(null);
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);

  useEffect(() => {
    useThemeStore.getState().initTheme();
    (async () => {
      await initAuth();
      // Check license on startup
      try {
        const status = await window.api.invoke('license:status');
        setLicenseStatus(status);
      } catch {
        setLicenseStatus({ status: 'error', message: 'تعذر التحقق من الترخيص - يرجى التواصل مع المطور' });
      }
      setLicenseChecked(true);
      // Check first-run setup
      try {
        const setup = await window.api.invoke('setup:isComplete');
        setSetupComplete(setup.complete);
      } catch {
        setSetupComplete(true);
      }
      setLoading(false);
    })();
  }, [initAuth]);

  // Dev console shortcut: Ctrl+Shift+5 — works even when license is expired
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === '5' || e.code === 'Digit5' || e.code === 'Numpad5')) {
        e.preventDefault();
        e.stopPropagation();
        navigate('/dev-console');
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [navigate]);

  if (loading || !licenseChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-100 dark:bg-slate-900">
        <div className="text-slate-600 dark:text-slate-300 text-lg">جاري التحميل...</div>
      </div>
    );
  }

  // First-run wizard
  if (!setupComplete) {
    return <FirstRunWizard />;
  }

  const isLicensed = licenseStatus?.status === 'active' || licenseStatus?.status === 'trial';

  return (
    // The ROOT boundary. The one inside MainLayout covers ordinary screens;
    // this covers everything outside it — the login screen, the first-run
    // wizard and the licence page — where there is no layout left to fall
    // back to and a throw would otherwise leave a blank window.
    <ErrorBoundary area="التطبيق">
      <Routes>
        {/* Dev console is always accessible, even when license is expired */}
        <Route path="/dev-console" element={<DevConsolePage />} />

        {/* License gate: if not active/trial, show activation page for all other routes */}
        {!isLicensed ? (
          <Route path="*" element={<LicenseActivationPage />} />
        ) : !isAuthenticated ? (
          <>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<MainLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="accounting/sales" element={<SalesPage />} />
              <Route path="accounting/purchases" element={<PurchasesPage />} />
              <Route path="accounting/maintenance" element={<MaintenancePage />} />
              <Route path="accounting/vouchers" element={<VouchersPage />} />
              <Route path="accounting/payroll" element={<PayrollPage />} />
              <Route path="accounting/sale-returns" element={<SalesPage mode="returns" />} />
              <Route path="accounting/purchase-returns" element={<PurchasesPage mode="returns" />} />
              <Route path="accounting/vouchers-receipt" element={<VouchersPage mode="receipt" />} />
              <Route path="accounting/vouchers-payment" element={<VouchersPage mode="payment" />} />
              <Route path="accounting/rents" element={<RentPage />} />
              <Route path="accounting/rent-parties" element={<RentPartiesPage />} />
              <Route path="accounting/services" element={<ServicesPage />} />
              <Route path="accounting/fiscal-year" element={<FiscalYearPage />} />
              <Route path="accounting/settlement" element={<SettlementPage />} />
              <Route path="accounting/opening-balances" element={<OpeningBalancePage />} />
              <Route path="inventory" element={<InventoryPage />} />
              <Route path="inventory/warehouses" element={<InventoryPage />} />
              <Route path="inventory/items" element={<InventoryPage />} />
              <Route path="hr/employees" element={<EmployeesPage />} />
              <Route path="hr/customers" element={<CustomersPage />} />
              <Route path="hr/suppliers" element={<SuppliersPage />} />
              <Route path="assets" element={<AssetsPage />} />
              <Route path="assets/payment-methods" element={<PaymentMethodsPage />} />
              <Route path="assets/transfers" element={<TransfersPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="reports/customer-statement" element={<CustomerStatementPage />} />
              <Route path="reports/supplier-statement" element={<SupplierStatementPage />} />
              <Route path="reports/employee-statement" element={<EmployeeStatementPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/backup" element={<BackupPage />} />
              <Route path="settings/database" element={<DatabaseManagementPage />} />
              <Route path="settings/license" element={<LicenseInfoSettings />} />
              <Route path="about" element={<AboutPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
      <ToastContainer />
      {/*
        Only once the user is inside the app. Showing a renewal dialog over the
        login box or the activation screen would cover the very field they need
        to type into, and those screens already state the licence situation.
      */}
      {isLicensed && isAuthenticated && <NoticeCenter />}
    </ErrorBoundary>
  );
}
