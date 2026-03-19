/**
 * Maps OpenCode SSE events to transcript entries.
 *
 * Accumulates streaming message parts into coherent transcript entries.
 * OpenCode message parts include text, tool calls/results, and step-finish.
 */

import type { OpenCodeSseEvent } from "./opencode-sse";

export interface TranscriptEntry {
  role: "assistant" | "tool_use" | "tool_result" | "user";
  /** Tool name (for tool_use/tool_result entries). */
  tool?: string;
  /** Message content or tool output. */
  content: string;
  /** Tool input (for tool_use entries). */
  input?: Record<string, unknown>;
  /** Timestamp when this entry was recorded. */
  timestamp: number;
}

/** Mutable transcript accumulator state. */
export interface TranscriptState {
  /** In-flight tool calls awaiting results (toolId → entry). */
  pendingToolCalls: Map<string, { name: string; input?: unknown }>;
}

export function createTranscriptState(): TranscriptState {
  return {
    pendingToolCalls: new Map(),
  };
}

/**
 * Process an OpenCode SSE event and return any completed transcript entries.
 */
export function processEvent(event: OpenCodeSseEvent, state: TranscriptState, timestamp?: number): TranscriptEntry[] {
  const ts = timestamp ?? Date.now();

  if (event.type !== "message.part.updated") return [];

  const part = event.data.part as Record<string, unknown> | undefined;
  if (!part) return [];

  const partType = part.type as string | undefined;

  switch (partType) {
    case "tool": {
      const toolState = part.state as string | undefined;
      const toolId = part.id as string | undefined;
      const toolName = part.name as string | undefined;

      if (!toolId || !toolName) return [];

      if (toolState === "running") {
        const input = part.input;
        state.pendingToolCalls.set(toolId, { name: toolName, input });
        return [
          {
            role: "tool_use",
            tool: toolName,
            content: toolName,
            input: typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined,
            timestamp: ts,
          },
        ];
      }

      if (toolState === "completed" || toolState === "error") {
        const pending = state.pendingToolCalls.get(toolId);
        state.pendingToolCalls.delete(toolId);
        const output = part.output as string | undefined;
        return [
          {
            role: "tool_result",
            tool: pending?.name ?? toolName,
            content: output ?? "",
            timestamp: ts,
          },
        ];
      }
      return [];
    }

    default:
      return [];
  }
}

/** Create a transcript entry from a completed assistant message. */
export function assistantEntry(text: string, timestamp?: number): TranscriptEntry {
  return { role: "assistant", content: text, timestamp: timestamp ?? Date.now() };
}

/** Create a transcript entry from a user prompt. */
export function userEntry(text: string, timestamp?: number): TranscriptEntry {
  return { role: "user", content: text, timestamp: timestamp ?? Date.now() };
}
