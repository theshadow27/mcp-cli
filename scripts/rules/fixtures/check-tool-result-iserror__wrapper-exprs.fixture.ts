/**
 * @rule check-tool-result-iserror
 * @expect 1
 * @path packages/daemon/src/example.ts
 *
 * callTool() result assigned through expression wrappers (as-cast,
 * non-null assertion) — the rule must still detect the binding and
 * flag the unguarded .content access.
 */

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function withAsCast(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {}) as ToolResult;
  return result.content[0].text;
}
