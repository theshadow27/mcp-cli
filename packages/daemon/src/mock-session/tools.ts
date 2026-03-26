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
        "The mock reads canned responses from the JSON file and emits them with configurable delays. " +
        "Returns the session ID immediately by default. Set wait=true to block until the script completes.",
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
      description: "Approve a pending permission request (mock sessions do not generate permission requests).",
    },
    deny: {
      description: "Deny a pending permission request (mock sessions do not generate permission requests).",
    },
  },
});
