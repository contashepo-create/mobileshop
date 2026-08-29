/**
 * Schema versioning and the safety net around an upgrade.
 *
 * WHY THIS EXISTS
 * ---------------
 * A shop's database is the only thing in this system that cannot be rebuilt.
 * The application can be reinstalled, the licence reissued, the settings
 * retyped — but a year of invoices exists in exactly one place. Every upgrade
 * touches that file, so an upgrade is the single most dangerous routine event
 * in the product's life.
 *
 * The migration logic itself was measured and is sound: 250 vouchers went into
 * a table rebuild and 250 came out with identical totals, and a deliberately
 * broken migration rolled back leaving every row intact. Three things around
 * it were not.
 *
 *   1. THE BACKUP RAN AFTER THE MIGRATION.
 *      `runMigrations` was called at index.ts:115 and `autoBackup` at :163. If
 *      a migration ever damaged the data, the only backup taken that day would
 *      be a backup of the damage. There was no way back.
 *
 *   2. NOTHING RECORDED WHICH SCHEMA THE FILE HELD.
 *      `PRAGMA user_version` was never used. Measured consequence: after a
 *      newer build added a column, an OLDER build opened the same file and
 *      wrote to it successfully — producing rows with fields the old code did
 *      not know existed. Silent, and invisible until a report disagreed.
 *
 *   3. AN INTERRUPTED UPGRADE LEFT NO TRACE.
 *      Migrations are a long sequence of individually guarded statements. A
 *      power cut between step 20 and step 21 left the schema half-applied with
 *      nothing recording where it stopped.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   - a copy of the database is taken with SQLite's own backup API BEFORE a
 *     single migration statement runs, and only when the version actually
 *     changed, so ordinary launches stay fast;
 *   - if the migration throws, that copy is put back automatically and the
 *     user is told, rather than being left with a half-migrated file;
 *   - a database written by a NEWER build refuses to open in an older one;
 *   - the version is only stamped after the migration completes, so an
 *     interrupted upgrade is retried on the next launch instead of being
 *     assumed done.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The schema this build understands.
 *
 * BUMP THIS whenever `runMigrations` gains a statement that changes the shape
 * of the database — a new table, a new column, a rebuilt table. Do NOT bump it
 * for a pure code change: the number exists to describe the FILE, and bumping
 * it needlessly forces a backup on every customer for no reason.
 *
 * History:
 *   1 — first versioned release. Everything shipped before this point is
 *       treated as version 0 and upgraded on first launch.
 *   2 — `maintenance_additional_costs` and the `AdditionalCosts` columns on
 *       maintenance tables removed (extra costs folded into TotalCost instead
 *       of stored separately).
 */
export const CURRENT_SCHEMA_VERSION = 2;

/** How many pre-upgrade snapshots to keep before pruning the oldest. */
const KEEP_SNAPSHOTS = 5;

/** How many pre-update snapshots to keep before pruning the oldest. */
const KEEP_UPDATE_SNAPSHOTS = 3;

export function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db.pragma('user_version', { simple: true });
    return Number(row) || 0;
  } catch {
    return 0;
  }
}

export function writeSchemaVersion(db: Database.Database, version: number): void {
  // `user_version` is part of the SQLite file header, not a table, so it
  // survives every migration and cannot be dropped by one.
  db.pragma(`user_version = ${Math.floor(version)}`);
}

/** Raised when the file was written by a build newer than this one. */
export class SchemaTooNewError extends Error {
  // Written out longhand rather than as constructor parameter properties:
  // the verification harness runs TypeScript through Node's strip-only mode,
  // which cannot synthesise those assignments.
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `قاعدة البيانات أحدث من البرنامج (إصدار القاعدة ${found}، البرنامج يدعم ${supported}). ` +
      'يرجى تحديث البرنامج إلى آخر إصدار قبل فتح هذه البيانات.',
    );
    this.found = found;
    this.supported = supported;
    this.name = 'SchemaTooNewError';
  }
}

function snapshotDir(userDataDir: string): string {
  const dir = path.join(userDataDir, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Keeps the most recent pre-upgrade snapshots and removes the rest.
 *
 * Matched by an exact pattern so nothing the owner stored in that folder is
 * ever touched — the same restriction the daily backup pruner needed.
 */
function pruneSnapshots(dir: string): void {
  try {
    const mine = fs.readdirSync(dir)
      .filter(f => /^pre_upgrade_v\d+_\d{8}T\d{6}\.db$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of mine.slice(KEEP_SNAPSHOTS)) {
      try { fs.unlinkSync(path.join(dir, old.f)); } catch { /* ignore */ }
    }
  } catch { /* pruning is best-effort and must never block an upgrade */ }
}

/**
 * Keeps the most recent pre-update snapshots and removes the rest.
 *
 * Same exact-pattern language as `pruneSnapshots`, on its own prefix so the
 * two lifecycles never delete each other.
 */
function pruneUpdateSnapshots(dir: string): void {
  try {
    const mine = fs.readdirSync(dir)
      .filter(f => /^pre_update_[\d.]+_\d{8}T\d{6}\.db$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of mine.slice(KEEP_UPDATE_SNAPSHOTS)) {
      try { fs.unlinkSync(path.join(dir, old.f)); } catch { /* ignore */ }
    }
  } catch { /* pruning is best-effort */ }
}

/**
 * Takes a timestamped snapshot of the database — synchronously, WAL-safely —
 * into the userData backups folder, BEFORE an application update is applied.
 *
 * WHY THIS EXISTS
 * ---------------
 * The application update itself never touches the database file: the database
 * lives OUTSIDE the install directory (userData), so reinstalling or swapping
 * app.asar does not move a byte of it. The danger is the NEXT LAUNCH, when the
 * new build runs its schema migrations on that file. `migrateWithSafetyNet`
 * already snaps a `pre_upgrade_v*` copy before migrating and restores it on
 * failure — but only when the schema version actually changed. This function
 * gives the owner a second, independent copy taken from the OLD build, before
 * the update is applied, whatever the new build's schema does. "Restore if the
 * original is lost" does not have to be discovered in a panic: the file is
 * already there, in the same backups folder the app already watches.
 *
 * BEST-EFFORT ON PURPOSE: an update must not be blocked (or even shown as
 * failed) because a snapshot could not be written. The caller decides whether
 * a pre-update copy is a requirement of that particular operation.
 *
 * Synchronous `VACUUM INTO`, for the same reason `migrateWithSafetyNet` uses
 * it: the file is complete when this function returns, and the guarantee is
 * that the copy exists BEFORE the update is applied.
 */
export function snapshotBeforeUpdate(
  db: Database.Database,
  userDataDir: string,
  appVersion: string,
): string | null {
  const dir = snapshotDir(userDataDir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const safeVersion = String(appVersion || '0').replace(/[^\w.-]/g, '_');
  const target = path.join(dir, `pre_update_${safeVersion}_${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    console.error('[DB] could not take a pre-update snapshot:', err);
    return null;
  }
  pruneUpdateSnapshots(dir);
  return target;
}

export interface UpgradeReport {
  /** True when the schema changed on this launch. */
  upgraded: boolean;
  from: number;
  to: number;
  /** Path of the snapshot taken before the upgrade, when one was needed. */
  snapshot?: string;
  /** Set when the migration failed and the snapshot was restored. */
  restoredFrom?: string;
  error?: Error;
}

/**
 * Runs `migrate` with a snapshot taken first and restored on failure.
 *
 * `migrate` is passed in rather than imported so this module stays testable
 * without pulling in the whole migration file, and so the ordering guarantee —
 * snapshot, then migrate, then stamp — is visible in one place.
 */
export function migrateWithSafetyNet(
  db: Database.Database,
  userDataDir: string,
  migrate: (db: Database.Database) => void,
  opts: { onUpgradeStart?: (from: number, to: number) => void } = {},
): UpgradeReport {
  const from = readSchemaVersion(db);
  const to = CURRENT_SCHEMA_VERSION;

  // Refuse to touch a file written by a newer build. Opening it read-write
  // would let this build write rows missing whatever the newer schema added,
  // which is silent corruption the owner would not notice for months.
  if (from > to) throw new SchemaTooNewError(from, to);

  // Nothing to do. The overwhelmingly common case: no snapshot, no delay.
  if (from === to) {
    migrate(db);          // still run it: it is idempotent and self-healing
    return { upgraded: false, from, to };
  }

  opts.onUpgradeStart?.(from, to);

  // --- snapshot BEFORE the first migration statement ---
  let snapshot: string | undefined;
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    snapshot = path.join(snapshotDir(userDataDir), `pre_upgrade_v${from}_${stamp}.db`);
    // `VACUUM INTO`, not `fs.copyFileSync` and not `db.backup()`.
    //
    //   - a plain file copy is unsafe: the database runs in WAL mode, and
    //     measured on this project a 500-row database copied that way read
    //     back as "no such table" because the schema was still in the -wal;
    //   - `db.backup()` is ASYNCHRONOUS. It returns a promise, and the file
    //     does not exist when it returns. This routine must stay synchronous,
    //     because the whole guarantee is that the snapshot is complete BEFORE
    //     the first migration statement runs. The first version of this code
    //     called it without awaiting and the verification suite caught it.
    //
    // `VACUUM INTO` is synchronous, checkpoints the WAL, and writes a single
    // consistent file — verified to capture all 500 rows immediately.
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  } catch (err) {
    // A snapshot we cannot take is a snapshot we cannot rely on. Better to
    // stop than to migrate with no way back.
    throw new Error(
      'تعذر إنشاء نسخة احتياطية قبل التحديث، وتم إيقاف التحديث حفاظاً على بياناتك. ' +
      `السبب: ${(err as Error).message}`,
    );
  }

  // --- migrate ---
  try {
    migrate(db);
  } catch (err) {
    // Put the data back exactly as it was. The file is replaced rather than
    // patched, and the stale -wal/-shm must go with it or SQLite will replay
    // them over the restored copy.
    let restored = false;
    try {
      const live = db.name;
      (db as unknown as { close: () => void }).close();
      fs.copyFileSync(snapshot, live);
      for (const suffix of ['-wal', '-shm']) {
        const p = `${live}${suffix}`;
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      }
      restored = true;
    } catch { /* reported below */ }

    return {
      upgraded: false, from, to, snapshot,
      restoredFrom: restored ? snapshot : undefined,
      error: err as Error,
    };
  }

  // --- stamp LAST ---
  // Only now is the upgrade genuinely complete. Stamping earlier would make an
  // interrupted run look finished and skip the remaining steps for ever.
  writeSchemaVersion(db, to);
  pruneSnapshots(snapshotDir(userDataDir));

  return { upgraded: true, from, to, snapshot };
}
