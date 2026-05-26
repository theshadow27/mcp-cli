/**
 * @rule provider-spec-shape
 * @expect 0
 * @path packages/core/src/agent-provider.spec.ts
 *
 * Per-provider shape assertions and non-enumeration uses of getAllProviders are fine.
 * toEqual([]) (empty/reset check) and toEqual([objRef]) (full object assertion) are also fine.
 */

import { expect, test } from "bun:test";

declare function getAllProviders(): { name: string; serverName: string; native: { worktree: boolean } }[];
declare function getAllShims(): { feature: string }[];
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

test("getAllShims for a non-enumeration check", () => {
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
