/**
 * Rule: test-trivial-bound
 *
 * Flag `toBeLessThanOrEqual(1)` in tests. It passes at 0, so a "fires at
 * most once" test passes when the code never fired at all.
 *
 * `toBeGreaterThanOrEqual(0)` was considered but excluded: it has
 * legitimate uses for indexOf/findIndex results where >= 0 means "found."
 *
 * Sources: #2197.
 */

import type { CheckRule } from "./_engine/rule";

const TRIVIAL_UPPER = /\.toBeLessThanOrEqual\s*\(\s*1\s*\)/;

const rule: CheckRule = {
  id: "test-trivial-bound",
  kind: "check",
  scold: "toBeLessThanOrEqual(1) passes at 0 (never fired) — assert the exact count or both bounds",
  guidance: [
    "assert the exact expected count: expect(n).toBe(1)",
    "or assert both bounds: expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)",
  ],
  documentation: "#2247",
  appliesToTests: true,
  check({ file, violated }) {
    if (!file.isTest) return;

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      const m = TRIVIAL_UPPER.exec(line);
      if (m) violated(i + 1, (m.index ?? 0) + 1, line.trim());
    }
  },
};

export default rule;
