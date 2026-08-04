/**
 * SQLite-backed storage for the phase transition log (issues #1328, #1372, #1375).
 *
 * Replaces the append-only `.mcx/transitions.jsonl` file. The jsonl design had
 * three distinct failure modes, all of which are structural rather than
 * incidental:
 *
 *   1. #1328 — `appendFileSync` after a separate read/validate step is a
 *      read-modify-write race. Two concurrent `mcx phase run` invocations for
 *      the same work item both read the same history snapshot, both validate
 *      against it, and both append. A partial write (crash or entry > PIPE_BUF)
 *      leaves a torn line that readers then silently skip, dropping a
 *      `committed` entry and breaking the next transition.
 *   2. #1372 — the O_EXCL lockfile that mitigated (1) is not atomic on NFSv2
 *      and unreliable on many NFSv3 configurations, so the mitigation does not
 *      hold on shared mounts.
 *   3. #1375 — every read loaded and parsed the entire file, which grows one
 *      line per phase run forever.
 *
 * A single-writer SQLite transaction fixes all three at once: read-validate-
 * insert happens inside `BEGIN IMMEDIATE` (atomic, no advisory locking), reads
 * are indexed queries instead of full-file parses, and there is no line-level
 * write to tear.
 *
 * ## Journal mode: deliberately NOT WAL
 *
 * This store uses SQLite's default rollback journal, not WAL. WAL requires a
 * `-shm` shared-memory file that SQLite mmaps to coordinate readers and
 * writers; that mmap is not available on network filesystems, so a WAL
 * database on an NFS-mounted home directory either fails to open or corrupts.
 * NFS-mounted `~/` is exactly the environment #1372 is about, so WAL would
 * reintroduce the bug this store exists to fix. Rollback journal + a
 * `busy_timeout` uses POSIX locks only, which NFS does support.
 *
 * DO NOT "optimize" this to `PRAGMA journal_mode = WAL`. Transactions here are
 * single-digit-millisecond inserts; there is no throughput problem to solve,
 * and the tradeoff is correctness on shared mounts.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Default wait for a contended write lock before surfacing a busy error. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Current schema revision, recorded in `meta` for future migrations. */
const SCHEMA_VERSION = 1;

/** Suffix for a legacy jsonl claimed by an in-flight import. */
const IMPORTING_SUFFIX = ".importing.";

/**
 * Lifecycle status of a transition log entry.
 *
 * - `"attempted"`: intent was logged but the phase handler has not (yet)
 *   committed. Written before branch-guard / handler dispatch so attempts
 *   from feature branches or crashed handlers leave an audit trail.
 *   IGNORED by regression / graph-walk checks.
 * - `"committed"`: the phase handler ran to completion and the transition
 *   is now part of the work item's authoritative history.
 *
 * Legacy entries (written before issue #1381 re-entry fix) omit `status`;
 * readers treat missing `status` as `"committed"` for back-compat so old
 * logs continue to gate transitions the same way.
 */
export type TransitionStatus = "attempted" | "committed";

/** One record in the transition log. */
export interface TransitionLogEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** Work-item identifier, or null if transitioning outside a work item. */
  workItemId: string | null;
  /** Source phase; null for the very first transition (initial). */
  from: string | null;
  /** Target phase (guaranteed to be a declared phase). */
  to: string;
  /** When `--force` was used, the justification text. */
  forceMessage?: string;
  /** Two-phase commit status. Missing → "committed" (legacy). */
  status?: TransitionStatus;
}

/** True when `entry` should gate future transitions (committed or legacy). */
export function isCommitted(entry: TransitionLogEntry): boolean {
  return entry.status !== "attempted";
}

/**
 * Called once per corrupt line encountered while importing a legacy
 * `transitions.jsonl`. `lineNumber` is 1-based.
 *
 * Only fires during the one-time jsonl → SQLite migration; the SQLite store
 * itself cannot produce a partially-written record.
 */
export type OnCorruptLine = (lineNumber: number, line: string, err: unknown) => void;

/** Default corrupt-line sink: warn to stderr so silent log rot is visible. */
export function defaultOnCorruptLine(logPath: string): OnCorruptLine {
  return (lineNumber, line, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const preview = line.length > 80 ? `${line.slice(0, 77)}...` : line;
    process.stderr.write(`warn: corrupt transition log line ${logPath}:${lineNumber} (${msg}): ${preview}\n`);
  };
}

/**
 * Raised when the write lock could not be acquired. Distinguishes real
 * contention from a programming error so callers can retry or report
 * "another phase run is in progress".
 */
export class TransitionLockBusyError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `could not acquire the transition write lock on ${dbPath} within ${timeoutMs}ms — another phase run is in progress`,
      options,
    );
    this.name = "TransitionLockBusyError";
  }
}

/**
 * True when `err` is a SQLite lock-contention error, by code (never by message).
 *
 * The set is calibrated for the rollback journal this store deliberately uses
 * (see the journal-mode note above), which is why `SQLITE_PROTOCOL` is in it and
 * `SQLITE_BUSY_SNAPSHOT` is not:
 *
 * - `SQLITE_PROTOCOL` is what SQLite returns when the rollback journal's
 *   locking protocol fails to make progress — the flaky-`lockd` shared-mount
 *   case that justifies not using WAL in the first place. Omitting it meant the
 *   one environment the journal choice exists to serve surfaced a raw
 *   unclassified error instead of the typed, retryable one.
 * - `SQLITE_BUSY_SNAPSHOT` can only arise in WAL mode, so matching it here was
 *   dead code.
 *
 * `SQLITE_LOCKED` is retained: it is table-level contention and is reachable
 * under any journal mode.
 */
function isBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code === "SQLITE_PROTOCOL";
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Path of the SQLite database backing `logPath`.
 *
 * The whole public API is keyed on the historical jsonl path so callers
 * (`transitionLogPath()`, phase scripts, `.mcx.lock` consumers) need no
 * change: `.mcx/transitions.jsonl` → `.mcx/transitions.db`.
 */
export function transitionDbPath(logPath: string): string {
  const base = logPath.endsWith(".jsonl") ? logPath.slice(0, -".jsonl".length) : logPath;
  return `${base}.db`;
}

// ── Row mapping ────────────────────────────────────────────────────────

interface TransitionRow {
  ts: string;
  work_item_id: string | null;
  from_phase: string | null;
  to_phase: string;
  force_message: string | null;
  status: string | null;
}

/**
 * Narrow a stored status string. NULL is a legacy entry (no status column
 * value), and anything unrecognised is treated the same way — as committed —
 * because that is how pre-#1381 logs were interpreted. Only the exact literal
 * `"attempted"` downgrades an entry to audit-only, so a garbled value can
 * never silently stop gating transitions.
 */
function toStatus(raw: string | null): TransitionStatus | undefined {
  if (raw === "attempted") return "attempted";
  if (raw === "committed") return "committed";
  return undefined;
}

function rowToEntry(row: TransitionRow): TransitionLogEntry {
  const status = toStatus(row.status);
  return {
    ts: row.ts,
    workItemId: row.work_item_id,
    from: row.from_phase,
    to: row.to_phase,
    ...(row.force_message !== null ? { forceMessage: row.force_message } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

// ── Schema ─────────────────────────────────────────────────────────────

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transitions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      work_item_id  TEXT,
      from_phase    TEXT,
      to_phase      TEXT NOT NULL,
      force_message TEXT,
      status        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transitions_work_item ON transitions(work_item_id, id);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imported_files (
      name        TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );
  `);
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", ["schema_version", String(SCHEMA_VERSION)]);
}

// ── Legacy jsonl import ────────────────────────────────────────────────

function parseJsonlEntries(text: string, onCorrupt: OnCorruptLine): TransitionLogEntry[] {
  const out: TransitionLogEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        out.push(parsed as TransitionLogEntry);
      }
    } catch (err) {
      onCorrupt(i + 1, line, err);
    }
  }
  return out;
}

function insertEntries(db: Database, entries: readonly TransitionLogEntry[]): void {
  const stmt = db.prepare(
    "INSERT INTO transitions (ts, work_item_id, from_phase, to_phase, force_message, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const e of entries) {
    stmt.run(e.ts, e.workItemId, e.from, e.to, e.forceMessage ?? null, e.status ?? null);
  }
}

/** Candidate park name: the plain `.migrated`, else a nonce-suffixed sibling. */
function migratedPath(logPath: string): string {
  const first = `${logPath}.migrated`;
  if (!existsSync(first)) return first;
  return `${first}.${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Import one claimed staging file into the DB. Must run inside the caller's
 * write transaction, and the file must be parked with `parkStagingFile` only
 * after that transaction commits.
 *
 * Exactly-once is enforced by the `imported_files` row, written in the same
 * transaction as the entries. A crash before COMMIT rolls the whole thing back
 * and the staging file is retried on the next open; a crash after COMMIT but
 * before the file is parked leaves the row behind, so the retry skips the
 * insert and only parks the file. The data is never in neither place, and
 * never in both.
 */
function importStagingFile(db: Database, staging: string, onCorrupt: OnCorruptLine): void {
  const name = basename(staging);
  const already = db.query<{ name: string }, [string]>("SELECT name FROM imported_files WHERE name = ?").get(name);
  if (already !== null) return;
  insertEntries(db, parseJsonlEntries(readFileSync(staging, "utf-8"), onCorrupt));
  db.run("INSERT INTO imported_files (name, imported_at) VALUES (?, ?)", [name, new Date().toISOString()]);
}

/**
 * Park a fully-committed staging file beside the log, never deleting log data
 * and never overwriting an older park.
 *
 * `link(2)` + `unlink(2)` rather than `rename(2)`, because rename silently
 * replaces an existing destination: two parks landing in the same millisecond
 * computed the same `.migrated.<Date.now()>` name and the older parked
 * generation was destroyed. That file is precisely the artifact recovery reads
 * from when the DB is the thing that went wrong (#2962), so a nonce alone is not
 * enough — `link` fails `EEXIST` atomically, which closes the check-then-rename
 * window that no amount of name entropy can.
 *
 * Unlinking the staging path after a successful link removes a *name*, not data:
 * the content is already reachable under the parked name at that point.
 */
function parkStagingFile(staging: string, logPath: string): void {
  for (;;) {
    try {
      linkSync(staging, migratedPath(logPath));
    } catch (err) {
      const code = errnoCode(err);
      // ENOENT: a concurrent process already parked it. Both processes agree the
      // import committed, so there is nothing left to do.
      if (code === "ENOENT") return;
      // EEXIST: lost the race for that name; migratedPath picks a fresh nonce.
      if (code === "EEXIST") continue;
      throw err;
    }
    unlinkSync(staging);
    return;
  }
}

/** Staging files left behind by a crash mid-import, oldest claim first. */
function findAbandonedStagingFiles(logPath: string): string[] {
  const dir = dirname(logPath);
  const prefix = `${basename(logPath)}${IMPORTING_SUFFIX}`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
  // Nonces are `<Date.now()>-<random>`, so a lexical sort replays claims in
  // the order they were made (Date.now() is a fixed 13 digits for centuries).
  return names
    .filter((n) => n.startsWith(prefix))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Migrate a legacy `transitions.jsonl` into the DB, if one is present. Returns
 * the staging files to park once the caller's transaction commits.
 *
 * Claiming is done by `rename(2)` rather than a lockfile: the first process to
 * rename the jsonl to a private staging name owns the import, and every other
 * process's rename fails with ENOENT. rename is atomic on POSIX and on NFS, so
 * unlike the O_EXCL lockfile in #1372 this cannot double-claim on a shared
 * mount — and no advisory lock is involved.
 *
 * This MUST be called with the write lock already held. Running it before
 * `BEGIN IMMEDIATE` reintroduces #1328 in a new shape: a second process can
 * observe "nothing to import" in the window between another process's
 * directory scan and its claiming rename, then commit its own entry ahead of
 * the imported history — leaving the log out of insertion order and the second
 * process's transition validated against an empty history.
 */
function migrateLegacyJsonl(db: Database, logPath: string, onCorrupt: OnCorruptLine): string[] {
  const staged: string[] = [];
  for (const abandoned of findAbandonedStagingFiles(logPath)) {
    importStagingFile(db, abandoned, onCorrupt);
    staged.push(abandoned);
  }

  if (!existsSync(logPath)) return staged;

  const staging = `${logPath}${IMPORTING_SUFFIX}${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(logPath, staging);
  } catch (err) {
    // ENOENT: another process claimed the jsonl first — it owns the import.
    if (errnoCode(err) === "ENOENT") return staged;
    throw err;
  }
  importStagingFile(db, staging, onCorrupt);
  staged.push(staging);
  return staged;
}

// ── Connection lifecycle ───────────────────────────────────────────────

function configure(db: Database, busyTimeoutMs: number): void {
  // Rollback journal (the default) is retained deliberately — see the
  // "Journal mode: deliberately NOT WAL" note at the top of this file.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
}

/**
 * Extra COMMIT attempts before a contended commit is finally given up on. Each
 * attempt independently waits up to `busy_timeout`, so this only has to cover a
 * reader that reappears between attempts, not the wait itself.
 */
const COMMIT_RETRY_ATTEMPTS = 2;

/**
 * COMMIT, retrying while SQLite reports lock contention.
 *
 * A busy COMMIT is **not** a failed transaction. In rollback-journal mode COMMIT
 * must upgrade RESERVED → EXCLUSIVE, which any concurrent reader holding SHARED
 * blocks; when that wait expires SQLite returns SQLITE_BUSY and leaves the
 * transaction **active**. Treating it as a failure would roll back an entry that
 * had already passed validation and then misreport it as somebody else's
 * contention ("another phase run is in progress") — a silent lost write.
 *
 * Reproduced with a second process holding a read transaction open across the
 * commit point: COMMIT raised SQLITE_BUSY after the busy_timeout, `BEGIN
 * IMMEDIATE` then failed with "cannot start a transaction within a transaction"
 * (proving the transaction was still live), and retrying COMMIT once the reader
 * released committed the same entry successfully.
 *
 * If the retries are exhausted the entry genuinely cannot be committed, so the
 * caller's rollback and `TransitionLockBusyError` are accurate at that point.
 */
function commitWithRetry(db: Database): void {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("COMMIT");
      return;
    } catch (err) {
      if (attempt >= COMMIT_RETRY_ATTEMPTS || !isBusyError(err)) throw err;
    }
  }
}

function rollbackQuietly(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch (err) {
    // A failed rollback means the transaction was already aborted by SQLite
    // (the common case for a constraint violation). The original error is
    // about to be rethrown by the caller and is the more useful one.
    void err;
  }
}

export interface StoreOptions {
  /** How long to wait for a contended write lock. */
  timeoutMs?: number;
  /** Corrupt-line sink for the one-time legacy jsonl import. */
  onCorrupt?: OnCorruptLine;
}

/**
 * Open the store for writing, creating the file and schema as needed. The
 * legacy-jsonl import deliberately does NOT happen here — it runs inside the
 * write transaction (see `migrateLegacyJsonl`). Caller must `close()`.
 */
function openForWrite(logPath: string, opts: StoreOptions = {}): Database {
  const dbPath = transitionDbPath(logPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    configure(db, opts.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    applySchema(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Open the store for reading, or return null when nothing has ever been
 * written. Reads must not materialise a database file as a side effect —
 * `readTransitionHistory` on a fresh repo answers "no history" without
 * touching the disk.
 */
function openForRead(logPath: string, opts: StoreOptions = {}): Database | null {
  const dbPath = transitionDbPath(logPath);
  if (existsSync(logPath) || findAbandonedStagingFiles(logPath).length > 0) {
    // A pending import has to run under the write lock, so a read that finds
    // one drives an otherwise-empty write transaction to completion first.
    withDbTx(logPath, () => {}, opts);
  }
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    configure(db, opts.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Run `fn` inside a single `BEGIN IMMEDIATE` write transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so a read-validate-insert
 * cycle inside `fn` cannot interleave with another process's cycle: this is
 * what makes `commitTransition` atomic without the lockfile from #1368/#1372.
 * Concurrent writers serialise on SQLite's own lock and wait up to
 * `busy_timeout`, after which they get a `TransitionLockBusyError`.
 */
function withDbTx<T>(logPath: string, fn: (db: Database) => T, opts: StoreOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const dbPath = transitionDbPath(logPath);
  const asLockError = (err: unknown): unknown =>
    isBusyError(err) ? new TransitionLockBusyError(dbPath, timeoutMs, { cause: err }) : err;

  // `applySchema` writes (`CREATE TABLE IF NOT EXISTS` + an `INSERT OR IGNORE`
  // into `meta`), so opening for write can itself lose the lock race to a
  // concurrent reader or writer. Classify it here or it escapes as a raw
  // SQLiteError that no caller knows to treat as contention.
  let db: Database;
  try {
    db = openForWrite(logPath, { ...opts, timeoutMs });
  } catch (err) {
    throw asLockError(err);
  }
  try {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      throw asLockError(err);
    }
    try {
      // Inside the lock: the imported history is guaranteed to precede anything
      // `fn` inserts, and `fn` validates against the full history.
      const staged = migrateLegacyJsonl(db, logPath, opts.onCorrupt ?? defaultOnCorruptLine(logPath));
      const result = fn(db);
      if (result instanceof Promise) {
        // The transaction would commit before the async work completed, so the
        // "atomic read-validate-append" guarantee would silently not hold.
        throw new Error("withTransitionWriter: fn must be synchronous (returned a Promise)");
      }
      commitWithRetry(db);
      for (const staging of staged) parkStagingFile(staging, logPath);
      return result;
    } catch (err) {
      rollbackQuietly(db);
      throw asLockError(err);
    }
  } finally {
    // Load-bearing beyond releasing the fd: `bun:sqlite` closes the handle when
    // the `Database` is garbage-collected, and closing mid-transaction rolls it
    // back. This `finally` is what keeps `db` reachable for the whole
    // transaction. Do not "simplify" it into a bare `using`/drop — a `db` whose
    // last reference dies before COMMIT loses the write silently.
    db.close();
  }
}

/**
 * Read-modify-write handle valid only for the duration of one
 * `withTransitionWriter` call. Every method runs on the transaction's own
 * connection, so `history()` observes exactly the rows the subsequent
 * `insert()` is validated against — the property the jsonl implementation
 * could not provide (#1328).
 */
export interface TransitionWriter {
  /** History for one work item, oldest first, inside this transaction. */
  history(workItemId: string | null): TransitionLogEntry[];
  /** Append one entry inside this transaction. */
  insert(entry: TransitionLogEntry): void;
}

/**
 * Run `fn` as an atomic read-modify-write over the transition log.
 *
 * This is the concurrency primitive behind `commitTransition`: the write lock
 * is held for the whole `fn`, so two concurrent `mcx phase run` invocations for
 * the same work item are serialised rather than both validating against the
 * same stale snapshot. `fn` must be synchronous — an async `fn` would let the
 * transaction commit before its work finished, silently voiding atomicity.
 */
export function withTransitionWriter<T>(logPath: string, fn: (w: TransitionWriter) => T, opts: StoreOptions = {}): T {
  return withDbTx(
    logPath,
    (db) => {
      const writer: TransitionWriter = {
        history: (workItemId) => selectEntries(db, "work_item_id IS ?", [workItemId]),
        insert: (entry) => insertEntries(db, [entry]),
      };
      return fn(writer);
    },
    opts,
  );
}

// ── Queries ────────────────────────────────────────────────────────────

const SELECT_COLUMNS = "ts, work_item_id, from_phase, to_phase, force_message, status";

/**
 * Read the newest `tail` rows matching `where`, returned oldest-first.
 *
 * The tail is applied in SQL (`ORDER BY id DESC LIMIT ?`) and the page is
 * reversed in memory, so a bounded read never materialises the full table
 * (#1375). `id` ordering is insertion order, which is the log's contract —
 * `ts` is supplied by callers and is not monotonic.
 */
function selectEntries(db: Database, where: string, params: (string | null)[], tail?: number): TransitionLogEntry[] {
  const clause = where.length > 0 ? ` WHERE ${where}` : "";
  if (tail === undefined) {
    const rows = db
      .query<TransitionRow, (string | null)[]>(`SELECT ${SELECT_COLUMNS} FROM transitions${clause} ORDER BY id ASC`)
      .all(...params);
    return rows.map(rowToEntry);
  }
  // The limit is interpolated rather than bound, so a non-integer must be
  // rejected here: NaN or Infinity would reach SQLite as `LIMIT NaN`.
  if (!Number.isInteger(tail)) throw new TypeError(`tail must be an integer, got ${tail}`);
  if (tail <= 0) return [];
  const rows = db
    .query<TransitionRow, (string | null)[]>(
      `SELECT ${SELECT_COLUMNS} FROM transitions${clause} ORDER BY id DESC LIMIT ${tail}`,
    )
    .all(...params);
  return rows.reverse().map(rowToEntry);
}

export interface ReadHistoryOptions extends StoreOptions {
  /** Return at most the newest N entries (still ordered oldest-first). */
  tail?: number;
}

/**
 * Read the transition history for one work item, oldest first.
 *
 * `workItemId` is matched exactly, including `null` (entries recorded outside
 * a work item) — this is an indexed lookup, not a full scan. No store yet →
 * empty array.
 */
export function readTransitionHistory(
  logPath: string,
  workItemId: string | null,
  onCorrupt?: OnCorruptLine,
  opts: ReadHistoryOptions = {},
): TransitionLogEntry[] {
  const db = openForRead(logPath, { ...opts, ...(onCorrupt !== undefined ? { onCorrupt } : {}) });
  if (db === null) return [];
  try {
    return selectEntries(db, "work_item_id IS ?", [workItemId], opts.tail);
  } finally {
    db.close();
  }
}

export interface ReadAllOptions extends StoreOptions {
  /**
   * Restrict to one work item. `null` or omitted means "no filter" — this
   * matches `filterTransitionLog`'s long-standing semantics, and differs from
   * `readTransitionHistory`, where `null` selects the null work item.
   */
  workItemId?: string | null;
  /** Only entries carrying a `forceMessage`. */
  forcedOnly?: boolean;
  /** Return at most the newest N entries (still ordered oldest-first). */
  tail?: number;
}

/**
 * Read transition entries, oldest first. With no options this returns every
 * entry; `workItemId`, `forcedOnly` and `tail` are pushed down into SQL so
 * `mcx phase log` no longer loads the whole log to filter it in memory
 * (#1375). No store yet → empty array.
 */
export function readAllTransitions(logPath: string, opts: ReadAllOptions = {}): TransitionLogEntry[] {
  const db = openForRead(logPath, opts);
  if (db === null) return [];
  try {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (opts.workItemId !== undefined && opts.workItemId !== null) {
      clauses.push("work_item_id = ?");
      params.push(opts.workItemId);
    }
    if (opts.forcedOnly === true) {
      clauses.push("force_message IS NOT NULL");
    }
    return selectEntries(db, clauses.join(" AND "), params, opts.tail);
  } finally {
    db.close();
  }
}

/** Insert one transition entry. Creates the store if needed. */
export function appendTransitionLog(logPath: string, entry: TransitionLogEntry, opts: StoreOptions = {}): void {
  withDbTx(logPath, (db) => insertEntries(db, [entry]), opts);
}

/**
 * Remove stale transition entries for a work item whose incarnation predates
 * `cutoff`. Used by `mcx track` to clear history from prior sprints so a
 * re-tracked item starts with a clean slate (issue #2463).
 *
 * Returns the number of entries deleted. Runs as a single statement inside a
 * write transaction, so a concurrent phase run cannot observe a half-pruned
 * history.
 */
export function pruneStaleHistory(logPath: string, workItemId: string, cutoff: Date, opts: StoreOptions = {}): number {
  return withDbTx(
    logPath,
    (db) => {
      // `ts` is compared as a parsed date, not lexically: it is caller-supplied
      // and only conventionally an ISO-8601 string, so a lexical `ts < ?` in SQL
      // would silently mis-prune any entry written in another format. An
      // unparseable `ts` yields NaN, which fails the comparison and keeps the
      // entry — the same conservative behaviour the jsonl implementation had.
      const cutoffMs = cutoff.getTime();
      const rows = db
        .query<{ id: number; ts: string }, [string]>("SELECT id, ts FROM transitions WHERE work_item_id = ?")
        .all(workItemId);
      const staleIds = rows.filter((r) => new Date(r.ts).getTime() < cutoffMs).map((r) => r.id);
      if (staleIds.length === 0) return 0;
      const stmt = db.prepare("DELETE FROM transitions WHERE id = ?");
      for (const id of staleIds) stmt.run(id);
      return staleIds.length;
    },
    opts,
  );
}
