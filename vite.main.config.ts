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
      // Licence verification key and developer password hash.
      //
      // Kept in .env rather than edited into the source: a tracked file that
      // holds production values fights every `git pull`, and a reverted edit
      // would silently invalidate every licence already issued.
      'process.env.MOBILESHOP_LICENSE_PUBLIC_KEY': JSON.stringify(env.MOBILESHOP_LICENSE_PUBLIC_KEY || ''),
      'process.env.MOBILESHOP_DEV_PASSWORD_HASH': JSON.stringify(env.MOBILESHOP_DEV_PASSWORD_HASH || ''),
      // The base64 form exists because dotenv-expand mangles a bcrypt hash:
      // `$2a$12$abc...` becomes `$2a$12`. Base64 has no `$` to expand.
      'process.env.MOBILESHOP_DEV_PASSWORD_HASH_B64': JSON.stringify(env.MOBILESHOP_DEV_PASSWORD_HASH_B64 || ''),
    },
  };
});
