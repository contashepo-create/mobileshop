/// <reference types="react" />
/// <reference types="react-dom" />

/**
 * Renderer-side view of the preload bridge.
 *
 * Declared structurally rather than importing from `src/preload`: that module
 * is compiled into a separate Electron bundle, and the previous
 * `import ... from '../preload/index'` pointed at a path that does not exist,
 * so `window.api` silently fell back to `any`.
 *
 * `invoke` is writable because main.tsx wraps it to intercept auth failures.
 */
// With the automatic JSX runtime (`jsx: "react-jsx"`) files do not import
// React, yet many of them annotate handlers with `React.ChangeEvent<...>`.
// Re-exporting the namespace globally keeps those annotations valid without
// adding a redundant `import React` to 27 files.
import type * as ReactNamespace from 'react';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export import React = ReactNamespace;

  interface Window {
    api: {
      invoke: (channel: string, ...args: unknown[]) => Promise<any>;
      on: (channel: string, callback: (...args: unknown[]) => void) => void;
    };
  }
}

export {};
