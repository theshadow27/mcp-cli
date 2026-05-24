/**
 * @rule no-hardcoded-test-port
 * @expect 0
 * @path packages/daemon/src/server.spec.ts
 *
 * Dynamic port allocation (port: 0) is the correct pattern.
 * Reading the assigned port back from the server handle is fine.
 * Non-port numeric literals must not be flagged.
 */

import { describe, it, expect, afterAll } from "bun:test";

describe("dynamic-port server", () => {
  it("binds to an OS-assigned port", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const assignedPort = server.port;
    expect(assignedPort).toBeGreaterThan(0);

    const res = await fetch(`http://localhost:${assignedPort}/`);
    expect(await res.text()).toBe("ok");
    server.stop(true);
  });

  it("treats timeout constants as unrelated numbers", () => {
    const timeoutMs = 5000;
    const retryCount = 3;
    expect(timeoutMs).toBe(5000);
    expect(retryCount).toBe(3);
  });
});
