import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TestFailureEntry,
  appendFailures,
  getGitContext,
  getLogPath,
  logTestRun,
  parseTestFailures,
  readFailures,
  rotateIfNeeded,
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

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe("appendFailures + readFailures", () => {
    it("writes and reads JSONL entries", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      const entry1 = makeEntry({ test: "test one" });
      const entry2 = makeEntry({ test: "test two" });

      appendFailures([entry1], logPath);
      appendFailures([entry2], logPath);

      const entries = readFailures(logPath);
      expect(entries).toHaveLength(2);
      expect(entries[0].test).toBe("test one");
      expect(entries[1].test).toBe("test two");
    });

    it("creates parent directory if missing", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "nested", "deep", "test-failures.log");

      appendFailures([makeEntry()], logPath);
      const entries = readFailures(logPath);
      expect(entries).toHaveLength(1);
    });

    it("returns empty array for missing file", () => {
      const entries = readFailures("/tmp/nonexistent-test-failure-log.log");
      expect(entries).toEqual([]);
    });
  });

  describe("rotateIfNeeded", () => {
    it("trims to 10000 entries when over limit", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      // Write 10050 entries
      const lines: string[] = [];
      for (let i = 0; i < 10_050; i++) {
        lines.push(JSON.stringify(makeEntry({ test: `test-${i}` })));
      }
      writeFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

      rotateIfNeeded(logPath);

      const after = readFailures(logPath);
      expect(after).toHaveLength(10_000);
      // Should keep the most recent (last) entries
      expect(after[0].test).toBe("test-50");
      expect(after[after.length - 1].test).toBe("test-10049");
    });

    it("does nothing when under limit", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      appendFailures([makeEntry(), makeEntry()], logPath);
      rotateIfNeeded(logPath);

      expect(readFailures(logPath)).toHaveLength(2);
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

    it("extracts PR number from issue branch names", () => {
      // We're on feat/issue-456-test-failure-logging
      const ctx = getGitContext();
      if (ctx.branch.includes("issue-456")) {
        expect(ctx.pr).toBe(456);
      }
    });
  });

  describe("getLogPath", () => {
    it("returns path under MCP_CLI_DIR", () => {
      const path = getLogPath();
      expect(path).toEndWith("test-failures.log");
    });
  });

  describe("logTestRun", () => {
    it("logs parsed failures from bun test output", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      const output = `(fail) packages/core/src/foo.spec.ts:
 ✗ my failing test [10ms]
   error: Expected true, got false`;

      logTestRun(output, 1, 5000, false, logPath);

      const entries = readFailures(logPath);
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
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      logTestRun("some error output with fail", 1, 3000, false, logPath);

      const entries = readFailures(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].file).toBe("unknown");
      expect(entries[0].test).toBe("unknown");
    });

    it("skips logging on clean pass (exit 0, no retry)", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      logTestRun("all good", 0, 1000, false, logPath);

      const entries = readFailures(logPath);
      expect(entries).toHaveLength(0);
    });

    it("logs when retryPassed is true even with exit 0", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const logPath = join(dir, "test-failures.log");

      logTestRun("some flaky failure output", 0, 2000, true, logPath);

      const entries = readFailures(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].retryPassed).toBe(true);
    });
  });
});
