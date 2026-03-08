import { ipcCall } from "@mcp-cli/core";
import { useCallback, useEffect, useState } from "react";
import { extractToolText } from "./ipc-tool-helpers.js";

// Mirror the daemon's SessionInfo shape (from claude-session/ws-server.ts)
export type SessionStateEnum = "connecting" | "init" | "active" | "waiting_permission" | "result" | "idle" | "ended";

export interface ClaudeSession {
  sessionId: string;
  state: SessionStateEnum;
  model: string | null;
  cwd: string | null;
  cost: number;
  tokens: number;
  numTurns: number;
  pendingPermissions: number;
  worktree: string | null;
}

interface UseClaudeSessionsResult {
  sessions: ClaudeSession[];
  loading: boolean;
  error: string | null;
}

export function useClaudeSessions(intervalMs = 2500, enabled = true): UseClaudeSessionsResult {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await ipcCall("callTool", {
        server: "_claude",
        tool: "claude_session_list",
        arguments: {},
      });

      const text = extractToolText(result);
      if (text) {
        setSessions(JSON.parse(text) as ClaudeSession[]);
      } else {
        setSessions([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function doPoll() {
      if (cancelled) return;
      await poll();
    }

    doPoll();
    const id = setInterval(doPoll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, poll, enabled]);

  return { sessions, loading, error };
}
