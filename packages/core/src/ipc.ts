/**
 * IPC protocol between mcx (command) and mcpd (daemon).
 *
 * Transport: HTTP over Unix socket at ~/.mcp-cli/mcpd.sock
 * Encoding: JSON request/response bodies
 */

import { z } from "zod/v4";
import type { AliasType } from "./alias";

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

// -- Param schemas per method --

export const CallToolParamsSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
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
});

export const DeleteAliasParamsSchema = z.object({
  name: z.string(),
});

export const GetAliasParamsSchema = z.object({
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
