/**
 * Shared tool definitions for the _codex virtual MCP server.
 *
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

export const CODEX_TOOLS = [
  {
    name: "codex_prompt",
    description:
      "Start a new Codex session with a prompt, or send a follow-up prompt to an existing session. " +
      "Returns the session ID immediately by default. Set wait=true to block until Codex produces a result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The message to send to Codex" },
        sessionId: { type: "string", description: "Existing session ID to continue (omit for new session)" },
        cwd: { type: "string", description: "Working directory for the Codex process" },
        model: {
          type: "string",
          description: "Model to use (e.g. 'codex-mini', 'o4-mini')",
        },
        approvalPolicy: {
          type: "string",
          enum: ["auto_approve", "on-request", "unless-allow-listed"],
          description: 'Approval handling strategy (default: "on-request")',
        },
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
        sandbox: {
          type: "string",
          enum: ["read-only", "danger-full-access"],
          description: 'Sandbox policy (default: "read-only")',
        },
        worktree: { type: "string", description: "Git worktree name for isolation" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        wait: { type: "boolean", description: "Block until result (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_session_list",
    description: "List all active Codex sessions with their status, model, and token usage.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "codex_session_status",
    description: "Get detailed status for a specific Codex session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "codex_interrupt",
    description: "Interrupt the current turn of a Codex session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to interrupt" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "codex_bye",
    description: "Terminate a Codex session: kill the process and clean up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to end" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "codex_transcript",
    description: "Get transcript entries from a Codex session.",
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
    name: "codex_wait",
    description:
      "Block until a Codex session event occurs (result, error, permission request, or ended). " +
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
    name: "codex_approve",
    description: "Approve a pending permission request for a Codex session.",
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
    name: "codex_deny",
    description: "Deny a pending permission request for a Codex session.",
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
