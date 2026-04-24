import { describe, expect, test } from "bun:test";
import {
  type EventFilterSpec,
  WaitTimeoutError,
  createWaitForEvent,
  filterSpecToStreamParams,
  globToRegex,
  matchFilter,
} from "./event-filter";
import type { MonitorEvent } from "./monitor-event";

// ── Helpers ──

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    src: "test",
    event: "pr.opened",
    category: "work_item",
    ...overrides,
  };
}

// ── globToRegex ──

describe("globToRegex", () => {
  test("matches exact string", () => {
    expect(globToRegex("pr.opened").test("pr.opened")).toBe(true);
  });

  test("* matches any chars", () => {
    expect(globToRegex("pr.*").test("pr.opened")).toBe(true);
    expect(globToRegex("pr.*").test("pr.merged")).toBe(true);
    expect(globToRegex("pr.*").test("session.result")).toBe(false);
  });

  test("? matches single char", () => {
    expect(globToRegex("ci.?inished").test("ci.finished")).toBe(true);
    expect(globToRegex("ci.?inished").test("ci.xinished")).toBe(true);
    expect(globToRegex("ci.?inished").test("ci.finished2")).toBe(false);
  });

  test("anchored — no partial matches", () => {
    expect(globToRegex("pr.*").test("xpr.opened")).toBe(false);
  });
});

// ── matchFilter ──

describe("matchFilter", () => {
  test("empty spec matches everything", () => {
    expect(matchFilter(makeEvent(), {})).toBe(true);
  });

  test("subscribe category filter", () => {
    const spec: EventFilterSpec = { subscribe: ["session"] };
    expect(matchFilter(makeEvent({ category: "session" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ category: "work_item" }), spec)).toBe(false);
  });

  test("type glob filter — single pattern", () => {
    const spec: EventFilterSpec = { type: "pr.*" };
    expect(matchFilter(makeEvent({ event: "pr.opened" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ event: "session.result" }), spec)).toBe(false);
  });

  test("type filter — array of globs (OR)", () => {
    const spec: EventFilterSpec = { type: ["pr.*", "session.idle"] };
    expect(matchFilter(makeEvent({ event: "pr.merged" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ event: "session.idle" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ event: "session.result" }), spec)).toBe(false);
  });

  test("session filter", () => {
    const spec: EventFilterSpec = { session: "abc" };
    expect(matchFilter(makeEvent({ sessionId: "abc" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ sessionId: "xyz" }), spec)).toBe(false);
    expect(matchFilter(makeEvent({}), spec)).toBe(false);
  });

  test("pr filter", () => {
    const spec: EventFilterSpec = { pr: 42 };
    expect(matchFilter(makeEvent({ prNumber: 42 }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ prNumber: 43 }), spec)).toBe(false);
    expect(matchFilter(makeEvent({}), spec)).toBe(false);
  });

  test("workItem filter", () => {
    const spec: EventFilterSpec = { workItem: "wi-1" };
    expect(matchFilter(makeEvent({ workItemId: "wi-1" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ workItemId: "wi-2" }), spec)).toBe(false);
  });

  test("src glob filter", () => {
    const spec: EventFilterSpec = { src: "daemon.*" };
    expect(matchFilter(makeEvent({ src: "daemon.poller" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ src: "user.script" }), spec)).toBe(false);
  });

  test("phase filter", () => {
    const spec: EventFilterSpec = { phase: "review" };
    expect(matchFilter(makeEvent({ phase: "review" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ phase: "impl" }), spec)).toBe(false);
  });

  test("multiple filter axes — all must match (AND)", () => {
    const spec: EventFilterSpec = { pr: 10, type: "ci.*" };
    expect(matchFilter(makeEvent({ prNumber: 10, event: "ci.finished" }), spec)).toBe(true);
    expect(matchFilter(makeEvent({ prNumber: 10, event: "pr.opened" }), spec)).toBe(false);
    expect(matchFilter(makeEvent({ prNumber: 99, event: "ci.finished" }), spec)).toBe(false);
  });

  test("heartbeats are NOT auto-passed by matchFilter", () => {
    const spec: EventFilterSpec = { subscribe: ["work_item"] };
    const hb = makeEvent({ category: "heartbeat", event: "heartbeat" });
    // matchFilter returns false because heartbeat category is not in spec.subscribe
    expect(matchFilter(hb, spec)).toBe(false);
  });
});

// ── filterSpecToStreamParams ──

describe("filterSpecToStreamParams", () => {
  test("converts subscribe array to comma-separated string", () => {
    const p = filterSpecToStreamParams({ subscribe: ["session", "ci"] });
    expect(p.subscribe).toBe("session,ci");
  });

  test("converts type array to comma-separated string", () => {
    const p = filterSpecToStreamParams({ type: ["pr.*", "ci.*"] });
    expect(p.type).toBe("pr.*,ci.*");
  });

  test("passes through scalar fields", () => {
    const p = filterSpecToStreamParams({ pr: 42, session: "s1", workItem: "w1", src: "x", phase: "impl" });
    expect(p.pr).toBe(42);
    expect(p.session).toBe("s1");
    expect(p.workItem).toBe("w1");
    expect(p.src).toBe("x");
    expect(p.phase).toBe("impl");
  });

  test("undefined fields stay undefined", () => {
    const p = filterSpecToStreamParams({});
    expect(p.subscribe).toBeUndefined();
    expect(p.type).toBeUndefined();
    expect(p.pr).toBeUndefined();
  });
});

// ── WaitTimeoutError ──

describe("WaitTimeoutError", () => {
  test("has correct name and message", () => {
    const err = new WaitTimeoutError(5000);
    expect(err.name).toBe("WaitTimeoutError");
    expect(err.message).toContain("5000");
    expect(err instanceof WaitTimeoutError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

// ── createWaitForEvent ──

describe("createWaitForEvent", () => {
  /**
   * Build a fake openEventStream that yields the provided events in sequence.
   * Returns { events: AsyncIterable, abort } just like the real one.
   */
  function fakeStream(evts: MonitorEvent[]): { events: AsyncIterable<MonitorEvent>; abort: () => void } {
    let aborted = false;

    async function* gen(): AsyncGenerator<MonitorEvent> {
      for (const e of evts) {
        if (aborted) return;
        yield e;
      }
    }

    return {
      events: gen(),
      abort: () => {
        aborted = true;
      },
    };
  }

  test("resolves with first matching event", async () => {
    const target = makeEvent({ event: "ci.finished", category: "ci" });
    const noise = makeEvent({ event: "pr.opened", category: "work_item" });

    const waitFor = createWaitForEvent({ openStream: () => fakeStream([noise, target]) });
    const result = await waitFor({ type: "ci.finished" });
    expect(result).toEqual(target);
  });

  test("skips non-matching events", async () => {
    const e1 = makeEvent({ event: "pr.opened", category: "work_item", seq: 1 });
    const e2 = makeEvent({ event: "pr.merged", category: "work_item", seq: 2 });

    const waitFor = createWaitForEvent({ openStream: () => fakeStream([e1, e2]) });
    const result = await waitFor({ type: "pr.merged" });
    expect(result.seq).toBe(2);
  });

  test("skips heartbeat events", async () => {
    const hb = makeEvent({ event: "heartbeat", category: "heartbeat", seq: 1 });
    const target = makeEvent({ event: "ci.finished", category: "ci", seq: 2 });

    const waitFor = createWaitForEvent({ openStream: () => fakeStream([hb, target]) });
    const result = await waitFor({ type: "ci.*" });
    expect(result.seq).toBe(2);
  });

  test("skips ring-buffer heartbeat events ({t:'heartbeat'})", async () => {
    const ringHb = { t: "heartbeat", seq: 99 } as unknown as MonitorEvent;
    const target = makeEvent({ event: "ci.finished", category: "ci", seq: 2 });

    const waitFor = createWaitForEvent({ openStream: () => fakeStream([ringHb, target]) });
    const result = await waitFor({ type: "ci.*" });
    expect(result.seq).toBe(2);
  });

  test("empty-spec waitForEvent({}) skips normalized heartbeats, resolves with next real event", async () => {
    // Regression for #1718: standard-shape heartbeats must not resolve empty-spec waitForEvent.
    const hb = makeEvent({ event: "heartbeat", category: "heartbeat", seq: 1, src: "daemon" });
    const target = makeEvent({ event: "pr.opened", category: "work_item", seq: 2 });

    const waitFor = createWaitForEvent(() => fakeStream([hb, target]));
    const result = await waitFor({});
    expect(result.seq).toBe(2);
    expect(result.event).toBe("pr.opened");
  });

  test("rejects with WaitTimeoutError after timeoutMs", async () => {
    // Infinite stream that yields nothing matching
    const noise = makeEvent({ event: "pr.opened", category: "work_item" });

    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r;
    });

    async function* infinite(): AsyncGenerator<MonitorEvent> {
      yield noise;
      await blockPromise; // block so timeout fires
    }

    const waitFor = createWaitForEvent({ openStream: () => ({ events: infinite(), abort: resolveBlock }) });
    await expect(waitFor({ type: "ci.finished" }, { timeoutMs: 20 })).rejects.toThrow(WaitTimeoutError);
  });

  test("rejects when stream ends without matching event", async () => {
    const e = makeEvent({ event: "pr.opened", category: "work_item" });
    const waitFor = createWaitForEvent({ openStream: () => fakeStream([e]) });
    await expect(waitFor({ type: "ci.finished" })).rejects.toThrow("ended without matching event");
  });

  // ── AbortSignal cancellation ──

  test("pre-aborted signal → immediate AbortError rejection", async () => {
    const controller = new AbortController();
    controller.abort();

    const waitFor = createWaitForEvent({ signal: controller.signal });
    await expect(waitFor({ type: "ci.finished" })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("signal fires while waiting → AbortError rejection", async () => {
    const controller = new AbortController();

    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r;
    });

    async function* blocking(): AsyncGenerator<MonitorEvent> {
      await blockPromise;
      yield makeEvent({ event: "never-reached" }); // abort fires before blockPromise resolves
    }

    const waitFor = createWaitForEvent({ openStream: () => ({ events: blocking(), abort: resolveBlock }), signal: controller.signal });
    const waitPromise = waitFor({ type: "ci.finished" });

    controller.abort();
    await expect(waitPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abort listener removed on normal resolution — no leaked listeners", async () => {
    let listeners: (() => void)[] = [];
    const mockSignal = {
      aborted: false,
      addEventListener(_: string, fn: () => void) {
        listeners.push(fn);
      },
      removeEventListener(_: string, fn: () => void) {
        listeners = listeners.filter((l) => l !== fn);
      },
    } as unknown as AbortSignal;

    const target = makeEvent({ event: "ci.finished", category: "ci" });
    const waitFor = createWaitForEvent({ openStream: () => fakeStream([target]), signal: mockSignal });
    await waitFor({ type: "ci.finished" });

    expect(listeners).toHaveLength(0);
  });

  test("abort listener removed on timeout — no leaked listeners", async () => {
    let listeners: (() => void)[] = [];
    const mockSignal = {
      aborted: false,
      addEventListener(_: string, fn: () => void) {
        listeners.push(fn);
      },
      removeEventListener(_: string, fn: () => void) {
        listeners = listeners.filter((l) => l !== fn);
      },
    } as unknown as AbortSignal;

    const noise = makeEvent({ event: "pr.opened", category: "work_item" });

    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r;
    });

    async function* infinite(): AsyncGenerator<MonitorEvent> {
      yield noise;
      await blockPromise;
    }

    const waitFor = createWaitForEvent({ openStream: () => ({ events: infinite(), abort: resolveBlock }), signal: mockSignal });
    await expect(waitFor({ type: "ci.finished" }, { timeoutMs: 20 })).rejects.toThrow(WaitTimeoutError);
    expect(listeners).toHaveLength(0);
  });

  test("abort after resolve — settled flag prevents second rejection", async () => {
    const controller = new AbortController();
    const target = makeEvent({ event: "ci.finished", category: "ci" });
    const waitFor = createWaitForEvent({ openStream: () => fakeStream([target]), signal: controller.signal });
    const result = await waitFor({ type: "ci.finished" });
    expect(result).toEqual(target);
    // Aborting after resolution must be a no-op (no unhandled rejection, no throw)
    controller.abort();
  });

  test("abort after timeout — settled flag prevents second rejection", async () => {
    const controller = new AbortController();

    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r;
    });

    async function* infinite(): AsyncGenerator<MonitorEvent> {
      await blockPromise;
    }

    const waitFor = createWaitForEvent({ openStream: () => ({ events: infinite(), abort: resolveBlock }), signal: controller.signal });
    await expect(waitFor({ type: "ci.finished" }, { timeoutMs: 10 })).rejects.toThrow(WaitTimeoutError);
    // Aborting after timeout resolution must be a no-op
    controller.abort();
  });
});
