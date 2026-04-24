import { describe, expect, test } from "bun:test";
import { TEST_PATH_RE, computeSrcChurn } from "./pr-churn";

describe("TEST_PATH_RE", () => {
  test("matches spec files", () => {
    expect(TEST_PATH_RE.test("src/foo.spec.ts")).toBe(true);
  });

  test("matches test files", () => {
    expect(TEST_PATH_RE.test("src/foo.test.ts")).toBe(true);
  });

  test("matches __tests__ directories", () => {
    expect(TEST_PATH_RE.test("src/__tests__/util.ts")).toBe(true);
  });

  test("matches tests/ at root", () => {
    expect(TEST_PATH_RE.test("tests/e2e.ts")).toBe(true);
  });

  test("matches tests/ in subdirectory", () => {
    expect(TEST_PATH_RE.test("packages/foo/tests/bar.ts")).toBe(true);
  });

  test("matches test/fixtures/", () => {
    expect(TEST_PATH_RE.test("test/fixtures/data.json")).toBe(true);
  });

  test("does not match source files", () => {
    expect(TEST_PATH_RE.test("src/index.ts")).toBe(false);
    expect(TEST_PATH_RE.test("src/utils.ts")).toBe(false);
  });
});

describe("computeSrcChurn", () => {
  test("counts only non-test files", () => {
    const files = [
      { path: "src/index.ts", additions: 100, deletions: 20 },
      { path: "src/index.spec.ts", additions: 50, deletions: 10 },
      { path: "src/__tests__/util.ts", additions: 30, deletions: 5 },
      { path: "tests/e2e.ts", additions: 20, deletions: 3 },
      { path: "test/fixtures/data.json", additions: 5, deletions: 1 },
      { path: "src/util.test.ts", additions: 15, deletions: 2 },
    ];
    expect(computeSrcChurn(files)).toBe(120);
  });

  test("returns 0 for all-test diff", () => {
    expect(computeSrcChurn([{ path: "foo.spec.ts", additions: 99, deletions: 1 }])).toBe(0);
  });

  test("returns 0 for empty diff", () => {
    expect(computeSrcChurn([])).toBe(0);
  });

  test("sums additions and deletions for source files", () => {
    const files = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 20, deletions: 3 },
    ];
    expect(computeSrcChurn(files)).toBe(38);
  });
});
