// Guards the build.ts worker-smoke failure detector (#2800): it must fire on a
// worker-backed server failure or a ModuleNotFound worker-resolution regression,
// and must NOT fire on the non-worker servers (metrics/tracing/mail/work-items)
// that log the identical "Failed to start ... server" phrase — those would
// false-fail the required `build` gate on a transient init hiccup.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKER_SMOKE_FAILURE_PATTERN } from "./smoke-failure-pattern";

// Worker-backed servers this smoke asserts (see build.ts `expected` list).
const WORKER_SERVERS = ["Claude session", "Codex session", "ACP session", "OpenCode session", "mock", "site"];
// Non-worker servers that log the same phrase but must not trip the detector.
const NON_WORKER_SERVERS = ["metrics", "tracing", "mail", "work items"];

describe("WORKER_SMOKE_FAILURE_PATTERN", () => {
  it("matches ModuleNotFound (the direct worker-resolution regression signal)", () => {
    expect(WORKER_SMOKE_FAILURE_PATTERN.test('ModuleNotFound resolving "./acp-session-worker" (entry point)')).toBe(
      true,
    );
  });

  it("matches a startup failure of every worker-backed server", () => {
    for (const name of WORKER_SERVERS) {
      const line = `[mcpd] Failed to start ${name} server: Error: boom`;
      expect(WORKER_SMOKE_FAILURE_PATTERN.test(line)).toBe(true);
    }
  });

  it("does NOT match a startup failure of a non-worker server", () => {
    for (const name of NON_WORKER_SERVERS) {
      const line = `[mcpd] Failed to start ${name} server: Error: sqlite blip`;
      expect(WORKER_SMOKE_FAILURE_PATTERN.test(line)).toBe(false);
    }
  });

  it("does not match a clean daemon startup log", () => {
    expect(WORKER_SMOKE_FAILURE_PATTERN.test("[mcpd] Claude session server started")).toBe(false);
  });

  // Drift guard: the servers the daemon actually logs "Failed to start ... server"
  // for must stay partitioned by the pattern exactly as classified above. If a
  // new server is added, this fails until it's classified in one bucket.
  it("classifies every daemon 'Failed to start' log site", () => {
    const src = readFileSync(resolve("packages/daemon/src/index.ts"), "utf-8");
    const names = [...src.matchAll(/Failed to start (.+?) server:/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const known = new Set([...WORKER_SERVERS, ...NON_WORKER_SERVERS, "alias"]);
    const unknown = names.filter((n) => !known.has(n));
    expect(unknown).toEqual([]);
  });
});
