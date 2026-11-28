/**
 * Rule: staging-path-enoent-tolerant
 *
 * Every filesystem operation naming a *peer-visible staging path* must tolerate
 * ENOENT.
 *
 * The transition store claims a legacy `transitions.jsonl` by renaming it to a
 * private `.importing.<nonce>` name, imports it inside `BEGIN IMMEDIATE`, and
 * parks it afterwards. The park runs *after* COMMIT, so the write lock is
 * already released while the staging path is still on disk — which means any
 * other process can be scanning, reading, parking or quarantining that same path
 * concurrently. Every syscall naming one can therefore lose the race and return
 * ENOENT, and every one of them must treat that as "a peer already handled it"
 * rather than as a failure.
 *
 * This is a rule and not a test because the defect it exists to prevent is
 * *partial* compliance. The invariant was stated, then satisfied at two of the
 * four sites; the two that were missed threw out of `withDbTx` after
 * `commitWithRetry`, so a transition that was already committed to the database
 * was reported to the operator as a hard failure with a non-zero exit — and
 * `phase.ts` only retries `TransitionLockBusyError`, so nothing caught it. A
 * behavioural test can only cover the sites someone thought to drive, and the
 * window is a single syscall wide, so driving it at all needs a peer process
 * suspended mid-park. A static check covers every site, including the next one
 * added. See #1328 and PR #2964.
 *
 * Fix: wrap the call in `try` / `catch` and branch on `errnoCode(err) ===
 * "ENOENT"`, or route it through a helper that already does (e.g.
 * `unlinkQuietly`). Note that the check is satisfied by any *enclosing* try
 * whose catch mentions ENOENT, so a shared guard around several operations is
 * fine.
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

/** Syscall wrappers that throw ENOENT when their target has already vanished. */
const FS_CALLS = new Set([
  "readFileSync",
  "linkSync",
  "unlinkSync",
  "renameSync",
  "copyFileSync",
  "statSync",
  "openSync",
  "rmSync",
  "appendFileSync",
]);

/**
 * An argument naming a staging path. Deliberately identifier-shaped rather than
 * type-driven: the engine parses without a type-checker, and every site in
 * practice passes a plainly-named local.
 */
const STAGING_IDENT = /^(staging|stagingPath|abandoned|claimed)$/;

/** True when `node` sits inside a try block whose catch handles ENOENT. */
function insideEnoentGuard(node: TSESTree.Node, content: string): boolean {
  for (let cur: TSESTree.Node | undefined = node; cur; cur = cur.parent) {
    const parent: TSESTree.Node | undefined = cur.parent;
    if (!parent || parent.type !== "TryStatement") continue;
    // Only the try block is guarded — a call sitting in the catch or finally of
    // the same statement is not protected by it.
    if (parent.block !== cur) continue;
    if (parent.handler && content.slice(...parent.handler.range).includes("ENOENT")) return true;
  }
  return false;
}

/** The name a call invokes: `name()`, `obj.name()` or `obj["name"]()`. */
function calledName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed) return callee.property.type === "Identifier" ? callee.property.name : undefined;
  return callee.property.type === "Literal" && typeof callee.property.value === "string"
    ? callee.property.value
    : undefined;
}

export default {
  id: "staging-path-enoent-tolerant",
  type: "check",
  category: "architecture",
  ast: true,
  tests: "exclude",
  scold: "filesystem call on a peer-visible staging path without an ENOENT branch — a concurrent park makes this throw",
  guidance: [
    'wrap it in try/catch and branch on errnoCode(err) === "ENOENT"',
    "or call a helper that already tolerates it, e.g. unlinkQuietly()",
    "the park runs after COMMIT with the write lock released, so a peer can remove the path mid-operation",
    "throwing here reports an already-committed transition as a failure (#1328, PR #2964)",
  ],
  documentation: "#1328",
  check(ctx) {
    const { file } = ctx;
    // Staging paths exist only in the transition store. Scoping to the files
    // that actually mint them keeps the identifier heuristic from firing on
    // unrelated code that happens to use the name.
    if (!file.content.includes("IMPORTING_SUFFIX")) return ctx.skipped();

    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression") return;
      const name = calledName(node);
      if (name === undefined || !FS_CALLS.has(name)) return;
      const namesStaging = node.arguments.some((arg) => arg.type === "Identifier" && STAGING_IDENT.test(arg.name));
      if (!namesStaging) return;
      if (insideEnoentGuard(node, file.content)) return;

      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, file.content.split("\n")[line - 1]?.trim() ?? "");
    });
    return ctx.checked();
  },
} satisfies Rule;
