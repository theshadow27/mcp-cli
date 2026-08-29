import { describe, expect, test } from "bun:test";
import {
  TROUTER_PACKET,
  encodeAck,
  encodeEvent,
  encodeHeartbeat,
  encodeMessage,
  isDisconnect,
  parseEventFrame,
  parseFrame,
} from "./trouter-codec";

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("expected non-null");
  return v;
}

describe("parseFrame", () => {
  test("parses a connect ack", () => {
    const f = parseFrame("1::");
    expect(f).toEqual({ type: 1, id: "", needsAck: false, endpoint: "", data: "" });
  });

  test("parses a heartbeat", () => {
    const f = parseFrame("2::");
    expect(f?.type).toBe(TROUTER_PACKET.heartbeat);
  });

  test("parses a type-3 message with a JSON body containing colons", () => {
    const f = parseFrame('3:::{"id":7,"url":"/v4/f/abc/messaging","body":"{}"}');
    expect(f?.type).toBe(3);
    expect(f?.id).toBe("");
    expect(f?.data).toBe('{"id":7,"url":"/v4/f/abc/messaging","body":"{}"}');
  });

  test("parses an event frame with an id", () => {
    const f = parseFrame('5:1::{"name":"trouter.connected","args":[]}');
    expect(f?.type).toBe(5);
    expect(f?.id).toBe("1");
    expect(f?.needsAck).toBe(false);
  });

  test("detects the ack marker on an id", () => {
    const f = parseFrame('5:42+::{"name":"ping"}');
    expect(f?.id).toBe("42");
    expect(f?.needsAck).toBe(true);
  });

  test("parses the server disconnect frame", () => {
    const f = parseFrame('0:::{"reason":"timeout"}');
    expect(f).not.toBeNull();
    expect(isDisconnect(must(f))).toBe(true);
  });

  test("returns null for a frame with no colons", () => {
    expect(parseFrame("garbage")).toBeNull();
  });

  test("returns null for a non-numeric type", () => {
    expect(parseFrame("x::")).toBeNull();
  });
});

describe("parseEventFrame", () => {
  test("decodes name and args", () => {
    const f = parseFrame('5:1::{"name":"trouter.connected","args":[{"surl":"https://p/f/1/"}]}');
    const ev = parseEventFrame(must(f));
    expect(ev?.name).toBe("trouter.connected");
    expect(ev?.args).toHaveLength(1);
    expect((ev?.args[0] as { surl: string }).surl).toBe("https://p/f/1/");
  });

  test("defaults args to [] when missing", () => {
    const f = parseFrame('5:::{"name":"ping"}');
    const ev = parseEventFrame(must(f));
    expect(ev?.name).toBe("ping");
    expect(ev?.args).toEqual([]);
  });

  test("returns null for a non-event frame", () => {
    const f = parseFrame("2::");
    expect(parseEventFrame(must(f))).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const f = parseFrame("5:::{not json");
    expect(parseEventFrame(must(f))).toBeNull();
  });
});

describe("encoders", () => {
  test("encodeEvent round-trips through parseEventFrame", () => {
    const raw = encodeEvent("user.authenticate", [{ headers: { Authorization: "Bearer x" } }]);
    const ev = parseEventFrame(must(parseFrame(raw)));
    expect(ev?.name).toBe("user.authenticate");
    expect((ev?.args[0] as { headers: { Authorization: string } }).headers.Authorization).toBe("Bearer x");
  });

  test("encodeMessage produces a type-3 frame", () => {
    const raw = encodeMessage({ id: 7, status: 200, headers: {}, body: "" });
    const f = parseFrame(raw);
    expect(f?.type).toBe(3);
    expect(JSON.parse(must(f).data)).toEqual({ id: 7, status: 200, headers: {}, body: "" });
  });

  test("encodeHeartbeat is the bare 2:: frame", () => {
    expect(encodeHeartbeat()).toBe("2::");
  });

  test("encodeAck packs id and args into the data segment", () => {
    expect(encodeAck("42", ["pong"])).toBe('6:::42+["pong"]');
  });
});
