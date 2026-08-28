/**
 * IPC handlers for `mcx domain` (#3035) — the domains table's only writer.
 *
 * The CLI never opens the database itself, which is why `which` cannot grow its own
 * walk-up loop: the resolution rule lives in `resolveDomainForPath` and reaches the CLI
 * only through {@link McxDb.resolveDomain}.
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
  canonicalizeExistingDomainPath,
} from "@mcp-cli/core";
import {
  IMPORT_MARKER_KEY,
  type ImportArmState,
  clearImportMarker,
  readImportMarkerValue,
  recoveryInstructions as recoveryInstructionsImpl,
} from "../db/import-legacy";
import { DomainHasDependentsError, type McxDb } from "../db/state";
import { type DomainResolver, NULL_DOMAIN_RESOLVER } from "../domain-resolver";
import type { RequestHandler } from "../handler-types";

export class DomainHandlers {
  /**
   * The import primitives are injected so a test can exercise the handler without falling
   * back to their defaults — clearing the marker on the developer's own legacy database
   * would re-arm a destructive one-shot import on their real install. (The constant naming
   * that file is deliberately not referenced here: `domains.spec.ts` asserts that only the
   * importer itself may name it, so nothing else can quietly reopen the old database.)
   *
   * `domains` is the daemon's shared {@link DomainResolver} (#3040) — this class is the
   * `domains` table's only writer, so `createDomain`/`renameDomain`/`deleteDomain` must
   * invalidate its memo or every later lookup answers from a stale cache
   * (`domain-mutation-invalidates-resolver` rule). Defaults to the null resolver so a test
   * that does not care needs no extra wiring.
   */
  constructor(
    private db: McxDb,
    private clearMarker: () => ImportArmState = () => clearImportMarker(),
    private recoveryInstructions: () => string = () => recoveryInstructionsImpl(),
    private readMarker: () => { present: boolean; value: string | null } = () => readImportMarkerValue(),
    private readonly domains: DomainResolver = NULL_DOMAIN_RESOLVER,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("domainAdd", async (params) => {
      const { name, host, path } = DomainAddParamsSchema.parse(params);

      // The name/location collision check is NOT here any more (#3210). It used to read
      // the table and then call `createDomain`, so two writers could both pass it and the
      // loser got the bare `SQLITE_CONSTRAINT_UNIQUE` the check existed to replace.
      // `createDomain` now decides inside the transaction that writes, and its
      // `DomainConflictError` carries the same named-conflict message — one decider, the
      // shape `deleteDomain` took in #3180.
      //
      // What stays here is the one precondition a transaction CANNOT hold: the local path
      // must already exist. The filesystem is not in the database's transaction, so this
      // is a boundary check by nature — and this is the boundary that has the operator's
      // intent. `createDomain` stays the storage primitive (the legacy scope importer and
      // the resolution tests both register domains whose directories are not this
      // machine's concern); registering a domain at a path that does not exist yet is a
      // choice `mcx domain add` refuses to let someone make.
      if (host === null) canonicalizeExistingDomainPath(path);

      const created = this.db.createDomain(name, path, host);
      this.domains.invalidate();
      return created;
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
      // Same move as `domainAdd`: the "is `to` taken?" check and the re-read of the
      // renamed row both lived here and both raced (#3210). `renameDomain` now checks,
      // writes and returns the row in one transaction — `null` means no domain called
      // `from`, and a taken name throws a `DomainConflictError` with its own message.
      const renamed = this.db.renameDomain(from, to);
      if (!renamed) throw new Error(`no domain named "${from}"`);
      this.domains.invalidate();
      return renamed satisfies Domain;
    });

    handlers.set("domainRemove", async (params) => {
      const { name, cascade } = DomainRemoveParamsSchema.parse(params);
      const domain = this.db.getDomainByName(name);
      if (!domain) {
        return { found: false, removed: false, dependents: [], strandedSenders: 0 } satisfies DomainRemoveResult;
      }
      // `deleteDomain` is the sole decider: it counts dependents and refuses inside the
      // same call. Counting here first and re-deciding would make this a *second* decider,
      // and the two would disagree under concurrency — the event log writes continuously,
      // so a count of 0 here followed by an insert leaves `deleteDomain` throwing, which
      // bypasses the structured refusal this shape exists to produce.
      //
      // Both counts are for REPORTING a cascade only, which is why they are taken solely
      // on that branch: without `cascade` the numbers that reach the operator come off the
      // refusal, decided inside the transaction.
      const dependents = cascade ? this.db.countDomainDependents(domain.id) : [];
      // A cascade does not delete these (#3247) — they are another partition's rows. They
      // are reported so `mcx domain rm --force` can say which replies it just stranded.
      const stranded = cascade ? this.db.countStampedSenders(domain.name, domain.id) : 0;
      try {
        const removed = this.db.deleteDomain(name, { cascade });
        this.domains.invalidate();
        return { found: true, removed, dependents, strandedSenders: stranded } satisfies DomainRemoveResult;
      } catch (err) {
        // ONLY the refusal becomes a result. This catch used to re-count dependents on
        // any throw and return the refusal shape whenever the count was non-empty — but
        // the count is non-empty after *every* failed delete, because the transaction
        // rolled back. So `SQLITE_FULL`, corruption, or the `SQLITE_BUSY_SNAPSHOT` the
        // DEFERRED transaction used to produce all reached the operator as "reassign or
        // delete them first, or re-run with --force" — advice they had already taken —
        // with the real error string discarded (#3180).
        //
        // Branching on the type rather than on a re-count also removes the last reason to
        // touch the database here: `deleteDomain` refuses on counts taken inside its own
        // transaction and hands them over, so what the caller renders is what the refusal
        // was decided on, not a re-read of a database that has moved since.
        if (err instanceof DomainHasDependentsError) {
          // Refusal is a result, not an exception: the caller needs the per-table counts
          // to decide, and orphaning a thousand work items over a typo is unrecoverable.
          return {
            found: true,
            removed: false,
            dependents: err.dependents,
            strandedSenders: err.strandedSenders,
          } satisfies DomainRemoveResult;
        }
        throw err;
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
