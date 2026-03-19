import { CLAUDE_SERVER_NAME, CODEX_SERVER_NAME, ipcCall } from "@mcp-cli/core";
import type { AgentSessionInfo } from "@mcp-cli/core";
import { useEffect, useState } from "react";
import { extractToolText } from "./ipc-tool-helpers.js";

interface UseAgentSessionsResult {
  sessions: AgentSessionInfo[];
  loading: boolean;
  error: string | null;
}

export interface UseAgentSessionsOptions {
  intervalMs?: number;
  enabled?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/** Fetch sessions from a single provider, swallowing errors so one offline provider doesn't block others. */
async function fetchProviderSessions(
  ipcCallFn: typeof ipcCall,
  server: string,
  tool: string,
): Promise<AgentSessionInfo[]> {
  try {
    const result = await ipcCallFn("callTool", { server, tool, arguments: {} });
    const text = extractToolText(result);
    return text ? (JSON.parse(text) as AgentSessionInfo[]) : [];
  } catch {
    return [];
  }
}

export function useAgentSessions(opts: UseAgentSessionsOptions = {}): UseAgentSessionsResult {
  const { intervalMs = 2500, enabled = true, ipcCallFn = ipcCall } = opts;
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const [claudeSessions, codexSessions] = await Promise.all([
          fetchProviderSessions(ipcCallFn, CLAUDE_SERVER_NAME, "claude_session_list"),
          fetchProviderSessions(ipcCallFn, CODEX_SERVER_NAME, "codex_session_list"),
        ]);

        if (cancelled) return;

        setSessions([...claudeSessions, ...codexSessions]);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelled) {
        timerId = setTimeout(scheduleNext, intervalMs);
      }
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [intervalMs, enabled, ipcCallFn]);

  return { sessions, loading, error };
}
