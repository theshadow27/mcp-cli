import { CLAUDE_SERVER_NAME, ipcCall } from "@mcp-cli/core";
import { useEffect, useState } from "react";
import type { TranscriptEntry } from "../components/claude-session-detail.js";
import { extractToolText } from "./ipc-tool-helpers.js";

const MAX_ENTRIES = 10;

export interface UseTranscriptOptions {
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

export function useTranscript(
  sessionId: string | null,
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
          server: CLAUDE_SERVER_NAME,
          tool: "claude_transcript",
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
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, ipcCallFn]);

  return { entries, error };
}
