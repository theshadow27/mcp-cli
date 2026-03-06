import { describe, expect, mock, test } from "bun:test";
import { WorkerClientTransport, WorkerServerTransport } from "./worker-transport";

describe("WorkerClientTransport", () => {
  function mockWorker() {
    return {
      postMessage: mock(() => {}),
      terminate: mock(() => {}),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent | Event) => void) | null,
    };
  }

  test("start() installs onmessage and onerror handlers on worker", async () => {
    const worker = mockWorker();
    const transport = new WorkerClientTransport(worker as unknown as Worker);
    await transport.start();

    expect(worker.onmessage).toBeFunction();
    expect(worker.onerror).toBeFunction();
  });

  test("send() posts message to worker", async () => {
    const worker = mockWorker();
    const transport = new WorkerClientTransport(worker as unknown as Worker);
    const msg = { jsonrpc: "2.0" as const, method: "test", id: 1 };

    await transport.send(msg);

    expect(worker.postMessage).toHaveBeenCalledWith(msg);
  });

  test("incoming worker messages are forwarded to onmessage callback", async () => {
    const worker = mockWorker();
    const transport = new WorkerClientTransport(worker as unknown as Worker);
    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    await transport.start();

    const msg = { jsonrpc: "2.0", result: "ok", id: 1 };
    worker.onmessage?.({ data: msg } as MessageEvent);

    expect(received).toEqual([msg]);
  });

  test("worker errors are forwarded to onerror callback", async () => {
    const worker = mockWorker();
    const transport = new WorkerClientTransport(worker as unknown as Worker);
    const errors: Error[] = [];
    transport.onerror = (err) => errors.push(err);

    await transport.start();

    worker.onerror?.(new ErrorEvent("error", { message: "boom" }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  test("close() terminates worker and calls onclose", async () => {
    const worker = mockWorker();
    const transport = new WorkerClientTransport(worker as unknown as Worker);
    const closeCalled = mock(() => {});
    transport.onclose = closeCalled;

    await transport.close();

    expect(worker.terminate).toHaveBeenCalled();
    expect(closeCalled).toHaveBeenCalled();
  });
});

describe("WorkerServerTransport", () => {
  function mockSelf() {
    return {
      postMessage: mock(() => {}),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
  }

  test("start() installs onmessage handler on self", async () => {
    const self = mockSelf();
    const transport = new WorkerServerTransport(self as unknown as Worker);
    await transport.start();

    expect(self.onmessage).toBeFunction();
  });

  test("send() posts message to self", async () => {
    const self = mockSelf();
    const transport = new WorkerServerTransport(self as unknown as Worker);
    const msg = { jsonrpc: "2.0" as const, result: {}, id: 1 };

    await transport.send(msg);

    expect(self.postMessage).toHaveBeenCalledWith(msg);
  });

  test("close() calls onclose", async () => {
    const self = mockSelf();
    const transport = new WorkerServerTransport(self as unknown as Worker);
    const closeCalled = mock(() => {});
    transport.onclose = closeCalled;

    await transport.close();

    expect(closeCalled).toHaveBeenCalled();
  });
});
