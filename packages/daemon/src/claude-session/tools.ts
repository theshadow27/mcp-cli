/**
 * Shared tool definitions for the _claude virtual MCP server.
 *
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { DEFAULT_SAFE_TOOLS } from "./permission-router";

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
        sessionId: {
          type: "string",
          description: "Existing session ID to continue, supports prefix matching (omit for new session)",
        },
        cwd: { type: "string", description: "Working directory for the Claude process" },
        permissionMode: {
          type: "string",
          enum: ["auto", "rules"],
          description: `Permission handling strategy (default: "rules" with safe tools: ${DEFAULT_SAFE_TOOLS.join(", ")})`,
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-approve (e.g. 'Read', 'Bash(git *)')",
        },
        worktree: { type: "string", description: "Git worktree name for isolation" },
        repoRoot: { type: "string", description: "Original repo root (for worktree hook config lookup at teardown)" },
        model: {
          type: "string",
          description: "Model to use: shortname (opus, sonnet, haiku) or full ID (e.g. claude-opus-4-6)",
        },
        resumeSessionId: {
          type: "string",
          description:
            "Claude CLI session ID to resume (restores conversation history). " +
            'Pass a UUID to resume that specific session (--resume <id>), or "continue" ' +
            "to resume the most recent conversation in the cwd (--continue).",
        },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        wait: { type: "boolean", description: "Block until result (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "claude_session_list",
    description: "List all active Claude Code sessions with their status, model, cost, and token usage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repoRoot: {
          type: "string",
          description:
            "Filter sessions to those belonging to this repo root (sessions with null repoRoot pass through)",
        },
      },
    },
  },
  {
    name: "claude_session_status",
    description: "Get detailed status for a specific Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID or unique prefix to query" },
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
        sessionId: { type: "string", description: "Session ID or unique prefix to interrupt" },
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
        sessionId: { type: "string", description: "Session ID or unique prefix to end" },
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
        sessionId: { type: "string", description: "Session ID or unique prefix to query" },
        limit: { type: "number", description: "Max entries to return (default: 50)" },
        compact: {
          type: "boolean",
          description:
            "When true, return only timestamp, role, content summary (≤200 chars), " +
            "and tool name — much smaller for monitoring. Default: false.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "claude_wait",
    description:
      "Block until a session event occurs (result, error, or permission request). " +
      "If sessionId is provided, waits for that session only. Otherwise waits for any session. " +
      "Use afterSeq for race-free cursor-based polling: returns immediately if events exist past the cursor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID or unique prefix to wait on (omit for any session)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000)" },
        afterSeq: {
          type: "number",
          description: "Sequence cursor: return events after this seq number (enables race-free long-poll)",
        },
        repoRoot: {
          type: "string",
          description:
            "Filter results to sessions belonging to this repo root (sessions with null repoRoot pass through)",
        },
      },
    },
  },
  {
    name: "claude_approve",
    description: "Approve a pending permission request for a Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID or unique prefix containing the permission request" },
        requestId: { type: "string", description: "Permission request ID to approve" },
      },
      required: ["sessionId", "requestId"],
    },
  },
  {
    name: "claude_deny",
    description: "Deny a pending permission request for a Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID or unique prefix containing the permission request" },
        requestId: { type: "string", description: "Permission request ID to deny" },
        message: { type: "string", description: "Denial reason (default: 'Denied by user via mcpctl')" },
      },
      required: ["sessionId", "requestId"],
    },
  },
] as const;
