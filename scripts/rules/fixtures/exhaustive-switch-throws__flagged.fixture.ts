/**
 * @rule exhaustive-switch-throws
 * @expect 1
 * @path packages/daemon/src/example-exhaustive-flagged.ts
 *
 * A default branch with `satisfies never` but no runtime throw should be
 * flagged. The assertion is compile-time only; an unexpected value at
 * runtime will silently fall through.
 */

type Action = { type: "merge" } | { type: "skip" };

declare function doMerge(a: { type: "merge" }): void;

function handle(action: Action): void {
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
