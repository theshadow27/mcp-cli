import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import { type WatchDeps, buildSourceMatcher, cmdWatch, parseWatchArgs, sinceToMs } from "./watch";

const THREAD_ID = "19:aaa@thread.v2";

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

function toolResult(payload: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function siteMessageEvent(thread: string, over: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: "2026-08-28T10:00:00.000Z",
    src: "site.trouter",
    event: "site.message",
    category: "site",
    domainId: 0,
    site: "teams",
    thread,
    id: "1700000000001",
    version: "1700000000001",
    at: "2026-08-28T10:00:00.000Z",
    is_me: false,
    mentions_me: false,
    kind: "new",
    text: "hello",
    ...over,
  } as MonitorEvent;
}

interface Harness {
  deps: WatchDeps;
  stdout: string[];
  stderr: string[];
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
}

function prEvent(prNumber: number, event: string, over: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: "2026-08-28T10:00:00.000Z",
    src: "github.poller",
    event,
    category: "ci",
    domainId: 0,
    prNumber,
    ...over,
  } as MonitorEvent;
}

function makeDeps(opts: {
  threads?: Array<{ name: string; id: string; post: "allow" | "deny"; watch: boolean }>;
  events?: MonitorEvent[];
  backfill?: MonitorEvent[];
  isTTY?: boolean;
  trackedPrs?: number[];
}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const ipcCall = (async (_method: string, params: unknown) => {
    const p = params as { tool: string; arguments: Record<string, unknown> };
    toolCalls.push({ tool: p.tool, args: p.arguments });
    switch (p.tool) {
      case "site_threads":
        return toolResult({ site: "teams", threads: opts.threads ?? [] });
      case "site_watch_start":
        return toolResult({ site: "teams", state: "live", dryRun: p.arguments.dryRun === true });
      case "site_backfill":
        return toolResult({ site: "teams", records: opts.backfill ?? [] });
      default:
        return toolResult({});
    }
  }) as WatchDeps["ipcCall"];

  const openEventStream = (() => {
    async function* gen(): AsyncGenerator<MonitorEvent> {
      for (const e of opts.events ?? []) yield e;
    }
    return { events: gen(), abort: () => {} };
  }) as unknown as WatchDeps["openEventStream"];

  const deps: WatchDeps = {
    ipcCall,
    openEventStream,
    listTrackedPrNumbers: async () => new Set(opts.trackedPrs ?? []),
    isTTY: opts.isTTY ?? false,
    writeStdout: (l) => stdout.push(l),
    writeStderr: (l) => stderr.push(l),
    exit: (code) => {
      throw new ExitError(code);
    },
    onSigint: () => {},
    onStdoutError: () => {},
  };
  return { deps, stdout, stderr, toolCalls };
}

describe("parseWatchArgs", () => {
  test("parses site + threads + flags", () => {
    const a = parseWatchArgs(["teams", "general", "devs", "--ndjson", "--since", "2026-08-28T00:00:00Z"]);
    expect(a.site).toBe("teams");
    expect(a.threads).toEqual(["general", "devs"]);
    expect(a.ndjson).toBe(true);
    expect(a.since).toBe("2026-08-28T00:00:00Z");
  });
  test("flags help", () => {
    expect(parseWatchArgs(["--help"]).error).toBe("help");
  });
  test("rejects max-events < 1", () => {
    expect(parseWatchArgs(["teams", "--max-events", "0"]).error).toContain("--max-events");
  });

  test("back-compat: site + threads only, no PR sources", () => {
    const a = parseWatchArgs(["teams", "general", "devs"]);
    expect(a.site).toBe("teams");
    expect(a.threads).toEqual(["general", "devs"]);
    expect(a.prNumbers).toEqual([]);
    expect(a.error).toBeUndefined();
  });

  test("classifies gh:pr#<n> as a PR source", () => {
    const a = parseWatchArgs(["gh:pr#123"]);
    expect(a.site).toBeUndefined();
    expect(a.threads).toEqual([]);
    expect(a.prNumbers).toEqual([123]);
    expect(a.error).toBeUndefined();
  });

  test("accepts the gh:pr:<n> spelling too", () => {
    expect(parseWatchArgs(["gh:pr:77"]).prNumbers).toEqual([77]);
  });

  test("interleaves a site source with multiple PR sources", () => {
    const a = parseWatchArgs(["teams", "general", "gh:pr#12", "gh:pr#34"]);
    expect(a.site).toBe("teams");
    expect(a.threads).toEqual(["general"]);
    expect(a.prNumbers).toEqual([12, 34]);
  });

  test("rejects a malformed PR number token", () => {
    expect(parseWatchArgs(["gh:pr#abc"]).error).toContain("gh:pr#abc");
  });

  test("rejects an unknown gh: source token", () => {
    expect(parseWatchArgs(["gh:foo"]).error).toContain("gh:foo");
  });

  test("rejects gh:pr#0", () => {
    expect(parseWatchArgs(["gh:pr#0"]).error).toBeDefined();
  });
});

describe("buildSourceMatcher (OR union)", () => {
  const wanted = new Set([THREAD_ID]);

  test("passes a site event on a watched thread", () => {
    const m = buildSourceMatcher({ site: "teams", wantedThreads: wanted, prNumbers: [123] });
    expect(m(siteMessageEvent(THREAD_ID))).toBe(true);
  });

  test("filters a site event on an unwatched thread", () => {
    const m = buildSourceMatcher({ site: "teams", wantedThreads: wanted, prNumbers: [123] });
    expect(m(siteMessageEvent("19:other@thread.v2"))).toBe(false);
  });

  test("passes a pr event for a watched PR", () => {
    const m = buildSourceMatcher({ site: "teams", wantedThreads: wanted, prNumbers: [123] });
    expect(m(prEvent(123, "pr.opened"))).toBe(true);
    expect(m(prEvent(123, "checks.passed"))).toBe(true);
    expect(m(prEvent(123, "ci.finished"))).toBe(true);
  });

  test("filters a pr event for a different PR", () => {
    const m = buildSourceMatcher({ site: "teams", wantedThreads: wanted, prNumbers: [123] });
    expect(m(prEvent(999, "pr.opened"))).toBe(false);
  });

  test("filters an unrelated event", () => {
    const m = buildSourceMatcher({ site: "teams", wantedThreads: wanted, prNumbers: [123] });
    expect(m(prEvent(123, "session.idle"))).toBe(false);
    expect(m(siteMessageEvent(THREAD_ID, { event: "mail.sent" }))).toBe(false);
  });

  test("PR-only matcher (no site) passes pr events and rejects site events", () => {
    const m = buildSourceMatcher({ site: undefined, wantedThreads: new Set(), prNumbers: [42] });
    expect(m(prEvent(42, "ci.running"))).toBe(true);
    expect(m(siteMessageEvent(THREAD_ID))).toBe(false);
  });
});

describe("sinceToMs", () => {
  test("passes epoch-ms through", () => {
    expect(sinceToMs("1700000000001")).toBe("1700000000001");
  });
  test("parses an ISO timestamp", () => {
    expect(sinceToMs("2026-08-28T00:00:00.000Z")).toBe(String(Date.parse("2026-08-28T00:00:00.000Z")));
  });
  test("returns null for garbage", () => {
    expect(sinceToMs("not a date")).toBeNull();
  });
});

describe("cmdWatch", () => {
  const threads = [{ name: "general", id: THREAD_ID, post: "allow" as const, watch: false }];

  test("resolves a thread name to its id when starting the watcher", async () => {
    const h = makeDeps({ threads, events: [] });
    await cmdWatch(["teams", "general", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    const start = h.toolCalls.find((c) => c.tool === "site_watch_start");
    expect(start?.args.threads).toEqual([THREAD_ID]);
  });

  test("dry-run prints the plan and does not open a stream", async () => {
    const h = makeDeps({ threads, events: [siteMessageEvent(THREAD_ID)] });
    await cmdWatch(["teams", "general", "--dry-run"], h.deps);
    expect(h.toolCalls.some((c) => c.tool === "site_watch_start" && c.args.dryRun === true)).toBe(true);
    expect(h.stdout.join("")).toContain('"dryRun": true');
    // No live start (non-dry) should have run.
    expect(h.toolCalls.filter((c) => c.tool === "site_watch_start")).toHaveLength(1);
  });

  test("prints a matching live event as ndjson and stops at --max-events", async () => {
    const h = makeDeps({ threads, events: [siteMessageEvent(THREAD_ID)] });
    await cmdWatch(["teams", "general", "--ndjson", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stdout).toHaveLength(1);
    const parsed = JSON.parse(h.stdout[0]);
    expect(parsed.thread).toBe(THREAD_ID);
    expect(parsed.threadName).toBe("general");
  });

  test("filters out events for other threads", async () => {
    const h = makeDeps({
      threads,
      events: [siteMessageEvent("19:other@thread.v2"), siteMessageEvent(THREAD_ID)],
    });
    await cmdWatch(["teams", "general", "--ndjson", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]).thread).toBe(THREAD_ID);
  });

  test("backfills from --since before the live stream", async () => {
    const h = makeDeps({
      threads,
      backfill: [siteMessageEvent(THREAD_ID, { id: "1699999999999", text: "old" })],
      events: [],
    });
    await cmdWatch(["teams", "general", "--ndjson", "--since", "1699999999998"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    const backfill = h.toolCalls.find((c) => c.tool === "site_backfill");
    expect(backfill?.args.since).toBe("1699999999998");
    expect(h.stdout.some((l) => l.includes("1699999999999"))).toBe(true);
  });

  test("exits 2 when the stream ends before an --until terminator", async () => {
    const h = makeDeps({ threads, events: [] });
    let code: number | undefined;
    await cmdWatch(["teams", "general", "--until", "pr.*"], h.deps).catch((e) => {
      if (e instanceof ExitError) code = e.code;
      else throw e;
    });
    expect(code).toBe(2);
  });

  test("errors when no threads can be resolved", async () => {
    const h = makeDeps({ threads: [], events: [] });
    let code: number | undefined;
    await cmdWatch(["teams"], h.deps).catch((e) => {
      if (e instanceof ExitError) code = e.code;
      else throw e;
    });
    expect(code).toBe(1);
    expect(h.stderr.join("")).toContain("no threads to watch");
  });

  test("errors when neither a site nor a PR source is given", async () => {
    const h = makeDeps({ events: [] });
    let code: number | undefined;
    await cmdWatch(["--ndjson"], h.deps).catch((e) => {
      if (e instanceof ExitError) code = e.code;
      else throw e;
    });
    expect(code).toBe(1);
    expect(h.stderr.join("")).toContain("a source is required");
  });

  test("PR-only watch does not touch any site tool and streams the PR event", async () => {
    const h = makeDeps({ trackedPrs: [123], events: [prEvent(123, "ci.finished")] });
    await cmdWatch(["gh:pr#123", "--ndjson", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    // No site tools called at all in PR-only mode.
    expect(h.toolCalls).toHaveLength(0);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]).prNumber).toBe(123);
  });

  test("warns when a requested PR is not tracked", async () => {
    const h = makeDeps({ trackedPrs: [], events: [prEvent(123, "ci.finished")] });
    await cmdWatch(["gh:pr#123", "--ndjson", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stderr.join("")).toContain("PR #123 is not tracked");
    expect(h.stderr.join("")).toContain("mcx track 123");
  });

  test("does not warn when a requested PR is tracked", async () => {
    const h = makeDeps({ trackedPrs: [123], events: [prEvent(123, "ci.finished")] });
    await cmdWatch(["gh:pr#123", "--ndjson", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stderr.join("")).not.toContain("is not tracked");
  });

  test("combined watch interleaves a thread message and a PR event", async () => {
    const h = makeDeps({
      threads,
      trackedPrs: [123],
      events: [siteMessageEvent(THREAD_ID), prEvent(123, "pr.opened")],
    });
    await cmdWatch(["teams", "general", "gh:pr#123", "--ndjson", "--max-events", "2"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stdout).toHaveLength(2);
    expect(JSON.parse(h.stdout[0]).thread).toBe(THREAD_ID);
    expect(JSON.parse(h.stdout[1]).prNumber).toBe(123);
  });

  test("PR-only dry-run reports source plan with tracked status and opens no stream", async () => {
    const h = makeDeps({ trackedPrs: [] });
    await cmdWatch(["gh:pr#123", "--dry-run"], h.deps);
    expect(h.toolCalls).toHaveLength(0);
    const plan = JSON.parse(h.stdout.join(""));
    expect(plan.prSources).toEqual([{ prNumber: 123, tracked: false }]);
  });

  test("--since on a PR-only watch notes backfill is site-only, does not error", async () => {
    const h = makeDeps({ trackedPrs: [123], events: [prEvent(123, "ci.finished")] });
    await cmdWatch(["gh:pr#123", "--ndjson", "--since", "1700000000000", "--max-events", "1"], h.deps).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(h.stderr.join("")).toContain("--since backfill applies to site sources only");
    expect(h.toolCalls.some((c) => c.tool === "site_backfill")).toBe(false);
  });
});
