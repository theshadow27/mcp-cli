/**
 * ACP (Agent Client Protocol) types.
 *
 * Based on spike #518 findings against copilot --acp and the ACP spec.
 * JSON-RPC 2.0 over NDJSON on stdio.
 *
 * @see https://agentclientprotocol.com/protocol/schema
 */

// ── JSON-RPC 2.0 base types ──

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** A server-initiated request (has both method and id). */
export interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

// ── Initialize handshake ──

export interface InitializeParams {
  protocolVersion: number;
  clientInfo: { name: string; version: string };
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

export interface InitializeResult {
  agentInfo?: { name: string; version: string };
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
}

// ── Session lifecycle ──

export interface SessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
}

export interface SessionPromptResult {
  stopReason?: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

// ── session/update notification ──

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

/**
 * ACP session update chunk types.
 * The discriminant is `update.sessionUpdate`.
 */
export type SessionUpdate =
  | AgentMessageChunk
  | ToolCallUpdate
  | ToolResultUpdate
  | PlanUpdate
  | SessionInfoUpdate
  | ConfigOptionUpdate
  | CurrentModeUpdate
  | GenericUpdate;

export interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: { type: "text"; text: string };
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  type: "toolCall";
  toolCall: { id: string; name: string; input?: unknown };
}

export interface ToolResultUpdate {
  sessionUpdate: "tool_result";
  type: "toolResult";
  toolResult: { id: string; output?: string; isError?: boolean };
}

export interface PlanUpdate {
  sessionUpdate: "plan_update";
  plan?: unknown;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  cost?: number;
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
}

export interface GenericUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

// ── session/request_permission (server → client) ──

export interface PermissionRequestParams {
  sessionId: string;
  options: PermissionOption[];
  /** Tool name requesting permission (may not always be present). */
  tool?: string;
  /** Human-readable description of what's being requested. */
  description?: string;
  /** Command or file path being requested. */
  command?: string;
  path?: string;
}

export interface PermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  description?: string;
}

export interface PermissionResponse {
  outcome: { outcome: "selected"; optionId: string };
}

// ── Server-initiated capability requests ──

export interface FsWriteTextFileParams {
  path: string;
  content: string;
}

export interface FsReadTextFileParams {
  path: string;
}

export interface TerminalCreateParams {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface TerminalOutputParams {
  terminalId: string;
}

export interface TerminalWaitForExitParams {
  terminalId: string;
}

export interface TerminalReleaseParams {
  terminalId: string;
}

// ── Message classification ──

/** Classify a parsed NDJSON message by its shape. */
export function classifyMessage(
  msg: Record<string, unknown>,
): "response" | "notification" | "server_request" | "unknown" {
  const hasId = "id" in msg;
  const hasMethod = "method" in msg;
  const hasResult = "result" in msg;
  const hasError = "error" in msg;

  if (hasId && (hasResult || hasError)) return "response";
  if (hasId && hasMethod) return "server_request";
  if (hasMethod && !hasId) return "notification";
  return "unknown";
}
