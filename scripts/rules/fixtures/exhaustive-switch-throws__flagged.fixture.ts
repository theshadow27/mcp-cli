/**
 * @rule exhaustive-switch-throws
 * @expect 3
 * @path packages/daemon/src/example-exhaustive-flagged.ts
 *
 * Three shapes that MUST be flagged:
 *   1. default branch with `satisfies never` but no runtime throw
 *   2. terminal else with `satisfies never` but no runtime throw
 *   3. default branch where the only `throw` is inside a nested arrow —
 *      the arrow is never called, so the branch still silently no-ops
 */

type Action = { type: "merge" } | { type: "skip" };

declare function doMerge(a: { type: "merge" }): void;

// Shape 1: default branch — satisfies never, no throw.
function handleSwitch(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default:
      action satisfies never; // compile-time only — no runtime guard
  }
}

// Shape 2: terminal else — satisfies never, no throw.
function handleIfElse(action: Action): void {
  if (action.type === "merge") {
    doMerge(action);
  } else if (action.type === "skip") {
    // nothing
  } else {
    action satisfies never; // compile-time only — no runtime guard
  }
}

// Shape 3: throw buried inside a nested arrow — never invoked, so the branch
// still silently no-ops at runtime. branchHasRuntimeGuard must not descend
// into the arrow's body when searching for a guard.
function handleWithDeadArrow(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default:
      action satisfies never; // compile-time only — nested arrow throw doesn't count
      // Arrow is assigned but never called — not a runtime guard.
      const _dead = () => {
        throw new Error("unreachable");
      };
      void _dead;
  }
}
