import { describe, expect, test } from "bun:test";
import { type DomainSnapshot, WireUnsafeError, domainInitMessage } from "@mcp-cli/core";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createWorkerDomainLink } from "./domain-link";

const phoenix: DomainSnapshot = {
  id: 1,
  name: "phoenix",
  host: null,
  path: "/projects/phoenix",
  createdAt: "2026-08-22T00:00:00Z",
};

/** A stand-in for a Bun Worker: records what was posted, lets a test push messages back. */
function fakeWorker() {
  const posted: unknown[] = [];
  let terminated = false;
  const worker = {
    postMessage: (message: unknown) => posted.push(message),
    terminate: () => {
      terminated = true;
    },
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent | Event) => void) | null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    posted,
    isTerminated: () => terminated,
    worker: worker as unknown as Worker,
    /** Deliver a message from the "worker" to the daemon. */
    emit: (data: unknown) => worker.onmessage?.({ data } as MessageEvent),
    /** Raise a worker error event. */
    raise: (message: string) => worker.onerror?.(new ErrorEvent("error", { message })),
  };
}

function makeLink() {
  const fake = fakeWorker();
  const link = createWorkerDomainLink(phoenix, () => fake.worker);
  return { fake, link };
}

describe("the worker domain link", () => {
  test("posts control messages verbatim", () => {
    const { fake, link } = makeLink();

    link.postControl(domainInitMessage(phoenix, "daemon-1"));

    expect(fake.posted).toEqual([domainInitMessage(phoenix, "daemon-1")]);
  });

  test("refuses to send anything that would not survive JSON", () => {
    // The check is on the send, not on a review comment: a value that crosses
    // postMessage intact and dies over a socket must fail here and now.
    const { fake, link } = makeLink();
    const smuggled = { ...domainInitMessage(phoenix, null), when: new Date() };

    expect(() => link.postControl(smuggled as never)).toThrow(WireUnsafeError);
    expect(fake.posted).toHaveLength(0);
  });

  test("wire-checks JSON-RPC too, not just control messages", async () => {
    const { fake, link } = makeLink();
    const badFrame = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { at: new Date() } };

    await expect(link.transport.send(badFrame as unknown as JSONRPCMessage)).rejects.toThrow(WireUnsafeError);
    expect(fake.posted).toHaveLength(0);
  });

  test("routes control messages to onControl and JSON-RPC to the transport", () => {
    const { fake, link } = makeLink();
    const control: unknown[] = [];
    const rpc: unknown[] = [];
    link.onControl = (m) => control.push(m);
    link.transport.onmessage = (m) => rpc.push(m);

    fake.emit({ type: "ready", supported_protocol_version: 1, domain_id: 1 });
    fake.emit({ jsonrpc: "2.0", id: 1, result: {} });

    expect(control).toHaveLength(1);
    expect(rpc).toHaveLength(1);
  });

  test("treats a message that is neither as a link failure", () => {
    // Feeding it to the MCP client would surface as a parse error with no
    // provenance; a link failure is supervised and restartable.
    const { fake, link } = makeLink();
    const failures: string[] = [];
    link.onFailure = (reason) => failures.push(reason);

    fake.emit({ hello: "there" });

    expect(failures[0]).toContain("unrecognized message");
    expect(failures[0]).toContain("hello");
  });

  test("a worker error reaches both the transport and the supervisor", () => {
    const { fake, link } = makeLink();
    const failures: string[] = [];
    const transportErrors: Error[] = [];
    link.onFailure = (reason) => failures.push(reason);
    link.transport.onerror = (err) => transportErrors.push(err);

    fake.raise("worker panicked");

    expect(failures).toEqual(["worker panicked"]);
    expect(transportErrors[0]?.message).toBe("worker panicked");
  });

  test("close terminates the worker and closes the transport, once", async () => {
    // Closing the transport is what rejects in-flight MCP requests; a link that
    // terminates the thread without it leaves callers waiting forever.
    const { fake, link } = makeLink();
    let closes = 0;
    link.transport.onclose = () => closes++;

    await link.close();
    await link.close();

    expect(fake.isTerminated()).toBe(true);
    expect(closes).toBe(1);
  });

  test("a closed link stops delivering", async () => {
    const { fake, link } = makeLink();
    const control: unknown[] = [];
    link.onControl = (m) => control.push(m);

    await link.close();
    fake.emit({ type: "ready", supported_protocol_version: 1, domain_id: 1 });

    expect(control).toHaveLength(0);
  });
});
