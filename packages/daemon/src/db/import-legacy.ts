/**
 * One-shot, best-effort import from the pre-domain `state.db` into `mcx.db` (#3034).
 *
 * This is deliberately **not** a migration. There is no rollback path, no dual-write,
 * no swap protocol, and no "migration in progress" state.
 *
 * The marker lives in the **legacy** database, not in `mcx.db`, so it survives deleting
 * `mcx.db`. That means **deleting `mcx.db` alone is not a recovery** — the import
 * declines and the daemon comes up empty. The recovery is to back up, delete, and clear
 * the marker as well; {@link recoveryInstructions} builds that command from the paths
 * this process actually opened.
 *
 * No literal path is written here on purpose. This comment used to spell out
 * `~/.mcp-cli/...`, which is wrong for any install with `MCP_CLI_DIR` set — and the
 * warning a user sees is generated, so a second copy here could only ever drift.
 *
 * As of #3035 the marker half of that recovery is `mcx domain import --force`, which
 * {@link clearImportMarker} performs and which arms the *next* start rather than importing
 * in place. The import runs at exactly one call site, at boot, and refuses a target that
 * already holds rows — see {@link nonEmptyImportedTables}.
 *
 * Best-effort applies to *rows*: individual rows that do not map are skipped and counted.
 * It does **not** extend to sealing the marker — a run in which any table failed outright
 * rolls the whole copy back and leaves the marker unset. A failed import must not stop the
 * daemon from booting, and must not silently become permanent.
 *
 * **What "retry" does and does not mean here** (#3160 review N2; this used to promise a
 * partial-commit retry the code does not implement). Driven, not inferred — force one table
 * to error and the target holds **zero** rows from the tables that succeeded:
 *
 * - A failed run is **all-or-nothing**. Nothing lands. `ran && !sealed` does not mean rows
 *   are in the target; see {@link ImportResult.sealed}.
 * - The next start retries **only while the target is still empty**. That holds for a crash
 *   or a failure early in the very first boot. It does **not** hold once a daemon has
 *   completed a boot: it publishes `daemon.restarted` into `monitor_events`, so by the next
 *   start the target is non-empty and {@link nonEmptyImportedTables} declines.
 * - That decline is correct, not a regression. Copying legacy `monitor_events` over a target
 *   that already holds seq 1 drops the colliding legacy rows under `INSERT OR IGNORE` — the
 *   "retry" the old wording promised was itself the data-loss path.
 * - From there recovery is deliberate and operator-driven: `mcx domain import --force`, then
 *   remove the target, then restart. {@link recoveryInstructions} prints it with real paths.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Domain,
  NO_DOMAIN_ID,
  canonicalizeDomainPath,
  isValidDomainName,
  options,
  resolveDomainForPath,
} from "@mcp-cli/core";
import { DERIVED_CURSOR_ID } from "../derived-events";
import { ADOPTABLE_TABLES, adoptUnassignedRows } from "./adopt-domains";

/** Shape of a `~/.mcp-cli/scopes/<name>.json` sidecar, as written by `mcx scope init`. */
interface ScopeFile {
  root: string;
  created?: string;
}

/** Key of the import marker row in the legacy DB's `daemon_state` table. */
export const IMPORT_MARKER_KEY = "mcx_domain_import_at";

/** Key recording how many rows the sealed import copied, next to the marker. */
export const IMPORT_ROWCOUNT_KEY = "mcx_domain_import_rows";

/**
 * The recovery incantation, built from the paths this process actually opened.
 *
 * A function, not a constant, because `options` is mutable (every test harness and any
 * non-default `MCP_CLI_DIR` retargets it) and because a hardcoded `~/.mcp-cli` made the
 * two halves of the warning name different files — diagnosing the real database and then
 * instructing an unconditional `rm` of a healthy one (#3034 review R2). A recovery
 * instruction that deletes the wrong database is worse than no instruction.
 *
 * Step 0 is a backup: this arc has no rollback by design, so `rm` would otherwise destroy
 * everything done since the bad import.
 *
 * The order matters and is not cosmetic (#3160 review). `state.ts` opens the target in WAL
 * mode, so `cp <target> <target>.bak` against a LIVE database copies the main file without
 * the un-checkpointed `-wal` — a backup silently missing the most recent transactions, in
 * the one step whose entire job is to be the rollback. Arming first and shutting the daemon
 * down before the copy closes the database, which checkpoints WAL into the main file and
 * makes the single-file copy valid. It also means the `rm` cannot race a live writer.
 *
 * The `sqlite3` stopgap the #3034 TODO described is gone as of #3035 — `mcx domain import
 * --force` clears both keys through {@link clearImportMarker}, so the instruction no longer
 * asks for a tool this project does not depend on. `rm` stays, and is now *required* rather
 * than advisory: the import refuses a non-empty target, so an operator who skips it gets a
 * refusal instead of silent data loss.
 *
 * `legacyPath` is still a parameter even though the command no longer names it, because the
 * warning that embeds this text also names the database it diagnosed, and the two must not
 * drift into describing different files (#3034 review R2).
 */
export function recoveryInstructions(legacyPath = options.LEGACY_DB_PATH, targetPath = options.DB_PATH): string {
  return `to re-run the import from ${legacyPath}: mcx domain import --force && mcx shutdown && cp ${targetPath} ${targetPath}.bak && rm ${targetPath} && mcx status  (the shutdown checkpoints WAL, so the copy is a valid backup)`;
}

export type ImportArmState =
  /** The marker is gone: the next daemon start will run the import. */
  | { state: "armed"; alreadyArmed: boolean }
  /** Nothing to arm — no legacy database, or it could not be opened or written. */
  | { state: "unavailable"; reason: string };

/**
 * Read the marker's current value without changing it. `null` means the import is already
 * armed; a string is the timestamp it was sealed at.
 *
 * Exported so the CLI can *check* rather than assert. `mcx domain import` used to print
 * "the marker is set in the legacy database" and hand over an `rm` incantation on an
 * install that had no legacy database at all (#3160 review N1) — a recovery instruction
 * derived from an assumption rather than from a read.
 */
export function readImportMarkerValue(legacyPath = options.LEGACY_DB_PATH): { present: boolean; value: string | null } {
  if (!existsSync(legacyPath)) return { present: false, value: null };
  let legacy: Database;
  try {
    legacy = new Database(legacyPath, { readonly: true });
  } catch {
    return { present: false, value: null };
  }
  try {
    return { present: true, value: readMarker(legacy) };
  } finally {
    legacy.close();
  }
}

/**
 * Clear the one-shot marker (and its row count) so the next daemon start re-runs the import.
 *
 * This is what `mcx domain import --force` does, and it is deliberately **all** it does.
 * The import itself stays where it has always been — `index.ts`, at startup, ahead of
 * `reapOrphanedSessions`, `restoreActiveSessions`, the pollers and the event bus. Running
 * it against a booted daemon would land `agent_sessions` rows *after* the reaper had already
 * run, surfacing dead sessions as live until the next restart, and a printed "restart the
 * daemon" line is an instruction rather than a guarantee (#3035 review finding 2).
 *
 * Arming rather than importing also happens to be the only design that works at all: the
 * daemon publishes `daemon.restarted` into `monitor_events` before it accepts its first
 * request, so by the time an IPC call arrives the target is never empty, and an in-flight
 * forced import would be refused by the emptiness guard every single time.
 *
 * Idempotent: arming an already-armed install reports `alreadyArmed`, not failure.
 */
export function clearImportMarker(legacyPath = options.LEGACY_DB_PATH): ImportArmState {
  if (!existsSync(legacyPath)) return { state: "unavailable", reason: `no legacy database at ${legacyPath}` };
  let legacy: Database;
  try {
    legacy = new Database(legacyPath, { readwrite: true, create: false });
  } catch (err) {
    return { state: "unavailable", reason: `cannot open ${legacyPath}: ${errText(err)}` };
  }
  try {
    const res = legacy.run("DELETE FROM daemon_state WHERE key IN (?, ?)", [IMPORT_MARKER_KEY, IMPORT_ROWCOUNT_KEY]);
    // `changes === 0` means the marker was ALREADY absent — which is the state this
    // function exists to produce, not a failure (#3160 review N13). Reporting it as failure
    // made the command say it failed in both of its live states: re-run after lost
    // scrollback, and re-run after a failed import, which seal-or-nothing *guarantees*
    // leaves the marker unset. Idempotent by construction now.
    return { state: "armed", alreadyArmed: res.changes === 0 };
  } catch (err) {
    return { state: "unavailable", reason: errText(err) };
  } finally {
    legacy.close();
  }
}

/**
 * Tables copied from the legacy DB, in dependency-free order.
 *
 * Excluded on purpose:
 * - `schema_versions` — copying it would stamp mcx.db with the legacy versions and
 *   make every consumer skip its own migrations. This is the one row set that would
 *   silently corrupt the new database.
 * - `tool_cache`, `spans`, `usage_stats`, `server_logs` — caches, export buffers and
 *   volatile telemetry. Rebuilt on demand; copying them costs size and buys nothing.
 */
export const IMPORTED_TABLES = [
  "daemon_state",
  "auth_tokens",
  "oauth_clients",
  "oauth_verifiers",
  "oauth_discovery",
  "aliases",
  "alias_state",
  "notes",
  "mail",
  "agent_sessions",
  "session_metrics",
  "work_items",
  "work_item_transitions",
  "ci_run_states",
  "copilot_comment_state",
  "monitor_events",
  "derived_cursor",
] as const;

/**
 * Every table the import WRITES — which is `IMPORTED_TABLES` **plus `domains`**.
 *
 * `copyEverything` does two things: it copies `IMPORTED_TABLES`, and it calls
 * `importScopesAsDomains`, which does `INSERT OR IGNORE INTO domains`. Deriving the
 * emptiness guard from `IMPORTED_TABLES` alone therefore reproduced the exact defect that
 * guard was written to close (#3160 review N12): a second table set, maintained by
 * omission, so the guard reported EMPTY for a target already holding `domains` rows and let
 * the import proceed over them.
 *
 * There is no hand-maintained duplicate here — this list is the copied set spread into a
 * superset — and `import-legacy.spec.ts` pins it behaviourally: it runs a real import into
 * an empty target and asserts that every table which gained rows is a member. A future
 * writer added to `copyEverything` fails that test rather than silently escaping the guard.
 */
export const IMPORT_WRITTEN_TABLES = [...IMPORTED_TABLES, "domains"] as const;

/**
 * Per-table row filters applied to the legacy SELECT.
 *
 * The import marker is written into the legacy `daemon_state`, so a `--force` re-run
 * would otherwise copy it into `mcx.db` — putting a marker in the database whose
 * deletion is supposed to be the recovery path.
 */
const TABLE_FILTERS: Partial<Record<(typeof IMPORTED_TABLES)[number], { sql: string; params: string[] }>> = {
  daemon_state: { sql: "key NOT IN (?, ?)", params: [IMPORT_MARKER_KEY, IMPORT_ROWCOUNT_KEY] },
};

export interface TableImportResult {
  table: string;
  copied: number;
  /**
   * Rows present in the legacy table that did not become new rows here. `INSERT OR
   * IGNORE` cannot distinguish "already present" (benign, and on a re-run that is every
   * row) from "rejected by a constraint" — so this number alone is not a data-loss
   * signal. `failed` is.
   */
  notCopied: number;
  /** True when the copy itself errored, i.e. the table was not imported at all. */
  failed: boolean;
  /** Why the table was skipped or failed. Absent on a clean copy. */
  reason?: string;
}

export interface ImportResult {
  /** False when the import was declined — no legacy DB, marker already set, or unwritable. */
  ran: boolean;
  /**
   * True only when the marker was written, i.e. this import will never run again.
   * `ran && !sealed` means the copy was ATTEMPTED AND ROLLED BACK — the target is
   * unchanged and the marker is unset. It does **not** mean rows landed. (The row counts
   * alongside it describe what was copied inside the transaction before the rollback, which
   * is #3170 part 1 and not fixed here.) Whether the next start actually retries depends on
   * the target still being empty — see this file's header.
   */
  sealed: boolean;
  reason?: string;
  tables: TableImportResult[];
  /**
   * Tables whose copy errored outright. Non-empty means the entire transaction was rolled
   * back and the marker withheld — not that these tables failed while others were kept.
   */
  failedTables: string[];
  domainsImported: number;
  domainsSkipped: number;
  totalCopied: number;
  totalNotCopied: number;
}

export interface ImportOptions {
  /** The open `mcx.db` connection to import into. */
  db: Database;
  /** Legacy database path. Defaults to `options.LEGACY_DB_PATH`. */
  legacyPath?: string;
  /**
   * Path of `db`, used only in user-facing recovery text. Defaults to the filename of the
   * handle itself, so the instruction names the database this process actually opened.
   */
  targetPath?: string;
  /** Directory of `mcx scope` JSON sidecars to import as domains. Defaults to `options.SCOPES_DIR`. */
  scopesDir?: string;
  /** Re-run even when the marker is set (`mcx domain import --force`). */
  force?: boolean;
  /** Progress/diagnostics sink. Defaults to stderr. */
  log?: (msg: string) => void;
  /** How long to wait for the legacy write lock before declaring it unwritable. */
  legacyBusyTimeoutMs?: number;
}

const declined = (reason: string): ImportResult => ({
  ran: false,
  sealed: false,
  reason,
  tables: [],
  failedTables: [],
  domainsImported: 0,
  domainsSkipped: 0,
  totalCopied: 0,
  totalNotCopied: 0,
});

/**
 * Run the one-shot import. Never throws: any failure is reported through `log` and
 * returns a declined result, because a bad import must not block daemon startup.
 */
export function importLegacyState(opts: ImportOptions): ImportResult {
  const legacyPath = opts.legacyPath ?? options.LEGACY_DB_PATH;
  const targetPath = opts.targetPath ?? opts.db.filename ?? options.DB_PATH;
  const scopesDir = opts.scopesDir ?? options.SCOPES_DIR;
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const recovery = recoveryInstructions(legacyPath, targetPath);

  if (!existsSync(legacyPath)) {
    return declined(`no legacy database at ${legacyPath}`);
  }

  let legacy: Database;
  try {
    legacy = new Database(legacyPath, { readwrite: true, create: false });
    // Without this a momentary write lock (a leftover sqlite3 shell, a second daemon)
    // surfaces as "not writable" in ~2ms and is reported to the user as a permissions
    // problem on a database whose permissions are fine (#3034 review Y7).
    legacy.exec(`PRAGMA busy_timeout = ${opts.legacyBusyTimeoutMs ?? 3000}`);
  } catch (err) {
    log(`[domain-import] cannot open legacy database ${legacyPath}: ${errText(err)}`);
    return declined(`cannot open ${legacyPath}`);
  }

  try {
    const existingMarker = readMarker(legacy);
    if (existingMarker !== null && !opts.force) {
      const reason = `already imported at ${existingMarker}`;
      const expected = readImportedRowCount(legacy);
      if (importedDataMissing(opts.db, expected)) {
        log(
          `[domain-import] WARNING: ${legacyPath} was already imported at ${existingMarker} (${expected ?? "unknown"} row(s)), but ${targetPath} holds ${countImportedRows(opts.db)} of them. The daemon is starting WITHOUT your imported data — deleting mcx.db does not re-arm the import, because the "${IMPORT_MARKER_KEY}" marker lives in the legacy database. ${recovery}`,
        );
      } else {
        log(`[domain-import] ${reason} — skipping`);
      }
      return declined(reason);
    }

    // The target must be EMPTY across every imported table (#3035 review finding 1).
    //
    // This precondition used to hold by construction: the only caller was daemon startup,
    // positioned before any subsystem wrote a row, and the documented recovery began with
    // `rm mcx.db`. Nothing restated it, because nothing had to. `copyTable` uses
    // `INSERT OR IGNORE` over the shared column set — which includes surrogate primary
    // keys (`monitor_events.seq`, `mail.id`, both AUTOINCREMENT) — so against a populated
    // target every legacy row whose id was already reallocated is dropped on the floor,
    // permanently, on a run that reports `sealed: true` and exits 0. The surviving event
    // log is a scrambled timeline, and a revoked `auth_tokens` row comes back.
    //
    // Atomicity does not help here: no table fails, so there is nothing to roll back. The
    // seal-or-nothing repair makes this path land *more* completely, not less.
    const occupied = nonEmptyImportedTables(opts.db);
    if (occupied.length > 0) {
      const detail = occupied.map((t) => `${t.table}=${t.rows}`).join(", ");
      log(
        `[domain-import] refusing to import into ${targetPath}: it already holds ${detail}. The import can only add rows (INSERT OR IGNORE), so copying into a populated database silently drops every legacy row whose id was already taken. ${recovery}`,
      );
      return declined(`target database is not empty (${detail})`);
    }

    // Not load-bearing for correctness any more — the marker write happens inside the
    // same transaction as the copies, so an unwritable legacy DB rolls the whole thing
    // back on its own. This is an early, friendlier exit that avoids doing 17 copies
    // only to discard them, and it produces a better message than a failed INSERT.
    const writeError = probeLegacyWritable(legacy);
    if (writeError !== null) {
      log(
        `[domain-import] legacy database ${legacyPath} is not writable (${writeError}); skipping the import entirely rather than copying rows we could not mark as imported. Make it writable and restart.`,
      );
      return declined(`legacy database not writable: ${writeError}`);
    }

    return copyEverything(opts.db, legacyPath, scopesDir, log);
  } catch (err) {
    log(`[domain-import] import failed: ${errText(err)}`);
    return declined(`import failed: ${errText(err)}`);
  } finally {
    // Same hazard as the DETACH below: a throw in a `finally` replaces whatever the try
    // block returned, so a cleanup failure would erase the real result on the way out.
    try {
      legacy.close();
    } catch (err) {
      log(`[domain-import] could not close the legacy database handle: ${errText(err)}`);
    }
  }
}

/**
 * The whole import, as ONE transaction: every table copy, the scope→domain rows, the
 * derived-cursor clamp, AND the marker write. It commits only if all of them succeeded.
 *
 * This is the structural form of the doctrine "copy nothing at all rather than copying
 * rows we could not mark as imported". The previous shape enforced that at one call site
 * (the unwritable-legacy probe) and left every other failure trigger — a missing target
 * table, SQLITE_FULL — committing rows with the marker withheld, which then retried on
 * every start and resurrected rows the user had deleted. Making it a transaction rather
 * than a rule to remember means no failure trigger, present or future, can leave a
 * partial commit.
 *
 * The marker lives in the legacy database, which is ATTACHed here, so it is written as
 * `legacy.daemon_state` on this same connection and is inside the transaction — verified
 * by running: a ROLLBACK undoes the marker and the copies together.
 *
 * One honest limit: SQLite's atomic multi-database COMMIT uses a master journal, which
 * WAL mode disables. So a hard crash *during the commit itself* could in principle leave
 * the two files disagreeing. Every ERROR path — which is what this function is defending
 * against — rolls back atomically, and a SIGKILL mid-copy was verified to leave the
 * target empty and the legacy file byte-identical.
 */
function copyEverything(
  target: Database,
  legacyPath: string,
  scopesDir: string,
  log: (msg: string) => void,
): ImportResult {
  const tables: TableImportResult[] = [];
  let domains = { imported: 0, skipped: 0 };
  let aborted: string | null = null;

  // ATTACH and DETACH cannot run inside a transaction, so they bracket it.
  target.run("ATTACH DATABASE ? AS legacy", [legacyPath]);
  try {
    target.run("BEGIN");
    try {
      domains = importScopesAsDomains(target, scopesDir, log);
      logUnimportedLegacyTables(target, log);

      for (const table of IMPORTED_TABLES) {
        // SQLITE_FULL aborts the transaction out from under us; without this check the
        // remaining copies would run in autocommit and be permanently committed.
        if (!target.inTransaction) {
          aborted = "the transaction was aborted by SQLite (typically a full disk)";
          break;
        }
        tables.push(copyTable(target, table, log));
      }

      // The domain stamp runs INSIDE the guarded region, next to the cursor clamp and
      // BEFORE the failure checks below (#3040 review R4). It used to sit after them,
      // immediately before writeMarker — which meant a stamp that failed on one table
      // and succeeded on another was COMMITted with sealed:true and no signal anywhere
      // in ImportResult, landing the user in a split partition having done nothing
      // wrong. This file was just repaired to be seal-or-nothing; the stamp has to hold
      // that property too rather than be excused from it.
      let stampFailures: string[] = [];
      if (aborted === null && target.inTransaction) {
        clampDerivedCursor(target, log);
        stampFailures = stampImportedDomainIds(target, log);
      }

      // Stamp failures join the copy failures, so the existing rollback-and-retry path
      // covers them and ImportResult names them. A row copied into the wrong partition
      // is not a successful import.
      const failedTables = [...new Set([...tables.filter((t) => t.failed).map((t) => t.table), ...stampFailures])];
      const result = summarize(tables, failedTables, domains);

      if (aborted !== null || !target.inTransaction) {
        const undone = safeRollback(target);
        log(`[domain-import] ${aborted ?? "the transaction is no longer active"} — ${undoneNote(undone)}`);
        return { ...result, ran: false, sealed: false, reason: aborted ?? "transaction aborted" };
      }

      if (failedTables.length > 0) {
        const undone = safeRollback(target);
        log(
          `[domain-import] ${failedTables.length} table(s) failed to import (${failedTables.join(", ")}); ${undoneNote(undone)} The legacy database is unmarked, so the import will be retried on the next start.`,
        );
        return result;
      }

      // Inside the transaction, in the legacy database, on this connection.
      writeMarker(target, result.totalCopied);
      target.run("COMMIT");

      const notCopiedNote =
        result.totalNotCopied > 0 ? `; ${result.totalNotCopied} row(s) not copied (already present or rejected)` : "";
      log(
        `[domain-import] imported ${result.totalCopied} row(s) and ${result.domainsImported} domain(s) from ${legacyPath}${notCopiedNote}`,
      );
      return { ...result, sealed: true };
    } catch (err) {
      // Roll back in its own try so a rollback failure cannot replace the real error —
      // an aborted transaction makes ROLLBACK itself throw "no transaction is active",
      // which is how a disk-full error got reported as a rollback error.
      const undone = safeRollback(target);
      // Return what actually happened rather than rethrowing into declined()'s zeros:
      // `ran:false, totalCopied:0` for a run that copied and rolled back 17 tables is
      // the same false report this whole finding is about. The caller must be able to
      // tell a failure from an empty import.
      const failedTables = tables.filter((t) => t.failed).map((t) => t.table);
      log(`[domain-import] import failed: ${errText(err)} — ${undoneNote(undone)}`);
      return {
        ...summarize(tables, failedTables, domains),
        ran: false,
        sealed: false,
        reason: `import failed: ${errText(err)}`,
      };
    }
  } finally {
    detachLegacy(target, log);
  }
}

/**
 * Close out the ATTACH without letting cleanup damage the caller.
 *
 * Two hazards, and the measured behaviour is not the obvious one. `DETACH` while a
 * transaction is still open does **not** throw on bun's SQLite — it silently succeeds and
 * leaves the shared handle mid-transaction, so every later query on the daemon's only
 * connection runs inside a transaction nobody knows is open. That is worse than a throw,
 * because nothing surfaces. So: force the transaction closed first, then detach, and
 * swallow only the detach's own error so it can never replace the real one on the way out
 * of a `finally`.
 *
 * Reachable at startup today; #3160's `mcx domain import --force` makes it reachable at
 * runtime on a daemon holding live sessions, and this repair makes rollback the routine
 * failure path rather than an exotic one.
 */
function detachLegacy(target: Database, log: (msg: string) => void): void {
  if (target.inTransaction) {
    log("[domain-import] transaction still open at detach — rolling back before releasing the legacy database");
    safeRollback(target);
  }
  try {
    target.run("DETACH DATABASE legacy");
  } catch (err) {
    log(`[domain-import] could not detach the legacy database: ${errText(err)}`);
  }
}

/**
 * Name legacy tables this import does not carry over. Every one is excluded on purpose
 * today (caches, telemetry, schema_versions), but a user who ran a newer mcx once and
 * downgraded would otherwise lose an unknown table permanently under a success message.
 */
function logUnimportedLegacyTables(target: Database, log: (msg: string) => void): void {
  try {
    const rows = target
      .query<{ name: string }, []>(
        "SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const known = new Set<string>([...IMPORTED_TABLES, "schema_versions"]);
    const unimported = rows.map((r) => r.name).filter((n) => !known.has(n));
    if (unimported.length > 0) {
      log(
        `[domain-import] not importing legacy table(s) ${unimported.join(", ")} — caches/telemetry, rebuilt on demand`,
      );
    }
  } catch (err) {
    log(`[domain-import] could not enumerate legacy tables: ${errText(err)}`);
  }
}

/**
 * "sealed:false means nothing landed" is the invariant. On the rare path where the
 * rollback itself did not take, say so at maximum volume rather than repeating the claim.
 */
function undoneNote(undone: boolean): string {
  return undone
    ? "ROLLED BACK — nothing was imported."
    : "WARNING: the ROLLBACK did not take and a transaction is still open — the target database may hold partial data. Stop the daemon and inspect it before continuing.";
}

function summarize(
  tables: TableImportResult[],
  failedTables: string[],
  domains: { imported: number; skipped: number },
): ImportResult {
  return {
    ran: true,
    sealed: false,
    tables,
    failedTables,
    domainsImported: domains.imported,
    domainsSkipped: domains.skipped,
    totalCopied: tables.reduce((n, t) => n + t.copied, 0),
    totalNotCopied: tables.reduce((n, t) => n + t.notCopied, 0),
  };
}

/**
 * Roll back, and report whether the transaction is actually closed afterwards.
 *
 * Returns a boolean rather than swallowing, because every caller uses it to justify the
 * claim "nothing was imported" — and a rollback that silently failed would make
 * `sealed:false` mean the one thing this whole repair exists to rule out. A ROLLBACK that
 * throws because SQLite already aborted the transaction is success (nothing is left to
 * undo); a transaction still open afterwards is not.
 */
function safeRollback(db: Database): boolean {
  try {
    if (db.inTransaction) db.run("ROLLBACK");
  } catch {
    // Typically "no transaction is active" — SQLite already aborted it for us.
  }
  return !db.inTransaction;
}

/**
 * Can we actually write to the legacy database? `{ readwrite: true }` is a request, not
 * a guarantee — a read-only mount, a restored backup, a different uid or an SELinux
 * denial all yield a handle that only fails on first write. Returns the error message,
 * or null when writable. Leaves no trace: the probe is rolled back.
 *
 * No retry loop: `busy_timeout` on the handle already waits out contention, so a second
 * attempt only doubles the worst-case wall time without changing any outcome.
 */
function probeLegacyWritable(legacy: Database): string | null {
  try {
    legacy.run("BEGIN IMMEDIATE");
    legacy.run("CREATE TABLE mcx_import_write_probe (ok INTEGER)");
    legacy.run("ROLLBACK");
    return null;
  } catch (err) {
    try {
      if (legacy.inTransaction) legacy.run("ROLLBACK");
    } catch {
      // nothing open to undo
    }
    return errText(err);
  }
}

/**
 * Which of the tables the import populates already hold rows, and how many.
 *
 * Derived from {@link IMPORTED_TABLES} — the same constant `copyEverything` iterates —
 * so the emptiness precondition and the copy can never disagree about which tables are
 * in scope. A second, hand-maintained list is how the predecessor of this function
 * (`targetLooksEmpty`) came to inspect six tables while omitting `monitor_events`: the
 * one carrying an AUTOINCREMENT primary key, and the one a live daemon writes at startup
 * and continuously thereafter. It reported EMPTY over a populated event log, which is
 * precisely the case a guard built on it would have to catch (#3035 review finding 1).
 */
export function nonEmptyImportedTables(target: Database): Array<{ table: string; rows: number }> {
  const out: Array<{ table: string; rows: number }> = [];
  for (const table of IMPORT_WRITTEN_TABLES) {
    try {
      const rows = target.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get()?.n ?? 0;
      if (rows > 0) out.push({ table, rows });
    } catch {
      // table absent — contributes nothing
    }
  }
  return out;
}

/** Total rows currently held in `mcx.db` across the tables the import populates. */
function countImportedRows(target: Database): number {
  return nonEmptyImportedTables(target).reduce((n, t) => n + t.rows, 0);
}

/**
 * Is the imported data missing from `mcx.db`?
 *
 * Compares against the row count recorded alongside the marker rather than asking "is
 * this file completely blank?" — the blank test was silenced permanently by a single
 * unrelated row (a session restore, one `mcx claude spawn`), which is exactly the case
 * the loud warning exists for (#3034 review Y9).
 */
function importedDataMissing(target: Database, expected: number | null): boolean {
  const actual = countImportedRows(target);
  if (expected === null) return actual === 0; // pre-count marker: fall back to the blank test
  if (expected === 0) return false; // nothing was imported, so nothing can be missing
  return actual < expected;
}

function clampDerivedCursor(target: Database, log: (msg: string) => void): void {
  // Read the LEGACY side, not main. This runs inside the ATTACH and after the copies, so
  // `main.monitor_events` holds the imported rows PLUS anything the target already had —
  // and parking the cursor at that maximum permanently skips live events that were never
  // processed. The events this clamp exists to suppress are exactly the imported ones, so
  // the bound is the legacy maximum. On a virgin target the two are equal, which is why
  // the startup path is unaffected either way.
  //
  // Tolerant: if monitor_events or derived_cursor is absent there is nothing to replay,
  // and copyTable has already flagged the missing table as `failed` so the marker is
  // withheld regardless. This must not abort the other sixteen copies.
  try {
    const row = target
      .query<{ max_seq: number | null }, []>("SELECT MAX(seq) AS max_seq FROM legacy.monitor_events")
      .get();
    const maxSeq = row?.max_seq ?? null;
    if (maxSeq === null || maxSeq <= 0) return;
    target.run(
      `INSERT INTO derived_cursor (domain_id, id, last_seq) VALUES (?, ?, ?)
       ON CONFLICT(domain_id, id) DO UPDATE SET last_seq = MAX(derived_cursor.last_seq, excluded.last_seq)`,
      [NO_DOMAIN_ID, DERIVED_CURSOR_ID, maxSeq],
    );
    log(`[domain-import] derived-event cursor parked at seq ${maxSeq} — imported events are history, not new work`);
  } catch (err) {
    log(`[domain-import] could not park the derived-event cursor: ${errText(err)}`);
  }
}

/**
 * Copy one table via the attached legacy database, restricted to the columns both
 * schemas share. A column present only in the new schema takes its default (that is
 * how every `domain_id` arrives as the unassigned sentinel); a column present only in
 * the legacy schema is dropped.
 *
 * A copy error is reported as `failed`, not thrown: one unmappable table should not
 * abandon the other sixteen. The caller withholds the marker when anything failed.
 */
function copyTable(
  target: Database,
  table: (typeof IMPORTED_TABLES)[number],
  log: (msg: string) => void,
): TableImportResult {
  const filter = TABLE_FILTERS[table];
  const where = filter ? ` WHERE ${filter.sql}` : "";
  const params = filter?.params ?? [];

  const sourceCols = columnsOf(target, "legacy", table);
  if (sourceCols.length === 0) {
    return { table, copied: 0, notCopied: 0, failed: false, reason: "absent from legacy database" };
  }
  const targetCols = new Set(columnsOf(target, "main", table));
  if (targetCols.size === 0) {
    // The table exists in the legacy DB but not here — its rows are silently lost unless
    // this counts as a failure. It means a schema consumer did not migrate before the
    // import ran, which is a bug, not a benign skip.
    const total = countRows(target, "legacy", table, where, params);
    return { table, copied: 0, notCopied: total, failed: true, reason: "absent from mcx.db (consumer not migrated)" };
  }

  const shared = sourceCols.filter((c) => targetCols.has(c));
  const droppedCols = sourceCols.filter((c) => !targetCols.has(c));
  if (droppedCols.length > 0) {
    log(`[domain-import] ${table}: dropping legacy-only column(s) ${droppedCols.join(", ")} — absent from mcx.db`);
  }
  const total = countRows(target, "legacy", table, where, params);
  if (shared.length === 0) {
    return { table, copied: 0, notCopied: total, failed: total > 0, reason: "no columns in common" };
  }
  if (total === 0) return { table, copied: 0, notCopied: 0, failed: false };

  const targetRowsBefore = countRows(target, "main", table);
  const columnList = shared.map(quoteIdent).join(", ");
  try {
    // INSERT OR IGNORE, not OR REPLACE: a row already in mcx.db wins over the legacy
    // copy, so a re-run never clobbers post-import work.
    //
    // The deliberate consequence, recorded here because it looks like a bug to fix: the
    // importer can only ADD, never reconcile. A row deleted in mcx.db after a first pass
    // is RESURRECTED if the import runs again. That is why sealing the marker matters
    // (an unsealed import retries on every start) and why an unwritable legacy DB now
    // copies nothing at all rather than copying rows it could not mark as imported.
    // Do not "fix" this by switching to OR REPLACE — that trades resurrection for
    // clobbering the user's live data, which is strictly worse.
    const res = target.run(
      `INSERT OR IGNORE INTO main.${quoteIdent(table)} (${columnList}) SELECT ${columnList} FROM legacy.${quoteIdent(table)}${where}`,
      params,
    );
    const notCopied = Math.max(0, total - res.changes);
    if (notCopied > 0 && targetRowsBefore === 0) {
      // "already present" is impossible when the target table started empty, so these
      // rows were rejected by a constraint — data loss, not a benign re-run.
      log(`[domain-import] ${table}: ${notCopied} row(s) REJECTED (target table was empty, so not duplicates)`);
    }
    return { table, copied: res.changes, notCopied, failed: false };
  } catch (err) {
    log(`[domain-import] table ${table} failed: ${errText(err)}`);
    return { table, copied: 0, notCopied: total, failed: true, reason: errText(err) };
  }
}

/**
 * Map imported `alias_state` and `monitor_events` rows onto the domains just created from
 * the scope sidecars.
 *
 * Shares its row-mapping with the boot-time adopter (`adopt-domains.ts`) so the two cannot
 * disagree about which domain owns a root. They differ only in collision policy, which is
 * a real difference and not a knob: here a collision must abort so the whole copy rolls
 * back and retries, because this file is seal-or-nothing (#3040 review R4).
 */
function stampImportedDomainIds(target: Database, log: (msg: string) => void): string[] {
  const domains = target
    .query<{ id: number; name: string; host: string | null; path: string; created_at: string }, []>(
      "SELECT id, name, host, path, created_at FROM domains",
    )
    .all()
    .map((r): Domain => ({ id: r.id, name: r.name, host: r.host, path: r.path, createdAt: r.created_at }));
  if (domains.length === 0) return [];

  const failures: string[] = [];
  for (const spec of ADOPTABLE_TABLES) {
    try {
      const { stamped } = adoptUnassignedRows(target, domains, spec, "throw", log);
      if (stamped > 0) log(`[domain-import] ${spec.table}: stamped ${stamped} row(s) with a domain`);
    } catch (err) {
      // Reported, NOT swallowed (#3040 review R4): the caller folds this into failedTables
      // so the whole import rolls back and retries, the same treatment a failed copy gets.
      failures.push(spec.table);
      log(`[domain-import] ${spec.table}: could not stamp domain ids — ${errText(err)}`);
    }
  }
  return failures;
}

/**
 * Import `~/.mcp-cli/scopes/*.json` as domain rows. Scopes were the same idea —
 * a name bound to a root — stored as JSON sidecars with no partition role and no
 * host component, so every scope becomes a local domain.
 */
function importScopesAsDomains(
  target: Database,
  scopesDir: string,
  log: (msg: string) => void,
): { imported: number; skipped: number } {
  if (!existsSync(scopesDir)) return { imported: 0, skipped: 0 };

  let entries: string[];
  try {
    entries = readdirSync(scopesDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    log(`[domain-import] cannot read scopes directory ${scopesDir}: ${errText(err)}`);
    return { imported: 0, skipped: 0 };
  }

  // Parse first, then order by the sidecar's own `created` time — NOT by filename.
  // One location can hold one domain, so when two sidecars share a root exactly one
  // survives; picking by filename meant an obsolete `aaa-old.json` beat the live
  // `phoenix.json` on an alphabetical tiebreak the user was never told about, and the
  // domain name IS the addressing scheme post-#3034 (#3034 review Y10).
  const parsed: Array<{ name: string; root: string; createdAt: string; sortKey: string }> = [];
  let skipped = 0;

  for (const entry of entries.sort()) {
    const name = basename(entry, ".json");
    if (!isValidDomainName(name)) {
      log(`[domain-import] skipped scope "${name}": not a valid domain name`);
      skipped++;
      continue;
    }
    let scope: ScopeFile;
    try {
      scope = JSON.parse(readFileSync(join(scopesDir, entry), "utf-8")) as ScopeFile;
    } catch (err) {
      log(`[domain-import] skipped scope "${name}": ${errText(err)}`);
      skipped++;
      continue;
    }
    if (typeof scope?.root !== "string" || scope.root.length === 0) {
      log(`[domain-import] skipped scope "${name}": no root`);
      skipped++;
      continue;
    }
    // Scopes are local roots, so canonicalize like createDomain does. A relative or
    // tilde root throws rather than being anchored at the daemon's cwd.
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizeDomainPath(scope.root);
    } catch (err) {
      log(`[domain-import] skipped scope "${name}": ${errText(err)}`);
      skipped++;
      continue;
    }
    const createdAt = typeof scope.created === "string" && scope.created.length > 0 ? scope.created : nowIso();
    // Undated sidecars sort last, so a dated one always wins a location contest.
    const sortKey = typeof scope.created === "string" && scope.created.length > 0 ? createdAt : "\uffff";
    parsed.push({ name, root: canonicalRoot, createdAt, sortKey });
  }

  // Newest first: the most recently registered scope is the one the user is using.
  parsed.sort((a, b) => (a.sortKey === b.sortKey ? a.name.localeCompare(b.name) : b.sortKey.localeCompare(a.sortKey)));

  const insert = target.prepare("INSERT OR IGNORE INTO domains (name, host, path, created_at) VALUES (?, NULL, ?, ?)");
  const winnerByRoot = new Map<string, string>();
  let imported = 0;

  for (const scope of parsed) {
    const res = insert.run(scope.name, scope.root, scope.createdAt);
    if (res.changes > 0) {
      winnerByRoot.set(scope.root, scope.name);
      imported++;
      continue;
    }
    skipped++;
    const winner = winnerByRoot.get(scope.root);
    if (winner) {
      log(
        `[domain-import] skipped scope "${scope.name}": ${scope.root} is already registered as domain "${winner}" (newer sidecar wins; one domain per location)`,
      );
    } else {
      log(`[domain-import] skipped scope "${scope.name}": a domain with that name already exists`);
    }
  }
  return { imported, skipped };
}

// -- Marker (written into the LEGACY database) --

function readMarker(legacy: Database): string | null {
  try {
    const row = legacy
      .query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?")
      .get(IMPORT_MARKER_KEY);
    return row?.value ?? null;
  } catch {
    // No daemon_state table — a legacy DB this old carries nothing worth a marker check.
    return null;
  }
}

/** Rows the sealed import reported copying, or null if the marker predates the count. */
function readImportedRowCount(legacy: Database): number | null {
  try {
    const row = legacy
      .query<{ value: string }, [string]>("SELECT value FROM daemon_state WHERE key = ?")
      .get(IMPORT_ROWCOUNT_KEY);
    if (!row) return null;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the legacy database, **through the target connection** so this write is part of
 * the import's transaction and a rollback undoes it along with the copies.
 */
function writeMarker(target: Database, rowsCopied: number): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS legacy.daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  const upsert = `INSERT INTO legacy.daemon_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  target.run(upsert, [IMPORT_MARKER_KEY, nowIso()]);
  target.run(upsert, [IMPORT_ROWCOUNT_KEY, String(rowsCopied)]);
}

// -- Helpers --

function columnsOf(db: Database, schema: string, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

function countRows(db: Database, schema: string, table: string, where = "", params: string[] = []): number {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${schema}.${quoteIdent(table)}${where}`).get(...params) as {
      n: number;
    } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Quote a SQL identifier. Table and column names here come from PRAGMA output and
 * from IMPORTED_TABLES, never from user input, but interpolation into SQL is
 * unconditionally quoted rather than trusted case by case.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
