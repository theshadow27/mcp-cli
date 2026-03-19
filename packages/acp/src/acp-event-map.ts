/**
 * Maps ACP session/update notifications to AgentSessionEvent.
 *
 * ACP is cleaner than Codex — the discriminant is `update.sessionUpdate`
 * inside the `session/update` notification params.
 */

import type { AgentResult, AgentSessionEvent } from "@mcp-cli/core";
import type { SessionUpdateParams } from "./schemas";

/** Accumulated state needed across events within a session. */
export interface AcpEventMapState {
  /** Cumulative token counts. */
  totalTokens: number;
  /** Reasoning tokens. */
  reasoningTokens: number;
  /** Turn count. */
  numTurns: number;
  /** Accumulated response text for the current turn. */
  currentResponseText: string;
  /** Accumulated cost (if agent reports it). */
  cost: number | null;
}

export function createAcpEventMapState(): AcpEventMapState {
  return {
    totalTokens: 0,
    reasoningTokens: 0,
    numTurns: 0,
    currentResponseText: "",
    cost: null,
  };
}

/**
 * Map a session/update notification to zero or more AgentSessionEvents.
 *
 * The update type is discriminated by `params.update.sessionUpdate`.
 * We use a plain Record<string, unknown> approach because the JSON comes
 * untyped from the wire — explicit field access is safer than relying
 * on discriminated union narrowing.
 */
export function mapSessionUpdate(params: Record<string, unknown>, state: AcpEventMapState): AgentSessionEvent[] {
  const update = (params as { update?: Record<string, unknown> }).update;
  if (!update) return [];
  const sessionUpdate = update.sessionUpdate as string | undefined;
  if (!sessionUpdate) return [];

  switch (sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        state.currentResponseText += content.text;
        return [{ type: "session:response", text: content.text }];
      }
      return [];
    }

    case "tool_call":
    case "tool_result":
      // Tool calls/results are tracked for transcript but don't produce
      // top-level AgentSessionEvents (same as Codex — only response text streams).
      return [];

    case "session_info_update": {
      const usage = update.usage as
        | { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
        | undefined;
      if (usage) {
        state.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        state.reasoningTokens = usage.reasoningTokens ?? 0;
      }
      if (typeof update.cost === "number") {
        state.cost = update.cost;
      }
      return [];
    }

    case "plan_update":
    case "config_option_update":
    case "current_mode_update":
      // Ignored — debug/config info
      return [];

    default:
      // Unknown update type — ignore
      return [];
  }
}

/**
 * Build an AgentResult from the accumulated state when a prompt completes.
 * Resets the current response text for the next turn.
 */
export function buildTurnResult(state: AcpEventMapState): AgentResult {
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
