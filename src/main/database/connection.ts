import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

let db: Database.Database | null = null;

/**
 * The directory the application was installed into.
 *
 * SUPPORTS BOTH PACKAGING SYSTEMS, WHICH DIFFER in where the exe sits:
 *
 * Squirrel (the old installer):
 *   C:\Users\me\AppData\Local\MobileShopERP\app-1.0.0\MobileShopERP.exe
 *   A version-specific `app-x.x.x` folder that is replaced on every update,
 *   so data lives in its PARENT (the Squirrel root) to survive updates.
 *
 * NSIS (the current installer):
 *   C:\Program Files\MobileShopERP\MobileShopERP.exe      (all users)
 *   C:\Users\me\AppData\Local\Programs\...\MobileShopERP.exe (per-user)
 *   The exe sits DIRECTLY in the install directory — there is no `app-x.x.x`
 *   layer. For a per-machine install that directory is under Program Files,
 *   which a normal user cannot write, so business data is never kept there
 *   either; see defaultDbPath() / settingsFile() below.
 *
 * The layout is told apart by the name of the folder holding the exe: a
 * Squirrel version folder is `app-<version>`, an NSIS install folder is not.
 */
function installRoot(): string {
  if (app.isPackaged) {
    const exe = app.getPath('exe');
    const appDir = path.dirname(exe);          // ...\MobileShopERP\app-1.0.0\  or  ...\MobileShopERP\
    const dirName = path.basename(appDir);
    if (/^app-/.test(dirName)) {
      return path.dirname(appDir);             // Squirrel root
    }
    return appDir;                              // NSIS install directory
  }
  return app.getPath('userData');
}

/**
 * The user-scoped data folder: `app.getPath('userData')` (Roaming).
 *
 * This is the ONE folder the app can always write to, whatever the install
 * mode: per-user NSIS installs are user-writable, per-machine installs point
 * at Program Files, which a normal login cannot write to. The database and the
 * settings file live here so a store on a shared PC keeps its own data and a
 * per-machine update cannot be blocked by a read-only install directory.
 *
 * NOTE ON THE DOUBLE-NESTED LAYOUT HELD HERE FROM 1.0.6 (REVERTED):
 * This used to be `path.join(app.getPath('userData'), 'mobile-shop-erp')` —
 * Electron's `userData` for this app is ALREADY `%APPDATA%\mobile-shop-erp`,
 * so the app silently added one segment and the packaged build opened
 * `%APPDATA%\mobile-shop-erp\mobile-shop-erp\mobile_shop.db`, a FRESH and
 * EMPTY database, while every real sale sat in the flat
 * `%APPDATA%\mobile-shop-erp\mobile_shop.db`. Upgrading a shop to 1.0.6 made
 * its invoices vanish. The fold-down below (and the legacy rescue in
 * `defaultDbPath`) restore the flat file as the single source of truth.
 */
function userDataRoot(): string {
  return app.getPath('userData');
}

/**
 * Where the custom-path setting lives. Read before the database is open.
 *
 * Written to userDataRoot (writable) so the app's own "change DB path"
 * action is not blocked on a per-machine install; also read from the install
 * directory so the NSIS installer's chosen path (written at install time to
 * `$INSTDIR\db_settings.json`, where the elevated installer CAN write) is
 * honoured on the very first launch. The install-dir copy only ever tells the
 * app where to START — after that, changes go to the user-scoped copy.
 */
function settingsFile(): string {
  if (app.isPackaged) {
    const installed = path.join(installRoot(), 'db_settings.json');
    const user = path.join(userDataRoot(), 'db_settings.json');
    // A 1.0.6 install wrote its settings into the double-nested folder (see
    // userDataRoot note). Honour that copy one last time so a shop that set a
    // custom database path does not silently lose it after upgrading.
    const legacyNested = path.join(userDataRoot(), 'mobile-shop-erp', 'db_settings.json');
    if (!fs.existsSync(user) && fs.existsSync(legacyNested)) return legacyNested;
    // Prefer the installer's choice while it is the only one; once the app has
    // written a user-scoped copy, that copy is authoritative.
    return fs.existsSync(user) ? user : installed;
  }
  return path.join(app.getPath('userData'), 'db_settings.json');
}

/** The default location, used whenever no valid custom path is configured. */
function defaultDbPath(): string {
  if (app.isPackaged) {
    // NSIS per-machine installs land under Program Files, which is read-only
    // for a normal user — never store data there. Roaming is always writable.
    const roaming = path.join(userDataRoot(), 'mobile_shop.db');
    if (fs.existsSync(roaming)) return roaming;

    // A legacy Squirrel install kept the database in the Squirrel ROOT
    // (note: installRoot() answers that root for an `app-x.y.z` layout, and
    // the NSIS install directory otherwise). If a store upgraded from
    // Squirrel — or kept data in the flat Roaming file from the dev/unpacked
    // layout — the default above is a NEW and EMPTY database. Prefer the file
    // that actually has the shop's data over silently starting fresh.
    const legacy = path.join(installRoot(), 'mobile_shop.db');
    if (legacy !== roaming && fs.existsSync(legacy)) {
      console.log('[DB] Adopting legacy database location:', legacy);
      return legacy;
    }
    return roaming;
  }
  return path.join(app.getPath('userData'), 'mobile_shop.db');
}

/**
 * The configured custom path, or null.
 *
 * SINGLE SOURCE OF TRUTH. `getDb()` and `getDbPath()` previously each parsed
 * db_settings.json with their OWN rules and could disagree:
 *
 *   - `getDb()` required `fs.existsSync(settings.dbPath)` and silently fell
 *     back to the default when the file was not reachable;
 *   - `getDbPath()` returned the configured path unconditionally.
 *
 * On a shop whose database sits on a network share, that divergence is a
 * data-loss trap. If the share is offline at launch, the app quietly opens a
 * DIFFERENT (usually empty) database and carries on as if nothing happened —
 * while `backup:restore`, which targets `getDbPath()`, writes the restored
 * data to the unreachable network file. The owner sees an empty shop, restores
 * a backup, is told it succeeded, and still sees an empty shop.
 *
 * Both callers now go through here, so they cannot drift apart again.
 */
function configuredDbPath(): string | null {
  const file = settingsFile();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file);
    const text = decodeSettings(raw);
    // The NSIS installer (installer.nsh) writes db_settings.json with
    // FileWriteUTF16LE and literal Windows backslashes — e.g.
    //   {"dbPath":"C:\ProgramData\MobileShopERP\mobile_shop.db"}
    // Those backslashes are not valid JSON escapes, so JSON.parse throws
    // "Bad escaped character" and the shop silently falls back to the
    // default path. Fix by escaping lone backslashes before parsing.
    const fixed = escapeLoneBackslashes(text);
    const settings = JSON.parse(fixed);
    const p = settings?.dbPath;
    if (typeof p !== 'string' || !p.trim()) return null;

    // PERSISTENCE: the installer writes db_settings.json to $INSTDIR, which is
    // DELETED on upgrade by the uninstaller. If the user chose a custom path
    // (e.g. D:\Data\mobile_shop.db) and never changed it from the settings UI,
    // there is no user-scoped copy — the path is lost on the next upgrade and
    // the shop opens an empty database as if it were new.
    //
    // Fix: the FIRST time we successfully read a path from the installer's
    // copy, save it to the user-scoped location (%APPDATA%\MobileShopERP\)
    // where it survives reinstalls. The user-scoped copy takes priority on
    // subsequent launches (see settingsFile()), so once saved the path is
    // permanent until the owner explicitly changes it.
    const userFile = path.join(userDataRoot(), 'db_settings.json');
    if (file !== userFile && !fs.existsSync(userFile)) {
      try {
        const dir = path.dirname(userFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(userFile, JSON.stringify({ dbPath: p }), 'utf-8');
        console.log('[DB] Persisted installer path to user settings:', userFile, '->', p);
      } catch (persistErr) {
        console.error('[DB] Failed to persist path to user settings (non-fatal):', persistErr);
      }
    }

    return p;
  } catch (err) {
    console.error('[DB] db_settings.json is unreadable, using the default path:', err);
    return null;
  }
}

/**
 * Makes an installer-written db_settings.json parseable when it is not already
 * valid JSON, without corrupting a file that is.
 *
 * The NSIS installer writes the raw path with LITERAL Windows backslashes —
 * `{"dbPath":"C:\ProgramData\MobileShopERP\mobile_shop.db"}` — which are not
 * valid JSON. A per-backslash lookahead cannot repair that safely: a backslash
 * followed by one of the JSON escape letters (`\t` in `C:\temp`, `\f` in
 * `C:\folder`, `\u` in `C:\Users\...`) is indistinguishable from a genuine
 * `\t`/`\n`/... escape inside a plain-text scan, and the wrong guess silently
 * rewrites the shop's database path.
 *
 * Windows forbids control characters (0x00–0x1F) in file names, so a parse
 * that SUCCEEDS but yields a path containing one is proof the file used
 * literal separators: double every backslash and parse again. A file written
 * by setDbPath (JSON.stringify, proper `\\` escapes) parses clean on the
 * first attempt and is returned untouched.
 */
function escapeLoneBackslashes(text: string): string {
  try {
    const settings = JSON.parse(text);
    const p = (settings as { dbPath?: unknown } | null)?.dbPath;
    // eslint-disable-next-line no-control-regex
    if (typeof p !== 'string' || !/[\u0000-\u001f]/.test(p)) return text;
  } catch {
    // Not valid JSON — treat every backslash as a literal separator below.
  }
  return text.replace(/\\/g, '\\\\');
}

/**
 * Decodes db_settings.json whatever encoding produced it.
 *
 * The NSIS installer writes UTF-16LE with a BOM; `fs.writeFileSync` writes
 * UTF-8 (optionally with a BOM). A BOM is authoritative when present; without
 * one, UTF-16 is detected by the runs of NUL bytes that ASCII in UTF-16LE
 * produces.
 */
function decodeSettings(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2);
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  // No BOM. ASCII in UTF-16LE is interleaved with 0x00 bytes; ASCII/UTF-8 is
  // not. Check the first few bytes for the UTF-16 pattern.
  const probe = Math.min(buf.length, 512);
  let utf16 = true;
  for (let i = 0; i + 1 < probe; i += 2) {
    if (buf[i + 1] !== 0x00) { utf16 = false; break; }
  }
  return utf16 ? buf.toString('utf16le') : buf.toString('utf8');
}

export function getDb(): Database.Database {
  if (!db) {
    const configured = configuredDbPath();
    let dbPath = configured ?? defaultDbPath();

    if (configured && !fs.existsSync(configured)) {
      // The database FILE is missing. Two very different situations arrive
      // here and they must not be treated the same way:
      //
      //   1. A FRESH INSTALL. The NSIS installer wrote db_settings.json with
      //      the shop's chosen data directory, but no `mobile_shop.db` has
      //      been created yet — SQLite creates it on first open. Falling back
      //      here would silently abandon the path the owner picked and use a
      //      different empty database instead.
      //   2. A NETWORK SHARE THAT IS OFFLINE. The file lives somewhere the
      //      machine cannot reach right now. Falling back is deliberate, but
      //      must be LOUD, because the shop is about to work in the WRONG
      //      database — work saved now will not be in the shared database.
      //
      // The two are told apart by the DIRECTORY: on a fresh install it exists
      // (the installer created it) or can be created; on an offline share the
      // mkdir fails. So the directory, not the file, decides.
      const dir = path.dirname(configured);
      let dirOk = true;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        dirOk = false;
      }
      if (!dirOk) {
        console.error(
          `[DB] Configured database not found and its directory is not ` +
          `reachable: ${configured}\n` +
          '[DB] Falling back to the default location. If this database lives on a ' +
          'network share, check the connection BEFORE entering any data — work ' +
          'saved now will not be in the shared database.',
        );
        dbPath = defaultDbPath();
      } else {
        console.log('[DB] First run with configured database path:', dbPath);
      }
    } else if (configured) {
      // The configured file EXISTS — but is it the RIGHT database? A code
      // update or an installer can create an EMPTY database at the configured
      // path while the shop's real data sits at the default Roaming location.
      // If the configured DB has NO user tables (fresh/empty) AND the default
      // path has a database WITH data, prefer the one with data. This is the
      // exact scenario that caused data loss: db_settings.json pointed at
      // C:\ProgramData\...\mobile_shop.db which was empty, while the real
      // data lived in %APPDATA%\mobile-shop-erp\mobile_shop.db.
      const defaultPath = defaultDbPath();
      if (configured !== defaultPath && fs.existsSync(defaultPath)) {
        try {
          const probe = new Database(configured, { readonly: true, fileMustExist: true });
          const tableCount = probe.prepare(
            "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          ).get() as { n: number };
          probe.close();
          if (tableCount.n === 0) {
            // The configured DB is empty — check if the default has data.
            const probeDefault = new Database(defaultPath, { readonly: true, fileMustExist: true });
            const defaultCount = probeDefault.prepare(
              "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            ).get() as { n: number };
            probeDefault.close();
            if (defaultCount.n > 0) {
              console.error(
                `[DB] Configured database "${configured}" is EMPTY (0 tables), ` +
                `but the default "${defaultPath}" has ${defaultCount.n} tables.\n` +
                '[DB] Using the default to prevent data loss. Delete db_settings.json ' +
                'if this was intentional (e.g. a fresh install).',
              );
              dbPath = defaultPath;
            }
          }
        } catch {
          // Cannot read the configured DB — let the normal open path handle it.
        }
      }
      console.log('[DB] Using database path:', dbPath);
    }

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);

    // WAL is the right journal for a local disk and the WRONG one for a network
    // share. It needs a shared-memory (-shm) file, which SMB and most network
    // filesystems do not implement correctly; SQLite's own documentation warns
    // that the result is corruption rather than an error. A shop running its
    // database from a shared folder — which `db:createNetwork` explicitly
    // offers — must therefore fall back to the older, slower, safe journal.
    const onNetworkShare = isNetworkPath(dbPath);
    if (onNetworkShare) {
      db.pragma('journal_mode = DELETE');
      console.log('[DB] network path detected — using DELETE journal (WAL is unsafe over SMB)');
    } else {
      db.pragma('journal_mode = WAL');
    }

    // How long a write waits for another machine before giving up.
    //
    // better-sqlite3 defaults to 5 seconds, which is fine for two clicks a
    // second apart and NOT fine for the case that actually happens: one
    // workstation runs a long report or the nightly backup while a cashier
    // rings up a sale. Measured with two real processes — an 8-second
    // transaction on machine A made machine B fail with SQLITE_BUSY after
    // 5,012 ms; with 15 seconds it waited 7,646 ms and completed.
    //
    // A failed sale is far worse than a slow one, so the wait is generous.
    db.pragma(`busy_timeout = ${onNetworkShare ? 30000 : 15000}`);

    db.pragma('foreign_keys = ON');
    hardenTransactions(db);
    hardenBinding(db);
    console.log('[DB] Connected to:', dbPath);
  }
  return db;
}

/**
 * Makes every `db.transaction(...)` in the program IMMEDIATE, and retries the
 * one error a busy timeout cannot fix.
 *
 * THE DEFECT THIS REPAIRS
 * -----------------------
 * better-sqlite3's `.transaction()` produces a DEFERRED transaction: the write
 * lock is taken at the first WRITE, not at `BEGIN`. Every financial handler in
 * this program does read-modify-write — check the stock, compute a cost, then
 * insert — so between the read and the write another till holds nothing back.
 *
 * Under WAL that does NOT silently corrupt the total; SQLite detects it and
 * fails the transaction with `SQLITE_BUSY_SNAPSHOT`. But that error is not
 * waitable: `busy_timeout` does nothing for it, because there is no lock to
 * wait for — the snapshot the reader holds is already stale. So the generous
 * 15-second timeout configured above never applies to it.
 *
 * MEASURED, two processes against one database file, each doing 40
 * read-modify-writes with a 5 ms gap between the read and the write:
 *
 *     worker A: 4 succeeded, 36 failed SQLITE_BUSY_SNAPSHOT
 *     worker B: 40 succeeded
 *     final counter 44, expected 80  — 36 operations rejected
 *
 * A rejected sale is not a lost sale — `ipcGuard` returns a failure and the
 * screen reports it — but the cashier sees "تعذّر تنفيذ العملية" on nearly
 * half of their sales while the second till is busy, which in a shop means the
 * software is broken.
 *
 * THE FIX
 * -------
 * `BEGIN IMMEDIATE` takes the write lock at the start, so the read and the
 * write are inside the same exclusive window and the interleave cannot happen.
 * Waiting for THAT lock is exactly what `busy_timeout` is for. A short retry
 * loop covers the remaining case where two processes reach `BEGIN IMMEDIATE`
 * at the same instant.
 *
 * Doing it here rather than at the 52 call sites means a handler written
 * tomorrow is safe without its author knowing any of this.
 */
/** Marks a connection as already wrapped, so wrapping cannot stack. */
const HARDENED = Symbol.for('mobileshop.transactionsHardened');


/** Marks a connection whose statements have already been bind-hardened. */
const BIND_HARDENED = Symbol.for('mobileshop.bindHardened');

/**
 * Turns a binding failure into a clean refusal instead of a crash.
 *
 * THE PROBLEM
 * -----------
 * better-sqlite3 throws when a value cannot be bound:
 *
 *     TypeError: Provided value cannot be bound to SQLite parameter 1.
 *
 * That is correct of the driver, but the throw escapes the handler and crosses
 * the IPC boundary as an unhandled rejection: the screen gets no reply at all,
 * so the button appears to do nothing and the failure is invisible.
 *
 * A sweep that called every channel with a malformed identifier — `undefined`,
 * `{}`, `[]` — found this on TWENTY-FIVE channels. Most are ordinary reads:
 * `items:get`, `sales:get`, `employees:statement`, `permissions:getByRole`.
 * The screens always pass a real id, which is exactly why nothing noticed. But
 * "no screen currently sends a bad value" is not a property of the code, it is
 * a property of today's callers, and the earlier audits found several places
 * where that assumption had already been broken.
 *
 * THE APPROACH
 * ------------
 * Patching each call site would mean editing about a hundred `.get(id)` calls
 * and hoping the next one is remembered. Wrapping `prepare` covers every
 * statement in the application, including any added later — the same reasoning
 * that put the transaction retry and the IPC guard where they are.
 *
 * A REJECTED READ RETURNS EMPTY rather than throwing: `undefined` from `.get`,
 * `[]` from `.all`. That is the honest answer — a row whose key is not a value
 * cannot exist — and it is what the handlers already expect when a lookup
 * finds nothing, so they produce their own "not found" message in Arabic
 * instead of a crash.
 *
 * A REJECTED WRITE THROWS. This is the opposite decision, and it is deliberate.
 *
 * WHY A WRITE MUST NOT FAIL QUIETLY
 * ---------------------------------
 * The first version of this wrapper answered a refused `run()` with
 * `{ changes: 0, lastInsertRowid: 0 }` and let execution continue. Measured
 * consequence, driving the real code:
 *
 *     db.transaction(() => {
 *       insert supplier A          -> committed
 *       insert supplier B (undefined phone) -> refused, {changes: 0}
 *     })()
 *     transaction threw: no
 *     suppliers 1 -> 2
 *
 * The transaction COMMITTED with one of its writes silently dropped. For a
 * read that behaviour is a repair; for a write it converts a loud crash — which
 * rolls the whole document back — into a quiet partial write that no report
 * can detect.
 *
 * It matters most on the statement that actually moves money:
 *
 *     UPDATE cash_accounts SET Balance = Balance - ? WHERE CashAccountID = ?
 *
 * MEASURED: with an unbindable amount the drawer stayed at 100,000, `run()`
 * returned `{changes: 0}`, and nothing was raised. A foreign key cannot catch
 * that — there is no child row and no missing parent, only an UPDATE that
 * matched nothing. A scan of `src/main/ipc` found 106 balance-moving UPDATE
 * statements, of which 103 never inspect `.changes`; from inside those
 * handlers a dropped write is indistinguishable from a successful one. The
 * invoice would say the customer paid and the drawer would disagree.
 *
 * So the two cases are separated by the VERB of the statement. Throwing is safe
 * here because `installIpcGuard` wraps every channel in `runSafely`, which
 * turns a throw into the structured Arabic failure the renderer already
 * understands — and because the throw happens BEFORE the statement runs, so
 * the enclosing transaction rolls back with nothing half-applied.
 *
 * Deliberately NOT silent in either case: the rejected value is logged with the
 * statement, so a caller passing rubbish is still visible to the developer.
 */
function hardenBinding(conn: Database.Database): void {
  const marked = conn as unknown as Record<symbol, boolean>;
  if (marked[BIND_HARDENED]) return;
  marked[BIND_HARDENED] = true;

  const originalPrepare = conn.prepare.bind(conn);

  /** True for a value better-sqlite3 will refuse to bind. */
  const unbindable = (v: unknown): boolean =>
    v !== null
    && typeof v !== 'number'
    && typeof v !== 'string'
    && typeof v !== 'bigint'
    && !Buffer.isBuffer(v)
    && !(v instanceof Uint8Array)
    && v !== undefined
    && typeof v !== 'boolean';

  const hasBadArg = (args: unknown[]): boolean => {
    for (const a of args) {
      if (a === undefined) return true;
      if (a !== null && typeof a === 'object' && !Buffer.isBuffer(a) && !(a instanceof Uint8Array)) {
        // A named-parameter object is legitimate; its VALUES are checked.
        if (Array.isArray(a)) return true;
        for (const v of Object.values(a as Record<string, unknown>)) {
          if (v === undefined || unbindable(v)) return true;
        }
        continue;
      }
      if (unbindable(a)) return true;
    }
    return false;
  };

  (conn as unknown as { prepare: unknown }).prepare = ((rawSql: string) => {
    const sql = roundBalanceArithmetic(rawSql);
    const stmt = originalPrepare(sql) as unknown as Record<string, unknown>;
    // Decided from the SQL, once per statement, not per call. A statement that
    // changes rows must never be allowed to do nothing quietly; a statement
    // that only reads may safely answer "nothing found".
    const writes = isWriteStatement(sql);
    for (const method of ['get', 'all', 'run', 'iterate', 'pluck'] as const) {
      const fn = stmt[method];
      if (typeof fn !== 'function') continue;
      stmt[method] = function patched(this: unknown, ...args: unknown[]) {
        if (hasBadArg(args)) {
          const shortSql = sql.slice(0, 90).replace(/\s+/g, ' ');
          console.error(`[DB] refused an unbindable parameter for: ${shortSql}`);
          if (writes) {
            // Loud on purpose. See the comment above `hardenBinding`: a
            // dropped write inside a transaction commits the rest of the
            // document and leaves the books wrong with nothing to show for it.
            // `runSafely` in ipcGuard converts this into the structured Arabic
            // failure the renderer already handles.
            throw new Error(
              `[DB] refused to run a write with an unbindable parameter: ${shortSql}`,
            );
          }
          if (method === 'all') return [];
          if (method === 'iterate') return [][Symbol.iterator]();
          return undefined;
        }
        return (fn as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
    return stmt;
  }) as unknown as typeof conn.prepare;
}

/**
 * True when a statement can CHANGE data.
 *
 * Leading comments and whitespace are stripped first: several statements in
 * this project begin with a `--` explanation, and matching the raw text would
 * class those as reads. `WITH ... INSERT` and `EXPLAIN` are handled by looking
 * for the verb anywhere in the leading clause rather than only at position
 * zero, and the fallback is WRITE — an unrecognised statement is treated as
 * dangerous, because the cost of being wrong in that direction is an error
 * message, while the other direction is a silent wrong balance.
 */
/**
 * Rounds every running-balance UPDATE to the piastre, in SQL.
 *
 * THE DEFECT, MEASURED
 * --------------------
 * Every money column in this schema is REAL — a binary float. Individual
 * documents are fine: the handlers pass their totals through `money()`, so an
 * invoice of 0.1 + 0.2 is stored as exactly 0.3 (verified).
 *
 * The running balances are not, because they are never recomputed — they are
 * accumulated by 92 statements of the form
 *
 *     UPDATE customers SET Balance = Balance + ? WHERE CustomerID = ?
 *
 * and the addition happens inside SQLite, after `money()` has done its work.
 * Each step adds a value that is exact to the piastre to a total that is not,
 * and the error compounds. MEASURED, 300 credit sales of 33.33 driven through
 * the real handlers:
 *
 *     expected            9999.000000000000
 *     customers.Balance   9998.999999999982      <- 1.8e-11 short
 *
 * and separately a `cash_accounts.Balance` holding a fraction of a piastre.
 *
 * WHY THAT MATTERS EVEN THOUGH IT IS A HUNDRED-BILLIONTH OF A POUND
 * -----------------------------------------------------------------
 * Not because 9998.999999999982 prints wrong — it rounds to 9,999.00 on every
 * screen. It matters because of the COMPARISONS the program makes against
 * these numbers:
 *
 *   - `Balance = 0` decides whether a customer is settled. A residue of
 *     -1.8e-11 makes a fully-paid customer appear on the aging report forever,
 *     owing an amount that displays as 0.00 and cannot be collected or cleared.
 *   - `Balance >= amount` decides whether the drawer can pay. A drawer holding
 *     999.9999999999 refuses a payment of 1,000 that it can plainly make.
 *   - `CreditLimit` comparisons refuse a sale that is exactly at the limit.
 *
 * These are the failures a shop cannot diagnose, because every figure on
 * screen agrees with them.
 *
 * WHY HERE, AND WHY NOT decimal.js
 * ---------------------------------
 * The arithmetic happens in SQLite, so a JavaScript decimal library cannot see
 * it — `Balance = Balance + ?` never passes through JavaScript at all. The fix
 * has to be in the SQL, and `ROUND(..., 2)` is exactly the operation needed.
 * Verified against the same 300 sales: `ROUND(Balance + ?, 2)` yields
 * 9999.000000000000 exactly.
 *
 * Rewriting here rather than at the 92 call sites is the same reasoning as the
 * bind hardening above: the 93rd, written next month, is covered without its
 * author knowing any of this.
 *
 * Storing integer piastres instead would also work and is the textbook answer,
 * but it means changing 108 columns, every read, every report and every
 * existing database — a far larger surface for a defect than the one it
 * closes. The safe range here is not the constraint: 2^53 piastres is
 * 90 trillion pounds, ninety times the application's own MAX_AMOUNT ceiling.
 * The problem was never the magnitude, only the accumulation, and that is what
 * this repairs.
 */
function roundBalanceArithmetic(sql: string): string {
  // Narrow on purpose. Only the exact accumulate-in-place shape is rewritten,
  // matched on the balance column by name, so no other arithmetic in the
  // program can be altered by accident.
  if (!/\bSET\s+Balance\s*=\s*Balance\s*[+-]\s*\?/i.test(sql)) return sql;
  return sql.replace(
    /\bSET\s+Balance\s*=\s*Balance\s*([+-])\s*\?/gi,
    (_m, op: string) => `SET Balance = ROUND(Balance ${op} ?, 2)`,
  );
}

function isWriteStatement(sql: string): boolean {
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

function hardenTransactions(conn: Database.Database): void {
  // Applying the wrapper twice would nest a retry loop inside a retry loop:
  // 5 attempts would become 25, and the pauses would multiply with them, so a
  // contended write could block the main process for seconds. Called from one
  // place today, but a second caller must not be able to cause that.
  const marked = conn as unknown as Record<symbol, boolean>;
  if (marked[HARDENED]) return;
  marked[HARDENED] = true;

  const original = conn.transaction.bind(conn);

  // How many times to re-run a transaction that was rejected before it could
  // do anything. Only safe because the function is re-executed from the start:
  // nothing it did was committed, so there is nothing to undo.
  const MAX_ATTEMPTS = 5;

  (conn as unknown as { transaction: unknown }).transaction = ((fn: (...a: unknown[]) => unknown) => {
    const wrapped = original(fn as never) as unknown as {
      immediate: (...a: unknown[]) => unknown;
    };

    const run = (...args: unknown[]) => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return wrapped.immediate(...args);
        } catch (err) {
          const code = (err as { code?: string })?.code ?? '';
          // Only these mean "nothing happened, try again". Anything else — a
          // constraint violation, a bug — must surface immediately and must
          // NOT be retried, or a genuine refusal looks like a glitch.
          if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_SNAPSHOT') throw err;
          lastErr = err;
          // A tiny escalating pause so two tills do not keep colliding in
          // lockstep. Synchronous on purpose: this is the main process, and
          // the transaction must not be left half-open across an await.
          const until = Date.now() + attempt * 20;
          while (Date.now() < until) { /* spin briefly */ }
        }
      }
      throw lastErr;
    };

    // `.immediate`, `.exclusive` and `.deferred` are part of the public API.
    // Keep them working, and keep the retry on the two that can be retried.
    (run as unknown as Record<string, unknown>).immediate = run;
    (run as unknown as Record<string, unknown>).exclusive =
      (...a: unknown[]) => (wrapped as unknown as Record<string, (...x: unknown[]) => unknown>).exclusive(...a);
    (run as unknown as Record<string, unknown>).deferred =
      (...a: unknown[]) => (wrapped as unknown as Record<string, (...x: unknown[]) => unknown>).deferred(...a);
    return run;
  }) as unknown as typeof conn.transaction;
}

/**
 * True when the database lives on a network share rather than a local disk.
 *
 * Recognises a Windows UNC path and, on Unix, the usual mount points. A mapped
 * drive letter is
 * indistinguishable from a local one at this level — so this is a best-effort
 * signal, not a guarantee. It only ever makes the configuration MORE
 * conservative, so a false negative costs nothing beyond the old behaviour and
 * a false positive costs a little speed.
 */
function isNetworkPath(p: string): boolean {
  if (!p) return false;
  // Normalise to backslashes so a UNC path is recognisable whichever
  // separator the caller used.
  const win = p.replace(/\//g, '\\');
  if (win.startsWith('\\\\')) return true;              // \\server\share
  if (/^\/(mnt|media|net)\//.test(p)) return true;      // common Unix mounts
  return false;
}

/**
 * The path of the database the application is ACTUALLY using.
 *
 * When the connection is open this is taken from the live handle, so a restore
 * or a backup can never target a different file from the one being read.
 */
export function getDbPath(): string {
  if (db) return db.name;
  const configured = configuredDbPath();
  if (configured && fs.existsSync(configured)) return configured;
  return defaultDbPath();
}

export function setDbPath(newPath: string) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ dbPath: newPath }), 'utf-8');
  console.log('[DB] Path set to:', newPath);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
