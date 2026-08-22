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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Default wait for a contended write lock before surfacing a busy error. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Current schema revision, recorded in `meta` for future migrations.
 *
 * v2 replaced the name-keyed `imported_files` with content-hashed
 * `imported_content` (see `applySchema`).
 */
const SCHEMA_VERSION = 2;

/** Suffix for a legacy jsonl claimed by an in-flight import. */
const IMPORTING_SUFFIX = ".importing.";

/**
 * Suffix for a claimed jsonl whose import failed for a non-contention reason.
 * Must NOT start with `IMPORTING_SUFFIX`, so a quarantined file is never replayed.
 */
const UNIMPORTABLE_SUFFIX = ".unimportable.";

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
 * Called for a staging-file anomaly the store survives but must not hide.
 *
 * Distinct from `OnCorruptLine`, which is per-record and per-line. This one
 * fires when a *whole claimed file* is skipped or disappears — cases where the
 * store deliberately chooses availability over certainty, and the operator is
 * the only party who can tell whether anything was actually lost.
 */
export type OnWarn = (message: string) => void;

/** Default anomaly sink: one stderr line, injectable for tests. */
export function defaultOnWarn(out: { write: (s: string) => void } = process.stderr): OnWarn {
  return (message) => out.write(`warn: ${message}\n`);
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
    -- Keyed on a SHA-256 of the file's bytes, NOT its name. The name embeds a
    -- fresh import nonce, so a name key could only ever match a crash-retry of
    -- the same claim and deduped nothing an operator or a peer binary did (see
    -- importStagingFile).
    CREATE TABLE IF NOT EXISTS imported_content (
      content_hash TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      imported_at  TEXT NOT NULL
    );
    -- v1's name-keyed predecessor. Dropping it cannot resurrect an import:
    -- insertImportedEntries dedupes at row level, so a staging file whose v1
    -- marker is gone re-imports to zero new rows and is simply parked.
    DROP TABLE IF EXISTS imported_files;
  `);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["schema_version", String(SCHEMA_VERSION)]);
}

// ── Legacy jsonl import ────────────────────────────────────────────────

/** Optional field that must be a string when present (and not null). */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string, got ${typeof value}`);
  return value;
}

/** Nullable field that must be a string or null. */
function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string or null, got ${typeof value}`);
  return value;
}

/**
 * Validate and normalise one parsed jsonl record into a `TransitionLogEntry`,
 * throwing a descriptive `TypeError` for anything that isn't one.
 *
 * The importer previously passed **any** parsed JSON object straight through as
 * a `TransitionLogEntry` with no shape check, so a record that was valid JSON
 * but not a valid entry — `{"foo":1}` — reached the INSERT and threw from
 * SQLite (`NOT NULL constraint failed`, or `Binding expected string...` for a
 * wrong-typed field). Because `rename(2)` is not transactional, that throw
 * rolled back the import but left the claimed jsonl as `.importing.<nonce>`,
 * which was then replayed on every subsequent open — permanently wedging every
 * read and every write, with the only copy of the log hidden under a name
 * nobody looks for.
 *
 * A malformed record is log rot, exactly like a torn line, so it belongs in the
 * `onCorrupt` sink the importer already has rather than in an exception. The
 * design refuses to trust the file's *bytes*; it must not then trust its
 * *schema* — least of all because the most likely producer of a schema-invalid
 * line is a hand-recovered jsonl (#2962).
 */
function toEntry(parsed: unknown): TransitionLogEntry {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.ts !== "string") throw new TypeError(`ts must be a string, got ${typeof raw.ts}`);
  if (typeof raw.to !== "string") throw new TypeError(`to must be a string, got ${typeof raw.to}`);

  const forceMessage = optionalString(raw.forceMessage, "forceMessage");
  // An unrecognised status is normalised to undefined rather than rejected, for
  // the same reason `toStatus` does it on read: only the exact literal
  // "attempted" may downgrade an entry to audit-only, so a garbled value can
  // never silently stop gating transitions.
  const status = typeof raw.status === "string" ? toStatus(raw.status) : undefined;
  return {
    ts: raw.ts,
    workItemId: nullableString(raw.workItemId, "workItemId"),
    from: nullableString(raw.from, "from"),
    to: raw.to,
    ...(forceMessage !== undefined ? { forceMessage } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function parseJsonlEntries(text: string, onCorrupt: OnCorruptLine): { entries: TransitionLogEntry[]; corrupt: number } {
  const entries: TransitionLogEntry[] = [];
  let corrupt = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      entries.push(toEntry(JSON.parse(line)));
    } catch (err) {
      corrupt++;
      onCorrupt(i + 1, line, err);
    }
  }
  return { entries, corrupt };
}

function insertEntries(db: Database, entries: readonly TransitionLogEntry[]): void {
  const stmt = db.prepare(
    "INSERT INTO transitions (ts, work_item_id, from_phase, to_phase, force_message, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const e of entries) {
    stmt.run(e.ts, e.workItemId, e.from, e.to, e.forceMessage ?? null, e.status ?? null);
  }
}

/**
 * Insert imported entries, skipping any row already present. Returns how many
 * were inserted and how many were skipped as duplicates.
 *
 * Row-level dedupe is what makes re-importing the *same* history idempotent, and
 * it is deliberately applied only on the import path — never to `appendTransitionLog`,
 * whose job is to record whatever the caller decided.
 *
 * The identity tuple is `(ts, work_item_id, from_phase, to_phase, status)`.
 * `ts` is millisecond-precision, so two rows agreeing on all five are the same
 * transition by the log's own semantics: a work item's chain cannot legitimately
 * contain two identical `from → to` moves at the same instant, and if it did,
 * regression validation would reject the second anyway. `force_message` is
 * excluded so a re-import whose justification text was reflowed still dedupes.
 *
 * `IS` rather than `=` for the nullable columns: `= NULL` is never true in SQL,
 * so an initial transition (`from_phase` NULL) or a non-work-item entry
 * (`work_item_id` NULL) would never match itself and would duplicate on every
 * re-import — precisely the case this exists to fix.
 */
function insertImportedEntries(
  db: Database,
  entries: readonly TransitionLogEntry[],
): { inserted: number; skipped: number } {
  const exists = db.prepare<{ 1: number }, [string, string | null, string | null, string, string | null]>(
    "SELECT 1 FROM transitions WHERE ts = ? AND work_item_id IS ? AND from_phase IS ? AND to_phase = ? AND status IS ? LIMIT 1",
  );
  const insert = db.prepare(
    "INSERT INTO transitions (ts, work_item_id, from_phase, to_phase, force_message, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    const status = e.status ?? null;
    if (exists.get(e.ts, e.workItemId, e.from, e.to, status) !== null) {
      skipped++;
      continue;
    }
    insert.run(e.ts, e.workItemId, e.from, e.to, e.forceMessage ?? null, status);
    inserted++;
  }
  return { inserted, skipped };
}

/**
 * Drop a staging *name* whose content is already linked elsewhere, tolerating a
 * peer having dropped it first.
 *
 * The invariant this exists to serve: **every operation on a peer-visible
 * staging path must tolerate ENOENT**. A staging path is visible to every
 * process that scans the directory, and the window in which one is claimed but
 * not yet parked is not covered by the write lock — the park runs after COMMIT.
 * So any syscall naming one can lose the race, and the only two syscalls here
 * that remove a name are these.
 *
 * Callers must only reach this after the content is reachable under another
 * name, which is why a vanished path is a no-op rather than an error.
 */
function unlinkQuietly(staging: string): void {
  try {
    unlinkSync(staging);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

/** Candidate park name: the plain `.migrated`, else a nonce-suffixed sibling. */
function migratedPath(logPath: string): string {
  const first = `${logPath}.migrated`;
  if (!existsSync(first)) return first;
  return `${first}.${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/** What one staging-file import contributed. */
interface ImportResult {
  inserted: number;
  skipped: number;
  corrupt: number;
}

/** A staging file imported in this transaction, awaiting its post-COMMIT park. */
interface StagedImport {
  path: string;
  result: ImportResult;
}

/**
 * Import one claimed staging file into the DB. Must run inside the caller's
 * write transaction, and the file must be parked with `parkStagingFile` only
 * after that transaction commits.
 *
 * ## Idempotence is content-addressed, at two levels
 *
 * The dedupe key is a SHA-256 of the file's bytes, not `basename(staging)`. The
 * name embeds a fresh `Date.now()`-plus-random import nonce, so a name key could
 * only ever match a crash-after-COMMIT-before-park retry of the *same* claim —
 * it deduped nothing an operator or a peer binary did, and two paths made that
 * fatal:
 *
 *   - Restoring the parked `.migrated` file, which is the documented recovery
 *     procedure, re-imported the whole history under a new nonce. Three entries
 *     became six, chain integrity was destroyed, every visited phase appeared
 *     twice, and the next real transition threw `RegressionError` — silently.
 *   - The mixed-binary rollout triggers it with certainty: an old jsonl-era
 *     binary finds no `transitions.jsonl` (renamed away), so it validates
 *     against an *empty* history and writes a fresh file, which this binary then
 *     imported with no dedupe.
 *
 * A content key makes a byte-identical restore a no-op. `insertImportedEntries`
 * then dedupes at row level, which covers the case a content key cannot: a file
 * whose bytes differ but whose *entries* were already imported — a truncated or
 * re-serialised copy of history the store has already seen. Both are needed —
 * the hash is the cheap exact-match path, the row check is the broader one.
 *
 * Neither covers the mixed-binary rollout above once the old binary appends a
 * transition the store has never seen: that row is genuinely new, so it is
 * imported verbatim, out of order and validated against an empty history. That
 * is a gap in the migration strategy rather than in the dedupe, and is tracked
 * separately in #2980.
 *
 * Exactly-once across a crash still holds: the `imported_content` row is written
 * in the same transaction as the entries, so a crash before COMMIT rolls the
 * whole thing back and the staging file is retried on the next open; a crash
 * after COMMIT but before the park leaves the row behind, so the retry inserts
 * nothing and only parks the file. The data is never in neither place, and never
 * in both.
 *
 * Returns null when the staging path has already vanished — see below.
 */
function importStagingFile(
  db: Database,
  staging: string,
  onCorrupt: OnCorruptLine,
  onWarn: OnWarn,
): ImportResult | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(staging);
  } catch (err) {
    // ENOENT: the path vanished between our directory scan and this read. The
    // *expected* cause is a peer that claimed it, committed its import, and
    // then parked the file — that gap is real, because the park happens after
    // COMMIT and the owner no longer holds the write lock while it runs.
    //
    // Treat that as the explanation, but do not assert it as fact: we never
    // read the bytes, so we have no hash to test against `imported_content` and
    // no way to confirm the entries reached the DB. Anything else that unlinks
    // a staging path — an operator, a stray cleanup script, a dangling symlink —
    // is indistinguishable from here, and in those cases uncommitted
    // transitions are genuinely gone. Hence the warning: skipping is the right
    // availability trade, but it must not be silent.
    //
    // This must not fall through to the caller's quarantine, either: ENOENT is
    // not a busy error, so `claim` would route a vanished path to
    // `quarantineStagingFile`, whose `link(2)` throws ENOENT in turn — out
    // through the rollback and out of `withDbTx`, failing not just this write
    // but every *read*, since `openForRead` drives a write transaction whenever
    // it sees a staging file and only swallows contention.
    if (errnoCode(err) === "ENOENT") {
      onWarn(`staging file vanished before it could be imported: ${staging} (assuming a concurrent park)`);
      return null;
    }
    throw err;
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const already = db
    .query<{ content_hash: string }, [string]>("SELECT content_hash FROM imported_content WHERE content_hash = ?")
    .get(contentHash);
  if (already !== null) return { inserted: 0, skipped: 0, corrupt: 0 };

  const { entries, corrupt } = parseJsonlEntries(bytes.toString("utf-8"), onCorrupt);
  const { inserted, skipped } = insertImportedEntries(db, entries);
  db.run("INSERT INTO imported_content (content_hash, name, imported_at) VALUES (?, ?, ?)", [
    contentHash,
    basename(staging),
    new Date().toISOString(),
  ]);
  return { inserted, skipped, corrupt };
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
function parkStagingFile(staging: string, logPath: string): string | null {
  for (;;) {
    const dest = migratedPath(logPath);
    try {
      linkSync(staging, dest);
    } catch (err) {
      const code = errnoCode(err);
      // ENOENT: a concurrent process already parked it. Both processes agree the
      // import committed, so there is nothing left to do.
      if (code === "ENOENT") return null;
      // EEXIST: lost the race for that name; migratedPath picks a fresh nonce.
      if (code === "EEXIST") continue;
      throw err;
    }
    // Same window as the `link` above, half a syscall later: a peer that hashed
    // to the same `imported_content` row stages the same path, so both
    // processes park it, and whichever unlinks second finds the name already
    // gone. Throwing here would report a *committed* transition as a failure —
    // this runs after `commitWithRetry`, so `rollbackQuietly` is a no-op and the
    // error escapes `withDbTx` as a hard failure that `phase.ts` does not retry
    // (it only retries `TransitionLockBusyError`), by which point the handler
    // has already pushed the branch and opened the PR.
    //
    // Nothing is lost by tolerating it: `dest` is our own hardlink to the same
    // content, so the park is complete either way. Only the name we were about
    // to remove disappeared.
    unlinkQuietly(staging);
    return dest;
  }
}

/**
 * Move a staging file that cannot be imported out of the replay set, returning
 * its new path, or null if the path vanished first. Callers are expected to
 * announce that path — it is the only way an operator can find the file again.
 *
 * Belt to `toEntry`'s braces. Validation removes the *known* way one bad record
 * wedged the store, but any unexpected non-contention failure during import has
 * the same shape — `rename(2)` is not transactional, so the DB rolls back while
 * the claimed file stays on disk and is replayed on every subsequent open, and
 * because `openForRead` escalates to a write transaction whenever a staging file
 * exists, that denies service to every read *and* every write, permanently. One
 * bad file must cost one error and then self-heal.
 *
 * `.unimportable` deliberately does not match `IMPORTING_SUFFIX`, so the file is
 * never replayed; it is left on disk, under a reported name, because it may be
 * the only copy of the log.
 *
 * `link(2)` first, for the same reason `parkStagingFile` uses it: it fails
 * `EEXIST` atomically instead of silently replacing its destination. `link`
 * cannot operate on anything but a regular file, so a staging *path* that is not
 * a regular file (which is one of the ways import fails in the first place) falls
 * back to `rename`. That fallback can only ever replace a nonce'd name minted a
 * moment earlier, and one that by definition holds no importable log data.
 *
 * Returns null when the staging path is already gone — there is nothing left to
 * move aside, and throwing here would turn a benign race into the permanent
 * denial of service this function exists to prevent.
 */
function quarantineStagingFile(staging: string, logPath: string): string | null {
  for (;;) {
    // Built from `logPath`, NOT from `staging`: appending to the staging name
    // would leave the result still prefixed with `IMPORTING_SUFFIX`, so
    // findAbandonedStagingFiles would keep replaying it and the quarantine would
    // do nothing at all.
    const dest = `${logPath}${UNIMPORTABLE_SUFFIX}${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      linkSync(staging, dest);
    } catch (err) {
      const code = errnoCode(err);
      if (code === "EEXIST") continue;
      // ENOENT: the owner of this claim parked it while we were deciding to
      // quarantine it. Nothing to move aside — and the import it held has
      // already committed.
      if (code === "ENOENT") return null;
      // EXDEV is deliberately NOT in this list. `dest` is built from `logPath`
      // and `staging` is always `${logPath}${IMPORTING_SUFFIX}*`, so the two are
      // by construction in the same directory and `link` cannot report a
      // cross-device failure. Even if it somehow did, `rename(2)` fails EXDEV on
      // exactly the same condition, so the fallback could only ever replace one
      // error with a worse one.
      if (code === "EPERM" || code === "EISDIR" || code === "ENOTSUP") {
        try {
          renameSync(staging, dest);
        } catch (renameErr) {
          // Same peer-park race as the `link` above, one syscall later.
          if (errnoCode(renameErr) === "ENOENT") return null;
          throw renameErr;
        }
        return dest;
      }
      throw err;
    }
    // Critically ENOENT-tolerant here, not just tidy: this runs inside `claim`'s
    // catch block, so a throw would *replace* the import error that sent us here
    // with a spurious filesystem one — destroying the diagnosis this quarantine
    // exists to preserve, which is verbatim the harm the `link` guard above
    // prevents.
    unlinkQuietly(staging);
    return dest;
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
function migrateLegacyJsonl(db: Database, logPath: string, onCorrupt: OnCorruptLine, onWarn: OnWarn): StagedImport[] {
  const staged: StagedImport[] = [];

  // Nearly every staging file seen here is genuinely abandoned: this runs under
  // the write lock, and a live import holds that lock for all of its *database*
  // work. The one exception is the tail of another process's claim — it parks
  // the file after COMMIT, so between that COMMIT and that park the lock is
  // free and the staging path is still on disk. `importStagingFile` returns
  // null for a path that vanishes in exactly that window; there is nothing to
  // import (its entries are committed) and nothing to park.
  const claim = (staging: string): void => {
    try {
      const result = importStagingFile(db, staging, onCorrupt, onWarn);
      if (result !== null) staged.push({ path: staging, result });
    } catch (err) {
      // Contention is not the file's fault — leave it in place to be replayed
      // once the lock is free. Anything else is quarantined so it cannot deny
      // service to the store forever.
      if (!isBusyError(err)) {
        // Announced, not just moved. The quarantined file may be the only copy
        // of the log, and its new name is the only way an operator can find it;
        // discarding this return value left `docs/phases.md` and this
        // function's own docstring both claiming a report that never happened.
        const quarantined = quarantineStagingFile(staging, logPath);
        if (quarantined !== null) onWarn(`could not import ${staging} — moved aside to ${quarantined}`);
      }
      throw err;
    }
  };

  for (const abandoned of findAbandonedStagingFiles(logPath)) claim(abandoned);

  if (!existsSync(logPath)) return staged;

  const staging = `${logPath}${IMPORTING_SUFFIX}${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(logPath, staging);
  } catch (err) {
    // NOT the same ENOENT as the abandoned-scan path above, and it must not get
    // the same silent treatment.
    //
    // This rename runs under `BEGIN IMMEDIATE`, and `migrateLegacyJsonl` is only
    // ever reached from inside that transaction, so no peer can be between its
    // own `existsSync` and its own claiming rename — the mutual exclusion the
    // abandoned-scan path lacks is present here. (The "another process claimed
    // it first" reasoning this comment used to give was inherited from a design
    // where claiming happened *outside* the lock. It no longer applies.)
    //
    // So ENOENT means `transitions.jsonl` was unlinked by something outside this
    // store between `existsSync` a few lines up and here: an operator, a cleanup
    // script, a restore gone wrong. Continuing is still correct — there is
    // nothing to import and wedging the store helps nobody — but the operator's
    // log just disappeared and that cannot be inferred from a successful run.
    if (errnoCode(err) === "ENOENT") {
      onWarn(`legacy transition log disappeared before it could be claimed: ${logPath} (nothing was imported)`);
      return staged;
    }
    throw err;
  }
  claim(staging);
  return staged;
}

// ── Connection lifecycle ───────────────────────────────────────────────

/** SQLite takes the busy timeout as a C `int`, so this is its ceiling (~24 days). */
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

/**
 * Coerce a caller-supplied busy timeout to an integer SQLite will actually apply.
 *
 * `Math.max(0, Math.trunc(ms))` looks like a guard but is NaN-transparent —
 * `Math.max` propagates NaN — so `NaN` and `Infinity` both reached the pragma
 * verbatim and SQLite silently applied **0**, which disables the contention wait
 * entirely: every concurrent writer then fails immediately instead of
 * serialising, and the COMMIT retry cannot recover it because each attempt waits
 * zero. `1e21` was worse than useless in the other direction — it is an integer,
 * but it stringifies to `1e+21`, which SQLite parsed as 1ms.
 *
 * Clamping to `MAX_BUSY_TIMEOUT_MS` is what keeps the interpolated pragma safe:
 * the result is always a plain decimal integer in `[0, 2^31)`, so it can never
 * reach SQL in exponential notation. A non-finite value is a caller bug, and
 * falling back to the default is the only choice that preserves the property the
 * store depends on; zero and negative keep their documented "do not wait"
 * meaning.
 */
export function sanitizeBusyTimeout(busyTimeoutMs: number): number {
  if (!Number.isFinite(busyTimeoutMs)) return DEFAULT_BUSY_TIMEOUT_MS;
  const ms = Math.trunc(busyTimeoutMs);
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_BUSY_TIMEOUT_MS);
}

function configure(db: Database, busyTimeoutMs: number): void {
  // Rollback journal (the default) is retained deliberately — see the
  // "Journal mode: deliberately NOT WAL" note at the top of this file.
  db.exec(`PRAGMA busy_timeout = ${sanitizeBusyTimeout(busyTimeoutMs)}`);
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

/** What one completed legacy-jsonl migration did. */
export interface MigrationReport {
  /** The legacy jsonl path that was migrated. */
  logPath: string;
  /** The SQLite store it was migrated into. */
  dbPath: string;
  /** Where the original bytes were parked, and can be recovered from. */
  parkedPath: string;
  /** Records inserted. */
  imported: number;
  /** Records already present in the store, skipped as duplicates. */
  skipped: number;
  /** Records rejected as corrupt (also reported individually via `onCorrupt`). */
  corrupt: number;
}

/** Called once per completed legacy-jsonl migration. */
export type OnMigrate = (report: MigrationReport) => void;

/**
 * Default migration sink: one line to stderr.
 *
 * A migration is a one-way, in-place conversion of load-bearing state that
 * reported nothing anywhere. It is also now reachable from a pure *read* —
 * `openForRead` escalates to a write transaction when there is an import
 * pending — so a read-only-looking command mutates state, unannounced. In #2962
 * the only reason that was recoverable is the park-not-delete decision; the
 * operator still got no chance to notice before continuing. Naming the parked
 * path is the point of the line: it is what recovery reads from.
 */
export function defaultOnMigrate(out: { write: (s: string) => void } = process.stderr): OnMigrate {
  return ({ logPath, dbPath, parkedPath, imported, skipped, corrupt }) => {
    const extra = [
      ...(skipped > 0 ? [`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`] : []),
      ...(corrupt > 0 ? [`${corrupt} corrupt record${corrupt === 1 ? "" : "s"} rejected`] : []),
    ];
    const suffix = extra.length > 0 ? ` (${extra.join(", ")})` : "";
    out.write(`migrated ${imported} entries from ${logPath} → ${dbPath}${suffix}; original parked at ${parkedPath}\n`);
  };
}

export interface StoreOptions {
  /** How long to wait for a contended write lock. */
  timeoutMs?: number;
  /** Corrupt-line sink for the one-time legacy jsonl import. */
  onCorrupt?: OnCorruptLine;
  /** Migration announcement sink. Defaults to one stderr line per migration. */
  onMigrate?: OnMigrate;
  /** Staging-file anomaly sink. Defaults to one stderr line per anomaly. */
  onWarn?: OnWarn;
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
    try {
      withDbTx(logPath, () => {}, opts);
    } catch (err) {
      // Contention here is not the reader's problem to solve. The staging-file
      // scan above runs unlocked, so a reader also fires on another live
      // process's in-flight claim — and making a previously-infallible read path
      // fail on that turns read-only orchestrator polling into a stall vector
      // (`readTransitionHistory` from `phase.ts`, `pruneStaleHistory` from
      // `track.ts`, where it becomes `exit 1`).
      //
      // Falling through is safe because it cannot affect gating: the process
      // holding the lock is completing the import, and every *writer* takes the
      // write lock and imports before it validates. The worst case for this
      // reader is observing the pre-import history, which is exactly what it
      // would have seen a moment earlier.
      if (!(err instanceof TransitionLockBusyError)) throw err;
    }
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
      const staged = migrateLegacyJsonl(
        db,
        logPath,
        opts.onCorrupt ?? defaultOnCorruptLine(logPath),
        opts.onWarn ?? defaultOnWarn(),
      );
      const result = fn(db);
      if (result instanceof Promise) {
        // The transaction would commit before the async work completed, so the
        // "atomic read-validate-append" guarantee would silently not hold.
        throw new Error("withTransitionWriter: fn must be synchronous (returned a Promise)");
      }
      commitWithRetry(db);
      // Parked, then announced: the report names the parked path, which is the
      // artifact recovery reads from, so it must exist before it is reported.
      const onMigrate = opts.onMigrate ?? defaultOnMigrate();
      for (const { path, result: imported } of staged) {
        const parkedPath = parkStagingFile(path, logPath);
        if (parkedPath === null) continue;
        onMigrate({
          logPath,
          dbPath,
          parkedPath,
          imported: imported.inserted,
          skipped: imported.skipped,
          corrupt: imported.corrupt,
        });
      }
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
type SelectParam = string | number | null;

function selectEntries(db: Database, where: string, params: SelectParam[], tail?: number): TransitionLogEntry[] {
  const clause = where.length > 0 ? ` WHERE ${where}` : "";
  if (tail === undefined) {
    const rows = db
      .query<TransitionRow, SelectParam[]>(`SELECT ${SELECT_COLUMNS} FROM transitions${clause} ORDER BY id ASC`)
      .all(...params);
    return rows.map(rowToEntry);
  }
  // A non-integer tail is a caller bug and is rejected with a useful message
  // rather than being coerced into a different query.
  if (!Number.isInteger(tail)) throw new TypeError(`tail must be an integer, got ${tail}`);
  if (tail <= 0) return [];
  // `LIMIT ?` rather than `LIMIT ${tail}`. Interpolation left a hole the integer
  // predicate in front of it could not close: `Number.isInteger(1e21)` is true,
  // but it stringifies to `1e+21`, so it reached SQLite as `LIMIT 1e+21` →
  // "datatype mismatch". Binding the parameter eliminates the class instead of
  // patching predicates in front of it; clamping to a safe integer keeps a
  // "larger than the table" tail meaning exactly that.
  const rows = db
    .query<TransitionRow, SelectParam[]>(`SELECT ${SELECT_COLUMNS} FROM transitions${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(tail, Number.MAX_SAFE_INTEGER));
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
