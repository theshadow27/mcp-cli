/**
 * @rule prod-empty-catch
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * Two inline empty catch blocks in production code — both should be flagged.
 */

function risky() {
  try { JSON.parse("bad"); } catch {}
  try { throw new Error("boom"); } catch (e) {}
}
