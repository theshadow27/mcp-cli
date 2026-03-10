import { ipcCall } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { extractToolText } from "../hooks/ipc-tool-helpers.js";

export interface TranscriptEntry {
  timestamp: number;
  direction: "inbound" | "outbound";
  message: Record<string, unknown>;
}

interface ClaudeSessionDetailProps {
  sessionId: string;
}

const MAX_ENTRIES = 10;

export function summarizeEntry(entry: TranscriptEntry): string {
  const msg = entry.message;
  const type = msg.type as string | undefined;

  if (type === "assistant" && msg.message) {
    const inner = msg.message as Record<string, unknown>;
    const content = inner.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => b.text as string);
      if (texts.length > 0) {
        const combined = texts.join(" ");
        return combined.length > 120 ? `${combined.slice(0, 117)}...` : combined;
      }
      const toolUses = content.filter((b: Record<string, unknown>) => b.type === "tool_use");
      if (toolUses.length > 0) {
        return `[tool: ${(toolUses[0] as Record<string, unknown>).name}]`;
      }
    }
    return "[assistant message]";
  }

  if (type === "result") {
    const text = (msg.result as string) ?? "";
    return text.length > 120 ? `${text.slice(0, 117)}...` : text || "[result]";
  }

  if (type === "tool_result" || type === "tool_use") {
    const name = (msg.name as string) ?? (msg.tool as string) ?? type;
    return `[${name}]`;
  }

  return `[${type ?? "unknown"}]`;
}

export function ClaudeSessionDetail({ sessionId }: ClaudeSessionDetailProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      try {
        const result = await ipcCall("callTool", {
          server: "_claude",
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

    fetch();
    const id = setInterval(fetch, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  if (error) {
    return (
      <Box marginLeft={4}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box marginLeft={4}>
        <Text dimColor>No transcript entries yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={4}>
      {entries.map((entry, i) => {
        const arrow = entry.direction === "outbound" ? "→" : "←";
        const color = entry.direction === "outbound" ? "cyan" : "white";
        const key = `${entry.timestamp}-${entry.direction}-${i}`;
        return (
          <Text key={key} wrap="truncate">
            <Text dimColor>{arrow}</Text> <Text color={color}>{summarizeEntry(entry)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
