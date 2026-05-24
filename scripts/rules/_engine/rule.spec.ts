import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./file-loader";
import type { CheckRule, PatternRule } from "./rule";
import { evaluateRule } from "./rule";

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
