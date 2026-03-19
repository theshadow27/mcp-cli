/**
 * Shared tool definitions for the _opencode virtual MCP server.
 *
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

export const OPENCODE_TOOLS = [
  {
    name: "opencode_prompt",
    description:
      "Start a new OpenCode agent session with a prompt, or send a follow-up prompt to an existing session. " +
      "OpenCode is provider-agnostic: it wraps any LLM (Grok, Gemini, Bedrock, open-source) in a coding agent harness. " +
      "Returns the session ID immediately by default. Set wait=true to block until the next actionable event " +
      "(result, error, permission request, or ended).",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The message to send to the agent" },
        provider: {
          type: "string",
          description: 'LLM provider (e.g. "anthropic", "openai", "google", "xai", "bedrock")',
        },
        sessionId: { type: "string", description: "Existing session ID to continue (omit for new session)" },
        cwd: { type: "string", description: "Working directory for the agent process" },
        model: { type: "string", description: "Model override (informational)" },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-approve (e.g. 'Bash(git *)', 'Read')",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-deny",
        },
        worktree: { type: "string", description: "Git worktree name for isolation" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        wait: { type: "boolean", description: "Block until result (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "opencode_session_list",
    description: "List all active OpenCode agent sessions with their status, model, and token usage.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "opencode_session_status",
    description: "Get detailed status for a specific OpenCode agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "opencode_interrupt",
    description: "Interrupt the current prompt of an OpenCode agent session (sends abort).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to interrupt" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "opencode_bye",
    description: "Terminate an OpenCode agent session: kill the process and clean up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to end" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "opencode_transcript",
    description: "Get transcript entries from an OpenCode agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
        limit: { type: "number", description: "Max entries to return (default: 50)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "opencode_wait",
    description:
      "Block until an OpenCode agent session event occurs (result, error, permission request, or ended). " +
      "If sessionId is provided, waits for that session only. Otherwise waits for any session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to wait on (omit for any session)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
      },
    },
  },
  {
    name: "opencode_approve",
    description: "Approve a pending permission request for an OpenCode agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID containing the permission request" },
        requestId: { type: "string", description: "Permission request ID to approve" },
      },
      required: ["sessionId", "requestId"],
    },
  },
  {
    name: "opencode_deny",
    description: "Deny a pending permission request for an OpenCode agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID containing the permission request" },
        requestId: { type: "string", description: "Permission request ID to deny" },
      },
      required: ["sessionId", "requestId"],
    },
  },
] as const;
