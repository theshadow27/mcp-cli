/**
 * Centralized test failure logging.
 *
 * Uses bun:sqlite for concurrent-safe persistence at ~/.mcp-cli/test-failures.db.
 * Failures are preserved across ephemeral worktree lifetimes.
 *
 * Migration note: This replaces the previous JSONL-based test-failures.log.
 * Existing .log data is not migrated — this is intentional since the JSONL
 * format had no stable schema and the data is ephemeral diagnostic info.
 * The old test-failures.log file can be safely deleted.
 */

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Max entries before pruning oldest on write */
const MAX_ENTRIES = 10_000;

export interface TestFailureEntry {
  timestamp: string;
  file: string;
  test: string;
  worktree: string;
  branch: string;
  pr: number | null;
  exitCode: number;
  retryPassed: boolean;
  duration: number;
  error: string;
}

/** Lazy-opened database handle per path */
const dbCache = new Map<string, Database>();

function openDb(dbPath: string): Database {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      file TEXT NOT NULL,
      test TEXT NOT NULL,
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      pr INTEGER,
      exit_code INTEGER NOT NULL,
      retry_passed INTEGER NOT NULL DEFAULT 0,
      duration INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_test_failures_timestamp ON test_failures(timestamp)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_test_failures_file ON test_failures(file)
  `);

  dbCache.set(dbPath, db);
  return db;
}

/** Close and remove a cached database handle (for testing cleanup). */
export function closeDb(dbPath: string): void {
  const cached = dbCache.get(dbPath);
  if (cached) {
    cached.close();
    dbCache.delete(dbPath);
  }
}

/** Resolve the database path from env or default */
export function getDbPath(): string {
  const dir = process.env.MCP_CLI_DIR;
  if (dir) return `${dir}/test-failures.db`;
  const home = process.env.HOME;
  if (!home) throw new Error("Neither MCP_CLI_DIR nor HOME is set");
  return `${home}/.mcp-cli/test-failures.db`;
}

/** Extract current git context (worktree name, branch, PR number) */
export function getGitContext(): { worktree: string; branch: string; pr: number | null } {
  let branch = "unknown";
  let worktree = "main";
  let pr: number | null = null;

  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    // not in a git repo or timeout
  }

  try {
    const toplevel = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 5000 }).trim();
    const dirName = toplevel.split("/").pop() ?? "main";
    // Worktrees live in .claude/worktrees/<name>
    if (toplevel.includes(".claude/worktrees/")) {
      worktree = dirName;
    } else {
      worktree = "main";
    }
  } catch {
    // not in a git repo
  }

  // Extract PR number from branch name patterns like "fix/issue-422" or "feat/issue-456-slug"
  const prMatch = branch.match(/issue-(\d+)/);
  if (prMatch) {
    pr = Number.parseInt(prMatch[1], 10);
  }

  return { worktree, branch, pr };
}

/**
 * Parse failed test names and files from bun test output.
 * Returns an array of { file, test, error } objects.
 */
export function parseTestFailures(output: string): Array<{ file: string; test: string; error: string }> {
  const failures: Array<{ file: string; test: string; error: string }> = [];

  let currentFile = "unknown";

  // Build a line-by-line map
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for file header
    const fileMatch = line.match(/^\(fail\)\s+([\w/.@-]+\.(?:spec|test)\.ts)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Check for test failure marker
    const testMatch = line.match(/^\s*(?:✗|✘|×)\s+(.+?)(?:\s+\[\d+.*?\])?\s*$/);
    if (testMatch) {
      const testName = testMatch[1];
      // Look ahead for error message
      let error = "";
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const errLine = lines[j].trim();
        if (errLine.startsWith("error:") || errLine.startsWith("Error:") || errLine.startsWith("Expected")) {
          error = errLine;
          break;
        }
        if (errLine.match(/^(?:✗|✘|×|✓|✔|\(fail\)|\(pass\))/)) break;
      }
      failures.push({ file: currentFile, test: testName, error });
    }
  }

  return failures;
}

/** Append one or more failure entries to the database, pruning if needed. */
export function appendFailures(entries: TestFailureEntry[], dbPath?: string): void {
  const path = dbPath ?? getDbPath();
  const db = openDb(path);

  const insert = db.prepare(`
    INSERT INTO test_failures (timestamp, file, test, worktree, branch, pr, exit_code, retry_passed, duration, error)
    VALUES ($timestamp, $file, $test, $worktree, $branch, $pr, $exitCode, $retryPassed, $duration, $error)
  `);

  const insertAndPrune = db.transaction((rows: TestFailureEntry[]) => {
    for (const e of rows) {
      insert.run({
        $timestamp: e.timestamp,
        $file: e.file,
        $test: e.test,
        $worktree: e.worktree,
        $branch: e.branch,
        $pr: e.pr,
        $exitCode: e.exitCode,
        $retryPassed: e.retryPassed ? 1 : 0,
        $duration: e.duration,
        $error: e.error,
      });
    }
    pruneIfNeeded(db);
  });

  insertAndPrune(entries);
}

/** Delete rows beyond MAX_ENTRIES, keeping the most recent. */
function pruneIfNeeded(db: Database): void {
  const countRow = db.prepare("SELECT COUNT(*) as cnt FROM test_failures").get() as { cnt: number };
  if (countRow.cnt <= MAX_ENTRIES) return;

  db.exec(`
    DELETE FROM test_failures WHERE id NOT IN (
      SELECT id FROM test_failures ORDER BY id DESC LIMIT ${MAX_ENTRIES}
    )
  `);
}

/** Read entries from the database with optional filters. */
export function readFailures(dbPath?: string, filters?: { since?: number; file?: string }): TestFailureEntry[] {
  const path = dbPath ?? getDbPath();
  if (!existsSync(path)) return [];

  const db = openDb(path);

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters?.since) {
    conditions.push("timestamp >= $since");
    params.$since = new Date(filters.since).toISOString();
  }
  if (filters?.file) {
    conditions.push("file LIKE $file");
    params.$file = `%${filters.file}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM test_failures ${where} ORDER BY id ASC`;

  const rows = db.prepare(query).all(params) as Array<{
    id: number;
    timestamp: string;
    file: string;
    test: string;
    worktree: string;
    branch: string;
    pr: number | null;
    exit_code: number;
    retry_passed: number;
    duration: number;
    error: string;
  }>;

  return rows.map((r) => ({
    timestamp: r.timestamp,
    file: r.file,
    test: r.test,
    worktree: r.worktree,
    branch: r.branch,
    pr: r.pr,
    exitCode: r.exit_code,
    retryPassed: r.retry_passed !== 0,
    duration: r.duration,
    error: r.error,
  }));
}

/**
 * High-level helper: log test failures from a bun test run.
 *
 * @param output - combined stdout+stderr from bun test
 * @param exitCode - process exit code
 * @param duration - total test duration in ms
 * @param retryPassed - did a retry succeed?
 * @param dbPath - override db path (for testing)
 */
export function logTestRun(
  output: string,
  exitCode: number,
  duration: number,
  retryPassed = false,
  dbPath?: string,
): void {
  if (exitCode === 0 && !retryPassed) return; // nothing to log on clean pass

  const { worktree, branch, pr } = getGitContext();
  const timestamp = new Date().toISOString();
  const parsed = parseTestFailures(output);

  if (parsed.length === 0) {
    // No individual test failures parsed — log a single entry for the run
    appendFailures(
      [
        {
          timestamp,
          file: "unknown",
          test: "unknown",
          worktree,
          branch,
          pr,
          exitCode,
          retryPassed,
          duration,
          error:
            output
              .split("\n")
              .find((l) => /^(error:|Error:|FAIL:|panic:)/i.test(l.trim()))
              ?.trim() ?? "",
        },
      ],
      dbPath,
    );
    return;
  }

  const entries: TestFailureEntry[] = parsed.map((f) => ({
    timestamp,
    file: f.file,
    test: f.test,
    worktree,
    branch,
    pr,
    exitCode,
    retryPassed,
    duration,
    error: f.error,
  }));

  appendFailures(entries, dbPath);
}
