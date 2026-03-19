import type { AgentSessionInfo, AgentSessionState } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import { AgentSessionDetail, type TranscriptEntry } from "./agent-session-detail.js";

interface AgentSessionListProps {
  sessions: AgentSessionInfo[];
  selectedIndex: number;
  expandedSession: string | null;
  loading: boolean;
  error: string | null;
  permissionIndex: number;
  transcriptEntries: TranscriptEntry[];
  transcriptError: string | null;
  transcriptSelectedEntry: string | null;
  transcriptExpandedEntries: ReadonlySet<string>;
  transcriptScrollOffset: number;
  transcriptViewHeight: number;
}

const stateColor: Record<AgentSessionState, string> = {
  active: "green",
  init: "green",
  connecting: "yellow",
  idle: "white",
  waiting_permission: "red",
  result: "cyan",
  disconnected: "red",
  ended: "gray",
};

const stateLabel: Record<AgentSessionState, string> = {
  active: "active",
  init: "init",
  connecting: "connecting",
  idle: "idle",
  waiting_permission: "permission",
  result: "result",
  disconnected: "disconnected",
  ended: "ended",
};

export function formatCost(cost: number | null): string {
  if (cost == null) return "-";
  return `$${cost.toFixed(4)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function shortCwd(cwd: string | null): string {
  if (!cwd) return "";
  const home = process.env.HOME ?? "";
  const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return display.length > 30 ? `...${display.slice(-27)}` : display;
}

export function AgentSessionList({
  sessions,
  selectedIndex,
  expandedSession,
  loading,
  error,
  permissionIndex,
  transcriptEntries,
  transcriptError,
  transcriptSelectedEntry,
  transcriptExpandedEntries,
  transcriptScrollOffset,
  transcriptViewHeight,
}: AgentSessionListProps) {
  if (loading && sessions.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>Loading sessions...</Text>
      </Box>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No active sessions. Use `mcx claude spawn` or `mcx codex spawn` to start one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {sessions.map((session, index) => {
        const selected = index === selectedIndex;
        const expanded = expandedSession === session.sessionId;
        const color = stateColor[session.state];
        const label = stateLabel[session.state];

        return (
          <Box key={session.sessionId} flexDirection="column">
            <Text bold={selected}>
              <Text>{selected ? "> " : "  "}</Text>
              <Text bold={selected}>{shortId(session.sessionId)}</Text>
              {"  "}
              <Text color="magenta">[{session.provider}]</Text>
              {"  "}
              <Text color={color}>{label}</Text>
              {"  "}
              <Text dimColor>{session.model ?? "unknown"}</Text>
              {"  "}
              <Text>{formatCost(session.cost)}</Text>
              {"  "}
              <Text dimColor>{formatTokens(session.tokens)} tok</Text>
              {session.cwd && (
                <Text dimColor>
                  {"  "}
                  {shortCwd(session.cwd)}
                </Text>
              )}
              {session.worktree && (
                <Text color="blue">
                  {"  "}[wt:{session.worktree}]
                </Text>
              )}
              {session.pendingPermissions > 0 && (
                <Text color="red">
                  {"  "}[{session.pendingPermissions} pending]
                </Text>
              )}
            </Text>
            {selected && session.pendingPermissionDetails?.length > 0 && (
              <Box flexDirection="column" marginLeft={4}>
                {session.pendingPermissionDetails.map((perm, permIdx) => {
                  const targeted = permIdx === permissionIndex;
                  return (
                    <Text key={perm.requestId} color={targeted ? "yellow" : "gray"}>
                      {targeted ? "▸ " : "  "}
                      <Text bold={targeted}>{perm.toolName}</Text>
                      {perm.inputSummary ? <Text dimColor>({perm.inputSummary})</Text> : null}
                      {targeted && (
                        <>
                          {" — "}
                          <Text color="green">[a]</Text>
                          <Text>pprove </Text>
                          <Text color="red">[d]</Text>
                          <Text>eny</Text>
                        </>
                      )}
                    </Text>
                  );
                })}
                {session.pendingPermissionDetails.length > 1 && <Text dimColor>{"  ←/→ navigate permissions"}</Text>}
              </Box>
            )}
            {expanded && (
              <AgentSessionDetail
                entries={transcriptEntries}
                error={transcriptError}
                selectedEntry={transcriptSelectedEntry}
                expandedEntries={transcriptExpandedEntries}
                scrollOffset={transcriptScrollOffset}
                height={transcriptViewHeight}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
