/**
 * Maps OpenCode SSE events to AgentSessionEvent.
 *
 * OpenCode streams events via SSE. The event type discriminates the content:
 *
 * | SSE event type              | Maps to                           |
 * |-----------------------------|-----------------------------------|
 * | session.status (idle)       | session:result or state → idle    |
 * | session.status (busy)       | state → active                    |
 * | session.error               | session:error                     |
 * | message.part.updated (text) | session:response                  |
 * | message.part.updated (tool) | transcript: tool_use/tool_result  |
 * | message.part.updated (step) | token/cost update                 |
 * | permission.asked            | session:permission_request        |
 * | permission.replied          | clear pending permission          |
 */

import type { AgentResult, AgentSessionEvent } from "@mcp-cli/core";
import type { OpenCodeSseEvent } from "./opencode-sse";

/** Accumulated state needed across events within a session. */
export interface OpenCodeEventMapState {
  /** Cumulative token counts. */
  totalTokens: number;
  /** Reasoning tokens. */
  reasoningTokens: number;
  /** Turn count. */
  numTurns: number;
  /** Accumulated response text for the current turn. */
  currentResponseText: string;
  /** Accumulated cost (OpenCode tracks cost natively). */
  cost: number | null;
}

export function createOpenCodeEventMapState(): OpenCodeEventMapState {
  return {
    totalTokens: 0,
    reasoningTokens: 0,
    numTurns: 0,
    currentResponseText: "",
    cost: null,
  };
}

/**
 * Map an OpenCode SSE event to zero or more AgentSessionEvents.
 */
export function mapSseEvent(event: OpenCodeSseEvent, state: OpenCodeEventMapState): AgentSessionEvent[] {
  switch (event.type) {
    case "session.status": {
      const status = event.data.status as string | undefined;
      if (status === "idle") {
        // Turn completed — build result
        return []; // Result is emitted by the session when prompt response arrives
      }
      // "busy" — no event needed (session state managed by session orchestrator)
      return [];
    }

    case "session.error": {
      const message = (event.data.message as string) ?? (event.data.error as string) ?? "Unknown error";
      return [
        {
          type: "session:error",
          errors: [message],
          cost: state.cost,
        },
      ];
    }

    case "message.part.updated": {
      const part = event.data.part as Record<string, unknown> | undefined;
      if (!part) return [];

      const partType = part.type as string | undefined;

      switch (partType) {
        case "text": {
          const text = part.text as string | undefined;
          if (text) {
            state.currentResponseText += text;
            return [{ type: "session:response", text }];
          }
          return [];
        }

        case "tool": {
          // Tool updates tracked for transcript but don't produce top-level events
          return [];
        }

        case "step-finish": {
          // Token and cost update
          const tokens = part.tokens as { input?: number; output?: number; reasoning?: number } | undefined;
          if (tokens) {
            state.totalTokens += (tokens.input ?? 0) + (tokens.output ?? 0);
            state.reasoningTokens += tokens.reasoning ?? 0;
          }
          const cost = part.cost as number | undefined;
          if (typeof cost === "number") {
            state.cost = (state.cost ?? 0) + cost;
          }
          return [];
        }

        default:
          return [];
      }
    }

    case "message.part.delta": {
      // Streaming text accumulator
      const delta = event.data.delta as string | undefined;
      if (delta) {
        state.currentResponseText += delta;
        return [{ type: "session:response", text: delta }];
      }
      return [];
    }

    case "session.diff": {
      // Store diff on session — no AgentSessionEvent needed
      return [];
    }

    case "permission.asked":
    case "permission.replied":
      // Handled separately by the session orchestrator
      return [];

    default:
      return [];
  }
}

/**
 * Build an AgentResult from the accumulated state when a prompt completes.
 * Resets the current response text for the next turn.
 */
export function buildTurnResult(state: OpenCodeEventMapState): AgentResult {
  state.numTurns++;
  const result: AgentResult = {
    result: state.currentResponseText,
    cost: state.cost,
    tokens: state.totalTokens,
    numTurns: state.numTurns,
  };
  state.currentResponseText = "";
  return result;
}
