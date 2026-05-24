import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { loadAllRules } from "./rule-loader";

const VALID_RULE = `export default { id: "test", kind: "pattern", scold: "bad", guidance: ["fix it"], pattern: /x/ };`;

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
      await expect(loadAllRules(tmp)).rejects.toThrow(/failed validation/);
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
      await expect(loadAllRules(tmp)).rejects.toThrow(/failed validation/);
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
      await expect(loadAllRules(tmp)).rejects.toThrow(/failed validation/);
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

  it("loads rules from nested subdirectories", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(join(tmp, "top.rule.ts"), VALID_RULE.replace('"test"', '"top"'));
      const sub = join(tmp, "subdir");
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, "nested.rule.ts"), VALID_RULE.replace('"test"', '"nested"'));
      const rules = await loadAllRules(tmp);
      const ids = rules.map((r) => r.id);
      expect(ids).toContain("top");
      expect(ids).toContain("nested");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("loads .rule.tsx files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "tsx-rule.rule.tsx"),
        `export default { id: "tsx-rule", kind: "pattern", scold: "bad", guidance: ["fix"], pattern: /x/ };`,
      );
      const rules = await loadAllRules(tmp);
      expect(rules.map((r) => r.id)).toContain("tsx-rule");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a rule missing scold", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "bad.rule.ts"),
        `export default { id: "bad", kind: "pattern", guidance: [], pattern: /x/ };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/failed validation/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects a rule missing guidance", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "bad.rule.ts"),
        `export default { id: "bad", kind: "pattern", scold: "x", pattern: /x/ };`,
      );
      await expect(loadAllRules(tmp)).rejects.toThrow(/failed validation/);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("resolves a relative rulesDir to absolute before importing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(join(tmp, "rel.rule.ts"), VALID_RULE.replace('"test"', '"rel"'));
      const relPath = relative(process.cwd(), tmp);
      const rules = await loadAllRules(relPath);
      expect(rules.map((r) => r.id)).toContain("rel");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("returns deeply frozen rule objects", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rule-loader-"));
    try {
      await writeFile(
        join(tmp, "frz.rule.ts"),
        `export default { id: "frz", kind: "pattern", scold: "bad", guidance: ["fix it"], pattern: /x/, except: ["ok"] };`,
      );
      const rules = await loadAllRules(tmp);
      expect(rules.length).toBe(1);
      expect(Object.isFrozen(rules)).toBe(true);
      expect(Object.isFrozen(rules[0])).toBe(true);
      expect(Object.isFrozen(rules[0].guidance)).toBe(true);
      const pr = rules[0] as { except?: readonly string[] };
      expect(Object.isFrozen(pr.except)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });
});
