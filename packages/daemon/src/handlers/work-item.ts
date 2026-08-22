import { resolve } from "node:path";
import {
  AliasStateAllParamsSchema,
  AliasStateDeleteParamsSchema,
  AliasStateGetParamsSchema,
  AliasStateSetParamsSchema,
  GetWorkItemParamsSchema,
  IPC_ERROR,
  ListWorkItemsParamsSchema,
  TrackWorkItemParamsSchema,
  UntrackWorkItemParamsSchema,
  resolveRealpath,
} from "@mcp-cli/core";
import type { IpcMethod, Logger, Manifest, WorkItemPhase } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { DomainWorkItems, WorkItemDb } from "../db/work-items";
import { resolveDomainId } from "../domain-scope";
import type { RequestHandler } from "../handler-types";

export class WorkItemHandlers {
  constructor(
    private readonly workItemDb: WorkItemDb,
    private readonly db: StateDb,
    private readonly resolveIssuePr: ((number: number) => Promise<{ prNumber: number | null }>) | null,
    private readonly loadManifestFn: ((repoRoot: string) => Manifest | null) | null,
    private readonly logger: Logger,
  ) {}

  /**
   * Fire-and-forget: resolve PR number via GitHub API and update the work item.
   * Handles UNIQUE constraint collisions by skipping if an item already
   * tracks the same PR number.
   */
  /**
   * The work-item handle for the domain this request came from.
   *
   * Resolved per request from the caller's cwd rather than held on the handler: one daemon
   * serves every domain on the box, so a handler-lifetime domain would be whichever project
   * happened to start it (#3037).
   */
  private scopeFor(cwd: string | undefined): DomainWorkItems {
    return this.workItemDb.forDomain(resolveDomainId(this.db, cwd));
  }

  private resolveAndUpdateWorkItem(scoped: DomainWorkItems, itemId: string, issueNumber: number): void {
    if (!this.resolveIssuePr) return;
    this.resolveIssuePr(issueNumber)
      .then((resolved) => {
        if (!resolved.prNumber) return;

        // Check for UNIQUE constraint: another item may already track this PR
        const existingByPr = scoped.getWorkItemByPr(resolved.prNumber);
        if (existingByPr && existingByPr.id !== itemId) {
          this.logger.info(
            `[mcpd] PR #${resolved.prNumber} already tracked by ${existingByPr.id}, skipping update for ${itemId}`,
          );
          return;
        }

        scoped.updateWorkItem(itemId, { prNumber: resolved.prNumber });
        this.logger.info(`[mcpd] Resolved #${issueNumber} → PR #${resolved.prNumber}`);
      })
      .catch((err) => {
        this.logger.warn(
          `[mcpd] Failed to resolve PR for #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("trackWorkItem", async (params, _ctx) => {
      const { number, branch, initialPhase, repoRoot, cwd, automationOverrides } =
        TrackWorkItemParamsSchema.parse(params);
      const scoped = this.scopeFor(cwd ?? repoRoot);

      // Validate initialPhase server-side when a manifest is available (#1351).
      // When no manifest is present (repoRoot absent or manifest missing), accept any string.
      if (initialPhase && repoRoot && this.loadManifestFn) {
        const manifest = this.loadManifestFn(repoRoot);
        if (manifest) {
          const declared = Object.keys(manifest.phases);
          if (!declared.includes(initialPhase)) {
            throw Object.assign(
              new Error(`unknown initialPhase "${initialPhase}". declared phases: ${declared.join(", ")}.`),
              { code: IPC_ERROR.INVALID_PARAMS },
            );
          }
        }
      }

      // Check if already tracked
      if (number) {
        const existing = scoped.getWorkItemByIssue(number) ?? scoped.getWorkItem(`#${number}`);
        if (existing) {
          if (existing.prNumber === null && this.resolveIssuePr) {
            this.resolveAndUpdateWorkItem(scoped, existing.id, number);
          }
          if (automationOverrides !== undefined) {
            return scoped.updateWorkItem(existing.id, { automationOverrides });
          }
          return existing;
        }
      } else if (branch) {
        const existing = scoped.getWorkItemByBranch(branch);
        if (existing) {
          if (automationOverrides !== undefined) {
            return scoped.updateWorkItem(existing.id, { automationOverrides });
          }
          return existing;
        }
      }

      // Create the item immediately (non-blocking) so the caller isn't waiting on GitHub
      const id = number ? `#${number}` : `branch:${branch}`;
      const item = scoped.createWorkItem({
        id,
        issueNumber: number ?? null,
        prNumber: null,
        branch: branch ?? null,
        ...(initialPhase ? { phase: initialPhase as WorkItemPhase } : {}),
        ...(automationOverrides ? { automationOverrides } : {}),
      });

      // Fire-and-forget: resolve PR number in the background
      if (number && this.resolveIssuePr) {
        this.resolveAndUpdateWorkItem(scoped, item.id, number);
      }

      return item;
    });

    handlers.set("untrackWorkItem", async (params, _ctx) => {
      const { number, branch, cwd } = UntrackWorkItemParamsSchema.parse(params);
      const scoped = this.scopeFor(cwd);

      if (branch) {
        const existing = scoped.getWorkItemByBranch(branch) ?? scoped.getWorkItem(`branch:${branch}`);
        if (existing) {
          scoped.deleteWorkItem(existing.id);
          return { ok: true as const, deleted: true, id: existing.id };
        }
        return { ok: true as const, deleted: false };
      }

      // Number-based lookup (number is guaranteed non-null when branch is absent per schema refine)
      const num = number as number;
      const existing = scoped.getWorkItemByPr(num) ?? scoped.getWorkItemByIssue(num) ?? scoped.getWorkItem(`#${num}`);
      if (existing) {
        scoped.deleteWorkItem(existing.id);
        return { ok: true as const, deleted: true, id: existing.id };
      }
      return { ok: true as const, deleted: false };
    });

    handlers.set("listWorkItems", async (params, _ctx) => {
      const { phase, includeArchived, cwd } = ListWorkItemsParamsSchema.parse(params ?? {});
      const scoped = this.scopeFor(cwd);
      // Only filter when caller explicitly opts in (includeArchived === false).
      // Unset or true means show everything so callers like mcx claude ls are unaffected.
      const excludeArchived = includeArchived === false;
      const items = scoped.listWorkItems({ ...(phase ? { phase } : {}), excludeArchived });
      const hiddenCount = excludeArchived ? scoped.countArchivedWorkItems() : 0;
      return { items, hiddenCount };
    });

    handlers.set("getWorkItem", async (params, _ctx) => {
      const { id, number, branch, cwd } = GetWorkItemParamsSchema.parse(params);
      const scoped = this.scopeFor(cwd);
      if (id) return scoped.getWorkItem(id);
      if (number !== undefined) {
        return scoped.getWorkItemByPr(number) ?? scoped.getWorkItemByIssue(number);
      }
      if (branch) return scoped.getWorkItemByBranch(branch);
      return null;
    });

    // -- Alias state (per-work-item / per-alias scratchpad) --

    handlers.set("aliasStateGet", async (params, _ctx) => {
      const parsed = AliasStateGetParamsSchema.parse(params);
      const repoRoot = resolveRealpath(resolve(parsed.repoRoot));
      return { value: this.db.getAliasState(repoRoot, parsed.namespace, parsed.key) };
    });

    handlers.set("aliasStateSet", async (params, _ctx) => {
      const parsed = AliasStateSetParamsSchema.parse(params);
      const repoRoot = resolveRealpath(resolve(parsed.repoRoot));
      this.db.setAliasState(repoRoot, parsed.namespace, parsed.key, parsed.value);
      return { ok: true as const };
    });

    handlers.set("aliasStateDelete", async (params, _ctx) => {
      const parsed = AliasStateDeleteParamsSchema.parse(params);
      const repoRoot = resolveRealpath(resolve(parsed.repoRoot));
      const deleted = this.db.deleteAliasState(repoRoot, parsed.namespace, parsed.key);
      return { ok: true as const, deleted };
    });

    handlers.set("aliasStateAll", async (params, _ctx) => {
      const parsed = AliasStateAllParamsSchema.parse(params);
      const repoRoot = resolveRealpath(resolve(parsed.repoRoot));
      return { entries: this.db.listAliasState(repoRoot, parsed.namespace) };
    });
  }
}
