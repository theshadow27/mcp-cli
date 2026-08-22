import { describe, expect, test } from "bun:test";
import { VFS_COMPLETED, VFS_PROGRESS, VFS_STARTED } from "@mcp-cli/core";
import type { RemoteProvider, ResolvedScope } from "../providers/provider";
import {
  ProgressReporter,
  type VfsProgressEvent,
  estimateTotal,
  formatProgressLine,
  percentOf,
  shouldReport,
} from "./progress";

const SCOPE: ResolvedScope = { key: "FOO", cloudId: "cloud-1", resolved: {} };

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
function runPhase(count: number, total: number | undefined): { lines: string[]; events: VfsProgressEvent[] } {
  const lines: string[] = [];
  const events: VfsProgressEvent[] = [];
  const reporter = new ProgressReporter({
    operation: "clone",
    provider: "confluence",
    scope: "FOO",
    log: (m) => lines.push(m),
    onEvent: (e) => events.push(e),
  });
  for (let i = 1; i <= count; i++) reporter.tick("list", i, total);
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

  test("with a small total, the step floors at one item", () => {
    // 5% of 3 rounds up to 1, so a tiny scope reports every item rather than
    // going silent until it finishes.
    expect(shouldReport(1, 3, 0)).toBe(true);
    expect(shouldReport(2, 3, 1)).toBe(true);
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
    expect(shouldReport(10, 100, 0, { percentStep: 10 })).toBe(true);
    expect(shouldReport(9, 100, 0, { percentStep: 10 })).toBe(false);
    expect(shouldReport(5, undefined, 0, { countStep: 5 })).toBe(true);
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
  test("renders the count, total and percent", () => {
    const line = formatProgressLine({
      event: VFS_PROGRESS,
      operation: "clone",
      provider: "confluence",
      scope: "FOO",
      phase: "list",
      current: 250,
      total: 5000,
      percent: 5,
    });
    expect(line).toBe("  Fetching FOO... 250/5000 pages (5%)");
  });

  test("degrades to a bare counter when the total is unknown", () => {
    const line = formatProgressLine({
      event: VFS_PROGRESS,
      operation: "pull",
      provider: "confluence",
      scope: "FOO",
      phase: "list",
      current: 50,
    });
    expect(line).toBe("  Fetching FOO... 50 pages");
  });

  test("labels the content and write phases distinctly", () => {
    const base = { event: VFS_PROGRESS, operation: "clone", provider: "c", scope: "FOO", current: 1 } as const;
    expect(formatProgressLine({ ...base, phase: "content" })).toContain("Fetching content for FOO");
    expect(formatProgressLine({ ...base, phase: "write" })).toContain("Writing FOO");
  });
});

describe("ProgressReporter", () => {
  test("emits exactly one update per 5% of a known total", () => {
    const { events, lines } = runPhase(5000, 5000);
    expect(events).toHaveLength(20);
    expect(lines).toHaveLength(20);
    expect(events[0]).toMatchObject({ event: VFS_PROGRESS, current: 250, total: 5000, percent: 5, phase: "list" });
    expect(events[19]).toMatchObject({ current: 5000, percent: 100 });
  });

  test("carries provider and scope on every update", () => {
    const { events } = runPhase(100, 100);
    for (const e of events) {
      expect(e).toMatchObject({ operation: "clone", provider: "confluence", scope: "FOO" });
    }
  });

  test("omits total and percent when the provider cannot count", () => {
    const { events } = runPhase(120, undefined);
    expect(events.map((e) => e.current)).toEqual([50, 100]);
    expect(events[0].total).toBeUndefined();
    expect(events[0].percent).toBeUndefined();
  });

  test("tick reports whether it emitted", () => {
    const reporter = new ProgressReporter({ operation: "clone", provider: "c", scope: "FOO", log: () => {} });
    expect(reporter.tick("list", 1, 5000)).toBe(false);
    expect(reporter.tick("list", 250, 5000)).toBe(true);
  });

  test("phases throttle independently", () => {
    const events: VfsProgressEvent[] = [];
    const reporter = new ProgressReporter({
      operation: "clone",
      provider: "c",
      scope: "FOO",
      log: () => {},
      onEvent: (e) => events.push(e),
    });
    reporter.tick("list", 100, 100);
    // A fresh phase starts its own bar instead of inheriting `list`'s high mark.
    expect(reporter.tick("content", 10, 10)).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(["list", "content"]);
  });

  test("a phase that restarts (pull falling back to full sync) reports again", () => {
    const reporter = new ProgressReporter({ operation: "pull", provider: "c", scope: "FOO", log: () => {} });
    expect(reporter.tick("content", 20, 20)).toBe(true);
    // Second pass over the same phase with a different denominator.
    expect(reporter.tick("content", 5, 100)).toBe(true);
  });

  test("start announces the operation with the estimate", () => {
    const lines: string[] = [];
    const events: VfsProgressEvent[] = [];
    const reporter = new ProgressReporter({
      operation: "clone",
      provider: "confluence",
      scope: "FOO",
      log: (m) => lines.push(m),
      onEvent: (e) => events.push(e),
    });
    reporter.start(5000);
    expect(lines[0]).toBe("Cloning confluence/FOO... (5000 pages)");
    expect(events[0]).toMatchObject({ event: VFS_STARTED, current: 0, total: 5000 });
  });

  test("start omits the estimate when there is none", () => {
    const lines: string[] = [];
    const events: VfsProgressEvent[] = [];
    const reporter = new ProgressReporter({
      operation: "pull",
      provider: "confluence",
      scope: "FOO",
      log: (m) => lines.push(m),
      onEvent: (e) => events.push(e),
    });
    reporter.start();
    expect(lines[0]).toBe("Pulling confluence/FOO...");
    expect(events[0].total).toBeUndefined();
  });

  test("finish emits a terminal event and no extra stderr line", () => {
    const lines: string[] = [];
    const events: VfsProgressEvent[] = [];
    const reporter = new ProgressReporter({
      operation: "clone",
      provider: "c",
      scope: "FOO",
      log: (m) => lines.push(m),
      onEvent: (e) => events.push(e),
    });
    reporter.finish(42);
    expect(events).toEqual([
      {
        event: VFS_COMPLETED,
        operation: "clone",
        provider: "c",
        scope: "FOO",
        current: 42,
        total: 42,
        percent: 100,
      },
    ]);
    expect(lines).toEqual([]);
  });

  test("works with no event sink attached", () => {
    const lines: string[] = [];
    const reporter = new ProgressReporter({
      operation: "clone",
      provider: "c",
      scope: "FOO",
      log: (m) => lines.push(m),
    });
    reporter.start(10);
    reporter.tick("list", 10, 10);
    reporter.finish(10);
    expect(lines).toHaveLength(2);
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

  test("caps the estimate at --limit, since the listing stops there", async () => {
    const provider = makeProvider({ count: async () => 5000 });
    expect(await estimateTotal(provider, SCOPE, 100)).toBe(100);
    expect(await estimateTotal(provider, SCOPE, 9000)).toBe(5000);
  });
});
