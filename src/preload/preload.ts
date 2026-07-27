import { contextBridge, ipcRenderer } from 'electron';

/**
 * Bridge between the renderer and the main process.
 *
 * The session-expiry interception lives HERE rather than in the renderer:
 * `contextBridge.exposeInMainWorld` deep-freezes the exposed object, so
 * `window.api.invoke = ...` throws
 * "Cannot assign to read only property 'invoke'" and the whole app fails to
 * boot. Wrapping the function before it is exposed avoids that entirely.
 */

/** Set by the renderer so it can react to its session being dropped. */
let onUnauthenticated: (() => void) | null = null;

const api = {
  invoke: async (channel: string, ...args: unknown[]) => {
    const result = await ipcRenderer.invoke(channel, ...args);
    // The main process rejects unauthorised calls with a structured failure.
    // Surfacing it once here means no screen has to check for itself.
    if (
      result && typeof result === 'object' &&
      (result as any).success === false &&
      (result as any).code === 'UNAUTHENTICATED'
    ) {
      try { onUnauthenticated?.(); } catch { /* never break the caller */ }
    }
    return result;
  },

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },

  /** Registers the renderer's "session died" handler (logout + redirect). */
  onSessionExpired: (handler: () => void) => {
    onUnauthenticated = typeof handler === 'function' ? handler : null;
  },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
