import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_SPEC_URL, AGENT_PROTOCOL_VERSION, ProtocolVersionMismatchError } from "./agent-protocol";

describe("AGENT_PROTOCOL_VERSION", () => {
  test("is a positive integer", () => {
    expect(AGENT_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(AGENT_PROTOCOL_VERSION)).toBe(true);
  });
});

describe("ProtocolVersionMismatchError", () => {
  test("captures requested and supported versions", () => {
    const err = new ProtocolVersionMismatchError(2, 1);
    expect(err.requested).toBe(2);
    expect(err.supported).toBe(1);
    expect(err.name).toBe("ProtocolVersionMismatchError");
    expect(err).toBeInstanceOf(Error);
  });

  test("message references the spec doc URL", () => {
    const err = new ProtocolVersionMismatchError(2, 1);
    expect(err.message).toContain(AGENT_PROTOCOL_SPEC_URL);
    expect(err.message).toContain("v2");
    expect(err.message).toContain("v1");
  });

  test("docUrl field matches the constant", () => {
    const err = new ProtocolVersionMismatchError(3, 1);
    expect(err.docUrl).toBe(AGENT_PROTOCOL_SPEC_URL);
  });
});
