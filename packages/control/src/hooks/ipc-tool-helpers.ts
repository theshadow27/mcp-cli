import { CLAUDE_SERVER_NAME, getProvider } from "@mcp-cli/core";
import type { AgentProviderName } from "@mcp-cli/core";

/** Extract the first text content from an IPC callTool result. */
export function extractToolText(result: unknown): string | null {
  const r = result as { content?: Array<{ type: string; text: string }> } | undefined;
  return r?.content?.[0]?.text ?? null;
}

/** Map an agent provider to its virtual MCP server name. */
export function serverForProvider(provider: AgentProviderName): string {
  return getProvider(provider)?.serverName ?? CLAUDE_SERVER_NAME;
}

/** Build a tool name for a provider (e.g. "claude_approve", "codex_bye"). */
export function toolForProvider(provider: AgentProviderName, action: string): string {
  const prefix = getProvider(provider)?.toolPrefix ?? "claude";
  return `${prefix}_${action}`;
}
