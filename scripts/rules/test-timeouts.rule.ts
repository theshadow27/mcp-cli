import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Flag `setTimeout` and `Bun.sleep` calls with literal numeric delays in `*.spec.ts(x)` files.
 * Fixed-delay waits in tests are flaky and environment-dependent: they pass on a fast laptop and
 * fail in CI, or vice-versa. A literal delay is a guess about how long the code under test takes;
 * it wastes time on a fast machine and races the thing it waits for on a loaded one.
 *
 * Owns delays written inside code with a whole-number literal: `setTimeout`'s second argument
 * (`setTimeout(fn, 50, extra)` is flagged: the delay is the second argument, not the last; a
 * member call such as `globalThis.setTimeout` counts) and `Bun.sleep`'s first.
 * `0` is flagged too. Named constants, variables and other expressions are fine, since a name can
 * be tuned in one place. The options slot of `test()` is `no-per-test-timeout`'s, not this rule's.
 *
 * Only `*.spec.ts(x)` files are scanned. The standalone `check-test-timeouts.ts` this came from
 * globbed `**\/*.spec.ts` only, so `.test.ts` files (e.g. scripts/bun-segfault-repro/repro.test.ts)
 * are intentionally not scanned (broaden in a separate PR if desired).
 *
 * Not caught: `Bun.sleepSync` (a synchronous spin, used in cross-process polling loops), `sleep` imported from `timers/promises`, `setInterval`, and a delay hidden behind a
 * local helper (`const wait = () => Bun.sleep(100)` is caught only at its `Bun.sleep`).
 */
const WHOLE_NUMBER = /^[0-9][0-9_]*$/;

const isWholeNumber = (node: TSESTree.Node | undefined): boolean =>
  node?.type === "Literal" && typeof node.value === "number" && WHOLE_NUMBER.test(node.raw);

const memberName = (callee: TSESTree.MemberExpression): string | undefined =>
  !callee.computed && callee.property.type === "Identifier" ? callee.property.name : undefined;

/** The delay argument of `setTimeout(fn, delay)` or `Bun.sleep(delay)`, if `call` is one. */
function delayOf(call: TSESTree.CallExpression): TSESTree.Node | undefined {
  const { callee, arguments: args } = call;
  if (callee.type === "Identifier" && callee.name === "setTimeout") return args[1];
  if (callee.type !== "MemberExpression") return undefined;
  const name = memberName(callee);
  if (name === "setTimeout") return args[1];
  const isBun = callee.object.type === "Identifier" && callee.object.name === "Bun";
  return isBun && name === "sleep" ? args[0] : undefined;
}

export default {
  id: "test-timeouts",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "setTimeout / Bun.sleep with a fixed numeric delay in a test — flaky, environment-dependent wait",
  guidance: [
    "Bad:   await new Promise((r) => setTimeout(r, 50))",
    "Good:  await pollUntil(() => condition(), { timeout: 5000 })",
    "Bad:   await Bun.sleep(50) // then assert",
    "Good:  inject a FakeClock or pass a configurable delay parameter (e.g. Bun.sleep(intervalMs))",
    "named constants and parameters are fine: setTimeout(r, POLL_INTERVAL), Bun.sleep(remaining)",
  ],
  documentation: "test/CLAUDE.md flaky-test prevention",
  check(ctx) {
    const path = ctx.file.relativePath;
    if (!path.endsWith(".spec.ts") && !path.endsWith(".spec.tsx")) return ctx.skipped();
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || !isWholeNumber(delayOf(node))) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
