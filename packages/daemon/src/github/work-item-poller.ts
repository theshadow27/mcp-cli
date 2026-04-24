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
import { computeSrcChurn, consoleLogger } from "@mcp-cli/core";
import type { CiStatus, PrState, ReviewStatus, WorkItem } from "@mcp-cli/core";
import type { WorkItemDb } from "../db/work-items";
import { type MergeStatePR, computeCascadeHead } from "./cascade-head";
import { type CiEvent, type CiRunState, computeCiTransitions } from "./ci-events";
import { type FetchPRsOptions, type PRStatus, type RepoInfo, detectRepo, fetchTrackedPRs } from "./graphql-client";

export { computeSrcChurn };

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
  /** Called on each CI run event (ci.started / ci.running / ci.finished). */
  onCiEvent?: (event: CiEvent) => void;
  /** Injected for testing — override Date.now(). */
  now?: () => number;
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
  private polling = false;
  private stopped = false;
  private repoDetectFailures = 0;
  private fetchPRs: NonNullable<WorkItemPollerOptions["fetchPRs"]>;
  private detectRepoFn: NonNullable<WorkItemPollerOptions["detectRepo"]>;
  private onEvent: (event: WorkItemEvent) => void;
  private lastRateLimitWarnMs = 0;
  private onCiEvent: (event: CiEvent) => void;
  private nowFn: () => number;
  private readonly ciRunStates: Map<number, CiRunState>;

  constructor(opts: WorkItemPollerOptions) {
    this.db = opts.db;
    this.logger = opts.logger ?? consoleLogger;
    this.fixedInterval = opts.intervalMs ?? null;
    this.currentIntervalMs = this.fixedInterval ?? ACTIVE_INTERVAL_MS;
    this.fetchPRs = opts.fetchPRs ?? fetchTrackedPRs;
    this.detectRepoFn = opts.detectRepo ?? detectRepo;
    this.onEvent = opts.onEvent ?? (() => {});
    this.onCiEvent = opts.onCiEvent ?? (() => {});
    this.nowFn = opts.now ?? (() => Date.now());
    this.ciRunStates = this.db.loadCiRunStates();
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

  /** Start polling. Does an immediate first poll, then chains via setTimeout. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.scheduleNext(0);
  }

  /** Trigger an immediate poll cycle and reschedule the next tick.
   *  Useful when a new item is tracked — avoids waiting up to 5 minutes. */
  pollNow(): void {
    if (this.stopped) return;
    // Cancel the current timer and reschedule with 0 delay so the
    // next tick runs immediately, then resumes at currentIntervalMs.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

  /** Stop polling and clean up. In-flight polls will bail before writing. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.poll();
      this.scheduleNext(this.currentIntervalMs);
    }, delayMs);
  }

  /** Run a single poll cycle. Exported for testing. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      // Detect repo (with failure caching — stop retrying after 3 failures)
      if (!this._repo) {
        if (this.repoDetectFailures >= 3) {
          this._pollCount++;
          return;
        }
        try {
          this._repo = await this.detectRepoFn();
        } catch (err) {
          this.repoDetectFailures++;
          const msg = err instanceof Error ? err.message : String(err);
          if (this.repoDetectFailures >= 3) {
            this.logger.warn(`[mcpd] Repo detection failed ${this.repoDetectFailures} times, giving up: ${msg}`);
          } else {
            this.logger.warn(`[mcpd] Repo detection failed (attempt ${this.repoDetectFailures}/3): ${msg}`);
          }
          this._lastError = msg;
          this._pollCount++;
          return;
        }
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
      const statuses = await this.fetchPRs(this._repo, prNumbers, {
        warn: (msg) => {
          const now = Date.now();
          if (now - this.lastRateLimitWarnMs >= 60_000) {
            this.lastRateLimitWarnMs = now;
            this.logger.warn(msg);
          }
        },
      });

      if (this.stopped) return; // bail before writing if stopped during fetch

      // Build lookup by PR number
      const statusMap = new Map<number, PRStatus>();
      for (const s of statuses) {
        statusMap.set(s.number, s);
      }

      // Compute cascade head from the current snapshot of all fetched statuses
      const cascadeHead = computeCascadeHead(
        statuses.map(
          (s): MergeStatePR => ({
            prNumber: s.number,
            mergeStateStatus: s.mergeStateStatus,
            autoMergeEnabled: s.autoMergeEnabled,
            updatedAt: s.updatedAt,
          }),
        ),
      );

      // Compare and update
      for (const item of tracked) {
        if (this.stopped) return; // bail before writing if stopped mid-reconcile
        const status = statusMap.get(item.prNumber as number);
        if (!status) continue;
        this.reconcile(item, status, cascadeHead);
      }

      // Prune ciRunStates for PR numbers no longer tracked (e.g., work item untracked via prNumber clear)
      const trackedPrNums = new Set(prNumbers);
      for (const pr of this.ciRunStates.keys()) {
        if (!trackedPrNums.has(pr)) {
          this.ciRunStates.delete(pr);
          this.db.deleteCiRunState(pr);
        }
      }

      this._lastError = null;
      this._pollCount++;
      this.adjustInterval(hasActive);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      this._pollCount++;
      this.logger.warn(`[mcpd] Work item poll failed: ${msg}`);
    } finally {
      this.polling = false;
    }
  }

  /** Compare fetched PR status against stored work item and emit events for changes. */
  private reconcile(item: WorkItem, status: PRStatus, cascadeHead: number | null): void {
    const prNumber = item.prNumber as number; // Safe: caller filters for non-null prNumber
    const newPrState = mapPrState(status);
    const newCiStatus = mapCiStatus(status);
    const newReviewStatus = mapReviewStatus(status);
    const srcChurn = computeSrcChurn(status.files);
    const newMergeState = status.mergeStateStatus;

    const patch: Partial<WorkItem> = {};
    let changed = false;

    // PR state changes
    if (newPrState !== item.prState) {
      patch.prState = newPrState;
      changed = true;
      this.emitPrEvent(prNumber, newPrState, status, srcChurn);
    }

    // Push detection: HEAD OID changed on an open/draft PR (no state change).
    // Uses headRefOid persisted to SQLite so detection survives daemon restarts
    // and correctly handles force-pushes / rebases that don't change commit count.
    if (newPrState === item.prState && (newPrState === "open" || newPrState === "draft")) {
      const lastOid = this.db.getLastSeenHeadOid(prNumber);
      if (lastOid !== null && status.headRefOid && status.headRefOid !== lastOid) {
        this.onEvent({
          type: "pr:pushed",
          prNumber,
          branch: status.headRefName,
          base: status.baseRefName,
          commits: status.commitCount,
          srcChurn,
          ...(status.filesTruncated ? { filesTruncated: true } : {}),
        });
      }
    }
    // Persist current HEAD OID so next poll can detect changes (and restarts don't lose baseline).
    if (status.headRefOid) {
      this.db.setLastSeenHeadOid(prNumber, status.headRefOid);
    }

    // CI status changes
    if (newCiStatus !== item.ciStatus) {
      patch.ciStatus = newCiStatus;
      changed = true;
      this.emitCiEvent(prNumber, newCiStatus, status);
    }

    // Review status changes
    if (newReviewStatus !== item.reviewStatus) {
      patch.reviewStatus = newReviewStatus;
      changed = true;
      this.emitReviewEvent(prNumber, newReviewStatus, status);
    }

    // Merge state changes
    if (newMergeState !== (item.mergeStateStatus ?? null)) {
      patch.mergeStateStatus = newMergeState;
      changed = true;
      this.onEvent({
        type: "pr:merge_state_changed",
        prNumber,
        from: item.mergeStateStatus ?? null,
        to: newMergeState,
        cascadeHead,
      });
    }

    if (changed) {
      this.db.updateWorkItem(item.id, patch);
      this.logger.info(`[mcpd] Work item ${item.id} (PR #${prNumber}) updated: ${JSON.stringify(patch)}`);
    }

    // CI run events — separate from the coarse checks:started/passed/failed above
    if (status.ciChecks.length > 0) {
      const prev = this.ciRunStates.get(prNumber) ?? null;
      const { events: ciEvents, state: ciState } = computeCiTransitions(
        prNumber,
        item.id,
        prev,
        status.ciChecks,
        this.nowFn(),
      );
      if (ciState) {
        this.ciRunStates.set(prNumber, ciState);
        this.db.upsertCiRunState(prNumber, ciState);
      }
      for (const ev of ciEvents) {
        this.onCiEvent(ev);
      }
    }

    // Clean up CI state when PR is no longer active
    if (newPrState === "merged" || newPrState === "closed") {
      this.ciRunStates.delete(prNumber);
      this.db.deleteCiRunState(prNumber);
    }
  }

  private emitPrEvent(prNumber: number, newState: PrState, status: PRStatus, srcChurn: number): void {
    switch (newState) {
      case "merged":
        this.onEvent({ type: "pr:merged", prNumber, mergeSha: status.mergeCommitOid });
        break;
      case "closed":
        this.onEvent({ type: "pr:closed", prNumber });
        break;
      case "open":
        this.onEvent({
          type: "pr:opened",
          prNumber,
          branch: status.headRefName,
          base: status.baseRefName,
          commits: status.commitCount,
          srcChurn,
          ...(status.filesTruncated ? { filesTruncated: true } : {}),
        });
        break;
    }
  }

  private emitCiEvent(prNumber: number, newStatus: CiStatus, status: PRStatus): void {
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
        this.onEvent({ type: "checks:started", prNumber });
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
      return "pending";
    default:
      return "none";
  }
}

function mapReviewStatus(status: PRStatus): ReviewStatus {
  if (status.reviews.length === 0) return "none";
  // Filter to decisive review states — ignore COMMENTED/PENDING/DISMISSED
  // which don't change the approval status. Take the latest decisive review.
  const decisive = status.reviews.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED");
  if (decisive.length === 0) return "pending";
  const latest = decisive[decisive.length - 1];
  switch (latest.state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    default:
      return "pending";
  }
}
