import { describe, expect, test } from "bun:test";
import { getProvider } from "@mcp-cli/core";
import type { AgentProvider } from "@mcp-cli/core";
import { gateTest, missingFeatures } from "./capability-gate";
import type { GridResult, GridTest } from "./grid-test";

function requireProvider(name: string): AgentProvider {
  const p = getProvider(name);
  if (!p) throw new Error(`provider "${name}" not registered`);
  return p;
}

function stubTest(requires: GridTest["requires"]): GridTest {
  return {
    name: "stub",
    requires,
    run: async () => ({ status: "pass" }),
  };
}

describe("missingFeatures", () => {
  test("returns empty for provider with all required features", () => {
    const claude = requireProvider("claude");
    expect(missingFeatures(claude, ["worktree", "resume", "costTracking"])).toEqual([]);
  });

  test("returns missing features for provider lacking them", () => {
    const codex = requireProvider("codex");
    expect(missingFeatures(codex, ["worktree", "resume"])).toEqual(["worktree", "resume"]);
  });

  test("returns empty when requires is empty", () => {
    const codex = requireProvider("codex");
    expect(missingFeatures(codex, [])).toEqual([]);
  });

  test("partial overlap returns only missing", () => {
    const codex = requireProvider("codex");
    expect(missingFeatures(codex, ["costTracking", "worktree"])).toEqual(["worktree"]);
  });

  test("treats absent keys as missing", () => {
    const mock = requireProvider("mock");
    expect(missingFeatures(mock, ["worktree"])).toEqual(["worktree"]);
  });
});

describe("gateTest", () => {
  test("returns null when test has no requirements", () => {
    const claude = requireProvider("claude");
    expect(gateTest(stubTest([]), claude)).toBeNull();
  });

  test("returns null when provider satisfies all requirements", () => {
    const claude = requireProvider("claude");
    expect(gateTest(stubTest(["worktree", "resume"]), claude)).toBeNull();
  });

  test("returns n/a with reason when provider lacks a feature", () => {
    const codex = requireProvider("codex");
    const result = gateTest(stubTest(["worktree"]), codex);
    expect(result).not.toBeNull();
    const r = result as GridResult & { status: "n/a" };
    expect(r.status).toBe("n/a");
    expect(r.reason).toContain("codex");
    expect(r.reason).toContain("worktree");
  });

  test("lists all missing features in reason", () => {
    const codex = requireProvider("codex");
    const result = gateTest(stubTest(["worktree", "resume", "compactLog"]), codex);
    expect(result).not.toBeNull();
    const r = result as GridResult & { status: "n/a" };
    expect(r.reason).toContain("worktree");
    expect(r.reason).toContain("resume");
    expect(r.reason).toContain("compactLog");
  });

  test("skips for mock provider with minimal features", () => {
    const mock = requireProvider("mock");
    const result = gateTest(stubTest(["costTracking"]), mock);
    expect(result).not.toBeNull();
    expect((result as GridResult & { status: "n/a" }).status).toBe("n/a");
  });
});
