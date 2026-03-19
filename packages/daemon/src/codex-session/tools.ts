/**
 * Tool definitions for the _codex virtual MCP server.
 *
 * Built from the shared agent tool builder with Codex-specific overrides.
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { buildAgentTools } from "@mcp-cli/core";

export const CODEX_TOOLS = buildAgentTools({
  prefix: "codex",
  label: "Codex",
  overrides: {
    prompt: {
      description:
        "Start a new Codex session with a prompt, or send a follow-up prompt to an existing session. " +
        "Returns the session ID immediately by default. Set wait=true to block until the next actionable event " +
        "(result, error, permission request, or ended). With on-request approval, a permission_request event " +
        "is returned so the caller can approve/deny before continuing.",
      extraProperties: {
        approvalPolicy: {
          type: "string",
          enum: ["auto_approve", "on-request", "unless-allow-listed"],
          description: 'Approval handling strategy (default: "on-request")',
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
      },
    },
    session_list: {
      description: "List all active Codex sessions with their status, model, and token usage.",
    },
    session_status: {
      description: "Get detailed status for a specific Codex session.",
    },
    interrupt: {
      description: "Interrupt the current turn of a Codex session.",
    },
    bye: {
      description: "Terminate a Codex session: kill the process and clean up.",
    },
    transcript: {
      description: "Get transcript entries from a Codex session.",
    },
    wait: {
      description:
        "Block until a Codex session event occurs (result, error, permission request, or ended). " +
        "If sessionId is provided, waits for that session only. Otherwise waits for any session.",
    },
    approve: {
      description: "Approve a pending permission request for a Codex session.",
    },
    deny: {
      description: "Deny a pending permission request for a Codex session.",
    },
  },
});
