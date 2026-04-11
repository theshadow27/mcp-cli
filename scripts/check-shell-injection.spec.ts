import { describe, expect, test } from "bun:test";

/**
 * Unit tests for the shell injection lint rule's pattern matching.
 * We test the regex directly rather than spawning the script.
 */

const VIOLATION_PATTERN = /\b(execSync|execFileSync)\s*\(\s*`[^`]*\$\{/;

describe("check-shell-injection pattern", () => {
  const shouldMatch = [
    "execSync(`git commit -m ${JSON.stringify(msg)}`, opts)",
    "execSync(`git commit -m ${msg}`, opts)",
    "execFileSync(`/bin/sh -c ${cmd}`)",
    "execSync(  `foo ${bar}`)",
    "execSync(`${cmd}`)",
  ];

  const shouldNotMatch = [
    'execSync("git init", opts)',
    "execSync('git add -A', opts)",
    "execSync(`git init`, opts)", // template literal without interpolation is fine
    "execSync(`git add -A`, opts)",
    'spawnSync("git", ["commit", "-m", msg], opts)',
    'execFileSync("git", ["commit", "-m", msg], opts)',
    "// execSync(`git commit -m ${msg}`)", // comment — but regex doesn't know; acceptable false positive
  ];

  for (const line of shouldMatch) {
    test(`flags: ${line}`, () => {
      expect(VIOLATION_PATTERN.test(line)).toBe(true);
    });
  }

  for (const line of shouldNotMatch) {
    test(`allows: ${line}`, () => {
      expect(VIOLATION_PATTERN.test(line)).toBe(false);
    });
  }
});
