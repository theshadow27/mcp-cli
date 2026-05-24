/**
 * @rule check-tool-result-iserror
 * @expect 1
 * @path packages/daemon/src/example.ts
 *
 * Unsafe pattern: .content accessed on a callTool result without
 * checking isError or using unwrapToolResult.
 */

async function unsafeDirect(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  const data = JSON.parse(result.content[0].text);
  return data;
}
