import { ipcCall } from "@mcp-cli/core";
import type { AgentProviderName } from "@mcp-cli/core";
import { useEffect, useState } from "react";
import type { TranscriptEntry } from "../components/agent-session-detail";
import { extractToolText, serverForProvider, toolForProvider } from "./ipc-tool-helpers";

const MAX_ENTRIES = 10;
const TRANSCRIPT_POLL_INTERVAL_MS = 3_000;

export interface UseTranscriptOptions {
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useTranscript(
  sessionId: string | null,
  provider: AgentProviderName = "claude",
  opts: UseTranscriptOptions = {},
): {
  entries: TranscriptEntry[];
  error: string | null;
} {
  const { ipcCallFn = ipcCall } = opts;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setError(null);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const result = await ipcCallFn("callTool", {
          server: serverForProvider(provider),
          tool: toolForProvider(provider, "transcript"),
          arguments: { sessionId, limit: MAX_ENTRIES },
        });

        if (cancelled) return;

        const text = extractToolText(result);
        if (text) {
          setEntries(JSON.parse(text) as TranscriptEntry[]);
        }
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    poll();
    const id = setInterval(poll, TRANSCRIPT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, provider, ipcCallFn]);

  return { entries, error };
}
