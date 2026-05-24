import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllRules } from "./rule-loader";

describe("loadAllRules", () => {
  it("loads rules from the default directory", async () => {
    const rules = await loadAllRules();
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });

  it("returns rules sorted by id", async () => {
    const rules = await loadAllRules();
    const ids = rules.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("every rule has required fields", async () => {
    const rules = await loadAllRules();
    for (const r of rules) {
      expect(r.id).toBeString();
      expect(r.kind).toMatch(/^(pattern|check)$/);
      expect(r.scold).toBeString();
      expect(r.guidance).toBeArray();
    }
  });

  it("detects duplicate rule ids", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "dup-a.rule.ts"),
        `export default { id: "dup-test", kind: "pattern", scold: "a", guidance: [], pattern: /x/ };`,
      );
      await writeFile(
        join(tmp, "dup-b.rule.ts"),
        `export default { id: "dup-test", kind: "pattern", scold: "b", guidance: [], pattern: /y/ };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/duplicate rule\.id 'dup-test' in .+ \(already defined in .+\)/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a module without a valid default export", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(join(tmp, "bad.rule.ts"), `export default "not a rule";`);
      await expect(loadAllRules(tmp)).rejects.toThrow(/not a Rule/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a pattern rule missing a RegExp", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "bad.rule.ts"),
        `export default { id: "bad", kind: "pattern", scold: "x", guidance: [] };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/missing a 'pattern' RegExp/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a check rule missing a check function", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "bad.rule.ts"),
        `export default { id: "bad", kind: "check", scold: "x", guidance: [] };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/missing a 'check' function/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a rule with unknown kind", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "bad.rule.ts"),
        `export default { id: "bad", kind: "banana", scold: "x", guidance: [] };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/unknown kind 'banana'/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("returns an empty array for a directory with no rules", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      const rules = await loadAllRules(tmp);
      expect(rules).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });
});
