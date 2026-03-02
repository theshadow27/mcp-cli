/**
 * IPC protocol between mcp (command) and mcpd (daemon).
 *
 * Transport: Unix socket at ~/.mcp-cli/mcpd.sock
 * Encoding: Newline-delimited JSON (NDJSON)
 */

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
  | "deleteAlias";

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
}

// -- Param types per method --

export interface CallToolParams {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ListToolsParams {
  server?: string;
  format?: "compact" | "full";
}

export interface GetToolInfoParams {
  server: string;
  tool: string;
}

export interface GrepToolsParams {
  pattern: string;
}

export interface TriggerAuthParams {
  server: string;
}

export interface RestartServerParams {
  server?: string; // if omitted, restart all
}

export interface SaveAliasParams {
  name: string;
  script: string;
  description?: string;
}

export interface DeleteAliasParams {
  name: string;
}

export interface GetAliasParams {
  name: string;
}

export interface AliasInfo {
  name: string;
  description: string;
  filePath: string;
  updatedAt: number;
}

export interface AliasDetail extends AliasInfo {
  script: string;
}

// -- Result types --

export interface ServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  state: "disconnected" | "connecting" | "connected" | "error";
  toolCount: number;
  lastUsed?: number;
  lastError?: string;
  source: string;
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
  servers: ServerStatus[];
  dbPath: string;
}

export interface GetConfigResult {
  servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }>;
  sources: Array<{ file: string; scope: string }>;
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

/** Encode a request to NDJSON line */
export function encodeRequest(req: IpcRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/** Encode a response to NDJSON line */
export function encodeResponse(res: IpcResponse): string {
  return `${JSON.stringify(res)}\n`;
}

/** Parse a single NDJSON line */
export function parseLine(line: string): IpcRequest | IpcResponse {
  return JSON.parse(line);
}
