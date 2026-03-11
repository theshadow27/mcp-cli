import { describe, expect, test } from "bun:test";
import { bumpVersion, determineBump, parseCommitPrefix } from "./release";

describe("parseCommitPrefix", () => {
  test("parses simple prefix", () => {
    expect(parseCommitPrefix("feat: add feature")).toEqual({ prefix: "feat", breaking: false });
  });

  test("parses scoped prefix", () => {
    expect(parseCommitPrefix("fix(daemon): fix bug")).toEqual({ prefix: "fix", breaking: false });
  });

  test("parses breaking change marker", () => {
    expect(parseCommitPrefix("feat!: breaking change")).toEqual({ prefix: "feat", breaking: true });
  });

  test("parses scoped breaking change", () => {
    expect(parseCommitPrefix("refactor(core)!: rewrite")).toEqual({ prefix: "refactor", breaking: true });
  });

  test("returns null for non-conventional commit", () => {
    expect(parseCommitPrefix("just a message")).toBeNull();
  });

  test("returns null for missing space after colon", () => {
    expect(parseCommitPrefix("feat:no space")).toBeNull();
  });
});

describe("determineBump", () => {
  test("returns major for breaking change marker", () => {
    expect(determineBump(["feat!: break stuff"])).toBe("major");
  });

  test("returns major for BREAKING CHANGE in body", () => {
    expect(determineBump(["feat: add thing"], ["BREAKING CHANGE: removed old API"])).toBe("major");
  });

  test("returns minor for feat prefix", () => {
    expect(determineBump(["feat: new feature"])).toBe("minor");
  });

  test("returns patch for fix prefix", () => {
    expect(determineBump(["fix: patch bug"])).toBe("patch");
  });

  test("returns patch for refactor prefix", () => {
    expect(determineBump(["refactor: clean up"])).toBe("patch");
  });

  test("returns patch for perf prefix", () => {
    expect(determineBump(["perf: optimize"])).toBe("patch");
  });

  test("returns null for test-only commits", () => {
    expect(determineBump(["test: add tests", "docs: update readme"])).toBeNull();
  });

  test("returns null for chore-only commits", () => {
    expect(determineBump(["chore: bump deps", "ci: update workflow"])).toBeNull();
  });

  test("returns null for empty list", () => {
    expect(determineBump([])).toBeNull();
  });

  test("highest bump wins — major over minor", () => {
    expect(determineBump(["feat: add thing", "fix!: breaking fix"])).toBe("major");
  });

  test("highest bump wins — minor over patch", () => {
    expect(determineBump(["fix: patch", "feat: feature"])).toBe("minor");
  });

  test("non-conventional commits count as patch", () => {
    expect(determineBump(["random commit message"])).toBe("patch");
  });

  test("release prefix is skipped", () => {
    expect(determineBump(["release: v1.0.0 [skip ci]"])).toBeNull();
  });
});

describe("bumpVersion", () => {
  test("bumps major", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("bumps minor", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  test("bumps patch", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  test("bumps from 0.x", () => {
    expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
  });

  test("bumps from 0.0.x", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
  });

  test("throws on invalid semver", () => {
    expect(() => bumpVersion("not.a.version", "patch")).toThrow("Invalid semver");
  });

  test("throws on incomplete version", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow("Invalid semver");
  });
});
