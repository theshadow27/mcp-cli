import { describe, expect, test } from "bun:test";
import { VFS_COMPLETED, VFS_FAILED, VFS_PROGRESS, VFS_STARTED } from "@mcp-cli/core";
import type { RemoteProvider, ResolvedScope } from "../providers/provider";
import {
  ProgressReporter,
  type ProgressReporterOptions,
  type VfsProgressEvent,
  estimateTotal,
  formatProgressLine,
  percentOf,
  shouldReport,
} from "./progress";

const SCOPE: ResolvedScope = { key: "FOO", cloudId: "cloud-1", resolved: {} };

/** Fixed so assertions can compare whole events; production uses a fresh span id. */
const RUN_ID = "0123456789abcdef";
const REPO_ROOT = "/tmp/atlassian/foo";

function makeReporter(overrides: Partial<ProgressReporterOptions> = {}): {
  reporter: ProgressReporter;
  lines: string[];
  events: VfsProgressEvent[];
} {
  const lines: string[] = [];
  const events: VfsProgressEvent[] = [];
  const reporter = new ProgressReporter({
    operation: "clone",
    provider: "confluence",
    scope: "FOO",
    repoRoot: REPO_ROOT,
    unit: "pages",
    runId: RUN_ID,
    log: (m) => {
      lines.push(m);
    },
    onEvent: (e) => {
      events.push(e);
    },
    ...overrides,
  });
  return { reporter, lines, events };
}

function makeProvider(overrides: Partial<RemoteProvider> = {}): RemoteProvider {
  return {
    name: "test",
    resolveScope: async (s) => ({ ...s, cloudId: "cloud-1", resolved: {} }),
    list: async function* () {},
    fetch: async (_s, id) => ({
      content: "",
      entry: { id, title: id, version: 1, lastModified: "2026-01-01T00:00:00Z", metadata: {} },
    }),
    toPath: (e) => `${e.id}.md`,
    frontmatter: () => ({}),
    ...overrides,
  };
}

/** Drive a reporter over a whole phase and collect what it emitted. */
async function runPhase(
  count: number,
  total: number | undefined,
): Promise<{ lines: string[]; events: VfsProgressEvent[] }> {
  const { reporter, lines, events } = makeReporter();
  for (let i = 1; i <= count; i++) await reporter.tick("list", i, total);
  return { lines, events };
}

describe("shouldReport", () => {
  test("never reports a counter that did not advance", () => {
    expect(shouldReport(10, 100, 10)).toBe(false);
    expect(shouldReport(9, 100, 10)).toBe(false);
  });

  test("with a known total, reports every 5% by default", () => {
    // 5% of 5000 = 250 — the cadence the issue asks for.
    expect(shouldReport(249, 5000, 0)).toBe(false);
    expect(shouldReport(250, 5000, 0)).toBe(true);
    expect(shouldReport(499, 5000, 250)).toBe(false);
    expect(shouldReport(500, 5000, 250)).toBe(true);
  });

  test("the percent step never drops below 10 items", () => {
    // 5% of 40 is 2, but reporting every 2nd page of a 40-page clone is noise:
    // before #1249 it printed nothing at all. The floor keeps small scopes quiet.
    expect(shouldReport(2, 40, 0)).toBe(false);
    expect(shouldReport(9, 40, 0)).toBe(false);
    expect(shouldReport(10, 40, 0)).toBe(true);
    // A scope smaller than the floor reports only when it finishes.
    expect(shouldReport(1, 3, 0)).toBe(false);
    expect(shouldReport(3, 3, 0)).toBe(true);
  });

  test("the tick that reaches the total always reports", () => {
    expect(shouldReport(5000, 5000, 4750)).toBe(true);
    expect(shouldReport(5000, 5000, 4999)).toBe(true);
  });

  test("overshooting a low estimate falls back to the step, not every item", () => {
    expect(shouldReport(5001, 5000, 5000)).toBe(false);
    expect(shouldReport(5250, 5000, 5000)).toBe(true);
  });

  test("without a total, reports every 50 items by default", () => {
    expect(shouldReport(49, undefined, 0)).toBe(false);
    expect(shouldReport(50, undefined, 0)).toBe(true);
    expect(shouldReport(100, undefined, 50)).toBe(true);
  });

  test("a zero total is treated as unknown", () => {
    expect(shouldReport(10, 0, 0)).toBe(false);
    expect(shouldReport(50, 0, 0)).toBe(true);
  });

  test("honors custom steps", () => {
    expect(shouldReport(20, 100, 0, { percentStep: 20 })).toBe(true);
    expect(shouldReport(19, 100, 0, { percentStep: 20 })).toBe(false);
    expect(shouldReport(5, undefined, 0, { countStep: 5 })).toBe(true);
    expect(shouldReport(2, 40, 0, { minStep: 1 })).toBe(true);
  });
});

describe("percentOf", () => {
  test("floors to an integer percent", () => {
    expect(percentOf(250, 5000)).toBe(5);
    expect(percentOf(1, 3)).toBe(33);
  });

  test("clamps at 100 when an estimate came in low", () => {
    expect(percentOf(6000, 5000)).toBe(100);
  });

  test("is undefined without a usable total", () => {
    expect(percentOf(10, undefined)).toBeUndefined();
    expect(percentOf(10, 0)).toBeUndefined();
  });
});

describe("formatProgressLine", () => {
  const base = {
    event: VFS_PROGRESS,
    runId: RUN_ID,
    operation: "clone",
    provider: "confluence",
    scope: "FOO",
    repoRoot: REPO_ROOT,
  } as const;

  test("renders the count, total and percent", () => {
    const line = formatProgressLine({ ...base, phase: "list", current: 250, total: 5000, percent: 5, unit: "pages" });
    expect(line).toBe("  Fetching FOO... 250/5000 pages (5%)");
  });

  test("degrades to a bare counter when the total is unknown", () => {
    const line = formatProgressLine({ ...base, operation: "pull", phase: "list", current: 50, unit: "pages" });
    expect(line).toBe("  Fetching FOO... 50 pages");
  });

  test("uses the provider's noun, so jira does not report pages", () => {
    const line = formatProgressLine({ ...base, provider: "jira", phase: "list", current: 50, unit: "issues" });
    expect(line).toBe("  Fetching FOO... 50 issues");
  });

  test("falls back to a neutral noun when the provider names none", () => {
    expect(formatProgressLine({ ...base, phase: "list", current: 7 })).toBe("  Fetching FOO... 7 items");
  });

  test("labels the content phase distinctly", () => {
    expect(formatProgressLine({ ...base, phase: "content", current: 1 })).toContain("Fetching content for FOO");
  });
});

describe("ProgressReporter", () => {
  test("emits exactly one update per 5% of a known total", async () => {
    const { events, lines } = await runPhase(5000, 5000);
    expect(events).toHaveLength(20);
    expect(lines).toHaveLength(20);
    expect(events[0]).toMatchObject({ event: VFS_PROGRESS, current: 250, total: 5000, percent: 5, phase: "list" });
    expect(events[19]).toMatchObject({ current: 5000, percent: 100 });
  });

  test("a small scope stays quiet — 4 updates for 40 pages, not 40", async () => {
    const { events } = await runPhase(40, 40);
    expect(events.map((e) => e.current)).toEqual([10, 20, 30, 40]);
  });

  test("carries identity, repo scope and unit on every update", async () => {
    const { events } = await runPhase(100, 100);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toMatchObject({
        runId: RUN_ID,
        operation: "clone",
        provider: "confluence",
        scope: "FOO",
        repoRoot: REPO_ROOT,
        unit: "pages",
      });
    }
  });

  test("generates a distinct runId per reporter so concurrent runs demultiplex", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { reporter, events } = makeReporter({ runId: undefined });
      await reporter.start();
      seen.push(String(events[0].runId));
    }
    expect(seen[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("omits total and percent when the provider cannot count", async () => {
    const { events } = await runPhase(120, undefined);
    expect(events.map((e) => e.current)).toEqual([50, 100]);
    expect(events[0].total).toBeUndefined();
    expect(events[0].percent).toBeUndefined();
  });

  test("tick reports whether it emitted", async () => {
    const { reporter } = makeReporter();
    expect(await reporter.tick("list", 1, 5000)).toBe(false);
    expect(await reporter.tick("list", 250, 5000)).toBe(true);
  });

  test("phases throttle independently", async () => {
    const { reporter, events } = makeReporter();
    await reporter.tick("list", 100, 100);
    // A fresh phase starts its own bar instead of inheriting `list`'s high mark.
    expect(await reporter.tick("content", 10, 10)).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(["list", "content"]);
  });

  test("start announces the operation without waiting for a denominator", async () => {
    const { reporter, lines, events } = makeReporter();
    await reporter.start();
    expect(lines).toEqual(["Cloning confluence/FOO..."]);
    expect(events[0]).toMatchObject({ event: VFS_STARTED, current: 0, repoRoot: REPO_ROOT });
    expect(events[0].total).toBeUndefined();
  });

  test("start is idempotent — one started event per run", async () => {
    const { reporter, events } = makeReporter();
    await reporter.start();
    await reporter.start();
    expect(events).toHaveLength(1);
  });

  test("announceTotal logs the denominator once it arrives, without a second event", async () => {
    const { reporter, lines, events } = makeReporter();
    await reporter.start();
    reporter.announceTotal(5000);
    reporter.announceTotal(undefined);
    expect(lines).toEqual(["Cloning confluence/FOO...", "  → 5000 pages to fetch"]);
    expect(events).toHaveLength(1);
  });

  test("finish emits a terminal event and no extra stderr line", async () => {
    const { reporter, lines, events } = makeReporter();
    await reporter.start();
    await reporter.tick("list", 40, 40);
    await reporter.finish(42);
    expect(events.at(-1)).toEqual({
      event: VFS_COMPLETED,
      runId: RUN_ID,
      operation: "clone",
      provider: "confluence",
      scope: "FOO",
      repoRoot: REPO_ROOT,
      unit: "pages",
      phase: "list",
      current: 40,
      total: 40,
      percent: 100,
      items: 42,
    });
    // `items` is what the run produced; `current`/`total` stay in the last
    // phase's unit so a subscriber tracking the bar never sees it collapse.
    expect(lines.at(-1)).toBe("  Fetching FOO... 40/40 pages (100%)");
  });

  test("finish reports where the run actually got to, not just the last emitted tick", async () => {
    const { reporter, events } = makeReporter();
    await reporter.start();
    await reporter.tick("list", 10, 40); // emitted
    await reporter.tick("list", 13, 40); // throttled away
    await reporter.finish();
    expect(events.at(-1)).toMatchObject({ event: VFS_COMPLETED, current: 13, total: 40 });
  });

  test("fail closes the stream when the operation throws", async () => {
    const { reporter, events } = makeReporter();
    await reporter.start();
    await reporter.tick("list", 250, 5000);
    await reporter.fail(new Error("401 token expired"));
    expect(events.at(-1)).toMatchObject({
      event: VFS_FAILED,
      runId: RUN_ID,
      repoRoot: REPO_ROOT,
      phase: "list",
      current: 250,
      total: 5000,
      error: "401 token expired",
    });
  });

  test("every started run ends in exactly one terminal event", async () => {
    const { reporter, events } = makeReporter();
    await reporter.start();
    await reporter.finish(1);
    await reporter.fail(new Error("late failure"));
    await reporter.finish(2);
    const terminal = events.filter((e) => e.event === VFS_COMPLETED || e.event === VFS_FAILED);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toBe(VFS_COMPLETED);
  });

  test("a run that never started emits no terminal event", async () => {
    const { reporter, events } = makeReporter();
    await reporter.fail(new Error("scope resolution failed"));
    expect(events).toEqual([]);
  });

  test("awaits the sink, so a socket write lands before the process exits", async () => {
    // The regression #2983 guards: a fire-and-forget publish resolves after the
    // caller has already returned, and process.exit() drops it.
    let delivered = 0;
    const { reporter } = makeReporter({
      onEvent: async () => {
        await Promise.resolve();
        delivered++;
      },
    });
    await reporter.start();
    await reporter.finish(1);
    expect(delivered).toBe(2);
  });

  test("works with no event sink attached", async () => {
    const { reporter, lines } = makeReporter({ onEvent: undefined });
    await reporter.start();
    reporter.announceTotal(10);
    await reporter.tick("list", 10, 10);
    await reporter.finish(10);
    expect(lines).toHaveLength(3);
  });
});

describe("estimateTotal", () => {
  test("is undefined for a provider without count()", async () => {
    expect(await estimateTotal(makeProvider(), SCOPE)).toBeUndefined();
  });

  test("returns the provider's count", async () => {
    const provider = makeProvider({ count: async () => 5000 });
    expect(await estimateTotal(provider, SCOPE)).toBe(5000);
  });

  test("a failing count() does not propagate — progress just loses its denominator", async () => {
    const provider = makeProvider({
      count: async () => {
        throw new Error("CQL search unavailable");
      },
    });
    expect(await estimateTotal(provider, SCOPE)).toBeUndefined();
  });

  test("rejects a nonsense count", async () => {
    expect(await estimateTotal(makeProvider({ count: async () => -1 }), SCOPE)).toBeUndefined();
    expect(await estimateTotal(makeProvider({ count: async () => Number.NaN }), SCOPE)).toBeUndefined();
    expect(await estimateTotal(makeProvider({ count: async () => undefined }), SCOPE)).toBeUndefined();
  });

  test("treats zero as unknown, not as an empty scope", async () => {
    // A remote that failed to populate totalSize is indistinguishable from a
    // genuinely empty space, and `0` would render a header contradicting the bar.
    expect(await estimateTotal(makeProvider({ count: async () => 0 }), SCOPE)).toBeUndefined();
  });

  test("caps the estimate at --limit, since the listing stops there", async () => {
    const provider = makeProvider({ count: async () => 5000 });
    expect(await estimateTotal(provider, SCOPE, 100)).toBe(100);
    expect(await estimateTotal(provider, SCOPE, 9000)).toBe(5000);
  });
});
