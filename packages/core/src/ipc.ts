/**
 * IPC protocol between mcx (command) and mcpd (daemon).
 *
 * Transport: HTTP over Unix socket at ~/.mcp-cli/mcpd.sock
 * Encoding: JSON request/response bodies
 */

import { z } from "zod/v4";
import type { AliasType } from "./alias";
import type { PlanProtocolCapability } from "./plan";
import type { SpanEvent } from "./trace";
import type { WorkItem } from "./work-item";

// -- Methods --

export type IpcMethod =
  | "ping"
  | "status"
  | "quotaStatus"
  | "listServers"
  | "listTools"
  | "getToolInfo"
  | "grepTools"
  | "callTool"
  | "triggerAuth"
  | "authStatus"
  | "restartServer"
  | "getConfig"
  | "shutdown"
  | "listAliases"
  | "getAlias"
  | "saveAlias"
  | "deleteAlias"
  | "touchAlias"
  | "recordAliasRun"
  | "checkAlias"
  | "getLogs"
  | "getDaemonLogs"
  | "sendMail"
  | "readMail"
  | "waitForMail"
  | "replyToMail"
  | "markRead"
  | "reloadConfig"
  | "getMetrics"
  | "getSpans"
  | "markSpansExported"
  | "pruneSpans"
  | "registerServe"
  | "unregisterServe"
  | "listServeInstances"
  | "killServe"
  | "setNote"
  | "getNote"
  | "listNotes"
  | "deleteNote"
  | "trackWorkItem"
  | "untrackWorkItem"
  | "listWorkItems"
  | "aliasStateGet"
  | "aliasStateSet"
  | "aliasStateDelete"
  | "aliasStateAll";

// -- Request/Response --

export interface IpcRequest {
  id: string;
  method: IpcMethod;
  params?: unknown;
  /** W3C traceparent header for request correlation. */
  traceparent?: string;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: IpcError;
}

export interface IpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

// -- Param schemas per method --

export const CallToolParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  timeoutMs: z.number().optional(),
  /** Alias call chain for cycle detection in cross-alias composition. */
  callChain: z.array(z.string()).optional(),
  /**
   * Caller's working directory. Used to resolve the repo root scope for
   * `ctx.state` when invoking aliases — without this, alias subprocesses
   * inherit the daemon's cwd and all aliases share one "__none__" bucket.
   */
  cwd: z.string().optional(),
});

export const ListToolsParamsSchema = z.object({
  server: z.string().optional(),
  format: z.enum(["compact", "full"]).optional(),
});

export const GetToolInfoParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
});

export const GrepToolsParamsSchema = z.object({
  pattern: z.string(),
});

export const TriggerAuthParamsSchema = z.object({
  server: z.string(),
});

export const AuthStatusParamsSchema = z.object({
  server: z.string().optional(),
});

export const RestartServerParamsSchema = z.object({
  server: z.string().optional(),
});

export const SaveAliasParamsSchema = z.object({
  name: z.string(),
  script: z.string(),
  description: z.string().optional(),
  aliasType: z.enum(["freeform", "defineAlias"]).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** Absolute ms timestamp when this alias expires (ephemeral aliases only) */
  expiresAt: z.number().optional(),
});

export const DeleteAliasParamsSchema = z.object({
  name: z.string(),
});

export const GetAliasParamsSchema = z.object({
  name: z.string(),
});

export const TouchAliasParamsSchema = z.object({
  name: z.string(),
  /** New absolute expiry timestamp (ms) — must be a future timestamp */
  expiresAt: z.number().positive(),
});

export const RecordAliasRunParamsSchema = z.object({
  name: z.string(),
});

export const GetLogsParamsSchema = z.object({
  server: z.string(),
  limit: z.number().optional(),
  since: z.number().optional(),
});

export interface AliasInfo {
  name: string;
  description: string;
  filePath: string;
  updatedAt: number;
  aliasType: AliasType;
  inputSchemaJson?: Record<string, unknown>;
  outputSchemaJson?: Record<string, unknown>;
  /** Absolute ms timestamp when this alias expires (null = permanent) */
  expiresAt?: number | null;
  /** Number of times this alias has been run */
  runCount?: number;
  /** Epoch seconds of last run (null = never run) */
  lastRunAt?: number | null;
}

export interface AliasDetail extends AliasInfo {
  script: string;
}

// -- Log types --

export interface LogEntry {
  timestamp: number;
  line: string;
}

export interface GetLogsResult {
  server: string;
  lines: LogEntry[];
}

export const GetDaemonLogsParamsSchema = z.object({
  limit: z.number().optional(),
  since: z.number().optional(),
});

export interface GetDaemonLogsResult {
  lines: LogEntry[];
}

// -- Result types --

export interface UsageStat {
  serverName: string;
  toolName: string;
  callCount: number;
  totalDurationMs: number;
  successCount: number;
  errorCount: number;
  lastCalledAt: number;
  lastError: string | null;
}

export interface ServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse" | "virtual";
  state: "disconnected" | "connecting" | "connected" | "error";
  toolCount: number;
  lastUsed?: number;
  lastError?: string;
  source: string;
  recentStderr?: string[];
  callCount?: number;
  errorCount?: number;
  avgDurationMs?: number;
  /** Plan protocol capabilities detected from tool names, if any. */
  planCapabilities?: PlanProtocolCapability;
}

export interface ToolInfo {
  name: string;
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Compact TypeScript-notation signature */
  signature?: string;
  /** User-attached note (from `mcx note set`) */
  note?: string;
}

export interface ServeInstanceInfo {
  instanceId: string;
  pid: number;
  /** Curated tool names from MCP_TOOLS (empty if discovery-only). */
  tools: string[];
  /** Epoch ms when the serve instance started. */
  startedAt: number;
}

export interface DaemonStatus {
  pid: number;
  uptime: number;
  protocolVersion: string;
  daemonVersion?: string;
  servers: ServerStatus[];
  dbPath: string;
  usageStats: UsageStat[];
  /** Actual WebSocket port the daemon is listening on (null if not started). */
  wsPort?: number | null;
  /** The well-known port the daemon was configured to use. */
  wsPortExpected?: number;
  /** Process holding the expected WS port when there's a mismatch (e.g. "mcpd (PID 38291)"). */
  wsPortHolder?: string | null;
  /** Active `mcx serve` instances registered with the daemon. */
  serveInstances?: ServeInstanceInfo[];
}

// -- Quota types --

export interface QuotaUsageBucket {
  /** Percentage used (0-100). */
  utilization: number;
  /** ISO 8601 timestamp when this window resets. */
  resetsAt: string;
}

export interface QuotaExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  /** Percentage of extra usage budget consumed (0-100). */
  utilization: number;
}

export interface QuotaStatusResult {
  fiveHour: QuotaUsageBucket | null;
  sevenDay: QuotaUsageBucket | null;
  sevenDaySonnet: QuotaUsageBucket | null;
  sevenDayOpus: QuotaUsageBucket | null;
  extraUsage: QuotaExtraUsage | null;
  /** When this data was last fetched (ms since epoch). */
  fetchedAt: number;
  /** Last error message if the most recent fetch failed. */
  lastError: string | null;
}

export interface GetConfigResult {
  servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }>;
  sources: Array<{ file: string; scope: string }>;
}

// -- Mail types --

export interface MailMessage {
  id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string | null;
  replyTo: number | null;
  read: boolean;
  createdAt: string;
}

export const SendMailParamsSchema = z.object({
  sender: z.string(),
  recipient: z.string(),
  subject: z.string().optional(),
  body: z.string().optional(),
  replyTo: z.number().optional(),
});

export const ReadMailParamsSchema = z.object({
  recipient: z.string().optional(),
  unreadOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

export const WaitForMailParamsSchema = z.object({
  recipient: z.string().optional(),
  timeout: z.number().optional(),
});

export const ReplyToMailParamsSchema = z.object({
  id: z.number(),
  sender: z.string(),
  body: z.string(),
  subject: z.string().optional(),
});

export const MarkReadParamsSchema = z.object({
  id: z.number(),
});

// -- Span schemas --

export const GetSpansParamsSchema = z.object({
  since: z.number().optional(),
  limit: z.number().optional(),
  unexported: z.boolean().optional(),
});

export const MarkSpansExportedParamsSchema = z.object({
  ids: z.array(z.number()),
});

export const PruneSpansParamsSchema = z.object({
  before: z.number().optional(),
});

// -- Serve instance schemas --

export const RegisterServeParamsSchema = z.object({
  instanceId: z.string(),
  pid: z.number(),
  tools: z.array(z.string()),
});

export const UnregisterServeParamsSchema = z.object({
  instanceId: z.string(),
});

export const KillServeParamsSchema = z.object({
  /** Kill a specific instance by ID. */
  instanceId: z.string().optional(),
  /** Kill a specific instance by PID. */
  pid: z.number().optional(),
  /** Kill all serve instances. */
  all: z.boolean().optional(),
  /** Kill instances older than this many hours. */
  staleHours: z.number().optional(),
});

// -- Note schemas --

export const SetNoteParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
  note: z.string(),
});

export const GetNoteParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
});

export const DeleteNoteParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
});

// -- Work item schemas --

export const TrackWorkItemParamsSchema = z
  .object({
    /** Issue or PR number to track. */
    number: z.number().optional(),
    /** Branch name to track (PR may not exist yet). */
    branch: z.string().optional(),
  })
  .refine((p) => p.number != null || p.branch != null, {
    message: "Either number or branch is required",
  });

export const UntrackWorkItemParamsSchema = z
  .object({
    /** Issue or PR number to untrack. */
    number: z.number().optional(),
    /** Branch name to untrack. */
    branch: z.string().optional(),
  })
  .refine((p) => p.number != null || p.branch != null, {
    message: "Either number or branch is required",
  });

export const ListWorkItemsParamsSchema = z.object({
  /** Filter by phase. */
  phase: z.string().optional(),
});

// -- Alias state schemas --

const AliasStateScope = z.object({
  repoRoot: z.string().min(1),
  namespace: z.string().min(1),
});

export const AliasStateGetParamsSchema = AliasStateScope.extend({ key: z.string().min(1) });
export const AliasStateSetParamsSchema = AliasStateScope.extend({
  key: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, {
    message: "value cannot be undefined; use delete(key) to remove a key",
  }),
});
export const AliasStateDeleteParamsSchema = AliasStateScope.extend({ key: z.string().min(1) });
export const AliasStateAllParamsSchema = AliasStateScope;

export interface AliasStateGetResult {
  value: unknown | undefined;
}
export interface AliasStateSetResult {
  ok: true;
}
export interface AliasStateDeleteResult {
  ok: true;
  deleted: boolean;
}
export interface AliasStateAllResult {
  entries: Record<string, unknown>;
}

// -- Result types for methods without a named interface --

export interface PingResult {
  pong: true;
  time: number;
  protocolVersion: string;
}

export interface TriggerAuthResult {
  ok: boolean;
  message: string;
}

export interface ServerAuthStatus {
  server: string;
  transport: "stdio" | "http" | "sse" | "virtual";
  authSupport: "oauth" | "auth_tool" | "none";
  status: "authenticated" | "expired" | "not_authenticated" | "unknown";
  expiresAt?: number;
}

export interface AuthStatusResult {
  servers: ServerAuthStatus[];
}

export interface RestartServerResult {
  ok: true;
}

export interface SaveAliasResult {
  ok: true;
  filePath: string;
  /** Validation warnings (non-fatal issues detected during save) */
  warnings?: string[];
  /** Validation errors (alias saved but validation failed) */
  validationErrors?: string[];
}

export interface CheckAliasResult {
  valid: boolean;
  aliasType: "defineAlias" | "freeform";
  name?: string;
  description?: string;
  errors: string[];
  warnings: string[];
}

export const CheckAliasParamsSchema = z.object({
  name: z.string(),
});

export interface DeleteAliasResult {
  ok: true;
}

export interface SendMailResult {
  id: number;
}

export interface ReadMailResult {
  messages: MailMessage[];
}

export interface WaitForMailResult {
  message: MailMessage | null;
}

export interface ReplyToMailResult {
  id: number;
}

export interface ReloadConfigResult {
  ok: true;
}

export const ShutdownParamsSchema = z.object({
  force: z.boolean().optional(),
});

export interface ShutdownResult {
  ok: boolean;
  /** Present when ok=false — number of active sessions blocking shutdown */
  activeSessions?: number;
  /** Present when ok=false — human-readable refusal message */
  message?: string;
}

export interface MetricsSnapshot {
  /** Daemon instance ID (stable for daemon lifetime). */
  daemonId?: string;
  /** Daemon startup timestamp (ms since epoch). */
  startedAt?: number;
  collectedAt: number;
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

// -- Note types --

export interface NoteEntry {
  serverName: string;
  toolName: string;
  note: string;
  updatedAt: number;
}

// -- Span types --

export interface SpanRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: string;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  daemonId: string | null;
  exportedAt: number | null;
}

export interface GetSpansResult {
  spans: SpanRow[];
}

export interface MarkSpansExportedResult {
  marked: number;
}

export interface PruneSpansResult {
  pruned: number;
}

// -- Method → Result type map --

export interface IpcMethodResult {
  ping: PingResult;
  status: DaemonStatus;
  quotaStatus: QuotaStatusResult;
  listServers: ServerStatus[];
  listTools: ToolInfo[];
  getToolInfo: ToolInfo;
  grepTools: ToolInfo[];
  callTool: unknown;
  triggerAuth: TriggerAuthResult;
  authStatus: AuthStatusResult;
  restartServer: RestartServerResult;
  getConfig: GetConfigResult;
  shutdown: ShutdownResult;
  listAliases: AliasInfo[];
  getAlias: AliasDetail | null;
  saveAlias: SaveAliasResult;
  deleteAlias: DeleteAliasResult;
  touchAlias: { ok: true };
  recordAliasRun: { ok: true; runCount: number };
  checkAlias: CheckAliasResult;
  getLogs: GetLogsResult;
  getDaemonLogs: GetDaemonLogsResult;
  sendMail: SendMailResult;
  readMail: ReadMailResult;
  waitForMail: WaitForMailResult;
  replyToMail: ReplyToMailResult;
  markRead: Record<string, never>;
  reloadConfig: ReloadConfigResult;
  getMetrics: MetricsSnapshot;
  getSpans: GetSpansResult;
  markSpansExported: MarkSpansExportedResult;
  pruneSpans: PruneSpansResult;
  registerServe: { ok: true };
  unregisterServe: { ok: true };
  listServeInstances: ServeInstanceInfo[];
  killServe: { killed: number };
  setNote: { ok: true };
  getNote: { note: string | null };
  listNotes: NoteEntry[];
  deleteNote: { ok: true; deleted: boolean };
  trackWorkItem: WorkItem;
  untrackWorkItem: { ok: true; deleted: boolean };
  listWorkItems: WorkItem[];
  aliasStateGet: AliasStateGetResult;
  aliasStateSet: AliasStateSetResult;
  aliasStateDelete: AliasStateDeleteResult;
  aliasStateAll: AliasStateAllResult;
}

// -- Error codes --

export const IPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_FOUND: -1001,
  TOOL_NOT_FOUND: -1002,
  CONNECTION_FAILED: -1003,
  AUTH_REQUIRED: -1004,
  TIMEOUT: -1005,
} as const;

// -- Helpers --

let counter = 0;

/** Generate a short unique request ID */
export function nextId(): string {
  return `r${++counter}`;
}
