#!/usr/bin/env bun
/**
 * Mine flaky test failures from Claude Code session JSONL transcripts.
 * Scans tool results for bun test failure patterns, aggregates by (file, test, session).
 *
 * Scans both the main project sessions AND worktree sessions, since most test
 * runs happen in worktree sessions spawned by the orchestrator.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// Derive project key from cwd
const cwd = process.cwd();
const projectKey = cwd.replace(/[/.]/g, "-");
const projectsDir = join(homedir(), ".claude", "projects");

if (!existsSync(projectsDir)) {
  console.error(`No projects directory found: ${projectsDir}`);
  process.exit(1);
}

// Find all session dirs: main project + worktree variants
const sessionDirs: string[] = [];
for (const dir of readdirSync(projectsDir)) {
  if (dir === projectKey || dir.startsWith(projectKey + "--")) {
    sessionDirs.push(join(projectsDir, dir));
  }
}

if (sessionDirs.length === 0) {
  console.error(`No session directories found for project key: ${projectKey}`);
  process.exit(1);
}

interface Failure {
  file: string;
  test: string;
  sessionId: string;
}

const failures: Failure[] = [];
let filesScanned = 0;
let totalJsonlFiles = 0;

/**
 * Check if a tool_result block contains bun test runner output.
 * We look for the characteristic "bun test" header or pass/fail summary.
 */
function isBunTestOutput(text: string): boolean {
  return (
    text.includes("bun test v") ||
    /\d+ pass/.test(text) ||
    /\d+ fail/.test(text) ||
    // Also match pre-commit hook test output
    text.includes("Ran ") && text.includes(" tests across ")
  );
}

/**
 * Extract the text content from a tool_result block.
 * Content can be a string or an array of {type: "text", text: "..."}.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Normalize a spec file path to just the relative path from packages/.
 * Strips absolute paths, diff prefixes (a/, b/), etc.
 */
function normalizeSpecPath(raw: string): string {
  // Strip diff prefixes
  let p = raw.replace(/^[ab]\//, "");
  // Extract from absolute path
  const pkgIdx = p.indexOf("packages/");
  if (pkgIdx >= 0) p = p.substring(pkgIdx);
  return p;
}

for (const sessionsDir of sessionDirs) {
  const jsonlFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  totalJsonlFiles += jsonlFiles.length;

  for (const file of jsonlFiles) {
    const path = join(sessionsDir, file);
    const sessionId = file.replace(".jsonl", "").slice(0, 8);
    filesScanned++;

    const content = readFileSync(path, "utf-8");
    const sessionFailures = new Set<string>();

    for (const line of content.split("\n")) {
      if (!line.includes("tool_result")) continue; // fast skip

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== "user") continue;

      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const msgContent = message.content;
      if (!Array.isArray(msgContent)) continue;

      for (const block of msgContent) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;

        const text = extractToolResultText(b.content);
        if (!text || !isBunTestOutput(text)) continue;

        // Now we know this is actual test runner output. Parse it.
        let currentFile = "unknown";

        for (const textLine of text.split("\n")) {
          // Track which spec file we're in from lines like:
          // "packages/daemon/src/server-pool.spec.ts:"
          const fileMatch = textLine.match(/^([\w/.@-]+\.spec\.ts):/);
          if (fileMatch) {
            currentFile = normalizeSpecPath(fileMatch[1]);
            continue;
          }

          // bun test uses "(fail)" as the failure marker
          const failMatch = textLine.match(/\(fail\)\s+(.+)/);
          if (failMatch) {
            const testName = failMatch[1].trim();
            // Strip timing info like "[12.34ms]"
            const cleanName = testName.replace(/\s*\[[\d.]+m?s\]\s*$/, "");
            if (!cleanName) continue;

            const key = `${currentFile}::${cleanName}`;
            if (!sessionFailures.has(key)) {
              sessionFailures.add(key);
              failures.push({ file: currentFile, test: cleanName, sessionId });
            }
          }
        }
      }
    }
  }
}

// Aggregate by (file, test) → distinct sessions
interface AggEntry {
  file: string;
  test: string;
  sessions: Set<string>;
  occurrences: number;
}

const agg = new Map<string, AggEntry>();
for (const f of failures) {
  const key = `${f.file}::${f.test}`;
  const entry = agg.get(key) ?? {
    file: f.file,
    test: f.test,
    sessions: new Set(),
    occurrences: 0,
  };
  entry.sessions.add(f.sessionId);
  entry.occurrences++;
  agg.set(key, entry);
}

// Sort by session count desc, then occurrences desc
const sorted = [...agg.values()].sort((a, b) => {
  const diff = b.sessions.size - a.sessions.size;
  return diff !== 0 ? diff : b.occurrences - a.occurrences;
});

// Output report
console.log(`# Flaky Test Report`);
console.log(
  `\nScanned ${filesScanned} session files across ${sessionDirs.length} project dirs.`,
);
console.log(
  `Found ${failures.length} failure instances across ${agg.size} unique (file, test) combinations.\n`,
);

const high = sorted.filter((e) => e.sessions.size >= 3);
const medium = sorted.filter((e) => e.sessions.size === 2);
const low = sorted.filter((e) => e.sessions.size === 1 && e.occurrences >= 2);

if (high.length > 0) {
  console.log(`## High Confidence Flaky (3+ sessions)\n`);
  console.log(`| Sessions | Occurrences | File | Test |`);
  console.log(`|----------|-------------|------|------|`);
  for (const e of high) {
    console.log(
      `| ${e.sessions.size} | ${e.occurrences} | ${e.file} | ${e.test} |`,
    );
  }
  console.log();
}

if (medium.length > 0) {
  console.log(`## Likely Flaky (2 sessions)\n`);
  console.log(`| Sessions | Occurrences | File | Test |`);
  console.log(`|----------|-------------|------|------|`);
  for (const e of medium) {
    console.log(
      `| ${e.sessions.size} | ${e.occurrences} | ${e.file} | ${e.test} |`,
    );
  }
  console.log();
}

if (low.length > 0) {
  console.log(`## Repeated Failures (1 session, 2+ occurrences)\n`);
  console.log(`| Occurrences | File | Test |`);
  console.log(`|-------------|------|------|`);
  for (const e of low.slice(0, 30)) {
    console.log(`| ${e.occurrences} | ${e.file} | ${e.test} |`);
  }
  if (low.length > 30) {
    console.log(`\n...and ${low.length - 30} more single-session failures.`);
  }
  console.log();
}

if (sorted.length === 0) {
  console.log("No test failures found in session transcripts.");
}
