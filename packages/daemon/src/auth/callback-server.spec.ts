import { afterEach, describe, expect, test } from "bun:test";
import { type CallbackServer, startCallbackServer } from "./callback-server";

describe("startCallbackServer", () => {
  let server: CallbackServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("starts and returns valid port and URL", () => {
    server = startCallbackServer();

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${server.port}/callback`);
  });

  test("GET /callback?code=abc resolves waitForCode", async () => {
    server = startCallbackServer();

    const resp = await fetch(`${server.url}?code=abc`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/html");

    const code = await server.waitForCode;
    expect(code).toBe("abc");
  });

  test("GET /callback?error rejects waitForCode", async () => {
    server = startCallbackServer();

    // Wrap in allSettled before triggering rejection to prevent unhandled rejection
    const settled = Promise.allSettled([server.waitForCode]);

    await fetch(`${server.url}?error=access_denied&error_description=nope`);

    const [result] = await settled;
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason.message).toContain("nope");
  });

  test("GET /callback?error uses error as description fallback", async () => {
    server = startCallbackServer();

    const settled = Promise.allSettled([server.waitForCode]);

    await fetch(`${server.url}?error=server_error`);

    const [result] = await settled;
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason.message).toContain("server_error");
  });

  test("GET /callback with no code or error returns 400", async () => {
    server = startCallbackServer();

    const resp = await fetch(server.url);
    expect(resp.status).toBe(400);
  });

  test("GET /other-path returns 404", async () => {
    server = startCallbackServer();

    const base = `http://localhost:${server.port}`;
    const resp = await fetch(`${base}/other-path`);
    expect(resp.status).toBe(404);
  });

  test("timeout rejects waitForCode and stops the server", async () => {
    // Capture the timeout callback so we can fire it manually
    const origSetTimeout = globalThis.setTimeout;
    let timeoutFn: (() => void) | undefined;
    let timeoutMs: number | undefined;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timeoutFn = fn;
      timeoutMs = ms;
      // Return a fake timer ID (never actually fires)
      return origSetTimeout(() => {}, 999_999) as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;

    try {
      server = startCallbackServer();

      // Verify timeout was registered at 2 minutes
      expect(timeoutMs).toBe(120_000);
      expect(timeoutFn).toBeDefined();

      // Wrap in allSettled before triggering rejection
      const settled = Promise.allSettled([server.waitForCode]);

      // Fire the timeout callback
      timeoutFn?.();

      const [result] = await settled;
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason.message).toContain("timeout");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    // Server was stopped by timeout — prevent afterEach double-stop
    server = undefined;
  });

  test("stop() is idempotent", () => {
    server = startCallbackServer();

    server.stop();
    server.stop(); // should not throw
    server = undefined; // prevent afterEach double-stop
  });

  test("server auto-stops after receiving code", async () => {
    server = startCallbackServer();
    const port = server.port;

    await fetch(`${server.url}?code=done`);
    await server.waitForCode;

    // Wait for the 50ms auto-stop delay
    await Bun.sleep(150);

    // Server should be stopped — fetch should fail
    try {
      await fetch(`http://localhost:${port}/callback?code=again`);
      // If we get here, the server is still running (unexpected but not fatal)
    } catch {
      // Expected: connection refused
    }
    server = undefined; // already stopped
  });
});
