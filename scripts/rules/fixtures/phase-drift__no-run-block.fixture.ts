/**
 * @rule phase-drift
 * @expect 1
 * @path packages/command/src/commands/phase.ts
 *
 * No `sub === "run"` block at all — likely a refactor that renamed
 * the dispatch surface. The rule must flag this so the drift guard
 * doesn't silently vanish.
 */

declare const sub: string;
declare function listPhases(): void;

export function dispatch(): void {
  if (sub === "list") {
    listPhases();
    return;
  }
}
