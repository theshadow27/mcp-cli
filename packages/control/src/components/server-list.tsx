import type { ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import { ServerDetail } from "./server-detail.js";

interface ServerListProps {
  servers: ServerStatus[];
  selectedIndex: number;
  expandedServer: string | null;
}

const stateColor: Record<ServerStatus["state"], string> = {
  connected: "green",
  connecting: "yellow",
  disconnected: "gray",
  error: "red",
};

export function ServerList({ servers, selectedIndex, expandedServer }: ServerListProps) {
  if (servers.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>No servers configured.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {servers.map((server, index) => {
        const selected = index === selectedIndex;
        const expanded = expandedServer === server.name;
        const color = stateColor[server.state];

        return (
          <Box key={server.name} flexDirection="column">
            <Text bold={selected}>
              <Text>{selected ? "> " : "  "}</Text>
              <Text bold={selected}>{server.name}</Text>
              <Text dimColor> ({server.transport})</Text>
              {"  "}
              <Text color={color}>{server.state}</Text>
              {"  "}
              <Text dimColor>[{server.toolCount} tools]</Text>
              {server.state === "error" && server.lastError && (
                <Text color="red">
                  {"  "}
                  {server.lastError.length > 40 ? `${server.lastError.slice(0, 40)}...` : server.lastError}
                </Text>
              )}
            </Text>
            {expanded && <ServerDetail server={server} />}
          </Box>
        );
      })}
    </Box>
  );
}
