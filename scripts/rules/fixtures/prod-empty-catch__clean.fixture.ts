/**
 * @rule prod-empty-catch
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Catch blocks with a body — not flagged.
 */

function handled() {
  try {
    JSON.parse("bad");
  } catch (e) {
    throw new TypeError("parse failed", { cause: e });
  }

  try { throw new Error("boom"); } catch (e) { console.error(e); }
}
