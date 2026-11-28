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

import type { Rule } from "am-i-done";

export default {
  id: "test-trivial-bound",
  type: "pattern",
  category: "testing",
  pattern: /\.toBeLessThanOrEqual\s*\(\s*1\s*\)/g,
  scope: "code",
  tests: "only",
  scold: "toBeLessThanOrEqual(1) passes at 0 (never fired) — assert the exact count or both bounds",
  guidance: [
    "assert the exact expected count: expect(n).toBe(1)",
    "or assert both bounds: expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)",
  ],
  documentation: "#2247",
} satisfies Rule;
