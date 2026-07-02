import { describe, expect, it } from "bun:test";
import { resolveEmbeddedWorker } from "./worker-path";

/** Fake resolver: succeeds for the given embedded specifiers, throws otherwise. */
function fakeResolve(embedded: Record<string, string>): (s: string) => string {
  return (s) => {
    const hit = embedded[s];
    if (!hit) throw new Error(`Cannot find module '${s}'`);
    return hit;
  };
}

describe("resolveEmbeddedWorker", () => {
  it("resolves a worker embedded flat (pinned --root layout)", () => {
    const resolve = fakeResolve({ "./acp-session-worker.js": "/$bunfs/root/acp-session-worker.js" });
    expect(resolveEmbeddedWorker("acp-session-worker.ts", resolve)).toBe("/$bunfs/root/acp-session-worker.js");
  });

  it("resolves a worker embedded nested (≥9-entrypoint layout, #2796)", () => {
    const resolve = fakeResolve({
      "./packages/daemon/src/site-worker.js": "/$bunfs/root/packages/daemon/src/site-worker.js",
    });
    expect(resolveEmbeddedWorker("site-worker.ts", resolve)).toBe("/$bunfs/root/packages/daemon/src/site-worker.js");
  });

  it("prefers the embedded module over a stray real-filesystem hit", () => {
    // A bare candidate can resolve to a disk file; only /$bunfs/ results count.
    const resolve = fakeResolve({
      "./monitor-executor.js": "/home/user/monitor-executor.js",
      "./packages/daemon/src/monitor-executor.js": "/$bunfs/root/packages/daemon/src/monitor-executor.js",
    });
    expect(resolveEmbeddedWorker("monitor-executor.ts", resolve)).toBe(
      "/$bunfs/root/packages/daemon/src/monitor-executor.js",
    );
  });

  it("throws a helpful error listing the tried candidates when unresolved", () => {
    const resolve = fakeResolve({});
    expect(() => resolveEmbeddedWorker("missing-worker.ts", resolve)).toThrow(
      /Worker not embedded: missing-worker\.ts.*\.\/missing-worker\.js.*daemon-workers\.ts/s,
    );
  });

  it("rejects a non-embedded (real-filesystem-only) resolution", () => {
    const resolve = fakeResolve({ "./alias-executor.js": "/real/disk/alias-executor.js" });
    expect(() => resolveEmbeddedWorker("alias-executor.ts", resolve)).toThrow(/not embedded/);
  });
});
