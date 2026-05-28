/**
 * @rule prod-empty-catch
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Suppressed empty catch — the dotw-ignore comment prevents flagging.
 */

function bestEffort() {
  try { cleanup(); } catch {} // dotw-ignore prod-empty-catch: best-effort cleanup
  try { cleanup(); } catch {} // dotw-todo prod-empty-catch: should log — fix in #2535
}
