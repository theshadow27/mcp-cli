import { describe, expect, test } from "bun:test";
import { BunStdioServerTransport } from "./bun-stdio-transport";

/** Create a ReadableStream from lines of text. */
function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

/** Collect stdout writes into an array. */
function mockStdout(): { writes: string[]; writer: { write(data: string): number } } {
  const writes: string[] = [];
  return {
    writes,
    writer: {
      write: (data: string) => {
        writes.push(data);
        return data.length;
      },
    },
  };
}

describe("BunStdioServerTransport", () => {
  test("receives and parses a JSON-RPC message from stdin", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const stdin = streamFromLines([`${JSON.stringify(msg)}\n`]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.start();
    // Wait for the read loop to process
    await transport.closed;

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).method).toBe("initialize");

    await transport.close();
  });

  test("handles multiple messages in a single chunk", async () => {
    const msg1 = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const msg2 = { jsonrpc: "2.0", method: "notifications/initialized" };
    const stdin = streamFromLines([`${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.start();
    await transport.closed;

    expect(received).toHaveLength(2);

    await transport.close();
  });

  test("handles message split across chunks", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const full = `${JSON.stringify(msg)}\n`;
    const mid = Math.floor(full.length / 2);
    const stdin = streamFromLines([full.slice(0, mid), full.slice(mid)]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.start();
    await transport.closed;

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).method).toBe("initialize");

    await transport.close();
  });

  test("sends a JSON-RPC message to stdout", async () => {
    // Use a stream that stays open so close() doesn't race with send()
    let closeStream!: () => void;
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => controller.close();
      },
    });
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });

    expect(stdout.writes).toHaveLength(1);
    const parsed = JSON.parse(stdout.writes[0].trim());
    expect(parsed.result.protocolVersion).toBe("2024-11-05");

    closeStream();
    await transport.close();
  });

  test("calls onclose when closed", async () => {
    const stdin = streamFromLines([]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    let closed = false;
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    await transport.close();

    expect(closed).toBe(true);
  });

  test("calls onerror on invalid JSON", async () => {
    const stdin = streamFromLines(["not valid json\n"]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);

    await transport.start();
    await transport.closed;

    expect(errors.length).toBeGreaterThanOrEqual(1);

    await transport.close();
  });

  test("throws if started twice", async () => {
    const stdin = streamFromLines([]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    await transport.start();
    await expect(transport.start()).rejects.toThrow("already started");

    await transport.close();
  });

  test("send() after close() is silently ignored", async () => {
    const stdin = streamFromLines([]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    await transport.start();
    await transport.close();

    // Should not throw or write anything
    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(stdout.writes).toHaveLength(0);
  });

  test("handles \\r\\n line endings", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const stdin = streamFromLines([`${JSON.stringify(msg)}\r\n`]);
    const stdout = mockStdout();
    const transport = new BunStdioServerTransport(stdin, stdout.writer);

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.start();
    await transport.closed;

    expect(received).toHaveLength(1);

    await transport.close();
  });
});
