import { describe, expect, test } from "bun:test";
import { hasFixedDelay } from "./check-test-timeouts";

/**
 * Unit tests for the setTimeout lint rule's detection logic.
 * Tests the hasFixedDelay function directly rather than spawning the script.
 */

describe("check-test-timeouts hasFixedDelay", () => {
  const shouldMatch = [
    "await new Promise((r) => setTimeout(r, 50))",
    "await new Promise((r) => setTimeout(r, 100))",
    "setTimeout(resolve, 0)",
    "setTimeout(fn, 1000)",
    "setTimeout(r,50)",
    "  setTimeout(done, 200)  ",
    "setTimeout(() => r(null), 50)", // arrow-function callback with nested paren
    "setTimeout(() => doWork(), 250)", // arrow function, no nested paren complications
    "new Promise<null>((r) => setTimeout(() => r(null), 50))", // full pattern from ws-server
    "// setTimeout(r, 50)", // comment lines are flagged — no comment-stripping
  ];

  const shouldNotMatch = [
    "clearTimeout(handle)",
    "setTimeout(r, POLL_INTERVAL)", // named constant — no numeric literal
    "setTimeout(r, TIMEOUT)",
    "setTimeout(r)", // single arg, no delay parameter
    "pollUntil(() => condition(), { timeout: 5000 })",
    'expect.poll(() => value).toBe("done")',
    "someTimeout(r, 50)", // not setTimeout
    "nosetTimeout(r, 50)", // word boundary guard
    "await Bun.sleep(50)", // Bun.sleep is the accepted form
  ];

  for (const line of shouldMatch) {
    test(`flags: ${line.trim()}`, () => {
      expect(hasFixedDelay(line)).toBe(true);
    });
  }

  for (const line of shouldNotMatch) {
    test(`allows: ${line.trim()}`, () => {
      expect(hasFixedDelay(line)).toBe(false);
    });
  }
});
