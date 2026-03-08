import { ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";
import { extractToolText } from "./ipc-tool-helpers.js";

// Mirror the daemon's SessionInfo shape (from claude-session/ws-server.ts)
export type SessionStateEnum = "connecting" | "init" | "active" | "waiting_permission" | "result" | "idle" | "ended";

export interface PendingPermissionInfo {
  requestId: string;
  toolName: string;
  inputSummary: string;
}

export interface ClaudeSession {
  sessionId: string;
  state: SessionStateEnum;
  model: string | null;
  cwd: string | null;
  cost: number;
  tokens: number;
  numTurns: number;
  pendingPermissions: number;
  pendingPermissionDetails: PendingPermissionInfo[];
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

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const result = await ipcCall("callTool", {
          server: "_claude",
          tool: "claude_session_list",
          arguments: {},
        });

        if (cancelled) return;

        const text = extractToolText(result);
        if (text) {
          setSessions(JSON.parse(text) as ClaudeSession[]);
        } else {
          setSessions([]);
        }
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

    poll();
    const id = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);

  return { sessions, loading, error };
}
