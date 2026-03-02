/**
 * ServerPool — manages multiplexed MCP server connections.
 *
 * Connections are lazy: established on first tool call, cached, and
 * disconnected after idle timeout.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { type JsonSchema, formatToolSignature } from "@mcp-cli/command/schema-display.js";
import type { ResolvedConfig, ResolvedServer, ServerConfig, ServerStatus, ToolInfo } from "@mcp-cli/core";
import {
  CONNECT_INITIAL_DELAY_MS,
  CONNECT_MAX_DELAY_MS,
  CONNECT_MAX_RETRIES,
  getTransportType,
  isHttpConfig,
  isSseConfig,
  isStdioConfig,
} from "@mcp-cli/core";
import { McpOAuthProvider } from "./auth/oauth-provider.js";
import type { StateDb } from "./db/state.js";
import { StderrRingBuffer } from "./stderr-buffer.js";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface ServerConnection {
  name: string;
  resolved: ResolvedServer;
  client: Client | null;
  transport: Transport | null;
  tools: Map<string, ToolInfo>;
  state: ConnectionState;
  lastUsed: number;
  lastError?: string;
  connectingPromise?: Promise<ServerConnection>;
  stderrCleanup?: () => void;
}

export class ServerPool {
  private connections = new Map<string, ServerConnection>();
  private config: ResolvedConfig;
  private db: StateDb | null;
  private stderrBuffer = new StderrRingBuffer();

  constructor(config: ResolvedConfig, db?: StateDb) {
    this.config = config;
    this.db = db ?? null;
    // Pre-populate connection entries (disconnected, with cached tools if available)
    for (const [name, resolved] of config.servers) {
      const cachedTools = new Map<string, ToolInfo>();
      if (db) {
        for (const tool of db.getCachedTools(name)) {
          cachedTools.set(tool.name, tool);
        }
      }
      this.connections.set(name, {
        name,
        resolved,
        client: null,
        transport: null,
        tools: cachedTools,
        state: "disconnected",
        lastUsed: 0,
      });
    }
  }

  /** Update config (e.g., after file change) */
  updateConfig(config: ResolvedConfig): void {
    this.config = config;
    // Add new servers
    for (const [name, resolved] of config.servers) {
      if (!this.connections.has(name)) {
        this.connections.set(name, {
          name,
          resolved,
          client: null,
          transport: null,
          tools: new Map(),
          state: "disconnected",
          lastUsed: 0,
        });
      }
    }
    // Remove servers no longer in config
    for (const name of this.connections.keys()) {
      if (!config.servers.has(name)) {
        this.disconnect(name).catch(() => {});
        this.connections.delete(name);
      }
    }
  }

  /** Get or establish connection to a server */
  private async ensureConnected(name: string): Promise<ServerConnection> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Server "${name}" not found`);

    if (conn.state === "connected" && conn.client) {
      conn.lastUsed = Date.now();
      return conn;
    }

    // Deduplicate concurrent connection attempts
    if (conn.connectingPromise) return conn.connectingPromise;

    conn.connectingPromise = (async () => {
      conn.state = "connecting";

      // Auth provider is reusable across retries — create once
      let authProvider: OAuthClientProvider | undefined;
      const config = conn.resolved.config;
      if (this.db && (isSseConfig(config) || isHttpConfig(config))) {
        authProvider = new McpOAuthProvider(name, config.url, this.db);
      }

      let lastErr: Error = new Error("Connection failed");
      const maxRetries = CONNECT_MAX_RETRIES;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const transport = createTransport(config, authProvider);
          const client = new Client({ name: `mcp-cli/${name}`, version: "0.1.0" });

          // Attach stderr capture before connect so early output isn't lost
          this.attachStderrCapture(name, transport, conn);

          await client.connect(transport);

          conn.client = client;
          conn.transport = transport;
          conn.state = "connected";
          conn.lastUsed = Date.now();
          conn.lastError = undefined;

          // Cache tools on connect
          await this.refreshTools(conn);

          return conn;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));

          if (attempt < maxRetries && isRetryableError(err)) {
            const delay = Math.min(CONNECT_INITIAL_DELAY_MS * 2 ** attempt, CONNECT_MAX_DELAY_MS);
            console.error(
              `[mcpd] Connection to "${name}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${lastErr.message}`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          break;
        }
      }

      conn.state = "error";
      const wrapped = wrapTransportError(name, conn.resolved.config, lastErr);
      conn.lastError = wrapped.message;
      throw wrapped;
    })().finally(() => {
      conn.connectingPromise = undefined;
    });

    return conn.connectingPromise;
  }

  /** Refresh cached tool list for a connection */
  private async refreshTools(conn: ServerConnection): Promise<void> {
    if (!conn.client) return;
    try {
      const { tools } = await conn.client.listTools();
      conn.tools.clear();
      const { allowedTools, disabledTools } = conn.resolved.config;
      for (const tool of tools) {
        if (!isToolAllowed(tool.name, allowedTools, disabledTools)) continue;
        const inputSchema = (tool.inputSchema as Record<string, unknown>) ?? {};
        conn.tools.set(tool.name, {
          name: tool.name,
          server: conn.name,
          description: tool.description ?? "",
          inputSchema,
          signature: formatToolSignature(tool.name, inputSchema as JsonSchema),
        });
      }
      // Persist to SQLite cache
      if (this.db) {
        this.db.cacheTools(conn.name, [...conn.tools.values()]);
      }
    } catch (err) {
      console.error(`[pool] Failed to list tools for "${conn.name}": ${err}`);
    }
  }

  /** Attach a stderr listener to a stdio transport for capture and forwarding. */
  private attachStderrCapture(name: string, transport: Transport, conn: ServerConnection): void {
    // Only StdioClientTransport exposes a stderr stream
    const stdio = transport as unknown as { stderr: import("node:stream").Readable | null };
    if (typeof stdio.stderr?.on !== "function") return;

    const stream = stdio.stderr;
    let partial = "";

    const onData = (chunk: Buffer | string) => {
      const text = partial + chunk.toString();
      const lines = text.split("\n");
      // Last element is a partial line (or empty if text ended with \n)
      partial = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") continue;
        const entry = this.stderrBuffer.push(name, line);
        process.stderr.write(`[${name}] ${line}\n`);
        this.db?.insertServerLog(name, line, entry.timestamp);
      }
    };

    stream.on("data", onData);

    conn.stderrCleanup = () => {
      stream.removeListener("data", onData);
      // Flush any remaining partial line
      if (partial) {
        const entry = this.stderrBuffer.push(name, partial);
        process.stderr.write(`[${name}] ${partial}\n`);
        this.db?.insertServerLog(name, partial, entry.timestamp);
        partial = "";
      }
    };
  }

  /** Get recent stderr lines for a server from the in-memory ring buffer. */
  getStderrLines(server: string, limit?: number): Array<{ timestamp: number; line: string }> {
    return this.stderrBuffer.getLines(server, limit);
  }

  /** List all configured servers with status */
  listServers(): ServerStatus[] {
    return [...this.connections.values()].map((conn) => {
      const recent = this.stderrBuffer.getLines(conn.name, 3);
      const recentStderr = recent.length > 0 ? recent.map((l) => l.line) : undefined;
      return {
        name: conn.name,
        transport: getTransportType(conn.resolved.config),
        state: conn.state,
        toolCount: conn.tools.size,
        lastUsed: conn.lastUsed || undefined,
        lastError: conn.lastError,
        source: conn.resolved.source.file,
        recentStderr,
      };
    });
  }

  /** List tools for a specific server (connects if needed) */
  async listTools(serverName?: string): Promise<ToolInfo[]> {
    if (serverName) {
      const conn = await this.ensureConnected(serverName);
      return [...conn.tools.values()];
    }
    // List all — connect to all servers in parallel
    const names = [...this.connections.keys()];
    const settled = await Promise.allSettled(names.map((name) => this.ensureConnected(name)));

    const results: ToolInfo[] = [];
    const errors: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        results.push(...outcome.value.tools.values());
      } else {
        errors.push(`${names[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : outcome.reason}`);
      }
    }
    if (errors.length > 0 && results.length === 0) {
      throw new Error(`Failed to connect to any server:\n${errors.join("\n")}`);
    }
    return results;
  }

  /** Get info for a specific tool */
  async getToolInfo(serverName: string, toolName: string): Promise<ToolInfo> {
    const conn = await this.ensureConnected(serverName);
    const tool = conn.tools.get(toolName);
    if (!tool) {
      const available = [...conn.tools.keys()].join(", ");
      throw new Error(`Tool "${toolName}" not found on server "${serverName}". Available: ${available}`);
    }
    return tool;
  }

  /** Call a tool on a server */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = await this.ensureConnected(serverName);
    if (!conn.client) throw new Error(`Not connected to "${serverName}"`);

    const result = await conn.client.callTool({ name: toolName, arguments: args });
    conn.lastUsed = Date.now();
    return result;
  }

  /** Search tools across all servers by pattern */
  async grepTools(pattern: string): Promise<ToolInfo[]> {
    const allTools = await this.listTools();
    const regex = globToRegex(pattern);
    return allTools.filter((t) => regex.test(t.name) || regex.test(t.description));
  }

  /** Disconnect a specific server */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    // Flush and detach stderr listener
    if (conn.stderrCleanup) {
      conn.stderrCleanup();
      conn.stderrCleanup = undefined;
    }

    try {
      await conn.client?.close();
    } catch {
      // ignore close errors
    }
    conn.client = null;
    conn.transport = null;
    conn.state = "disconnected";
    conn.tools.clear();
  }

  /** Restart a server (disconnect + reconnect) */
  async restart(name?: string): Promise<void> {
    if (name) {
      await this.disconnect(name);
      await this.ensureConnected(name);
    } else {
      // Restart all connected servers
      const connected = [...this.connections.entries()].filter(([, c]) => c.state === "connected");
      for (const [serverName] of connected) {
        await this.disconnect(serverName);
        await this.ensureConnected(serverName);
      }
    }
  }

  /** Disconnect all servers */
  async closeAll(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name);
    }
  }

  /** Get the URL of a remote server, or undefined for stdio */
  getServerUrl(name: string): string | undefined {
    const conn = this.connections.get(name);
    if (!conn) return undefined;
    const config = conn.resolved.config;
    if (isSseConfig(config) || isHttpConfig(config)) return config.url;
    return undefined;
  }

  /** Get the StateDb instance */
  getDb(): StateDb | null {
    return this.db;
  }

  /** Get names of servers idle longer than the threshold */
  getIdleServers(thresholdMs: number): string[] {
    const now = Date.now();
    return [...this.connections.entries()]
      .filter(([, c]) => c.state === "connected" && c.lastUsed > 0 && now - c.lastUsed > thresholdMs)
      .map(([name]) => name);
  }
}

// -- Retry classification --

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
]);

/** Classify whether a connection error is transient and worth retrying. */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;

  // System-level transient network errors
  if (code && RETRYABLE_CODES.has(code)) return true;

  // Fetch-style network errors (no system code)
  if (msg.includes("fetch failed") || msg.includes("socket hang up")) return true;

  // NOT retryable: auth failures, bad config
  if (msg.includes("401") || msg.includes("403") || msg.includes("not found") || msg.includes("permission denied")) {
    return false;
  }

  return false;
}

// -- Transport factories --

function createTransport(config: ServerConfig, authProvider?: OAuthClientProvider): Transport {
  if (isStdioConfig(config)) {
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) mergedEnv[key] = value;
    }
    if (config.env) Object.assign(mergedEnv, config.env);

    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergedEnv,
      cwd: config.cwd,
      stderr: "pipe",
    });
  }

  if (isHttpConfig(config)) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  if (isSseConfig(config)) {
    return new SSEClientTransport(new URL(config.url), {
      authProvider,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  throw new Error(`Unknown transport type for config: ${JSON.stringify(config)}`);
}

// -- Error wrapping --

/**
 * Inspect a transport-level error and return a new Error with an actionable,
 * user-friendly message that includes the server name and hints for resolution.
 * @internal Exported for testing only.
 */
export function wrapTransportError(serverName: string, config: ServerConfig, raw: unknown): Error {
  const err = raw instanceof Error ? raw : new Error(String(raw));
  const msg = err.message.toLowerCase();

  // Extract system error code (Node/Bun set `err.code` on system errors)
  const code: string | undefined = (err as unknown as Record<string, unknown>).code as string | undefined;

  const prefix = `Server "${serverName}"`;

  if (isStdioConfig(config)) {
    if (code === "ENOENT" || msg.includes("not found") || msg.includes("enoent")) {
      return new Error(
        `${prefix} failed: command "${config.command}" not found. Check that it's installed and on your PATH.`,
      );
    }
    if (code === "EACCES" || msg.includes("permission denied") || msg.includes("eacces")) {
      return new Error(`${prefix} failed: permission denied for "${config.command}". Check file permissions.`);
    }
    if (msg.includes("exited") || msg.includes("exit code") || msg.includes("killed") || msg.includes("spawn")) {
      return new Error(
        `${prefix} process exited unexpectedly. Check server logs or run the command manually: ${config.command} ${(config.args ?? []).join(" ")}`,
      );
    }
    // Generic stdio fallback
    return new Error(`${prefix} failed (stdio): ${err.message}`);
  }

  // HTTP and SSE share most network-level errors
  const url = (config as { url: string }).url;

  if (code === "ECONNREFUSED" || msg.includes("econnrefused") || msg.includes("connection refused")) {
    return new Error(`${prefix} failed: could not connect to ${url}. Is the server running?`);
  }
  if (code === "ENOTFOUND" || msg.includes("enotfound") || msg.includes("getaddrinfo")) {
    return new Error(`${prefix} failed: DNS lookup failed for ${url}. Check the URL and your network connection.`);
  }
  if (
    msg.includes("certificate") ||
    msg.includes("ssl") ||
    msg.includes("tls") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return new Error(`${prefix} failed: TLS/certificate error connecting to ${url}. ${err.message}`);
  }
  if (msg.includes("401") || msg.includes("unauthorized")) {
    return new Error(`${prefix} auth failed (401). Run "mcp auth ${serverName}" to re-authenticate.`);
  }
  if (msg.includes("403") || msg.includes("forbidden")) {
    return new Error(
      `${prefix} auth failed (403 Forbidden). Run "mcp auth ${serverName}" to re-authenticate or check your permissions.`,
    );
  }
  if (msg.includes("timeout") || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new Error(
      `${prefix} failed: connection to ${url} timed out. Check network connectivity and server availability.`,
    );
  }

  // SSE-specific
  if (isSseConfig(config) && (msg.includes("stream") || msg.includes("event source") || msg.includes("eventsource"))) {
    return new Error(`${prefix} SSE stream error from ${url}: ${err.message}`);
  }

  // Generic network fallback
  const transport = isHttpConfig(config) ? "http" : "sse";
  return new Error(`${prefix} failed (${transport}): ${err.message}`);
}

// -- Utility --

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

/** Check if a tool passes allowedTools/disabledTools glob filters */
function isToolAllowed(name: string, allowed?: string[], disabled?: string[]): boolean {
  // disabledTools takes precedence
  if (disabled?.length) {
    for (const pattern of disabled) {
      if (globToRegex(pattern).test(name)) return false;
    }
  }
  // If allowedTools is set, tool must match at least one pattern
  if (allowed?.length) {
    for (const pattern of allowed) {
      if (globToRegex(pattern).test(name)) return true;
    }
    return false;
  }
  return true;
}
