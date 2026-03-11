import { describe, expect, test } from "bun:test";
import type { CodexProcess } from "./codex-process";
import { CodexRpcClient } from "./codex-rpc";

/** Create a mock CodexProcess that captures written messages. */
function createMockProcess() {
  const written: Record<string, unknown>[] = [];
  const proc = {
    async write(msg: Record<string, unknown>) {
      written.push(msg);
    },
  } as unknown as CodexProcess;
  return { proc, written };
}

describe("CodexRpcClient", () => {
  test("request sends JSON-RPC and resolves on response", async () => {
    const { proc, written } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    const promise = rpc.request("initialize", { clientInfo: { name: "test", version: "0.1" } });

    // Verify the request was written
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "0.1" } },
    });

    // Simulate response
    rpc.handleMessage({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "codex", version: "0.112.0" } } });

    const result = await promise;
    expect(result).toEqual({ serverInfo: { name: "codex", version: "0.112.0" } });
  });

  test("request rejects on error response", async () => {
    const { proc } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    const promise = rpc.request("bad/method");
    rpc.handleMessage({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });

    await expect(promise).rejects.toThrow("RPC error -32601: Method not found");
  });

  test("request times out", async () => {
    const { proc } = createMockProcess();
    const rpc = new CodexRpcClient(proc, { timeoutMs: 50 });

    const promise = rpc.request("slow/method");
    await expect(promise).rejects.toThrow("RPC timeout: slow/method (50ms)");
    expect(rpc.pendingCount).toBe(0);
  });

  test("notify sends without id", async () => {
    const { proc, written } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    await rpc.notify("initialized", { foo: "bar" });

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({ jsonrpc: "2.0", method: "initialized", params: { foo: "bar" } });
    expect(written[0]).not.toHaveProperty("id");
  });

  test("routes notifications to callback", () => {
    const { proc } = createMockProcess();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    const rpc = new CodexRpcClient(proc, {
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    rpc.handleMessage({ jsonrpc: "2.0", method: "turn/completed", params: { status: "completed" } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({ method: "turn/completed", params: { status: "completed" } });
  });

  test("routes server requests to callback", () => {
    const { proc } = createMockProcess();
    const requests: Array<{ id: number | string; method: string; params: Record<string, unknown> }> = [];

    const rpc = new CodexRpcClient(proc, {
      onServerRequest: (id, method, params) => requests.push({ id, method, params }),
    });

    rpc.handleMessage({
      jsonrpc: "2.0",
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", cwd: "/tmp" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", cwd: "/tmp" },
    });
  });

  test("respondToServerRequest sends response with matching id", async () => {
    const { proc, written } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    await rpc.respondToServerRequest(42, { decision: "accept" });

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({ jsonrpc: "2.0", id: 42, result: { decision: "accept" } });
  });

  test("rejectAll clears all pending requests", async () => {
    const { proc } = createMockProcess();
    const rpc = new CodexRpcClient(proc, { timeoutMs: 60_000 });

    const p1 = rpc.request("method1");
    const p2 = rpc.request("method2");
    expect(rpc.pendingCount).toBe(2);

    rpc.rejectAll("process died");

    await expect(p1).rejects.toThrow("process died");
    await expect(p2).rejects.toThrow("process died");
    expect(rpc.pendingCount).toBe(0);
  });

  test("auto-increments request ids", async () => {
    const { proc, written } = createMockProcess();
    const rpc = new CodexRpcClient(proc, { timeoutMs: 60_000 });

    const p1 = rpc.request("a");
    const p2 = rpc.request("b");
    const p3 = rpc.request("c");

    expect((written[0] as { id: number }).id).toBe(1);
    expect((written[1] as { id: number }).id).toBe(2);
    expect((written[2] as { id: number }).id).toBe(3);

    rpc.rejectAll("cleanup");
    // Consume the rejections to avoid unhandled promise errors
    await expect(p1).rejects.toThrow("cleanup");
    await expect(p2).rejects.toThrow("cleanup");
    await expect(p3).rejects.toThrow("cleanup");
  });

  test("request cleans up timer and pending on write failure", async () => {
    const proc = {
      async write(_msg: Record<string, unknown>) {
        throw new Error("stdin closed");
      },
    } as unknown as CodexProcess;
    const rpc = new CodexRpcClient(proc, { timeoutMs: 60_000 });

    await expect(rpc.request("test/method")).rejects.toThrow("stdin closed");
    expect(rpc.pendingCount).toBe(0);
  });

  test("ignores orphaned responses", () => {
    const { proc } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    // Should not throw — just silently drops
    rpc.handleMessage({ jsonrpc: "2.0", id: 999, result: "orphan" });
    expect(rpc.pendingCount).toBe(0);
  });

  test("ignores unknown message shapes", () => {
    const { proc } = createMockProcess();
    const rpc = new CodexRpcClient(proc);

    // No method, no id, no result — should not throw
    rpc.handleMessage({ jsonrpc: "2.0", data: "weird" });
  });
});
