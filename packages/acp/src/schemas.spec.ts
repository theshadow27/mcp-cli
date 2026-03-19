import { describe, expect, test } from "bun:test";
import { classifyMessage } from "./schemas";

describe("classifyMessage", () => {
  test("response: has id + result", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, result: "ok" })).toBe("response");
  });

  test("response: has id + error", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } })).toBe("response");
  });

  test("notification: has method, no id", () => {
    expect(classifyMessage({ jsonrpc: "2.0", method: "session/update", params: {} })).toBe("notification");
  });

  test("server_request: has id + method", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: {} })).toBe(
      "server_request",
    );
  });

  test("unknown: no id, no method, no result", () => {
    expect(classifyMessage({ jsonrpc: "2.0" })).toBe("unknown");
  });
});
