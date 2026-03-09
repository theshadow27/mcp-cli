/**
 * Shared session types used by daemon, command, and control packages.
 * Single source of truth for Claude Code session state representation.
 */

export type SessionStateEnum =
  | "connecting"
  | "init"
  | "active"
  | "waiting_permission"
  | "result"
  | "idle"
  | "disconnected"
  | "ended";

export interface PendingPermissionInfo {
  requestId: string;
  toolName: string;
  inputSummary: string;
}

export interface SessionInfo {
  sessionId: string;
  state: SessionStateEnum;
  model: string | null;
  cwd: string | null;
  cost: number;
  tokens: number;
  numTurns: number;
  pendingPermissions: number;
  pendingPermissionDetails: PendingPermissionInfo[];
  worktree: string | null;
  /** Whether the WebSocket transport is currently connected. */
  wsConnected: boolean;
  /** Whether the spawned Claude CLI process is still alive. */
  spawnAlive: boolean;
}
