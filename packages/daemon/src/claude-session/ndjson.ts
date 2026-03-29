/**
 * NDJSON parser/serializer for the Claude Code WebSocket SDK protocol.
 *
 * Wire format: newline-delimited JSON over WebSocket text frames.
 * Reference: WEBSOCKET_PROTOCOL_REVERSED.md
 */

import { z } from "zod/v4";

// ── Shared schemas ──

const ContentBlock = z.record(z.string(), z.unknown());

const Usage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

// ── Inbound schemas (CLI → Server) ──

export const SystemInit = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    cwd: z.string(),
    session_id: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
    model: z.string(),
    permissionMode: z.string(),
    apiKeySource: z.string(),
    claude_code_version: z.string(),
    uuid: z.string(),
  })
  .passthrough();

/**
 * Loose init schema — requires only the fields the state machine needs
 * (session_id, model, cwd). Used as a fallback when SystemInit doesn't
 * match, so the session still initializes instead of staying stuck in
 * "connecting" forever.
 */
export const SystemInitFallback = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const SystemStatus = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("status"),
    status: z.string().nullable(),
    uuid: z.string(),
    session_id: z.string(),
  })
  .passthrough();

export const Assistant = z.object({
  type: z.literal("assistant"),
  message: z
    .object({
      id: z.string(),
      type: z.literal("message"),
      role: z.literal("assistant"),
      model: z.string(),
      content: z.array(ContentBlock),
      stop_reason: z.string().nullable(),
      usage: Usage,
    })
    .passthrough(),
  parent_tool_use_id: z.string().nullable(),
  error: z.string().optional(),
  uuid: z.string(),
  session_id: z.string(),
});

/**
 * Loose assistant schema — requires only the fields the state machine needs
 * (usage for token tracking). Used as a fallback when Assistant doesn't match,
 * so the session still transitions to "active" and accumulates tokens.
 */
export const AssistantFallback = z
  .object({
    type: z.literal("assistant"),
    message: z
      .object({
        usage: Usage.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ResultSuccess = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    is_error: z.literal(false).optional(),
    result: z.string(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number(),
    total_cost_usd: z.number(),
    usage: Usage,
    uuid: z.string().optional(),
    session_id: z.string(),
  })
  .passthrough();

export const ResultError = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.literal(true).optional(),
    errors: z.array(z.string()),
    duration_ms: z.number().optional(),
    num_turns: z.number(),
    total_cost_usd: z.number(),
    uuid: z.string().optional(),
    session_id: z.string(),
  })
  .passthrough();

/**
 * Loose result schema — matches any `type: "result"` message regardless of
 * other fields. Used as a fallback when neither ResultSuccess nor ResultError
 * match, so the session still transitions to idle instead of staying stuck.
 */
export const ResultFallback = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    result: z.string().optional(),
    errors: z.array(z.string()).optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: Usage.optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

export const CanUseToolRequest = z.object({
  subtype: z.literal("can_use_tool"),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
  description: z.string().optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
  agent_id: z.string().optional(),
  decision_reason: z.string().optional(),
  blocked_path: z.string().optional(),
});

export const CanUseTool = z.object({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: CanUseToolRequest,
});

export const HookCallback = z.object({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.object({
    subtype: z.literal("hook_callback"),
    callback_id: z.string(),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().optional(),
  }),
});

export const ToolProgress = z.object({
  type: z.literal("tool_progress"),
  tool_use_id: z.string(),
  tool_name: z.string(),
  parent_tool_use_id: z.string().nullable(),
  elapsed_time_seconds: z.number(),
  uuid: z.string(),
  session_id: z.string(),
});

export const StreamEvent = z.object({
  type: z.literal("stream_event"),
  event: z.unknown(),
  parent_tool_use_id: z.string().nullable(),
  uuid: z.string(),
  session_id: z.string(),
});

export const ToolUseSummary = z.object({
  type: z.literal("tool_use_summary"),
  summary: z.string(),
  preceding_tool_use_ids: z.array(z.string()),
  uuid: z.string(),
  session_id: z.string(),
});

export const AuthStatus = z.object({
  type: z.literal("auth_status"),
  isAuthenticating: z.boolean(),
  output: z.array(z.string()),
  error: z.string().optional(),
  uuid: z.string(),
  session_id: z.string(),
});

export const KeepAlive = z.object({
  type: z.literal("keep_alive"),
});

// ── Outbound schemas (Server → CLI) ──

export const UserMessage = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(ContentBlock)]),
  }),
  parent_tool_use_id: z.string().nullable(),
  session_id: z.string(),
  uuid: z.string().optional(),
  isSynthetic: z.boolean().optional(),
});

export const ControlResponseSuccess = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    request_id: z.string(),
    response: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ControlResponseError = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("error"),
    request_id: z.string(),
    error: z.string(),
    pending_permission_requests: z.array(z.unknown()).optional(),
  }),
});

export const ControlCancelRequest = z.object({
  type: z.literal("control_cancel_request"),
  request_id: z.string(),
});

export const InitializeRequest = z.object({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.object({
    subtype: z.literal("initialize"),
    hooks: z.record(z.string(), z.unknown()).optional(),
    sdkMcpServers: z.array(z.string()).optional(),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    agents: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const InterruptRequest = z.object({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.object({
    subtype: z.literal("interrupt"),
  }),
});

// ── Tool permission response types ──

export const PermissionAllow = z.object({
  behavior: z.literal("allow"),
  updatedInput: z.record(z.string(), z.unknown()),
  updatedPermissions: z.array(z.unknown()).optional(),
  toolUseID: z.string().optional(),
});

export const PermissionDeny = z.object({
  behavior: z.literal("deny"),
  message: z.string(),
  interrupt: z.boolean().optional(),
  toolUseID: z.string().optional(),
});

// ── Inferred types ──

export type SystemInit = z.infer<typeof SystemInit>;
export type SystemInitFallback = z.infer<typeof SystemInitFallback>;
export type SystemStatus = z.infer<typeof SystemStatus>;
export type Assistant = z.infer<typeof Assistant>;
export type AssistantFallback = z.infer<typeof AssistantFallback>;
export type ResultSuccess = z.infer<typeof ResultSuccess>;
export type ResultError = z.infer<typeof ResultError>;
export type ResultFallback = z.infer<typeof ResultFallback>;
export type CanUseTool = z.infer<typeof CanUseTool>;
export type HookCallback = z.infer<typeof HookCallback>;
export type ToolProgress = z.infer<typeof ToolProgress>;
export type StreamEvent = z.infer<typeof StreamEvent>;
export type ToolUseSummary = z.infer<typeof ToolUseSummary>;
export type AuthStatus = z.infer<typeof AuthStatus>;
export type KeepAlive = z.infer<typeof KeepAlive>;
export type UserMessage = z.infer<typeof UserMessage>;
export type ControlResponseSuccess = z.infer<typeof ControlResponseSuccess>;
export type ControlResponseError = z.infer<typeof ControlResponseError>;
export type ControlCancelRequest = z.infer<typeof ControlCancelRequest>;
export type InitializeRequest = z.infer<typeof InitializeRequest>;
export type InterruptRequest = z.infer<typeof InterruptRequest>;
export type PermissionAllow = z.infer<typeof PermissionAllow>;
export type PermissionDeny = z.infer<typeof PermissionDeny>;

/** Any parsed NDJSON message with at least a `type` field. */
export type NdjsonMessage = { type: string; [key: string]: unknown };

// ── Parsing ──

const Envelope = z.object({ type: z.string() }).passthrough();

/** Parse a single NDJSON line into a loosely-typed message. */
export function parseLine(line: string): NdjsonMessage {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("Empty NDJSON line");
  return Envelope.parse(JSON.parse(trimmed));
}

/**
 * Parse a WebSocket text frame that may contain multiple NDJSON lines.
 * Filters out empty lines.
 */
export function parseFrame(frame: string): NdjsonMessage[] {
  return frame
    .split("\n")
    .filter((l) => l.trim())
    .map(parseLine);
}

// ── Serialization ──

/** Serialize a message object to an NDJSON line (JSON + newline). */
export function serialize(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Build a `user` message to send to the CLI. */
export function userMessage(
  content: string | unknown[],
  sessionId: string,
  opts?: { parentToolUseId?: string; uuid?: string },
): string {
  return serialize({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: opts?.parentToolUseId ?? null,
    session_id: sessionId,
    ...(opts?.uuid && { uuid: opts.uuid }),
  });
}

/** Build a `control_response` (success) for a pending control request. */
export function controlResponseSuccess(requestId: string, response?: Record<string, unknown>): string {
  return serialize({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      ...(response && { response }),
    },
  });
}

/** Build a `control_response` (error) for a pending control request. */
export function controlResponseError(requestId: string, error: string): string {
  return serialize({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error,
    },
  });
}

/** Build a permission allow response for a `can_use_tool` request. */
export function permissionAllow(
  requestId: string,
  updatedInput: Record<string, unknown>,
  updatedPermissions?: unknown[],
): string {
  return controlResponseSuccess(requestId, {
    behavior: "allow",
    updatedInput,
    ...(updatedPermissions && { updatedPermissions }),
  });
}

/** Build a permission deny response for a `can_use_tool` request. */
export function permissionDeny(requestId: string, message: string, interrupt?: boolean): string {
  return controlResponseSuccess(requestId, {
    behavior: "deny",
    message,
    ...(interrupt !== undefined && { interrupt }),
  });
}

/** Build a `control_request` for `initialize`. */
export function initializeRequest(
  requestId: string,
  opts?: {
    systemPrompt?: string;
    appendSystemPrompt?: string;
    hooks?: Record<string, unknown>;
    sdkMcpServers?: string[];
    agents?: Record<string, unknown>;
  },
): string {
  return serialize({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "initialize",
      ...opts,
    },
  });
}

/** Build a `control_request` for `interrupt`. */
export function interruptRequest(requestId: string): string {
  return serialize({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}

/** Build a `control_request` for `set_model`. Pass "default" to reset. */
export function setModelRequest(requestId: string, model: string): string {
  return serialize({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_model", model },
  });
}

/** Build a `keep_alive` message. */
export function keepAlive(): string {
  return serialize({ type: "keep_alive" });
}
