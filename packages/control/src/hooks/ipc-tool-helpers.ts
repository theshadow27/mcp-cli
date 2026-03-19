import { CLAUDE_SERVER_NAME, CODEX_SERVER_NAME } from "@mcp-cli/core";
import type { AgentProvider } from "@mcp-cli/core";

/** Extract the first text content from an IPC callTool result. */
export function extractToolText(result: unknown): string | null {
  const r = result as { content?: Array<{ type: string; text: string }> } | undefined;
  return r?.content?.[0]?.text ?? null;
}

/** Map an agent provider to its virtual MCP server name. */
export function serverForProvider(provider: AgentProvider): string {
  if (provider === "codex") return CODEX_SERVER_NAME;
  return CLAUDE_SERVER_NAME;
}

/** Build a tool name for a provider (e.g. "claude_approve", "codex_bye"). */
export function toolForProvider(provider: AgentProvider, action: string): string {
  if (provider === "codex") return `codex_${action}`;
  return `claude_${action}`;
}
