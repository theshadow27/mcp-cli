import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkItemEvent } from "@mcp-cli/core";
import { WorkItemDb } from "../db/work-items";
import type { CiEvent } from "./ci-events";
import type { CiCheck, PRStatus, RepoInfo } from "./graphql-client";
import { WorkItemPoller } from "./work-item-poller";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "test", repo: "repo" };

function makePRStatus(overrides: Partial<PRStatus> & { number: number }): PRStatus {
  return {
    state: "OPEN",
    isDraft: false,
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    autoMergeEnabled: false,
    updatedAt: "2024-01-01T00:00:00Z",
    ciState: null,
    ciChecks: [],
    reviews: [],
    commitCount: 1,
    headRefName: "feat/test",
    baseRefName: "main",
    headRefOid: "sha-default",
    mergeCommitOid: null,
    files: [],
    filesTruncated: false,
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
    db.createWorkItem({ id: "pr:42", prNumber: 42, prState: "open", mergeStateStatus: "UNKNOWN" });

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
    expect(events).toContainEqual(expect.objectContaining({ type: "pr:merged", prNumber: 42 }));
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
            { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", checkSuiteId: 100 },
            { name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuiteId: 100 },
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
      mergeStateStatus: "UNKNOWN",
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
          mergeStateStatus: "UNKNOWN",
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

  // ── Merge state (#1581) ──

  test("emits pr:merge_state_changed on first poll (null → UNKNOWN transition)", async () => {
    db.createWorkItem({ id: "pr:30", prNumber: 30, mergeStateStatus: null });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 30, mergeStateStatus: "UNKNOWN" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(events).toContainEqual(
      expect.objectContaining({ type: "pr:merge_state_changed", prNumber: 30, from: null, to: "UNKNOWN" }),
    );
    expect(db.getWorkItem("pr:30")?.mergeStateStatus).toBe("UNKNOWN");
  });

  test("emits pr:merge_state_changed on BEHIND→CLEAN transition", async () => {
    db.createWorkItem({ id: "pr:31", prNumber: 31, mergeStateStatus: "BEHIND" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 31,
          mergeStateStatus: "CLEAN",
          autoMergeEnabled: true,
          updatedAt: "2024-01-01T00:00:00Z",
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const evt = events.find((e) => e.type === "pr:merge_state_changed");
    expect(evt).toBeDefined();
    if (evt?.type === "pr:merge_state_changed") {
      expect(evt.prNumber).toBe(31);
      expect(evt.from).toBe("BEHIND");
      expect(evt.to).toBe("CLEAN");
      expect(evt.cascadeHead).toBe(31); // only armed PR, CLEAN
    }
    expect(db.getWorkItem("pr:31")?.mergeStateStatus).toBe("CLEAN");
  });

  test("no pr:merge_state_changed when status unchanged", async () => {
    db.createWorkItem({ id: "pr:32", prNumber: 32, mergeStateStatus: "CLEAN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 32,
          mergeStateStatus: "CLEAN",
          autoMergeEnabled: true,
          updatedAt: "2024-01-01T00:00:00Z",
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    expect(events.some((e) => e.type === "pr:merge_state_changed")).toBe(false);
  });

  test("cascadeHead is null when no PR has auto-merge enabled", async () => {
    db.createWorkItem({ id: "pr:33", prNumber: 33, mergeStateStatus: "BEHIND" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 33, mergeStateStatus: "CLEAN", autoMergeEnabled: false })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const evt = events.find((e) => e.type === "pr:merge_state_changed");
    expect(evt?.type === "pr:merge_state_changed" && evt.cascadeHead).toBeNull();
  });

  test("cascadeHead selects earliest CLEAN auto-merge PR across multi-PR poll", async () => {
    db.createWorkItem({ id: "pr:40", prNumber: 40, mergeStateStatus: "UNKNOWN" });
    db.createWorkItem({ id: "pr:41", prNumber: 41, mergeStateStatus: "UNKNOWN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 40,
          mergeStateStatus: "CLEAN",
          autoMergeEnabled: true,
          updatedAt: "2024-01-02T00:00:00Z",
        }),
        makePRStatus({
          number: 41,
          mergeStateStatus: "CLEAN",
          autoMergeEnabled: true,
          updatedAt: "2024-01-01T00:00:00Z",
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    // Both PRs emit a merge_state_changed event; cascadeHead should be 41 (earlier updatedAt)
    const mergeEvents = events.filter((e) => e.type === "pr:merge_state_changed");
    expect(mergeEvents).toHaveLength(2);
    for (const evt of mergeEvents) {
      if (evt.type === "pr:merge_state_changed") {
        expect(evt.cascadeHead).toBe(41);
      }
    }
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

  test("pr:pushed emits when headRefOid changes on open PR", async () => {
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
            headRefOid: pollCount === 1 ? "sha-v1" : "sha-v2",
            commitCount: 4,
            files: [{ path: "src/app.ts", additions: 30, deletions: 5 }],
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    // First poll — establishes OID baseline, no push event
    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(0);

    // Second poll — OID changed (sha-v1 → sha-v2), even with same commit count
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

  test("pr:pushed detects force-push when commitCount decreases but OID changes", async () => {
    db.createWorkItem({ id: "pr:64", prNumber: 64, prState: "open" });

    const events: WorkItemEvent[] = [];
    let pollCount = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollCount++;
        return [
          makePRStatus({
            number: 64,
            state: "OPEN",
            headRefOid: pollCount === 1 ? "sha-before-squash" : "sha-after-squash",
            commitCount: pollCount === 1 ? 5 : 1,
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(0);

    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(1);
  });

  test("pr:pushed not emitted when OID stays the same", async () => {
    db.createWorkItem({ id: "pr:63", prNumber: 63, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 63, state: "OPEN", headRefOid: "sha-stable", commitCount: 3 })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();
    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(0);
  });

  test("pr:pushed sets filesTruncated when files list was truncated", async () => {
    db.createWorkItem({ id: "pr:65", prNumber: 65, prState: "open" });

    const events: WorkItemEvent[] = [];
    let pollCount = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollCount++;
        return [
          makePRStatus({
            number: 65,
            state: "OPEN",
            headRefOid: pollCount === 1 ? "sha-a" : "sha-b",
            filesTruncated: true,
            files: Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 1, deletions: 0 })),
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();
    await poller.poll();
    const pushed = events.find((e) => e.type === "pr:pushed");
    expect(pushed?.type === "pr:pushed" && pushed.filesTruncated).toBe(true);
  });

  // ── CI run event integration tests ──

  function ciCheck(name: string, status: string, conclusion: string | null, suiteId = 100): CiCheck {
    return { name, status, conclusion, checkSuiteId: suiteId };
  }

  test("onCiEvent receives ci.started + ci.running on first poll with in-progress checks", async () => {
    db.createWorkItem({ id: "#10", prNumber: 10, ciStatus: "none" });

    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 10,
          ciState: "PENDING",
          ciChecks: [ciCheck("check", "IN_PROGRESS", null), ciCheck("build", "QUEUED", null)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();

    expect(ciEvents).toHaveLength(2);
    expect(ciEvents[0].type).toBe("ci.started");
    expect(ciEvents[1].type).toBe("ci.running");
  });

  test("onCiEvent receives ci.finished when all checks become COMPLETED", async () => {
    db.createWorkItem({ id: "#11", prNumber: 11, ciStatus: "none" });

    let pollNum = 0;
    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollNum++;
        if (pollNum === 1) {
          return [
            makePRStatus({
              number: 11,
              ciState: "PENDING",
              ciChecks: [ciCheck("check", "IN_PROGRESS", null)],
            }),
          ];
        }
        return [
          makePRStatus({
            number: 11,
            ciState: "SUCCESS",
            ciChecks: [ciCheck("check", "COMPLETED", "SUCCESS")],
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();
    await poller.poll();

    const types = ciEvents.map((e) => e.type);
    expect(types).toContain("ci.started");
    expect(types).toContain("ci.finished");
    const finished = ciEvents.find((e) => e.type === "ci.finished");
    expect((finished as Extract<CiEvent, { type: "ci.finished" }>).allGreen).toBe(true);
  });

  test("re-polling finished checks does NOT re-emit ci.started", async () => {
    db.createWorkItem({ id: "#12", prNumber: 12, ciStatus: "none" });

    const completedChecks = [ciCheck("check", "COMPLETED", "SUCCESS")];
    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 12, ciState: "SUCCESS", ciChecks: completedChecks })],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();
    expect(ciEvents.filter((e) => e.type === "ci.started")).toHaveLength(1);
    expect(ciEvents.filter((e) => e.type === "ci.finished")).toHaveLength(1);

    ciEvents.length = 0;

    // Second poll — same completed checks, should NOT re-emit
    await poller.poll();
    expect(ciEvents).toHaveLength(0);

    // Third poll — still stable
    await poller.poll();
    expect(ciEvents).toHaveLength(0);
  });

  test("new suiteId triggers a new ci.started (re-run detection)", async () => {
    db.createWorkItem({ id: "#13", prNumber: 13, ciStatus: "none" });

    let pollNum = 0;
    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollNum++;
        if (pollNum === 1) {
          return [
            makePRStatus({
              number: 13,
              ciState: "SUCCESS",
              ciChecks: [ciCheck("check", "COMPLETED", "SUCCESS", 100)],
            }),
          ];
        }
        return [
          makePRStatus({
            number: 13,
            ciState: "PENDING",
            ciChecks: [ciCheck("check", "IN_PROGRESS", null, 200)],
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();
    const firstStarted = ciEvents.filter((e) => e.type === "ci.started");
    expect(firstStarted).toHaveLength(1);

    ciEvents.length = 0;

    await poller.poll();
    const secondStarted = ciEvents.filter((e) => e.type === "ci.started");
    expect(secondStarted).toHaveLength(1);
  });

  test("CI state survives poller restart — no duplicate ci.started, correct observedDurationMs", async () => {
    db.createWorkItem({ id: "#20", prNumber: 20, prState: "open", ciStatus: "running" });

    const T0 = 1_000_000;
    const ciEvents1: CiEvent[] = [];

    // First poller instance: sees ci.started
    const poller1 = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 20,
          ciState: "PENDING",
          ciChecks: [ciCheck("check", "IN_PROGRESS", null, 500)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents1.push(e),
      now: () => T0,
    });

    await poller1.poll();
    expect(ciEvents1.filter((e) => e.type === "ci.started")).toHaveLength(1);
    poller1.stop();

    // Simulate daemon restart: new poller instance, same DB
    const ciEvents2: CiEvent[] = [];
    const poller2 = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 20,
          ciState: "SUCCESS",
          ciChecks: [ciCheck("check", "COMPLETED", "SUCCESS", 500)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents2.push(e),
      now: () => T0 + 120_000,
    });

    await poller2.poll();

    // No duplicate ci.started — state was loaded from DB
    expect(ciEvents2.filter((e) => e.type === "ci.started")).toHaveLength(0);

    // ci.finished should have observedDurationMs reflecting original startedAt
    const finished = ciEvents2.find((e) => e.type === "ci.finished") as Extract<CiEvent, { type: "ci.finished" }>;
    expect(finished).toBeDefined();
    expect(finished.observedDurationMs).toBe(120_000);
    expect(finished.allGreen).toBe(true);
    poller2.stop();
  });

  test("CI state cleaned up on PR merge", async () => {
    db.createWorkItem({ id: "#14", prNumber: 14, prState: "open", ciStatus: "none" });

    let pollNum = 0;
    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        pollNum++;
        if (pollNum === 1) {
          return [
            makePRStatus({
              number: 14,
              state: "OPEN",
              ciState: "SUCCESS",
              ciChecks: [ciCheck("check", "COMPLETED", "SUCCESS")],
            }),
          ];
        }
        return [
          makePRStatus({
            number: 14,
            state: "MERGED",
            ciState: "SUCCESS",
            ciChecks: [ciCheck("check", "COMPLETED", "SUCCESS")],
          }),
        ];
      },
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();
    expect(ciEvents.filter((e) => e.type === "ci.finished")).toHaveLength(1);

    ciEvents.length = 0;

    // PR merged — CI state should be cleaned up, but no duplicate events
    await poller.poll();
    expect(ciEvents).toHaveLength(0);
  });
});
