import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestFailureEntry, appendFailures, closeDb, readFailures } from "./test-failure-log";
import { formatOutput, parseArgs } from "./test-failures";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `test-failures-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(overrides: Partial<TestFailureEntry> = {}): TestFailureEntry {
  return {
    timestamp: new Date().toISOString(),
    file: "packages/core/src/foo.spec.ts",
    test: "does the thing",
    worktree: "claude-test",
    branch: "feat/issue-456",
    pr: 456,
    exitCode: 1,
    retryPassed: false,
    duration: 1234,
    error: "Expected 3, received 2",
    ...overrides,
  };
}

describe("test-failures CLI", () => {
  const tmpDirs: string[] = [];
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      closeDb(p);
    }
    dbPaths.length = 0;
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function makeDbPath(): string {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const dbPath = join(dir, "test-failures.db");
    dbPaths.push(dbPath);
    return dbPath;
  }

  describe("parseArgs", () => {
    it("parses --top with valid number", () => {
      const result = parseArgs(["node", "script", "--top", "5"]);
      expect(result.top).toBe(5);
    });

    it("parses --since with valid duration", () => {
      const result = parseArgs(["node", "script", "--since", "7d"]);
      expect(result.since).toBeGreaterThan(0);
    });

    it("parses --file", () => {
      const result = parseArgs(["node", "script", "--file", "foo.spec"]);
      expect(result.file).toBe("foo.spec");
    });

    it("parses --json flag", () => {
      const result = parseArgs(["node", "script", "--json"]);
      expect(result.json).toBe(true);
    });

    it("defaults to null/false when no args", () => {
      const result = parseArgs(["node", "script"]);
      expect(result.top).toBeNull();
      expect(result.since).toBeNull();
      expect(result.file).toBeNull();
      expect(result.json).toBe(false);
    });
  });

  describe("formatOutput", () => {
    it("returns message for empty entries", () => {
      const output = formatOutput([], { top: null, json: false });
      expect(output).toBe("No test failures recorded.");
    });

    it("outputs JSON when json flag set", () => {
      const entries = [makeEntry({ test: "test-a" })];
      const output = formatOutput(entries, { top: null, json: true });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].test).toBe("test-a");
    });

    it("shows top aggregation", () => {
      const entries = [
        makeEntry({ test: "flaky-test", file: "a.spec.ts" }),
        makeEntry({ test: "flaky-test", file: "a.spec.ts" }),
        makeEntry({ test: "other-test", file: "b.spec.ts" }),
      ];
      const output = formatOutput(entries, { top: 2, json: false });
      expect(output).toContain("Top 2 most frequent");
      expect(output).toContain("flaky-test");
      expect(output).toContain("other-test");
    });

    it("shows recent failures in default mode", () => {
      const entries = [makeEntry({ test: "some-test" })];
      const output = formatOutput(entries, { top: null, json: false });
      expect(output).toContain("1 test failure(s) recorded");
      expect(output).toContain("some-test");
    });

    it("truncates to 50 in default mode", () => {
      const entries = Array.from({ length: 60 }, (_, i) => makeEntry({ test: `test-${i}` }));
      const output = formatOutput(entries, { top: null, json: false });
      expect(output).toContain("... and 10 more");
    });
  });

  describe("SQL-pushed filtering", () => {
    it("filters entries by since at database level", () => {
      const dbPath = makeDbPath();
      const old = makeEntry({ test: "old", timestamp: "2020-01-01T00:00:00.000Z" });
      const recent = makeEntry({ test: "recent", timestamp: new Date().toISOString() });

      appendFailures([old, recent], dbPath);

      const filtered = readFailures(dbPath, { since: Date.now() - 86400000 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].test).toBe("recent");
    });

    it("filters entries by file at database level", () => {
      const dbPath = makeDbPath();
      appendFailures([makeEntry({ file: "core/a.spec.ts" }), makeEntry({ file: "daemon/b.spec.ts" })], dbPath);

      const filtered = readFailures(dbPath, { file: "daemon" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].file).toBe("daemon/b.spec.ts");
    });
  });
});
