/**
 * Alias definition types for structured defineAlias() aliases.
 */

import type { z } from "zod/v4";
import type { EventFilterSpec } from "./event-filter";
import type { MonitorEvent } from "./monitor-event";
import { parsePythonRepr } from "./python-repr";

/** Options for the cache() helper in alias context */
export interface CacheOptions {
  /** Namespace prefix — defaults to the current alias name */
  prefix?: string;
  /** Time-to-live in ms — default 24h */
  ttl?: number;
}

/** Sentinel string to detect defineAlias scripts without executing them */
export const DEFINE_ALIAS_SENTINEL = "defineAlias(";

/** Check if source code uses defineAlias() (static text analysis, no execution) */
export function isDefineAlias(source: string): boolean {
  return source.includes(DEFINE_ALIAS_SENTINEL);
}

/** Sentinel string to detect defineMonitor scripts without executing them */
export const DEFINE_MONITOR_SENTINEL = "defineMonitor(";

/** Check if source code uses defineMonitor() (static text analysis, no execution) */
export function isDefineMonitor(source: string): boolean {
  return source.includes(DEFINE_MONITOR_SENTINEL);
}

/**
 * Minimal event shape for monitor alias outputs.
 *
 * Alias generators yield this shape; the runtime adds `src: "alias:<name>"`
 * and maps the result into the daemon's full `MonitorEvent` envelope.
 * `src` is intentionally absent here — the runtime injects it.
 */
export interface AliasMonitorEventInput {
  event: string;
  category?: string;
  [key: string]: unknown;
}

/** Logger passed into a monitor alias subscribe function */
export interface MonitorAliasLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Context available inside a defineMonitor subscribe generator */
export interface MonitorAliasContext {
  /** Fired when the alias is disabled or the daemon is shutting down */
  signal: AbortSignal;
  /** For fire-and-forget side events that shouldn't interrupt the generator */
  bus: { publish(input: AliasMonitorEventInput): void };
  logger: MonitorAliasLogger;
}

/**
 * Structured monitor source definition.
 *
 * An alias that exports a `defineMonitor` is registered at alias-server
 * startup and its async generator yields events that flow into the main
 * monitor bus with `src: "alias:<name>"`.
 *
 * The runtime integration (cross-thread yielding) is delivered separately
 * in P5-alias-runtime. This type defines the contract only.
 */
export interface MonitorAliasDefinition<E extends AliasMonitorEventInput = AliasMonitorEventInput> {
  name: string;
  description?: string;
  subscribe: (ctx: MonitorAliasContext) => AsyncIterable<E>;
}

/**
 * Identity factory for defineMonitor — mirrors the defineAlias pattern.
 * Returns the definition unchanged; provides TypeScript type inference
 * at the call site without leaking bundler internals.
 */
export function defineMonitor<E extends AliasMonitorEventInput = AliasMonitorEventInput>(
  def: MonitorAliasDefinition<E>,
): MonitorAliasDefinition<E> {
  return def;
}

/** Proxy type for calling MCP tools: mcp.server.tool(args) */
export type McpProxy = Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>;

/**
 * Persistent, per-work-item / per-alias scratchpad for cross-invocation state.
 *
 * Values are stored as JSON in the daemon's SQLite database, keyed by
 * (repo_root, namespace, key). The namespace is resolved by the alias
 * runtime — typically the alias name when invoked standalone, or the
 * work_item_id when invoked from a phase.
 */
export interface AliasStateAccessor {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

/**
 * Read-only snapshot of the work item backing the current alias invocation.
 * Populated by the alias runtime by resolving the caller's cwd to a tracked
 * work item (by branch). `null` when there is no matching tracked item.
 */
export interface AliasWorkItemInfo {
  id: string;
  issueNumber: number | null;
  prNumber: number | null;
  branch: string | null;
  phase: string;
}

/** The context available inside a defineAlias handler function */
export interface AliasContext {
  /** Proxy for calling MCP tools: mcp.server.tool(args) */
  mcp: McpProxy;
  /** Raw CLI --key value pairs */
  args: Record<string, string>;
  /** Read a file as text */
  file: (path: string) => Promise<string>;
  /** Read and parse a JSON file */
  json: (path: string) => Promise<unknown>;
  /** Cache a value by key. Returns cached value if fresh, otherwise calls producer. */
  cache: <T>(key: string, producer: () => T | Promise<T>, opts?: CacheOptions) => Promise<T>;
  /**
   * Persistent scratchpad scoped to the current work-item (when invoked from
   * a phase) or to the alias name (when invoked standalone).
   */
  state: AliasStateAccessor;
  /**
   * Escape hatch: persistent scratchpad shared across all aliases and phases
   * in the current repository (namespace = `__global__`).
   */
  globalState: AliasStateAccessor;
  /**
   * Work item backing this invocation (built-in fields only: issueNumber,
   * prNumber, branch, phase). Use `state` for user-declared fields.
   * `null` when the current repo/branch does not map to a tracked work item.
   */
  workItem: AliasWorkItemInfo | null;
  /**
   * Absolute path to the git repository root for the current invocation.
   * Resolved from the caller's cwd via findGitRoot, so it is correct even
   * when the alias or phase is invoked from a subdirectory. Falls back to
   * NO_REPO_ROOT ("__no_repo__") when the caller is not inside a git repo.
   */
  repoRoot?: string;
  /**
   * Cancellation signal for this alias invocation. Fires on SIGINT, SIGTERM,
   * or daemon shutdown. Aliases that do long-running work should check this
   * signal and abort gracefully. `waitForEvent` is wired to this signal
   * automatically — a fired signal causes an in-progress wait to reject
   * immediately with `signal.reason` (an AbortError by default).
   */
  signal: AbortSignal;
  /**
   * Wait for the first monitor event that matches `filter`.
   *
   * Resolves with the matching event. Rejects with `WaitTimeoutError` if
   * `opts.timeoutMs` elapses, or with a `DOMException` with name `"AbortError"`
   * if `ctx.signal` fires, or with an `Error` if the underlying event stream
   * ends or errors before a matching event is observed. The underlying event
   * stream subscription is always cleaned up on resolve/reject — no leaked
   * subscribers.
   *
   * ⚠️ Race warning: if you omit `since`, events that fire between this call
   * and the stream subscription (10–100ms later) are missed. To avoid this,
   * record the latest event sequence **before** triggering the action you're
   * waiting for, then pass it as `opts.since`.
   */
  waitForEvent(filter: EventFilterSpec, opts?: { timeoutMs?: number; since?: number }): Promise<MonitorEvent>;
}

/**
 * Structured alias definition with typed input/output via Zod schemas.
 *
 * At the defineAlias call site, TypeScript infers I and O from the schemas:
 *   defineAlias(({ z }) => ({
 *     input: z.object({ email: z.string() }), // I = { email: string }
 *     fn: (input) => input.email,              // input: { email: string }
 *   }))
 *
 * At the runner level, generics default to unknown for runtime operation.
 */
export interface AliasDefinition<I = unknown, O = unknown> {
  name: string;
  description?: string;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  fn: (input: I, ctx: AliasContext) => O | Promise<O>;
}

/** Alias type discriminant for DB and IPC */
export type AliasType = "freeform" | "defineAlias" | "defineMonitor";

/** Context passed to a defineMonitor subscribe function */
export interface MonitorContext {
  signal: AbortSignal;
  mcp: McpProxy;
}

/**
 * Structured monitor definition with an async generator that yields events.
 *
 * At the defineMonitor call site:
 *   defineMonitor({
 *     name: "my-monitor",
 *     subscribe: async function*(ctx) {
 *       yield { event: "tick", category: "heartbeat" };
 *     },
 *   })
 */
export interface MonitorDefinition {
  name: string;
  description?: string;
  subscribe: (ctx: MonitorContext) => AsyncGenerator<Record<string, unknown>>;
}

/**
 * Unwrap MCP tool call result content for ergonomic alias authoring.
 *
 * MCP results look like: { content: [{type: "text", text: "..."}] }
 * This extracts the actual value, attempting JSON parse on text content.
 */
export function extractContent(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content) && content.length === 1 && content[0].type === "text" && content[0].text) {
      const text = content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        // JSON.parse failed — try Python repr conversion (e.g. Coralogix MCP responses)
        const parsed = parsePythonRepr(text);
        if (parsed !== text) return parsed;
        return text;
      }
    }
    // Multiple content items — return array of text
    return content.filter((c) => c.type === "text").map((c) => c.text);
  }
  return result;
}
