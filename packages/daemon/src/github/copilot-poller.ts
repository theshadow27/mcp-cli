/**
 * GitHub PR inline comment poller (#1578).
 *
 * Polls `GET /repos/{owner}/{repo}/pulls/{n}/comments` for each tracked PR,
 * tracks which comment IDs have been seen (persisted to SQLite), and emits
 * `copilot.inline_posted` events with only the diff (new comments).
 *
 * Adaptive cadence: 10s when active work items exist, 60s idle, 300s after merge.
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
import { clearTokenCache, detectRepo, getGhToken } from "./graphql-client";

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
  in_reply_to_id: number | null;
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

export interface FetchCommentsResult {
  comments: PRComment[];
  rateLimitLow: boolean;
  rateLimitRemaining: number | null;
}

export interface CopilotPollerOptions {
  workItemDb: WorkItemDb;
  stateDb: StateDb;
  logger?: Logger;
  intervalMs?: number;
  fetchComments?: (repo: RepoInfo, prNumber: number, token: string) => Promise<FetchCommentsResult>;
  detectRepo?: (cwd?: string) => Promise<RepoInfo>;
  getToken?: () => Promise<string>;
  onEvent?: (event: MonitorEventInput) => void;
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
  private rateLimitBackoff = false;
  private fetchCommentsFn: NonNullable<CopilotPollerOptions["fetchComments"]>;
  private detectRepoFn: NonNullable<CopilotPollerOptions["detectRepo"]>;
  private getTokenFn: NonNullable<CopilotPollerOptions["getToken"]>;
  private onEvent: (event: MonitorEventInput) => void;

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
      const tracked = allItems.filter(
        (item) =>
          item.prNumber !== null && item.phase !== "done" && item.prState !== "merged" && item.prState !== "closed",
      );

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

    let result: FetchCommentsResult;
    try {
      result = await this.fetchCommentsFn(repo, prNumber, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("rate limit") || msg.includes("403")) {
        this.rateLimitBackoff = true;
      }
      this.logger.warn(`[mcpd] CopilotPoller failed to fetch comments for PR #${prNumber}: ${msg}`);
      return;
    }

    if (result.rateLimitLow) {
      this.rateLimitBackoff = true;
      this.logger.warn(`[mcpd] CopilotPoller: GitHub rate limit low (${result.rateLimitRemaining} remaining)`);
    } else {
      this.rateLimitBackoff = false;
    }

    // Filter out threaded replies — only top-level review comments matter
    const comments = result.comments.filter((c) => c.in_reply_to_id == null);

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

const MAX_PAGES = 10;

function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "mcp-cli/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

async function fetchPRComments(repo: RepoInfo, prNumber: number, token: string): Promise<FetchCommentsResult> {
  const allComments: PRComment[] = [];
  let rateLimitLow = false;
  let rateLimitRemaining: number | null = null;
  let url: string | null =
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments?per_page=100`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await fetch(url, {
      headers: makeHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 401: clear token cache so next poll retries with fresh token
    if (response.status === 401) {
      clearTokenCache();
      throw new Error("GitHub API auth failed (401) — token cache cleared");
    }

    // 403: check if rate-limit exhaustion vs auth/scope issue
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number.parseInt(remaining, 10) === 0) {
        throw new Error("GitHub API rate limit exhausted (403)");
      }
      throw new Error(`GitHub API forbidden (403): ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null) {
      rateLimitRemaining = Number.parseInt(remaining, 10);
      if (rateLimitRemaining < RATE_LIMIT_WARN_THRESHOLD) {
        rateLimitLow = true;
      }
    }

    const pageComments = (await response.json()) as PRComment[];
    allComments.push(...pageComments);

    url = parseNextUrl(response.headers.get("link"));
  }

  return { comments: allComments, rateLimitLow, rateLimitRemaining };
}
