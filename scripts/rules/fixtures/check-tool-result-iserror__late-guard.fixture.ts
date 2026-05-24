/**
 * @rule check-tool-result-iserror
 * @expect 1
 * @path packages/daemon/src/example.ts
 *
 * isError check appears AFTER .content access — not a valid guard.
 * The content is already consumed unsafely before the check.
 */

async function lateGuard(mcp: { callTool: Function }) {
  const result = await mcp.callTool("server", "tool", {});
  const data = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error("too late");
  return data;
}
