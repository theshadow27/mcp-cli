/**
 * @rule provider-spec-shape
 * @expect 5
 * @path packages/core/src/agent-provider.spec.ts
 *
 * Registry enumeration assertions must be flagged.
 */

import { expect, test } from "bun:test";

declare function getAllProviders(): { name: string }[];
declare function getAllShims(): { feature: string }[];

test("count assertion — pure bump on new provider", () => {
  expect(getAllProviders()).toHaveLength(8);
});

test("name list assertion — still a count by another name", () => {
  const names = getAllProviders().map((p) => p.name).sort();
  expect(names).toEqual(["acp", "claude", "codex", "copilot", "gemini", "grok", "mock", "opencode"]);
});

// test.skip does not exempt the assertion from the rule
test.skip("skipped count assertion — still flagged", () => {
  expect(getAllProviders()).toHaveLength(8);
});

// .length + toBe is equivalent to toHaveLength — both are count assertions
test(".length + toBe — enumeration via property access", () => {
  expect(getAllProviders().length).toBe(8);
});

// .length on a tracked variable + toEqual(N) is the same violation
test(".length on a derived variable + toEqual — enumeration", () => {
  const all = getAllProviders();
  expect(all.length).toEqual(8);
});
