import { Box, Text } from "ink";
import React from "react";

export interface TranscriptEntry {
  timestamp: number;
  direction: "inbound" | "outbound";
  message: Record<string, unknown>;
}

interface ClaudeSessionDetailProps {
  entries: TranscriptEntry[];
  error: string | null;
  selectedEntry: number;
  expandedEntries: ReadonlySet<number>;
}

/** Extract a short summary of the tool input for display. */
function summarizeToolInput(toolUse: Record<string, unknown>): string {
  const input = toolUse.input as Record<string, unknown> | undefined;
  if (!input) return "";
  // For common tools, show the most relevant field
  const command = input.command as string | undefined;
  if (command) return command;
  const file_path = input.file_path as string | undefined;
  if (file_path) return file_path;
  const pattern = input.pattern as string | undefined;
  if (pattern) return pattern;
  const query = input.query as string | undefined;
  if (query) return query;
  // Fallback: compact JSON of first key
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  const firstVal = input[keys[0]];
  if (typeof firstVal === "string") return firstVal;
  return JSON.stringify(input).slice(0, 60);
}

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
        const tool = toolUses[0] as Record<string, unknown>;
        const name = tool.name as string;
        const inputSummary = summarizeToolInput(tool);
        if (inputSummary) {
          const maxLen = 80 - name.length - 4; // [Name: ...]
          const truncated = inputSummary.length > maxLen ? `${inputSummary.slice(0, maxLen - 3)}...` : inputSummary;
          return `[${name}: ${truncated}]`;
        }
        return `[${name}]`;
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

/** Format a transcript entry's full content for expanded view. */
export function formatFullEntry(entry: TranscriptEntry): string {
  const msg = entry.message;
  const type = msg.type as string | undefined;

  if (type === "assistant" && msg.message) {
    const inner = msg.message as Record<string, unknown>;
    const content = inner.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          parts.push(b.text as string);
        } else if (b.type === "tool_use") {
          const name = b.name as string;
          const input = b.input as Record<string, unknown> | undefined;
          parts.push(`[tool_use: ${name}]`);
          if (input) {
            parts.push(JSON.stringify(input, null, 2));
          }
        }
      }
      return parts.join("\n");
    }
  }

  if (type === "result") {
    return (msg.result as string) ?? "[empty result]";
  }

  // Fallback: JSON dump
  return JSON.stringify(msg, null, 2);
}

const MAX_EXPANDED_LINES = 20;

function ExpandedContent({ entry }: { entry: TranscriptEntry }) {
  const full = formatFullEntry(entry);
  const lines = full.split("\n");
  const shown = lines.slice(0, MAX_EXPANDED_LINES);
  const remaining = lines.length - MAX_EXPANDED_LINES;

  return (
    <Box marginLeft={3} flexDirection="column">
      {shown.map((line, idx) => (
        <Text key={`${entry.timestamp}-${idx}`} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
      {remaining > 0 && (
        <Text dimColor italic>
          ... ({remaining} more lines)
        </Text>
      )}
    </Box>
  );
}

export function ClaudeSessionDetail({ entries, error, selectedEntry, expandedEntries }: ClaudeSessionDetailProps) {
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
        const selected = i === selectedEntry;
        const expanded = expandedEntries.has(i);

        return (
          <Box key={key} flexDirection="column">
            <Text wrap="truncate">
              <Text dimColor>{selected ? "▸" : " "}</Text>
              <Text dimColor>{arrow}</Text> <Text color={color}>{summarizeEntry(entry)}</Text>
            </Text>
            {expanded && <ExpandedContent entry={entry} />}
          </Box>
        );
      })}
    </Box>
  );
}
