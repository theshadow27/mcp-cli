/**
 * Provider-neutral agent session types.
 *
 * These types define the common interface that all agent providers
 * (Claude, Codex, OpenCode) implement. Provider-specific extensions
 * add their own fields on top of these.
 */

/**
 * Known agent providers. Uses `string & {}` to allow unknown providers
 * without requiring type changes — the DB stores plain TEXT.
 */
export type AgentProvider = "claude" | "codex" | "opencode" | "acp" | (string & {});

export type AgentSessionState =
  | "connecting"
  | "init"
  | "active"
  | "waiting_permission"
  | "result"
  | "idle"
  | "disconnected"
  | "ended";

export interface AgentPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  inputSummary: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  provider: AgentProvider;
  state: AgentSessionState;
  model: string | null;
  cwd: string | null;
  /** Null when provider cannot compute cost. */
  cost: number | null;
  tokens: number;
  /** Reasoning/thinking tokens (Codex/OpenCode report this). */
  reasoningTokens: number;
  numTurns: number;
  pendingPermissions: number;
  pendingPermissionDetails: AgentPermissionRequest[];
  worktree: string | null;
  /** Whether the agent process is still alive. */
  processAlive: boolean;
}

export interface AgentResult {
  result: string;
  cost: number | null;
  tokens: number;
  numTurns: number;
  diff?: string;
}

export type AgentSessionEvent =
  | { type: "session:init"; sessionId: string; provider: AgentProvider; model: string; cwd: string }
  | { type: "session:response"; text: string }
  | { type: "session:permission_request"; request: AgentPermissionRequest }
  | { type: "session:result"; result: AgentResult }
  | { type: "session:error"; errors: string[]; cost: number | null }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:ended" };
