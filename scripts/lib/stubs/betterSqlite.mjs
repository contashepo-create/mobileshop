/**
 * `better-sqlite3` stand-in backed by Node's built-in `node:sqlite`.
 *
 * The handlers use a small, stable slice of the API — prepare/run/get/all,
 * exec, transaction, pragma — and `node:sqlite` matches it closely enough that
 * the handler source needs no changes at all. That matters: the point of the
 * harness is to execute the REAL code, so anything that would require editing
 * the handlers to make them testable defeats the purpose.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * True when a statement can CHANGE data.
 *
 * Byte-for-byte the same rule as `isWriteStatement` in
 * src/main/database/connection.ts. It is duplicated rather than imported
 * because this stub must stay loadable without the TypeScript source, and
 * `verify_release_readiness.mjs` pins the two to the same behaviour so they
 * cannot drift apart.
 */
function isWriteStatement(sql) {
  const head = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .slice(0, 400)
    .toUpperCase();
  if (/^\s*(SELECT|PRAGMA|EXPLAIN)\b/.test(head) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)) {
    return false;
  }
  if (/^\s*WITH\b/.test(head)) {
    return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head);
  }
  return true;
}

class Wrapped {
  constructor(path, opts) {
    // node:sqlite rejects `undefined` for options, unlike better-sqlite3.
    this._db = opts
      ? new DatabaseSync(path ?? ':memory:', opts)
      : new DatabaseSync(path ?? ':memory:');
  }

  prepare(rawSql) {
    // Mirrors `roundBalanceArithmetic` in src/main/database/connection.ts.
    // Running balances accumulate inside SQLite, so 300 credit sales of 33.33
    // settled at 9998.999999999982 instead of 9999 — and `Balance = 0` then
    // never reads true for a customer who has paid in full. The stub replaces
    // the driver entirely, so without the same rewrite the tests would measure
    // a different database layer from the one that ships.
    const sql = /\bSET\s+Balance\s*=\s*Balance\s*[+-]\s*\?/i.test(rawSql)
      ? rawSql.replace(/\bSET\s+Balance\s*=\s*Balance\s*([+-])\s*\?/gi,
          (_m, op) => `SET Balance = ROUND(Balance ${op} ?, 2)`)
      : rawSql;
    const st = this._db.prepare(sql);
    // Mirrors `hardenBinding` in src/main/database/connection.ts.
    //
    // The application wraps `prepare` so an unbindable parameter returns empty
    // instead of throwing across the IPC boundary. This stub replaces the real
    // driver entirely, so without the same wrapper the tests would exercise a
    // DIFFERENT database layer from the one that ships — and would keep
    // reporting crashes the application no longer has, or worse, miss ones it
    // does. The two must behave identically.
    const unbindable = (v) =>
      v !== null && v !== undefined
      && typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'bigint'
      && typeof v !== 'boolean'
      && !Buffer.isBuffer(v) && !(v instanceof Uint8Array);
    const bad = (args) => {
      for (const a of args) {
        if (a === undefined) return true;
        if (a !== null && typeof a === 'object' && !Buffer.isBuffer(a) && !(a instanceof Uint8Array)) {
          if (Array.isArray(a)) return true;
          for (const v of Object.values(a)) if (v === undefined || unbindable(v)) return true;
          continue;
        }
        if (unbindable(a)) return true;
      }
      return false;
    };
    // A refused WRITE throws; a refused READ answers empty. Mirrors the same
    // split in `hardenBinding`, and for the same measured reason: a write that
    // returns `{changes: 0}` lets the enclosing transaction COMMIT with one of
    // its statements silently dropped, so the document and the balance
    // disagree with nothing raised. See connection.ts for the measurement.
    const writes = isWriteStatement(sql);
    const guard = (method, fn, empty) => (...a) => {
      if (bad(a)) {
        const shortSql = sql.slice(0, 90).replace(/\s+/g, ' ');
        console.error(`[DB] refused an unbindable parameter for: ${shortSql}`);
        if (writes) {
          throw new Error(`[DB] refused to run a write with an unbindable parameter: ${shortSql}`);
        }
        return typeof empty === 'function' ? empty() : empty;
      }
      return fn(...a);
    };
    return {
      // better-sqlite3 accepts either positional args or a single object for
      // named parameters; node:sqlite behaves the same way.
      run: guard('run', (...a) => st.run(...a), () => ({ changes: 0, lastInsertRowid: 0 })),
      get: guard('get', (...a) => st.get(...a) ?? undefined, undefined),
      all: guard('all', (...a) => st.all(...a), () => []),
      iterate: guard('iterate', (...a) => st.all(...a)[Symbol.iterator](), () => [][Symbol.iterator]()),
      pluck: () => ({ get: guard('get', (...a) => Object.values(st.get(...a) ?? {})[0], undefined) }),
    };
  }

  exec(sql) { return this._db.exec(sql); }

  /**
   * better-sqlite3 returns a callable that opens a transaction when invoked.
   * Nested calls must NOT open a second transaction — several handlers call one
   * transactional helper from inside another — so the depth is tracked.
   */
  transaction(fn) {
    const self = this;
    return function wrapped(...args) {
      // `_inTx` only tracks transactions this wrapper opened. The runtime book
      // guard opens a SAVEPOINT with `exec`, which puts the connection in a
      // transaction without this flag knowing — and the stub then issued a
      // second BEGIN and failed with "cannot start a transaction within a
      // transaction". Real better-sqlite3 converts a nested transaction into a
      // savepoint and copes fine (measured), so the stub must ask the driver
      // rather than rely on its own bookkeeping.
      if (self._inTx || self._db.isTransaction) return fn.apply(this, args);
      self._inTx = true;
      self._db.exec('BEGIN');
      try {
        const out = fn.apply(this, args);
        self._db.exec('COMMIT');
        return out;
      } catch (err) {
        try { self._db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      } finally {
        self._inTx = false;
      }
    };
  }

  pragma(str) {
    try { return this._db.exec(`PRAGMA ${str}`); } catch { return undefined; }
  }

  backup() { return Promise.resolve(); }
  close() { this._db.close(); }
  get name() { return ':memory:'; }
}

export default Wrapped;
