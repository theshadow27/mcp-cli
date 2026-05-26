/**
 * @rule provider-spec-shape
 * @expect 2
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
