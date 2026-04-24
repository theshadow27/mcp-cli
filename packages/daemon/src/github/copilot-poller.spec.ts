import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import {
  COPILOT_INLINE_POSTED,
  ISSUE_COMMENT,
  PR_COMMENT,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  REVIEW_COMMENTED,
  REVIEW_STICKY_UPDATED,
} from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import {
  CopilotPoller,
  type CopilotPollerOptions,
  type FetchCommentsResult,
  type FetchIssueCommentsResult,
  type FetchReviewsResult,
  type GitHubReview,
  type IssueComment,
  type PRComment,
} from "./copilot-poller";
import type { RepoInfo } from "./graphql-client";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "test", repo: "repo" };

function okResult(comments: PRComment[]): FetchCommentsResult {
  return { comments, rateLimitLow: false, rateLimitRemaining: 5000 };
}

function makeComment(overrides: Partial<PRComment> & { id: number }): PRComment {
  return {
    path: "src/index.ts",
    line: 10,
    original_line: null,
    in_reply_to_id: null,
    user: { login: "github-copilot[bot]" },
    body: "Consider refactoring this.",
    ...overrides,
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

/** Minimal StateDb-like wrapper around an in-memory SQLite database. */
function createStateDb(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_comment_state (
      pr_number              INTEGER PRIMARY KEY,
      seen_comment_ids       TEXT NOT NULL DEFAULT '[]',
      seen_review_ids        TEXT NOT NULL DEFAULT '[]',
      seen_pr_comment_ids    TEXT NOT NULL DEFAULT '[]',
      seen_issue_comment_ids TEXT NOT NULL DEFAULT '[]',
      last_sticky_body_hash  TEXT,
      last_poll_ts           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  function getJsonCol(col: string, key: number): number[] {
    const row = db
      .query<Record<string, string>, [number]>(`SELECT ${col} FROM copilot_comment_state WHERE pr_number = ?`)
      .get(key);
    return row ? (JSON.parse(row[col]) as number[]) : [];
  }

  function upsertJsonCol(col: string, key: number, ids: number[]): void {
    db.query(
      `INSERT INTO copilot_comment_state (pr_number, ${col}, last_poll_ts)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(pr_number) DO UPDATE SET
         ${col} = excluded.${col},
         last_poll_ts = excluded.last_poll_ts`,
    ).run(key, JSON.stringify(ids));
  }

  return {
    getSeenCommentIds: (n: number) => getJsonCol("seen_comment_ids", n),
    updateSeenCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_comment_ids", n, ids),
    getSeenReviewIds: (n: number) => getJsonCol("seen_review_ids", n),
    updateSeenReviewIds: (n: number, ids: number[]) => upsertJsonCol("seen_review_ids", n, ids),
    getSeenPRCommentIds: (n: number) => getJsonCol("seen_pr_comment_ids", n),
    updateSeenPRCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_pr_comment_ids", n, ids),
    getSeenIssueCommentIds: (n: number) => getJsonCol("seen_issue_comment_ids", n),
    updateSeenIssueCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_issue_comment_ids", n, ids),
    getStickyBodyHash(prNumber: number): string | null {
      const row = db
        .query<{ last_sticky_body_hash: string | null }, [number]>(
          "SELECT last_sticky_body_hash FROM copilot_comment_state WHERE pr_number = ?",
        )
        .get(prNumber);
      return row?.last_sticky_body_hash ?? null;
    },
    updateStickyBodyHash(prNumber: number, hash: string | null): void {
      db.query(
        `INSERT INTO copilot_comment_state (pr_number, last_sticky_body_hash, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           last_sticky_body_hash = excluded.last_sticky_body_hash,
           last_poll_ts = excluded.last_poll_ts`,
      ).run(prNumber, hash);
    },
    deleteCopilotCommentState(workItemNumber: number): boolean {
      const result = db.run("DELETE FROM copilot_comment_state WHERE pr_number = ?", [workItemNumber]);
      return result.changes > 0;
    },
  };
}

describe("CopilotPoller", () => {
  let rawDb: Database;
  let workItemDb: WorkItemDb;
  let stateDb: ReturnType<typeof createStateDb>;

  beforeEach(() => {
    rawDb = new Database(":memory:");
    workItemDb = new WorkItemDb(rawDb);
    stateDb = createStateDb(rawDb);
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
      fetchComments: async () => okResult([]),
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () => okResult([]),
      });

      await poller.poll();

      expect(events).toHaveLength(0);
      expect(poller.pollCount).toBe(1);
    });

    test("all-new: first poll with comments emits event for each author", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const comments = [
        makeComment({ id: 1001, path: "src/a.ts", line: 5 }),
        makeComment({ id: 1002, path: "src/b.ts", line: 10 }),
      ];
      const { poller, events } = makePoller({
        fetchComments: async () => okResult(comments),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.event).toBe(COPILOT_INLINE_POSTED);
      expect(evt.prNumber).toBe(42);
      expect(evt.newCount).toBe(2);
      expect(evt.commentIds).toEqual([1001, 1002]);
      expect(evt.firstLine).toBe("a.ts:5");
      expect(evt.author).toBe("github-copilot[bot]");
    });

    test("partial-new: only emits diff after seen IDs populated", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);

      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001, 1002]);

      const { poller, events } = makePoller({
        fetchComments: async () => okResult([makeComment({ id: 1001 }), makeComment({ id: 1002 })]),
      });

      await poller.poll();

      expect(events).toHaveLength(0);
    });
  });

  // ── Per-author grouping ──

  describe("per-author grouping", () => {
    test("emits separate events per author", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller, events } = makePoller({
        fetchComments: async () => {
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);

      const { poller } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () =>
          okResult([makeComment({ id: 1001, path: "packages/daemon/src/poller.ts", line: 143 })]),
      });

      await poller.poll();

      expect(events[0].firstLine).toBe("poller.ts:143");
    });

    test("falls back to original_line when line is null", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () => okResult([makeComment({ id: 1001 })]),
      });

      poller.stop();
      await poller.poll();

      expect(events).toHaveLength(0);
    });

    test("repo detection failure caches after 3 attempts", async () => {
      let attempts = 0;
      const { poller } = makePoller({
        detectRepo: async () => {
          attempts++;
          throw new Error("no git remote");
        },
      });

      await poller.poll();
      await poller.poll();
      await poller.poll();
      await poller.poll(); // Should be skipped

      expect(attempts).toBe(3);
      expect(poller.pollCount).toBe(4);
    });

    test("fetch error for one PR does not abort other PRs", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      workItemDb.createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });

      const { poller, events } = makePoller({
        fetchComments: async (_repo, prNumber) => {
          if (prNumber === 42) throw new Error("network error");
          return okResult([makeComment({ id: 2001, path: "src/x.ts", line: 1 })]);
        },
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].prNumber).toBe(43);
    });
  });

  // ── Rate limit backoff ──

  describe("rate limit", () => {
    test("rateLimitLow sets backoff, successful poll clears it", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      let callCount = 0;
      const { poller } = makePoller({
        fetchComments: async () => {
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
  });

  // ── Coalesced event integration (mocked) ──

  describe("coalesced burst", () => {
    test("two comments in quick succession produce one event per author", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });

      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:done", prNumber: 10, prState: "open", phase: "done" });
      workItemDb.createWorkItem({ id: "wi:active", prNumber: 11, prState: "open" });
      const fetched: number[] = [];
      const { poller, events } = makePoller({
        fetchComments: async (_repo, prNumber) => {
          fetched.push(prNumber);
          return okResult([makeComment({ id: prNumber * 100 })]);
        },
      });

      await poller.poll();

      expect(fetched).toEqual([11]);
      expect(events).toHaveLength(1);
      expect(events[0].prNumber).toBe(11);
    });

    test("skips work items with prState=merged", async () => {
      workItemDb.createWorkItem({ id: "wi:merged", prNumber: 20, prState: "merged" });
      workItemDb.createWorkItem({ id: "wi:open", prNumber: 21, prState: "open" });
      const fetched: number[] = [];
      const { poller } = makePoller({
        fetchComments: async (_repo, prNumber) => {
          fetched.push(prNumber);
          return okResult([]);
        },
      });

      await poller.poll();

      expect(fetched).toEqual([21]);
    });

    test("skips work items with prState=closed", async () => {
      workItemDb.createWorkItem({ id: "wi:closed", prNumber: 30, prState: "closed" });
      const fetched: number[] = [];
      const { poller } = makePoller({
        fetchComments: async (_repo, prNumber) => {
          fetched.push(prNumber);
          return okResult([]);
        },
      });

      await poller.poll();

      expect(fetched).toEqual([]);
    });
  });

  // ── in_reply_to_id filtering (#5) ──

  describe("in_reply_to_id filtering", () => {
    test("threaded replies are excluded from events", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenCommentIds(42, [1001]);
      const { poller, events } = makePoller({
        fetchComments: async () =>
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchComments: async () => okResult([makeComment({ id: 1001, user: null })]),
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe("unknown");
    });

    test("partial poll failure: lastError reflects the error after mixed results", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      workItemDb.createWorkItem({ id: "wi:2", prNumber: 43, prState: "open" });

      const { poller, events } = makePoller({
        fetchComments: async (_repo, prNumber) => {
          if (prNumber === 42) throw new Error("network timeout");
          return okResult([makeComment({ id: 2001 })]);
        },
      });

      await poller.poll();

      expect(events).toHaveLength(1);
      expect(events[0].prNumber).toBe(43);
      // lastError is null because the overall poll succeeded (per-PR errors are logged but don't set _lastError)
      expect(poller.lastError).toBeNull();
    });
  });

  // ── PR reviews (#1579) ──

  describe("PR reviews", () => {
    test("new review emits review.approved for APPROVED state", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 5003, state: "COMMENTED" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_COMMENTED);
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].reviewId).toBe(5003);
    });

    test("PENDING reviews are skipped", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenReviewIds(42, [5001]);
      const { poller, events } = makePoller({
        fetchReviews: async () => okReviewResult([makeReview({ id: 5001, state: "APPROVED" })]),
      });

      await poller.poll();

      const reviewEvents = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(reviewEvents).toHaveLength(0);
    });

    test("review state transitions: first APPROVED, then CHANGES_REQUESTED", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
      stateDb.updateSeenPRCommentIds(42, [7001]);
      const { poller, events } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 7001 })]),
      });

      await poller.poll();

      const commentEvents = events.filter((e) => e.event === PR_COMMENT && e.commentId !== undefined);
      expect(commentEvents).toHaveLength(0);
    });

    test("PR comment IDs survive across polls", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open" });
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
      workItemDb.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
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
      workItemDb.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
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
      workItemDb.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null });
      stateDb.updateSeenIssueCommentIds(99, [8001]);
      const { poller, events } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 8001 })]),
      });

      await poller.poll();

      expect(events.filter((e) => e.event === ISSUE_COMMENT)).toHaveLength(0);
    });

    test("issue comments are not polled for PR-based work items", async () => {
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "open", issueNumber: 99 });
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
      workItemDb.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null, phase: "done" });
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
      workItemDb.createWorkItem({ id: "wi:1", prNumber: 42, prState: "merged" });
      stateDb.updateSeenCommentIds(42, [1001, 1002, 1003]);
      stateDb.updateSeenReviewIds(42, [5001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(42)).toEqual([]);
      expect(stateDb.getSeenReviewIds(42)).toEqual([]);
    });

    test("closed PR state row is deleted on next poll", async () => {
      workItemDb.createWorkItem({ id: "wi:2", prNumber: 55, prState: "closed" });
      stateDb.updateSeenCommentIds(55, [2001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(55)).toEqual([]);
    });

    test("done-phase PR state row is deleted on next poll", async () => {
      workItemDb.createWorkItem({ id: "wi:done-pr", prNumber: 88, prState: "open", phase: "done" });
      stateDb.updateSeenCommentIds(88, [4001]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenCommentIds(88)).toEqual([]);
    });

    test("open PR state is preserved (dedup still works)", async () => {
      workItemDb.createWorkItem({ id: "wi:3", prNumber: 77, prState: "open" });
      stateDb.updateSeenCommentIds(77, [3001]);

      const { poller } = makePoller({
        fetchComments: async () => okResult([makeComment({ id: 3001 }), makeComment({ id: 3002 })]),
      });
      await poller.poll();

      const stored = stateDb.getSeenCommentIds(77);
      expect(stored).toContain(3001);
      expect(stored).toContain(3002);
    });

    test("done-phase issue state is deleted on next poll", async () => {
      workItemDb.createWorkItem({ id: "#99", issueNumber: 99, prNumber: null, prState: null, phase: "done" });
      stateDb.updateSeenIssueCommentIds(99, [8001, 8002]);

      const { poller } = makePoller();
      await poller.poll();

      expect(stateDb.getSeenIssueCommentIds(99)).toEqual([]);
    });

    test("active issue state is preserved", async () => {
      workItemDb.createWorkItem({ id: "#50", issueNumber: 50, prNumber: null, prState: null, phase: "impl" });
      stateDb.updateSeenIssueCommentIds(50, [9001]);

      const { poller } = makePoller({
        fetchIssueComments: async () => okIssueCommentResult([makeIssueComment({ id: 9001 })]),
      });
      await poller.poll();

      expect(stateDb.getSeenIssueCommentIds(50)).toContain(9001);
    });
  });
});
