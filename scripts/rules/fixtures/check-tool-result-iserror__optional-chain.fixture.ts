/**
 * @rule check-tool-result-iserror
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Optional-chaining variants: ts.isPropertyAccessExpression matches
 * both `a.b` and `a?.b`, so the rule handles these natively.
 */

async function safeWithOptionalIsError(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  if (result?.isError) throw new Error("fail");
  return result?.content[0]?.text;
}

async function safeWithOptionalUnwrap(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  return unwrapToolResult(result);
}

declare function unwrapToolResult(r: unknown): string;
