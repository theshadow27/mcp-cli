/**
 * GitHub PR inline comment poller (#1578).
 *
 * Polls `GET /repos/{owner}/{repo}/pulls/{n}/comments` for each tracked PR,
 * tracks which comment IDs have been seen (persisted to SQLite), and emits
 * `copilot.inline_posted` events with only the diff (new comments).
 *
 * Adaptive cadence: 10s when PR has open threads, 60s idle, 300s after merge.
 * Respects GitHub API rate limits: backs off to 300s when remaining < 500.
 */

import type { Logger } from "@mcp-cli/core";
import { COPILOT_INLINE_POSTED } from "@mcp-cli/core";
import { consoleLogger } from "@mcp-cli/core";
import type { WorkItem } from "@mcp-cli/core";
import type { MonitorEventInput } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { WorkItemDb } from "../db/work-items";
import type { RepoInfo } from "./graphql-client";
import { detectRepo, getGhToken } from "./graphql-client";

// ── Cadence constants ──

const ACTIVE_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 60_000;
const MERGED_INTERVAL_MS = 300_000;
const RATE_LIMIT_INTERVAL_MS = 300_000;
const RATE_LIMIT_WARN_THRESHOLD = 500;
const REQUEST_TIMEOUT_MS = 10_000;

// ── Types ──

export interface PRComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  user: { login: string } | null;
  body: string;
}

export interface CopilotInlineEvent {
  event: typeof COPILOT_INLINE_POSTED;
  category: "copilot";
  workItemId: string;
  prNumber: number;
  newCount: number;
  commentIds: number[];
  firstLine: string;
  author: string;
}

export interface CopilotPollerOptions {
  workItemDb: WorkItemDb;
  stateDb: StateDb;
  logger?: Logger;
  intervalMs?: number;
  fetchComments?: (repo: RepoInfo, prNumber: number, token: string) => Promise<PRComment[]>;
  detectRepo?: (cwd?: string) => Promise<RepoInfo>;
  getToken?: () => Promise<string>;
  onEvent?: (event: MonitorEventInput) => void;
  now?: () => number;
}

// ── Poller ──

export class CopilotPoller {
  private workItemDb: WorkItemDb;
  private stateDb: StateDb;
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
  private lastRateLimitWarnMs = 0;
  private rateLimitBackoff = false;
  private fetchCommentsFn: NonNullable<CopilotPollerOptions["fetchComments"]>;
  private detectRepoFn: NonNullable<CopilotPollerOptions["detectRepo"]>;
  private getTokenFn: NonNullable<CopilotPollerOptions["getToken"]>;
  private onEvent: (event: MonitorEventInput) => void;
  private nowFn: () => number;

  constructor(opts: CopilotPollerOptions) {
    this.workItemDb = opts.workItemDb;
    this.stateDb = opts.stateDb;
    this.logger = opts.logger ?? consoleLogger;
    this.fixedInterval = opts.intervalMs ?? null;
    this.currentIntervalMs = this.fixedInterval ?? IDLE_INTERVAL_MS;
    this.fetchCommentsFn = opts.fetchComments ?? fetchPRComments;
    this.detectRepoFn = opts.detectRepo ?? detectRepo;
    this.getTokenFn = opts.getToken ?? getGhToken;
    this.onEvent = opts.onEvent ?? (() => {});
    this.nowFn = opts.now ?? (() => Date.now());
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

  start(): void {
    if (this.timer || this.stopped) return;
    this.scheduleNext(0);
  }

  pollNow(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

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

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
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
          this.logger.warn(`[mcpd] CopilotPoller repo detection failed (attempt ${this.repoDetectFailures}/3): ${msg}`);
          this._lastError = msg;
          this._pollCount++;
          return;
        }
      }

      const allItems = this.workItemDb.listWorkItems();
      const tracked = allItems.filter((item) => item.prNumber !== null);

      if (tracked.length === 0) {
        this._lastError = null;
        this._pollCount++;
        this.adjustInterval(tracked);
        return;
      }

      let token: string;
      try {
        token = await this.getTokenFn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._lastError = `Token acquisition failed: ${msg}`;
        this._pollCount++;
        return;
      }

      const repo = this._repo;
      for (const item of tracked) {
        if (this.stopped) return;
        await this.pollPR(repo, item, token);
      }

      this._lastError = null;
      this._pollCount++;
      this.adjustInterval(tracked);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      this._pollCount++;
      this.logger.warn(`[mcpd] CopilotPoller poll failed: ${msg}`);
    } finally {
      this.polling = false;
    }
  }

  private async pollPR(repo: RepoInfo, item: WorkItem, token: string): Promise<void> {
    const prNumber = item.prNumber as number;

    let comments: PRComment[];
    try {
      comments = await this.fetchCommentsFn(repo, prNumber, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("rate limit") || msg.includes("403")) {
        this.rateLimitBackoff = true;
      }
      this.logger.warn(`[mcpd] CopilotPoller failed to fetch comments for PR #${prNumber}: ${msg}`);
      return;
    }

    if (this.stopped) return;

    const seenIds = new Set(this.stateDb.getSeenCommentIds(prNumber));
    const currentIds = comments.map((c) => c.id);
    const newComments = comments.filter((c) => !seenIds.has(c.id));

    if (newComments.length === 0) {
      if (currentIds.length > 0) {
        this.stateDb.updateSeenCommentIds(prNumber, currentIds);
      }
      return;
    }

    // Group new comments by author
    const byAuthor = new Map<string, PRComment[]>();
    for (const comment of newComments) {
      const author = comment.user?.login ?? "unknown";
      let group = byAuthor.get(author);
      if (!group) {
        group = [];
        byAuthor.set(author, group);
      }
      group.push(comment);
    }

    for (const [author, authorComments] of byAuthor) {
      const commentIds = authorComments.map((c) => c.id);
      const earliest = authorComments[0];
      const line = earliest.line ?? earliest.original_line ?? 0;
      const pathBasename = earliest.path.split("/").pop() ?? earliest.path;
      const firstLine = `${pathBasename}:${line}`;

      this.onEvent({
        src: "daemon.copilot-poller",
        event: COPILOT_INLINE_POSTED,
        category: "copilot",
        workItemId: item.id,
        prNumber,
        newCount: authorComments.length,
        commentIds,
        firstLine,
        author,
      });
    }

    // Update seen IDs with full union
    const unionIds = [...new Set([...seenIds, ...currentIds])];
    this.stateDb.updateSeenCommentIds(prNumber, unionIds);
  }

  private adjustInterval(tracked: WorkItem[]): void {
    if (this.fixedInterval !== null) return;

    if (this.rateLimitBackoff) {
      this.currentIntervalMs = RATE_LIMIT_INTERVAL_MS;
      return;
    }

    const hasActive = tracked.some(
      (item) => item.phase !== "done" && item.prState !== "merged" && item.prState !== "closed",
    );
    const allMerged =
      tracked.length > 0 && tracked.every((item) => item.prState === "merged" || item.prState === "closed");

    let target: number;
    if (allMerged) {
      target = MERGED_INTERVAL_MS;
    } else if (hasActive) {
      target = ACTIVE_INTERVAL_MS;
    } else {
      target = IDLE_INTERVAL_MS;
    }

    if (target !== this.currentIntervalMs) {
      this.currentIntervalMs = target;
      this.logger.info(`[mcpd] CopilotPoller interval adjusted to ${target / 1000}s`);
    }
  }
}

// ── GitHub REST API ──

async function fetchPRComments(repo: RepoInfo, prNumber: number, token: string): Promise<PRComment[]> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments?per_page=100`;
  const response = await fetch(url, {
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mcp-cli/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number.parseInt(remaining, 10) < RATE_LIMIT_WARN_THRESHOLD) {
    const reset = response.headers.get("x-ratelimit-reset");
    const resetAt = reset ? new Date(Number.parseInt(reset, 10) * 1000).toISOString() : "unknown";
    throw new Error(`GitHub API rate limit low: ${remaining} remaining, resets at ${resetAt}`);
  }

  if (response.status === 403) {
    throw new Error("GitHub API rate limit exceeded (403)");
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as PRComment[];
}
