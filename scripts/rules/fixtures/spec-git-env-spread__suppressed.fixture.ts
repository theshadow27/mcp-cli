/**
 * @rule spec-git-env-spread
 * @expect 0
 * @path packages/daemon/src/claude-session/ws-server-tls.spec.ts
 *
 * A non-git subprocess (TLS WebSocket client) with dotw-ignore suppression.
 * The spread is safe here because bun never calls git internally — documented.
 */

import { describe, test } from "bun:test";

describe("tls (suppressed)", () => {
  test("spawn bun TLS client — not a git subprocess", () => {
    // dotw-ignore spec-git-env-spread: spawning a bun TLS client, not a git subprocess
    const proc = Bun.spawn({ cmd: ["bun", "client.ts"], env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    proc.kill();
  });
});
