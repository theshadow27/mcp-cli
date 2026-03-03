import type { ServerStatus, UsageStat } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface ServerDetailProps {
  server: ServerStatus;
  toolStats: UsageStat[];
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ServerDetail({ server, toolStats }: ServerDetailProps) {
  const totalCalls = server.callCount ?? 0;
  const totalErrors = server.errorCount ?? 0;
  const avgMs = server.avgDurationMs;
  const successRate = totalCalls > 0 ? (((totalCalls - totalErrors) / totalCalls) * 100).toFixed(1) : null;

  // Top 10 tools by call count
  const topTools = [...toolStats].sort((a, b) => b.callCount - a.callCount).slice(0, 10);

  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      <Text>
        <Text dimColor>Transport: </Text>
        <Text>{server.transport}</Text>
        <Text dimColor> | Source: </Text>
        <Text>{server.source}</Text>
      </Text>
      <Text>
        <Text dimColor>Tools: </Text>
        <Text>{server.toolCount}</Text>
        {server.lastUsed != null && (
          <Text>
            <Text dimColor> | Last used: </Text>
            <Text>{formatRelativeTime(server.lastUsed)}</Text>
          </Text>
        )}
      </Text>
      {totalCalls > 0 && (
        <Text>
          <Text dimColor>Calls: </Text>
          <Text>{totalCalls}</Text>
          {avgMs != null && (
            <Text>
              <Text dimColor> | Avg: </Text>
              <Text>{avgMs}ms</Text>
            </Text>
          )}
          {successRate !== null && (
            <Text>
              <Text dimColor> | Success: </Text>
              <Text color={totalErrors === 0 ? "green" : "yellow"}>{successRate}%</Text>
            </Text>
          )}
          {totalErrors > 0 && (
            <Text>
              <Text dimColor> | Errors: </Text>
              <Text color="red">{totalErrors}</Text>
            </Text>
          )}
        </Text>
      )}
      {topTools.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Tool breakdown:</Text>
          {topTools.map((t) => {
            const toolAvg = t.callCount > 0 ? Math.round(t.totalDurationMs / t.callCount) : 0;
            return (
              <Text key={t.toolName}>
                <Text> {t.toolName}</Text>
                <Text dimColor>
                  {" "}
                  — {t.callCount} calls, {toolAvg}ms avg
                </Text>
                {t.errorCount > 0 && <Text color="red"> ({t.errorCount} errors)</Text>}
              </Text>
            );
          })}
        </Box>
      )}
      {server.recentStderr && server.recentStderr.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Recent stderr:</Text>
          {server.recentStderr.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stderr lines are append-only
            <Text key={i} color="yellow">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      )}
      {server.lastError && (
        <Text>
          <Text dimColor>Error: </Text>
          <Text color="red">{server.lastError}</Text>
        </Text>
      )}
      <Text dimColor>Press 'r' to restart</Text>
    </Box>
  );
}
