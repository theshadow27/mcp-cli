/**
 * @rule no-hardcoded-test-port
 * @expect 0
 * @path packages/daemon/src/server.spec.ts
 *
 * Zero violations expected.  Covers:
 *   - port: 0  (dynamic — the correct pattern)
 *   - port: N  inside expect()/assertion — not a server bind
 *   - port: N  in a mock struct returned by a helper — not a server bind
 *   - transport-named variable with numeric literal — "transport" ≠ "port" word
 *   - unrelated numeric literals (timeouts, counts)
 */

import { describe, expect, it } from "bun:test";

// Fictional type used to test the assertion-context escape path.
declare function isReadyEvent(v: unknown): boolean;

describe("dynamic-port server", () => {
  it("binds to an OS-assigned port", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const assignedPort = server.port;
    expect(assignedPort).toBeGreaterThan(0);

    const res = await fetch(`http://localhost:${assignedPort}/`);
    expect(await res.text()).toBe("ok");
    server.stop(true);
  });

  it("type-guard assertion with non-zero port field is not a server bind", () => {
    // port: 3000 here is discriminated-union test data, not a socket binding.
    expect(isReadyEvent({ type: "ready", port: 3000 })).toBe(true);
    expect(isReadyEvent({ type: "ready", port: 9999 })).toBe(true);
  });

  it("mock struct with fixed port mirrors URL — not a real bind", () => {
    // OAuth callback mocks must have a port that matches the redirect URI string;
    // port: 0 would be semantically wrong here.
    function makeCallback() {
      return {
        url: "http://localhost:9999/callback",
        port: 9999,
        stop: () => {},
      };
    }
    const cb = makeCallback();
    expect(cb.port).toBe(9999);
  });

  it("transport-named variable with a numeric literal is not a port", () => {
    // "transport" contains the substring "port" but it is not the word "port"
    // after camelCase splitting.
    const transportDelay = 5000;
    const reportInterval = 3000;
    expect(transportDelay).toBeGreaterThan(0);
    expect(reportInterval).toBeGreaterThan(0);
  });

  it("unrelated numeric literals are never flagged", () => {
    const timeoutMs = 5000;
    const retryCount = 3;
    expect(timeoutMs).toBe(5000);
    expect(retryCount).toBe(3);
  });
});
