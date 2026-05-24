/**
 * @rule spawn-mock-kill-resolves-exited
 * @expect 0
 * @path packages/daemon/src/multi-object.spec.ts
 *
 * Two separate objects within proximity — one has a never-resolving exited,
 * the other has a no-op kill. Because they are distinct object literals the
 * rule must NOT fire (fixes #2284).
 */

import { describe, it } from "bun:test";

describe("cross-object — no false positive", () => {
  it("separate objects are fine", () => {
    // Object A — intentional, unrelated to proc lifecycle
    const testTimer = {
      exited: new Promise(() => {}),
      label: "timer",
    };

    // Object B — completely separate
    const mockHandler = {
      kill: () => {},
      name: "handler",
    };

    void testTimer;
    void mockHandler;
  });
});
