import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import type { WorkItemEvent } from "@mcp-cli/core";
import { type CrossDomainWorkItems, type DomainWorkItems, WorkItemDb } from "../db/work-items";
import type { CiEvent } from "./ci-events";
import type { CiCheck, PRStatus, RepoInfo } from "./graphql-client";
import { WorkItemPoller, repoDetectBackoffMs } from "./work-item-poller";

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_REPO: RepoInfo = { owner: "test", repo: "repo" };
const SETTLE_MS = 50;

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
  /** Ring-0 handle handed to the poller — the thing under test. */
  let db: CrossDomainWorkItems;
  /** Scoped handle used only to ARRANGE rows; the poller must find them without being told. */
  let seed: DomainWorkItems;

  beforeEach(() => {
    sqlDb = new Database(":memory:");
    const wdb = new WorkItemDb(sqlDb);
    db = wdb.acrossDomains();
    seed = wdb.forDomain(NO_DOMAIN_ID);
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
    seed.createWorkItem({ id: "#100", issueNumber: 100 });

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
    seed.createWorkItem({ id: "pr:42", prNumber: 42, prState: "open", mergeStateStatus: "UNKNOWN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 42, state: "MERGED" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = seed.getWorkItem("pr:42");
    expect(item?.prState).toBe("merged");
    expect(events).toContainEqual(expect.objectContaining({ type: "pr:merged", prNumber: 42 }));
  });

  test("updates CI status and emits checks:passed", async () => {
    seed.createWorkItem({ id: "pr:10", prNumber: 10, ciStatus: "running" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 10, ciState: "SUCCESS" })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = seed.getWorkItem("pr:10");
    expect(item?.ciStatus).toBe("passed");
    expect(events).toContainEqual({ type: "checks:passed", prNumber: 10 });
  });

  test("updates review status and emits review:approved", async () => {
    seed.createWorkItem({ id: "pr:5", prNumber: 5, reviewStatus: "pending" });

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

    const item = seed.getWorkItem("pr:5");
    expect(item?.reviewStatus).toBe("approved");
    expect(events).toContainEqual({ type: "review:approved", prNumber: 5 });
  });

  test("emits checks:failed with failedJob", async () => {
    seed.createWorkItem({ id: "pr:7", prNumber: 7, ciStatus: "running" });

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
    seed.createWorkItem({ id: "pr:8", prNumber: 8, reviewStatus: "none" });

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
    seed.createWorkItem({
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
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

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
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

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

  describe("per-domain repos (#3192)", () => {
    /** A resolver that maps each domain to a distinct repo, recording what was asked for. */
    function reposFor(map: Record<number, RepoInfo>) {
      const asked: number[] = [];
      return {
        asked,
        repos: {
          repoFor: async (domainId: number) => {
            asked.push(domainId);
            return map[domainId] ?? null;
          },
          cached: (domainId: number) => map[domainId] ?? null,
          lastErrorFor: () => null,
        },
      };
    }

    test("each domain's PR numbers are fetched against that domain's repo", async () => {
      // The defect: one repo for the whole daemon meant project A's PR #7 was looked up in
      // project B's repo, and whatever PR #7 is over there got reconciled onto A's row.
      const wdb = new WorkItemDb(sqlDb);
      wdb.forDomain(1).createWorkItem({ id: "pr:7", prNumber: 7 });
      wdb.forDomain(2).createWorkItem({ id: "pr:7", prNumber: 7 });

      const alpha: RepoInfo = { owner: "acme", repo: "alpha" };
      const beta: RepoInfo = { owner: "acme", repo: "beta" };
      const { repos, asked } = reposFor({ 1: alpha, 2: beta });
      const fetches: Array<{ repo: RepoInfo; prNumbers: readonly number[] }> = [];

      const poller = new WorkItemPoller({
        db,
        logger: SILENT_LOGGER,
        repos,
        fetchPRs: async (repo, prNumbers) => {
          fetches.push({ repo, prNumbers: [...prNumbers] });
          return [];
        },
      });

      await poller.poll();

      expect(asked.sort()).toEqual([1, 2]);
      expect(fetches).toHaveLength(2);
      expect(fetches.map((f) => f.repo)).toEqual([alpha, beta]);
      expect(fetches.every((f) => f.prNumbers.length === 1 && f.prNumbers[0] === 7)).toBe(true);
    });

    test("a domain whose repo will not resolve is skipped, not fatal to the others", async () => {
      const wdb = new WorkItemDb(sqlDb);
      wdb.forDomain(1).createWorkItem({ id: "pr:1", prNumber: 1 });
      wdb.forDomain(2).createWorkItem({ id: "pr:2", prNumber: 2 });

      const beta: RepoInfo = { owner: "acme", repo: "beta" };
      const fetched: number[] = [];
      const poller = new WorkItemPoller({
        db,
        logger: SILENT_LOGGER,
        repos: {
          repoFor: async (domainId: number) => (domainId === 2 ? beta : null),
          cached: () => null,
          lastErrorFor: () => "no git remote",
        },
        fetchPRs: async (_repo, prNumbers) => {
          fetched.push(...prNumbers);
          return [];
        },
      });

      await poller.poll();

      expect(fetched).toEqual([2]);
      // The unresolved domain is reported, not swallowed — but the poll still counted.
      expect(poller.lastError).toBe("no git remote");
      expect(poller.pollCount).toBe(1);
    });

    test("two unresolvable domains are each named, not collapsed to one reason (#3397 review)", async () => {
      // A single scalar reported whichever domain the loop touched last, so "no git remote"
      // named no project and the other failure vanished.
      const wdb = new WorkItemDb(sqlDb);
      wdb.forDomain(1).createWorkItem({ id: "pr:1", prNumber: 1 });
      wdb.forDomain(2).createWorkItem({ id: "pr:2", prNumber: 2 });

      const poller = new WorkItemPoller({
        db,
        logger: SILENT_LOGGER,
        repos: {
          repoFor: async () => null,
          cached: () => null,
          lastErrorFor: (domainId: number) => (domainId === 1 ? "no git remote" : "not a github repo"),
        },
        fetchPRs: async () => [],
      });

      await poller.poll();

      expect(poller.lastError).toBe("domain 1: no git remote; domain 2: not a github repo");
    });

    test("`repo` is null once a cycle spans several domains (#3397 review)", async () => {
      // "The repo" is not a question a multi-project daemon has an answer to; naming
      // whichever domain the loop visited last is a diagnostic that lies.
      const wdb = new WorkItemDb(sqlDb);
      wdb.forDomain(1).createWorkItem({ id: "pr:1", prNumber: 1 });
      wdb.forDomain(2).createWorkItem({ id: "pr:2", prNumber: 2 });

      const { repos } = reposFor({ 1: { owner: "acme", repo: "alpha" }, 2: { owner: "acme", repo: "beta" } });
      const poller = new WorkItemPoller({ db, logger: SILENT_LOGGER, repos, fetchPRs: async () => [] });

      await poller.poll();

      expect(poller.repo).toBeNull();
    });

    test("cascade head is computed per repo, not across every domain's PRs", async () => {
      // A BEHIND, auto-merge-armed PR in another repo is not this repo's cascade head.
      const wdb = new WorkItemDb(sqlDb);
      wdb.forDomain(1).createWorkItem({ id: "pr:1", prNumber: 1, mergeStateStatus: "CLEAN" });
      wdb.forDomain(2).createWorkItem({ id: "pr:2", prNumber: 2, mergeStateStatus: "CLEAN" });

      const events: WorkItemEvent[] = [];
      const poller = new WorkItemPoller({
        db,
        logger: SILENT_LOGGER,
        repos: {
          repoFor: async (domainId: number) => ({ owner: "acme", repo: `r${domainId}` }),
          cached: () => null,
          lastErrorFor: () => null,
        },
        fetchPRs: async (repo) =>
          repo.repo === "r1"
            ? [makePRStatus({ number: 1, mergeStateStatus: "BEHIND", autoMergeEnabled: true })]
            : [makePRStatus({ number: 2, mergeStateStatus: "BEHIND", autoMergeEnabled: true })],
        onEvent: (e) => events.push(e),
      });

      await poller.poll();

      const cascades = events.filter((e) => e.type === "pr:merge_state_changed");
      expect(cascades).toHaveLength(2);
      // Each PR is the head of its own repo's cascade — never the other repo's number.
      expect(cascades.map((e) => (e as { prNumber: number; cascadeHead: number | null }).cascadeHead)).toEqual([1, 2]);
    });
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
    seed.createWorkItem({ id: "pr:15", prNumber: 15, prState: "open" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 15, state: "OPEN", isDraft: true })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const item = seed.getWorkItem("pr:15");
    expect(item?.prState).toBe("draft");
    // No pr:opened event for draft transition
    expect(events.some((e) => e.type === "pr:opened")).toBe(false);
  });

  test("handles multiple PRs in single poll", async () => {
    seed.createWorkItem({ id: "pr:1", prNumber: 1, prState: "open" });
    seed.createWorkItem({ id: "pr:2", prNumber: 2, prState: "open" });

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

    expect(seed.getWorkItem("pr:1")?.prState).toBe("merged");
    expect(seed.getWorkItem("pr:2")?.prState).toBe("closed");
    expect(events).toContainEqual({ type: "pr:merged", prNumber: 1, mergeSha: null });
    expect(events).toContainEqual({ type: "pr:closed", prNumber: 2 });
  });

  test("concurrency guard prevents overlapping polls", async () => {
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await Bun.sleep(SETTLE_MS);
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
    seed.createWorkItem({ id: "pr:1", prNumber: 1, prState: "open" });

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
    const item = seed.getWorkItem("pr:1");
    expect(item?.prState).toBe("open");
  });

  test("detectRepo failure backs off within the retry window, without giving up (#3243)", async () => {
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

    let detectCalls = 0;
    const now = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => {
        detectCalls++;
        throw new Error("not a github repo");
      },
      now: () => now,
    });

    // First attempt tries detectRepo and fails, arming a backoff window.
    await poller.poll();
    expect(detectCalls).toBe(1);
    expect(poller.lastError).toBe("not a github repo");

    // A poll that lands inside the backoff window is skipped entirely — but this is
    // a temporary backoff, not the old "3 tries then dead forever": it must still
    // count as a completed poll cycle (pollCount advances) so callers can observe
    // liveness even while repo detection is quiescent.
    await poller.poll();
    await poller.poll();
    expect(detectCalls).toBe(1);
    expect(poller.pollCount).toBe(3);
  });

  test("detectRepo retries again once the backoff window elapses (#3243)", async () => {
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

    let detectCalls = 0;
    let now = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => {
        detectCalls++;
        throw new Error("not a github repo");
      },
      now: () => now,
    });

    await poller.poll();
    expect(detectCalls).toBe(1);

    // Still within the first backoff window (base 30s) — skipped.
    now += 10_000;
    await poller.poll();
    expect(detectCalls).toBe(1);

    // Past the first backoff window — retries (and fails again, arming a longer one).
    now += 25_000; // now = 35s > 30s base
    await poller.poll();
    expect(detectCalls).toBe(2);

    // Still within the 2nd backoff window (delay doubled to 60s from the 2nd failure).
    now += 10_000;
    await poller.poll();
    expect(detectCalls).toBe(2);

    // Past the doubled window — retries again. Never permanently gives up.
    now += 55_000;
    await poller.poll();
    expect(detectCalls).toBe(3);
  });

  test("detectRepo backoff resets on recovery — a later success is not treated as a fluke", async () => {
    seed.createWorkItem({ id: "pr:1", prNumber: 1 });

    let now = 0;
    let shouldFail = true;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [],
      detectRepo: async () => {
        if (shouldFail) throw new Error("no git remote");
        return TEST_REPO;
      },
      now: () => now,
    });

    await poller.poll();
    expect(poller.lastError).toBe("no git remote");
    expect(poller.repo).toBeNull();

    // Repo now exists (e.g. cwd fix, or the repo appeared) — advance past backoff.
    shouldFail = false;
    now += 30_000;
    await poller.poll();

    expect(poller.repo).toEqual(TEST_REPO);
    expect(poller.lastError).toBeNull();
  });

  test("review status ignores COMMENTED after APPROVED", async () => {
    seed.createWorkItem({ id: "pr:9", prNumber: 9, reviewStatus: "none" });

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
    const item = seed.getWorkItem("pr:9");
    expect(item?.reviewStatus).toBe("approved");
    expect(events).toContainEqual({ type: "review:approved", prNumber: 9 });
  });

  test("checks:started event has no runId", async () => {
    seed.createWorkItem({ id: "pr:11", prNumber: 11, ciStatus: "none" });

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
    seed.createWorkItem({ id: "pr:50", prNumber: 50, prState: "open" });

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
    await Bun.sleep(SETTLE_MS);
    expect(poller.pollCount).toBe(1);

    // Reset state so the next poll sees a change
    seed.updateWorkItem("pr:50", { prState: "open" });
    events.length = 0;

    poller.pollNow();
    // Wait for the triggered poll to complete
    await Bun.sleep(SETTLE_MS);

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
    seed.createWorkItem({ id: "pr:12", prNumber: 12, ciStatus: "none" });

    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 12, ciState: "EXPECTED" })],
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();

    const item = seed.getWorkItem("pr:12");
    expect(item?.ciStatus).toBe("pending");
  });

  // ── Merge state (#1581) ──

  test("emits pr:merge_state_changed on first poll (null → UNKNOWN transition)", async () => {
    seed.createWorkItem({ id: "pr:30", prNumber: 30, mergeStateStatus: null });

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
    expect(seed.getWorkItem("pr:30")?.mergeStateStatus).toBe("UNKNOWN");
  });

  test("emits pr:merge_state_changed on BEHIND→CLEAN transition", async () => {
    seed.createWorkItem({ id: "pr:31", prNumber: 31, mergeStateStatus: "BEHIND" });

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
    expect(evt?.type).toBe("pr:merge_state_changed");
    if (evt?.type === "pr:merge_state_changed") {
      expect(evt.prNumber).toBe(31);
      expect(evt.from).toBe("BEHIND");
      expect(evt.to).toBe("CLEAN");
      expect(evt.cascadeHead).toBe(31); // only armed PR, CLEAN
    }
    expect(seed.getWorkItem("pr:31")?.mergeStateStatus).toBe("CLEAN");
  });

  test("no pr:merge_state_changed when status unchanged", async () => {
    seed.createWorkItem({ id: "pr:32", prNumber: 32, mergeStateStatus: "CLEAN" });

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
    seed.createWorkItem({ id: "pr:33", prNumber: 33, mergeStateStatus: "BEHIND" });

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
    seed.createWorkItem({ id: "pr:40", prNumber: 40, mergeStateStatus: "UNKNOWN" });
    seed.createWorkItem({ id: "pr:41", prNumber: 41, mergeStateStatus: "UNKNOWN" });

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
      expect(evt.type).toBe("pr:merge_state_changed");
      if (evt.type === "pr:merge_state_changed") {
        expect(evt.cascadeHead).toBe(41);
      }
    }
  });

  test("cascadeHead is null on non-actionable DIRTY transition even when other PR is CLEAN/BEHIND", async () => {
    // PR 50 starts BEHIND, transitions to DIRTY (non-actionable)
    // PR 51 is CLEAN with auto-merge — would normally be the cascade head
    seed.createWorkItem({ id: "pr:50", prNumber: 50, mergeStateStatus: "BEHIND" });
    seed.createWorkItem({ id: "pr:51", prNumber: 51, mergeStateStatus: "UNKNOWN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({ number: 50, mergeStateStatus: "DIRTY", autoMergeEnabled: true }),
        makePRStatus({ number: 51, mergeStateStatus: "CLEAN", autoMergeEnabled: true }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const dirtyEvt = events.find((e) => e.type === "pr:merge_state_changed" && e.prNumber === 50);
    expect(dirtyEvt).toBeDefined();
    if (!dirtyEvt || dirtyEvt.type !== "pr:merge_state_changed")
      throw new Error("Expected pr:merge_state_changed event for PR 50");
    expect(dirtyEvt.cascadeHead).toBeNull();
  });

  test("cascadeHead is null on null→UNKNOWN transition", async () => {
    seed.createWorkItem({ id: "pr:52", prNumber: 52 });
    // Add a CLEAN armed PR to ensure cascadeHead would be non-null if not gated
    seed.createWorkItem({ id: "pr:53", prNumber: 53, mergeStateStatus: "BEHIND" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({ number: 52, mergeStateStatus: "UNKNOWN", autoMergeEnabled: false }),
        makePRStatus({ number: 53, mergeStateStatus: "BEHIND", autoMergeEnabled: true }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const unknownEvt = events.find((e) => e.type === "pr:merge_state_changed" && e.prNumber === 52);
    expect(unknownEvt).toBeDefined();
    if (!unknownEvt || unknownEvt.type !== "pr:merge_state_changed")
      throw new Error("Expected pr:merge_state_changed event for PR 52");
    expect(unknownEvt.cascadeHead).toBeNull();
  });

  test("cascadeHead is null on HAS_HOOKS transition", async () => {
    seed.createWorkItem({ id: "pr:54", prNumber: 54, mergeStateStatus: "BEHIND" });
    seed.createWorkItem({ id: "pr:55", prNumber: 55, mergeStateStatus: "UNKNOWN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({ number: 54, mergeStateStatus: "HAS_HOOKS", autoMergeEnabled: true }),
        makePRStatus({ number: 55, mergeStateStatus: "BEHIND", autoMergeEnabled: true }),
      ],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const hooksEvt = events.find((e) => e.type === "pr:merge_state_changed" && e.prNumber === 54);
    expect(hooksEvt).toBeDefined();
    if (!hooksEvt || hooksEvt.type !== "pr:merge_state_changed")
      throw new Error("Expected pr:merge_state_changed event for PR 54");
    expect(hooksEvt.cascadeHead).toBeNull();
  });

  test("cascadeHead is null on UNSTABLE transition", async () => {
    seed.createWorkItem({ id: "pr:56", prNumber: 56, mergeStateStatus: "CLEAN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 56, mergeStateStatus: "UNSTABLE", autoMergeEnabled: true })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const unstableEvt = events.find((e) => e.type === "pr:merge_state_changed");
    expect(unstableEvt).toBeDefined();
    if (!unstableEvt || unstableEvt.type !== "pr:merge_state_changed")
      throw new Error("Expected pr:merge_state_changed event for PR 56");
    expect(unstableEvt.cascadeHead).toBeNull();
  });

  test("cascadeHead is non-null when PR transitions to BEHIND with auto-merge", async () => {
    seed.createWorkItem({ id: "pr:57", prNumber: 57, mergeStateStatus: "UNKNOWN" });

    const events: WorkItemEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 57, mergeStateStatus: "BEHIND", autoMergeEnabled: true })],
      detectRepo: async () => TEST_REPO,
      onEvent: (e) => events.push(e),
    });

    await poller.poll();

    const behindEvt = events.find((e) => e.type === "pr:merge_state_changed");
    expect(behindEvt).toBeDefined();
    if (!behindEvt || behindEvt.type !== "pr:merge_state_changed")
      throw new Error("Expected pr:merge_state_changed event for PR 57");
    expect(behindEvt.cascadeHead).toBe(57);
  });

  // ── Phase 2 enrichment (#1576) ──

  test("pr:opened carries branch, base, commits, srcChurn", async () => {
    seed.createWorkItem({ id: "pr:60", prNumber: 60, prState: "draft" });

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
    expect(opened?.type).toBe("pr:opened");
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
    seed.createWorkItem({ id: "pr:61", prNumber: 61, prState: "open" });

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
    expect(merged?.type).toBe("pr:merged");
    if (merged?.type === "pr:merged") {
      expect(merged.mergeSha).toBe("deadbeef123");
    }
  });

  test("pr:pushed emits when headRefOid changes on open PR", async () => {
    seed.createWorkItem({ id: "pr:62", prNumber: 62, prState: "open" });

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
    expect(events).not.toContainEqual(expect.objectContaining({ type: "pr:pushed" }));

    // Second poll — OID changed (sha-v1 → sha-v2), even with same commit count
    await poller.poll();
    const pushed = events.find((e) => e.type === "pr:pushed");
    expect(pushed).toBeDefined();
    expect(pushed?.type).toBe("pr:pushed");
    if (pushed?.type === "pr:pushed") {
      expect(pushed.prNumber).toBe(62);
      expect(pushed.branch).toBe("feat/push-test");
      expect(pushed.commits).toBe(4);
      expect(pushed.srcChurn).toBe(35);
    }
  });

  test("pr:pushed detects force-push when commitCount decreases but OID changes", async () => {
    seed.createWorkItem({ id: "pr:64", prNumber: 64, prState: "open" });

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
    expect(events).not.toContainEqual(expect.objectContaining({ type: "pr:pushed" }));

    await poller.poll();
    expect(events.filter((e) => e.type === "pr:pushed")).toHaveLength(1);
  });

  test("pr:pushed not emitted when OID stays the same", async () => {
    seed.createWorkItem({ id: "pr:63", prNumber: 63, prState: "open" });

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
    expect(events).not.toContainEqual(expect.objectContaining({ type: "pr:pushed" }));
  });

  test("pr:pushed sets filesTruncated when files list was truncated", async () => {
    seed.createWorkItem({ id: "pr:65", prNumber: 65, prState: "open" });

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
    seed.createWorkItem({ id: "#10", prNumber: 10, ciStatus: "none" });

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
    seed.createWorkItem({ id: "#11", prNumber: 11, ciStatus: "none" });

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
    seed.createWorkItem({ id: "#12", prNumber: 12, ciStatus: "none" });

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
    seed.createWorkItem({ id: "#13", prNumber: 13, ciStatus: "none" });

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

  test("onCiEvent is not called when ciChecks is empty", async () => {
    seed.createWorkItem({ id: "#15", prNumber: 15, ciStatus: "none" });

    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [makePRStatus({ number: 15, ciState: null, ciChecks: [] })],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
    });

    await poller.poll();
    expect(ciEvents).toHaveLength(0);
  });

  test("CI state survives poller restart — no duplicate ci.started, correct observedDurationMs", async () => {
    seed.createWorkItem({ id: "#20", prNumber: 20, prState: "open", ciStatus: "running" });

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
    expect(ciEvents2).not.toContainEqual(expect.objectContaining({ type: "ci.started" }));

    // ci.finished should have observedDurationMs reflecting original startedAt
    const finished = ciEvents2.find((e) => e.type === "ci.finished") as Extract<CiEvent, { type: "ci.finished" }>;
    expect(finished).toBeDefined();
    expect(finished.observedDurationMs).toBe(120_000);
    expect(finished.allGreen).toBe(true);
    poller2.stop();
  });

  test("CI state cleaned up on PR merge", async () => {
    seed.createWorkItem({ id: "#14", prNumber: 14, prState: "open", ciStatus: "none" });

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

  test("stale ciRunStates are purged when tracked items drops to zero", async () => {
    const item = seed.createWorkItem({ id: "#30", prNumber: 30, prState: "open", ciStatus: "running" });

    let pollCount = 0;
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 30,
          ciState: "PENDING",
          ciChecks: [ciCheck("build", "IN_PROGRESS", null, 500)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onCiEvent: () => {},
      now: () => 1000,
    });

    await poller.poll();
    pollCount++;
    expect(seed.loadCiRunStates().size).toBe(1);

    // Remove the work item so tracked becomes empty
    seed.deleteWorkItem(item.id);

    await poller.poll();
    pollCount++;
    expect(seed.loadCiRunStates().size).toBe(0);
  });

  test("upsertCiRunState is not called when CI state is unchanged across polls", async () => {
    seed.createWorkItem({ id: "#31", prNumber: 31, prState: "open", ciStatus: "none" });

    // Spy on the seam production uses: the poller writes through `db.forRow(item)`, which
    // returns a FRESH scoped handle per row, so patching any single instance would count
    // zero and silently assert nothing.
    let upsertCount = 0;
    const origForRow = db.forRow.bind(db);
    db.forRow = (item) => {
      const scoped = origForRow(item);
      const origUpsert = scoped.upsertCiRunState.bind(scoped);
      scoped.upsertCiRunState = (pr, state) => {
        upsertCount++;
        return origUpsert(pr, state);
      };
      return scoped;
    };

    const ciEvents: CiEvent[] = [];
    const poller = new WorkItemPoller({
      db,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 31,
          ciState: "SUCCESS",
          ciChecks: [ciCheck("build", "COMPLETED", "SUCCESS", 600)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      onCiEvent: (e) => ciEvents.push(e),
      now: () => 2000,
    });

    await poller.poll();
    expect(upsertCount).toBe(1);

    // Second poll — same checks, same suiteId, state already emitted both flags
    await poller.poll();
    expect(upsertCount).toBe(1);
  });
});

/**
 * The regression this repair exists for (#3037 review round 2).
 *
 * The poller used to be handed `forDomain(resolveDomainScope(db, process.cwd()))`. Writers
 * scope per request from the caller's cwd, so an item tracked from a project directory landed
 * in that project's partition while the poller sat in whichever partition the daemon woke up
 * in. `listWorkItems()` returned `[]` — no PR state, no CI events, no automation, for every
 * tracked item, reported as an empty list rather than an error.
 *
 * These drive the real WorkItemPoller over a real database. Seeding uses a scoped handle,
 * exactly as a caller writes; nothing tells the poller where to look.
 */
describe("WorkItemPoller — ring 0 sees every domain (#3037)", () => {
  let sqlDb: Database;

  afterEach(() => {
    sqlDb?.close();
  });

  function check(name: string, status: string, conclusion: string | null, suiteId = 100): CiCheck {
    return { name, status, conclusion, checkSuiteId: suiteId };
  }

  function setup() {
    sqlDb = new Database(":memory:");
    const wdb = new WorkItemDb(sqlDb);
    return { ring0: wdb.acrossDomains(), alpha: wdb.forDomain(1), beta: wdb.forDomain(2) };
  }

  test("polls items written by callers in domains the daemon was never told about", async () => {
    const { ring0, alpha, beta } = setup();
    alpha.createWorkItem({ issueNumber: 1, prNumber: 11, prState: "open", ciStatus: "none" });
    beta.createWorkItem({ issueNumber: 2, prNumber: 22, prState: "open", ciStatus: "none" });

    const requested: number[] = [];
    const poller = new WorkItemPoller({
      db: ring0,
      logger: SILENT_LOGGER,
      fetchPRs: async (_repo, prNumbers) => {
        requested.push(...prNumbers);
        return [];
      },
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();

    // Pre-fix this was [] — the poller asked GitHub about nothing at all.
    expect(requested.sort()).toEqual([11, 22]);
  });

  test("writes land in the row's own domain, not a partition the daemon guessed", async () => {
    const { ring0, alpha, beta } = setup();
    alpha.createWorkItem({ issueNumber: 1, prNumber: 7, prState: "open", ciStatus: "none" });
    beta.createWorkItem({ issueNumber: 2, prNumber: 8, prState: "open", ciStatus: "none" });

    const poller = new WorkItemPoller({
      db: ring0,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({ number: 7, ciState: "SUCCESS" }),
        makePRStatus({ number: 8, ciState: "FAILURE" }),
      ],
      detectRepo: async () => TEST_REPO,
    });

    await poller.poll();

    expect(alpha.getWorkItemByPr(7)?.ciStatus).toBe("passed");
    expect(beta.getWorkItemByPr(8)?.ciStatus).toBe("failed");
    // Neither write leaked into the sentinel partition the daemon used to bind to.
    expect(ring0.listWorkItems().every((i) => i.domainId !== 0)).toBe(true);
  });

  test("two domains each holding PR #7 keep separate CI run state", async () => {
    const { ring0, alpha, beta } = setup();
    alpha.createWorkItem({ issueNumber: 1, prNumber: 7, prState: "open", ciStatus: "none" });
    beta.createWorkItem({ issueNumber: 2, prNumber: 7, prState: "open", ciStatus: "none" });

    const poller = new WorkItemPoller({
      db: ring0,
      logger: SILENT_LOGGER,
      fetchPRs: async () => [
        makePRStatus({
          number: 7,
          ciState: "SUCCESS",
          ciChecks: [check("build", "COMPLETED", "SUCCESS", 600)],
        }),
      ],
      detectRepo: async () => TEST_REPO,
      now: () => 2000,
    });

    await poller.poll();

    // One row per domain. Keyed by PR number alone, one would have overwritten the other.
    expect(alpha.loadCiRunStates().get(7)).toBeDefined();
    expect(beta.loadCiRunStates().get(7)).toBeDefined();
    expect(ring0.loadCiRunStates().size).toBe(2);
  });
});

describe("repoDetectBackoffMs", () => {
  test("doubles from the base for each consecutive failure", () => {
    expect(repoDetectBackoffMs(1)).toBe(30_000);
    expect(repoDetectBackoffMs(2)).toBe(60_000);
    expect(repoDetectBackoffMs(3)).toBe(120_000);
    expect(repoDetectBackoffMs(4)).toBe(240_000);
  });

  test("caps at 15 minutes — never grows unbounded and never signals permanent give-up", () => {
    expect(repoDetectBackoffMs(10)).toBe(15 * 60_000);
    expect(repoDetectBackoffMs(50)).toBe(15 * 60_000);
    expect(repoDetectBackoffMs(1000)).toBe(15 * 60_000);
  });
});
