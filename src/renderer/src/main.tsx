import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { useAuthStore } from './stores/auth.store';

/**
 * React to the main process dropping our session.
 *
 * The detection itself lives in the preload (it wraps `invoke` before
 * contextBridge freezes the object — reassigning `window.api.invoke` from here
 * throws "Cannot assign to read only property"). This side only decides what to
 * do about it: clear local auth state so the router falls back to the login
 * screen instead of leaving the user on a page whose every request now fails.
 */
window.api?.onSessionExpired?.(() => {
  const { isAuthenticated, logout } = useAuthStore.getState();
  if (isAuthenticated) void logout();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </React.StrictMode>
);
