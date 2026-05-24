/**
 * @rule check-tool-result-iserror
 * @expect 0
 * @path packages/daemon/src/example.ts
 *
 * Safe patterns: unwrapToolResult helper, explicit isError guard,
 * and non-callTool content access.
 */

// --- Safe: uses unwrapToolResult ---
async function safeWithHelper(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  const text = unwrapToolResult(result);
  return text;
}

// --- Safe: explicit isError check before .content ---
async function safeWithGuard(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  if (result.isError) {
    throw new Error(result.content[0].text);
  }
  return result.content[0].text;
}

// --- Safe: uses unwrapToolResultJson ---
async function safeWithJsonHelper(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  return unwrapToolResultJson(result);
}

// --- Not a callTool result — should not be flagged ---
function notCallTool() {
  const obj = { content: [{ text: "hello" }] };
  return obj.content[0].text;
}

declare function unwrapToolResult(r: unknown): string;
declare function unwrapToolResultJson(r: unknown): unknown;
