/**
 * Tool definitions for the _mock virtual MCP server.
 *
 * Built from the shared agent tool builder with Mock-specific overrides.
 * Single source of truth — used by both the worker (MCP Server registration)
 * and the main thread (tool cache for ServerPool).
 */

import { buildAgentTools } from "@mcp-cli/core";

export const MOCK_TOOLS = buildAgentTools({
  prefix: "mock",
  label: "Mock",
  overrides: {
    prompt: {
      description:
        "Start a mock session with a task (JSON script file path), or send a follow-up prompt to an existing session. " +
        "The mock reads a script of emit entries (response, tool_call, permission_request, cost, error, etc.) " +
        "and replays them with configurable delays. See mock-session/CLAUDE.md for the DSL reference. " +
        "Returns the session ID immediately by default. Set wait=true to block until the script completes.",
      omitProperties: ["name"],
    },
    session_list: {
      description: "List all active mock sessions with their status.",
    },
    session_status: {
      description: "Get detailed status for a specific mock session.",
    },
    interrupt: {
      description: "Interrupt a running mock session (skip remaining script entries).",
    },
    bye: {
      description: "Terminate a mock session and clean up.",
      omitProperties: ["message"],
    },
    transcript: {
      description: "Get transcript entries from a mock session.",
    },
    wait: {
      description:
        "Block until a mock session event occurs (result or error). " +
        "If sessionId is provided, waits for that session only. Otherwise waits for any session.",
    },
    approve: {
      description:
        "Approve a pending permission request from a mock session. " +
        'The script must contain a {"emit": "permission_request"} entry followed by {"wait_for": "approve"}.',
    },
    deny: {
      description:
        "Deny a pending permission request from a mock session. " +
        'The script must contain a {"emit": "permission_request"} entry followed by {"wait_for": "deny"}.',
    },
  },
});
