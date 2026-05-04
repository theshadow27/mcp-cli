#!/usr/bin/env bun
/**
 * Lint rule: flag setTimeout with fixed numeric delays in *.spec.ts files.
 *
 * CLAUDE.md bans setTimeout for waiting in tests: "Never use setTimeout for
 * waiting, always poll with deadlines instead of fixed delays."  This script
 * enforces that rule at commit time.
 *
 * Patterns flagged:
 *   setTimeout(r, 50)
 *   setTimeout(() => r(null), 50)     ← arrow-function callback
 *   await new Promise((r) => setTimeout(r, 100))
 *
 * Safe alternative: poll with a deadline helper (e.g. pollUntil / expect.poll)
 * or use Bun.sleep() for the documented exceptions (negative assertions, retry
 * backoff) described in test/CLAUDE.md.
 *
 * Detection uses parenthesis-depth tracking so nested parens in callbacks do
 * not cause false negatives, including arrow-function callbacks and setTimeout
 * calls whose arguments span multiple lines.
 *
 * Usage:  bun scripts/check-test-timeouts.ts
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — violations found
 */

import { Glob } from "bun";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;
const SCRIPTS_DIR = new URL("../scripts/", import.meta.url).pathname;
const TEST_DIR = new URL("../test/", import.meta.url).pathname;

/**
 * Returns true if the line contains a setTimeout call whose last argument is a
 * plain numeric literal (e.g. 50, 1_000), catching fixed-delay usages.
 *
 * Uses paren-depth tracking to extract the full argument list so that nested
 * parens in arrow-function callbacks (like `setTimeout(() => r(null), 50)`)
 * are handled correctly.
 */
export function hasFixedDelay(line: string): boolean {
  const re = /\bsetTimeout\s*\(/g;
  let match = re.exec(line);
  while (match !== null) {
    const parenOpen = match.index + match[0].length - 1; // index of '('

    // Walk forward tracking depth to find the matching closing paren.
    let depth = 1;
    let i = parenOpen + 1;
    while (i < line.length && depth > 0) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
      i++;
    }

    if (depth === 0) {
      const args = line.slice(parenOpen + 1, i - 1);

      // Find the last top-level comma to isolate the delay argument.
      let argDepth = 0;
      let lastComma = -1;
      for (let j = 0; j < args.length; j++) {
        const c = args[j];
        if (c === "(" || c === "[" || c === "{") argDepth++;
        else if (c === ")" || c === "]" || c === "}") argDepth--;
        else if (c === "," && argDepth === 0) lastComma = j;
      }

      if (lastComma !== -1) {
        const lastArg = args.slice(lastComma + 1).trim();
        // Match pure numeric literals (digits and underscores, must start with digit).
        if (/^[0-9][0-9_]*$/.test(lastArg)) return true;
      }
    }

    match = re.exec(line);
  }
  return false;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Scans a full file's content for setTimeout calls with fixed numeric delays,
 * tracking parenthesis depth across newlines so multi-line calls are caught.
 * Returns one entry per violation with a 1-based line number and the trimmed
 * text of the line where the setTimeout keyword appears.
 */
export function findViolations(content: string): Array<{ line: number; text: string }> {
  const results: Array<{ line: number; text: string }> = [];
  const lines = content.split("\n");
  const re = /\bsetTimeout\s*\(/g;

  for (let match = re.exec(content); match !== null; match = re.exec(content)) {
    const parenOpen = match.index + match[0].length - 1;

    let depth = 1;
    let i = parenOpen + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
      i++;
    }

    if (depth !== 0) continue;

    const args = content.slice(parenOpen + 1, i - 1);

    let argDepth = 0;
    let lastComma = -1;
    for (let j = 0; j < args.length; j++) {
      const c = args[j];
      if (c === "(" || c === "[" || c === "{") argDepth++;
      else if (c === ")" || c === "]" || c === "}") argDepth--;
      else if (c === "," && argDepth === 0) lastComma = j;
    }

    if (lastComma === -1) continue;

    const lastArg = args.slice(lastComma + 1).trim();
    if (!/^[0-9][0-9_]*$/.test(lastArg)) continue;

    const lineNum = content.slice(0, match.index).split("\n").length;
    results.push({ line: lineNum, text: lines[lineNum - 1].trim() });
  }

  return results;
}

async function scanDir(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.spec.ts");

  for await (const relPath of glob.scan({ cwd: dir, absolute: false })) {
    if (relPath.endsWith(".d.ts") || relPath.includes("node_modules")) continue;
    if (relPath === "check-test-timeouts.spec.ts") continue;

    const absPath = `${dir}${relPath}`;
    const content = await Bun.file(absPath).text();

    for (const { line, text } of findViolations(content)) {
      violations.push({ file: absPath, line, text });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const dirs = [PACKAGES_DIR, SCRIPTS_DIR, TEST_DIR];
  const allViolations: Violation[] = [];

  for (const dir of dirs) {
    const violations = await scanDir(dir);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    process.stderr.write("No setTimeout violations found in test files.\n");
    process.exit(0);
  }

  process.stderr.write(`\n  setTimeout with fixed delay: ${allViolations.length} violation(s) found\n\n`);
  process.stderr.write("  Fixed-delay setTimeout in tests creates flaky, environment-dependent waits.\n");
  process.stderr.write("  Use a poll-with-deadline helper instead, or Bun.sleep() for negative assertions.\n\n");

  for (const v of allViolations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n\n`);
  }

  process.stderr.write("  Bad:   await new Promise((r) => setTimeout(r, 50))\n");
  process.stderr.write("  Good:  await pollUntil(() => condition(), { timeout: 5000 })\n\n");

  process.exit(1);
}

if (import.meta.main) {
  main();
}
