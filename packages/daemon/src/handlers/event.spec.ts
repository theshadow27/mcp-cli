import { describe, expect, test } from "bun:test";
import type { IpcMethod, MonitorEvent } from "@mcp-cli/core";
import { IPC_ERROR, MONITOR_SEVERITIES, SESSION_PERMISSION_REQUEST } from "@mcp-cli/core";
import { EventBus } from "../event-bus";
import type { RequestHandler } from "../handler-types";
import { EventHandlers } from "./event";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function mockEventBus() {
  return {
    publish: (input: unknown) => ({ seq: 1, ...(input as object) }),
  } as never;
}

function buildHandlers(bus = mockEventBus()): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new EventHandlers(bus).register(map);
  return map;
}

describe("EventHandlers", () => {
  test("publishEvent publishes to eventBus", async () => {
    const map = buildHandlers();
    const result = (await invoke(map, "publishEvent")(
      { src: "test", event: "test.event", category: "session" },
      {} as never,
    )) as { ok: boolean; seq: number };
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(1);
  });

  test("publishEvent throws when no eventBus", async () => {
    const map = buildHandlers(null as never);
    await expect(
      invoke(map, "publishEvent")({ src: "test", event: "test.event", category: "session" }, {} as never),
    ).rejects.toMatchObject({ code: IPC_ERROR.INTERNAL_ERROR });
  });
});

/**
 * The envelope invariants (#1924) are only at risk on untyped ingress. `extra` is
 * `z.record(z.string(), z.unknown())`, so any socket client can put arbitrary keys
 * — including `payload`, a bogus `severity`, and an oversized `summary` — into the
 * object that `EventHandlers` spreads into `publish`. The compiler cannot see them.
 *
 * These tests drive the real handler over a default `new EventBus()` and assert on
 * the envelope a monitor consumer actually receives: the JSON string the bus
 * serializes for its subscribers. No stub bus, no hand-built input, no assertion
 * against the intended shape — only against the emitted one.
 */
describe("publishEvent envelope invariants over untyped ingress", () => {
  function publishAndObserve(params: Record<string, unknown>): MonitorEvent {
    const bus = new EventBus();
    const map = new Map<IpcMethod, RequestHandler>();
    new EventHandlers(bus).register(map);

    let observed: MonitorEvent | undefined;
    bus.subscribe((_event, serialized) => {
      observed = JSON.parse(serialized) as MonitorEvent;
    });

    const handler = map.get("publishEvent");
    if (!handler) throw new Error("publishEvent not registered");
    handler(params, {} as never);

    if (!observed) throw new Error("no event delivered to subscriber");
    return observed;
  }

  test("a hostile client cannot violate any of the three invariants", () => {
    const observed = publishAndObserve({
      src: "hostile-client",
      event: SESSION_PERMISSION_REQUEST,
      category: "session",
      extra: {
        payload: { state: "BEHIND" },
        severity: "banana",
        summary: "x".repeat(500),
      },
    });

    // Flat: the nested payload never reaches the consumer.
    expect(Object.hasOwn(observed, "payload")).toBe(false);

    // Severity is one of the four tiers — and specifically the table's tier, so
    // an urgent event cannot be smuggled below the documented filter threshold.
    expect(MONITOR_SEVERITIES as readonly (string | undefined)[]).toContain(observed.severity);
    expect(observed.severity).toBe("urgent");

    // Summary is capped and non-empty.
    expect(observed.summary).toBeTruthy();
    expect((observed.summary ?? "").length).toBeLessThanOrEqual(120);
  });

  test("a producer-supplied summary is normalized, not trusted verbatim", () => {
    const observed = publishAndObserve({
      src: "hostile-client",
      event: "session.idle",
      category: "session",
      extra: { summary: `  leading\nand\r\nembedded newlines  ${"y".repeat(200)}` },
    });

    // Newline runs collapse to a single space and the ends are trimmed; interior
    // spacing from the producer is otherwise left alone.
    expect(observed.summary).toBe(`${`leading and embedded newlines  ${"y".repeat(200)}`.slice(0, 119)}…`);
    expect(observed.summary).not.toContain("\n");
    expect(observed.summary).not.toContain("\r");
    expect((observed.summary ?? "").length).toBeLessThanOrEqual(120);
    expect(observed.summary?.startsWith(" ")).toBe(false);
  });

  test("an in-set producer severity is still honoured", () => {
    const observed = publishAndObserve({
      src: "hostile-client",
      event: "session.tool_use",
      category: "session",
      extra: { severity: "urgent" },
    });
    expect(observed.severity).toBe("urgent");
  });

  test("the default path stamps both fields with no producer input at all", () => {
    const observed = publishAndObserve({ src: "cli", event: "session.idle", category: "session" });
    expect(observed.summary).toBeTruthy();
    expect(MONITOR_SEVERITIES as readonly (string | undefined)[]).toContain(observed.severity);
    expect(observed.severity).toBe("actionable");
  });
});
