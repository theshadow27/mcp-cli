/**
 * @rule exhaustive-switch-throws
 * @expect 0
 * @path packages/daemon/src/example-exhaustive-clean.ts
 *
 * All shapes that must NOT be flagged:
 *   1. satisfies never + throw in default block (switch)
 *   2. satisfies never + throw in terminal else
 *   3. assertNever(action) helper — no satisfies never, rule does not apply
 *   4. assertNever(action satisfies never) — inline: helper handles the throw
 *   5. `default:` as an object-literal key — not a switch DefaultClause
 *   6. `throw` as a word inside a string literal — AST finds ThrowStatements,
 *      not the substring `throw`, so this shape is NOT a false clean
 *   7. satisfies never inside a nested arrow function — crosses function
 *      boundary; parent-chain walk stops at the arrow, no DefaultClause found
 */

type Action = { type: "merge" } | { type: "skip" };

declare function doMerge(a: { type: "merge" }): void;
declare function log(msg: string): void;

function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

// Shape 1: satisfies never + throw in same default block.
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

// Shape 4: assertNever(action satisfies never) — satisfies-never IS present,
// but branchHasRuntimeGuard finds the assertNever() call → clean.
function handleInlineAssertNever(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default:
      assertNever(action satisfies never);
  }
}

// Shape 5: `default:` as an object-literal key — not a SwitchStatement
// DefaultClause; the satisfies never below is in a separate statement
// outside any default branch.
function handleConfig(action: Action): void {
  const opts = { default: "none", retries: 3 };
  log(opts.default);
  // satisfies never in a plain statement — no enclosing DefaultClause found.
  // (not realistic production code, but exercises the scope boundary)
  if (false as boolean) {
    action satisfies never; // inside an `if (false)` branch, not a default/else
  }
}

// Shape 6: default branch with satisfies never + throw, but also has the
// word "throw" inside a string. AST uses ThrowStatement nodes, not the
// substring, so the string reference does not create a false clean (nor does
// the real throw create a false positive — it genuinely guards).
function handleWithStringMention(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default: {
      action satisfies never;
      log("will throw — see issue #2252");
      throw new Error(`unhandled: ${(action as { type: string }).type}`);
    }
  }
}

// Shape 7: satisfies never inside a nested arrow — function boundary stops
// the parent-chain walk before reaching the enclosing DefaultClause.
function handleWithNestedArrow(action: Action): void {
  switch (action.type) {
    case "merge":
      doMerge(action);
      break;
    case "skip":
      break;
    default: {
      // Arrow crosses the function boundary — satisfies-never inside is not
      // the default branch's own guard expression.
      const debug = () => {
        action satisfies never;
      };
      void debug;
      throw new Error(`unhandled: ${(action as { type: string }).type}`);
    }
  }
}
