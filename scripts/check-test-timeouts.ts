#!/usr/bin/env bun
/**
 * Lint rule: flag setTimeout with fixed numeric delays in *.spec.ts files.
 *
 * CLAUDE.md bans setTimeout for waiting in tests: "Never use setTimeout for
 * waiting, always poll with deadlines instead of fixed delays."  This script
 * enforces that rule at commit time.
 *
 * Pattern flagged: setTimeout(<anything>, <number-literal>)
 * Safe alternative: poll with a deadline helper (e.g. pollUntil / expect.poll)
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
 * Matches setTimeout calls where the delay argument contains a numeric literal,
 * e.g. setTimeout(r, 50) or await new Promise((r) => setTimeout(r, 100)).
 *
 * Does NOT match:
 *   setTimeout(r, TIMEOUT_CONST)   — named constant, not a bare number
 *   clearTimeout(handle)           — clearTimeout is not flagged
 */
const VIOLATION_PATTERN = /\bsetTimeout\s*\([^)]*[0-9]+[^)]*\)/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

async function scanDir(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.spec.ts");

  for await (const relPath of glob.scan({ cwd: dir, absolute: false })) {
    if (relPath.endsWith(".d.ts") || relPath.includes("node_modules")) continue;
    if (relPath === "check-test-timeouts.spec.ts") continue;

    const absPath = `${dir}${relPath}`;
    const content = await Bun.file(absPath).text();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (VIOLATION_PATTERN.test(lines[i])) {
        violations.push({ file: absPath, line: i + 1, text: lines[i].trim() });
      }
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
  process.stderr.write("  Use a poll-with-deadline helper instead.\n\n");

  for (const v of allViolations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n\n`);
  }

  process.stderr.write("  Bad:   await new Promise((r) => setTimeout(r, 50))\n");
  process.stderr.write("  Good:  await pollUntil(() => condition(), { timeout: 5000 })\n\n");

  process.exit(1);
}

main();
