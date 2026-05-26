/**
 * @rule provider-spec-shape
 * @expect 0
 * @path packages/core/src/agent-provider.spec.ts
 *
 * Per-provider shape assertions and non-enumeration uses of getAllProviders are fine.
 * toEqual([]) (empty/reset check) and toEqual([objRef]) (full object assertion) are also fine.
 * Shape assertions on individual elements obtained via .find are not flagged.
 * test.skip/.only with a non-enumeration assertion is not flagged.
 */

import { expect, test } from "bun:test";

declare function getAllProviders(): { name: string; serverName: string; native: { worktree: boolean } }[];
declare function getAllShims(): { feature: string; allowedPhases: string[] }[];
declare function getProvider(name: string): { name: string; serverName: string; native: { worktree: boolean } } | undefined;
declare function _resetRegistries(): void;

test("shape assertion on individual provider — load-bearing", () => {
  const p = getProvider("claude");
  expect(p).toBeDefined();
  expect(p?.serverName).toBe("_claude");
  expect(p?.native.worktree).toBe(true);
});

test("getAllProviders used for iteration without enumeration assertion", () => {
  for (const p of getAllProviders()) {
    expect(p.name.length).toBeGreaterThan(0);
  }
});

test("getAllProviders for a non-enumeration check", () => {
  const all = getAllProviders();
  expect(all.every((p) => p.serverName.startsWith("_"))).toBe(true);
});

test("toEqual([]) is a reset/empty check — not an enumeration", () => {
  _resetRegistries();
  expect(getAllProviders()).toEqual([]);
  expect(getAllShims()).toEqual([]);
});

test("toEqual([objRef]) asserts full shape — legitimate", () => {
  const shim = { feature: "worktree" as const, appliesTo: () => true };
  expect(getAllShims()).toEqual([shim]);
});

// Shape assertion on an individual element obtained via .find is not a registry
// enumeration — .find is a collection-consuming operation, not collection-preserving.
test("getAllShims().find() then toEqual([literals]) on element property — not an enumeration", () => {
  const shims = getAllShims();
  const worktree = shims.find((s) => s.feature === "worktree");
  expect(worktree?.allowedPhases).toEqual(["impl", "qa", "repair"]);
});

// concise-arrow non-enumeration assertion — not flagged
test("concise arrow — non-enumeration check", () => expect(getAllProviders().every((p) => p.serverName.startsWith("_"))).toBe(true));

// test.skip with a non-enumeration assertion is fine
test.skip("skipped shape assertion — not flagged", () => {
  const p = getProvider("claude");
  expect(p?.serverName).toBe("_claude");
});

// toEqual([literals]) on a value unrelated to the registry is fine even when
// getAllProviders() appears in the same test body for an unrelated purpose
test("registry call for iteration + unrelated toEqual([literals]) on separate value — not flagged", () => {
  const all = getAllProviders();
  const claudeExists = all.some((p) => p.name === "claude");
  expect(claudeExists).toBe(true);
  const phases = ["impl", "qa", "repair"];
  expect(phases).toEqual(["impl", "qa", "repair"]); // not registry-derived
});
