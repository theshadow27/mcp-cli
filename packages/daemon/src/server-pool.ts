/**
 * ServerPool — manages multiplexed MCP server connections.
 *
 * Connections are lazy: established on first tool call, cached, and
 * disconnected after idle timeout.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  ResolvedConfig,
  ResolvedServer,
  ServerConfig,
  ServerStatus,
  ToolInfo,
} from "@mcp-cli/core";
import { getTransportType, isHttpConfig, isSseConfig, isStdioConfig } from "@mcp-cli/core";

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
}

export class ServerPool {
  private connections = new Map<string, ServerConnection>();
  private config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.config = config;
    // Pre-populate connection entries (disconnected)
    for (const [name, resolved] of config.servers) {
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

    // Connect
    conn.state = "connecting";
    try {
      const transport = createTransport(conn.resolved.config);
      const client = new Client({ name: `mcp-cli/${name}`, version: "0.1.0" });

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
      conn.state = "error";
      conn.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Refresh cached tool list for a connection */
  private async refreshTools(conn: ServerConnection): Promise<void> {
    if (!conn.client) return;
    try {
      const { tools } = await conn.client.listTools();
      conn.tools.clear();
      for (const tool of tools) {
        conn.tools.set(tool.name, {
          name: tool.name,
          server: conn.name,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        });
      }
    } catch (err) {
      console.error(`[pool] Failed to list tools for "${conn.name}": ${err}`);
    }
  }

  /** List all configured servers with status */
  listServers(): ServerStatus[] {
    return [...this.connections.values()].map((conn) => ({
      name: conn.name,
      transport: getTransportType(conn.resolved.config),
      state: conn.state,
      toolCount: conn.tools.size,
      lastUsed: conn.lastUsed || undefined,
      lastError: conn.lastError,
      source: conn.resolved.source.file,
    }));
  }

  /** List tools for a specific server (connects if needed) */
  async listTools(serverName?: string): Promise<ToolInfo[]> {
    if (serverName) {
      const conn = await this.ensureConnected(serverName);
      return [...conn.tools.values()];
    }
    // List all — connect to all servers
    const results: ToolInfo[] = [];
    const errors: string[] = [];
    for (const name of this.connections.keys()) {
      try {
        const conn = await this.ensureConnected(name);
        results.push(...conn.tools.values());
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
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

  /** Get names of servers idle longer than the threshold */
  getIdleServers(thresholdMs: number): string[] {
    const now = Date.now();
    return [...this.connections.entries()]
      .filter(([, c]) => c.state === "connected" && c.lastUsed > 0 && now - c.lastUsed > thresholdMs)
      .map(([name]) => name);
  }
}

// -- Transport factories --

function createTransport(config: ServerConfig): Transport {
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
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  if (isSseConfig(config)) {
    return new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  throw new Error(`Unknown transport type for config: ${JSON.stringify(config)}`);
}

// -- Utility --

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}
