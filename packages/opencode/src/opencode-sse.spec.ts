import { describe, expect, test } from "bun:test";
import { parseSseEvent } from "./opencode-sse";

describe("parseSseEvent", () => {
  test("parses standard SSE event with type and data", () => {
    const raw = 'event: session.status\ndata: {"status":"idle"}';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.status");
    expect(event?.data).toEqual({ status: "idle" });
  });

  test("defaults to 'message' type when no event field", () => {
    const raw = 'data: {"hello":"world"}';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("message");
    expect(event?.data).toEqual({ hello: "world" });
  });

  test("handles multi-line data", () => {
    const raw = 'event: test\ndata: {"a":1}\ndata: extra';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("test");
    // Multi-line data joins with newline, but since it's not valid JSON,
    // it falls back to text wrapper
    expect(event?.data).toEqual({ text: '{"a":1}\nextra' });
  });

  test("ignores comment lines", () => {
    const raw = ': keep-alive\nevent: test\ndata: {"ok":true}';
    const event = parseSseEvent(raw);
    expect(event?.type).toBe("test");
    expect(event?.data).toEqual({ ok: true });
  });

  test("returns null for empty event block", () => {
    const event = parseSseEvent("");
    expect(event).toBeNull();
  });

  test("returns null for comment-only block", () => {
    const event = parseSseEvent(": heartbeat");
    expect(event).toBeNull();
  });

  test("handles non-JSON data as text", () => {
    const raw = "data: plain text message";
    const event = parseSseEvent(raw);
    expect(event?.data).toEqual({ text: "plain text message" });
  });

  test("trims whitespace from event type and data", () => {
    const raw = 'event:  session.status \ndata:  {"status":"busy"} ';
    const event = parseSseEvent(raw);
    expect(event?.type).toBe("session.status");
    expect(event?.data).toEqual({ status: "busy" });
  });
});
