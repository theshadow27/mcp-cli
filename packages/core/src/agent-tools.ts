/**
 * Shared agent tool definition types and builder.
 *
 * All agent providers (Claude, Codex, ACP) expose a common set of MCP tools
 * with provider-specific prefixes. This module captures the shared schema so
 * providers only specify their overrides — the ~90% common surface is defined
 * once.
 *
 * Follows Option C from #912: daemon tools keep per-provider prefixes,
 * but the definitions are generated from a single source of truth.
 */

import { DEFAULT_TIMEOUT_MS } from "./constants";

// ---------------------------------------------------------------------------
// JSON Schema helpers (matches the shape MCP SDK expects)
// ---------------------------------------------------------------------------

/** A single JSON Schema property definition. */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: readonly string[];
  items?: { type: string };
}

/** The inputSchema shape every MCP tool uses. */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Record<string, JsonSchemaProperty>;
  readonly required?: readonly string[];
}

/** A single MCP tool definition (name + description + inputSchema). */
export interface AgentToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

// ---------------------------------------------------------------------------
// Common tool names (unprefixed)
// ---------------------------------------------------------------------------

/**
 * The canonical set of tool basenames every agent provider exposes.
 * Provider-specific extras (e.g. claude `plans`) are added separately.
 */
export const AGENT_TOOL_NAMES = [
  "prompt",
  "session_list",
  "session_status",
  "interrupt",
  "bye",
  "transcript",
  "wait",
  "approve",
  "deny",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Common property groups (reusable across providers)
// ---------------------------------------------------------------------------

const sessionIdProp: JsonSchemaProperty = {
  type: "string",
  description: "Session ID or unique prefix",
};

const timeoutProp: JsonSchemaProperty = {
  type: "number",
  description: `Max wait time in ms (default: ${DEFAULT_TIMEOUT_MS})`,
};

const limitProp: JsonSchemaProperty = {
  type: "number",
  description: "Max entries to return (default: 50)",
};

const requestIdProp: JsonSchemaProperty = {
  type: "string",
  description: "Permission request ID",
};

// ---------------------------------------------------------------------------
// Override slots
// ---------------------------------------------------------------------------

/**
 * Per-tool overrides a provider can supply.
 *
 * - `extraProperties`: additional inputSchema properties merged on top of the
 *   common ones.
 * - `extraRequired`: additional required fields appended to the common ones.
 * - `omitProperties`: common property names to drop from the inputSchema.
 *   Use this when a provider does not implement a field that the shared base
 *   includes, so the tool description does not promise behaviour the worker
 *   cannot deliver.
 * - `description`: replaces the default description entirely.
 */
export interface ToolOverride {
  extraProperties?: Record<string, JsonSchemaProperty>;
  extraRequired?: readonly string[];
  omitProperties?: readonly string[];
  description?: string;
}

export type ToolOverrides = Partial<Record<AgentToolName, ToolOverride>>;

/**
 * An additional tool definition not in the common set (e.g. `claude_plans`).
 */
export interface ExtraTool {
  /** Unprefixed basename — will become `${prefix}_${basename}`. */
  basename: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyOmit(
  properties: Record<string, JsonSchemaProperty>,
  required: readonly string[] | undefined,
  omit: readonly string[] | undefined,
): { properties: Record<string, JsonSchemaProperty>; required?: readonly string[] } {
  if (!omit || omit.length === 0) {
    return required && required.length > 0 ? { properties, required } : { properties };
  }
  const set = new Set(omit);
  const filtered = required?.filter((r) => !set.has(r));
  const result: { properties: Record<string, JsonSchemaProperty>; required?: readonly string[] } = {
    properties: Object.fromEntries(Object.entries(properties).filter(([k]) => !set.has(k))),
  };
  if (filtered && filtered.length > 0) result.required = filtered;
  return result;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildAgentToolsOptions {
  /** Tool name prefix, e.g. `"claude"`, `"codex"`, `"acp"`. */
  prefix: string;
  /** Human-readable provider label for descriptions, e.g. `"Claude Code"`. */
  label: string;
  /** Per-tool overrides. */
  overrides?: ToolOverrides;
  /** Extra tools beyond the common set. */
  extraTools?: readonly ExtraTool[];
}

/**
 * Build the full MCP tool array for an agent provider.
 *
 * Returns a readonly tuple typed as `AgentToolDef[]` so consumers can use it
 * directly with MCP Server `setRequestHandler(ListToolsRequestSchema, …)`.
 */
export function buildAgentTools(opts: BuildAgentToolsOptions): readonly AgentToolDef[] {
  const { prefix, label, overrides = {}, extraTools = [] } = opts;
  const p = (name: string) => `${prefix}_${name}`;
  const ov = (name: AgentToolName) => overrides[name];
  const art = /^[aeiou]/i.test(label) ? "an" : "a";

  const schema = (name: AgentToolName, properties: Record<string, JsonSchemaProperty>, required?: readonly string[]) =>
    applyOmit(properties, required, ov(name)?.omitProperties);

  const tools: AgentToolDef[] = [
    // -- prompt --
    {
      name: p("prompt"),
      description:
        ov("prompt")?.description ??
        `Start a new ${label} session with a prompt, or send a follow-up prompt to an existing session. Returns the session ID immediately by default. Set wait=true to block until the next actionable event.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "prompt",
          {
            prompt: { type: "string", description: `The message to send to ${label}` },
            sessionId: {
              type: "string",
              description: "Existing session ID to continue (omit for new session)",
            },
            cwd: { type: "string", description: "Working directory for the process" },
            model: { type: "string", description: "Model to use" },
            allowedTools: {
              type: "array",
              items: { type: "string" },
              description: "Tool patterns to auto-approve (e.g. 'Bash(git *)', 'Read')",
            },
            worktree: { type: "string", description: "Git worktree name for isolation" },
            name: {
              type: "string",
              description: "Human-readable session name (auto-generated if omitted)",
            },
            timeout: timeoutProp,
            wait: { type: "boolean", description: "Block until result (default: false)" },
            ...ov("prompt")?.extraProperties,
          },
          ["prompt", ...(ov("prompt")?.extraRequired ?? [])],
        ),
      },
    },

    // -- session_list --
    {
      name: p("session_list"),
      description:
        ov("session_list")?.description ??
        `List all active ${label} sessions with their status, model, and token usage.`,
      inputSchema: {
        type: "object" as const,
        ...schema("session_list", {
          ...ov("session_list")?.extraProperties,
        }),
      },
    },

    // -- session_status --
    {
      name: p("session_status"),
      description: ov("session_status")?.description ?? `Get detailed status for a specific ${label} session.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "session_status",
          {
            sessionId: { ...sessionIdProp, description: "Session ID or unique prefix to query" },
            ...ov("session_status")?.extraProperties,
          },
          ["sessionId"],
        ),
      },
    },

    // -- interrupt --
    {
      name: p("interrupt"),
      description: ov("interrupt")?.description ?? `Interrupt the current turn of a ${label} session.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "interrupt",
          {
            sessionId: { ...sessionIdProp, description: "Session ID or unique prefix to interrupt" },
            reason: {
              type: "string" as const,
              description:
                "Optional reason for the interruption. When provided, it is prepended to the next send so the session understands why it was interrupted.",
            },
            ...ov("interrupt")?.extraProperties,
          },
          ["sessionId"],
        ),
      },
    },

    // -- bye --
    {
      name: p("bye"),
      description:
        ov("bye")?.description ??
        `Gracefully end a ${label} session: close the connection, stop the process, clean up.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "bye",
          {
            sessionId: { ...sessionIdProp, description: "Session ID or unique prefix to end" },
            message: {
              type: "string",
              description:
                "Closing message explaining why the session is being ended. Logged to the session transcript.",
            },
            ...ov("bye")?.extraProperties,
          },
          ["sessionId"],
        ),
      },
    },

    // -- transcript --
    {
      name: p("transcript"),
      description: ov("transcript")?.description ?? `Get recent transcript entries from ${art} ${label} session.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "transcript",
          {
            sessionId: { ...sessionIdProp, description: "Session ID or unique prefix to query" },
            limit: limitProp,
            ...ov("transcript")?.extraProperties,
          },
          ["sessionId"],
        ),
      },
    },

    // -- wait --
    {
      name: p("wait"),
      description:
        ov("wait")?.description ??
        `Block until a ${label} session event occurs (result, error, or permission request). If sessionId is provided, waits for that session only. Otherwise waits for any session.`,
      inputSchema: {
        type: "object" as const,
        ...schema("wait", {
          sessionId: {
            ...sessionIdProp,
            description: "Session ID or unique prefix to wait on (omit for any session)",
          },
          timeout: timeoutProp,
          ...ov("wait")?.extraProperties,
        }),
      },
    },

    // -- approve --
    {
      name: p("approve"),
      description: ov("approve")?.description ?? `Approve a pending permission request for ${art} ${label} session.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "approve",
          {
            sessionId: {
              ...sessionIdProp,
              description: "Session ID or unique prefix containing the permission request",
            },
            requestId: { ...requestIdProp, description: "Permission request ID to approve" },
            ...ov("approve")?.extraProperties,
          },
          ["sessionId", "requestId"],
        ),
      },
    },

    // -- deny --
    {
      name: p("deny"),
      description: ov("deny")?.description ?? `Deny a pending permission request for ${art} ${label} session.`,
      inputSchema: {
        type: "object" as const,
        ...schema(
          "deny",
          {
            sessionId: {
              ...sessionIdProp,
              description: "Session ID or unique prefix containing the permission request",
            },
            requestId: { ...requestIdProp, description: "Permission request ID to deny" },
            ...ov("deny")?.extraProperties,
          },
          ["sessionId", "requestId"],
        ),
      },
    },
  ];

  // Append provider-specific extra tools
  for (const extra of extraTools) {
    tools.push({
      name: p(extra.basename),
      description: extra.description,
      inputSchema: extra.inputSchema,
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Utility: resolve a generic tool basename to a prefixed name
// ---------------------------------------------------------------------------

/**
 * Given a tool prefix and a generic basename, return the provider-specific
 * tool name. Useful for CLI code that needs to construct tool calls.
 *
 * ```ts
 * prefixedToolName("claude", "prompt") // → "claude_prompt"
 * ```
 */
export function prefixedToolName(prefix: string, basename: string): string {
  return `${prefix}_${basename}`;
}
