/**
 * @rule check-tool-result-iserror
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Known blind spots: the rule does NOT flag these patterns because
 * getBindingName() cannot resolve a named Identifier binding:
 *   1. ObjectBindingPattern destructuring — VariableDeclaration.name is not an Identifier
 *   2. Inline property-access chain — PropertyAccessExpression breaks the traversal
 *
 * These patterns ARE unsafe. Always use unwrapToolResult() or
 * unwrapToolResultJson() instead. This fixture pins the boundary so
 * future rule extensions know what gaps remain.
 */

// Blind spot 1: destructuring — getBindingName walks up to VariableDeclaration
// but the name is ObjectBindingPattern, not Identifier → returns undefined → skipped.
async function destructurePattern(mcp: { callTool: Function }) {
  const { content } = (await mcp.callTool("s", "t", {})) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return content[0].text; // unsafe — not flagged due to destructuring
}

// Blind spot 2: inline property-access — callTool result is never bound to
// a named variable, so there is no binding name to scan for.
async function inlinePattern(mcp: { callTool: Function }) {
  return (
    (await mcp.callTool("s", "t", {})) as { content: Array<{ type: string; text: string }> }
  ).content[0].text; // unsafe — not flagged due to no binding
}
