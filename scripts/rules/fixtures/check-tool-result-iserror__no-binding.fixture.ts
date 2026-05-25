/**
 * @rule check-tool-result-iserror
 * @expect 2
 * @path packages/daemon/src/example.ts
 *
 * Both patterns are unsafe: .content accessed from a callTool() result
 * without an isError guard or unwrapToolResult wrapper.
 */

// Destructuring: content extracted via ObjectBindingPattern without isError check.
async function destructurePattern(mcp: { callTool: Function }) {
  const { content } = (await mcp.callTool("s", "t", {})) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return content[0].text;
}

// Inline chain: .content accessed directly on the callTool() result expression.
async function inlinePattern(mcp: { callTool: Function }) {
  return (
    (await mcp.callTool("s", "t", {})) as { content: Array<{ type: string; text: string }> }
  ).content[0].text;
}
