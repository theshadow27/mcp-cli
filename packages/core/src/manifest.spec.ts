import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_FILENAMES,
  ManifestError,
  findManifest,
  loadManifest,
  parseManifestText,
  validateManifest,
} from "./manifest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcx-manifest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const minimalYaml = `
initial: implement
phases:
  implement:
    source: ./impl.ts
    next: [review]
  review:
    source: ./review.ts
`.trim();

describe("findManifest", () => {
  test("returns null when no manifest present", () => {
    expect(findManifest(dir)).toBeNull();
  });

  test("prefers .mcx.yaml over .mcx.yml and .mcx.json", () => {
    writeFileSync(join(dir, ".mcx.json"), "{}");
    writeFileSync(join(dir, ".mcx.yml"), "x: 1");
    writeFileSync(join(dir, ".mcx.yaml"), "x: 1");
    expect(findManifest(dir)).toBe(join(dir, ".mcx.yaml"));
  });

  test("falls back to .mcx.yml then .mcx.json", () => {
    writeFileSync(join(dir, ".mcx.json"), "{}");
    writeFileSync(join(dir, ".mcx.yml"), "x: 1");
    expect(findManifest(dir)).toBe(join(dir, ".mcx.yml"));
  });

  test("exposes filename preference order", () => {
    expect(MANIFEST_FILENAMES).toEqual([".mcx.yaml", ".mcx.yml", ".mcx.json"]);
  });
});

describe("parseManifestText", () => {
  test("parses JSON", () => {
    expect(parseManifestText('{"a":1}', "x.json")).toEqual({ a: 1 });
  });

  test("parses YAML", () => {
    expect(parseManifestText("a: 1\nb: two\n", "x.yaml")).toEqual({ a: 1, b: "two" });
  });

  test("rejects unknown extension", () => {
    expect(() => parseManifestText("", "x.toml")).toThrow(/unsupported/);
  });
});

describe("validateManifest", () => {
  test("accepts a minimal valid manifest with defaults", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.runsOn).toBe("main");
    expect(m.phases.a.next).toEqual([]);
  });

  test("rejects missing initial", () => {
    expect(() => validateManifest({ phases: { a: { source: "./a.ts" } } }, "/tmp/x")).toThrow(ManifestError);
  });

  test("rejects initial pointing at undeclared phase", () => {
    try {
      validateManifest({ initial: "missing", phases: { a: { source: "./a.ts" } } }, "/tmp/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as Error).message).toContain('initial: "missing"');
    }
  });

  test("rejects next pointing at undeclared phase with actionable message", () => {
    try {
      validateManifest(
        {
          initial: "a",
          phases: {
            a: { source: "./a.ts", next: ["ghost"] },
          },
        },
        "/tmp/x",
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as Error).message).toBe('unknown phase "ghost" referenced in next: of "a"');
    }
  });

  test("rejects empty phases", () => {
    expect(() => validateManifest({ initial: "a", phases: {} }, "/tmp/x")).toThrow(/at least one phase/);
  });

  test("rejects unknown top-level keys (strict)", () => {
    expect(() => validateManifest({ initial: "a", phases: { a: { source: "./a.ts" } }, bogus: 1 }, "/tmp/x")).toThrow(
      ManifestError,
    );
  });

  test("accepts optional worktree and state sections", () => {
    const m = validateManifest(
      {
        initial: "a",
        worktree: { setup: ["echo hi"] },
        state: { ghPr: "number", agentName: "string?" },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.worktree?.setup).toEqual(["echo hi"]);
    expect(m.state?.ghPr).toBe("number");
  });
});

describe("loadManifest", () => {
  test("returns null when no manifest exists", () => {
    expect(loadManifest(dir)).toBeNull();
  });

  test("loads a YAML manifest", () => {
    writeFileSync(join(dir, ".mcx.yaml"), minimalYaml);
    const result = loadManifest(dir);
    expect(result).not.toBeNull();
    expect(result?.manifest.initial).toBe("implement");
    expect(Object.keys(result?.manifest.phases ?? {})).toEqual(["implement", "review"]);
  });

  test("loads a JSON manifest", () => {
    const json = {
      initial: "a",
      phases: { a: { source: "./a.ts", next: [] } },
    };
    writeFileSync(join(dir, ".mcx.json"), JSON.stringify(json));
    const result = loadManifest(dir);
    expect(result?.manifest.initial).toBe("a");
  });

  test("wraps parse errors in ManifestError", () => {
    writeFileSync(join(dir, ".mcx.json"), "{ not json");
    expect(() => loadManifest(dir)).toThrow(ManifestError);
  });

  test("wraps validation errors in ManifestError", () => {
    writeFileSync(join(dir, ".mcx.yaml"), "initial: a\nphases:\n  b:\n    source: ./b.ts\n");
    expect(() => loadManifest(dir)).toThrow(/not a declared phase/);
  });
});
