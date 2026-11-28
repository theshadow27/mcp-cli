import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Flag catch blocks in test files whose body contains no `expect(` call. An empty or
 * assertion-free catch swallows the failure the test claims to verify: the test passes vacuously
 * when the code throws. `try { await run(); } catch (error) { log(error); }` passes whether or not
 * `run` throws. `no-empty-catch` covers an empty block anywhere; this one covers any catch in a
 * test file that makes no `expect(...)` call, wherever it sits (a test body, a hook, a helper)
 * and including one that rethrows or only records the error. Sources: #2194, #1879.
 *
 * Deliberately not caught: `.catch(...)` handlers on promises, and a helper that asserts for you
 * (a call other than `expect` is not recognized as an assertion).
 */
export default {
  id: "test-empty-catch",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "catch block in test has no expect() — swallows the failure the test should verify",
  guidance: [
    "assert the caught error: expect(e).toBeInstanceOf(SomeError) or expect((e as Error).message).toContain(...)",
    "or replace try/catch with expect(fn).toThrow(...) / await expect(run()).rejects.toThrow(...)",
    "put `expect.assertions(1)` first, or fail after the `try` body, so a call that does not throw fails the test too",
  ],
  documentation: "#2247",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (clause) => {
      if (clause.type !== "CatchClause") return;
      let asserts = false;
      walk(clause.body, (node) => {
        if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect") {
          asserts = true;
        }
      });
      if (asserts) return;
      const { line, column } = clause.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
