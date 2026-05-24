/**
 * Rule: no-hardcoded-test-port
 *
 * Test files must not hard-code port numbers. A hardcoded port creates a
 * global resource that any concurrently running test suite can collide with,
 * causing spurious failures that are extremely difficult to reproduce or
 * diagnose. The canonical fix is `port: 0` — the OS assigns a free ephemeral
 * port and the server reports it back via `server.port` / `address().port`.
 *
 * Two patterns are flagged:
 *   1. A `port:` property in an object literal (listen/serve/connect config)
 *      initialised to a non-zero numeric literal.
 *   2. A variable whose name contains "port" (case-insensitive) initialised
 *      to a non-zero numeric literal.
 *
 * Prior incidents: #2013 (wsPort: 19275, ~94s of contention), #2005, #1670,
 * #1915, #1099.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "no-hardcoded-test-port",
  kind: "check",
  appliesToTests: true,
  scold: "hardcoded port number in test — use port: 0 and read the OS-assigned port from the server handle",
  guidance: [
    "pass port: 0 to serve()/listen()/connect() — the OS picks a free ephemeral port",
    "read the assigned port back: `server.port` (Bun), `server.address().port` (net.Server)",
    "never invent a random-port helper — they reintroduce collision risk (Bun's guide bans them)",
  ],
  documentation: "#2272",
  check({ file, violated, ast }) {
    if (!file.isTest) return;

    // Pattern 1: `port: <nonzero>` in any object literal property.
    for (const node of ast.find(ts.isPropertyAssignment)) {
      if (!isPortPropertyName(node.name)) continue;
      if (!ts.isNumericLiteral(node.initializer)) continue;
      if (Number(node.initializer.text) === 0) continue;
      const { line, column } = ast.positionOf(node.initializer);
      violated(line, column, node.initializer.text);
    }

    // Pattern 2: variable named *port* (case-insensitive) initialised to
    // a non-zero numeric literal.
    for (const node of ast.find(ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(node.name)) continue;
      if (!/port/i.test(node.name.text)) continue;
      if (!node.initializer || !ts.isNumericLiteral(node.initializer)) continue;
      if (Number(node.initializer.text) === 0) continue;
      const { line, column } = ast.positionOf(node.initializer);
      violated(line, column, node.initializer.text);
    }
  },
};

function isPortPropertyName(name: ts.PropertyName): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "port";
}

export default rule;
