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

class Wrapped {
  constructor(path, opts) {
    // node:sqlite rejects `undefined` for options, unlike better-sqlite3.
    this._db = opts
      ? new DatabaseSync(path ?? ':memory:', opts)
      : new DatabaseSync(path ?? ':memory:');
  }

  prepare(sql) {
    const st = this._db.prepare(sql);
    return {
      // better-sqlite3 accepts either positional args or a single object for
      // named parameters; node:sqlite behaves the same way.
      run: (...a) => st.run(...a),
      get: (...a) => st.get(...a) ?? undefined,
      all: (...a) => st.all(...a),
      iterate: (...a) => st.all(...a)[Symbol.iterator](),
      pluck: () => ({ get: (...a) => Object.values(st.get(...a) ?? {})[0] }),
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
