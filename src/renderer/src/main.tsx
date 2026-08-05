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

/**
 * NO `future` PROP — that is the one breaking change in the v6 -> v7 upgrade.
 *
 * On v6 this router carried `future={{ v7_startTransition: true,
 * v7_relativeSplatPath: true }}`. Those flags existed so a v6 app could opt
 * into v7 behaviour early; in v7 the behaviour IS the default and the prop was
 * removed from `HashRouterProps` altogether. Leaving it in place fails the
 * typecheck with "Property 'future' does not exist" and, in plain JavaScript,
 * would be silently ignored.
 *
 * Because both flags were already enabled here, the upgrade changes no runtime
 * behaviour at all: navigation was already wrapped in `React.startTransition`
 * and splat paths already resolved relatively. That is exactly the migration
 * path React Router documents — turn the flags on under v6, then bump.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
