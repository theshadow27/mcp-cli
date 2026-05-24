/**
 * @rule test-empty-catch
 * @expect 0
 * @path packages/daemon/src/example.spec.ts
 *
 * Same-line catch with expect — should NOT be flagged.
 */

import { expect, it } from "bun:test";

it("same-line catch with assertion", () => {
  try { JSON.parse("bad"); } catch (e) { expect(e).toBeInstanceOf(SyntaxError); }
});
