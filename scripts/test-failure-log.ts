/**
 * Centralized test failure logging.
 *
 * Writes JSONL entries to ~/.mcp-cli/test-failures.log so failures are
 * preserved across ephemeral worktree lifetimes.
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Max entries before trimming oldest on write */
const MAX_ENTRIES = 10_000;

/** Max file size before triggering rotation (10 MB) */
const MAX_BYTES = 10 * 1024 * 1024;

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

/** Resolve the log path from env or default */
export function getLogPath(): string {
  const dir = process.env.MCP_CLI_DIR || `${process.env.HOME}/.mcp-cli`;
  return `${dir}/test-failures.log`;
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
    const dirName = basename(toplevel);
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

/** Append one or more failure entries to the log file, rotating if needed. */
export function appendFailures(entries: TestFailureEntry[], logPath?: string): void {
  const path = logPath ?? getLogPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  appendFileSync(path, lines, "utf-8");

  // Rotate if needed
  rotateIfNeeded(path);
}

/** Trim log to MAX_ENTRIES if it exceeds size or entry limits. */
export function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;

  try {
    const stat = statSync(logPath);
    const content = readFileSync(logPath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());

    if (stat.size <= MAX_BYTES && allLines.length <= MAX_ENTRIES) return;

    // Trim to MAX_ENTRIES, write atomically via temp+rename
    const keep = allLines.slice(-MAX_ENTRIES);
    const tmpPath = `${logPath}.tmp`;
    writeFileSync(tmpPath, `${keep.join("\n")}\n`, "utf-8");
    renameSync(tmpPath, logPath);
  } catch {
    return;
  }
}

/** Read all entries from the log file. */
export function readFailures(logPath?: string): TestFailureEntry[] {
  const path = logPath ?? getLogPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as TestFailureEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TestFailureEntry => e !== null);
}

/**
 * High-level helper: log test failures from a bun test run.
 *
 * @param output - combined stdout+stderr from bun test
 * @param exitCode - process exit code
 * @param duration - total test duration in ms
 * @param retryPassed - did a retry succeed?
 * @param logPath - override log path (for testing)
 */
export function logTestRun(
  output: string,
  exitCode: number,
  duration: number,
  retryPassed = false,
  logPath?: string,
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
      logPath,
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

  appendFailures(entries, logPath);
}
