import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Will be populated with IPC channels as modules are built
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
