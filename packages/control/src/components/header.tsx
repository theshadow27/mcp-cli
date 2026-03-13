import type { DaemonStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface HeaderProps {
  status: DaemonStatus | null;
  error: string | null;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function Header({ status, error }: HeaderProps) {
  const servers = status?.servers ?? [];
  const connected = servers.filter((s) => s.state === "connected").length;
  const errored = servers.filter((s) => s.state === "error").length;
  const disconnected = servers.filter((s) => s.state === "disconnected").length;
  const connecting = servers.filter((s) => s.state === "connecting").length;

  const usageStats = status?.usageStats ?? [];
  const totalCalls = usageStats.reduce((sum, s) => sum + s.callCount, 0);
  const totalErrors = usageStats.reduce((sum, s) => sum + s.errorCount, 0);
  const successRate = totalCalls > 0 ? (((totalCalls - totalErrors) / totalCalls) * 100).toFixed(1) : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        mcpctl — MCP CLI Control Panel
      </Text>

      {status ? (
        <Text>
          <Text dimColor>Daemon: </Text>
          <Text>PID {status.pid}</Text>
          <Text dimColor> | </Text>
          <Text>Uptime: {formatUptime(status.uptime)}</Text>
          <Text dimColor> | </Text>
          <Text>DB: {status.dbPath}</Text>
        </Text>
      ) : error ? (
        <Text color="red">Daemon: {error}</Text>
      ) : null}

      <Text>
        <Text dimColor>Servers: </Text>
        {servers.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          [
            connected > 0 && (
              <Text key="connected" color="green">
                {connected} connected
              </Text>
            ),
            connecting > 0 && (
              <Text key="connecting" color="yellow">
                {connecting} connecting
              </Text>
            ),
            errored > 0 && (
              <Text key="errored" color="red">
                {errored} error
              </Text>
            ),
            disconnected > 0 && (
              <Text key="disconnected" dimColor>
                {disconnected} disconnected
              </Text>
            ),
          ]
            .filter(Boolean)
            .map((el, i, arr) => (
              <React.Fragment key={(el as React.ReactElement).key}>
                {i > 0 && <Text dimColor>, </Text>}
                {el}
              </React.Fragment>
            ))
        )}
      </Text>

      {totalCalls > 0 && (
        <Text>
          <Text dimColor>Usage: </Text>
          <Text>{totalCalls} calls</Text>
          {totalErrors > 0 && (
            <Text>
              <Text dimColor>, </Text>
              <Text color="red">{totalErrors} errors</Text>
            </Text>
          )}
          {successRate !== null && (
            <Text>
              <Text dimColor> | </Text>
              <Text color={totalErrors === 0 ? "green" : "yellow"}>{successRate}% success</Text>
            </Text>
          )}
        </Text>
      )}

      <Text dimColor>{"─".repeat(60)}</Text>
    </Box>
  );
}
