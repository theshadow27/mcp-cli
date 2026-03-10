import { describe, expect, it } from "bun:test";
import { PROTOCOL_VERSION } from "./constants";
import { DaemonStartCooldownError, IpcCallError, ProtocolMismatchError } from "./ipc-client";

describe("PROTOCOL_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof PROTOCOL_VERSION).toBe("string");
    expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
  });

  it("is deterministic (same value on repeated access)", () => {
    expect(PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});

describe("ProtocolMismatchError", () => {
  it("includes both versions and actionable instructions", () => {
    const err = new ProtocolMismatchError("abc123", "def456");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProtocolMismatchError");
    expect(err.daemonVersion).toBe("abc123");
    expect(err.cliVersion).toBe("def456");
    expect(err.message).toContain("abc123");
    expect(err.message).toContain("def456");
    expect(err.message).toContain("mcx daemon restart");
  });
});

describe("IpcCallError", () => {
  it("preserves code, message, data, and remoteStack", () => {
    const err = new IpcCallError({
      code: -1001,
      message: "Server not found",
      data: { server: "test" },
      stack: "Error: Server not found\n    at dispatch (ipc-server.ts:42)",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IpcCallError);
    expect(err.name).toBe("IpcCallError");
    expect(err.message).toBe("Server not found");
    expect(err.code).toBe(-1001);
    expect(err.data).toEqual({ server: "test" });
    expect(err.remoteStack).toBe("Error: Server not found\n    at dispatch (ipc-server.ts:42)");
  });

  it("handles missing optional fields", () => {
    const err = new IpcCallError({
      code: -32603,
      message: "Internal error",
    });

    expect(err.message).toBe("Internal error");
    expect(err.code).toBe(-32603);
    expect(err.data).toBeUndefined();
    expect(err.remoteStack).toBeUndefined();
  });
});

describe("DaemonStartCooldownError", () => {
  it("includes remaining time and descriptive message", () => {
    const err = new DaemonStartCooldownError(7500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonStartCooldownError");
    expect(err.remainingMs).toBe(7500);
    expect(err.message).toContain("8s"); // Math.ceil(7500/1000)
    expect(err.message).toContain("cooldown");
  });
});
