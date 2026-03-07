/**
 * IPC protocol between mcx (command) and mcpd (daemon).
 *
 * Transport: HTTP over Unix socket at ~/.mcp-cli/mcpd.sock
 * Encoding: JSON request/response bodies
 */

import { z } from "zod/v4";

// -- Methods --

export type IpcMethod =
  | "ping"
  | "status"
  | "listServers"
  | "listTools"
  | "getToolInfo"
  | "grepTools"
  | "callTool"
  | "triggerAuth"
  | "restartServer"
  | "getConfig"
  | "shutdown"
  | "listAliases"
  | "getAlias"
  | "saveAlias"
  | "deleteAlias"
  | "getLogs"
  | "getDaemonLogs"
  | "sendMail"
  | "readMail"
  | "waitForMail"
  | "replyToMail"
  | "markRead"
  | "reloadConfig";

// -- Request/Response --

export interface IpcRequest {
  id: string;
  method: IpcMethod;
  params?: unknown;
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

// -- Param types per method --

export interface CallToolParams {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export const CallToolParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

export interface ListToolsParams {
  server?: string;
  format?: "compact" | "full";
}

export const ListToolsParamsSchema = z.object({
  server: z.string().optional(),
  format: z.enum(["compact", "full"]).optional(),
});

export interface GetToolInfoParams {
  server: string;
  tool: string;
}

export const GetToolInfoParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
});

export interface GrepToolsParams {
  pattern: string;
}

export const GrepToolsParamsSchema = z.object({
  pattern: z.string(),
});

export interface TriggerAuthParams {
  server: string;
}

export const TriggerAuthParamsSchema = z.object({
  server: z.string(),
});

export interface RestartServerParams {
  server?: string; // if omitted, restart all
}

export const RestartServerParamsSchema = z.object({
  server: z.string().optional(),
});

export interface SaveAliasParams {
  name: string;
  script: string;
  description?: string;
  aliasType?: "freeform" | "defineAlias";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export const SaveAliasParamsSchema = z.object({
  name: z.string(),
  script: z.string(),
  description: z.string().optional(),
  aliasType: z.enum(["freeform", "defineAlias"]).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export interface DeleteAliasParams {
  name: string;
}

export const DeleteAliasParamsSchema = z.object({
  name: z.string(),
});

export interface GetAliasParams {
  name: string;
}

export const GetAliasParamsSchema = z.object({
  name: z.string(),
});

export interface GetLogsParams {
  server: string;
  limit?: number;
  since?: number;
}

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
  aliasType: "freeform" | "defineAlias";
  inputSchemaJson?: Record<string, unknown>;
  outputSchemaJson?: Record<string, unknown>;
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

export interface GetDaemonLogsParams {
  limit?: number;
  since?: number;
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
}

export interface ToolInfo {
  name: string;
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Compact TypeScript-notation signature */
  signature?: string;
}

export interface DaemonStatus {
  pid: number;
  uptime: number;
  protocolVersion: string;
  servers: ServerStatus[];
  dbPath: string;
  usageStats: UsageStat[];
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

export interface SendMailParams {
  sender: string;
  recipient: string;
  subject?: string;
  body?: string;
  replyTo?: number;
}

export const SendMailParamsSchema = z.object({
  sender: z.string(),
  recipient: z.string(),
  subject: z.string().optional(),
  body: z.string().optional(),
  replyTo: z.number().optional(),
});

export interface ReadMailParams {
  recipient?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export const ReadMailParamsSchema = z.object({
  recipient: z.string().optional(),
  unreadOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

export interface WaitForMailParams {
  recipient?: string;
  timeout?: number;
}

export const WaitForMailParamsSchema = z.object({
  recipient: z.string().optional(),
  timeout: z.number().optional(),
});

export interface ReplyToMailParams {
  id: number;
  sender: string;
  body: string;
  subject?: string;
}

export const ReplyToMailParamsSchema = z.object({
  id: z.number(),
  sender: z.string(),
  body: z.string(),
  subject: z.string().optional(),
});

export interface MarkReadParams {
  id: number;
}

export const MarkReadParamsSchema = z.object({
  id: z.number(),
});

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
