import type { AgentProvider } from "@mcp-cli/core";

export type CallToolFn = (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface PromptResult {
  sessionId: string;
  text: string;
  raw: unknown;
}

export function extractText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return String(raw);
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return JSON.stringify(raw);

  const parts: string[] = [];
  for (const item of obj.content) {
    if (typeof item === "object" && item !== null && "text" in item) {
      parts.push(String((item as { text: unknown }).text));
    }
  }
  return parts.join("\n");
}

export function extractSessionId(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.sessionId === "string") return parsed.sessionId;
  } catch {
    // not JSON — try regex fallback
  }
  const match = text.match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "";
}

function isErrorResult(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return (raw as Record<string, unknown>).isError === true;
}

export async function promptAndWait(
  provider: AgentProvider,
  opts: { task: string; cwd: string; callTool: CallToolFn },
): Promise<PromptResult> {
  const raw = await opts.callTool(provider.serverName, `${provider.toolPrefix}_prompt`, {
    prompt: opts.task,
    cwd: opts.cwd,
    wait: true,
  });

  const text = extractText(raw);
  if (isErrorResult(raw)) {
    throw new Error(`prompt failed: ${text}`);
  }

  const sessionId = extractSessionId(text);
  return { sessionId, text, raw };
}

export async function promptNoWait(
  provider: AgentProvider,
  opts: { task: string; cwd: string; callTool: CallToolFn },
): Promise<{ sessionId: string }> {
  const raw = await opts.callTool(provider.serverName, `${provider.toolPrefix}_prompt`, {
    prompt: opts.task,
    cwd: opts.cwd,
  });

  const text = extractText(raw);
  if (isErrorResult(raw)) {
    throw new Error(`prompt failed: ${text}`);
  }

  const sessionId = extractSessionId(text);
  if (!sessionId) throw new Error("no sessionId in prompt response");
  return { sessionId };
}

export async function promptFollowUp(
  provider: AgentProvider,
  opts: { sessionId: string; task: string; cwd: string; callTool: CallToolFn },
): Promise<PromptResult> {
  const raw = await opts.callTool(provider.serverName, `${provider.toolPrefix}_prompt`, {
    prompt: opts.task,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    wait: true,
  });

  const text = extractText(raw);
  if (isErrorResult(raw)) {
    throw new Error(`follow-up prompt failed: ${text}`);
  }

  return { sessionId: opts.sessionId, text, raw };
}

export async function byeSession(provider: AgentProvider, sessionId: string, callTool: CallToolFn): Promise<void> {
  await callTool(provider.serverName, `${provider.toolPrefix}_bye`, { sessionId });
}
