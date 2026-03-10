import { describe, expect, it } from "bun:test";
import { createIsControlMessage } from "./worker-control-message";

describe("createIsControlMessage", () => {
  const validTypes = new Set(["init", "refresh"]);
  const isControlMessage = createIsControlMessage(validTypes);

  it("returns true for { type: 'init' }", () => {
    expect(isControlMessage({ type: "init", aliases: [] })).toBe(true);
  });

  it("returns true for { type: 'refresh' }", () => {
    expect(isControlMessage({ type: "refresh", aliases: [] })).toBe(true);
  });

  it("returns false for JSON-RPC messages", () => {
    expect(isControlMessage({ jsonrpc: "2.0", method: "tools/list", id: 1 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isControlMessage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isControlMessage(undefined)).toBe(false);
  });

  it("returns false for plain objects without type", () => {
    expect(isControlMessage({ foo: "bar" })).toBe(false);
  });

  it("returns false for objects with non-string type", () => {
    expect(isControlMessage({ type: 42 })).toBe(false);
  });

  it("returns false for objects with unknown type string", () => {
    expect(isControlMessage({ type: "unknown" })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isControlMessage("init")).toBe(false);
    expect(isControlMessage(123)).toBe(false);
    expect(isControlMessage(true)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isControlMessage([{ type: "init" }])).toBe(false);
  });

  it("uses different type sets independently", () => {
    const otherGuard = createIsControlMessage(new Set(["tools_changed"]));
    expect(otherGuard({ type: "tools_changed" })).toBe(true);
    expect(otherGuard({ type: "init" })).toBe(false);
    // Original guard is unaffected
    expect(isControlMessage({ type: "init" })).toBe(true);
    expect(isControlMessage({ type: "tools_changed" })).toBe(false);
  });
});
