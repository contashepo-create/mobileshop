import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useEffect, useState } from 'react';
import { useThemeStore } from '../../stores/theme.store';
import { ErrorBoundary } from '../shared/ErrorBoundary';
import { UpdateReadyBanner } from './UpdateReadyBanner';

export function MainLayout() {
  const { initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <div className="flex h-screen bg-slate-100 dark:bg-slate-900">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <UpdateReadyBanner />
        <main className="flex-1 overflow-auto p-6">
          {/* Wrapping the OUTLET rather than the whole layout is deliberate: a
              screen that throws is contained, and the sidebar and header stay
              alive so the shop can walk to another section instead of
              restarting the application. */}
          <ErrorBoundary area="الصفحة">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
