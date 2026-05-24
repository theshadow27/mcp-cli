import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "no-raw-spawn",
  kind: "check",
  scold: "raw Bun.spawn/spawnSync or exitCode null-coercion — use spawnCapture() from @mcp-cli/core",
  guidance: [
    "use spawnCapture(cmd, args, opts) or spawnCaptureSync(cmd, args, opts) from packages/core/src/subprocess.ts",
    "branch on result.ok / result.timedOut — never coerce exitCode with ?? 0 or || 0",
    "the helper handles: try/catch (missing binary), stderr draining, timeout+SIGKILL, honest exit codes",
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

      const right = bin.right;
      const isZero = ts.isNumericLiteral(right) && right.text === "0";
      if (!isZero) continue;

      const pos = ast.positionOf(bin);
      violated(pos.line, pos.column, bin.getText(ast.sourceFile));
    }
  },
};

export default rule;
