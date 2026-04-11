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
    expect(events[0]).toEqual({ type: "pr:merged", prNumber: 42 });
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
    expect(events).toContainEqual({ type: "pr:merged", prNumber: 1 });
    expect(events).toContainEqual({ type: "pr:closed", prNumber: 2 });
  });
});
