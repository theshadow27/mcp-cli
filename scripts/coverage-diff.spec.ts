import { describe, expect, test } from "bun:test";
import { coveragePathInDiff } from "./coverage-diff";

describe("coveragePathInDiff", () => {
  test("returns true when changed is null (full enforcement)", () => {
    expect(coveragePathInDiff("packages/core/src/config.ts", null)).toBe(true);
  });

  test("exact match", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(true);
  });

  test("no match for unrelated file", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/daemon/src/server-pool.ts", changed)).toBe(false);
  });

  test("suffix match — coverage path is shorter", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("core/src/config.ts", changed)).toBe(true);
  });

  test("suffix match — changed path is shorter", () => {
    const changed = new Set(["src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(true);
  });

  test("empty changed set means nothing is in diff", () => {
    const changed = new Set<string>();
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(false);
  });

  test("multiple changed files — match on second", () => {
    const changed = new Set(["scripts/am-i-done.ts", "packages/core/src/env.ts"]);
    expect(coveragePathInDiff("packages/core/src/env.ts", changed)).toBe(true);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(false);
  });

  test("does not false-positive on partial filename overlap", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config-display.ts", changed)).toBe(false);
  });
});
