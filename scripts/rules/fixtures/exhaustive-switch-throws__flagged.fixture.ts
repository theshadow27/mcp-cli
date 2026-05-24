/**
 * @rule exhaustive-switch-throws
 * @expect 2
 * @path packages/daemon/src/example-exhaustive-flagged.ts
 *
 * Two shapes that MUST be flagged:
 *   1. default branch with `satisfies never` but no runtime throw
 *   2. terminal else with `satisfies never` but no runtime throw
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
