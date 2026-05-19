import { describe, expect, test } from "bun:test";
import { BUN_SLEEP_BASELINE, findBunSleepViolations, findViolations, hasBunSleep, hasFixedDelay } from "./check-test-timeouts";

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

describe("check-test-timeouts BUN_SLEEP_BASELINE", () => {
  test("baseline is a positive integer", () => {
    expect(BUN_SLEEP_BASELINE).toBeGreaterThan(0);
    expect(Number.isInteger(BUN_SLEEP_BASELINE)).toBe(true);
  });
});

// --- Bun.sleep detection ---

const bunSleepShouldMatch = [
  "await Bun.sleep(50)",
  "await Bun.sleep(100)",
  "Bun.sleep(0)",
  "Bun.sleep(1_000)",
  "  Bun.sleep(200)  ",
  "// Bun.sleep(50)", // comment lines are flagged — no comment-stripping
  "Promise.race([p, Bun.sleep(5000).then(() => null)])", // deadline pattern — intentionally flagged (#2100 remedy: name the constant)
];

const bunSleepShouldNotMatch = [
  "await Bun.sleep(ms)", // parameterized — acceptable
  "await Bun.sleep(intervalMs)", // named variable
  "await Bun.sleep(POLL_INTERVAL_MS)", // named constant
  "await Bun.sleep(remaining)", // variable
  "await Bun.sleep(delayMs)", // parameter name
  "noBun.sleep(50)", // word boundary guard
  "Promise.race([waitForMsg(), Bun.sleep(remaining).then(() => null)])", // variable arg
  "await Bun.sleep(`${delay}`)", // template literal — not a numeric literal
];

describe("check-test-timeouts hasBunSleep", () => {
  for (const line of bunSleepShouldMatch) {
    test(`flags: ${line.trim()}`, () => {
      expect(hasBunSleep(line)).toBe(true);
    });
  }

  for (const line of bunSleepShouldNotMatch) {
    test(`allows: ${line.trim()}`, () => {
      expect(hasBunSleep(line)).toBe(false);
    });
  }
});

describe("check-test-timeouts findBunSleepViolations (single-line equivalence)", () => {
  for (const line of bunSleepShouldMatch) {
    test(`flags: ${line.trim()}`, () => {
      expect(findBunSleepViolations(line).length).toBeGreaterThan(0);
    });
  }

  for (const line of bunSleepShouldNotMatch) {
    test(`allows: ${line.trim()}`, () => {
      expect(findBunSleepViolations(line)).toHaveLength(0);
    });
  }
});

describe("check-test-timeouts findBunSleepViolations (multi-line)", () => {
  test("catches single-line Bun.sleep(50)", () => {
    const content = "await Bun.sleep(50);";
    const vs = findBunSleepViolations(content);
    expect(vs).toHaveLength(1);
    expect(vs[0].line).toBe(1);
  });

  test("catches Bun.sleep split across lines", () => {
    const content = `await Bun.sleep(
  100
);`;
    const vs = findBunSleepViolations(content);
    expect(vs).toHaveLength(1);
    expect(vs[0].line).toBe(1);
  });

  test("does not flag Bun.sleep with a variable argument", () => {
    const content = "await Bun.sleep(intervalMs);";
    expect(findBunSleepViolations(content)).toHaveLength(0);
  });

  test("reports correct line numbers for multiple Bun.sleep violations", () => {
    const content = `// line 1
await Bun.sleep(10);
// line 3
await Bun.sleep(50);`;
    const vs = findBunSleepViolations(content);
    expect(vs).toHaveLength(2);
    expect(vs[0].line).toBe(2);
    expect(vs[1].line).toBe(4);
  });

  test("does not flag Bun.sleep in Promise.race with variable arg", () => {
    const content = "Promise.race([waitForMsg(), Bun.sleep(remaining).then(() => null)])";
    expect(findBunSleepViolations(content)).toHaveLength(0);
  });
});
