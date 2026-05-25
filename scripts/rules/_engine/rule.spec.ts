import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./file-loader";
import type { CheckRule, PatternRule } from "./rule";
import { MissingAnchorError, evaluateRule, validateAnchors } from "./rule";

function makeFile(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    path: "/fake/example.ts",
    relPath: "packages/daemon/src/example.ts",
    content: "const x = 1;\n",
    pkg: "packages/daemon",
    isTest: false,
    ...overrides,
  };
}

function makeFileMap(files: FileMeta[]): Map<string, FileMeta> {
  return new Map(files.map((f) => [f.path, f]));
}

const emptyFiles = new Map<string, FileMeta>();

describe("evaluateRule appliesToTests filtering", () => {
  const checkRule: CheckRule = {
    id: "test-rule",
    kind: "check",
    scold: "test",
    guidance: [],
    check({ file, violated }) {
      violated(1, 1, file.content.split("\n")[0]);
    },
  };

  const patternRule: PatternRule = {
    id: "test-pattern",
    kind: "pattern",
    scold: "test",
    guidance: [],
    pattern: /const/,
  };

  describe("appliesToTests omitted (default — runs on all files)", () => {
    it("runs on production files", () => {
      const v = evaluateRule(checkRule, makeFile({ isTest: false }), emptyFiles);
      expect(v).toHaveLength(1);
    });

    it("runs on test files", () => {
      const v = evaluateRule(checkRule, makeFile({ isTest: true }), emptyFiles);
      expect(v).toHaveLength(1);
    });
  });

  describe("appliesToTests: false (production-only)", () => {
    const prodOnly: CheckRule = { ...checkRule, appliesToTests: false };

    it("runs on production files", () => {
      const v = evaluateRule(prodOnly, makeFile({ isTest: false }), emptyFiles);
      expect(v).toHaveLength(1);
    });

    it("skips test files", () => {
      const v = evaluateRule(prodOnly, makeFile({ isTest: true }), emptyFiles);
      expect(v).toHaveLength(0);
    });
  });

  describe("appliesToTests: true (test-only)", () => {
    const testOnly: CheckRule = { ...checkRule, appliesToTests: true };
    const testOnlyPattern: PatternRule = { ...patternRule, appliesToTests: true };

    it("skips production files (check rule)", () => {
      const v = evaluateRule(testOnly, makeFile({ isTest: false }), emptyFiles);
      expect(v).toHaveLength(0);
    });

    it("runs on test files (check rule)", () => {
      const v = evaluateRule(testOnly, makeFile({ isTest: true }), emptyFiles);
      expect(v).toHaveLength(1);
    });

    it("skips production files (pattern rule)", () => {
      const v = evaluateRule(testOnlyPattern, makeFile({ isTest: false }), emptyFiles);
      expect(v).toHaveLength(0);
    });

    it("runs on test files (pattern rule)", () => {
      const v = evaluateRule(testOnlyPattern, makeFile({ isTest: true }), emptyFiles);
      expect(v).toHaveLength(1);
    });
  });
});

describe("validateAnchors", () => {
  const anchoredRule: CheckRule = {
    id: "needs-foo-and-bar",
    kind: "check",
    scold: "x",
    guidance: [],
    anchors: ["packages/foo/src/foo.ts", "packages/bar/src/bar.ts"],
    check() {},
  };

  it("does nothing for a rule with no anchors", () => {
    const rule: CheckRule = { id: "no-anchors", kind: "check", scold: "x", guidance: [], check() {} };
    expect(() => validateAnchors(rule, emptyFiles)).not.toThrow();
  });

  it("does nothing when every declared anchor is present", () => {
    const files = makeFileMap([
      makeFile({ path: "/abs/foo.ts", relPath: "packages/foo/src/foo.ts" }),
      makeFile({ path: "/abs/bar.ts", relPath: "packages/bar/src/bar.ts" }),
    ]);
    expect(() => validateAnchors(anchoredRule, files)).not.toThrow();
  });

  it("throws MissingAnchorError when an anchor is absent", () => {
    const files = makeFileMap([makeFile({ path: "/abs/foo.ts", relPath: "packages/foo/src/foo.ts" })]);
    expect(() => validateAnchors(anchoredRule, files)).toThrow(MissingAnchorError);
    try {
      validateAnchors(anchoredRule, files);
    } catch (e) {
      expect(e).toBeInstanceOf(MissingAnchorError);
      const err = e as MissingAnchorError;
      expect(err.ruleId).toBe("needs-foo-and-bar");
      expect(err.missing).toEqual(["packages/bar/src/bar.ts"]);
      expect(err.message).toContain("needs-foo-and-bar");
      expect(err.message).toContain("packages/bar/src/bar.ts");
      expect(err.message).toContain("silently pass");
    }
  });

  it("reports all missing anchors, not just the first", () => {
    expect(() => validateAnchors(anchoredRule, emptyFiles)).toThrow(MissingAnchorError);
    try {
      validateAnchors(anchoredRule, emptyFiles);
    } catch (e) {
      const err = e as MissingAnchorError;
      expect(err.missing).toEqual(["packages/foo/src/foo.ts", "packages/bar/src/bar.ts"]);
    }
  });

  it("treats an empty anchors array as no-anchors", () => {
    const rule: CheckRule = { id: "empty", kind: "check", scold: "x", guidance: [], anchors: [], check() {} };
    expect(() => validateAnchors(rule, emptyFiles)).not.toThrow();
  });
});

describe("evaluateRule onChecked callback", () => {
  it("invokes onChecked once per call into rule.check that signals work", () => {
    let count = 0;
    const rule: CheckRule = {
      id: "inspector",
      kind: "check",
      scold: "x",
      guidance: [],
      check(ctx) {
        ctx.checked();
        ctx.checked();
      },
    };
    evaluateRule(rule, makeFile(), emptyFiles, { onChecked: () => count++ });
    expect(count).toBe(2);
  });

  it("does not invoke onChecked when the rule early-returns without calling ctx.checked", () => {
    let count = 0;
    const rule: CheckRule = {
      id: "silent",
      kind: "check",
      scold: "x",
      guidance: [],
      check() {
        return;
      },
    };
    evaluateRule(rule, makeFile(), emptyFiles, { onChecked: () => count++ });
    expect(count).toBe(0);
  });

  it("invokes onChecked once for every pattern-rule scan (always inspects)", () => {
    let count = 0;
    const rule: PatternRule = {
      id: "always-scans",
      kind: "pattern",
      scold: "x",
      guidance: [],
      pattern: /nothing-to-match-here/,
    };
    evaluateRule(rule, makeFile(), emptyFiles, { onChecked: () => count++ });
    expect(count).toBe(1);
  });

  it("treats omitted options as a no-op (no throw, no side effect)", () => {
    const rule: CheckRule = {
      id: "no-opts",
      kind: "check",
      scold: "x",
      guidance: [],
      check(ctx) {
        ctx.checked();
      },
    };
    expect(() => evaluateRule(rule, makeFile(), emptyFiles)).not.toThrow();
  });
});
