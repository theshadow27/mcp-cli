/**
 * Shared session-display helpers used by `claude.ts`, `codex.ts`, `opencode.ts`, and `acp.ts`.
 */

import { dirname, resolve } from "node:path";
import { c } from "../output";

/** Transcript entry shape shared across providers. */
export interface TranscriptEntry {
  timestamp: number;
  direction: string;
  message: { type: string; [k: string]: unknown };
}

/**
 * Format a short date label like "(Mar 19)" for sessions older than 24 hours.
 * Returns empty string for recent sessions or if createdAt is unavailable.
 */
export function formatAge(createdAt: number | null | undefined, now?: number): string {
  if (createdAt == null) return "";
  const elapsed = (now ?? Date.now()) - createdAt;
  if (elapsed < 24 * 60 * 60 * 1000) return "";
  const date = new Date(createdAt);
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = date.getUTCDate();
  return `(${month} ${day})`;
}

/** Compact one-line format: SESSION STATE MODEL COST TOKENS TURNS [(date)] */
export function formatSessionShort(s: {
  sessionId: string;
  state: string;
  model?: string | null;
  cost?: number | null;
  tokens?: number;
  numTurns?: number;
  createdAt?: number | null;
}): string {
  const id = s.sessionId.slice(0, 8);
  const state = s.state;
  const model = s.model ?? "—";
  const cost = s.cost && s.cost > 0 ? `$${s.cost.toFixed(4)}` : "—";
  const tokens = s.tokens && s.tokens > 0 ? String(s.tokens) : "—";
  const turns = s.numTurns !== undefined ? String(s.numTurns) : "—";
  const age = formatAge(s.createdAt);
  return age
    ? `${id} ${state} ${model} ${cost} ${tokens} ${turns} ${age}`
    : `${id} ${state} ${model} ${cost} ${tokens} ${turns}`;
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

/**
 * Estimate cost from token count when the provider doesn't report cost.
 * Uses a rough blended rate of $5/M tokens (input-weighted average across common models).
 * Returns null if tokens are unavailable.
 */
export function estimateCost(tokens: number | undefined | null): number | null {
  if (!tokens || tokens <= 0) return null;
  return tokens * 5e-6; // $5 per million tokens
}

/**
 * Format cost for display, using estimate if real cost is unavailable.
 * Returns a formatted string like "$0.1234" or "~$0.0050" (estimated) or "—".
 */
export function formatCost(cost: number | null | undefined, tokens: number | undefined | null): string {
  if (cost != null && cost > 0) return `$${cost.toFixed(4)}`;
  const est = estimateCost(tokens);
  if (est !== null) return `~$${est.toFixed(4)}`;
  return "—";
}

/**
 * Compact a transcript by truncating tool results and collapsing verbose entries.
 * This is a client-side shim for providers that don't support compact natively.
 */
export function compactTranscript(entries: TranscriptEntry[], maxResultLen = 100): TranscriptEntry[] {
  return entries.map((entry) => {
    const msg = entry.message;
    if (msg.type === "result" && typeof (msg as Record<string, unknown>).result === "string") {
      const result = (msg as Record<string, unknown>).result as string;
      if (result.length > maxResultLen) {
        return {
          ...entry,
          message: { ...msg, result: `${result.slice(0, maxResultLen)}…` },
        };
      }
    }
    // Truncate tool_use input in assistant messages
    if ((msg.type === "assistant" || msg.type === "user") && msg.message) {
      const inner = msg.message as { content?: unknown };
      if (Array.isArray(inner.content)) {
        const compacted = inner.content.map((block: unknown) => {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (
              b.type === "tool_result" &&
              typeof b.content === "string" &&
              (b.content as string).length > maxResultLen
            ) {
              return { ...b, content: `${(b.content as string).slice(0, maxResultLen)}…` };
            }
          }
          return block;
        });
        return {
          ...entry,
          message: { ...msg, message: { ...inner, content: compacted } },
        };
      }
    }
    return entry;
  });
}

/**
 * Get the git repo root for the current working directory.
 * Uses --git-common-dir to resolve to the main repo root, not a worktree.
 */
export function getGitRepoRoot(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (result.exitCode !== 0) return null;
    const commonDir = result.stdout.toString().trim();
    if (!commonDir) return null;
    const resolved = resolve(commonDir);
    return resolved.endsWith(".git") ? dirname(resolved) : resolved;
  } catch {
    return null;
  }
}

/**
 * Filter sessions to only those whose cwd is under the current repo root.
 * This is the client-side shim for repo-scoped filtering.
 */
export function filterByRepo<T extends { cwd?: string | null }>(sessions: T[], repoRoot: string): T[] {
  return sessions.filter((s) => s.cwd?.startsWith(repoRoot));
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
