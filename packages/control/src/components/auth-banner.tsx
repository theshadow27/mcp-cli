import type { ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface AuthBannerProps {
  servers: ServerStatus[];
}

export function isAuthError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("auth") ||
    lower.includes("token") ||
    lower.includes("oauth") ||
    lower.includes("unauthorized")
  );
}

export function AuthBanner({ servers }: AuthBannerProps) {
  if (servers.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {servers.map((server) => (
        <Box key={server.name} flexDirection="column">
          <Text color="yellow">
            {"⚠  Authentication required: "}
            <Text bold>{server.name}</Text>
            {server.lastError && <Text> ({server.lastError.slice(0, 50)})</Text>}
          </Text>
          <Text dimColor> Run: mcp auth {server.name}</Text>
        </Box>
      ))}
    </Box>
  );
}
