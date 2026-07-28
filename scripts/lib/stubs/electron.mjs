/**
 * Minimal `electron` stand-in for the handler harness.
 *
 * `ipcMain.handle` records the handler instead of binding it to a real IPC
 * channel, so a test can invoke exactly the function the application invokes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registry = new Map();
globalThis.__TEST_HANDLERS__ ||= registry;

export const ipcMain = {
  handle(channel, listener) {
    globalThis.__TEST_HANDLERS__.set(channel, listener);
  },
  removeHandler(channel) {
    globalThis.__TEST_HANDLERS__.delete(channel);
  },
};

const userData = mkdtempSync(join(tmpdir(), 'mobileshop-test-'));

export const app = {
  getPath: () => userData,
  getVersion: () => '0.0.0-test',
  getName: () => 'mobileshop-test',
  quit() {},
  whenReady: async () => {},
  on() {},
};

export const dialog = {
  showErrorBox() {},
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
};

export const shell = { openExternal: async () => {} };
export const contextBridge = { exposeInMainWorld() {} };
export const ipcRenderer = { invoke: async () => undefined, on() {} };
export class BrowserWindow {
  static getAllWindows() { return []; }
  static fromWebContents() { return null; }
}
export const Notification = class {};
export default { ipcMain, app, dialog, shell, BrowserWindow };
