/**
 * Loads the REAL IPC handlers and lets a test call them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The earlier audits proved almost nothing. They did one of two things:
 *
 *   1. matched strings against the source text — which proves a line exists,
 *      not that it behaves correctly;
 *   2. reimplemented the handler's arithmetic in Python and tested THAT — which
 *      tests the author's understanding of the code, never the code itself.
 *
 * Neither ever executed `sales.handlers.ts`. So any defect on a path that was
 * not consciously reimplemented stayed invisible, and each fresh reading found
 * a different bug. Re-reading is not re-testing.
 *
 * This harness removes the copy. It:
 *   - builds a real database from the real migrations;
 *   - stubs `electron` so `ipcMain.handle` records handlers instead of binding
 *     to a process, and `app.getPath` returns a temp folder;
 *   - stubs `better-sqlite3` with `node:sqlite`, which has a compatible API;
 *   - imports the actual handler modules and registers them;
 *   - exposes `call(channel, payload)` so a test invokes exactly what the
 *     application invokes.
 *
 * A bug can then only escape if no test calls that channel — a much smaller
 * gap than "no test models that branch".
 */
import Wrapped from './stubs/betterSqlite.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** Registered by the fake ipcMain: channel -> handler function. */
export const handlers = (globalThis.__TEST_HANDLERS__ ||= new Map());

let activeDb = null;

// ---------------------------------------------------------------- module stubs
//
// A loader hook rewrites `electron` and `better-sqlite3` to local stubs, so the
// handler modules are imported UNMODIFIED and still resolve.
const STUB_DIR = pathToFileURL(join(HERE, 'stubs') + '/').href;

const LOADER_SOURCE = `
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const STUBS = ${JSON.stringify(STUB_DIR)};
  const CONNECTION = /database\\/connection$/;
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') {
      return { url: STUBS + 'electron.mjs', shortCircuit: true };
    }
    if (specifier === 'better-sqlite3') {
      return { url: STUBS + 'betterSqlite.mjs', shortCircuit: true };
    }
    // Matched on the tail so every relative depth resolves to one stub.
    if (CONNECTION.test(specifier)) {
      return { url: STUBS + 'connection.mjs', shortCircuit: true };
    }
    // TypeScript source omits the extension; Node's ESM resolver requires one.
    // Resolved against the importing file rather than retried, because a failed
    // next() rejects asynchronously and cannot be caught reliably here.
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      const base = context.parentURL || import.meta.url;
      const candidate = new URL(specifier + '.ts', base).href;
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate, shortCircuit: true };
      }
    }
    return next(specifier, context);
  }
`;

register('data:text/javascript,' + encodeURIComponent(LOADER_SOURCE), import.meta.url);

// ---------------------------------------------------------------- database
/** Builds a fresh database by running the project's own migration file. */
/**
 * Splits a SQL script into statements, ignoring semicolons that are inside
 * comments or string literals.
 *
 * A plain `split(';')` was wrong in a way that silently WEAKENED the tests: a
 * `--` comment line above a CREATE TABLE was glued to the previous fragment, so
 * the statement that followed it never ran. The table was simply missing from
 * the test database, and any handler touching it failed with "no such table"
 * inside a try/catch that reported a generic error — the schema and the tests
 * had quietly diverged.
 *
 * Comments are stripped and quotes are tracked so the split matches what SQLite
 * itself would do.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let quote = null;             // ' or " when inside a literal/identifier
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (c === '\n') { lineComment = false; buf += c; }
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (!quote && c === '-' && next === '-') { lineComment = true; i++; continue; }
    if (!quote && c === '/' && next === '*') { blockComment = true; i++; continue; }

    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }

    if (c === ';') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      continue;
    }
    buf += c;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

export function buildDatabase() {
  // Same wrapper the handlers get in production, so `transaction`,
  // `prepare` and `pragma` behave identically.
  const db = new Wrapped(':memory:');
  const ts = readFileSync(join(ROOT, 'src/main/database/migrations/index.ts'), 'utf-8');

  // Execute every db.exec(`...`) block in source order, exactly as the app does.
  for (const m of ts.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)) {
    const sql = m[1];
    if (sql.includes('${')) continue;           // dynamic, skipped by design
    for (const stmt of splitStatements(sql)) {
      try { db.exec(stmt); } catch { /* ALTER on an existing column, etc. */ }
    }
  }
  activeDb = db;
  globalThis.__TEST_DB__ = db;
  return db;
}

export function currentDb() {
  return activeDb;
}

// ---------------------------------------------------------------- session
/**
 * Identity the fake guard stamps onto payloads, mirroring the real IPC guard.
 * Tests can change it to check permission behaviour.
 */
export const session = { userId: 1, username: 'admin', roleId: 1 };

// ---------------------------------------------------------------- loading
/**
 * Imports the real handler modules and registers their channels.
 * `getDb` is monkey-patched to return the in-memory database.
 */
export async function loadHandlers() {
  const mods = [
    'src/main/ipc/sales.handlers.ts',
    'src/main/ipc/purchases.handlers.ts',
    'src/main/ipc/delete.handlers.ts',
    // Loaded so the profit report can be exercised against the SAME books the
    // trading handlers just wrote, rather than reasoned about separately. The
    // P&L is where a valuation error becomes a wrong number on screen.
    'src/main/ipc/reports.handlers.ts',
  ];
  const loaded = [];
  for (const rel of mods) {
    loaded.push(await import(pathToFileURL(join(ROOT, rel)).href));
  }
  // Register every channel by running each module's register* export.
  for (const mod of loaded) {
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn === 'function' && name.startsWith('register')) fn();
    }
  }
  return loaded;
}

/** Invokes a channel the way the application does. */
export async function call(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  // The real guard replaces any caller-supplied userId with the session's.
  const stamped = args.map(a =>
    a && typeof a === 'object' && !Array.isArray(a) ? { ...a, userId: session.userId } : a);
  return fn({ sender: { id: 1 } }, ...stamped);
}
