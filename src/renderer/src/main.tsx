import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { useAuthStore } from './stores/auth.store';

/**
 * Global IPC response interceptor.
 *
 * The main process rejects unauthorised calls with
 * `{ success: false, code: 'UNAUTHENTICATED' | 'FORBIDDEN' }`. Without this
 * wrapper an expired session showed up as an ordinary red toast on whichever
 * screen the user happened to be on, and they stayed on a page whose data no
 * longer loads. Handling it once here means every screen reacts correctly
 * without each page needing its own check.
 */
(() => {
  const api = window.api;
  if (!api || typeof api.invoke !== 'function') return;
  const rawInvoke = api.invoke.bind(api);

  api.invoke = async (channel: string, ...args: unknown[]) => {
    const result = await rawInvoke(channel, ...args);
    if (result && typeof result === 'object' && (result as any).success === false) {
      const code = (result as any).code;
      if (code === 'UNAUTHENTICATED') {
        // Session gone (timeout, password reset elsewhere) — drop local state so
        // the router falls back to the login screen instead of showing a page
        // whose every request now fails.
        const { isAuthenticated, logout } = useAuthStore.getState();
        if (isAuthenticated) void logout();
      }
    }
    return result;
  };
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </React.StrictMode>
);
