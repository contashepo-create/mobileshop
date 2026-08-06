import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

/**
 * The npm packages that must be COPIED INTO the app, not bundled.
 *
 * `vite.main.config.ts` marks these `external`, so the main bundle keeps a
 * literal `require('better-sqlite3')` instead of inlining the code. That is
 * mandatory for better-sqlite3 — it is a native addon and a .node binary
 * cannot be bundled — and bcryptjs comes along because it is required from
 * the same main-process graph.
 *
 * `external` only means "do not inline". It says nothing about packaging, so
 * the real files still have to be present at runtime.
 *
 * WHY THIS LIST HAS TO EXIST
 * --------------------------
 * @electron-forge/plugin-vite installs its own packager `ignore`:
 *
 *     forgeConfig.packagerConfig.ignore = (file) => !file.startsWith('/.vite')
 *
 * That keeps `.vite` and DISCARDS EVERYTHING ELSE — including the whole of
 * `node_modules`. It is the right default for an app whose dependencies are
 * all bundled, and it is silently wrong for one with a native module: the
 * build succeeds, the installer is produced, and the packaged app dies on
 * first launch with
 *
 *     Error: Cannot find module 'better-sqlite3'
 *
 * from `app.asar`, before any window is shown. Nothing earlier in the
 * pipeline can catch it, because nothing earlier looks inside the .asar.
 *
 * `asar.unpackDir` did not save it either: unpack only decides whether a file
 * that WAS copied lives inside the archive or beside it. A file that was
 * never copied cannot be unpacked.
 *
 * TRANSITIVE DEPENDENCIES COUNT
 * -----------------------------
 * better-sqlite3 does `require('bindings')` at load time to locate its .node,
 * and `bindings` does `require('file-uri-to-path')`. Copying only the two
 * top-level packages moves the same crash one module along. The list below is
 * the full runtime closure, measured by tracing `Module._load` while actually
 * requiring both packages — not read off package.json, where `prebuild-install`
 * appears as a dependency but is a build-time tool that is never loaded.
 *
 * `scripts/verify_packaged_app.mjs` re-derives this closure and fails if it
 * drifts, so a future dependency bump cannot quietly reintroduce the crash.
 */
const RUNTIME_MODULES = [
  'better-sqlite3',
  'bcryptjs',
  'bindings',
  'file-uri-to-path',
];

const config: ForgeConfig = {
  packagerConfig: {
    name: 'MobileShopERP',
    executableName: 'MobileShopERP',
    asar: { unpackDir: 'node_modules/better-sqlite3' },
    // Overrides the plugin's `.vite`-only filter. Declaring `ignore` here
    // makes the plugin leave it alone: it warns and returns early rather than
    // replacing a filter the developer set deliberately.
    ignore: (file: string) => {
      if (!file) return false;                       // the root itself
      if (file.startsWith('/.vite')) return false;   // the built app

      // package.json must survive: Electron reads `main` from it to find the
      // entry point. The Vite plugin rewrites a copy into the build folder,
      // and dropping the original leaves an app with no entry at all.
      if (file === '/package.json') return false;

      // Keep only the runtime modules, and keep the directories leading to
      // them — a filter that rejects `/node_modules` never gets asked about
      // anything inside it.
      if (file === '/node_modules') return false;
      for (const m of RUNTIME_MODULES) {
        // `/node_modules/x` and everything under it. The trailing-slash test
        // stops `/node_modules/bindings-extra` matching `bindings`.
        if (file === `/node_modules/${m}` || file.startsWith(`/node_modules/${m}/`)) {
          return false;
        }
      }
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'MobileShopERP',
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
