/**
 * @rule spawn-mock-kill-resolves-exited
 * @expect 0
 * @path packages/daemon/src/child-proc.spec.ts
 *
 * kill() properly resolves the deferred backing exited — teardown is instant.
 * Also demonstrates that a bare never-resolving exited WITHOUT a co-located
 * no-op kill does not trigger the rule.
 */

import { describe, expect, it } from "bun:test";

// Clean: kill() settles exited via Promise.withResolvers()
function makeCleanProc() {
  const { promise: exited, resolve } = Promise.withResolvers<number>();
  const kill = () => { resolve(0); };
  return { exited, kill };
}

describe("clean proc mock", () => {
  it("kill resolves exited", async () => {
    const proc = makeCleanProc();
    proc.kill();
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});

// Clean: never-resolving exited but kill DOES resolve it (deferred variable)
function makeDeferredProc() {
  let settle: (code: number) => void;
  const exited = new Promise<number>((r) => { settle = r; });
  const kill = () => { settle(0); };
  return { exited, kill };
}

describe("deferred proc mock", () => {
  it("kill resolves exited via captured resolver", async () => {
    const proc = makeDeferredProc();
    proc.kill();
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
