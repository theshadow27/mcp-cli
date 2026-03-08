/**
 * Shared tool definitions for the _claude virtual MCP server.
 *
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

export const CLAUDE_TOOLS = [
  {
    name: "claude_prompt",
    description:
      "Start a new Claude Code session with a prompt, or send a follow-up prompt to an existing session. " +
      "Returns the session ID immediately by default. Set wait=true to block until Claude produces a result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The message to send to Claude Code" },
        sessionId: { type: "string", description: "Existing session ID to continue (omit for new session)" },
        cwd: { type: "string", description: "Working directory for the Claude process" },
        permissionMode: {
          type: "string",
          enum: ["auto", "rules"],
          description: "Permission handling strategy (default: auto)",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-approve (e.g. 'Read', 'Bash(git *)')",
        },
        worktree: { type: "string", description: "Git worktree name for isolation" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        wait: { type: "boolean", description: "Block until result (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "claude_session_list",
    description: "List all active Claude Code sessions with their status, model, cost, and token usage.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "claude_session_status",
    description: "Get detailed status for a specific Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "claude_interrupt",
    description: "Interrupt the current turn of a Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to interrupt" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "claude_bye",
    description: "Gracefully end a Claude Code session: close the WebSocket, stop the process, clean up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to end" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "claude_transcript",
    description: "Get recent transcript entries from a Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to query" },
        limit: { type: "number", description: "Max entries to return (default: 50)" },
      },
      required: ["sessionId"],
    },
  },
] as const;
