/**
 * GitHub work item poller.
 *
 * Periodically fetches PR state from GitHub's GraphQL API and updates
 * the work_items table when state changes. Emits WorkItemEvent via callback.
 *
 * Adaptive polling: 30s when active items exist, 5min when all stable.
 *
 * Phase 2a of #1049.
 */

import type { Logger, WorkItemEvent } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import type { CiStatus, PrState, ReviewStatus, WorkItem, WorkItemDb } from "../db/work-items";
import { type FetchPRsOptions, type PRStatus, type RepoInfo, detectRepo, fetchTrackedPRs } from "./graphql-client";

const ACTIVE_INTERVAL_MS = 30_000;
const STABLE_INTERVAL_MS = 5 * 60_000;

export interface WorkItemPollerOptions {
  db: WorkItemDb;
  logger?: Logger;
  /** Override poll interval (ms). If set, disables adaptive interval. */
  intervalMs?: number;
  /** Injected for testing. */
  fetchPRs?: (repo: RepoInfo, prNumbers: readonly number[], opts?: FetchPRsOptions) => Promise<PRStatus[]>;
  /** Injected for testing. */
  detectRepo?: (cwd?: string) => Promise<RepoInfo>;
  /** Called on each work item event. */
  onEvent?: (event: WorkItemEvent) => void;
}

export class WorkItemPoller {
  private db: WorkItemDb;
  private logger: Logger;
  private fixedInterval: number | null;
  private currentIntervalMs: number;
  private timer: Timer | null = null;
  private _repo: RepoInfo | null = null;
  private _lastError: string | null = null;
  private _pollCount = 0;
  private fetchPRs: NonNullable<WorkItemPollerOptions["fetchPRs"]>;
  private detectRepoFn: NonNullable<WorkItemPollerOptions["detectRepo"]>;
  private onEvent: (event: WorkItemEvent) => void;

  constructor(opts: WorkItemPollerOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? consoleLogger;
    this.fixedInterval = opts.intervalMs ?? null;
    this.currentIntervalMs = this.fixedInterval ?? ACTIVE_INTERVAL_MS;
    this.fetchPRs = opts.fetchPRs ?? fetchTrackedPRs;
    this.detectRepoFn = opts.detectRepo ?? detectRepo;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get pollCount(): number {
    return this._pollCount;
  }

  get repo(): RepoInfo | null {
    return this._repo;
  }

  /** Start polling. Does an immediate first poll. */
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.currentIntervalMs);
  }

  /** Stop polling and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single poll cycle. Exported for testing. */
  async poll(): Promise<void> {
    try {
      // Detect repo on first poll
      if (!this._repo) {
        this._repo = await this.detectRepoFn();
      }

      const allItems = this.db.listWorkItems();
      const tracked = allItems.filter((item) => item.prNumber !== null);

      if (tracked.length === 0) {
        this._lastError = null;
        this._pollCount++;
        this.adjustInterval(false);
        return;
      }

      // Determine if any items are "active" (not done/merged/closed)
      const hasActive = tracked.some(
        (item) => item.phase !== "done" && item.prState !== "merged" && item.prState !== "closed",
      );

      // Safe: we filtered for prNumber !== null above
      const prNumbers = tracked.map((item) => item.prNumber as number);
      const statuses = await this.fetchPRs(this._repo, prNumbers);

      // Build lookup by PR number
      const statusMap = new Map<number, PRStatus>();
      for (const s of statuses) {
        statusMap.set(s.number, s);
      }

      // Compare and update
      for (const item of tracked) {
        const status = statusMap.get(item.prNumber as number);
        if (!status) continue;
        this.reconcile(item, status);
      }

      this._lastError = null;
      this._pollCount++;
      this.adjustInterval(hasActive);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      this._pollCount++;
      this.logger.warn(`[mcpd] Work item poll failed: ${msg}`);
    }
  }

  /** Compare fetched PR status against stored work item and emit events for changes. */
  private reconcile(item: WorkItem, status: PRStatus): void {
    const prNumber = item.prNumber as number; // Safe: caller filters for non-null prNumber
    const newPrState = mapPrState(status);
    const newCiStatus = mapCiStatus(status);
    const newReviewStatus = mapReviewStatus(status);

    const patch: Partial<WorkItem> = {};
    let changed = false;

    // PR state changes
    if (newPrState !== item.prState) {
      patch.prState = newPrState;
      changed = true;
      this.emitPrEvent(prNumber, newPrState);
    }

    // CI status changes
    if (newCiStatus !== item.ciStatus) {
      patch.ciStatus = newCiStatus;
      changed = true;
      this.emitCiEvent(prNumber, newCiStatus, item.ciRunId ?? 0, status);
    }

    // Review status changes
    if (newReviewStatus !== item.reviewStatus) {
      patch.reviewStatus = newReviewStatus;
      changed = true;
      this.emitReviewEvent(prNumber, newReviewStatus, status);
    }

    if (changed) {
      this.db.updateWorkItem(item.id, patch);
      this.logger.info(`[mcpd] Work item ${item.id} (PR #${prNumber}) updated: ${JSON.stringify(patch)}`);
    }
  }

  private emitPrEvent(prNumber: number, newState: PrState): void {
    switch (newState) {
      case "merged":
        this.onEvent({ type: "pr:merged", prNumber });
        break;
      case "closed":
        this.onEvent({ type: "pr:closed", prNumber });
        break;
      case "open":
        this.onEvent({ type: "pr:opened", prNumber });
        break;
    }
  }

  private emitCiEvent(prNumber: number, newStatus: CiStatus, ciRunId: number, status: PRStatus): void {
    switch (newStatus) {
      case "passed":
        this.onEvent({ type: "checks:passed", prNumber });
        break;
      case "failed": {
        const failedCheck = status.ciChecks.find((c) => c.conclusion === "FAILURE");
        this.onEvent({ type: "checks:failed", prNumber, failedJob: failedCheck?.name ?? "unknown" });
        break;
      }
      case "running":
      case "pending":
        this.onEvent({ type: "checks:started", prNumber, runId: ciRunId });
        break;
    }
  }

  private emitReviewEvent(prNumber: number, newStatus: ReviewStatus, status: PRStatus): void {
    switch (newStatus) {
      case "approved":
        this.onEvent({ type: "review:approved", prNumber });
        break;
      case "changes_requested": {
        const reviewer = status.reviews.find((r) => r.state === "CHANGES_REQUESTED")?.author ?? "unknown";
        this.onEvent({ type: "review:changes_requested", prNumber, reviewer });
        break;
      }
    }
  }

  /** Adjust the polling interval based on whether active items exist. */
  private adjustInterval(hasActive: boolean): void {
    if (this.fixedInterval !== null) return;
    const target = hasActive ? ACTIVE_INTERVAL_MS : STABLE_INTERVAL_MS;
    if (target !== this.currentIntervalMs) {
      this.currentIntervalMs = target;
      // Restart the timer with the new interval
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), this.currentIntervalMs);
      }
      this.logger.info(`[mcpd] Work item poll interval adjusted to ${target / 1000}s`);
    }
  }
}

// ---------- State mapping ----------

function mapPrState(status: PRStatus): PrState {
  switch (status.state) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "OPEN":
      return status.isDraft ? "draft" : "open";
    default:
      return "open";
  }
}

function mapCiStatus(status: PRStatus): CiStatus {
  if (!status.ciState) return "none";
  switch (status.ciState) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
      return "pending";
    case "EXPECTED":
      return "running";
    default:
      return "none";
  }
}

function mapReviewStatus(status: PRStatus): ReviewStatus {
  if (status.reviews.length === 0) return "none";
  // Use the most recent review state
  const latest = status.reviews[status.reviews.length - 1];
  switch (latest.state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
    case "PENDING":
      return "pending";
    default:
      return "none";
  }
}
