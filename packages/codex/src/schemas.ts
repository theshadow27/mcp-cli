/**
 * Hand-written Codex App Server protocol types.
 *
 * Based on spike #303 findings against codex-cli 0.112.0.
 * These cover the subset of the protocol we actually use —
 * not the full generated schema from `codex app-server generate-ts`.
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

/** A server-initiated request (has both method and id, but no result/error). */
export interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** Any message arriving on the JSONL stream. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

// ── Initialize handshake ──

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  capabilities?: InitializeCapabilities;
}

export interface InitializeCapabilities {
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  userAgent?: string;
}

// ── Thread lifecycle ──

export interface ThreadStartParams {
  cwd: string;
  model?: string;
  sandbox?: "read-only" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "unless-allow-listed";
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface Thread {
  id: string;
  status: ThreadStatus;
  cwd: string;
}

export type ThreadStatus = "idle" | "active" | "waitingOnApproval" | "ended";

export interface ThreadStatusChangedParams {
  threadId: string;
  status: ThreadStatus;
}

// ── Turn lifecycle ──

export interface TurnStartParams {
  threadId: string;
  input: TurnInput;
}

export interface TurnInput {
  text: string;
  text_elements?: unknown[];
}

export interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
}

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface TurnCompletedParams {
  threadId: string;
  turnId: string;
  status: TurnStatus;
  reason?: string;
}

export interface TurnDiffUpdatedParams {
  threadId: string;
  turnId: string;
  diff: string;
}

// ── Items ──

export type ThreadItemType =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "enteredReviewMode"
  | "exitedReviewMode";

export interface ThreadItemStartedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ThreadItemCompletedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ThreadItem {
  id: string;
  type: ThreadItemType;
  status: "inProgress" | "completed" | "failed";
  /** Present on agentMessage items. */
  text?: string;
  /** Present on agentMessage items. */
  phase?: "commentary" | "final_answer" | null;
  /** Present on commandExecution items. */
  command?: string;
  /** Present on commandExecution items. */
  cwd?: string;
  /** Present on commandExecution items. */
  exitCode?: number;
  /** Present on commandExecution items — concatenated stdout+stderr. */
  aggregatedOutput?: string;
  /** Present on commandExecution items. */
  durationMs?: number;
  /** Present on fileChange items. */
  changes?: FileChange[];
  /** Present on fileChange and commandExecution items. */
  autoApproved?: boolean;
}

export interface FileChange {
  path: string;
  kind: "add" | "modify" | "delete";
  diff: string;
}

// ── Streaming deltas ──

export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// ── Approval requests (server → client) ──

export interface CommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string;
  command: string;
  cwd: string;
  reason?: string;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string;
  reason?: string;
  grantRoot?: string;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalResponse {
  decision: ApprovalDecision;
}

// ── Token usage ──

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

// ── Turn interrupt ──

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ── Discriminated message routing ──

/** Classify a parsed JSONL message by its shape. */
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
