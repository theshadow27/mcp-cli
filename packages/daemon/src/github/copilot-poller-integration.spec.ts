/**
 * Integration tests for CopilotPoller review and sticky-comment surfaces.
 *
 * These tests verify the full poll → fetch → dedup → emit pipeline for the
 * GitHub review surfaces added in #1579 / PR #1740.
 *
 * Copilot bot behavior (documented from API observation):
 *
 *   In-place edit (same review ID):
 *     Copilot updates an existing review via PATCH. The review retains its
 *     original ID but the body changes. This triggers `review.sticky_updated`
 *     on the second poll once the review is already in seenIds.
 *
 *   Dismiss-and-repost (new review ID):
 *     Copilot dismisses the old review and creates a new one. The old review
 *     ID disappears from the list and a fresh ID is created. The new review
 *     is treated as a fresh event (review.commented / review.approved), NOT
 *     as `review.sticky_updated`. The sticky hash is replaced by the new
 *     review's hash on the next poll.
 *
 * Implication: `review.sticky_updated` only fires for in-place edits. If
 * Copilot uses dismiss-and-repost, orchestrators receive a new review event
 * instead. Both are valid signals; orchestrators should handle both.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import {
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
  type FetchIssueCommentsResult,
  type FetchReviewsResult,
  type GitHubReview,
  type IssueComment,
} from "./copilot-poller";
import type { RepoInfo } from "./graphql-client";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "acme", repo: "widget" };

function makeReview(overrides: Partial<GitHubReview> & { id: number }): GitHubReview {
  return {
    user: { login: "github-copilot[bot]", type: "Bot" },
    state: "COMMENTED",
    body: "Summary: no issues found.",
    submitted_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeIssueComment(overrides: Partial<IssueComment> & { id: number }): IssueComment {
  return {
    user: { login: "theshadow27" },
    body: "Looks good to me.",
    ...overrides,
  };
}

function okReviews(reviews: GitHubReview[]): FetchReviewsResult {
  return { reviews, rateLimitLow: false, rateLimitRemaining: 5000 };
}

function okPRComments(comments: IssueComment[]): FetchIssueCommentsResult {
  return { comments, rateLimitLow: false, rateLimitRemaining: 5000 };
}

/** Minimal StateDb-compatible adapter backed by an in-memory SQLite database. */
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

describe("CopilotPoller — review/sticky integration", () => {
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
      fetchComments: async () => ({ comments: [], rateLimitLow: false, rateLimitRemaining: 5000 }),
      fetchReviews: async () => okReviews([]),
      fetchIssueComments: async () => okPRComments([]),
      onEvent: (e) => events.push(e),
      ...overrides,
    });
    return { poller, events };
  }

  // ── AC #1: create a GitHub review via API, observe correct event type ──

  describe("review event types", () => {
    test("APPROVED review emits review.approved with reviewer and prNumber", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-1", prNumber: 100, prState: "open" });

      const { poller, events } = makePoller({
        fetchReviews: async () =>
          okReviews([
            makeReview({
              id: 9001,
              state: "APPROVED",
              user: { login: "alice", type: "User" },
              body: "LGTM!",
            }),
          ]),
      });

      await poller.poll();

      const approved = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(approved).toHaveLength(1);
      expect(approved[0].reviewId).toBe(9001);
      expect(approved[0].reviewer).toBe("alice");
      expect(approved[0].prNumber).toBe(100);
      expect(approved[0].category).toBe("review");
      expect(approved[0].workItemId).toBe("wi:pr-1");
    });

    test("CHANGES_REQUESTED review emits review.changes_requested with body", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-2", prNumber: 101, prState: "open" });

      const { poller, events } = makePoller({
        fetchReviews: async () =>
          okReviews([
            makeReview({
              id: 9002,
              state: "CHANGES_REQUESTED",
              user: { login: "bob", type: "User" },
              body: "Please fix the null check on line 42.",
            }),
          ]),
      });

      await poller.poll();

      const changes = events.filter((e) => e.event === REVIEW_CHANGES_REQUESTED);
      expect(changes).toHaveLength(1);
      expect(changes[0].reviewId).toBe(9002);
      expect(changes[0].body).toBe("Please fix the null check on line 42.");
    });

    test("COMMENTED review emits review.commented", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-3", prNumber: 102, prState: "open" });

      const { poller, events } = makePoller({
        fetchReviews: async () =>
          okReviews([
            makeReview({ id: 9003, state: "COMMENTED", user: { login: "github-copilot[bot]", type: "Bot" } }),
          ]),
      });

      await poller.poll();

      const commented = events.filter((e) => e.event === REVIEW_COMMENTED);
      expect(commented).toHaveLength(1);
      expect(commented[0].reviewId).toBe(9003);
    });

    test("second poll does not re-emit already-seen reviews", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-4", prNumber: 103, prState: "open" });

      const { poller, events } = makePoller({
        fetchReviews: async () => okReviews([makeReview({ id: 9004, state: "APPROVED", user: { login: "alice" } })]),
      });

      await poller.poll();
      await poller.poll();

      const approved = events.filter((e) => e.event === REVIEW_APPROVED);
      expect(approved).toHaveLength(1); // emitted exactly once
    });
  });

  // ── AC #2: edit a bot review body in-place, observe review.sticky_updated ──

  describe("in-place edit (same review ID, body changes)", () => {
    test("changed body on second poll emits review.sticky_updated", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-5", prNumber: 200, prState: "open" });

      let pollCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          pollCount++;
          if (pollCount === 1) {
            // First fetch: bot posts initial summary
            return okReviews([makeReview({ id: 10001, body: "Summary: 3 issues remain." })]);
          }
          // Second fetch: Copilot edits review in-place via PATCH — same ID, updated body
          return okReviews([makeReview({ id: 10001, body: "Summary: 0 issues remain — all resolved." })]);
        },
      });

      // Poll 1: review 10001 is new → emits review.commented, stored in seenIds
      await poller.poll();
      expect(events.filter((e) => e.event === REVIEW_STICKY_UPDATED)).toHaveLength(0);
      expect(events.filter((e) => e.event === REVIEW_COMMENTED)).toHaveLength(1);

      // Poll 2: same review ID, body changed → emits review.sticky_updated
      await poller.poll();
      const stickyEvents = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyEvents).toHaveLength(1);
      expect(stickyEvents[0].reviewId).toBe(10001);
      expect(stickyEvents[0].prNumber).toBe(200);
      expect(typeof stickyEvents[0].bodyHash).toBe("string");
    });

    test("identical body on subsequent polls does not emit review.sticky_updated", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-6", prNumber: 201, prState: "open" });

      const { poller, events } = makePoller({
        fetchReviews: async () => okReviews([makeReview({ id: 10002, body: "No changes needed." })]),
      });

      await poller.poll();
      await poller.poll();
      await poller.poll();

      expect(events.filter((e) => e.event === REVIEW_STICKY_UPDATED)).toHaveLength(0);
    });
  });

  // ── AC #3: dismiss-and-repost does NOT trigger review.sticky_updated ──

  describe("dismiss-and-repost (new review ID, same author)", () => {
    /**
     * When Copilot dismisses its old review and posts a fresh one, the new
     * review arrives with a different ID. The poller treats it as a brand-new
     * review event — it is NOT in seenIds, so `review.sticky_updated` is
     * never emitted. The old review ID is evicted from the API response and
     * the sticky hash is overwritten with the new review's hash.
     */
    test("dismiss-and-repost emits new review event, not review.sticky_updated", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-7", prNumber: 300, prState: "open" });

      let pollCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          pollCount++;
          if (pollCount === 1) {
            // First fetch: original bot review
            return okReviews([makeReview({ id: 20001, body: "Summary: 2 issues remain." })]);
          }
          // Second fetch: Copilot dismissed review 20001 and posted review 20002.
          // Old review ID is gone from the API response.
          return okReviews([makeReview({ id: 20002, body: "Summary: 0 issues — resolved." })]);
        },
      });

      // Poll 1: review 20001 → emits review.commented
      await poller.poll();
      const firstCommented = events.filter((e) => e.event === REVIEW_COMMENTED);
      expect(firstCommented).toHaveLength(1);
      expect(firstCommented[0].reviewId).toBe(20001);

      // Poll 2: review 20002 is new (not in seenIds) → emits review.commented again,
      // does NOT emit review.sticky_updated
      await poller.poll();
      const stickyEvents = events.filter((e) => e.event === REVIEW_STICKY_UPDATED);
      expect(stickyEvents).toHaveLength(0);

      const secondCommented = events.filter((e) => e.event === REVIEW_COMMENTED && e.reviewId === 20002);
      expect(secondCommented).toHaveLength(1);
      expect(secondCommented[0].author).toBe("github-copilot[bot]");
    });

    test("subsequent identical poll after dismiss-and-repost does not re-emit", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-8", prNumber: 301, prState: "open" });

      let pollCount = 0;
      const { poller, events } = makePoller({
        fetchReviews: async () => {
          pollCount++;
          // Poll 1: original review
          if (pollCount === 1) return okReviews([makeReview({ id: 21001, body: "Old summary." })]);
          // Poll 2+: only new review present (old was dismissed)
          return okReviews([makeReview({ id: 21002, body: "Updated summary." })]);
        },
      });

      await poller.poll(); // emits review 21001
      await poller.poll(); // emits review 21002 (dismiss-and-repost)
      await poller.poll(); // third poll — 21002 already seen, nothing new

      const allCommented = events.filter((e) => e.event === REVIEW_COMMENTED);
      expect(allCommented).toHaveLength(2); // one for 21001, one for 21002
      expect(events.filter((e) => e.event === REVIEW_STICKY_UPDATED)).toHaveLength(0);
    });
  });

  // ── Top-level PR comment full pipeline ──

  describe("top-level PR comment pipeline", () => {
    test("new comment emits pr.comment, second poll does not re-emit", async () => {
      workItemDb.createWorkItem({ id: "wi:pr-9", prNumber: 400, prState: "open" });

      let pollCount = 0;
      const { poller, events } = makePoller({
        fetchIssueComments: async () => {
          pollCount++;
          const comments = [makeIssueComment({ id: 30001, user: { login: "reviewer-a" } })];
          if (pollCount >= 2) {
            comments.push(makeIssueComment({ id: 30002, user: { login: "reviewer-b" } }));
          }
          return okPRComments(comments);
        },
      });

      // Poll 1: comment 30001 is new
      await poller.poll();
      const firstBatch = events.filter((e) => e.event === PR_COMMENT);
      expect(firstBatch).toHaveLength(1);
      expect(firstBatch[0].commentId).toBe(30001);
      expect(firstBatch[0].author).toBe("reviewer-a");
      expect(firstBatch[0].prNumber).toBe(400);

      // Poll 2: comment 30001 already seen, 30002 is new
      await poller.poll();
      const secondBatch = events.filter((e) => e.event === PR_COMMENT);
      expect(secondBatch).toHaveLength(2);
      expect(secondBatch[1].commentId).toBe(30002);
      expect(secondBatch[1].author).toBe("reviewer-b");
    });
  });
});
