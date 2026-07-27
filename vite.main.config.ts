import { defineConfig, loadEnv } from 'vite';

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  // Load .env from the project root. Vite only exposes variables prefixed with
  // VITE_ by default, and only to the RENDERER — but these two are read by the
  // main process (src/main/remote/heartbeat.ts), so they must be inlined into
  // the main bundle at build time. Without this the app silently ignores .env
  // and the remote feature stays disabled with no error.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'bcryptjs'],
      },
    },
    define: {
      'process.env.MOBILESHOP_API_BASE': JSON.stringify(env.MOBILESHOP_API_BASE || ''),
      'process.env.MOBILESHOP_CLIENT_KEY': JSON.stringify(env.MOBILESHOP_CLIENT_KEY || ''),
    },
  };
});
