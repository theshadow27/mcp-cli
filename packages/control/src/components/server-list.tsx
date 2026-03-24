import type { ServeInstanceInfo, ServerStatus, UsageStat } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import { ServerDetail } from "./server-detail.js";

interface ServerListProps {
  servers: ServerStatus[];
  selectedIndex: number;
  expandedServer: string | null;
  usageStats: UsageStat[];
  serveInstances?: ServeInstanceInfo[];
}

const stateColor: Record<ServerStatus["state"], string> = {
  connected: "green",
  connecting: "yellow",
  disconnected: "gray",
  error: "red",
};

/** Format millisecond duration as human-readable uptime. */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? `${rm}m` : ""}`;
}

export function ServerList({ servers, selectedIndex, expandedServer, usageStats, serveInstances }: ServerListProps) {
  const instances = serveInstances ?? [];

  if (servers.length === 0 && instances.length === 0) {
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
              {(server.callCount ?? 0) > 0 && (
                <Text>
                  {"  "}
                  <Text dimColor>{server.callCount} calls</Text>
                </Text>
              )}
              {server.state === "error" && server.lastError && (
                <Text color="red">
                  {"  "}
                  {Bun.stringWidth(server.lastError) > 40
                    ? `${Bun.sliceAnsi(server.lastError, 0, 40)}...`
                    : server.lastError}
                </Text>
              )}
            </Text>
            {expanded && (
              <ServerDetail server={server} toolStats={usageStats.filter((s) => s.serverName === server.name)} />
            )}
          </Box>
        );
      })}
      {instances.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text bold dimColor>
              Serve Instances ({instances.length})
            </Text>
          </Box>
          {instances.map((inst) => {
            const uptime = formatUptime(Date.now() - inst.startedAt);
            const toolLabel = inst.tools.length > 0 ? inst.tools.join(", ") : "discovery only";
            return (
              <Box key={inst.instanceId} flexDirection="column">
                <Text>
                  {"  "}
                  <Text color="green">running</Text>
                  {"  "}
                  <Text dimColor>PID {inst.pid}</Text>
                  {"  "}
                  <Text dimColor>up {uptime}</Text>
                  {"  "}
                  <Text dimColor>[{toolLabel}]</Text>
                </Text>
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}
