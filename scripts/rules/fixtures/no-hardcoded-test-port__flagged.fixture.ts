/**
 * @rule no-hardcoded-test-port
 * @expect 2
 * @path packages/daemon/src/server.spec.ts
 *
 * Two violations:
 *   1. `serve({ port: 19275 })` — hardcoded port in object literal property.
 *   2. `const wsPort = 8080`   — port-named variable with a numeric literal.
 */

import { describe, it } from "bun:test";

describe("hardcoded ports", () => {
  it("uses a hardcoded port in serve config", () => {
    const server = Bun.serve({ port: 19275, fetch: () => new Response("ok") });
    server.stop(true);
  });

  it("stores a hardcoded port in a variable", () => {
    const wsPort = 8080;
    void wsPort;
  });
});
