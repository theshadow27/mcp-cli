import { describe, expect, test } from "bun:test";
import { WireUnsafeError } from "@mcp-cli/core";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DomainWorkerTransport, checkedControlMessage } from "./transport";

/** Stands in for the worker's `self` — records what would cross the boundary. */
function fakeSelf() {
  const posted: unknown[] = [];
  const target = {
    postMessage: (message: unknown) => posted.push(message),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  return { posted, self: target as unknown as Worker };
}

describe("DomainWorkerTransport", () => {
  // The worker→daemon direction. Review found both of its wire checks deletable
  // with the suite staying green — the two rows the PR body claimed loudest.

  test("sends a wire-safe frame through unchanged", async () => {
    const { posted, self } = fakeSelf();
    const transport = new DomainWorkerTransport(self);
    const frame = { jsonrpc: "2.0", id: 1, result: { content: [] } } as JSONRPCMessage;

    await transport.send(frame);

    expect(posted).toEqual([frame]);
  });

  test("answers an unsendable result with an error frame naming the field", async () => {
    // Mutation this must fail against: delete the wire check from
    // DomainWorkerTransport.send. `isError: undefined` is the single most likely
    // #3044 spelling — `isError?: boolean` is declared optional — and it is
    // exactly what JSON drops.
    const { posted, self } = fakeSelf();
    const transport = new DomainWorkerTransport(self);
    const frame = { jsonrpc: "2.0", id: 4, result: { content: [], isError: undefined } } as unknown as JSONRPCMessage;

    await transport.send(frame);

    expect(posted).toHaveLength(1);
    const sent = posted[0] as { id: number; error?: { code: number; message: string }; result?: unknown };
    expect(sent.result).toBeUndefined();
    expect(sent.id).toBe(4);
    expect(sent.error?.message).toContain("$.result.isError");
    // The diagnostic has to name the field. Throwing instead would be swallowed
    // by the SDK and surface to the caller as "Request timed out".
    expect(sent.error?.message).toContain("undefined");
  });

  test("a Date in a tool result is caught, not silently stringified", async () => {
    const { posted, self } = fakeSelf();
    const transport = new DomainWorkerTransport(self);
    const frame = { jsonrpc: "2.0", id: 5, result: { at: new Date() } } as unknown as JSONRPCMessage;

    await transport.send(frame);

    const sent = posted[0] as { error?: { message: string } };
    expect(sent.error?.message).toContain("$.result.at");
    expect(sent.error?.message).toContain("Date");
  });

  test("throws for an unsendable notification — there is no id to answer", async () => {
    const { posted, self } = fakeSelf();
    const transport = new DomainWorkerTransport(self);
    const frame = { jsonrpc: "2.0", method: "notifications/message", params: { at: new Date() } } as JSONRPCMessage;

    await expect(transport.send(frame)).rejects.toThrow(WireUnsafeError);
    expect(posted).toHaveLength(0);
  });
});

describe("checkedControlMessage", () => {
  test("passes a well-formed control message through", () => {
    const ready = { type: "ready", supported_protocol_version: 1, domain_id: 3 } as const;
    expect(checkedControlMessage(ready)).toBe(ready);
  });

  test("rejects a control message that would not survive JSON", () => {
    // Mutation this must fail against: delete `assertWireSafe` from
    // checkedControlMessage. The worker only ever posts `ready` and `error`,
    // both safe by construction, so nothing else in the suite can reach this.
    const smuggled = { type: "error", message: "boom", at: new Date() } as unknown as Parameters<
      typeof checkedControlMessage
    >[0];

    expect(() => checkedControlMessage(smuggled)).toThrow(WireUnsafeError);
    expect(() => checkedControlMessage(smuggled)).toThrow(/\$\.at/);
  });
});
