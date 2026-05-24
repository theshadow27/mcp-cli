/**
 * Rule: no-hardcoded-test-port
 *
 * Test files must not hard-code port numbers. A hardcoded port creates a
 * global resource that any concurrently running test suite can collide with,
 * causing spurious failures that are extremely difficult to reproduce or
 * diagnose. The canonical fix is `port: 0` — the OS assigns a free ephemeral
 * port and the server reports it back via `server.port` / `address().port`.
 *
 * Two patterns are flagged (test files only):
 *
 *   1. A `port:` property in an ObjectLiteralExpression that is a **direct
 *      argument** to a known server-construction call (serve/listen/
 *      createServer). Plain data objects, mock structs, and assertion arguments
 *      are excluded.
 *
 *   2. A variable whose name contains "port" as a **whole word** (splits on
 *      camelCase and underscore boundaries) initialised to a non-zero numeric
 *      literal. This catches `wsPort = 8080` but not `transport = 8080` or
 *      `reportCount = 3`.
 *
 * Suppression: `// dotw-ignore no-hardcoded-test-port: <reason>` on the
 * preceding line (e.g. OAuth callback mock where the port matches the URL).
 *
 * Prior incidents: #2013 (wsPort: 19275, ~94s of contention), #2005, #1670,
 * #1915, #1099.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

// Call/constructor names whose first object-literal argument is a server config.
const SERVER_CALL_NAMES = new Set(["serve", "listen", "createServer"]);

const rule: CheckRule = {
  id: "no-hardcoded-test-port",
  kind: "check",
  appliesToTests: true,
  scold: "hardcoded port number in test — use port: 0 and read the OS-assigned port from the server handle",
  guidance: [
    "pass port: 0 to serve()/listen() — the OS picks a free ephemeral port",
    "read the assigned port back: `server.port` (Bun), `server.address().port` (net.Server)",
    "never invent a random-port helper — they reintroduce collision risk (Bun's guide bans them)",
    "if a fixed port is truly required (e.g. OAuth redirect-URI), add: // dotw-ignore no-hardcoded-test-port: <reason>",
  ],
  documentation: "#2272",
  check({ file, violated, ast }) {
    // Pattern 1: `port: <nonzero>` as a direct property of an object literal
    // passed to a known server-construction call/constructor.
    // Excludes: mock structs, return objects, assertion arguments.
    for (const node of ast.find(ts.isPropertyAssignment)) {
      if (!isPortPropertyName(node.name)) continue;
      if (!ts.isNumericLiteral(node.initializer)) continue;
      if (Number(node.initializer.text) === 0) continue;
      if (!isDirectServerCallArg(node)) continue;
      const { line, column } = ast.positionOf(node.initializer);
      violated(line, column, node.initializer.text);
    }

    // Pattern 2: variable named *port* (as a whole word) initialised to a
    // non-zero numeric literal. Word-splits camelCase and SCREAMING_SNAKE so
    // `transport`, `report`, `support` are not matched.
    for (const node of ast.find(ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(node.name)) continue;
      if (!isPortWordInName(node.name.text)) continue;
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

/**
 * Return true when the PropertyAssignment's object literal is a direct
 * argument to a known server-construction call or `new` expression.
 * Requires parent nodes (setParentNodes=true, enabled since #2308).
 */
function isDirectServerCallArg(node: ts.PropertyAssignment): boolean {
  if (node.parent === undefined) {
    throw new Error("no-hardcoded-test-port: parent nodes not set — ensure setParentNodes=true in createAstHelper");
  }
  if (!ts.isObjectLiteralExpression(node.parent)) return false;
  const callOrNew = node.parent.parent;
  if (!ts.isCallExpression(callOrNew) && !ts.isNewExpression(callOrNew)) return false;
  const expr = callOrNew.expression;
  const callee = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
  return callee !== null && SERVER_CALL_NAMES.has(callee);
}

/**
 * Return true when "port" is a whole word inside `name` after splitting
 * on camelCase and underscore/SCREAMING_SNAKE boundaries.
 * Examples that match:   port, PORT, wsPort, WS_PORT, httpPort, portNumber
 * Examples that don't:   transport, report, support, reportCount
 */
function isPortWordInName(name: string): boolean {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2") // ABCDef → ABC_Def
    .replace(/([a-z])([A-Z])/g, "$1_$2") // wsPort → ws_Port
    .toLowerCase()
    .split("_");
  return words.includes("port");
}

export default rule;
