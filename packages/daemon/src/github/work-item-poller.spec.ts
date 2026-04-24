import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkItemEvent } from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import type { PRStatus, RepoInfo } from "./graphql-client";
import { WorkItemPoller } from "./work-item-poller";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "test", repo: "repo" };

function makePRStatus(overrides: Partial<PRStatus> & { number: number }): PRStatus {
  return {
    state: "OPEN",
    isDraft: false,
    mergeable: "UNKNOWN",
    ciState: null,
    ciChecks: [],
    reviews: [],
    commitCount: 1,
    headRefName: "feat/test",
    baseRefName: "main",
    mergeCommitOid: null,
    files: [],
    ...overrides,
  };
}

describe("WorkItemPoller", () => {
  let sqlDb: Database;
  let db: WorkItemDb;

  beforeEach(() => {
    sqlDb = new Database(":memory:");
    db = new WorkItemDb(sqlDb);
  });

  afterEach(() => {
    sqlDb.close();
  });

  test("no-op poll when no tracked items", async () => {
    let fetchCalled = false;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        fetchCalled = true;
        return [];
      },
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();
    expect(fetchCalled).toBe(false);
    expect(poller.pollCount).toBe(1);
    expect(poller.lastError).toBeNull();
  });

  test("no-op when items exist but none have prNumber", async () => {
    db.createWorkItem({ id: "#100", issueNumber: 100 });

    let fetchCalled = false;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        fetchCalled = true;
        return [];
      },
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();
    expect(fetchCalled).toBe(false);
  });

  test("fetches and updates PR state", async () => {
    db.createWorkItem({ id: "pr:42", prNumber: 42, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 42, state: "MERGED" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = db.getWorkItem("pr:42");
    expect(item?.prState).toBe("merged");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "pr:merged", prNumber: 42, mergeSha: null });
  });

  test("updates CI status and emits checks:passed", async () => {
    db.createWorkItem({ id: "pr:10", prNumber: 10, ciStatus: "running" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 10, ciState: "SUCCESS" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = db.getWorkItem("pr:10");
    expect(item?.ciStatus).toBe("passed");
    expect(events).toContainEqual({ type: "checks:passed", prNumber: 10 });
  });

  test("updates review status and emits review:approved", async () => {
    db.createWorkItem({ id: "pr:5", prNumber: 5, reviewStatus: "pending" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 5,
          reviews: [{ state: "APPROVED", author: "alice" }],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = db.getWorkItem("pr:5");
    expect(item?.reviewStatus).toBe("approved");
    expect(events).toContainEqual({ type: "review:approved", prNumber: 5 });
  });

  test("emits checks:failed with failedJob", async () => {
    db.createWorkItem({ id: "pr:7", prNumber: 7, ciStatus: "running" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 7,
          ciState: "FAILURE",
          ciChecks: [
            { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(events).toContainEqual({ type: "checks:failed", prNumber: 7, failedJob: "test" });
  });

  test("emits review:changes_requested with reviewer", async () => {
    db.createWorkItem({ id: "pr:8", prNumber: 8, reviewStatus: "none" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 8,
          reviews: [{ state: "CHANGES_REQUESTED", author: "bob" }],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(events).toContainEqual({
      type: "review:changes_requested",
      prNumber: 8,
      reviewer: "bob",
    });
  });

  test("no events when state hasn't changed", async () => {
    db.createWorkItem({
      id: "pr:20",
      prNumber: 20,
      prState: "open",
      ciStatus: "passed",
      reviewStatus: "approved",
    });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 20,
          state: "OPEN",
          isDraft: false,
          ciState: "SUCCESS",
          reviews: [{ state: "APPROVED", author: "x" }],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();
    expect(events).toHaveLength(0);
  });

  test("handles fetch error gracefully", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1 });

    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        throw new Error("network failure");
      },
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();
    expect(poller.lastError).toBe("network failure");
    expect(poller.pollCount).toBe(1);
  });

  test("caches repo detection across polls", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1 });

    let detectCount = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => {
        detectCount++;
        return TEST_REPO;
      },
    });

    await poller.poll();
    await poller.poll();
    expect(detectCount).toBe(1);
    expect(poller.repo).toEqual(TEST_REPO);
  });

  test("start and stop lifecycle", () => {
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      intervalMs: 60_000,
      fetchPRs: async () => [],
      detectRepo: async () => TEST_REPO,
    });

    poller.start();
    // start is idempotent
    poller.start();
    poller.stop();
    // stop is idempotent
    poller.stop();
  });

  test("maps draft PRs correctly", async () => {
    db.createWorkItem({ id: "pr:15", prNumber: 15, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 15, state: "OPEN", isDraft: true })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = db.getWorkItem("pr:15");
    expect(item?.prState).toBe("draft");
    // No pr:opened event for draft transition
    expect(events.some((e) => e.type === "pr:opened")).toBe(false);
  });

  test("handles multiple PRs in single poll", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1, prState: "open" });
    db.createWorkItem({ id: "pr:2", prNumber: 2, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({ number: 1, state: "MERGED" }),
        makePRStatus({ number: 2, state: "CLOSED" }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(db.getWorkItem("pr:1")?.prState).toBe("merged");
    expect(db.getWorkItem("pr:2")?.prState).toBe("closed");
    expect(events).toContainEqual({ type: "pr:merged", prNumber: 1, mergeSha: null });
    expect(events).toContainEqual({ type: "pr:closed", prNumber: 2 });
  });

  test("concurrency guard prevents overlapping polls", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1 });

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await Bun.sleep(50);
        concurrentCalls--;
        return [makePRStatus({ number: 1 })];
      },
      detectRepo: async () => TEST_REPO,
    });

    // Fire two polls simultaneously — second should be skipped
    const [, secondResult] = await Promise.all([poller.poll(), poller.poll()]);
    expect(maxConcurrent).toBe(1);
    // Only one poll should have completed
    expect(poller.pollCount).toBe(1);
  });

  test("stopped flag prevents DB writes during shutdown", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1, prState: "open" });

    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        // Simulate stop being called during fetch
        poller.stop();
        return [makePRStatus({ number: 1, state: "MERGED" })];
      },
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();
    // PR state should NOT have been updated because stop() was called
    const item = db.getWorkItem("pr:1");
    expect(item?.prState).toBe("open");
  });

  test("detectRepo failure caches after 3 attempts", async () => {
    db.createWorkItem({ id: "pr:1", prNumber: 1 });

    let detectCalls = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => {
        detectCalls++;
        throw new Error("not a github repo");
      },
    });

    // First 3 attempts should try detectRepo
    await poller.poll();
    await poller.poll();
    await poller.poll();
    expect(detectCalls).toBe(3);
    expect(poller.lastError).toBe("not a github repo");

    // 4th attempt should skip detectRepo entirely
    await poller.poll();
    expect(detectCalls).toBe(3);
  });

  test("review status ignores COMMENTED after APPROVED", async () => {
    db.createWorkItem({ id: "pr:9", prNumber: 9, reviewStatus: "none" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 9,
          reviews: [
            { state: "APPROVED", author: "alice" },
            { state: "COMMENTED", author: "bob" },
          ],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    // Should be approved, not pending — COMMENTED doesn't override APPROVED
    const item = db.getWorkItem("pr:9");
    expect(item?.reviewStatus).toBe("approved");
    expect(events).toContainEqual({ type: "review:approved", prNumber: 9 });
  });

  test("checks:started event has no runId", async () => {
    db.createWorkItem({ id: "pr:11", prNumber: 11, ciStatus: "none" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 11, ciState: "PENDING" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(events).toContainEqual({ type: "checks:started", prNumber: 11 });
    // Verify no runId field
    const startedEvent = events.find((e) => e.type === "checks:started");
    expect(startedEvent).toBeDefined();
    if (startedEvent) {
      expect("runId" in startedEvent).toBe(false);
    }
  });

  test("pollNow triggers an immediate poll cycle", async () => {
    db.createWorkItem({ id: "pr:50", prNumber: 50, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      intervalMs: 60_000, // Long interval — pollNow should bypass it
      fetchPRs: async () => [makePRStatus({ number: 50, state: "MERGED" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    poller.start();
    // Wait for the initial poll from start() to complete
    await Bun.sleep(50);
    expect(poller.pollCount).toBe(1);

    // Reset state so the next poll sees a change
    db.updateWorkItem("pr:50", { prState: "open" });
    events.length = 0;

    poller.pollNow();
    // Wait for the triggered poll to complete
    await Bun.sleep(50);

    expect(poller.pollCount).toBe(2);
    expect(events).toContainEqual({ type: "pr:merged", prNumber: 50, mergeSha: null });
    poller.stop();
  });

  test("pollNow is a no-op when stopped", () => {
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => TEST_REPO,
    });

    poller.stop();
    // Should not throw
    poller.pollNow();
    expect(poller.pollCount).toBe(0);
  });

  test("EXPECTED status maps to pending, not running", async () => {
    db.createWorkItem({ id: "pr:12", prNumber: 12, ciStatus: "none" });

    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 12, ciState: "EXPECTED" })],
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();

    const item = db.getWorkItem("pr:12");
    expect(item?.ciStatus).toBe("pending");
  });

  // ── Phase 2 enrichment (#1576) ──

  test("pr:opened carries branch, base, commits, srcChurn", async () => {
    db.createWorkItem({ id: "pr:60", prNumber: 60, prState: "draft" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 60,
          state: "OPEN",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          commitCount: 3,
          files: [
            { path: "src/index.ts", additions: 50, deletions: 10 },
            { path: "src/foo.spec.ts", additions: 20, deletions: 5 },
          ],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const opened = events.find((e) => e.type === "pr:opened");
    expect(opened).toBeDefined();
    if (opened?.type === "pr:opened") {
      expect(opened.prNumber).toBe(60);
      expect(opened.branch).toBe("feat/my-feature");
      expect(opened.base).toBe("main");
      expect(opened.commits).toBe(3);
      // 50+10=60 src churn; 20+5=25 test churn excluded
      expect(opened.srcChurn).toBe(60);
    }
  });

  test("pr:merged carries mergeSha", async () => {
    db.createWorkItem({ id: "pr:61", prNumber: 61, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 61, state: "MERGED", mergeCommitOid: "deadbeef123" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const merged = events.find((e) => e.type === "pr:merged");
    expect(merged).toBeDefined();
    if (merged?.type === "pr:merged") {
      expect(merged.mergeSha).toBe("deadbeef123");
    }
  });

  test("pr:pushed emits when commitCount increases on open PR", async () => {
    db.createWorkItem({ id: "pr:62", prNumber: 62, prState: "open" });

    const events: WorkItemEvent[] = [];
    let pollCount = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollCount++;
        return [
          makePRStatus({
            number: 62,
            state: "OPEN",
            headRefName: "feat/push-test",
            baseRefName: "main",
            commitCount: pollCount === 1 ? 2 : 4,
            files: [{ path: "src/app.ts", additions: 30, deletions: 5 }],
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    // First poll — establish baseline commit count, no push event
    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(0);

    // Second poll — commit count increased from 2 → 4
    await poller.poll();
    const pushed = events.find((e) => e.type === "pr:pushed");
    expect(pushed).toBeDefined();
    if (pushed?.type === "pr:pushed") {
      expect(pushed.prNumber).toBe(62);
      expect(pushed.branch).toBe("feat/push-test");
      expect(pushed.commits).toBe(4);
      expect(pushed.srcChurn).toBe(35);
    }
  });

  test("pr:pushed not emitted when commit count stays the same", async () => {
    db.createWorkItem({ id: "pr:63", prNumber: 63, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 63, state: "OPEN", commitCount: 3 })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();
    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(0);
  });
});

// ── computeSrcChurn unit tests (#1576) ──

import { computeSrcChurn } from "./work-item-poller";

describe("computeSrcChurn", () => {
  test("counts only non-test files", () => {
    const files = [
      { path: "src/index.ts", additions: 100, deletions: 20 },
      { path: "src/index.spec.ts", additions: 50, deletions: 10 },
      { path: "src/__tests__/util.ts", additions: 30, deletions: 5 },
      { path: "tests/e2e.ts", additions: 20, deletions: 3 },
      { path: "test/fixtures/data.json", additions: 5, deletions: 1 },
      { path: "src/util.test.ts", additions: 15, deletions: 2 },
    ];

    // Only src/index.ts (100+20=120) should count
    expect(computeSrcChurn(files)).toBe(120);
  });

  test("returns 0 for all-test diff", () => {
    expect(computeSrcChurn([{ path: "foo.spec.ts", additions: 99, deletions: 1 }])).toBe(0);
  });

  test("returns 0 for empty diff", () => {
    expect(computeSrcChurn([])).toBe(0);
  });

  test("counts all lines for all-source diff", () => {
    const files = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 20, deletions: 3 },
    ];
    expect(computeSrcChurn(files)).toBe(38);
  });
});
