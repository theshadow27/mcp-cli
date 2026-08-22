/**
 * One-shot, best-effort import from the pre-domain `state.db` into `mcx.db` (#3034).
 *
 * This is deliberately **not** a migration. There is no rollback path, no dual-write,
 * no swap protocol, and no "migration in progress" state.
 *
 * The marker lives in the **legacy** database, not in `mcx.db`, so it survives deleting
 * `mcx.db`. That means **deleting `mcx.db` alone is not a recovery** — the import
 * declines and the daemon comes up empty. The recovery is to clear the marker as well:
 *
 * ```sh
 * rm ~/.mcp-cli/mcx.db
 * sqlite3 ~/.mcp-cli/state.db "DELETE FROM daemon_state WHERE key = 'mcx_domain_import_at';"
 * ```
 *
 * ({@link RECOVERY_INSTRUCTIONS} is this text, so the warning a user actually sees and
 * this comment cannot drift apart.)
 *
 * Best-effort applies to *rows*: individual rows that do not map are skipped and counted.
 * It does **not** extend to sealing the marker — a run in which any table failed outright
 * leaves the marker unset so the next start retries. A failed import must not stop the
 * daemon from booting, and must not silently become permanent.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { NO_DOMAIN_ID, canonicalizeDomainPath, isValidDomainName, options } from "@mcp-cli/core";
import { DERIVED_CURSOR_ID } from "../derived-events";

/** Shape of a `~/.mcp-cli/scopes/<name>.json` sidecar, as written by `mcx scope init`. */
interface ScopeFile {
  root: string;
  created?: string;
}

/** Key of the import marker row in the legacy DB's `daemon_state` table. */
export const IMPORT_MARKER_KEY = "mcx_domain_import_at";

/**
 * The literal recovery incantation, exported so the log message and the doc comment are
 * the same string. Deleting `mcx.db` on its own is NOT enough — the marker outlives it.
 */
export const RECOVERY_INSTRUCTIONS = `to re-run the import: rm ~/.mcp-cli/mcx.db && sqlite3 ~/.mcp-cli/state.db "DELETE FROM daemon_state WHERE key = '${IMPORT_MARKER_KEY}';"`;

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
 * Per-table row filters applied to the legacy SELECT.
 *
 * The import marker is written into the legacy `daemon_state`, so a `--force` re-run
 * would otherwise copy it into `mcx.db` — putting a marker in the database whose
 * deletion is supposed to be the recovery path.
 */
const TABLE_FILTERS: Partial<Record<(typeof IMPORTED_TABLES)[number], { sql: string; params: string[] }>> = {
  daemon_state: { sql: "key <> ?", params: [IMPORT_MARKER_KEY] },
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
   * `ran && !sealed` means the copy happened but the run is not final — it retries.
   */
  sealed: boolean;
  reason?: string;
  tables: TableImportResult[];
  /** Tables whose copy errored outright. Non-empty means the marker was withheld. */
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
  /** Directory of `mcx scope` JSON sidecars to import as domains. Defaults to `options.SCOPES_DIR`. */
  scopesDir?: string;
  /** Re-run even when the marker is set (`mcx domain import --force`). */
  force?: boolean;
  /** Progress/diagnostics sink. Defaults to stderr. */
  log?: (msg: string) => void;
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
  const scopesDir = opts.scopesDir ?? options.SCOPES_DIR;
  const log = opts.log ?? ((msg: string) => console.error(msg));

  if (!existsSync(legacyPath)) {
    return declined(`no legacy database at ${legacyPath}`);
  }

  let legacy: Database;
  try {
    legacy = new Database(legacyPath, { readwrite: true, create: false });
  } catch (err) {
    log(`[domain-import] cannot open legacy database ${legacyPath}: ${errText(err)}`);
    return declined(`cannot open ${legacyPath}`);
  }

  try {
    const existingMarker = readMarker(legacy);
    if (existingMarker !== null && !opts.force) {
      // The decline that means "your data is not here" must be the LOUDEST, not the
      // quietest. The marker outlives mcx.db, so a user who deleted mcx.db expecting a
      // re-import lands here and would otherwise boot silently onto an empty database.
      const reason = `already imported at ${existingMarker}`;
      if (targetLooksEmpty(opts.db)) {
        log(
          `[domain-import] WARNING: ${legacyPath} was already imported at ${existingMarker}, but ${options.DB_PATH} has no imported data. The daemon is starting on an EMPTY database — deleting mcx.db does not re-arm the import, because the marker lives in state.db. ${RECOVERY_INSTRUCTIONS}`,
        );
      } else {
        log(`[domain-import] ${reason} — skipping`);
      }
      return declined(reason);
    }

    // SQLite silently degrades `readwrite` to read-only rather than throwing at open
    // time, so the marker write would fail AFTER the copy — leaving rows imported, the
    // marker unset, and the import re-running on every start. Since INSERT OR IGNORE can
    // only add and never reconcile, that resurrects rows deleted after the first pass.
    // Probe first and copy nothing if we could not seal the result.
    const writeError = probeLegacyWritable(legacy);
    if (writeError !== null) {
      log(
        `[domain-import] legacy database ${legacyPath} is not writable (${writeError}); skipping the import entirely rather than copying rows we could not mark as imported. Make it writable and restart.`,
      );
      return declined(`legacy database not writable: ${writeError}`);
    }

    const result = copyEverything(opts.db, legacyPath, scopesDir, log);

    if (result.failedTables.length > 0) {
      // Best-effort covers rows, not tables. Withhold the marker so the next start
      // retries instead of sealing a wholly or partly failed import forever.
      log(
        `[domain-import] ${result.failedTables.length} table(s) failed to import (${result.failedTables.join(", ")}); NOT marking the legacy database as imported — the import will be retried on the next start.`,
      );
      return result;
    }

    writeMarker(legacy);
    result.sealed = true;
    const notCopiedNote =
      result.totalNotCopied > 0 ? `; ${result.totalNotCopied} row(s) not copied (already present or rejected)` : "";
    log(
      `[domain-import] imported ${result.totalCopied} row(s) and ${result.domainsImported} domain(s) from ${legacyPath}${notCopiedNote}`,
    );
    return result;
  } catch (err) {
    log(`[domain-import] import failed: ${errText(err)}`);
    return declined(`import failed: ${errText(err)}`);
  } finally {
    legacy.close();
  }
}

/**
 * Can we actually write to the legacy database? `{ readwrite: true }` is a request, not
 * a guarantee — a read-only mount, a restored backup, a different uid or an SELinux
 * denial all yield a handle that only fails on first write. Returns the error message,
 * or null when writable. Leaves no trace: the probe is rolled back.
 */
function probeLegacyWritable(legacy: Database): string | null {
  try {
    legacy.run("BEGIN IMMEDIATE");
    legacy.run("CREATE TABLE mcx_import_write_probe (ok INTEGER)");
    legacy.run("ROLLBACK");
    return null;
  } catch (err) {
    try {
      legacy.run("ROLLBACK");
    } catch {
      // no transaction was open — nothing to undo
    }
    return errText(err);
  }
}

/**
 * Does `mcx.db` look like nothing was ever imported into it? Used only to decide how
 * loudly to report a marker-set decline.
 */
function targetLooksEmpty(target: Database): boolean {
  for (const table of ["work_items", "aliases", "agent_sessions", "mail", "auth_tokens", "alias_state"]) {
    try {
      const row = target.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get();
      if ((row?.n ?? 0) > 0) return false;
    } catch {
      // table absent — counts as empty for this purpose
    }
  }
  return true;
}

function copyEverything(
  target: Database,
  legacyPath: string,
  scopesDir: string,
  log: (msg: string) => void,
): ImportResult {
  const domains = importScopesAsDomains(target, scopesDir, log);

  const tables: TableImportResult[] = [];
  // ATTACH and DETACH cannot run inside a transaction, so the BEGIN sits between them.
  // One transaction over all 17 copies gives a consistent snapshot and closes the window
  // where the derived cursor could be clamped against a partially-copied event log.
  target.run("ATTACH DATABASE ? AS legacy", [legacyPath]);
  try {
    target.run("BEGIN");
    try {
      for (const table of IMPORTED_TABLES) {
        tables.push(copyTable(target, table, log));
      }
      clampDerivedCursor(target, log);
      target.run("COMMIT");
    } catch (err) {
      target.run("ROLLBACK");
      throw err;
    }
  } finally {
    target.run("DETACH DATABASE legacy");
  }

  const failedTables = tables.filter((t) => t.failed).map((t) => t.table);
  for (const t of tables) {
    if (t.reason) log(`[domain-import] ${t.table}: ${t.failed ? "FAILED" : "skipped"} — ${t.reason}`);
  }

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
 * Park the derived-event cursor at the newest imported event.
 *
 * Imported `monitor_events` are history. Without this the cursor sits at 0 while
 * `currentSeq()` reports the imported maximum, so every historical event is reconciled
 * onto the live bus on first start — and derived rules mutate `work_items` and feed the
 * automation dispatcher. Clamping is preferred over dropping `monitor_events` from the
 * import because the event log is what `mcx monitor --since` replays; losing it loses
 * history that nothing else holds.
 */
function clampDerivedCursor(target: Database, log: (msg: string) => void): void {
  // Tolerant: if monitor_events or derived_cursor is absent there is nothing to replay,
  // and copyTable has already flagged the missing table as `failed` so the marker is
  // withheld regardless. This must not abort the other sixteen copies.
  try {
    const row = target
      .query<{ max_seq: number | null }, []>("SELECT MAX(seq) AS max_seq FROM main.monitor_events")
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
  const total = countRows(target, "legacy", table, where, params);
  if (shared.length === 0) {
    return { table, copied: 0, notCopied: total, failed: total > 0, reason: "no columns in common" };
  }
  if (total === 0) return { table, copied: 0, notCopied: 0, failed: false };

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
    return { table, copied: res.changes, notCopied: Math.max(0, total - res.changes), failed: false };
  } catch (err) {
    log(`[domain-import] table ${table} failed: ${errText(err)}`);
    return { table, copied: 0, notCopied: total, failed: true, reason: errText(err) };
  }
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

  const insert = target.prepare("INSERT OR IGNORE INTO domains (name, host, path, created_at) VALUES (?, NULL, ?, ?)");

  let imported = 0;
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
    const createdAt = typeof scope.created === "string" && scope.created.length > 0 ? scope.created : nowIso();
    // Scopes are local roots, so canonicalize like createDomain does. A relative or
    // tilde root now throws rather than being anchored at the daemon's cwd.
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizeDomainPath(scope.root);
    } catch (err) {
      log(`[domain-import] skipped scope "${name}": ${errText(err)}`);
      skipped++;
      continue;
    }
    const res = insert.run(name, canonicalRoot, createdAt);
    if (res.changes > 0) {
      imported++;
    } else {
      log(`[domain-import] skipped scope "${name}": a domain with that name or location already exists`);
      skipped++;
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

function writeMarker(legacy: Database): void {
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  legacy.run(
    `INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [IMPORT_MARKER_KEY, nowIso()],
  );
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
