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
import {
  IMPORT_MARKER_KEY,
  type ImportArmState,
  clearImportMarker,
  readImportMarkerValue,
  recoveryInstructions as recoveryInstructionsImpl,
} from "../db/import-legacy";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class DomainHandlers {
  /**
   * The import primitives are injected so a test can exercise the handler without falling
   * back to their defaults — clearing the marker on the developer's own legacy database
   * would re-arm a destructive one-shot import on their real install. (The constant naming
   * that file is deliberately not referenced here: `domains.spec.ts` asserts that only the
   * importer itself may name it, so nothing else can quietly reopen the old database.)
   */
  constructor(
    private db: StateDb,
    private clearMarker: () => ImportArmState = () => clearImportMarker(),
    private recoveryInstructions: () => string = () => recoveryInstructionsImpl(),
    private readMarker: () => { present: boolean; value: string | null } = () => readImportMarkerValue(),
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
      const recovery = this.recoveryInstructions();
      const base = { markerKey: IMPORT_MARKER_KEY, recovery, log };

      if (!force) {
        // READ the marker; do not assert it (#3160 review N1). This branch used to state
        // flatly that the marker was set and hand over an `rm` incantation — on an install
        // with no legacy database at all, which is every fresh install.
        const marker = this.readMarker();
        if (!marker.present) {
          return {
            ...base,
            armed: false,
            reason: "there is no legacy database to import from; nothing to arm",
          } satisfies DomainImportResult;
        }
        if (marker.value === null) {
          // Already armed. Not a failure — it is the state --force exists to produce.
          return { ...base, armed: true, alreadyArmed: true } satisfies DomainImportResult;
        }
        return {
          ...base,
          armed: false,
          markerSetAt: marker.value,
          reason: `the legacy database was already imported at ${marker.value}; re-arming clears that marker, which is destructive to the current database — re-run with --force`,
        } satisfies DomainImportResult;
      }

      // Arming is unconditional, and an emptiness check does NOT belong here.
      //
      // The obvious-looking improvement — refuse now if the database is not empty, so the
      // operator hears about it before restarting — cannot work: `mcx domain import` is an
      // IPC command, so a daemon is running by definition, and the daemon writes
      // `daemon.restarted` into `monitor_events` before it accepts its first request. The
      // target is therefore NEVER empty at arm time, including on the correct recovery
      // path, and the guard would refuse the very sequence it is printed alongside. Driving
      // the documented recovery end to end is what surfaced that; reading the code did not.
      //
      // So the single enforcement point is `importLegacyState`, at daemon startup, ahead of
      // the first write. Arming a start that then refuses is harmless: the marker stays
      // clear, the daemon boots normally, and the import runs once `mcx.db` is out of the
      // way. Nothing is copied and nothing is lost in the meantime.
      const armed = this.clearMarker();
      if (armed.state === "unavailable") {
        return { ...base, armed: false, reason: armed.reason } satisfies DomainImportResult;
      }
      log.push(
        armed.alreadyArmed
          ? "[domain-import] already armed — the next daemon start will run the import"
          : "[domain-import] marker cleared — the next daemon start will re-run the import",
      );
      return { ...base, armed: true, alreadyArmed: armed.alreadyArmed } satisfies DomainImportResult;
    });
  }
}
