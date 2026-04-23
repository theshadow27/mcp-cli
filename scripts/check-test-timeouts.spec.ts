import { describe, expect, test } from "bun:test";

/**
 * Unit tests for the setTimeout lint rule's pattern matching.
 * We test the regex directly rather than spawning the script.
 */

const VIOLATION_PATTERN = /\bsetTimeout\s*\([^)]*[0-9]+[^)]*\)/;

describe("check-test-timeouts pattern", () => {
  const shouldMatch = [
    "await new Promise((r) => setTimeout(r, 50))",
    "await new Promise((r) => setTimeout(r, 100))",
    "setTimeout(resolve, 0)",
    "setTimeout(fn, 1000)",
    "setTimeout(r,50)",
    "  setTimeout(done, 200)  ",
    "// setTimeout(r, 50)", // comment lines are flagged — regex can't distinguish
  ];

  const shouldNotMatch = [
    "clearTimeout(handle)",
    "setTimeout(r, POLL_INTERVAL)", // named constant — no numeric literal
    "setTimeout(r, TIMEOUT)",
    "pollUntil(() => condition(), { timeout: 5000 })",
    'expect.poll(() => value).toBe("done")',
    "someTimeout(r, 50)", // not setTimeout
    "nosetTimeout(r, 50)", // word boundary guard
  ];

  for (const line of shouldMatch) {
    test(`flags: ${line.trim()}`, () => {
      expect(VIOLATION_PATTERN.test(line)).toBe(true);
    });
  }

  for (const line of shouldNotMatch) {
    test(`allows: ${line.trim()}`, () => {
      expect(VIOLATION_PATTERN.test(line)).toBe(false);
    });
  }
});
