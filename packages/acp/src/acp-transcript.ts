/**
 * Maps ACP session/update events to transcript entries.
 *
 * Accumulates streaming chunks into coherent transcript entries.
 */

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
  /** In-flight tool calls awaiting results (toolCallId → entry). */
  pendingToolCalls: Map<string, { name: string; input?: unknown }>;
}

export function createTranscriptState(): TranscriptState {
  return {
    pendingToolCalls: new Map(),
  };
}

/**
 * Process a session/update and return any completed transcript entries.
 */
export function processUpdate(
  update: Record<string, unknown>,
  state: TranscriptState,
  timestamp?: number,
): TranscriptEntry[] {
  const ts = timestamp ?? Date.now();
  const sessionUpdate = update.sessionUpdate as string | undefined;
  if (!sessionUpdate) return [];

  switch (sessionUpdate) {
    case "tool_call": {
      const toolCall = (update as { toolCall?: { id?: string; name?: string; input?: unknown } }).toolCall;
      if (toolCall?.id && toolCall.name) {
        state.pendingToolCalls.set(toolCall.id, { name: toolCall.name, input: toolCall.input });
        return [
          {
            role: "tool_use",
            tool: toolCall.name,
            content: toolCall.name,
            input:
              typeof toolCall.input === "object" && toolCall.input !== null
                ? (toolCall.input as Record<string, unknown>)
                : undefined,
            timestamp: ts,
          },
        ];
      }
      return [];
    }

    case "tool_result": {
      const toolResult = (update as { toolResult?: { id?: string; output?: string; isError?: boolean } }).toolResult;
      if (toolResult?.id) {
        const pending = state.pendingToolCalls.get(toolResult.id);
        state.pendingToolCalls.delete(toolResult.id);
        return [
          {
            role: "tool_result",
            tool: pending?.name,
            content: toolResult.output ?? "",
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

/**
 * Create a transcript entry from a completed assistant message.
 */
export function assistantEntry(text: string, timestamp?: number): TranscriptEntry {
  return { role: "assistant", content: text, timestamp: timestamp ?? Date.now() };
}

/**
 * Create a transcript entry from a user prompt.
 */
export function userEntry(text: string, timestamp?: number): TranscriptEntry {
  return { role: "user", content: text, timestamp: timestamp ?? Date.now() };
}
