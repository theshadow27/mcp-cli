import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "no-raw-spawn",
  kind: "check",
  scold: "raw Bun.spawn/spawnSync or exitCode null-coercion — use spawnCapture/spawnManaged from @mcp-cli/core",
  guidance: [
    "use spawnCapture / spawnCaptureSync from @mcp-cli/core for capture-and-wait (run a command, collect output, check result). Use spawnManaged for long-lived processes whose handle you retain (streaming stdin/stdout, kill, exit monitoring). The point is to NOT relitigate the spawn corner cases at every call site: raw Bun.spawn THROWS on a missing binary instead of returning, a full stderr pipe can deadlock the child unless drained, a hung child needs timeout → SIGTERM → SIGKILL escalation, and exitCode is null when the process never ran (so ?? 0 / || 0 silently reports failure as success). Both helpers solve all of these once.",
    "if either helper lacks an option you need, EXTEND THE HELPER — adding it once fixes every call site. Re-implementing raw spawn to get one missing option means re-owning every corner case above, for everyone. A missing option is NOT a reason to suppress.",
    'suppress with // dotw-ignore no-raw-spawn: <reason> ONLY when the spawn is fundamentally not capture-and-wait AND not a managed long-lived process: interactive stdio:"inherit" (pager/editor), fire-and-forget (no handle retained), or file-redirect stdout/stderr (Bun.file). If you retain a handle for streaming, kill, or exit monitoring, use spawnManaged instead of suppressing.',
  ],
  documentation: "#2269",
  appliesToTests: false,

  check({ file, violated, ast }) {
    const inScope = file.relPath.startsWith("packages/") && file.relPath.includes("/src/");
    if (!inScope) return;

    const isSelf = file.relPath.endsWith("/subprocess.ts");

    if (!isSelf) {
      for (const call of [...ast.callsTo("spawn"), ...ast.callsTo("spawnSync")]) {
        const expr = call.expression;
        if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Bun") {
          const pos = ast.positionOf(call);
          violated(pos.line, pos.column, call.getText(ast.sourceFile).slice(0, 80));
        }
      }
    }

    for (const bin of ast.find(ts.isBinaryExpression)) {
      const op = bin.operatorToken.kind;
      if (op !== ts.SyntaxKind.QuestionQuestionToken && op !== ts.SyntaxKind.BarBarToken) continue;

      const left = bin.left;
      const isExitCode =
        (ts.isIdentifier(left) && left.text === "exitCode") ||
        (ts.isPropertyAccessExpression(left) && left.name.text === "exitCode");
      if (!isExitCode) continue;

      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "process")
        continue;

      const right = bin.right;
      const isZero = ts.isNumericLiteral(right) && right.text === "0";
      if (!isZero) continue;

      const pos = ast.positionOf(bin);
      violated(pos.line, pos.column, bin.getText(ast.sourceFile));
    }
  },
};

export default rule;
