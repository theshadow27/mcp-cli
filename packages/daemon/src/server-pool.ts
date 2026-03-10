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

import type { JsonSchema, ResolvedConfig, ResolvedServer, ServerConfig, ServerStatus, ToolInfo } from "@mcp-cli/core";
import { formatToolSignature } from "@mcp-cli/core";
import {
  CONNECT_INITIAL_DELAY_MS,
  CONNECT_MAX_DELAY_MS,
  CONNECT_MAX_RETRIES,
  CONNECT_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
  getTransportType,
  isHttpConfig,
  isSseConfig,
  isStdioConfig,
} from "@mcp-cli/core";
import { McpOAuthProvider } from "./auth/oauth-provider";
import type { StateDb } from "./db/state";
import { StderrRingBuffer } from "./stderr-buffer";

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
  /** Virtual servers are not managed by config and survive updateConfig(). */
  virtual?: boolean;
}

/**
 * Factory that creates and connects a client+transport pair for a server.
 * Tests inject a mock implementation to avoid real MCP connections.
 */
export type ConnectFn = (
  name: string,
  config: ServerConfig,
  authProvider?: OAuthClientProvider,
) => Promise<{ client: Client; transport: Transport }>;

export class ServerPool {
  private connections = new Map<string, ServerConnection>();
  private reconnecting = new Map<string, Promise<void>>();
  private pendingServers = new Map<string, Promise<void>>();
  private config: ResolvedConfig;
  private db: StateDb | null;
  private stderrBuffer = new StderrRingBuffer();
  private connectFn: ConnectFn;

  constructor(config: ResolvedConfig, db?: StateDb, connectFn?: ConnectFn) {
    this.config = config;
    this.db = db ?? null;
    this.connectFn = connectFn ?? defaultConnect;
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

  /**
   * Register a pre-connected virtual server (e.g., _aliases).
   * Virtual servers survive updateConfig() and are reported with transport "virtual".
   */
  registerVirtualServer(name: string, client: Client, transport: Transport, tools?: Map<string, ToolInfo>): void {
    // Disconnect existing connection if present
    const existing = this.connections.get(name);
    if (existing) {
      existing.client?.close().catch(() => {});
    }

    this.connections.set(name, {
      name,
      resolved: { name, config: { command: "__virtual__" }, source: { file: "built-in", scope: "mcp-cli" } },
      client,
      transport,
      tools: tools ?? new Map(),
      state: "connected",
      lastUsed: Date.now(),
      virtual: true,
    });
  }

  /**
   * Register a virtual server that is still starting up.
   * The promise resolves when the server is ready and registered via registerVirtualServer().
   * Commands that need this server will await the promise; others proceed immediately.
   *
   * If the startup promise does not settle within `timeoutMs` (default 30s), the pending
   * entry is removed so the idle timer can proceed normally. The underlying startup may
   * still complete later and call registerVirtualServer() successfully.
   */
  registerPendingVirtualServer(name: string, startPromise: Promise<void>, timeoutMs = 30_000): void {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`startup timed out after ${timeoutMs}ms`)), timeoutMs);
      // Don't let the timer keep the process alive if everything else has exited
      (timer as NodeJS.Timeout).unref?.();
    });
    const tracked = Promise.race([startPromise, timeout])
      .catch((err) => {
        console.error(`[pool] Pending virtual server "${name}" failed: ${err}`);
      })
      .finally(() => {
        clearTimeout(timer);
        this.pendingServers.delete(name);
      });
    this.pendingServers.set(name, tracked);
  }

  /** Wait for all pending virtual server startups to settle (resolve or reject). */
  async awaitPendingServers(): Promise<void> {
    if (this.pendingServers.size > 0) {
      await Promise.allSettled([...this.pendingServers.values()]);
    }
  }

  /** Returns true if any virtual servers are still starting up. */
  hasPendingServers(): boolean {
    return this.pendingServers.size > 0;
  }

  /** Update config (e.g., after file change). Returns names of changed/added/removed servers. */
  updateConfig(config: ResolvedConfig): { added: string[]; removed: string[]; changed: string[] } {
    this.config = config;
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    // Add new servers, detect changed configs
    for (const [name, resolved] of config.servers) {
      const existing = this.connections.get(name);
      if (!existing) {
        added.push(name);
        this.connections.set(name, {
          name,
          resolved,
          client: null,
          transport: null,
          tools: new Map(),
          state: "disconnected",
          lastUsed: 0,
        });
      } else if (!Bun.deepEquals(existing.resolved.config, resolved.config)) {
        changed.push(name);
        existing.resolved = resolved;
        // Reconnect if currently connected (skip if already reconnecting)
        if (existing.state === "connected" && !this.reconnecting.has(name)) {
          const reconnectPromise = this.disconnect(name)
            .then(() => {
              console.error(`[pool] Reconnecting "${name}" after config change`);
              return this.ensureConnected(name);
            })
            .then(() => {})
            .catch((err) => {
              console.error(`[pool] Failed to reconnect "${name}" after config change: ${err}`);
            })
            .finally(() => {
              this.reconnecting.delete(name);
            });
          this.reconnecting.set(name, reconnectPromise);
        }
      }
    }

    // Remove servers no longer in config (skip virtual servers)
    for (const [name, conn] of this.connections) {
      if (conn.virtual) continue;
      if (!config.servers.has(name)) {
        removed.push(name);
        this.disconnect(name).catch(() => {});
        this.connections.delete(name);
      }
    }

    return { added, removed, changed };
  }

  /** Get or establish connection to a server */
  private async ensureConnected(name: string): Promise<ServerConnection> {
    // Wait for pending virtual server startup if not yet registered
    const pending = this.pendingServers.get(name);
    if (pending) await pending;

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
        const { clientId, clientSecret, callbackPort } = config;
        authProvider = new McpOAuthProvider(name, config.url, this.db, { clientId, clientSecret, callbackPort });
      }

      let lastErr: Error = new Error("Connection failed");
      const maxRetries = CONNECT_MAX_RETRIES;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Connect with timeout to prevent permanent hang on unresponsive servers
          const { client, transport } = await Promise.race([
            this.connectFn(name, config, authProvider),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Connection to "${name}" timed out after ${CONNECT_TIMEOUT_MS}ms`)),
                CONNECT_TIMEOUT_MS,
              ),
            ),
          ]);

          // Attach stderr capture (Node streams buffer in paused mode, so no data is lost)
          this.attachStderrCapture(name, transport, conn);

          conn.client = client;
          conn.transport = transport;
          conn.state = "connected";
          conn.lastUsed = Date.now();
          conn.lastError = undefined;

          // Detect server crashes / transport close to reset stale "connected" state
          this.attachTransportLifecycle(name, transport, conn);

          // Cache tools on connect
          await this.refreshTools(conn);

          return conn;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err), { cause: err });

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

  /** Attach onclose/onerror handlers to detect server crashes and reset state. */
  private attachTransportLifecycle(name: string, transport: Transport, conn: ServerConnection): void {
    const reset = (reason: string) => {
      if (conn.state === "connected") {
        console.error(`[pool] Server "${name}" transport ${reason}, resetting connection state`);
        conn.state = "disconnected";
        conn.client = null;
        conn.transport = null;
      }
    };

    transport.onclose = () => reset("closed");
    transport.onerror = (err: Error) => {
      conn.lastError = err.message;
      reset(`error: ${err.message}`);
    };
  }

  /** Get recent stderr lines for a server from the in-memory ring buffer. */
  getStderrLines(server: string, limit?: number): Array<{ timestamp: number; line: string }> {
    return this.stderrBuffer.getLines(server, limit);
  }

  /** List all configured servers with status */
  listServers(): ServerStatus[] {
    const servers: ServerStatus[] = [...this.connections.values()].map((conn) => {
      const recent = this.stderrBuffer.getLines(conn.name, 3);
      const recentStderr = recent.length > 0 ? recent.map((l) => l.line) : undefined;
      return {
        name: conn.name,
        transport: conn.virtual ? ("virtual" as const) : getTransportType(conn.resolved.config),
        state: conn.state,
        toolCount: conn.tools.size,
        lastUsed: conn.lastUsed || undefined,
        lastError: conn.lastError,
        source: conn.resolved.source.file,
        recentStderr,
      };
    });

    // Include pending virtual servers that haven't registered yet
    for (const name of this.pendingServers.keys()) {
      if (!this.connections.has(name)) {
        servers.push({
          name,
          transport: "virtual",
          state: "connecting",
          toolCount: 0,
          source: "built-in",
        });
      }
    }

    return servers;
  }

  /** List tools for a specific server. Returns cached tools if available, connects only if no cache. */
  async listTools(serverName?: string): Promise<ToolInfo[]> {
    if (serverName) {
      // Wait for pending virtual server startup before checking connections
      const pending = this.pendingServers.get(serverName);
      if (pending) await pending;

      const conn = this.connections.get(serverName);
      if (!conn) throw new Error(`Server "${serverName}" not found`);

      // Return cached tools if we have any (from connect or SQLite)
      if (conn.tools.size > 0) return [...conn.tools.values()];

      // No cache — must connect to discover tools
      const connected = await this.ensureConnected(serverName);
      return [...connected.tools.values()];
    }

    // Wait for any pending virtual servers before listing all tools
    await this.awaitPendingServers();

    // List all — return cached tools, connect only servers with no cache
    const results: ToolInfo[] = [];
    const needConnect: string[] = [];

    for (const [name, conn] of this.connections) {
      if (conn.tools.size > 0) {
        results.push(...conn.tools.values());
      } else {
        needConnect.push(name);
      }
    }

    if (needConnect.length > 0) {
      const settled = await Promise.allSettled(needConnect.map((name) => this.ensureConnected(name)));
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === "fulfilled") {
          results.push(...outcome.value.tools.values());
        }
        // Silently skip connection failures — we already have tools from other servers
      }
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

  /** Call a tool on a server. Auto-retries once on transient errors (connection lost, timeout). */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = MCP_TOOL_TIMEOUT_MS,
  ): Promise<unknown> {
    const conn = await this.ensureConnected(serverName);
    if (!conn.client) throw new Error(`Not connected to "${serverName}"`);

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
      conn.lastUsed = Date.now();
      return result;
    } catch (err) {
      // Surface non-transient errors immediately (auth, config, etc.)
      if (!isTransientCallError(err)) throw err;

      console.error(
        `[mcpd] callTool "${toolName}" on "${serverName}" failed with transient error, reconnecting: ${err instanceof Error ? err.message : String(err)}`,
      );

      // Attempt one reconnect + retry
      await this.disconnect(serverName);
      const reconnected = await this.ensureConnected(serverName);
      if (!reconnected.client) throw new Error(`Reconnect to "${serverName}" failed`);

      const result = await reconnected.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: timeoutMs,
      });
      reconnected.lastUsed = Date.now();
      return result;
    }
  }

  /** Search tools across all servers by pattern (case-insensitive substring) */
  async grepTools(pattern: string): Promise<ToolInfo[]> {
    const allTools = await this.listTools();
    const regex = searchRegex(pattern);
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
      // Restart all connected servers in parallel
      const connected = [...this.connections.entries()].filter(([, c]) => c.state === "connected");
      const results = await Promise.allSettled(
        connected.map(async ([serverName]) => {
          await this.disconnect(serverName);
          await this.ensureConnected(serverName);
        }),
      );
      for (const [i, result] of results.entries()) {
        if (result.status === "rejected") {
          console.error(`[pool] Failed to restart "${connected[i][0]}": ${result.reason}`);
        }
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

  /** Get the resolved config for a server by name */
  getServerConfig(name: string): ServerConfig | undefined {
    return this.connections.get(name)?.resolved.config;
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

// -- Environment allowlist --

/**
 * Minimal set of environment variables passed to stdio child processes.
 * Only these vars are inherited from the daemon's process.env — all others
 * (AWS_*, GITHUB_TOKEN, SSH_AUTH_SOCK, etc.) are excluded unless explicitly
 * configured in the server's `env` block.
 */
export const BASE_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "SHELL",
  "USER",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
];

/**
 * Build the environment object for a stdio child process.
 *
 * Returns only: (a) allowlisted base vars from `parentEnv`, plus
 * (b) explicitly configured vars from `configuredEnv`. This prevents
 * leaking secrets (AWS credentials, GitHub tokens, etc.) to child servers.
 *
 * @internal Exported for testing only.
 */
export function buildChildEnv(
  parentEnv: Record<string, string | undefined>,
  configuredEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  // (a) Only inherit allowlisted vars from the parent process
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }

  // (b) Merge explicitly configured vars (these may override allowlisted ones)
  if (configuredEnv) Object.assign(env, configuredEnv);

  return env;
}

/**
 * Classify whether a callTool error is transient and worth a single reconnect + retry.
 *
 * Covers the same network-level codes as `isRetryableError` plus patterns that indicate
 * a stale or broken connection (e.g., the MCP server disconnected between calls).
 *
 * Auth errors, config errors, and application-level failures are NOT transient.
 */
export function isTransientCallError(err: unknown): boolean {
  // All connection-level retryable errors are also transient call errors
  if (isRetryableError(err)) return true;

  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();

  // NOT transient: auth failures, bad config, missing tools/servers
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("not found") ||
    msg.includes("permission denied") ||
    msg.includes("invalid") ||
    msg.includes("not allowed")
  ) {
    return false;
  }

  // Stale connection / disconnected patterns
  if (
    msg.includes("closed") ||
    msg.includes("disconnected") ||
    msg.includes("connection lost") ||
    msg.includes("broken pipe") ||
    msg.includes("stream") ||
    msg.includes("aborted") ||
    msg.includes("transport") ||
    msg.includes("eof") ||
    msg.includes("reset")
  ) {
    return true;
  }

  return false;
}

// -- Transport factories --

async function defaultConnect(
  name: string,
  config: ServerConfig,
  authProvider?: OAuthClientProvider,
): Promise<{ client: Client; transport: Transport }> {
  const transport = createTransport(config, authProvider);
  const client = new Client({ name: `mcp-cli/${name}`, version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

function createTransport(config: ServerConfig, authProvider?: OAuthClientProvider): Transport {
  if (isStdioConfig(config)) {
    const mergedEnv = buildChildEnv(process.env as Record<string, string | undefined>, config.env);

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
    return new Error(`${prefix} auth failed (401). Run "mcx auth ${serverName}" to re-authenticate.`);
  }
  if (msg.includes("403") || msg.includes("forbidden")) {
    return new Error(
      `${prefix} auth failed (403 Forbidden). Run "mcx auth ${serverName}" to re-authenticate or check your permissions.`,
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

/** Case-insensitive substring regex for grepTools search (unanchored). */
function searchRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

/** Check if a tool passes allowedTools/disabledTools glob filters.
 *  Uses Bun.Glob for anchored, case-sensitive matching. */
function isToolAllowed(name: string, allowed?: string[], disabled?: string[]): boolean {
  // disabledTools takes precedence
  if (disabled?.length) {
    for (const pattern of disabled) {
      if (new Bun.Glob(pattern).match(name)) return false;
    }
  }
  // If allowedTools is set, tool must match at least one pattern
  if (allowed?.length) {
    for (const pattern of allowed) {
      if (new Bun.Glob(pattern).match(name)) return true;
    }
    return false;
  }
  return true;
}
