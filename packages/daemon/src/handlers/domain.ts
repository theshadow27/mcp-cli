/**
 * IPC handlers for `mcx domain` (#3035) — the domains table's only writer.
 *
 * The CLI never opens the database itself, which is why `which` cannot grow its own
 * walk-up loop: the resolution rule lives in `resolveDomainForPath` and reaches the CLI
 * only through {@link StateDb.resolveDomain}.
 */

import {
  type Domain,
  DomainAddParamsSchema,
  DomainImportParamsSchema,
  type DomainImportResult,
  DomainRemoveParamsSchema,
  type DomainRemoveResult,
  DomainRenameParamsSchema,
  DomainShowParamsSchema,
  DomainWhichParamsSchema,
  type DomainWhichResult,
  type IpcMethod,
  canonicalizeDomainPath,
  formatDomainLocation,
} from "@mcp-cli/core";
import { IMPORT_MARKER_KEY, importLegacyState } from "../db/import-legacy";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class DomainHandlers {
  /**
   * `importLegacy` is injected so a test can exercise the handler without falling back to
   * the importer's default source — running the real importer against the developer's own
   * `~/.mcp-cli/state.db` would stamp the one-shot marker on it. (The constant naming that
   * file is deliberately not referenced here: `domains.spec.ts` asserts that only the
   * importer itself may name it, so nothing else can quietly reopen the old database.)
   */
  constructor(
    private db: StateDb,
    private importLegacy: typeof importLegacyState = importLegacyState,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("domainAdd", async (params) => {
      const { name, host, path } = DomainAddParamsSchema.parse(params);

      // Pre-checked rather than caught: the UNIQUE indexes on `name` and on
      // `(COALESCE(host,''), path)` are the enforcement, but a raw constraint error
      // cannot say *which* domain already owns the location without sniffing its
      // message. Checking first lets the refusal name the conflicting domain.
      const byName = this.db.getDomainByName(name);
      if (byName) {
        throw new Error(`domain "${name}" already exists at ${formatDomainLocation(byName)}`);
      }
      const storedPath = host === null ? canonicalizeDomainPath(path) : path;
      const byLocation = this.db.listDomains().find((d) => d.host === host && d.path === storedPath);
      if (byLocation) {
        throw new Error(`${formatDomainLocation({ host, path: storedPath })} is already domain "${byLocation.name}"`);
      }

      return this.db.createDomain(name, path, host);
    });

    handlers.set("domainList", async () => this.db.listDomains());

    handlers.set("domainShow", async (params) => {
      const { name } = DomainShowParamsSchema.parse(params);
      return this.db.getDomainByName(name);
    });

    handlers.set("domainWhich", async (params) => {
      const { path } = DomainWhichParamsSchema.parse(params);
      const domains = this.db.listDomains();
      const result: DomainWhichResult = {
        domain: this.db.resolveDomain(path),
        registered: domains.map((d) => d.name),
      };
      return result;
    });

    handlers.set("domainRename", async (params) => {
      const { from, to } = DomainRenameParamsSchema.parse(params);
      const existing = this.db.getDomainByName(from);
      if (!existing) throw new Error(`no domain named "${from}"`);
      if (from !== to && this.db.getDomainByName(to)) {
        throw new Error(`domain "${to}" already exists`);
      }
      // A name change and nothing else: `id` is untouched, so every `domain_id`
      // reference survives, and `path` is untouched, so `which` keeps resolving.
      this.db.renameDomain(from, to);
      const renamed = this.db.getDomainByName(to);
      if (!renamed) throw new Error(`failed to rename domain "${from}" to "${to}"`);
      return renamed satisfies Domain;
    });

    handlers.set("domainRemove", async (params) => {
      const { name, cascade } = DomainRemoveParamsSchema.parse(params);
      const domain = this.db.getDomainByName(name);
      if (!domain) {
        return { found: false, removed: false, dependents: [] } satisfies DomainRemoveResult;
      }
      // `deleteDomain` is the sole decider: it counts dependents and refuses inside the
      // same call. Counting here first and re-deciding would make this a *second* decider,
      // and the two would disagree under concurrency — the event log writes continuously,
      // so a count of 0 here followed by an insert leaves `deleteDomain` throwing, which
      // bypasses the structured refusal this shape exists to produce. Ask forgiveness:
      // re-count only on the throw, purely to render the message.
      //
      // Not error-message sniffing: the cause is re-derived from the database, never from
      // the string.
      const dependents = cascade ? this.db.countDomainDependents(domain.id) : [];
      try {
        const removed = this.db.deleteDomain(name, { cascade });
        return { found: true, removed, dependents } satisfies DomainRemoveResult;
      } catch (err) {
        const blocking = this.db.countDomainDependents(domain.id);
        if (blocking.length === 0) throw err;
        // Refusal is a result, not an exception: the caller needs the per-table counts
        // to decide, and orphaning a thousand work items over a typo is unrecoverable.
        return { found: true, removed: false, dependents: blocking } satisfies DomainRemoveResult;
      }
    });

    handlers.set("domainImport", async (params) => {
      // `params` is optional: `mcx domain import` with no flags sends nothing.
      const { force } = DomainImportParamsSchema.parse(params ?? {});
      const log: string[] = [];
      const result = this.importLegacy({
        db: this.db.getDatabase(),
        force,
        log: (msg) => log.push(msg),
      });
      return {
        ran: result.ran,
        sealed: result.sealed,
        reason: result.reason,
        tables: result.tables.map((t) => ({
          table: t.table,
          copied: t.copied,
          notCopied: t.notCopied,
          failed: t.failed,
          reason: t.reason,
        })),
        failedTables: result.failedTables,
        domainsImported: result.domainsImported,
        domainsSkipped: result.domainsSkipped,
        totalCopied: result.totalCopied,
        totalNotCopied: result.totalNotCopied,
        markerKey: IMPORT_MARKER_KEY,
        log,
      } satisfies DomainImportResult;
    });
  }
}
