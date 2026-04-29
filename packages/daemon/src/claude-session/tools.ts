/**
 * Tool definitions for the _claude virtual MCP server.
 *
 * Built from the shared agent tool builder with Claude-specific overrides.
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { buildAgentTools } from "@mcp-cli/core";
import { DEFAULT_SAFE_TOOLS } from "./permission-router";

export const CLAUDE_TOOLS = buildAgentTools({
  prefix: "claude",
  label: "Claude Code",
  overrides: {
    prompt: {
      description:
        "Start a new Claude Code session with a prompt, or send a follow-up prompt to an existing session. " +
        "Returns the session ID immediately by default. Set wait=true to block until Claude produces a result.",
      extraProperties: {
        permissionMode: {
          type: "string",
          enum: ["auto", "rules"],
          description: `Permission handling strategy (default: "rules" with safe tools: ${DEFAULT_SAFE_TOOLS.join(", ")})`,
        },
        repoRoot: {
          type: "string",
          description: "Original repo root (for worktree hook config lookup at teardown)",
        },
        resumeSessionId: {
          type: "string",
          description:
            "Claude CLI session ID to resume (restores conversation history). " +
            'Pass a UUID to resume that specific session (--resume <id>), or "continue" ' +
            "to resume the most recent conversation in the cwd (--continue).",
        },
        ifIdle: {
          type: "boolean",
          description:
            "When true, reject the prompt with isError if the target session is busy " +
            "(active turn, connecting, awaiting permission). Only applies to follow-up prompts (sessionId required).",
        },
      },
    },
    session_list: {
      description: "List all active Claude Code sessions with their status, model, cost, and token usage.",
      extraProperties: {
        repoRoot: {
          type: "string",
          description:
            "Filter sessions to those belonging to this repo root (sessions with null repoRoot pass through)",
        },
        scopeRoot: {
          type: "string",
          description: "Filter sessions to those whose cwd is under this scope root directory (prefix match on cwd)",
        },
      },
    },
    session_status: {
      description: "Get detailed status for a specific Claude Code session.",
    },
    interrupt: {
      description: "Interrupt the current turn of a Claude Code session.",
    },
    bye: {
      description: "Gracefully end a Claude Code session: close the WebSocket, stop the process, clean up.",
    },
    transcript: {
      description: "Get recent transcript entries from a Claude Code session.",
      extraProperties: {
        compact: {
          type: "boolean",
          description:
            "When true, return only timestamp, role, content summary (≤200 chars), " +
            "and tool name — much smaller for monitoring. Default: false.",
        },
      },
    },
    wait: {
      description:
        "Block until a session event occurs (result, error, or permission request). " +
        "If sessionId is provided, waits for that session only. Otherwise waits for any session. " +
        "Use afterSeq for race-free cursor-based polling: returns immediately if events exist past the cursor.",
      extraProperties: {
        afterSeq: {
          type: "number",
          description: "Sequence cursor: return events after this seq number (enables race-free long-poll)",
        },
        repoRoot: {
          type: "string",
          description:
            "Filter results to sessions belonging to this repo root (sessions with null repoRoot pass through)",
        },
        scopeRoot: {
          type: "string",
          description: "Filter results to sessions whose cwd is under this scope root directory (prefix match on cwd)",
        },
      },
    },
    approve: {
      description: "Approve a pending permission request for a Claude Code session.",
    },
    deny: {
      description: "Deny a pending permission request for a Claude Code session.",
      extraProperties: {
        message: {
          type: "string",
          description: "Denial reason (default: 'Denied by user via mcpctl')",
        },
      },
    },
  },
  extraTools: [
    {
      basename: "plans",
      description:
        "Extract plans from all active Claude Code sessions. " +
        "Returns Plan[] directly — no raw transcript data crosses the socket. " +
        "Replaces the N+1 pattern of claude_session_list + N × claude_transcript.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
});
