import type { ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface ServerDetailProps {
  server: ServerStatus;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ServerDetail({ server }: ServerDetailProps) {
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
