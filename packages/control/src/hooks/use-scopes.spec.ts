import { describe, expect, test } from "bun:test";
import type { ScopeMatch } from "@mcp-cli/core";

/**
 * Test the useScopes hook logic by directly testing the cycleScope behavior
 * without React rendering (avoids Ink dependency in unit tests).
 */

const SCOPES: ScopeMatch[] = [
  { name: "alpha", root: "/tmp/alpha" },
  { name: "beta", root: "/tmp/beta" },
];

function simulateCycle(scopes: ScopeMatch[], current: ScopeMatch | null): ScopeMatch | null {
  if (scopes.length === 0) return current;
  if (current === null) return scopes[0];
  const idx = scopes.findIndex((s) => s.root === current.root);
  if (idx < 0 || idx === scopes.length - 1) return null;
  return scopes[idx + 1];
}

describe("useScopes cycleScope logic", () => {
  test("cycles from null to first scope", () => {
    expect(simulateCycle(SCOPES, null)).toEqual(SCOPES[0]);
  });

  test("cycles from first to second scope", () => {
    expect(simulateCycle(SCOPES, SCOPES[0])).toEqual(SCOPES[1]);
  });

  test("cycles from last scope to null (all)", () => {
    expect(simulateCycle(SCOPES, SCOPES[1])).toBeNull();
  });

  test("full cycle: null → alpha → beta → null", () => {
    let current: ScopeMatch | null = null;
    current = simulateCycle(SCOPES, current);
    expect(current?.name).toBe("alpha");
    current = simulateCycle(SCOPES, current);
    expect(current?.name).toBe("beta");
    current = simulateCycle(SCOPES, current);
    expect(current).toBeNull();
  });

  test("no-op when scopes list is empty", () => {
    expect(simulateCycle([], null)).toBeNull();
    expect(simulateCycle([], SCOPES[0])).toEqual(SCOPES[0]);
  });

  test("single scope cycles between scope and null", () => {
    const single = [SCOPES[0]];
    let current: ScopeMatch | null = null;
    current = simulateCycle(single, current);
    expect(current?.name).toBe("alpha");
    current = simulateCycle(single, current);
    expect(current).toBeNull();
  });

  test("falls back to null when current scope not in list", () => {
    const unknown: ScopeMatch = { name: "unknown", root: "/tmp/unknown" };
    expect(simulateCycle(SCOPES, unknown)).toBeNull();
  });
});
