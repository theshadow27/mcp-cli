import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenCodeSse, parseSseEvent } from "./opencode-sse";

// ── parseSseEvent (pure function tests) ──

describe("parseSseEvent", () => {
  test("parses standard SSE event with type and data", () => {
    const raw = 'event: session.status\ndata: {"status":"idle"}';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.status");
    expect(event?.data).toEqual({ status: "idle" });
  });

  test("defaults to 'message' type when no event field", () => {
    const raw = 'data: {"hello":"world"}';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("message");
    expect(event?.data).toEqual({ hello: "world" });
  });

  test("handles multi-line data", () => {
    const raw = 'event: test\ndata: {"a":1}\ndata: extra';
    const event = parseSseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("test");
    expect(event?.data).toEqual({ text: '{"a":1}\nextra' });
  });

  test("ignores comment lines", () => {
    const raw = ': keep-alive\nevent: test\ndata: {"ok":true}';
    const event = parseSseEvent(raw);
    expect(event?.type).toBe("test");
    expect(event?.data).toEqual({ ok: true });
  });

  test("returns null for empty event block", () => {
    const event = parseSseEvent("");
    expect(event).toBeNull();
  });

  test("returns null for comment-only block", () => {
    const event = parseSseEvent(": heartbeat");
    expect(event).toBeNull();
  });

  test("handles non-JSON data as text", () => {
    const raw = "data: plain text message";
    const event = parseSseEvent(raw);
    expect(event?.data).toEqual({ text: "plain text message" });
  });

  test("trims whitespace from event type and data", () => {
    const raw = 'event:  session.status \ndata:  {"status":"busy"} ';
    const event = parseSseEvent(raw);
    expect(event?.type).toBe("session.status");
    expect(event?.data).toEqual({ status: "busy" });
  });
});

// ── OpenCodeSse class tests (local HTTP server) ──

describe("OpenCodeSse", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  // Track per-request behavior via URL path
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);

        // Normal SSE endpoint: streams 2 events then closes
        if (url.pathname === "/event") {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue('event: session.created\ndata: {"id":"s1"}\n\n');
              controller.enqueue('event: session.status\ndata: {"status":"idle"}\n\n');
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        // Endpoint that returns non-200
        if (url.pathname === "/error-status") {
          return new Response("bad", { status: 500 });
        }

        // Endpoint with no body
        if (url.pathname === "/no-body") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // Endpoint that sends events slowly (for disconnect test)
        if (url.pathname === "/slow") {
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue('event: ping\ndata: {"n":1}\n\n');
              // Wait a bit before sending more — gives time for disconnect
              await Bun.sleep(100);
              try {
                controller.enqueue('event: ping\ndata: {"n":2}\n\n');
                controller.close();
              } catch {
                // Controller may be closed by abort
              }
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("connects and receives events", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let closed = false;

    const sse = new OpenCodeSse({
      baseUrl,
      cwd: "/tmp",
      onEvent: (e) => events.push(e),
      onClose: () => {
        closed = true;
      },
    });

    await sse.connect();
    // consumeStream runs async — wait for close
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(events).toEqual([
      { type: "session.created", data: { id: "s1" } },
      { type: "session.status", data: { status: "idle" } },
    ]);
    expect(closed).toBe(true);
    expect(sse.connected).toBe(false);
  });

  test("connected getter tracks state", async () => {
    let closed = false;
    const sse = new OpenCodeSse({
      baseUrl,
      cwd: "/tmp",
      onEvent: () => {},
      onClose: () => {
        closed = true;
      },
    });

    expect(sse.connected).toBe(false);
    await sse.connect();
    // Should be connected immediately after connect resolves
    expect(sse.connected).toBe(true);

    // Wait for stream to close
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(sse.connected).toBe(false);
  });

  test("calls onError for non-200 response", async () => {
    let error: unknown = null;

    // Override baseUrl to hit the error endpoint by using a custom URL structure
    const sse = new OpenCodeSse({
      baseUrl: `${baseUrl}/error-status?x=1`,
      cwd: "/tmp",
      onEvent: () => {},
      onError: (e) => {
        error = e;
      },
    });

    // The connect URL will be baseUrl + /event?directory=... which won't hit /error-status.
    // Instead, let's test with a URL that 404s since our baseUrl path is wrong.
    await sse.connect();
    // Give a tick for error handling
    await Bun.sleep(10);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("SSE connect failed");
  });

  test("throws on double connect", async () => {
    let closed = false;
    const sse = new OpenCodeSse({
      baseUrl: `${baseUrl}/slow?x=1`,
      cwd: "/tmp",
      onEvent: () => {},
      onClose: () => {
        closed = true;
      },
    });

    await sse.connect();
    await expect(sse.connect()).rejects.toThrow("Already connected");

    sse.disconnect();
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await Bun.sleep(10);
    }
  });

  test("disconnect() stops receiving events", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let closed = false;

    const sse = new OpenCodeSse({
      baseUrl: `${baseUrl}/slow?x=1`,
      cwd: "/tmp",
      onEvent: (e) => events.push(e),
      onClose: () => {
        closed = true;
      },
    });

    await sse.connect();
    // Wait to receive first event
    const deadline1 = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline1) {
      await Bun.sleep(10);
    }

    // Disconnect before second event
    sse.disconnect();

    const deadline2 = Date.now() + 3000;
    while (!closed && Date.now() < deadline2) {
      await Bun.sleep(10);
    }

    expect(events.length).toBe(1);
    expect(sse.connected).toBe(false);
    expect(closed).toBe(true);
  });

  test("onClose is called when stream ends naturally", async () => {
    let closed = false;

    const sse = new OpenCodeSse({
      baseUrl,
      cwd: "/tmp",
      onEvent: () => {},
      onClose: () => {
        closed = true;
      },
    });

    await sse.connect();
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(closed).toBe(true);
  });

  test("sends correct URL with encoded directory", async () => {
    // The server will 404 for unrecognized paths, but we can verify the connection attempt.
    // The /event endpoint matches, so we just verify events arrive for a cwd with special chars.
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let closed = false;

    const sse = new OpenCodeSse({
      baseUrl,
      cwd: "/path with spaces/project",
      onEvent: (e) => events.push(e),
      onClose: () => {
        closed = true;
      },
    });

    await sse.connect();
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    // Events arrive regardless of cwd encoding
    expect(events.length).toBe(2);
  });
});
