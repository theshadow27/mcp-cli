/**
 * Rule: test-filtered-assertion
 *
 * Flag `expect(arr.filter(...)).toHaveLength(0)` and `.toEqual([])` in
 * tests. Filtering before asserting emptiness hides unexpected items in
 * the collection — the test passes while unrelated garbage accumulates.
 *
 * The fix: assert the whole collection (`expect(warnings).toEqual([])`)
 * or assert a specific element's absence with a named reason.
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
    "assert the whole collection: expect(warnings).toEqual([])",
    "or assert the specific element's absence with a named reason: expect(arr).not.toContainEqual(expect.objectContaining(...))",
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
