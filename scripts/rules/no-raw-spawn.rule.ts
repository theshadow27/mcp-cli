import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

/** `a?.b` is a ChainExpression around the member access; look through it. */
function unchain(node: TSESTree.Node): TSESTree.Node {
  return node.type === "ChainExpression" ? node.expression : node;
}

function memberName(node: TSESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return undefined;
}

export default {
  id: "no-raw-spawn",
  type: "check",
  category: "architecture",
  ast: true,
  scold: "raw Bun.spawn/spawnSync or exitCode null-coercion — use spawnCapture/spawnManaged from @mcp-cli/core",
  guidance: [
    "use spawnCapture / spawnCaptureSync from @mcp-cli/core for capture-and-wait (run a command, collect output, check result). Use spawnManaged for long-lived processes whose handle you retain (streaming stdin/stdout, kill, exit monitoring). The point is to NOT relitigate the spawn corner cases at every call site: raw Bun.spawn THROWS on a missing binary instead of returning, a full stderr pipe can deadlock the child unless drained, a hung child needs timeout → SIGTERM → SIGKILL escalation, and exitCode is null when the process never ran (so ?? 0 / || 0 silently reports failure as success). Both helpers solve all of these once.",
    "if either helper lacks an option you need, EXTEND THE HELPER — adding it once fixes every call site. Re-implementing raw spawn to get one missing option means re-owning every corner case above, for everyone. A missing option is NOT a reason to suppress.",
    'suppress with // doing-it-wrong-ignore no-raw-spawn: <reason> (#issue) ONLY when the spawn is fundamentally not capture-and-wait AND not a managed long-lived process: interactive stdio:"inherit" (pager/editor), fire-and-forget (no handle retained), or file-redirect stdout/stderr (Bun.file). If you retain a handle for streaming, kill, or exit monitoring, use spawnManaged instead of suppressing.',
  ],
  documentation: "#2269",
  tests: "exclude",

  check(ctx) {
    const { file } = ctx;
    const inScope = file.relativePath.startsWith("packages/") && file.relativePath.includes("/src/");
    if (!inScope) return ctx.skipped();

    const isSelf = file.relativePath.endsWith("/subprocess.ts");
    const text = (node: TSESTree.Node) => file.content.slice(...node.range);
    const report = (node: TSESTree.Node, snippet: string) =>
      ctx.violated(node.loc.start.line, node.loc.start.column + 1, snippet);

    walk(ctx.ast().program, (node) => {
      if (!isSelf && node.type === "CallExpression") {
        const callee = unchain(node.callee);
        if (callee.type === "MemberExpression") {
          const name = memberName(callee);
          if (
            (name === "spawn" || name === "spawnSync") &&
            callee.object.type === "Identifier" &&
            callee.object.name === "Bun"
          ) {
            report(node, text(node).slice(0, 80));
          }
        }
      }

      if (node.type === "LogicalExpression" && (node.operator === "??" || node.operator === "||")) {
        const left = unchain(node.left);
        const isExitCode =
          (left.type === "Identifier" && left.name === "exitCode") ||
          (left.type === "MemberExpression" && memberName(left) === "exitCode");
        if (!isExitCode) return;
        if (left.type === "MemberExpression" && left.object.type === "Identifier" && left.object.name === "process")
          return;
        const right = node.right;
        if (right.type !== "Literal" || right.raw !== "0") return;
        report(node, text(node));
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
