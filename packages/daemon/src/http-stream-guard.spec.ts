import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type StreamSuppressedInfo, createHttpStreamGuard } from "./http-stream-guard";

setDefaultTimeout(15_000);

const SSE_GET: RequestInit = { method: "GET", headers: { accept: "text/event-stream" } };
const STATEFUL_SSE_GET: RequestInit = {
  method: "GET",
  headers: { accept: "text/event-stream", "mcp-session-id": "sess-1" },
};

/** A fetch stub that records calls and returns an empty, already-closed SSE stream. */
function stubFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(null, { status: 200 });
  };
  return { calls, fn };
}

describe("createHttpStreamGuard", () => {
  test("passes POST traffic through untouched", async () => {
    const { calls, fn } = stubFetch();
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn });

    const res = await guard("http://x/", { method: "POST", body: "{}" });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "http://x/", method: "POST" }]);
  });

  test("passes a non-SSE GET through untouched", async () => {
    const { calls, fn } = stubFetch();
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn });

    await guard("http://x/", { method: "GET", headers: { accept: "application/json" } });

    expect(calls).toHaveLength(1);
  });

  test("suppresses the notification stream immediately for a stateless server", async () => {
    const { calls, fn } = stubFetch();
    const seen: StreamSuppressedInfo[] = [];
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn, onSuppress: (i) => seen.push(i) });

    const res = await guard("http://x/", SSE_GET);

    // 405 is the SDK's "this server has no GET stream" signal: it stops
    // reopening without scheduling a reconnect and without firing onerror.
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0); // never touched the network
    expect(seen).toEqual([{ server: "srv", reason: "stateless", reopens: 0, windowMs: 60_000 }]);
  });

  test("onSuppress fires once even across many suppressed opens", async () => {
    const { fn } = stubFetch();
    const seen: StreamSuppressedInfo[] = [];
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn, onSuppress: (i) => seen.push(i) });

    for (let i = 0; i < 5; i++) await guard("http://x/", SSE_GET);

    expect(seen).toHaveLength(1);
  });

  test("allows a stateful server to reopen up to the limit", async () => {
    const { calls, fn } = stubFetch();
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn, limit: 3, now: () => 1000 });

    for (let i = 0; i < 3; i++) {
      expect((await guard("http://x/", STATEFUL_SSE_GET)).status).toBe(200);
    }

    expect(calls).toHaveLength(3);
  });

  test("suppresses a stateful server that reopens past the limit", async () => {
    const { calls, fn } = stubFetch();
    const seen: StreamSuppressedInfo[] = [];
    const guard = createHttpStreamGuard("srv", {
      fetchImpl: fn,
      limit: 3,
      now: () => 1000,
      onSuppress: (i) => seen.push(i),
    });

    for (let i = 0; i < 3; i++) await guard("http://x/", STATEFUL_SSE_GET);
    const res = await guard("http://x/", STATEFUL_SSE_GET);

    expect(res.status).toBe(405);
    expect(calls).toHaveLength(3);
    expect(seen[0]).toMatchObject({ reason: "flapping", reopens: 4 });
  });

  test("reopens outside the window do not count toward the limit", async () => {
    const { calls, fn } = stubFetch();
    let clock = 0;
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn, limit: 2, windowMs: 1000, now: () => clock });

    // Two per window, each window well clear of the last — never trips.
    for (let i = 0; i < 5; i++) {
      clock += 2000;
      await guard("http://x/", STATEFUL_SSE_GET);
      await guard("http://x/", STATEFUL_SSE_GET);
    }

    expect(calls).toHaveLength(10);
  });

  test("stays latched once suppressed, even if the session id later appears", async () => {
    const { calls, fn } = stubFetch();
    const guard = createHttpStreamGuard("srv", { fetchImpl: fn });

    await guard("http://x/", SSE_GET); // stateless → suppressed
    const res = await guard("http://x/", STATEFUL_SSE_GET);

    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

describe("createHttpStreamGuard against a real transport", () => {
  test("a stateless server that closes the stream is opened once, and POSTs still work", async () => {
    let getCount = 0;
    let toolsListed = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "GET") {
          getCount++;
          // The shape that causes the storm: 200, then closed immediately.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        if (req.method === "POST") {
          const body = (await req.json()) as { id?: number; method: string };
          if (body.method === "initialize") {
            // No mcp-session-id header — this server is stateless.
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "stateless", version: "0.0.1" },
              },
            });
          }
          if (body.method === "tools/list") {
            toolsListed++;
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
          }
          return new Response(null, { status: 202 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const suppressed: StreamSuppressedInfo[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/`), {
      fetch: createHttpStreamGuard("stateless", { onSuppress: (i) => suppressed.push(i) }),
    });
    const errors: string[] = [];
    transport.onerror = (e) => errors.push(e.message);

    const client = new Client({ name: "test", version: "0.0.1" });
    try {
      await client.connect(transport);

      // The stream open is fired off after `notifications/initialized` is
      // accepted, so poll for the suppression rather than assuming it has
      // already happened.
      const deadline = Date.now() + 5000;
      while (suppressed.length === 0 && Date.now() < deadline) {
        await client.listTools();
      }

      expect(suppressed).toHaveLength(1);
      expect(suppressed[0].reason).toBe("stateless");

      // The guard answered the GET locally, so the server never saw one. Without
      // it this climbs by roughly one per second, forever.
      expect(getCount).toBe(0);

      // And the request/response channel is unaffected.
      const before = toolsListed;
      await client.listTools();
      expect(toolsListed).toBe(before + 1);

      // Suppression is the SDK's "no GET stream here" path, not an error path.
      expect(errors).toEqual([]);
    } finally {
      await transport.close();
      server.stop(true);
    }
  });
});
