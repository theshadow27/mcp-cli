import { describe, expect, test } from "bun:test";
import { classifyMessage } from "./schemas";

describe("classifyMessage", () => {
  test("response — has id + result", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe("response");
  });

  test("response — has id + error", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } })).toBe("response");
  });

  test("notification — has method, no id", () => {
    expect(classifyMessage({ jsonrpc: "2.0", method: "turn/completed", params: {} })).toBe("notification");
  });

  test("server_request — has id + method", () => {
    expect(
      classifyMessage({
        jsonrpc: "2.0",
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test" },
      }),
    ).toBe("server_request");
  });

  test("unknown — no id, no method", () => {
    expect(classifyMessage({ jsonrpc: "2.0" })).toBe("unknown");
  });

  test("response takes priority when both result and method present", () => {
    // This shouldn't happen in practice, but result/error wins
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, method: "foo", result: {} })).toBe("response");
  });
});
