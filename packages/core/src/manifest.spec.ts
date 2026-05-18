import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RUNS_ON,
  MANIFEST_FILENAMES,
  ManifestError,
  coerceTrackValue,
  detectCycles,
  findManifest,
  getTrackableFields,
  isPhaseInCycle,
  loadManifest,
  parseEnumValues,
  parseManifestText,
  resolveRunsOn,
  validateManifest,
  validateTrackValue,
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

  test("returns null when parent component is a file (ENOTDIR)", () => {
    // dir/file/.mcx.yaml — lstatSync throws ENOTDIR, treated as "not present"
    const filePath = join(dir, "file");
    writeFileSync(filePath, "x");
    expect(findManifest(filePath)).toBeNull();
  });

  test("throws on permission errors (EACCES)", () => {
    // Skip when running as root (chmod is a no-op for root)
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, ".mcx.yaml"), "x: 1");
    chmodSync(locked, 0o000);
    try {
      expect(() => findManifest(locked)).toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
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
    expect(m.version).toBe(1);
    expect(m.runsOn).toBeUndefined();
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

  test("coerces legacy array-of-strings worktree.setup to first element (compat shim)", () => {
    const m = validateManifest(
      {
        initial: "a",
        worktree: { setup: ["./setup.sh"] },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.worktree?.setup).toBe("./setup.sh");
  });

  test("accepts optional worktree and state sections", () => {
    const m = validateManifest(
      {
        initial: "a",
        worktree: { setup: "echo hi", branchPrefix: false },
        state: { gh_pr: "number", agent_name: "string?" },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.worktree?.setup).toBe("echo hi");
    expect(m.worktree?.branchPrefix).toBe(false);
    expect(m.state?.gh_pr).toBe("number");
  });
});

describe("validateManifest constraints", () => {
  test("rejects phase names with spaces or slashes", () => {
    expect(() => validateManifest({ initial: "a b", phases: { "a b": { source: "./a.ts" } } }, "/tmp/x")).toThrow(
      ManifestError,
    );
  });

  test("rejects __proto__ as a phase name", () => {
    expect(() =>
      validateManifest({ initial: "__proto__", phases: { __proto__: { source: "./a.ts" } } }, "/tmp/x"),
    ).toThrow(ManifestError);
  });

  test("rejects state values outside the type DSL", () => {
    expect(() =>
      validateManifest({ initial: "a", state: { foo: "banana" }, phases: { a: { source: "./a.ts" } } }, "/tmp/x"),
    ).toThrow(/state value/);
  });

  test("rejects unreachable phases from initial", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          phases: {
            a: { source: "./a.ts" },
            orphan: { source: "./o.ts" },
          },
        },
        "/tmp/x",
      ),
    ).toThrow(/unreachable/);
  });

  test("allows cycles in the phase graph", () => {
    const m = validateManifest(
      {
        initial: "review",
        phases: {
          review: { source: "./r.ts", next: ["repair"] },
          repair: { source: "./p.ts", next: ["review"] },
        },
      },
      "/tmp/x",
    );
    expect(m.phases.review.next).toEqual(["repair"]);
  });

  test("rejects empty / non-object manifest with clear message", () => {
    expect(() => validateManifest(null, "/tmp/x")).toThrow(/empty or not/);
    expect(() => validateManifest([], "/tmp/x")).toThrow(/empty or not/);
  });

  test("reports all structural errors at once", () => {
    try {
      validateManifest({ phases: {} }, "/tmp/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as Error).message).toContain("manifest validation failed");
      expect((err as Error).message).toContain("initial");
    }
  });

  test("rejects wrong version literal", () => {
    expect(() => validateManifest({ version: 2, initial: "a", phases: { a: { source: "./a.ts" } } }, "/tmp/x")).toThrow(
      ManifestError,
    );
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

describe("resolveRunsOn", () => {
  test("DEFAULT_RUNS_ON is 'main'", () => {
    expect(DEFAULT_RUNS_ON).toBe("main");
  });

  test("returns DEFAULT_RUNS_ON when runsOn is undefined", () => {
    expect(resolveRunsOn({ runsOn: undefined })).toBe(DEFAULT_RUNS_ON);
  });

  test("returns explicit runsOn when set", () => {
    expect(resolveRunsOn({ runsOn: "develop" })).toBe("develop");
  });
});

describe("detectCycles", () => {
  test("returns empty array for a DAG", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: {
          a: { source: "./a.ts", next: ["b"] },
          b: { source: "./b.ts", next: ["c"] },
          c: { source: "./c.ts", next: [] },
        },
      },
      "/tmp/x",
    );
    expect(detectCycles(m)).toEqual([]);
  });

  test("detects a direct 2-node cycle", () => {
    const m = validateManifest(
      {
        initial: "review",
        phases: {
          review: { source: "./r.ts", next: ["repair"] },
          repair: { source: "./p.ts", next: ["review"] },
        },
      },
      "/tmp/x",
    );
    const cycles = detectCycles(m);
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain("review");
    expect(flat).toContain("repair");
  });

  test("detects a longer cycle", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: {
          a: { source: "./a.ts", next: ["b"] },
          b: { source: "./b.ts", next: ["c"] },
          c: { source: "./c.ts", next: ["a"] },
        },
      },
      "/tmp/x",
    );
    const cycles = detectCycles(m);
    expect(cycles.length).toBeGreaterThan(0);
    const cycle = cycles[0];
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });

  test("cycle paths are closed (first === last)", () => {
    const m = validateManifest(
      {
        initial: "review",
        phases: {
          review: { source: "./r.ts", next: ["repair"] },
          repair: { source: "./p.ts", next: ["review", "done"] },
          done: { source: "./d.ts", next: [] },
        },
      },
      "/tmp/x",
    );
    const cycles = detectCycles(m);
    for (const cycle of cycles) {
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    }
  });
});

describe("isPhaseInCycle", () => {
  test("returns false for phases with no outgoing edges", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: {
          a: { source: "./a.ts", next: ["b"] },
          b: { source: "./b.ts", next: [] },
        },
      },
      "/tmp/x",
    );
    expect(isPhaseInCycle(m, "b")).toBe(false);
  });

  test("returns false for a phase in a DAG", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: {
          a: { source: "./a.ts", next: ["b"] },
          b: { source: "./b.ts", next: ["c"] },
          c: { source: "./c.ts", next: [] },
        },
      },
      "/tmp/x",
    );
    expect(isPhaseInCycle(m, "a")).toBe(false);
    expect(isPhaseInCycle(m, "b")).toBe(false);
  });

  test("returns true for phases in a 2-node cycle", () => {
    const m = validateManifest(
      {
        initial: "review",
        phases: {
          review: { source: "./r.ts", next: ["repair"] },
          repair: { source: "./p.ts", next: ["review"] },
        },
      },
      "/tmp/x",
    );
    expect(isPhaseInCycle(m, "review")).toBe(true);
    expect(isPhaseInCycle(m, "repair")).toBe(true);
  });

  test("returns true for phases in a longer cycle", () => {
    const m = validateManifest(
      {
        initial: "a",
        phases: {
          a: { source: "./a.ts", next: ["b"] },
          b: { source: "./b.ts", next: ["c"] },
          c: { source: "./c.ts", next: ["a"] },
        },
      },
      "/tmp/x",
    );
    expect(isPhaseInCycle(m, "a")).toBe(true);
    expect(isPhaseInCycle(m, "b")).toBe(true);
    expect(isPhaseInCycle(m, "c")).toBe(true);
  });

  test("returns false for a phase that can reach a cycle but is not in it", () => {
    const m = validateManifest(
      {
        initial: "start",
        phases: {
          start: { source: "./s.ts", next: ["review"] },
          review: { source: "./r.ts", next: ["repair"] },
          repair: { source: "./p.ts", next: ["review", "done"] },
          done: { source: "./d.ts", next: [] },
        },
      },
      "/tmp/x",
    );
    expect(isPhaseInCycle(m, "start")).toBe(false);
    expect(isPhaseInCycle(m, "done")).toBe(false);
    expect(isPhaseInCycle(m, "review")).toBe(true);
    expect(isPhaseInCycle(m, "repair")).toBe(true);
  });
});

describe("state field object form (#2019)", () => {
  test("accepts object-form state with track flag", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: {
          scrutiny: { type: "enum[low,medium,high]", track: true, default: "medium" },
          session_id: "string?",
        },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(typeof m.state?.scrutiny).toBe("object");
    expect(m.state?.session_id).toBe("string?");
  });

  test("accepts repeatable and required flags", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: {
          bundled_with: { type: "string", track: true, repeatable: true },
          priority: { type: "string", track: true, required: true },
        },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    const field = m.state?.bundled_with;
    expect(typeof field).toBe("object");
    if (typeof field === "object") expect(field.repeatable).toBe(true);
  });

  test("rejects unknown keys in state field object (strict)", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { scrutiny: { type: "enum[low,medium,high]", track: true, bogus: true } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(ManifestError);
  });

  test("rejects invalid type in state field object", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { scrutiny: { type: "banana", track: true } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(ManifestError);
  });

  test("accepts enum type with optional suffix", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: { level: { type: "enum[a,b,c]?", track: true } },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    const field = m.state?.level;
    expect(typeof field).toBe("object");
  });

  test("rejects malformed enum lists (empty values, leading/trailing commas)", () => {
    for (const bad of ["enum[a,,b]", "enum[,a,b]", "enum[a,b,]", "enum[,]", "enum[]"]) {
      expect(() =>
        validateManifest(
          {
            initial: "a",
            state: { level: { type: bad, track: true } },
            phases: { a: { source: "./a.ts" } },
          },
          "/tmp/x",
        ),
      ).toThrow(ManifestError);
    }
  });

  test("rejects trackable state key with hyphens", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { "my-field": { type: "string", track: true } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(/hyphens/);
  });

  test("allows hyphens in non-trackable state keys", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: { "my-field": "string?" },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.state?.["my-field"]).toBe("string?");
  });

  test("rejects invalid enum default at parse time", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { scrutiny: { type: "enum[low,medium,high]", track: true, default: "catastrophic" } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(ManifestError);
  });

  test("rejects non-number default for number type at parse time", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { count: { type: "number", track: true, default: "not-a-number" } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(ManifestError);
  });

  test("accepts valid enum default at parse time", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: { scrutiny: { type: "enum[low,medium,high]", track: true, default: "medium" } },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(typeof m.state?.scrutiny).toBe("object");
  });

  test("rejects reserved trackable field name 'phase'", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { phase: { type: "string", track: true } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(/conflicts with built-in CLI flag/);
  });

  test("rejects reserved trackable field name 'json'", () => {
    expect(() =>
      validateManifest(
        {
          initial: "a",
          state: { json: { type: "string", track: true } },
          phases: { a: { source: "./a.ts" } },
        },
        "/tmp/x",
      ),
    ).toThrow(/conflicts with built-in CLI flag/);
  });

  test("rejects repeatable on non-string type", () => {
    for (const type of ["number", "boolean", "enum[a,b,c]"]) {
      expect(() =>
        validateManifest(
          {
            initial: "a",
            state: { field: { type, track: true, repeatable: true } },
            phases: { a: { source: "./a.ts" } },
          },
          "/tmp/x",
        ),
      ).toThrow(/repeatable.*string/i);
    }
  });

  test("allows repeatable on string type", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: { tags: { type: "string", track: true, repeatable: true } },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(typeof m.state?.tags).toBe("object");
  });

  test("allows reserved name when not trackable", () => {
    const m = validateManifest(
      {
        initial: "a",
        state: { phase: "string?" },
        phases: { a: { source: "./a.ts" } },
      },
      "/tmp/x",
    );
    expect(m.state?.phase).toBe("string?");
  });
});

describe("parseEnumValues", () => {
  test("extracts values from enum type", () => {
    expect(parseEnumValues("enum[low,medium,high]")).toEqual(["low", "medium", "high"]);
  });

  test("extracts values from optional enum type", () => {
    expect(parseEnumValues("enum[a,b]?")).toEqual(["a", "b"]);
  });

  test("returns null for non-enum types", () => {
    expect(parseEnumValues("string")).toBeNull();
    expect(parseEnumValues("number?")).toBeNull();
  });
});

describe("getTrackableFields", () => {
  test("extracts only fields with track: true", () => {
    const fields = getTrackableFields({
      scrutiny: { type: "enum[low,medium,high]", track: true, default: "medium" },
      session_id: "string?",
      bundled_with: { type: "string", track: true, repeatable: true },
    });
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.key)).toEqual(["scrutiny", "bundled_with"]);
  });

  test("returns empty array for undefined state", () => {
    expect(getTrackableFields(undefined)).toEqual([]);
  });

  test("returns empty array when no fields have track: true", () => {
    expect(getTrackableFields({ session_id: "string?" })).toEqual([]);
  });

  test("parses enum field correctly", () => {
    const fields = getTrackableFields({
      level: { type: "enum[low,high]", track: true },
    });
    expect(fields[0].baseType).toBe("enum");
    expect(fields[0].enumValues).toEqual(["low", "high"]);
  });
});

describe("validateTrackValue", () => {
  test("accepts valid enum value", () => {
    const field = getTrackableFields({ s: { type: "enum[a,b,c]", track: true } })[0];
    expect(validateTrackValue(field, "a")).toBeNull();
    expect(validateTrackValue(field, "b")).toBeNull();
  });

  test("rejects invalid enum value", () => {
    const field = getTrackableFields({ s: { type: "enum[a,b,c]", track: true } })[0];
    expect(validateTrackValue(field, "z")).toContain("invalid value");
  });

  test("accepts any string for string type", () => {
    const field = getTrackableFields({ s: { type: "string", track: true } })[0];
    expect(validateTrackValue(field, "anything")).toBeNull();
  });

  test("validates number type", () => {
    const field = getTrackableFields({ n: { type: "number", track: true } })[0];
    expect(validateTrackValue(field, "42")).toBeNull();
    expect(validateTrackValue(field, "abc")).toContain("expected a number");
  });

  test("rejects empty string for number type", () => {
    const field = getTrackableFields({ n: { type: "number", track: true } })[0];
    expect(validateTrackValue(field, "")).toContain("expected a number");
    expect(validateTrackValue(field, "  ")).toContain("expected a number");
  });

  test("validates boolean type", () => {
    const field = getTrackableFields({ b: { type: "boolean", track: true } })[0];
    expect(validateTrackValue(field, "true")).toBeNull();
    expect(validateTrackValue(field, "false")).toBeNull();
    expect(validateTrackValue(field, "yes")).toContain("expected");
  });
});

describe("coerceTrackValue", () => {
  test("coerces number", () => {
    const field = getTrackableFields({ n: { type: "number", track: true } })[0];
    expect(coerceTrackValue(field, "42")).toBe(42);
  });

  test("coerces boolean", () => {
    const field = getTrackableFields({ b: { type: "boolean", track: true } })[0];
    expect(coerceTrackValue(field, "true")).toBe(true);
    expect(coerceTrackValue(field, "false")).toBe(false);
  });

  test("keeps string as-is", () => {
    const field = getTrackableFields({ s: { type: "string", track: true } })[0];
    expect(coerceTrackValue(field, "hello")).toBe("hello");
  });

  test("keeps enum as string", () => {
    const field = getTrackableFields({ e: { type: "enum[a,b]", track: true } })[0];
    expect(coerceTrackValue(field, "a")).toBe("a");
  });
});
