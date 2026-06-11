import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenCodeClient } from "./opencode-client";

describe("OpenCodeClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  let client: OpenCodeClient;
  // Records the last request the harness saw, so tests can assert method/path/body.
  let lastRequest: { method: string; path: string; body: unknown } | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
        lastRequest = { method: req.method, path, body };

        const json = (value: unknown) =>
          new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

        // POST /session — create
        if (req.method === "POST" && path === "/session") {
          return json({ id: "sess-1", status: "idle" });
        }
        // GET /session — list
        if (req.method === "GET" && path === "/session") {
          return json([
            { id: "sess-1", status: "idle" },
            { id: "sess-2", status: "busy" },
          ]);
        }
        // GET /session/:id — details
        if (req.method === "GET" && path === "/session/sess-1") {
          return json({ id: "sess-1", status: "busy" });
        }
        // POST /session/:id/message — prompt
        if (req.method === "POST" && path === "/session/sess-1/message") {
          return json({ id: "msg-1", role: "assistant", parts: [{ type: "text", text: "hi" }] });
        }
        // POST /session/:id/abort — empty 200 (no JSON content-type)
        if (req.method === "POST" && path === "/session/sess-1/abort") {
          return new Response(null, { status: 200 });
        }
        // POST /permission/:id/reply
        if (req.method === "POST" && path === "/permission/req-1/reply") {
          return new Response(null, { status: 200 });
        }
        // Error endpoints
        if (path === "/session/boom") {
          return new Response("kaboom", { status: 500, statusText: "Internal Server Error" });
        }
        return new Response("not found", { status: 404, statusText: "Not Found" });
      },
    });
    client = new OpenCodeClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(() => {
    server.stop(true);
  });

  test("createSession posts to /session and returns the session", async () => {
    const session = await client.createSession({ cwd: "/tmp/work" });
    expect(session).toEqual({ id: "sess-1", status: "idle" });
    expect(lastRequest).toMatchObject({ method: "POST", path: "/session", body: { cwd: "/tmp/work" } });
  });

  test("createSession works with no opts", async () => {
    const session = await client.createSession();
    expect(session.id).toBe("sess-1");
    expect(lastRequest?.body).toEqual({ cwd: undefined });
  });

  test("sendPrompt posts content and returns the assistant message", async () => {
    const msg = await client.sendPrompt("sess-1", "hello");
    expect(msg).toMatchObject({ id: "msg-1", role: "assistant" });
    expect(lastRequest).toMatchObject({
      method: "POST",
      path: "/session/sess-1/message",
      body: { content: "hello" },
    });
  });

  test("sendPromptAsync sets the async flag and resolves void", async () => {
    await expect(client.sendPromptAsync("sess-1", "later")).resolves.toBeUndefined();
    expect(lastRequest?.body).toEqual({ content: "later", async: true });
  });

  test("abortSession posts to /abort and tolerates a non-JSON empty body", async () => {
    await expect(client.abortSession("sess-1")).resolves.toBeUndefined();
    expect(lastRequest).toMatchObject({ method: "POST", path: "/session/sess-1/abort" });
  });

  test("getSession reads details via GET", async () => {
    const session = await client.getSession("sess-1");
    expect(session).toEqual({ id: "sess-1", status: "busy" });
    expect(lastRequest).toMatchObject({ method: "GET", path: "/session/sess-1" });
  });

  test("listSessions returns the array", async () => {
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toEqual({ id: "sess-2", status: "busy" });
    expect(lastRequest).toMatchObject({ method: "GET", path: "/session" });
  });

  test("replyPermission posts the decision", async () => {
    await expect(client.replyPermission("req-1", "always")).resolves.toBeUndefined();
    expect(lastRequest).toMatchObject({
      method: "POST",
      path: "/permission/req-1/reply",
      body: { decision: "always" },
    });
  });

  test("a non-ok GET throws with status, statusText, and body", async () => {
    await expect(client.getSession("boom")).rejects.toThrow(/OpenCode API 500: Internal Server Error kaboom/);
  });

  test("a non-ok POST throws with status, statusText, and body", async () => {
    // /session/missing/abort -> 404 from the catch-all
    await expect(client.abortSession("missing")).rejects.toThrow(/OpenCode API 404: Not Found not found/);
  });
});
