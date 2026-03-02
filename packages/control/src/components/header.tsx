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
  const s = seconds % 60;

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
        {connected > 0 && <Text color="green">{connected} connected</Text>}
        {connecting > 0 && (
          <Text>
            {connected > 0 && <Text dimColor>, </Text>}
            <Text color="yellow">{connecting} connecting</Text>
          </Text>
        )}
        {errored > 0 && (
          <Text>
            {(connected > 0 || connecting > 0) && <Text dimColor>, </Text>}
            <Text color="red">{errored} error</Text>
          </Text>
        )}
        {disconnected > 0 && (
          <Text>
            {(connected > 0 || connecting > 0 || errored > 0) && <Text dimColor>, </Text>}
            <Text dimColor>{disconnected} disconnected</Text>
          </Text>
        )}
        {servers.length === 0 && <Text dimColor>none</Text>}
      </Text>

      <Text dimColor>{"─".repeat(60)}</Text>
    </Box>
  );
}
