/**
 * Tool definitions for the _acp virtual MCP server.
 *
 * Built from the shared agent tool builder with ACP-specific overrides.
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { buildAgentTools } from "@mcp-cli/core";

export const ACP_TOOLS = buildAgentTools({
  prefix: "acp",
  label: "ACP agent",
  overrides: {
    prompt: {
      description:
        "Start a new ACP agent session with a prompt, or send a follow-up prompt to an existing session. " +
        "Supports any ACP-compatible agent (Copilot, Gemini, etc.) via the 'agent' parameter. " +
        "Returns the session ID immediately by default. Set wait=true to block until the next actionable event " +
        "(result, error, permission request, or ended).",
      extraProperties: {
        agent: {
          type: "string",
          description: 'Agent to use: "copilot", "gemini", or custom name (default: "copilot")',
        },
        customCommand: {
          type: "array",
          items: { type: "string" },
          description: "Custom command to spawn instead of using the agent registry",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool patterns to auto-deny",
        },
      },
    },
    session_list: {
      description: "List all active ACP agent sessions with their status, model, and token usage.",
    },
    session_status: {
      description: "Get detailed status for a specific ACP agent session.",
    },
    interrupt: {
      description: "Interrupt the current prompt of an ACP agent session (sends session/cancel).",
    },
    bye: {
      description: "Terminate an ACP agent session: kill the process and clean up.",
    },
    transcript: {
      description: "Get transcript entries from an ACP agent session.",
    },
    wait: {
      description:
        "Block until an ACP agent session event occurs (result, error, permission request, or ended). " +
        "If sessionId is provided, waits for that session only. Otherwise waits for any session.",
    },
    approve: {
      description: "Approve a pending permission request for an ACP agent session.",
    },
    deny: {
      description: "Deny a pending permission request for an ACP agent session.",
    },
  },
});
