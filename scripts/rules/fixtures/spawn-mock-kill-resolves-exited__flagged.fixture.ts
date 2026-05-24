/**
 * @rule spawn-mock-kill-resolves-exited
 * @expect 1
 * @path packages/daemon/src/child-proc.spec.ts
 *
 * exited is a never-resolving promise AND kill is a no-op — exactly the
 * pattern that causes test teardown to hang for ~5–7 s per test.
 */

import { describe, it } from "bun:test";

describe("bad proc mock — teardown will hang", () => {
  it("server stops cleanly", async () => {
    const fakeProc = { exited: new Promise(() => {}), kill: () => {} };
    void fakeProc;
  });
});
