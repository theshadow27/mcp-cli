import { describe, expect, test } from "bun:test";
import { findViolations, hasFixedDelay } from "./check-test-timeouts";

// Shared matrices — exercised by both hasFixedDelay (per-line) and
// findViolations (whole-content) so the production scan path is covered.
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
  "setTimeout(fn, 50, undefined)", // 3-arg form: delay is 2nd arg, not last
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
  "setTimeout(fn, TIMEOUT, 50)", // 3-arg form: delay (2nd arg) is named constant
];

describe("check-test-timeouts hasFixedDelay", () => {
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

describe("check-test-timeouts findViolations (single-line equivalence)", () => {
  for (const line of shouldMatch) {
    test(`flags: ${line.trim()}`, () => {
      expect(findViolations(line).length).toBeGreaterThan(0);
    });
  }

  for (const line of shouldNotMatch) {
    test(`allows: ${line.trim()}`, () => {
      expect(findViolations(line)).toHaveLength(0);
    });
  }
});

describe("check-test-timeouts findViolations (multi-line)", () => {
  test("catches single-line setTimeout(r, 50)", () => {
    const content = "await new Promise((r) => setTimeout(r, 50));";
    const vs = findViolations(content);
    expect(vs).toHaveLength(1);
    expect(vs[0].line).toBe(1);
  });

  test("catches setTimeout split across lines (delay on its own line)", () => {
    const content = `await new Promise((r) =>
  setTimeout(
    r,
    50
  )
);`;
    const vs = findViolations(content);
    expect(vs).toHaveLength(1);
    expect(vs[0].line).toBe(2);
  });

  test("catches setTimeout with arrow-fn callback split across lines", () => {
    const content = `new Promise((r) =>
  setTimeout(() => r(null), 50)
);`;
    const vs = findViolations(content);
    expect(vs).toHaveLength(1);
    expect(vs[0].line).toBe(2);
  });

  test("does not flag setTimeout with a variable delay spanning lines", () => {
    const content = `setTimeout(
  r,
  POLL_INTERVAL
);`;
    expect(findViolations(content)).toHaveLength(0);
  });

  test("does not flag single-arg setTimeout spanning lines", () => {
    const content = `setTimeout(
  fn
);`;
    expect(findViolations(content)).toHaveLength(0);
  });

  test("reports correct line numbers for multiple violations in one file", () => {
    const content = `// line 1
setTimeout(r, 50);
// line 3
setTimeout(
  fn,
  100
);`;
    const vs = findViolations(content);
    expect(vs).toHaveLength(2);
    expect(vs[0].line).toBe(2);
    expect(vs[1].line).toBe(4);
  });
});
