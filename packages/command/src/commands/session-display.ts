/**
 * Shared session-display helpers used by both `claude.ts` and `codex.ts`.
 */

import { c } from "../output";

/** Compact one-line format: SESSION STATE MODEL COST TOKENS TURNS */
export function formatSessionShort(s: {
  sessionId: string;
  state: string;
  model?: string | null;
  cost?: number | null;
  tokens?: number;
  numTurns?: number;
}): string {
  const id = s.sessionId.slice(0, 8);
  const state = s.state;
  const model = s.model ?? "—";
  const cost = s.cost && s.cost > 0 ? `$${s.cost.toFixed(4)}` : "—";
  const tokens = s.tokens && s.tokens > 0 ? String(s.tokens) : "—";
  const turns = s.numTurns !== undefined ? String(s.numTurns) : "—";
  return `${id} ${state} ${model} ${cost} ${tokens} ${turns}`;
}

/** Extract a readable summary from a Claude API content field (string or content block array). */
export function extractContentSummary(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push(`[tool_use: ${b.name}]`);
      } else if (b.type === "tool_result") {
        const rc = b.content;
        if (typeof rc === "string") {
          parts.push(rc);
        } else {
          parts.push("[tool_result]");
        }
      }
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function colorState(state: string): string {
  const padded = state.padEnd(12);
  switch (state) {
    case "active":
      return `${c.green}${padded}${c.reset}`;
    case "connecting":
    case "init":
      return `${c.yellow}${padded}${c.reset}`;
    case "waiting_permission":
    case "disconnected":
      return `${c.red}${padded}${c.reset}`;
    case "ended":
      return `${c.dim}${padded}${c.reset}`;
    default:
      return padded;
  }
}
