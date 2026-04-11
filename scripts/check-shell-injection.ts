#!/usr/bin/env bun
/**
 * Lint rule: flag execSync / execFileSync calls with template literal arguments.
 *
 * Shell commands built via template literals are injection vectors — even with
 * JSON.stringify, bash expands $() and backtick substitution inside double
 * quotes.  The safe alternative is spawnSync / execFileSync with an args array.
 *
 * Usage:  bun scripts/check-shell-injection.ts [--fix]
 *         --fix  just reports; there's no auto-fix (manual conversion required)
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
 * Pattern: execSync(`...${...}...`) or execFileSync(`...${...}...`)
 *
 * Matches calls where the first argument is a template literal containing
 * interpolation (${}).  Plain template literals without interpolation
 * (e.g., execSync(`git init`)) are fine — they're equivalent to string
 * literals and contain no dynamic content.
 */
const VIOLATION_PATTERN = /\b(execSync|execFileSync)\s*\(\s*`[^`]*\$\{/;

interface Violation {
  file: string;
  line: number;
  text: string;
  fn: string;
}

async function scanDir(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");

  for await (const relPath of glob.scan({ cwd: dir, absolute: false })) {
    // Skip declaration files, node_modules, and this script + its tests
    if (relPath.endsWith(".d.ts") || relPath.includes("node_modules")) continue;
    if (relPath === "check-shell-injection.ts" || relPath === "check-shell-injection.spec.ts") continue;

    const absPath = `${dir}${relPath}`;
    const file = Bun.file(absPath);
    const content = await file.text();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const match = VIOLATION_PATTERN.exec(lines[i]);
      if (match) {
        violations.push({
          file: absPath,
          line: i + 1,
          text: lines[i].trim(),
          fn: match[1],
        });
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
    process.stderr.write("No shell injection risks found.\n");
    process.exit(0);
  }

  process.stderr.write(`\n  Shell injection risk: ${allViolations.length} violation(s) found\n\n`);
  process.stderr.write("  execSync/execFileSync with template literal interpolation is unsafe.\n");
  process.stderr.write("  Use spawnSync() or execFileSync() with an args array instead.\n\n");

  for (const v of allViolations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n\n`);
  }

  process.stderr.write("  Bad:   execSync(`git commit -m ${JSON.stringify(msg)}`, opts)\n");
  process.stderr.write('  Good:  spawnSync("git", ["commit", "-m", msg], opts)\n\n');

  process.exit(1);
}

main();
