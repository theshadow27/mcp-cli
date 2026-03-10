/**
 * Shared session types used by daemon, command, and control packages.
 * Single source of truth for Claude Code session state representation.
 *
 * SessionInfo extends the provider-neutral AgentSessionInfo with
 * Claude-specific fields.
 */

import type { AgentSessionInfo, AgentSessionState } from "./agent-session";

/** @deprecated Use AgentSessionState instead. */
export type SessionStateEnum = AgentSessionState;

/** @deprecated Use AgentPermissionRequest instead. */
export interface PendingPermissionInfo {
  requestId: string;
  toolName: string;
  inputSummary: string;
}

export interface SessionInfo extends AgentSessionInfo {
  provider: "claude";
  /** Claude always has cost information. */
  cost: number;
  /** Whether the WebSocket transport is currently connected. */
  wsConnected: boolean;
  /** Whether the spawned Claude CLI process is still alive. Alias for processAlive. */
  spawnAlive: boolean;
  /** Unix timestamp (ms) when this snapshot was taken. Consumers can use this to detect staleness. */
  snapshotTs: number;
}
