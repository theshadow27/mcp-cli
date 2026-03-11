/**
 * Maps Codex item/completed events to transcript entries.
 *
 * Produces a Claude-compatible transcript format for `mcx codex log`.
 */

import type { ThreadItem } from "./schemas";

export interface TranscriptEntry {
  role: "assistant" | "tool_use" | "tool_result" | "user";
  /** Tool name (for tool_use/tool_result entries). */
  tool?: string;
  /** Message content or tool output. */
  content: string;
  /** Tool input (for tool_use entries). */
  input?: Record<string, unknown>;
  /** Command exit code (for Bash tool_result). */
  exitCode?: number;
  /** Diff content (for Write tool_result). */
  diff?: string;
  /** Duration in ms (for tool_result). */
  durationMs?: number;
  /** Timestamp when this entry was recorded. */
  timestamp: number;
}

/**
 * Convert a completed ThreadItem to transcript entries.
 *
 * Some items produce two entries (tool_use + tool_result).
 * Returns an empty array for item types we don't transcribe (e.g. reasoning).
 */
export function itemToTranscript(item: ThreadItem, timestamp?: number): TranscriptEntry[] {
  const ts = timestamp ?? Date.now();

  switch (item.type) {
    case "userMessage":
      return [
        {
          role: "user",
          content: item.text ?? "",
          timestamp: ts,
        },
      ];

    case "agentMessage":
      return [
        {
          role: "assistant",
          content: item.text ?? "",
          timestamp: ts,
        },
      ];

    case "commandExecution":
      return [
        {
          role: "tool_use",
          tool: "Bash",
          content: item.command ?? "",
          input: { command: item.command ?? "" },
          timestamp: ts,
        },
        {
          role: "tool_result",
          tool: "Bash",
          content: item.aggregatedOutput ?? "",
          exitCode: item.exitCode,
          durationMs: item.durationMs,
          timestamp: ts,
        },
      ];

    case "fileChange": {
      const files = item.changes?.map((c) => c.path) ?? [];
      const diffContent = item.changes?.map((c) => c.diff).join("\n") ?? "";
      return [
        {
          role: "tool_use",
          tool: "Write",
          content: files.join(", "),
          input: { files },
          timestamp: ts,
        },
        {
          role: "tool_result",
          tool: "Write",
          content: `Updated ${files.length} file(s)`,
          diff: diffContent,
          timestamp: ts,
        },
      ];
    }

    // Reasoning, reviewMode entries: not transcribed
    default:
      return [];
  }
}
