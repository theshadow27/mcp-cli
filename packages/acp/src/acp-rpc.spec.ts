import { describe, expect, test } from "bun:test";
import { AcpRpcClient } from "./acp-rpc";

/** Minimal stub that records writes and allows injecting messages. */
function makeFakeProcess() {
  const written: Record<string, unknown>[] = [];
  let messageHandler: ((msg: Record<string, unknown>) => void) | null = null;

  return {
    written,
    async write(msg: Record<string, unknown>) {
      written.push(msg);
    },
    get alive() {
      return true;
    },
    injectMessage(msg: Record<string, unknown>) {
      messageHandler?.(msg);
    },
    setMessageHandler(handler: (msg: Record<string, unknown>) => void) {
      messageHandler = handler;
    },
  };
}

describe("AcpRpcClient", () => {
  test("request sends JSON-RPC and resolves on response", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never);

    const promise = client.request("initialize", { protocolVersion: 1 });

    // Verify the request was written
    expect(proc.written).toHaveLength(1);
    expect(proc.written[0].method).toBe("initialize");
    expect(proc.written[0].jsonrpc).toBe("2.0");
    const id = proc.written[0].id;

    // Inject the response
    client.handleMessage({ jsonrpc: "2.0", id: id as number, result: { ok: true } });

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  test("request rejects on error response", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never);

    const promise = client.request("bad-method");
    const id = proc.written[0].id;

    client.handleMessage({
      jsonrpc: "2.0",
      id: id as number,
      error: { code: -32601, message: "Method not found" },
    });

    await expect(promise).rejects.toThrow("RPC error -32601: Method not found");
  });

  test("request rejects on timeout", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never, { timeoutMs: 50 });

    await expect(client.request("slow-method")).rejects.toThrow("RPC timeout");
  });

  test("routes notifications to onNotification", () => {
    const proc = makeFakeProcess();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpRpcClient(proc as never, {
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    client.handleMessage({ jsonrpc: "2.0", method: "session/update", params: { foo: 1 } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("session/update");
  });

  test("routes server requests to onServerRequest", () => {
    const proc = makeFakeProcess();
    const requests: Array<{ id: number | string; method: string }> = [];
    const client = new AcpRpcClient(proc as never, {
      onServerRequest: (id, method) => requests.push({ id, method }),
    });

    client.handleMessage({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {},
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("session/request_permission");
  });

  test("notify sends fire-and-forget message", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never);

    await client.notify("session/cancel", { sessionId: "s1" });

    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    expect(proc.written[0]).not.toHaveProperty("id");
  });

  test("respondToServerRequest sends response with correct id", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never);

    await client.respondToServerRequest("perm-1", { outcome: { outcome: "selected", optionId: "opt-1" } });

    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]).toEqual({
      jsonrpc: "2.0",
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "opt-1" } },
    });
  });

  test("rejectAll rejects all pending requests", async () => {
    const proc = makeFakeProcess();
    const client = new AcpRpcClient(proc as never, { timeoutMs: 10_000 });

    const p1 = client.request("method1");
    const p2 = client.request("method2");

    expect(client.pendingCount).toBe(2);
    client.rejectAll("process died");

    await expect(p1).rejects.toThrow("process died");
    await expect(p2).rejects.toThrow("process died");
    expect(client.pendingCount).toBe(0);
  });
});
