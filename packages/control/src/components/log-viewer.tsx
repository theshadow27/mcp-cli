import type { LogEntry, ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import type { LogSource } from "../hooks/use-logs.js";

interface LogViewerProps {
  lines: LogEntry[];
  source: LogSource;
  servers: ServerStatus[];
  scrollOffset: number;
  height: number;
}

function sourceLabel(source: LogSource): string {
  return source.type === "daemon" ? "daemon" : source.name;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function LogViewer({ lines, source, servers, scrollOffset, height }: LogViewerProps) {
  // Build source tabs
  const sources: LogSource[] = [{ type: "daemon" }, ...servers.map((s) => ({ type: "server" as const, name: s.name }))];

  const currentLabel = sourceLabel(source);

  // Compute visible window
  const maxOffset = Math.max(0, lines.length - height);
  const effectiveOffset = Math.min(scrollOffset, maxOffset);
  const visible = lines.slice(effectiveOffset, effectiveOffset + height);
  const isFollowing = effectiveOffset >= maxOffset;

  return (
    <Box flexDirection="column">
      {/* Source bar */}
      <Box>
        {sources.map((s) => {
          const label = sourceLabel(s);
          const active = label === currentLabel;
          return (
            <Text key={label}>
              {"  "}
              {active ? (
                <Text color="cyan" bold>
                  [{label}]
                </Text>
              ) : (
                <Text dimColor>[{label}]</Text>
              )}
            </Text>
          );
        })}
      </Box>

      {/* Log lines */}
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Box marginLeft={2}>
            <Text dimColor>No logs for {currentLabel}</Text>
          </Box>
        ) : (
          visible.map((entry, i) => (
            <Text key={`${entry.timestamp}-${i}`}>
              <Text dimColor>{formatTime(entry.timestamp)}</Text> {entry.line}
            </Text>
          ))
        )}
      </Box>

      {/* Scroll indicator */}
      {lines.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {effectiveOffset + 1}-{Math.min(effectiveOffset + height, lines.length)} of {lines.length}
            {isFollowing ? " (following)" : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}
