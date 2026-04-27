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
import {
  COPILOT_INLINE_POSTED,
  ISSUE_COMMENT,
  PR_COMMENT,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  REVIEW_COMMENTED,
  REVIEW_STICKY_UPDATED,
} from "@mcp-cli/core";
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

interface PollItemResult {
  isRateLimit: boolean;
  authError?: string;
  fetchError?: string;
}

export interface PRComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id: number | null;
  user: { login: string } | null;
  body: string;
  pull_request_url?: string;
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

export interface GitHubReview {
  id: number;
  user: { login: string; type?: string } | null;
  state: string;
  body: string;
  submitted_at: string;
}

export interface IssueComment {
  id: number;
  user: { login: string } | null;
  body: string;
}

export interface FetchCommentsResult {
  comments: PRComment[];
  rateLimitLow: boolean;
  rateLimitRemaining: number | null;
}

export interface FetchReviewsResult {
  reviews: GitHubReview[];
  rateLimitLow: boolean;
  rateLimitRemaining: number | null;
}

export interface FetchIssueCommentsResult {
  comments: IssueComment[];
  rateLimitLow: boolean;
  rateLimitRemaining: number | null;
}

export interface CopilotPollerOptions {
  workItemDb: WorkItemDb;
  stateDb: StateDb;
  logger?: Logger;
  intervalMs?: number;
  fetchRepoComments?: (repo: RepoInfo, since: string | null, token: string) => Promise<FetchCommentsResult>;
  fetchReviews?: (repo: RepoInfo, prNumber: number, token: string) => Promise<FetchReviewsResult>;
  fetchIssueComments?: (repo: RepoInfo, number: number, token: string) => Promise<FetchIssueCommentsResult>;
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
  private fetchRepoCommentsFn: NonNullable<CopilotPollerOptions["fetchRepoComments"]>;
  private fetchReviewsFn: NonNullable<CopilotPollerOptions["fetchReviews"]>;
  private fetchIssueCommentsFn: NonNullable<CopilotPollerOptions["fetchIssueComments"]>;
  private detectRepoFn: NonNullable<CopilotPollerOptions["detectRepo"]>;
  private getTokenFn: NonNullable<CopilotPollerOptions["getToken"]>;
  private onEvent: (event: MonitorEventInput) => void;

  constructor(opts: CopilotPollerOptions) {
    this.workItemDb = opts.workItemDb;
    this.stateDb = opts.stateDb;
    this.logger = opts.logger ?? consoleLogger;
    this.fixedInterval = opts.intervalMs ?? null;
    this.currentIntervalMs = this.fixedInterval ?? IDLE_INTERVAL_MS;
    this.fetchRepoCommentsFn = opts.fetchRepoComments ?? fetchRepoInlineComments;
    this.fetchReviewsFn = opts.fetchReviews ?? fetchPRReviews;
    this.fetchIssueCommentsFn = opts.fetchIssueComments ?? fetchIssueEndpointComments;
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
      const trackedIssues = allItems.filter(
        (item) => item.prNumber === null && item.issueNumber !== null && item.phase !== "done",
      );

      for (const item of allItems) {
        if (
          item.prNumber !== null &&
          (item.prState === "merged" || item.prState === "closed" || item.phase === "done")
        ) {
          this.stateDb.deleteCopilotCommentState(item.prNumber);
        } else if (item.prNumber === null && item.issueNumber !== null && item.phase === "done") {
          this.stateDb.deleteCopilotCommentState(item.issueNumber);
        }
      }

      if (tracked.length === 0 && trackedIssues.length === 0) {
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
      let anyRateLimitLow = false;
      let anyAuthError: string | null = null;
      const failedItemIds = new Set<string>();
      const fetchErrorMessages: string[] = [];
      const totalItems = tracked.length + trackedIssues.length;

      const collectResult = (r: PollItemResult, itemId: string): void => {
        if (r.isRateLimit) anyRateLimitLow = true;
        if (r.authError) anyAuthError = r.authError;
        if (r.fetchError) {
          failedItemIds.add(itemId);
          fetchErrorMessages.push(r.fetchError);
        }
      };

      // Batch-fetch all inline review comments in one repo-scoped call (#1738)
      let inlineByPr = new Map<number, PRComment[]>();
      if (tracked.length > 0) {
        const since = this.stateDb.getLastRepoPollTs();
        // `since=` is inclusive (>=updated_at); record pre-fetch ts so no comments fall through the gap
        const preFetchTs = new Date().toISOString();
        try {
          const result = await this.fetchRepoCommentsFn(repo, since, token);
          inlineByPr = groupCommentsByPr(result.comments);
          if (result.rateLimitLow) anyRateLimitLow = true;
          this.stateDb.updateLastRepoPollTs(preFetchTs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[mcpd] CopilotPoller failed to fetch repo comments: ${msg}`);
          if (msg.includes("rate limit")) anyRateLimitLow = true;
          else if (msg.includes("auth/scope") || msg.includes("auth failed")) anyAuthError = msg;
        }
      }

      for (const item of tracked) {
        if (this.stopped) return;
        this.processInlineComments(item, inlineByPr.get(item.prNumber as number) ?? []);
        if (this.stopped) return;
        collectResult(await this.pollReviews(repo, item, token), item.id);
        if (this.stopped) return;
        collectResult(await this.pollPRComments(repo, item, token), item.id);
      }
      for (const item of trackedIssues) {
        if (this.stopped) return;
        collectResult(await this.pollIssueComments(repo, item, token), item.id);
      }
      this.rateLimitBackoff = anyRateLimitLow;

      if (anyAuthError) {
        this._lastError = anyAuthError;
      } else if (failedItemIds.size > 0) {
        const unique = [...new Set(fetchErrorMessages)];
        this._lastError = `${failedItemIds.size}/${totalItems} items failed: ${unique.join("; ")}`;
      } else {
        this._lastError = null;
      }
      this._pollCount++;
      this.adjustInterval([...tracked, ...trackedIssues]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      this._pollCount++;
      this.logger.warn(`[mcpd] CopilotPoller poll failed: ${msg}`);
    } finally {
      this.polling = false;
    }
  }

  private processInlineComments(item: WorkItem, allComments: PRComment[]): void {
    const prNumber = item.prNumber as number;
    const comments = allComments.filter((c) => c.in_reply_to_id == null);

    const seenIds = new Set(this.stateDb.getSeenCommentIds(prNumber));
    const currentIds = comments.map((c) => c.id);
    const newComments = comments.filter((c) => !seenIds.has(c.id));

    if (newComments.length === 0) {
      if (currentIds.length > 0) {
        const mergedSeenIds = [...new Set([...seenIds, ...currentIds])];
        this.stateDb.updateSeenCommentIds(prNumber, mergedSeenIds);
      }
      return;
    }

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

    const unionIds = [...new Set([...seenIds, ...currentIds])];
    this.stateDb.updateSeenCommentIds(prNumber, unionIds);
  }

  private async pollReviews(repo: RepoInfo, item: WorkItem, token: string): Promise<PollItemResult> {
    const prNumber = item.prNumber as number;

    let result: FetchReviewsResult;
    try {
      result = await this.fetchReviewsFn(repo, prNumber, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[mcpd] CopilotPoller failed to fetch reviews for PR #${prNumber}: ${msg}`);
      if (msg.includes("rate limit")) return { isRateLimit: true };
      if (msg.includes("auth/scope") || msg.includes("auth failed")) return { isRateLimit: false, authError: msg };
      return { isRateLimit: false, fetchError: msg };
    }

    if (result.rateLimitLow) {
      this.logger.warn(`[mcpd] CopilotPoller: GitHub rate limit low (${result.rateLimitRemaining} remaining)`);
    }

    const reviews = result.reviews;
    if (this.stopped) return { isRateLimit: result.rateLimitLow };

    const seenIds = new Set(this.stateDb.getSeenReviewIds(prNumber));
    const currentIds = reviews.map((r) => r.id);
    const newReviews = reviews.filter((r) => !seenIds.has(r.id));

    for (const review of newReviews) {
      if (review.state === "PENDING") continue;

      const author = review.user?.login ?? "unknown";
      let eventName: string;
      switch (review.state) {
        case "APPROVED":
          eventName = REVIEW_APPROVED;
          break;
        case "CHANGES_REQUESTED":
          eventName = REVIEW_CHANGES_REQUESTED;
          break;
        default:
          eventName = REVIEW_COMMENTED;
          break;
      }

      this.onEvent({
        src: "daemon.copilot-poller",
        event: eventName,
        category: "review",
        workItemId: item.id,
        prNumber,
        reviewId: review.id,
        reviewer: author,
        author,
        ...(review.body ? { body: review.body } : {}),
      });
    }

    // Sticky detection: find the latest bot review and track its body hash.
    // Always store the hash (so it's ready for comparison next poll), but only
    // emit sticky_updated when the review was previously seen — a brand-new bot
    // review is already handled as a new review event above.
    let stickyCandidate: GitHubReview | null = null;
    for (const r of reviews) {
      if (r.user?.type === "Bot" && r.body) {
        if (!stickyCandidate || r.id > stickyCandidate.id) stickyCandidate = r;
      }
    }
    if (stickyCandidate) {
      const bodyHash = hashBody(stickyCandidate.body);
      const lastHash = this.stateDb.getStickyBodyHash(prNumber);
      if (seenIds.has(stickyCandidate.id) && lastHash !== null && lastHash !== bodyHash) {
        this.onEvent({
          src: "daemon.copilot-poller",
          event: REVIEW_STICKY_UPDATED,
          category: "review",
          workItemId: item.id,
          prNumber,
          reviewId: stickyCandidate.id,
          author: stickyCandidate.user?.login ?? "unknown",
          bodyHash,
        });
      }
      this.stateDb.updateStickyBodyHash(prNumber, bodyHash);
    }

    if (currentIds.length > 0) {
      const unionIds = [...new Set([...seenIds, ...currentIds])];
      this.stateDb.updateSeenReviewIds(prNumber, unionIds);
    }
    return { isRateLimit: result.rateLimitLow };
  }

  private async pollPRComments(repo: RepoInfo, item: WorkItem, token: string): Promise<PollItemResult> {
    const prNumber = item.prNumber as number;

    let result: FetchIssueCommentsResult;
    try {
      result = await this.fetchIssueCommentsFn(repo, prNumber, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[mcpd] CopilotPoller failed to fetch PR comments for PR #${prNumber}: ${msg}`);
      if (msg.includes("rate limit")) return { isRateLimit: true };
      if (msg.includes("auth/scope") || msg.includes("auth failed")) return { isRateLimit: false, authError: msg };
      return { isRateLimit: false, fetchError: msg };
    }

    if (result.rateLimitLow) {
      this.logger.warn(`[mcpd] CopilotPoller: GitHub rate limit low (${result.rateLimitRemaining} remaining)`);
    }

    const comments = result.comments;
    if (this.stopped) return { isRateLimit: result.rateLimitLow };

    const seenIds = new Set(this.stateDb.getSeenPRCommentIds(prNumber));
    const currentIds = comments.map((c) => c.id);
    const newComments = comments.filter((c) => !seenIds.has(c.id));

    for (const comment of newComments) {
      this.onEvent({
        src: "daemon.copilot-poller",
        event: PR_COMMENT,
        category: "review",
        workItemId: item.id,
        prNumber,
        commentId: comment.id,
        author: comment.user?.login ?? "unknown",
      });
    }

    if (currentIds.length > 0) {
      const unionIds = [...new Set([...seenIds, ...currentIds])];
      this.stateDb.updateSeenPRCommentIds(prNumber, unionIds);
    }
    return { isRateLimit: result.rateLimitLow };
  }

  private async pollIssueComments(repo: RepoInfo, item: WorkItem, token: string): Promise<PollItemResult> {
    const issueNumber = item.issueNumber as number;

    let result: FetchIssueCommentsResult;
    try {
      result = await this.fetchIssueCommentsFn(repo, issueNumber, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[mcpd] CopilotPoller failed to fetch issue comments for #${issueNumber}: ${msg}`);
      if (msg.includes("rate limit")) return { isRateLimit: true };
      if (msg.includes("auth/scope") || msg.includes("auth failed")) return { isRateLimit: false, authError: msg };
      return { isRateLimit: false, fetchError: msg };
    }

    if (result.rateLimitLow) {
      this.logger.warn(`[mcpd] CopilotPoller: GitHub rate limit low (${result.rateLimitRemaining} remaining)`);
    }

    const comments = result.comments;
    if (this.stopped) return { isRateLimit: result.rateLimitLow };

    const seenIds = new Set(this.stateDb.getSeenIssueCommentIds(issueNumber));
    const currentIds = comments.map((c) => c.id);
    const newComments = comments.filter((c) => !seenIds.has(c.id));

    for (const comment of newComments) {
      this.onEvent({
        src: "daemon.copilot-poller",
        event: ISSUE_COMMENT,
        category: "issue",
        workItemId: item.id,
        commentId: comment.id,
        author: comment.user?.login ?? "unknown",
      });
    }

    if (currentIds.length > 0) {
      const unionIds = [...new Set([...seenIds, ...currentIds])];
      this.stateDb.updateSeenIssueCommentIds(issueNumber, unionIds);
    }
    return { isRateLimit: result.rateLimitLow };
  }

  private adjustInterval(tracked: WorkItem[]): void {
    if (this.fixedInterval !== null) return;

    if (this.rateLimitBackoff) {
      this.currentIntervalMs = RATE_LIMIT_INTERVAL_MS;
      return;
    }

    const hasActive = tracked.some((item) => {
      if (item.phase === "done") return false;
      if (item.prNumber !== null) return item.prState !== "merged" && item.prState !== "closed";
      return true;
    });

    const target = hasActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

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

interface FetchPaginatedResult<T> {
  items: T[];
  rateLimitLow: boolean;
  rateLimitRemaining: number | null;
}

async function fetchPaginated<T>(startUrl: string, token: string): Promise<FetchPaginatedResult<T>> {
  const allItems: T[] = [];
  let rateLimitLow = false;
  let rateLimitRemaining: number | null = null;
  let url: string | null = startUrl;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await fetch(url, {
      headers: makeHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401) {
      clearTokenCache();
      throw new Error("GitHub API auth failed (401) — token cache cleared");
    }

    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number.parseInt(remaining, 10) === 0) {
        throw new Error("GitHub API rate limit exhausted (403)");
      }
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) {
        const retryAfterSeconds = Number.parseInt(retryAfter, 10);
        if (Number.isNaN(retryAfterSeconds)) {
          throw new Error(`GitHub API secondary rate limit (403): retry after ${retryAfter}`);
        }
        throw new Error(`GitHub API secondary rate limit (403): retry after ${retryAfterSeconds}s`);
      }
      throw new Error(`GitHub API auth/scope error (403): ${response.statusText}`);
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

    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) {
      throw new Error(`fetchPaginated: expected array, got ${typeof pageItems}`);
    }
    allItems.push(...(pageItems as T[]));

    url = parseNextUrl(response.headers.get("link"));
  }

  return { items: allItems, rateLimitLow, rateLimitRemaining };
}

async function fetchRepoInlineComments(
  repo: RepoInfo,
  since: string | null,
  token: string,
): Promise<FetchCommentsResult> {
  let url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/comments?sort=created&direction=desc&per_page=100`;
  if (since) {
    url += `&since=${encodeURIComponent(since)}`;
  }
  const result = await fetchPaginated<PRComment>(url, token);
  return { comments: result.items, rateLimitLow: result.rateLimitLow, rateLimitRemaining: result.rateLimitRemaining };
}

export function parsePrNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pulls\/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function groupCommentsByPr(comments: PRComment[]): Map<number, PRComment[]> {
  const map = new Map<number, PRComment[]>();
  for (const c of comments) {
    if (!c.pull_request_url) continue;
    const prNumber = parsePrNumberFromUrl(c.pull_request_url);
    if (prNumber === null) continue;
    let group = map.get(prNumber);
    if (!group) {
      group = [];
      map.set(prNumber, group);
    }
    group.push(c);
  }
  return map;
}

async function fetchPRReviews(repo: RepoInfo, prNumber: number, token: string): Promise<FetchReviewsResult> {
  const result = await fetchPaginated<GitHubReview>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews?per_page=100`,
    token,
  );
  return { reviews: result.items, rateLimitLow: result.rateLimitLow, rateLimitRemaining: result.rateLimitRemaining };
}

async function fetchIssueEndpointComments(
  repo: RepoInfo,
  number: number,
  token: string,
): Promise<FetchIssueCommentsResult> {
  const result = await fetchPaginated<IssueComment>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${number}/comments?per_page=100`,
    token,
  );
  return { comments: result.items, rateLimitLow: result.rateLimitLow, rateLimitRemaining: result.rateLimitRemaining };
}

function hashBody(body: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(body);
  return hasher.digest("hex").slice(0, 16);
}
