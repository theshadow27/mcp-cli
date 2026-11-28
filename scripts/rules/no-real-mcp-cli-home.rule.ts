/**
 * Rule: no-real-mcp-cli-home
 *
 * Nothing outside `packages/core/src/constants.ts` may build a path into the
 * real `~/.mcp-cli` home directory — the socket, database, PID file, and
 * config the *production* daemon uses. Every legitimate consumer must go
 * through `options.MCP_CLI_DIR` (mutable, respects the `MCP_CLI_DIR` env
 * override and every test's per-run override) instead of re-deriving the
 * path from `homedir()`.
 *
 * Two shapes are flagged:
 *
 *   1. `homedir()` combined with a `".mcp-cli"` string literal as sibling
 *      arguments to the same `join()`/`resolve()` call — e.g.
 *      `join(homedir(), ".mcp-cli", "vendor")`. This bypasses MCP_CLI_DIR
 *      entirely: a test (or a differently-configured install) that sets
 *      MCP_CLI_DIR to an isolated directory still lands on the real home.
 *      This is exactly the #3233 bug: `resolve-playwright.ts` hardcoded its
 *      vendor dir this way, so a real (non-DI'd) call would have installed
 *      playwright into the production `~/.mcp-cli/vendor/playwright`.
 *
 *   2. A hardcoded absolute real-home path (`/home/<user>/.mcp-cli...` or
 *      `/Users/<user>/.mcp-cli...`) passed directly as a call argument —
 *      i.e. actually used to touch the filesystem, not just prose. Tilde
 *      form (`~/.mcp-cli/...`) and doc/help strings are intentionally NOT
 *      flagged: `~` is not expanded by Node's fs functions, so a literal
 *      `~/.mcp-cli` string is virtually always documentation or a
 *      human-facing message, not a real path in use. Restricting to call
 *      arguments also excludes object-literal fixture data (e.g. a
 *      `{ filePath: "/home/user/.mcp-cli/..." }` test row) that never
 *      reaches the filesystem.
 *
 * Suppression: `// doing-it-wrong-ignore no-real-mcp-cli-home: <reason>` — expected
 * to be rare; the intended fix is almost always "read options.MCP_CLI_DIR
 * instead", not a suppression.
 *
 * See #3233 (tests/gates touching the real, production ~/.mcp-cli) and its
 * parent epic #3231 ("no daemon interruption").
 */

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

/** The name a call is made through: `name()`, `obj.name()` or `obj["name"]()`. */
function calleeName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
  if (callee.computed && callee.property.type === "Literal" && typeof callee.property.value === "string") {
    return callee.property.value;
  }
  return undefined;
}

/** The one file allowed to derive MCP_CLI_DIR from homedir() — everyone else must read options.MCP_CLI_DIR. */
const CANONICAL_FILES = new Set(["packages/core/src/constants.ts"]);

/** Absolute path into a real user's home directory's .mcp-cli — never a tilde form or a synthetic test path. */
const REAL_HOME_MCP_CLI = /^\/(home|Users)\/[^/]+\/\.mcp-cli(\/|$)/;

/** The text of a plain string literal or a template literal with no substitutions. */
function plainString(node: TSESTree.Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export default {
  id: "no-real-mcp-cli-home",
  type: "check",
  category: "architecture",
  ast: true,
  scold: "builds a path into the real ~/.mcp-cli home directory instead of reading options.MCP_CLI_DIR — see #3233",
  guidance: [
    'read options.MCP_CLI_DIR (from "@mcp-cli/core") instead of homedir() + ".mcp-cli" — it is mutable and respects the MCP_CLI_DIR env override and every test\'s per-run override',
    "if you need the path at module scope, wrap it in a function so it is read lazily — a module-level const computed at import time freezes in whatever MCP_CLI_DIR was set first and ignores every later override (see packages/core/src/constants.ts's `options` object and its doc comment)",
    "in tests, isolate via test/test-options.ts's testOptions() (in-process) or by spawning a subprocess with an explicit MCP_CLI_DIR env override (see test/harness.ts)",
    "suppress with // doing-it-wrong-ignore no-real-mcp-cli-home: <reason> (#issue) only if this genuinely is the canonical constants.ts definition",
  ],
  documentation: "#3233",
  check(ctx) {
    const { file } = ctx;
    if (CANONICAL_FILES.has(file.relativePath)) return ctx.skipped();

    walk(ctx.ast().program, (node) => {
      // Pattern 1: homedir() and a ".mcp-cli" string literal as sibling
      // arguments to the same join()/resolve() call.
      if (node.type === "CallExpression") {
        const name = calleeName(node);
        if (name === "join" || name === "resolve") {
          const hasHomedirArg = node.arguments.some((a) => a.type === "CallExpression" && calleeName(a) === "homedir");
          if (hasHomedirArg && node.arguments.some((a) => plainString(a) === ".mcp-cli")) {
            ctx.violated(
              node.loc.start.line,
              node.loc.start.column + 1,
              file.content.slice(...node.range).slice(0, 100),
            );
          }
        }
      }

      // Pattern 2: a hardcoded absolute real-home .mcp-cli path used directly
      // as a call argument (join/readFileSync/existsSync/... — anything that
      // could touch the filesystem).
      if (node.type === "Literal" && typeof node.value === "string" && REAL_HOME_MCP_CLI.test(node.value)) {
        const parent = node.parent;
        if (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
          ctx.violated(node.loc.start.line, node.loc.start.column + 1, node.value);
        }
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
