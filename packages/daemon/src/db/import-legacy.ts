/**
 * One-shot, best-effort import from the pre-domain `state.db` into `mcx.db` (#3034).
 *
 * This is deliberately **not** a migration. There is no rollback path, no dual-write,
 * no swap protocol, and no "migration in progress" state. `state.db` is left on disk
 * untouched apart from the marker written here, nothing opens it at runtime, and the
 * recovery story for a bad import is deleting `mcx.db` — which is sufficient for a
 * single-user local tool installed once.
 *
 * The marker lives in the **legacy** database, not in `mcx.db`, so deleting `mcx.db`
 * does not re-arm the import. `mcx domain import --force` is the only deliberate re-run.
 *
 * Best-effort means rows that do not map are skipped with a count reported, never
 * thrown. A failed import must not stop the daemon from starting.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isValidDomainName, normalizeDomainPath, options } from "@mcp-cli/core";

/** Shape of a `~/.mcp-cli/scopes/<name>.json` sidecar, as written by `mcx scope init`. */
interface ScopeFile {
  root: string;
  created?: string;
}

/** Key of the import marker row in the legacy DB's `daemon_state` table. */
export const IMPORT_MARKER_KEY = "mcx_domain_import_at";

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
const TABLE_FILTERS: Partial<Record<(typeof IMPORTED_TABLES)[number], string>> = {
  daemon_state: `key <> '${IMPORT_MARKER_KEY}'`,
};

export interface TableImportResult {
  table: string;
  copied: number;
  skipped: number;
  /** Present when the whole table was skipped rather than copied row by row. */
  reason?: string;
}

export interface ImportResult {
  /** False when the import was declined — no legacy DB, or the marker is already set. */
  ran: boolean;
  reason?: string;
  tables: TableImportResult[];
  domainsImported: number;
  domainsSkipped: number;
  totalCopied: number;
  totalSkipped: number;
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
  reason,
  tables: [],
  domainsImported: 0,
  domainsSkipped: 0,
  totalCopied: 0,
  totalSkipped: 0,
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
      return declined(`already imported at ${existingMarker}`);
    }

    const result = copyEverything(opts.db, legacy, legacyPath, scopesDir, log);
    writeMarker(legacy);
    const skippedNote = result.totalSkipped > 0 ? `; skipped ${result.totalSkipped} row(s)` : "";
    log(
      `[domain-import] imported ${result.totalCopied} row(s) and ${result.domainsImported} domain(s) from ${legacyPath}${skippedNote}`,
    );
    return result;
  } catch (err) {
    log(`[domain-import] import failed (legacy database left untouched): ${errText(err)}`);
    return declined(`import failed: ${errText(err)}`);
  } finally {
    legacy.close();
  }
}

function copyEverything(
  target: Database,
  legacy: Database,
  legacyPath: string,
  scopesDir: string,
  log: (msg: string) => void,
): ImportResult {
  const domains = importScopesAsDomains(target, scopesDir, log);

  const tables: TableImportResult[] = [];
  target.run("ATTACH DATABASE ? AS legacy", [legacyPath]);
  try {
    for (const table of IMPORTED_TABLES) {
      tables.push(copyTable(target, table, log));
    }
  } finally {
    target.run("DETACH DATABASE legacy");
  }

  const totalCopied = tables.reduce((n, t) => n + t.copied, 0);
  const totalSkipped = tables.reduce((n, t) => n + t.skipped, 0);
  return {
    ran: true,
    tables,
    domainsImported: domains.imported,
    domainsSkipped: domains.skipped,
    totalCopied,
    totalSkipped,
  };
}

/**
 * Copy one table via the attached legacy database, restricted to the columns both
 * schemas share. A column present only in the new schema takes its default (that is
 * how every `domain_id` arrives as the unassigned sentinel); a column present only in
 * the legacy schema is dropped.
 */
function copyTable(
  target: Database,
  table: (typeof IMPORTED_TABLES)[number],
  log: (msg: string) => void,
): TableImportResult {
  const filter = TABLE_FILTERS[table];
  const where = filter ? ` WHERE ${filter}` : "";
  const sourceCols = columnsOf(target, "legacy", table);
  if (sourceCols.length === 0) {
    return { table, copied: 0, skipped: 0, reason: "absent from legacy database" };
  }
  const targetCols = new Set(columnsOf(target, "main", table));
  if (targetCols.size === 0) {
    return { table, copied: 0, skipped: 0, reason: "absent from mcx.db" };
  }

  const shared = sourceCols.filter((c) => targetCols.has(c));
  if (shared.length === 0) {
    const total = countRows(target, "legacy", table, where);
    return { table, copied: 0, skipped: total, reason: "no columns in common" };
  }

  const total = countRows(target, "legacy", table, where);
  if (total === 0) return { table, copied: 0, skipped: 0 };

  const columnList = shared.map(quoteIdent).join(", ");
  try {
    // INSERT OR IGNORE, not OR REPLACE: a row already in mcx.db wins over the legacy
    // copy. Re-running with --force must never clobber post-import work.
    const res = target.run(
      `INSERT OR IGNORE INTO main.${quoteIdent(table)} (${columnList}) SELECT ${columnList} FROM legacy.${quoteIdent(table)}${where}`,
    );
    const copied = res.changes;
    return { table, copied, skipped: Math.max(0, total - copied) };
  } catch (err) {
    log(`[domain-import] skipped table ${table}: ${errText(err)}`);
    return { table, copied: 0, skipped: total, reason: errText(err) };
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
    const res = insert.run(name, normalizeDomainPath(scope.root), createdAt);
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

function countRows(db: Database, schema: string, table: string, where = ""): number {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${schema}.${quoteIdent(table)}${where}`).get() as {
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
