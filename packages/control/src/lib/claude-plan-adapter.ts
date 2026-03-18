/**
 * Re-export plan adapter from core — extraction logic lives in @mcp-cli/core
 * so it can be used by both the daemon (claude_plans tool) and the TUI.
 */
export {
  extractPlansFromTranscript,
  extractTodosFromTranscript,
  looksLikePlan,
  parseClaudePlanMarkdown,
  todosToPlan,
} from "@mcp-cli/core";
export type { TranscriptEntry } from "@mcp-cli/core";
