/**
 * Shared tool definitions for the _acp virtual MCP server.
 *
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

export const ACP_TOOLS = [
  {
    name: "acp_prompt",
    description:
      "Start a new ACP agent session with a prompt, or send a follow-up prompt to an existing session. " +
      "Supports any ACP-compatible agent (Copilot, Gemini, etc.) via the 'agent' parameter. " +
      "Returns the session ID immediately by default. Set wait=true to block until the next actionable event " +
      "(result, error, permission request, or ended).",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The message to send to the agent" },
        agent: {
          type: "string",
          description: 'Agent to use: "copilot", "gemini", or custom name (default: "copilot")',
        },
        sessionId: { type: "string", description: "Existing session ID to continue (omit for new session)" },
        cwd: { type: "string", description: "Working directory for the agent process" },
        model: { type: "string", description: "Model override (informational)" },
        customCommand: {
          type: "array",
          items: { type: "string" },
          description: "Custom command to spawn instead of using the agent registry",
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
        worktree: { type: "string", description: "Git worktree name for isolation" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        wait: { type: "boolean", description: "Block until result (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "acp_session_list",
    description: "List all active ACP agent sessions with their status, model, and token usage.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "acp_session_status",
    description: "Get detailed status for a specific ACP agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "acp_interrupt",
    description: "Interrupt the current prompt of an ACP agent session (sends session/cancel).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to interrupt" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "acp_bye",
    description: "Terminate an ACP agent session: kill the process and clean up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to end" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "acp_transcript",
    description: "Get transcript entries from an ACP agent session.",
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
    name: "acp_wait",
    description:
      "Block until an ACP agent session event occurs (result, error, permission request, or ended). " +
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
    name: "acp_approve",
    description: "Approve a pending permission request for an ACP agent session.",
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
    name: "acp_deny",
    description: "Deny a pending permission request for an ACP agent session.",
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
