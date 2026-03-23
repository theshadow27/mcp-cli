import type { ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

export interface AuthStatus {
  server: string;
  state: "pending" | "success" | "error";
  message?: string;
}

interface AuthBannerProps {
  servers: ServerStatus[];
  authStatus: AuthStatus | null;
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

export function AuthBanner({ servers, authStatus }: AuthBannerProps) {
  if (servers.length === 0 && !authStatus) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {authStatus?.state === "pending" && (
        <Text color="yellow">
          {"⏳ Authenticating "}
          <Text bold>{authStatus.server}</Text>
          {"... (check browser)"}
        </Text>
      )}
      {authStatus?.state === "success" && (
        <Text color="green">
          {"✓  Authenticated "}
          <Text bold>{authStatus.server}</Text>
        </Text>
      )}
      {authStatus?.state === "error" && (
        <Text color="red">
          {"✗  Auth failed for "}
          <Text bold>{authStatus.server}</Text>
          {authStatus.message && <Text>: {Bun.sliceAnsi(authStatus.message, 0, 60)}</Text>}
        </Text>
      )}
      {servers.map((server) => (
        <Box key={server.name} flexDirection="column">
          <Text color="yellow">
            {"⚠  Authentication required: "}
            <Text bold>{server.name}</Text>
            {server.lastError && <Text> ({Bun.sliceAnsi(server.lastError, 0, 50)})</Text>}
          </Text>
          <Text dimColor> Press a or run: mcx auth {server.name}</Text>
        </Box>
      ))}
    </Box>
  );
}
