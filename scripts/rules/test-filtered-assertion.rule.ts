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
    "default — assert the whole collection is empty: expect(arr).toEqual([])",
    "if the array legitimately holds other entries, don't deliberate: translate the filter predicate you already wrote into a negative matcher mechanically — .filter(e => e.field === V) → expect(arr).not.toContainEqual(expect.objectContaining({ field: V })); .filter(s => s.includes(V)) → expect(arr).not.toContainEqual(expect.stringContaining(V))",
    "for filter(...).map(...).toEqual([]): assert the predicate is false per element — for (const e of arr) expect(pred(e)).toBe(false)",
    "use the first form unless the collection is expected to contain unrelated items; the predicate is the answer, no judgment call needed",
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
