/**
 * Tool definitions for the _opencode virtual MCP server.
 *
 * Built from the shared agent tool builder with OpenCode-specific overrides.
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { buildAgentTools } from "@mcp-cli/core";

export const OPENCODE_TOOLS = buildAgentTools({
  prefix: "opencode",
  label: "OpenCode",
  overrides: {
    prompt: {
      description:
        "Start a new OpenCode agent session with a prompt, or send a follow-up prompt to an existing session. " +
        "OpenCode is provider-agnostic: it wraps any LLM (Grok, Gemini, Bedrock, open-source) in a coding agent harness. " +
        "Returns the session ID immediately by default. Set wait=true to block until the next actionable event " +
        "(result, error, permission request, or ended).",
      extraProperties: {
        provider: {
          type: "string",
          description: 'LLM provider (e.g. "anthropic", "openai", "google", "xai", "bedrock")',
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-deny",
        },
        repoRoot: {
          type: "string",
          description: "Repository root for worktree cleanup",
        },
      },
    },
    session_status: {
      extraProperties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
    },
    interrupt: {
      description: "Interrupt the current prompt of an OpenCode agent session (sends abort).",
      extraProperties: {
        sessionId: { type: "string", description: "Session ID to interrupt" },
      },
    },
    bye: {
      description: "Terminate an OpenCode agent session: kill the process and clean up.",
      extraProperties: {
        sessionId: { type: "string", description: "Session ID to end" },
      },
    },
    transcript: {
      extraProperties: {
        sessionId: { type: "string", description: "Session ID to query" },
      },
    },
    wait: {
      description:
        "Block until an OpenCode agent session event occurs (result, error, permission request, or ended). " +
        "If sessionId is provided, waits for that session only. Otherwise waits for any session. " +
        "Use afterSeq for race-free cursor-based polling: returns immediately if events exist past the cursor.",
      extraProperties: {
        sessionId: { type: "string", description: "Session ID to wait on (omit for any session)" },
        afterSeq: {
          type: "number",
          description: "Return events after this sequence number. Enables race-free polling.",
        },
      },
    },
    approve: {
      extraProperties: {
        sessionId: { type: "string", description: "Session ID containing the permission request" },
      },
    },
    deny: {
      extraProperties: {
        sessionId: { type: "string", description: "Session ID containing the permission request" },
      },
    },
  },
});
