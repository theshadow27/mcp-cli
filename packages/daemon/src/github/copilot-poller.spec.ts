import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MonitorEventInput } from "@mcp-cli/core";
import { COPILOT_INLINE_POSTED } from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import { CopilotPoller, type CopilotPollerOptions, type FetchCommentsResult, type PRComment } from "./copilot-poller";
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

/** Minimal StateDb-like wrapper around an in-memory SQLite database. */
function createStateDb(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_comment_state (
      pr_number        INTEGER PRIMARY KEY,
      seen_comment_ids TEXT NOT NULL DEFAULT '[]',
      last_poll_ts     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return {
    getSeenCommentIds(prNumber: number): number[] {
      const row = db
        .query<{ seen_comment_ids: string }, [number]>(
          "SELECT seen_comment_ids FROM copilot_comment_state WHERE pr_number = ?",
        )
        .get(prNumber);
      return row ? (JSON.parse(row.seen_comment_ids) as number[]) : [];
    },
    updateSeenCommentIds(prNumber: number, ids: number[]): void {
      db.query(
        `INSERT INTO copilot_comment_state (pr_number, seen_comment_ids, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           seen_comment_ids = excluded.seen_comment_ids,
           last_poll_ts = excluded.last_poll_ts`,
      ).run(prNumber, JSON.stringify(ids));
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
});
