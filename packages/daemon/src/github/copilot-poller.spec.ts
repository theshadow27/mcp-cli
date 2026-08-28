import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import {
  ISSUE_COMMENT,
  NO_DOMAIN_ID,
  PR_COMMENT,
  PR_REVIEW_COMMENT_POSTED,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  REVIEW_COMMENTED,
  REVIEW_STICKY_UPDATED,
} from "@mcp-cli/core";
import { type CrossDomainWorkItems, type DomainWorkItems, WorkItemDb } from "../db/work-items";
import {
  CopilotPoller,
  type CopilotPollerOptions,
  type FetchCommentsResult,
  type FetchIssueCommentsResult,
  type FetchReviewsResult,
  type GitHubReview,
  type IssueComment,
  type PRComment,
  parsePrNumberFromUrl,
  repoDetectBackoffMs,
} from "./copilot-poller";
import type { RepoInfo } from "./graphql-client";
import { createCopilotStateDb } from "./test-helpers";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "test", repo: "repo" };

function okResult(comments: PRComment[]): FetchCommentsResult {
  return { comments, rateLimitLow: false, rateLimitRemaining: 5000 };
}

function makeComment(overrides: Partial<PRComment> & { id: number; prNumber?: number }): PRComment {
  const pr = overrides.prNumber ?? 42;
  const { prNumber: _, ...rest } = overrides;
  return {
    path: "src/index.ts",
    line: 10,
    original_line: null,
    in_reply_to_id: null,
    user: { login: "github-copilot[bot]" },
    body: "Consider refactoring this.",
    pull_request_url: `https://api.github.com/repos/test/repo/pulls/${pr}`,
    ...rest,
  };
}

function okReviewResult(reviews: GitHubReview[]): FetchReviewsResult {
  return { reviews, rateLimitLow: false, rateLimitRemaining: 5000 };
}

function okIssueCommentResult(comments: IssueComment[]): FetchIssueCommentsResult {
  return { comments, rateLimitLow: false, rateLimitRemaining: 5000 };
}

function makeReview(overrides: Partial<GitHubReview> & { id: number }): GitHubReview {
  return {
    user: { login: "github-copilot[bot]", type: "Bot" },
    state: "COMMENTED",
    body: "Review body.",
    submitted_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeIssueComment(overrides: Partial<IssueComment> & { id: number }): IssueComment {
  return {
    user: { login: "theshadow27" },
    body: "Some comment.",
    ...overrides,
  };
}

describe("CopilotPoller", () => {
  let rawDb: Database;
  /** Ring-0 handle handed to the poller — the thing under test. */
  let workItemDb: CrossDomainWorkItems;
  /** Scoped handle used only to ARRANGE rows. */
  let seed: DomainWorkItems;
  let stateDb: ReturnType<typeof createCopilotStateDb>;

  beforeEach(() => {
    rawDb = new Database(":memory:");
    const wdb = new WorkItemDb(rawDb);
    workItemDb = wdb.acrossDomains();
    seed = wdb.forDomain(NO_DOMAIN_ID);
    stateDb = createCopilotStateDb(rawDb);
  });

  afterEach(() => {
    rawDb.close();
  });

  function makePoller(overrides: Partial<CopilotPollerOptions> = {}) {
    const events: MonitorEventInput[] = [];
    const poller = new CopilotPoller({
      workItemDb,
      stateDb: stateDb as unknown as CopilotPollerOptions["stateDb"] extends infer T ? T : never,
      logger: SILENT_LOGGER,
      detectRepo: async () => TEST_REPO,
      getToken: async () => "test-token",
      fetchRepoComments: async () => okResult([]),
      fetchReviews: async () => okReviewResult([]),
      fetchIssueComments: async () => okIssueCommentResult([]),
      onEvent: (e) => events.push(e),
      ...overrides,
    });
    return { poller, events };
  }

  // ── Diff computation ──

  describe("diff computation", () => {
    test("empty: no comments yields no events", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult([]),
      });

      await poller.poll();

      expect(events).toHaveLength(0);
      expect(poller.pollCount).toBe(1);
    });

    test("all-new: first poll with comments emits event for each author", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const comments = [
        makeComment({ id: 1001, path: "src/a.ts", line: 5 }),
        makeComment({ id: 1002, path: "src/b.ts", line: 10 }),
      ];
      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult(comments),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.event).toBe(PR_REVIEW_COMMENT_POSTED);
      expect(evt.prNumber).toBe(42);
      expect(evt.newCount).toBe(2);
      expect(evt.commentIds).toEqual([1001, 1002]);
      expect(evt.firstLine).toBe("a.ts:5");
      expect(evt.author).toBe("github-copilot[bot]");
    });

    test("partial-new: only emits diff after seen IDs populated", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);

      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, path: "src/a.ts", line: 5 }),
            makeComment({ id: 1002, path: "src/b.ts", line: 20 }),
            makeComment({ id: 1003, path: "src/c.ts", line: 30 }),
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].commentIds).toEqual([1002, 1003]);
      expect(events[0].newCount).toBe(2);
      expect(events[0].firstLine).toBe("b.ts:20");
    });

    test("no diff: all comments already seen yields no events", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001, 1002]);

      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult([makeComment({ id: 1001 }), makeComment({ id: 1002 })]),
      });

      await poller.poll();

      expect(events).toHaveLength(0);
    });
  });

  // ── Per-author grouping ──

  describe("per-author grouping", () => {
    test("emits separate events per author", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, user: { login: "github-copilot[bot]" }, path: "src/a.ts", line: 1 }),
            makeComment({ id: 1002, user: { login: "human-reviewer" }, path: "src/b.ts", line: 2 }),
            makeComment({ id: 1003, user: { login: "github-copilot[bot]" }, path: "src/c.ts", line: 3 }),
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(2);
      const copilotEvt = events.find((e) => e.author === "github-copilot[bot]");
      const humanEvt = events.find((e) => e.author === "human-reviewer");

      expect(copilotEvt).toBeDefined();
      expect(copilotEvt?.commentIds).toEqual([1001, 1003]);
      expect(copilotEvt?.newCount).toBe(2);

      expect(humanEvt).toBeDefined();
      expect(humanEvt?.commentIds).toEqual([1002]);
      expect(humanEvt?.newCount).toBe(1);
    });
  });

  // ── Persistence ──

  describe("persistence", () => {
    test("seen IDs survive across polls", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchRepoComments: async () => {
          callCount++;
          if (callCount === 1) {
            return okResult([makeComment({ id: 1001 })]);
          }
          return okResult([makeComment({ id: 1001 }), makeComment({ id: 1002, path: "src/new.ts", line: 99 })]);
        },
      });

      await poller.poll();
      expect(events).toHaveLength(1);
      expect(events[0].commentIds).toEqual([1001]);

      await poller.poll();
      expect(events).toHaveLength(2);
      expect(events[1].commentIds).toEqual([1002]);
      expect(events[1].firstLine).toBe("new.ts:99");
    });

    test("persists full union of IDs to SQLite", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);

      const { poller } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 1001 }), makeComment({ id: 1002 }), makeComment({ id: 1003 })]),
      });

      await poller.poll();

      const stored = stateDb.getSeenCommentIds(42);
      expect(stored).toContain(1001);
      expect(stored).toContain(1002);
      expect(stored).toContain(1003);
    });
  });

  // ── firstLine ──

  describe("firstLine format", () => {
    test("uses path basename and line number", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 1001, path: "packages/daemon/src/poller.ts", line: 143 })]),
      });

      await poller.poll();

      expect(events[0].firstLine).toBe("poller.ts:143");
    });

    test("falls back to original_line when line is null", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 1001, path: "src/foo.ts", line: null, original_line: 50 })]),
      });

      await poller.poll();

      expect(events[0].firstLine).toBe("foo.ts:50");
    });
  });

  // ── Lifecycle ──

  describe("lifecycle", () => {
    test("no tracked PRs yields no events and no error", async () => {
      const { poller, events } = makePoller();

      await poller.poll();

      expect(events).toHaveLength(0);
      expect(poller.lastError).toBeNull();
      expect(poller.pollCount).toBe(1);
    });

    test("stop prevents further polls", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult([makeComment({ id: 1001 })]),
      });

      poller.stop();
      await poller.poll();

      expect(events).toHaveLength(0);
    });

    test("repo detection failure backs off, but never gives up permanently (#3243)", async () => {
      // A tracked item is what makes the poller ask for a repo at all: detection is per
      // domain and therefore lazy (#3192), so a daemon tracking nothing spawns no `git`.
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let attempts = 0;
      let now = 0;
      const { poller } = makePoller({
        detectRepo: async () => {
          attempts++;
          throw new Error("no git remote");
        },
        now: () => now,
      });

      // First attempt tries and fails, arming a backoff window.
      await poller.poll();
      expect(attempts).toBe(1);

      // Polls landing inside the backoff window are skipped — but pollCount still
      // advances (this is a temporary backoff, not a permanent dead poller).
      await poller.poll();
      await poller.poll();
      expect(attempts).toBe(1);
      expect(poller.pollCount).toBe(3);

      // Once the backoff window elapses, it retries again.
      now += repoDetectBackoffMs(1);
      await poller.poll();
      expect(attempts).toBe(2);
    });

    test("repo detection recovers once detectRepo starts succeeding again (#3243)", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let now = 0;
      let shouldFail = true;
      const { poller } = makePoller({
        detectRepo: async () => {
          if (shouldFail) throw new Error("no git remote");
          return TEST_REPO;
        },
        now: () => now,
      });

      await poller.poll();
      expect(poller.lastError).toBe("no git remote");
      expect(poller.repo).toBeNull();

      shouldFail = false;
      now += repoDetectBackoffMs(1);
      await poller.poll();

      expect(poller.repo).toEqual(TEST_REPO);
      expect(poller.lastError).toBeNull();
    });

    test("repo-scoped fetch error skips inline comments but reviews still work", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      seed.createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });

      const { poller, events } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("network error");
        },
        fetchReviews: async () =>
          okReviewResult([makeReview({ id: 5001, state: "APPROVED", user: { login: "reviewer" } })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(reviewEvents).toHaveLength(2);
      const inlineEvents = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED);
      expect(inlineEvents).toHaveLength(0);
    });
  });

  // ── Rate limit backoff ──

  describe("rate limit", () => {
    test("rateLimitLow sets backoff, successful poll clears it", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          callCount++;
          if (callCount === 1) {
            return { comments: [], rateLimitLow: true, rateLimitRemaining: 100 };
          }
          return okResult([]);
        },
      });

      await poller.poll();
      // After rate-limit-low poll, backoff should be active (no events to check, but no error)
      expect(poller.lastError).toBeNull();

      await poller.poll();
      // After successful poll, backoff should be cleared
      expect(poller.lastError).toBeNull();
    });

    test("repo-scoped rateLimitLow logs warning with remaining count", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const warnMessages: string[] = [];
      const logger = {
        info() {},
        warn(msg: string) {
          warnMessages.push(msg);
        },
        error() {},
        debug() {},
      };
      const poller = new CopilotPoller({
        workItemDb,
        stateDb: stateDb as unknown as CopilotPollerOptions["stateDb"] extends infer T ? T : never,
        logger,
        detectRepo: async () => TEST_REPO,
        getToken: async () => "test-token",
        fetchRepoComments: async () => ({ comments: [], rateLimitLow: true, rateLimitRemaining: 42 }),
        fetchReviews: async () => okReviewResult([]),
        fetchIssueComments: async () => okIssueCommentResult([]),
      });

      await poller.poll();

      expect(warnMessages.some((m) => m.includes("rate limit low") && m.includes("42"))).toBe(true);
    });

    test("primary rate-limit error (remaining==0) does not set lastError", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("GitHub API rate limit exhausted (403)");
        },
      });

      await poller.poll();

      expect(poller.lastError).toBeNull();
    });

    test("secondary rate-limit error (retry-after) does not set lastError", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("GitHub API secondary rate limit (403): retry after 60s");
        },
      });

      await poller.poll();

      expect(poller.lastError).toBeNull();
    });

    test("auth/scope 403 does NOT trigger backoff and sets lastError", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("GitHub API auth/scope error (403): Forbidden");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("auth/scope");
    });

    test("auth/scope error on reviews sets lastError without backoff", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller } = makePoller({
        fetchReviews: async () => {
          throw new Error("GitHub API auth/scope error (403): Resource not accessible by personal access token");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("auth/scope");
    });

    test("401 auth failure sets lastError without backoff", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("GitHub API auth failed (401) — token cache cleared");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("auth failed");
    });

    test("auth/scope error clears after next successful poll", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          callCount++;
          if (callCount === 1) throw new Error("GitHub API auth/scope error (403): Forbidden");
          return okResult([]);
        },
      });

      await poller.poll();
      expect(poller.lastError).toContain("auth/scope");

      await poller.poll();
      expect(poller.lastError).toBeNull();
    });
  });

  // ── Coalesced event integration (mocked) ──

  describe("coalesced burst", () => {
    test("two comments in quick succession produce one event per author", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });

      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, path: "src/a.ts", line: 1 }),
            makeComment({ id: 1002, path: "src/b.ts", line: 2 }),
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].newCount).toBe(2);
      expect(events[0].commentIds).toEqual([1001, 1002]);
    });
  });

  // ── Active-only filtering (#4) ──

  describe("active-only filtering", () => {
    test("skips work items with phase=done", async () => {
      seed.createWorkItem({ id: "wi:done", prNumber: 10, prState: "open", phase: "done" });
      seed.createWorkItem({ id: "wi:active", prNumber: 11, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 1000, prNumber: 10 }), makeComment({ id: 1100, prNumber: 11 })]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].prNumber).toBe(11);
    });

    test("skips work items with prState=merged", async () => {
      seed.createWorkItem({ id: "wi:merged", prNumber: 20, prState: "merged" });
      seed.createWorkItem({ id: "wi:open", prNumber: 21, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 2000, prNumber: 20 }), makeComment({ id: 2100, prNumber: 21 })]),
      });

      await poller.poll();

      const inlineEvents = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED);
      expect(inlineEvents).toHaveLength(1);
      expect(inlineEvents[0].prNumber).toBe(21);
    });

    test("skips work items with prState=closed", async () => {
      seed.createWorkItem({ id: "wi:closed", prNumber: 30, prState: "closed" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult([makeComment({ id: 3000, prNumber: 30 })]),
      });

      await poller.poll();

      const inlineEvents = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED);
      expect(inlineEvents).toHaveLength(0);
    });
  });

  // ── in_reply_to_id filtering (#5) ──

  describe("in_reply_to_id filtering", () => {
    test("threaded replies are excluded from events", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, path: "src/a.ts", line: 1 }),
            makeComment({ id: 1002, path: "src/a.ts", line: 1, in_reply_to_id: 1001, user: { login: "human" } }),
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].commentIds).toEqual([1001]);
      expect(events[0].author).toBe("github-copilot[bot]");
    });

    test("all-reply comments yield no events", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001 }),
            makeComment({ id: 1002, in_reply_to_id: 1001, user: { login: "human" } }),
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(0);
    });
  });

  // ── Edge cases (review #12) ──

  describe("edge cases", () => {
    test("user: null in comment uses 'unknown' as author", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () => okResult([makeComment({ id: 1001, user: null })]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe("unknown");
    });

    test("repo-scoped fetch error is transient: lastError stays null", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });

      const { poller, events } = makePoller({
        fetchRepoComments: async () => {
          throw new Error("network timeout");
        },
      });

      await poller.poll();

      const inlineEvents = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED);
      expect(inlineEvents).toHaveLength(0);
      expect(poller.lastError).toBeNull();
    });

    test("fetchReviews error surfaces in lastError", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });

      const { poller } = makePoller({
        fetchReviews: async () => {
          throw new Error("reviews fetch failed");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("reviews fetch failed");
      expect(poller.lastError).toMatch(/^1\/1 items failed:/);
    });

    test("fetchIssueComments error on PR item surfaces in lastError", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });

      const { poller } = makePoller({
        fetchIssueComments: async () => {
          throw new Error("PR comments fetch failed");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("PR comments fetch failed");
      expect(poller.lastError).toMatch(/^1\/1 items failed:/);
    });

    test("fetchIssueComments error on issue-only item surfaces in lastError", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });

      const { poller } = makePoller({
        fetchIssueComments: async () => {
          throw new Error("issue comments fetch failed");
        },
      });

      await poller.poll();

      expect(poller.lastError).toContain("issue comments fetch failed");
      expect(poller.lastError).toMatch(/^1\/1 items failed:/);
    });
  });

  // ── Repo-scoped batching (#1738) ──

  describe("per-domain repos (#3192)", () => {
    test("each domain's items are polled against that domain's repo", async () => {
      const wdb = new WorkItemDb(rawDb);
      wdb.forDomain(1).createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      wdb.forDomain(2).createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });

      const fetchedRepos: string[] = [];
      const { poller } = makePoller({
        repos: {
          repoFor: async (domainId: number) => ({ owner: "acme", repo: `r${domainId}` }),
          cached: () => null,
          lastErrorFor: () => null,
        },
        fetchRepoComments: async (repo) => {
          fetchedRepos.push(repo.repo);
          return okResult([]);
        },
      });

      await poller.poll();

      expect(fetchedRepos.sort()).toEqual(["r1", "r2"]);
    });

    test("the repo-comment cursor is per domain, so a skipped domain does not lose its window", async () => {
      // One shared cursor let a domain that was skipped this cycle (repo backoff) have its
      // window advanced by a domain that was not — silently dropping the comments between.
      const wdb = new WorkItemDb(rawDb);
      wdb.forDomain(1).createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      wdb.forDomain(2).createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });

      const { poller } = makePoller({
        repos: {
          // Domain 1's repo will not resolve; domain 2's does.
          repoFor: async (domainId: number) => (domainId === 2 ? TEST_REPO : null),
          cached: () => null,
          lastErrorFor: () => "no git remote",
        },
      });

      await poller.poll();

      expect(stateDb.getLastRepoPollTs(2)).not.toBeNull();
      expect(stateDb.getLastRepoPollTs(1)).toBeNull();
    });

    test("a domain with no cursor of its own resumes from the pre-#3192 global cursor", async () => {
      // Otherwise the first poll after upgrade paginates a repo's entire comment history.
      const wdb = new WorkItemDb(rawDb);
      wdb.forDomain(1).createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateLastRepoPollTs("2026-08-01T00:00:00.000Z", NO_DOMAIN_ID);

      const sinceSeen: Array<string | null> = [];
      const { poller } = makePoller({
        repos: {
          repoFor: async () => TEST_REPO,
          cached: () => null,
          lastErrorFor: () => null,
        },
        fetchRepoComments: async (_repo, since) => {
          sinceSeen.push(since);
          return okResult([]);
        },
      });

      await poller.poll();

      expect(sinceSeen).toEqual(["2026-08-01T00:00:00.000Z"]);
    });
  });

  describe("repo-scoped batching", () => {
    test("groups comments by pull_request_url to correct PRs", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      seed.createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, prNumber: 42, path: "src/a.ts", line: 1 }),
            makeComment({ id: 2001, prNumber: 43, path: "src/b.ts", line: 2 }),
            makeComment({ id: 2002, prNumber: 43, path: "src/c.ts", line: 3 }),
          ]),
      });

      await poller.poll();

      const pr42 = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED && e.prNumber === 42);
      const pr43 = events.filter((e) => e.event === PR_REVIEW_COMMENT_POSTED && e.prNumber === 43);
      expect(pr42).toHaveLength(1);
      expect(pr42[0].commentIds).toEqual([1001]);
      expect(pr43).toHaveLength(1);
      expect(pr43[0].commentIds).toEqual([2001, 2002]);
    });

    test("comments without pull_request_url are silently dropped", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([
            makeComment({ id: 1001, prNumber: 42 }),
            { ...makeComment({ id: 1002 }), pull_request_url: undefined },
          ]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].commentIds).toEqual([1001]);
    });

    test("comments for untracked PRs are ignored", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 1001, prNumber: 42 }), makeComment({ id: 9001, prNumber: 999 })]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].prNumber).toBe(42);
    });

    test("since parameter passes last repo poll timestamp", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const sinceValues: Array<string | null> = [];
      const { poller } = makePoller({
        fetchRepoComments: async (_repo, since) => {
          sinceValues.push(since);
          return okResult([]);
        },
      });

      await poller.poll();
      expect(sinceValues[0]).toBeNull();

      await poller.poll();
      expect(sinceValues[1]).not.toBeNull();
      expect(typeof sinceValues[1]).toBe("string");
    });

    test("no fetch when zero tracked PRs", async () => {
      let fetched = false;
      const { poller } = makePoller({
        fetchRepoComments: async () => {
          fetched = true;
          return okResult([]);
        },
      });

      await poller.poll();

      expect(fetched).toBe(false);
    });
  });

  // ── parsePrNumberFromUrl ──

  describe("parsePrNumberFromUrl", () => {
    test("extracts PR number from standard URL", () => {
      expect(parsePrNumberFromUrl("https://api.github.com/repos/owner/repo/pulls/123")).toBe(123);
    });

    test("returns null for malformed URL", () => {
      expect(parsePrNumberFromUrl("not-a-url")).toBeNull();
    });

    test("returns null for non-pulls URL", () => {
      expect(parsePrNumberFromUrl("https://api.github.com/repos/owner/repo/issues/42")).toBeNull();
    });
  });

  // ── PR reviews (#1579) ──

  describe("PR reviews", () => {
    test("new review emits review.approved for APPROVED state", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () =>
          okReviewResult([makeReview({ id: 5001, state: "APPROVED", user: { login: "reviewer1" } })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].reviewId).toBe(5001);
      expect(reviewEvents[0].reviewer).toBe("reviewer1");
      expect(reviewEvents[0].author).toBe("reviewer1");
      expect(reviewEvents[0].category).toBe("review");
    });

    test("new review emits review.changes_requested for CHANGES_REQUESTED state", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () =>
          okReviewResult([makeReview({ id: 5002, state: "CHANGES_REQUESTED", body: "Fix these issues" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_CHANGES_REQUESTED);
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].reviewId).toBe(5002);
      expect(reviewEvents[0].body).toBe("Fix these issues");
    });

    test("new review emits review.commented for COMMENTED state", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 5003, state: "COMMENTED" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_COMMENTED);
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].reviewId).toBe(5003);
    });

    test("PENDING reviews are skipped", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 5004, state: "PENDING" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter(
        (e) => e.event === REVIEW_APPROVED || e.event === REVIEW_CHANGES_REQUESTED || e.event === REVIEW_COMMENTED,
      );
      expect(reviewEvents).toHaveLength(0);
    });

    test("already-seen reviews are not re-emitted", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenReviewIds(42, [5001]);
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 5001, state: "APPROVED" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(reviewEvents).toHaveLength(0);
    });

    test("review state transitions: first APPROVED, then CHANGES_REQUESTED", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          callCount++;
          if (callCount === 1) {
            return okReviewResult([makeReview({ id: 5001, state: "APPROVED", user: { login: "reviewer" } })]);
          }
          return okReviewResult([
            makeReview({ id: 5001, state: "APPROVED", user: { login: "reviewer" } }),
            makeReview({ id: 5002, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }),
          ]);
        },
      });

      await poller.poll();
      expect(events.filter((e) => e.event === REVIEW_APPROVED)).toHaveLength(1);

      await poller.poll();
      const reqChanges = events.filter((e) => e.event === REVIEW_CHANGES_REQUESTED);
      expect(reqChanges).toHaveLength(1);
      expect(reqChanges[0].reviewId).toBe(5002);
    });
  });

  // ── Sticky-comment detection (#1579) ──

  describe("sticky-comment detection", () => {
    test("identical body on subsequent poll does not emit sticky_updated", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const review = makeReview({ id: 6001, body: "Summary: all good" });
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([review]),
      });

      await poller.poll();
      await poller.poll();

      const stickyEvents = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyEvents).toHaveLength(0);
    });

    test("changed body emits review.sticky_updated with new hash", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          callCount++;
          if (callCount === 1) {
            return okReviewResult([makeReview({ id: 6001, body: "Summary: 3 issues" })]);
          }
          // Same review ID, different body — simulates Copilot editing its pinned summary
          return okReviewResult([makeReview({ id: 6001, body: "Summary: 0 issues — all resolved" })]);
        },
      });

      // First poll: review 6001 is new → emitted as review.comment, stored in seenIds + sticky hash
      await poller.poll();
      const stickyAfterFirst = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyAfterFirst).toHaveLength(0);

      // Second poll: review 6001 already seen, body changed → sticky_updated
      await poller.poll();
      const stickyAfterSecond = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyAfterSecond).toHaveLength(1);
      expect(stickyAfterSecond[0].reviewId).toBe(6001);
      expect(stickyAfterSecond[0].author).toBe("github-copilot[bot]");
      expect(typeof stickyAfterSecond[0].bodyHash).toBe("string");
    });

    test("non-bot reviews do not trigger sticky detection", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          callCount++;
          if (callCount === 1) {
            return okReviewResult([makeReview({ id: 6002, user: { login: "human" }, body: "LGTM" })]);
          }
          return okReviewResult([makeReview({ id: 6002, user: { login: "human" }, body: "Actually, wait..." })]);
        },
      });

      await poller.poll();
      await poller.poll();

      const stickyEvents = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyEvents).toHaveLength(0);
    });

    test("review with empty body does not trigger sticky detection", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 6003, body: "" })]),
      });

      await poller.poll();
      await poller.poll();

      const stickyEvents = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyEvents).toHaveLength(0);
    });
  });

  // ── Top-level PR comments (#1579) ──

  describe("top-level PR comments", () => {
    test("new PR comment emits pr.comment", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchIssueComments: async () =>
          okIssueCommentResult([makeIssueComment({ id: 7001, user: { login: "reviewer" } })]),
      });

      await poller.poll();

      const commentEvents = events.filter((e) => e.event === PR_COMMENT && e.commentId !== undefined);
      expect(commentEvents).toHaveLength(1);
      expect(commentEvents[0].commentId).toBe(7001);
      expect(commentEvents[0].author).toBe("reviewer");
      expect(commentEvents[0].prNumber).toBe(42);
      expect(commentEvents[0].category).toBe("review");
    });

    test("already-seen PR comments are not re-emitted", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenPRCommentIds(42, [7001]);
      const { poller, events } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 7001 })]),
      });

      await poller.poll();

      const commentEvents = events.filter((e) => e.event === PR_COMMENT && e.commentId !== undefined);
      expect(commentEvents).toHaveLength(0);
    });

    test("PR comment IDs survive across polls", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchIssueComments: async () => {
          callCount++;
          if (callCount === 1) {
            return okIssueCommentResult([makeIssueComment({ id: 7001 })]);
          }
          return okIssueCommentResult([makeIssueComment({ id: 7001 }), makeIssueComment({ id: 7002 })]);
        },
      });

      await poller.poll();
      const firstComments = events.filter((e) => e.event === PR_COMMENT && e.commentId !== undefined);
      expect(firstComments).toHaveLength(1);
      expect(firstComments[0].commentId).toBe(7001);

      await poller.poll();
      const secondComments = events.filter(
        (e) => e.event === PR_COMMENT && e.commentId !== undefined && e.commentId === 7002,
      );
      expect(secondComments).toHaveLength(1);
    });
  });

  // ── Issue comments (#1579) ──

  describe("issue comments", () => {
    test("new issue comment emits issue.comment", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
      const { poller, events } = makePoller({
        fetchIssueComments: async () =>
          okIssueCommentResult([makeIssueComment({ id: 8001, user: { login: "contributor" } })]),
      });

      await poller.poll();

      const issueEvents = events.filter((e) => e.event === ISSUE_COMMENT);
      expect(issueEvents).toHaveLength(1);
      expect(issueEvents[0].commentId).toBe(8001);
      expect(issueEvents[0].author).toBe("contributor");
      expect(issueEvents[0].category).toBe("issue");
      expect(issueEvents[0].workItemId).toBe("#99");
    });

    test("issue-only items are polled (no prNumber)", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
      const fetched: number[] = [];
      const { poller } = makePoller({
        fetchIssueComments: async (_repo, num) => {
          fetched.push(num);
          return okIssueCommentResult([]);
        },
      });

      await poller.poll();

      expect(fetched).toContain(99);
    });

    test("already-seen issue comments are not re-emitted", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
      stateDb.updateSeenIssueCommentIds(99, [8001]);
      const { poller, events } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 8001 })]),
      });

      await poller.poll();

      expect(events).not.toContainEqual(expect.objectContaining({ event: ISSUE_COMMENT }));
    });

    test("issue comments are not polled for PR-based work items", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open", issueNumber: 99 });
      const fetchedIssueNums: number[] = [];
      const { poller } = makePoller({
        fetchIssueComments: async (_repo, num) => {
          fetchedIssueNums.push(num);
          return okIssueCommentResult([]);
        },
      });

      await poller.poll();

      // PR-based items use fetchIssueComments for PR top-level comments (prNumber=42),
      // NOT for issue comments. Issue-only polling only happens for items with no PR.
      expect(fetchedIssueNums).not.toContain(99);
      expect(fetchedIssueNums).toContain(42);
    });

    test("done-phase issue items are not polled", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null, phase: "done" });
      const fetched: number[] = [];
      const { poller } = makePoller({
        fetchIssueComments: async (_repo, num) => {
          fetched.push(num);
          return okIssueCommentResult([]);
        },
      });

      await poller.poll();

      expect(fetched).not.toContain(99);
    });
  });

  // ── State cleanup on terminal PRs (#1736) ──

  describe("copilot state cleanup", () => {
    test("merged PR state row is deleted on next poll", async () => {
      seed.createWorkItem({ id: "wi:1", prNumber: 42, prState: "merged" });
      stateDb.updateSeenCommentIds(42, [1001, 1002, 1003]);
      stateDb.updateSeenReviewIds(42, [5001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(42)).toEqual([]);
      expect(stateDb.getSeenReviewIds(42)).toEqual([]);
    });

    test("closed PR state row is deleted on next poll", async () => {
      seed.createWorkItem({ id: "wi:2", prNumber: 55, prState: "closed" });
      stateDb.updateSeenCommentIds(55, [2001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(55)).toEqual([]);
    });

    test("done-phase PR state row is deleted on next poll", async () => {
      seed.createWorkItem({ id: "wi:done-pr", prNumber: 88, prState: "open", phase: "done" });
      stateDb.updateSeenCommentIds(88, [4001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(88)).toEqual([]);
    });

    test("open PR state is preserved (dedup still works)", async () => {
      seed.createWorkItem({ id: "wi:3", prNumber: 77, prState: "open" });
      stateDb.updateSeenCommentIds(77, [3001]);

      const { poller } = makePoller({
        fetchRepoComments: async () =>
          okResult([makeComment({ id: 3001, prNumber: 77 }), makeComment({ id: 3002, prNumber: 77 })]),
      });
      await poller.poll();

      const stored = stateDb.getSeenCommentIds(77);
      expect(stored).toContain(3001);
      expect(stored).toContain(3002);
    });

    test("done-phase issue state is deleted on next poll", async () => {
      seed.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null, phase: "done" });
      stateDb.updateSeenIssueCommentIds(99, [8001, 8002]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenIssueCommentIds(99)).toEqual([]);
    });

    test("active issue state is preserved", async () => {
      seed.createWorkItem({ id: "#50", issueNumber: 50, prNumber: null, prState: null, phase: "impl" });
      stateDb.updateSeenIssueCommentIds(50, [9001]);

      const { poller } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 9001 })]),
      });
      await poller.poll();

      expect(stateDb.getSeenIssueCommentIds(50)).toContain(9001);
    });
  });
});

describe("repoDetectBackoffMs", () => {
  test("doubles from the base for each consecutive failure, capped at 15 minutes", () => {
    expect(repoDetectBackoffMs(1)).toBe(30_000);
    expect(repoDetectBackoffMs(2)).toBe(60_000);
    expect(repoDetectBackoffMs(3)).toBe(120_000);
    expect(repoDetectBackoffMs(10)).toBe(15 * 60_000);
  });
});
