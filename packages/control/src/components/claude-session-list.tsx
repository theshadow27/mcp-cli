import { Box, Text } from "ink";
import React from "react";
import type { ClaudeSession, SessionStateEnum } from "../hooks/use-claude-sessions.js";
import { ClaudeSessionDetail } from "./claude-session-detail.js";

interface ClaudeSessionListProps {
  sessions: ClaudeSession[];
  selectedIndex: number;
  expandedSession: string | null;
  loading: boolean;
  error: string | null;
}

const stateColor: Record<SessionStateEnum, string> = {
  active: "green",
  init: "green",
  connecting: "yellow",
  idle: "white",
  waiting_permission: "red",
  result: "cyan",
  ended: "gray",
};

const stateLabel: Record<SessionStateEnum, string> = {
  active: "active",
  init: "init",
  connecting: "connecting",
  idle: "idle",
  waiting_permission: "permission",
  result: "result",
  ended: "ended",
};

export function formatCost(cost: number): string {
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

export function ClaudeSessionList({
  sessions,
  selectedIndex,
  expandedSession,
  loading,
  error,
}: ClaudeSessionListProps) {
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
        <Text dimColor>No active sessions. Use `mcx claude spawn` to start one.</Text>
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
            {expanded && <ClaudeSessionDetail sessionId={session.sessionId} />}
          </Box>
        );
      })}
    </Box>
  );
}
