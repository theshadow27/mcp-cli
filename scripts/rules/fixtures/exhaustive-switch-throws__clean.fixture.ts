/**
 * @rule exhaustive-switch-throws
 * @expect 0
 * @path packages/daemon/src/example-exhaustive-clean.ts
 *
 * Three clean shapes that must NOT be flagged:
 *   1. satisfies never paired with a throw in the same block
 *   2. satisfies never paired with a throw in a terminal else
 *   3. assertNever() helper (no satisfies never — rule does not apply)
 */

type Action = { type: "merge" } | { type: "skip" };

declare function doMerge(a: { type: "merge" }): void;

function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

// Shape 1: satisfies never + throw in default block.
function handleSwitch(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default: {
      action satisfies never;
      throw new Error(`unhandled action type: ${(action as { type: string }).type}`);
    }
  }
}

// Shape 2: satisfies never + throw in terminal else.
function handleIfElse(action: Action): void {
  if (action.type === "merge") {
    doMerge(action);
  } else if (action.type === "skip") {
    // nothing
  } else {
    action satisfies never;
    throw new Error(`unhandled action type: ${(action as { type: string }).type}`);
  }
}

// Shape 3: assertNever helper (no satisfies never — rule does not apply).
function handleWithHelper(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default:
      assertNever(action);
  }
}
