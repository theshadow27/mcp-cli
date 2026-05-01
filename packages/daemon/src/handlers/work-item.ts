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
import type { WorkItemDb } from "../db/work-items";
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
  private resolveAndUpdateWorkItem(itemId: string, issueNumber: number): void {
    if (!this.resolveIssuePr) return;
    this.resolveIssuePr(issueNumber)
      .then((resolved) => {
        if (!resolved.prNumber) return;

        // Check for UNIQUE constraint: another item may already track this PR
        const existingByPr = this.workItemDb.getWorkItemByPr(resolved.prNumber);
        if (existingByPr && existingByPr.id !== itemId) {
          this.logger.info(
            `[mcpd] PR #${resolved.prNumber} already tracked by ${existingByPr.id}, skipping update for ${itemId}`,
          );
          return;
        }

        this.workItemDb.updateWorkItem(itemId, { prNumber: resolved.prNumber });
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
      const { number, branch, initialPhase, repoRoot } = TrackWorkItemParamsSchema.parse(params);

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
        const existing = this.workItemDb.getWorkItemByIssue(number) ?? this.workItemDb.getWorkItem(`#${number}`);
        if (existing) {
          // Backfill: if prNumber is null, kick off background re-resolution
          if (existing.prNumber === null && this.resolveIssuePr) {
            this.resolveAndUpdateWorkItem(existing.id, number);
          }
          return existing;
        }
      } else if (branch) {
        const existing = this.workItemDb.getWorkItemByBranch(branch);
        if (existing) return existing;
      }

      // Create the item immediately (non-blocking) so the caller isn't waiting on GitHub
      const id = number ? `#${number}` : `branch:${branch}`;
      const item = this.workItemDb.createWorkItem({
        id,
        issueNumber: number ?? null,
        prNumber: null,
        branch: branch ?? null,
        ...(initialPhase ? { phase: initialPhase as WorkItemPhase } : {}),
      });

      // Fire-and-forget: resolve PR number in the background
      if (number && this.resolveIssuePr) {
        this.resolveAndUpdateWorkItem(id, number);
      }

      return item;
    });

    handlers.set("untrackWorkItem", async (params, _ctx) => {
      const { number, branch } = UntrackWorkItemParamsSchema.parse(params);

      if (branch) {
        const existing = this.workItemDb.getWorkItemByBranch(branch) ?? this.workItemDb.getWorkItem(`branch:${branch}`);
        if (existing) {
          this.workItemDb.deleteWorkItem(existing.id);
          return { ok: true as const, deleted: true };
        }
        return { ok: true as const, deleted: false };
      }

      // Number-based lookup (number is guaranteed non-null when branch is absent per schema refine)
      const num = number as number;
      const existing =
        this.workItemDb.getWorkItemByPr(num) ??
        this.workItemDb.getWorkItemByIssue(num) ??
        this.workItemDb.getWorkItem(`#${num}`);
      if (existing) {
        this.workItemDb.deleteWorkItem(existing.id);
        return { ok: true as const, deleted: true };
      }
      return { ok: true as const, deleted: false };
    });

    handlers.set("listWorkItems", async (params, _ctx) => {
      const { phase } = ListWorkItemsParamsSchema.parse(params ?? {});
      return this.workItemDb.listWorkItems(phase ? { phase } : undefined);
    });

    handlers.set("getWorkItem", async (params, _ctx) => {
      const { id, number, branch } = GetWorkItemParamsSchema.parse(params);
      if (id) return this.workItemDb.getWorkItem(id);
      if (number !== undefined) {
        return this.workItemDb.getWorkItemByPr(number) ?? this.workItemDb.getWorkItemByIssue(number);
      }
      if (branch) return this.workItemDb.getWorkItemByBranch(branch);
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
