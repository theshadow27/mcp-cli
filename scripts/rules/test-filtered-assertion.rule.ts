/**
 * Rule: test-filtered-assertion
 *
 * Flag `expect(arr.filter(...)).toHaveLength(0)` and `.toEqual([])` in
 * tests.
 *
 * Why this is a trap: filtering is *subtractive*. You delete rows from the
 * collection before you ever look at it, so anything the filter removed can
 * no longer fail the assertion. A passing `filter(...).toHaveLength(0)` tells
 * you "the specific bad thing I searched for is absent" — it can never tell
 * you "the output is correct." The unexpected, the malformed, the entries you
 * didn't think to filter for: all silently pass.
 *
 * The fix is to assert against the *whole* collection, so anything you didn't
 * expect also fails.
 *
 * Sources: #2085, #2099.
 */

import type { CheckRule } from "./_engine/rule";

const FILTERED_EMPTY =
  /expect\(.+\.filter\s*\(.+\)\s*\)\s*\.\s*(?:toHaveLength\s*\(\s*0\s*\)|toEqual\s*\(\s*\[\s*\]\s*\))/;

const rule: CheckRule = {
  id: "test-filtered-assertion",
  kind: "check",
  scold: "expect(collection.filter(...)) hides unexpected items — assert the whole collection instead",
  guidance: [
    "filtering is subtractive: whatever the filter removed can never fail the test, so .filter(...).toHaveLength(0) proves only that the bad thing you searched for is absent — never that the output is correct. Assert against the whole collection so unexpected items fail too.",
    "examples of doing it right (not exhaustive): expect(arr).toEqual([]) when it should be empty; expect(arr).not.toContainEqual(expect.objectContaining({ field: V })) when it legitimately holds other items (the filter predicate you wrote is the matcher); for a filter(p).map(f).toEqual([]), assert per element — for (const e of arr) expect(p(e)).toBe(false).",
  ],
  documentation: "#2247",
  appliesToTests: true,
  check({ file, violated }) {
    if (!file.isTest) return;

    const lines = file.content.split("\n");
    for (const [i, line] of lines.entries()) {
      const m = FILTERED_EMPTY.exec(line);
      if (m) violated(i + 1, (m.index ?? 0) + 1, line.trim());
    }
  },
};

export default rule;
