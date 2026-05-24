/**
 * Rule: spawn-mock-kill-resolves-exited
 *
 * Test spawn mocks that pair `exited: new Promise(() => {})` (a promise that
 * never resolves) with `kill: () => {}` (a no-op) cause test teardown to hang.
 *
 * When the code under test tears down (e.g. `server.stop()` in afterEach), it
 * calls `kill()` then `await`s `proc.exited`. Because `kill()` never settles
 * `exited`, teardown blocks for the full SIGTERM→SIGKILL escalation window
 * (~5–7 s) or until the Bun hook timeout — every test in the suite pays it.
 *
 * The `new Promise(() => {})` + no-op `kill` co-occurrence is unambiguous and
 * only meaningful in test files, so this rule is scoped to *.spec.ts / *.test.ts.
 */

import type { CheckRule } from "./_engine/rule";

// Matches: exited: new Promise(() => {}) or exited: new Promise(() => undefined)
const NEVER_RESOLVING_EXITED = /exited\s*:\s*new\s+Promise\s*\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/;

// Matches: kill: () => {} or kill: () => undefined (no-op variants)
const NOOP_KILL = /kill\s*:\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined)/;

// Number of lines either side to search for the kill co-occurrence.
// Large enough for any realistic object literal, small enough to avoid
// cross-object false positives.
const WINDOW = 20;

const rule: CheckRule = {
  id: "spawn-mock-kill-resolves-exited",
  kind: "check",
  scold: "spawn mock: exited is a never-resolving promise and kill() is a no-op — test teardown will hang",
  guidance: [
    "wire kill() to settle exited: const { promise: exited, resolve } = Promise.withResolvers(); kill = () => resolve(0)",
    "or add a shared makeFakeProc() helper under test/ that returns { exited, kill } where kill() resolves exited",
    "the no-op kill + never-settling exited blocks server.stop() in afterEach for the full SIGTERM→SIGKILL window (~5–7 s)",
  ],
  documentation: "#2249",
  appliesToTests: true,
  check({ file, violated }) {
    if (!file.isTest) return;

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!NEVER_RESOLVING_EXITED.test(line)) continue;
      const start = Math.max(0, i - WINDOW);
      const end = Math.min(lines.length - 1, i + WINDOW);
      for (let j = start; j <= end; j++) {
        if (NOOP_KILL.test(lines[j] ?? "")) {
          violated(i + 1, 1, line.trim());
          break;
        }
      }
    }
  },
};

export default rule;
