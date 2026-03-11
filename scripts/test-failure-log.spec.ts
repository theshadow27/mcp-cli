import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TestFailureEntry,
  appendFailures,
  closeDb,
  getDbPath,
  getGitContext,
  logTestRun,
  parseTestFailures,
  readFailures,
} from "./test-failure-log";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `test-failure-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("test-failure-log", () => {
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

  describe("appendFailures + readFailures", () => {
    it("writes and reads entries via SQLite", () => {
      const dbPath = makeDbPath();

      const entry1 = makeEntry({ test: "test one" });
      const entry2 = makeEntry({ test: "test two" });

      appendFailures([entry1], dbPath);
      appendFailures([entry2], dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(2);
      expect(entries[0].test).toBe("test one");
      expect(entries[1].test).toBe("test two");
    });

    it("creates parent directory if missing", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const dbPath = join(dir, "nested", "deep", "test-failures.db");
      dbPaths.push(dbPath);

      appendFailures([makeEntry()], dbPath);
      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(1);
    });

    it("returns empty array for missing file", () => {
      const entries = readFailures("/tmp/nonexistent-test-failure-log.db");
      expect(entries).toEqual([]);
    });

    it("preserves all fields through roundtrip", () => {
      const dbPath = makeDbPath();
      const entry = makeEntry({
        pr: null,
        retryPassed: true,
        exitCode: 0,
        duration: 9999,
        error: "some error message",
      });

      appendFailures([entry], dbPath);
      const [result] = readFailures(dbPath);

      expect(result.timestamp).toBe(entry.timestamp);
      expect(result.file).toBe(entry.file);
      expect(result.test).toBe(entry.test);
      expect(result.worktree).toBe(entry.worktree);
      expect(result.branch).toBe(entry.branch);
      expect(result.pr).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.retryPassed).toBe(true);
      expect(result.duration).toBe(9999);
      expect(result.error).toBe("some error message");
    });

    it("handles sequential writes from same process", () => {
      const dbPath = makeDbPath();

      appendFailures([makeEntry({ test: "writer-1" })], dbPath);
      appendFailures([makeEntry({ test: "writer-2" })], dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(2);
      const tests = entries.map((e) => e.test);
      expect(tests).toContain("writer-1");
      expect(tests).toContain("writer-2");
    });
  });

  describe("pruning", () => {
    it("prunes to 10000 entries when over limit", () => {
      const dbPath = makeDbPath();

      // Write 10050 entries in a batch
      const entries: TestFailureEntry[] = [];
      for (let i = 0; i < 10_050; i++) {
        entries.push(makeEntry({ test: `test-${i}` }));
      }
      appendFailures(entries, dbPath);

      const after = readFailures(dbPath);
      expect(after).toHaveLength(10_000);
      // Should keep the most recent (last) entries
      expect(after[0].test).toBe("test-50");
      expect(after[after.length - 1].test).toBe("test-10049");
    });

    it("does nothing when under limit", () => {
      const dbPath = makeDbPath();

      appendFailures([makeEntry(), makeEntry()], dbPath);

      expect(readFailures(dbPath)).toHaveLength(2);
    });
  });

  describe("readFailures with filters", () => {
    it("filters by since timestamp", () => {
      const dbPath = makeDbPath();
      const old = makeEntry({ test: "old", timestamp: "2020-01-01T00:00:00.000Z" });
      const recent = makeEntry({ test: "recent", timestamp: new Date().toISOString() });

      appendFailures([old, recent], dbPath);

      // Filter to last day
      const filtered = readFailures(dbPath, { since: Date.now() - 86400000 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].test).toBe("recent");
    });

    it("filters by file pattern", () => {
      const dbPath = makeDbPath();
      appendFailures(
        [makeEntry({ file: "packages/core/a.spec.ts" }), makeEntry({ file: "packages/daemon/b.spec.ts" })],
        dbPath,
      );

      const filtered = readFailures(dbPath, { file: "daemon" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].file).toBe("packages/daemon/b.spec.ts");
    });
  });

  describe("parseTestFailures", () => {
    it("parses bun test failure output", () => {
      const output = `(fail) packages/core/src/foo.spec.ts:
 ✗ handles concurrent requests [42.00ms]
   error: Expected 3, received 2
 ✓ other test [1.00ms]

(pass) packages/core/src/bar.spec.ts:
 ✓ all good [5.00ms]`;

      const failures = parseTestFailures(output);
      expect(failures).toHaveLength(1);
      expect(failures[0].file).toBe("packages/core/src/foo.spec.ts");
      expect(failures[0].test).toBe("handles concurrent requests");
      expect(failures[0].error).toBe("error: Expected 3, received 2");
    });

    it("handles multiple failures across files", () => {
      const output = `(fail) packages/core/src/a.spec.ts:
 ✗ test alpha [10ms]
   error: boom
 ✗ test beta [20ms]
   error: bang

(fail) packages/daemon/src/b.spec.ts:
 ✗ test gamma [5ms]
   Expected true to be false`;

      const failures = parseTestFailures(output);
      expect(failures).toHaveLength(3);
      expect(failures[0].file).toBe("packages/core/src/a.spec.ts");
      expect(failures[0].test).toBe("test alpha");
      expect(failures[1].test).toBe("test beta");
      expect(failures[2].file).toBe("packages/daemon/src/b.spec.ts");
      expect(failures[2].test).toBe("test gamma");
    });

    it("returns empty array for passing output", () => {
      const output = `(pass) packages/core/src/foo.spec.ts:
 ✓ all good [5.00ms]`;

      expect(parseTestFailures(output)).toEqual([]);
    });
  });

  describe("getGitContext", () => {
    it("returns branch, worktree, and pr", () => {
      const ctx = getGitContext();
      expect(typeof ctx.branch).toBe("string");
      expect(ctx.branch.length).toBeGreaterThan(0);
      expect(typeof ctx.worktree).toBe("string");
      // pr may be null if branch doesn't match issue-N pattern
      expect(ctx.pr === null || typeof ctx.pr === "number").toBe(true);
    });
  });

  describe("getDbPath", () => {
    it("returns path ending with .db", () => {
      const path = getDbPath();
      expect(path).toEndWith("test-failures.db");
    });
  });

  describe("logTestRun", () => {
    it("logs parsed failures from bun test output", () => {
      const dbPath = makeDbPath();

      const output = `(fail) packages/core/src/foo.spec.ts:
 ✗ my failing test [10ms]
   error: Expected true, got false`;

      logTestRun(output, 1, 5000, false, dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].file).toBe("packages/core/src/foo.spec.ts");
      expect(entries[0].test).toBe("my failing test");
      expect(entries[0].exitCode).toBe(1);
      expect(entries[0].retryPassed).toBe(false);
      expect(entries[0].duration).toBe(5000);
      expect(entries[0].error).toBe("error: Expected true, got false");
      expect(entries[0].timestamp).toBeTruthy();
    });

    it("logs a generic entry when no test names are parseable", () => {
      const dbPath = makeDbPath();

      logTestRun("some error output with fail", 1, 3000, false, dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].file).toBe("unknown");
      expect(entries[0].test).toBe("unknown");
    });

    it("skips logging on clean pass (exit 0, no retry)", () => {
      const dbPath = makeDbPath();

      logTestRun("all good", 0, 1000, false, dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(0);
    });

    it("logs when retryPassed is true even with exit 0", () => {
      const dbPath = makeDbPath();

      logTestRun("some flaky failure output", 0, 2000, true, dbPath);

      const entries = readFailures(dbPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].retryPassed).toBe(true);
    });
  });
});
