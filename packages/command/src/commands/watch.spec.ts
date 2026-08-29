import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import { type WatchDeps, cmdWatch, parseWatchArgs, sinceToMs } from "./watch";

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

function makeDeps(opts: {
  threads?: Array<{ name: string; id: string; post: "allow" | "deny"; watch: boolean }>;
  events?: MonitorEvent[];
  backfill?: MonitorEvent[];
  isTTY?: boolean;
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
});
