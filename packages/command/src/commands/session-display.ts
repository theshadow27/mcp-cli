/**
 * Shared session-display helpers used by `claude.ts` and `agent.ts`.
 */

import { dirname, resolve } from "node:path";
import type { WorkItem } from "@mcp-cli/core";
import { c } from "../output";

// ── Transcript walker ──

export interface DirectoryEntry {
  dir: string;
  reads: number;
  writes: number;
}

export interface CommandEntry {
  cmd: string;
  count: number;
  lastOutput: string | null;
}

export interface QueryEntry {
  tool: string;
  pattern: string;
  path?: string;
}

export interface TranscriptStats {
  lastPrompt: string | null;
  lastResult: string | null;
  directoryFootprint: DirectoryEntry[];
  commandSummary: CommandEntry[];
  lastQueries: QueryEntry[];
}

/**
 * Walk transcript entries and extract derived metrics:
 * - last user prompt text
 * - last assistant/result text
 * - directory footprint (Read/Edit/Write tool calls aggregated by dirname)
 * - command summary (Bash tool calls aggregated by first token)
 * - last N Grep/Glob queries
 */
export function walkTranscript(entries: TranscriptEntry[], lastQueryCount = 3): TranscriptStats {
  let lastPrompt: string | null = null;
  let lastResult: string | null = null;
  const dirReads = new Map<string, number>();
  const dirWrites = new Map<string, number>();
  const cmdMap = new Map<string, { count: number; lastOutput: string | null }>();
  // Maps tool_use_id → cmdMap key so tool_results can be attributed to the right command
  const bashToolUseIds = new Map<string, string>();
  const queries: QueryEntry[] = [];

  for (const entry of entries) {
    const type = entry.message.type;

    // Last user prompt: outbound user message with text content (not tool results)
    if (entry.direction === "outbound" && type === "user" && entry.message.message) {
      const msg = entry.message.message as { content?: unknown };
      const text = extractTextOnly(msg.content);
      if (text) lastPrompt = text;
    }

    // Last result: inbound assistant message with text, or result message
    if (entry.direction === "inbound") {
      if (type === "assistant" && entry.message.message) {
        const msg = entry.message.message as { content?: unknown };
        const text = extractTextOnly(msg.content);
        if (text) lastResult = text;
      } else if (type === "result") {
        const res = entry.message as { result?: string };
        if (res.result) lastResult = res.result;
      }
    }

    // Tool use: only in assistant messages
    if (type === "assistant" && entry.message.message) {
      const msg = entry.message.message as { content?: unknown };
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type !== "tool_use" || typeof b.name !== "string") continue;
          const input = (b.input ?? {}) as Record<string, unknown>;

          const name = b.name;

          if (name === "Read" && typeof input.file_path === "string") {
            const d = dirname(input.file_path);
            dirReads.set(d, (dirReads.get(d) ?? 0) + 1);
          } else if (
            (name === "Edit" || name === "Write" || name === "MultiEdit") &&
            typeof input.file_path === "string"
          ) {
            const d = dirname(input.file_path);
            dirWrites.set(d, (dirWrites.get(d) ?? 0) + 1);
          } else if (name === "Bash" && typeof input.command === "string") {
            const firstToken = input.command.trim().split(/\s+/)[0] || "bash";
            const existing = cmdMap.get(firstToken);
            cmdMap.set(firstToken, { count: (existing?.count ?? 0) + 1, lastOutput: existing?.lastOutput ?? null });
            if (typeof b.id === "string") bashToolUseIds.set(b.id, firstToken);
          } else if ((name === "Grep" || name === "Glob") && typeof input.pattern === "string") {
            const q: QueryEntry = { tool: name, pattern: input.pattern };
            if (typeof input.path === "string") q.path = input.path;
            queries.push(q);
          }
        }
      }
    }

    // Capture Bash tool results: match by tool_use_id to attribute to the right command
    if (entry.direction === "outbound" && type === "user" && entry.message.message) {
      const msg = entry.message.message as { content?: unknown };
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const cmdKey = bashToolUseIds.get(b.tool_use_id);
          if (cmdKey && typeof b.content === "string") {
            const existing = cmdMap.get(cmdKey);
            if (existing) cmdMap.set(cmdKey, { ...existing, lastOutput: b.content.trim().slice(0, 200) });
          }
        }
      }
    }
  }

  // Build directory footprint: merge reads + writes, sort by total activity desc
  const allDirs = new Set([...dirReads.keys(), ...dirWrites.keys()]);
  const footprint: DirectoryEntry[] = [];
  for (const dir of allDirs) {
    footprint.push({ dir, reads: dirReads.get(dir) ?? 0, writes: dirWrites.get(dir) ?? 0 });
  }
  footprint.sort((a, b) => b.reads + b.writes - (a.reads + a.writes));

  // Command summary sorted by count desc
  const commandSummary: CommandEntry[] = [];
  for (const [cmd, { count, lastOutput }] of cmdMap) {
    commandSummary.push({ cmd, count, lastOutput });
  }
  commandSummary.sort((a, b) => b.count - a.count);

  return {
    lastPrompt,
    lastResult,
    directoryFootprint: footprint,
    commandSummary,
    lastQueries: lastQueryCount === 0 ? [] : queries.slice(-lastQueryCount),
  };
}

/** Extract only text blocks from content (skipping tool_use / tool_result). */
function extractTextOnly(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
      // skip tool_use / tool_result
    }
  }
  const joined = parts.join(" ").trim();
  return joined || null;
}

/** Format elapsed milliseconds as "H:MM:SS" or "M:SS". */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a session status stanza for human display.
 * Returns lines to be printed (caller does d.log on each).
 */
export function formatStatusStanza(
  session: Record<string, unknown>,
  stats: TranscriptStats,
  lastEntryTs: number | null,
  now = Date.now(),
): string[] {
  const lines: string[] = [];

  // Header: Alice (dca8b240) — idle 04:23 — $13.83 / 182 turns
  const id = String(session.sessionId ?? "").slice(0, 8);
  const name = typeof session.name === "string" && session.name ? session.name : null;
  const sessionLabel = name ? `${c.bold}${name}${c.reset} (${c.cyan}${id}${c.reset})` : `${c.cyan}${id}${c.reset}`;
  const state = String(session.state ?? "unknown");
  const idleStr = lastEntryTs != null ? ` ${formatElapsed(now - lastEntryTs)}` : "";
  const stateStr = `${colorState(state)}${idleStr}`;
  const costStr = typeof session.cost === "number" && session.cost > 0 ? `$${session.cost.toFixed(2)}` : null;
  const turns = typeof session.numTurns === "number" ? session.numTurns : null;
  const metricParts: string[] = [];
  if (costStr) metricParts.push(costStr);
  if (turns != null) metricParts.push(`${turns} turns`);
  const metrics = metricParts.length > 0 ? ` — ${metricParts.join(" / ")}` : "";
  lines.push(`${sessionLabel} — ${stateStr}${metrics}`);

  // Last prompt / result
  if (stats.lastPrompt) {
    const p = stats.lastPrompt.length > 120 ? `${stats.lastPrompt.slice(0, 120)}…` : stats.lastPrompt;
    lines.push(`Last prompt: ${c.dim}"${p}"${c.reset}`);
  }
  if (stats.lastResult) {
    const r = stats.lastResult.length > 120 ? `${stats.lastResult.slice(0, 120)}…` : stats.lastResult;
    lines.push(`Last result:  ${c.dim}"${r}"${c.reset}`);
  }

  // Directory footprint
  if (stats.directoryFootprint.length > 0) {
    lines.push("");
    lines.push("Directory footprint (read / write):");
    const maxDir = Math.min(stats.directoryFootprint.length, 6);
    const dirColWidth = Math.max(...stats.directoryFootprint.slice(0, maxDir).map((e) => e.dir.length), 10) + 2;
    for (let i = 0; i < maxDir; i++) {
      const { dir, reads, writes } = stats.directoryFootprint[i];
      const r = reads > 0 ? `read ${reads}` : "";
      const w = writes > 0 ? `wrote ${writes}` : "";
      const rw = [r, w].filter(Boolean).join("  ");
      lines.push(`  ${dir.padEnd(dirColWidth)} ${rw}`);
    }
  }

  // Command summary
  if (stats.commandSummary.length > 0) {
    lines.push("");
    lines.push("Command summary:");
    for (const { cmd, count, lastOutput } of stats.commandSummary) {
      const last = lastOutput ? `  (last: ${lastOutput.length > 60 ? `${lastOutput.slice(0, 60)}…` : lastOutput})` : "";
      lines.push(`  ${cmd.padEnd(20)} ${count} ${count === 1 ? "run" : "runs"}${last}`);
    }
  }

  // Last queries
  if (stats.lastQueries.length > 0) {
    lines.push("");
    lines.push(`Last ${stats.lastQueries.length} quer${stats.lastQueries.length === 1 ? "y" : "ies"}:`);
    for (const { tool, pattern, path } of stats.lastQueries) {
      const pathSuffix = path ? ` ${path}` : "";
      lines.push(`  ${tool.toLowerCase()} ${c.dim}"${pattern}"${pathSuffix}${c.reset}`);
    }
  }

  return lines;
}

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
  name?: string | null;
  state: string;
  model?: string | null;
  cost?: number | null;
  tokens?: number;
  numTurns?: number;
  rateLimited?: boolean;
  createdAt?: number | null;
}): string {
  const id = s.sessionId.slice(0, 8);
  const nameLabel = s.name ? `/${s.name}` : "";
  const state = s.rateLimited ? `${s.state} [RATE LIMITED]` : s.state;
  const model = s.model ?? "—";
  const cost = s.cost && s.cost > 0 ? `$${s.cost.toFixed(4)}` : "—";
  const tokens = s.tokens && s.tokens > 0 ? String(s.tokens) : "—";
  const turns = s.numTurns !== undefined ? String(s.numTurns) : "—";
  const age = formatAge(s.createdAt);
  return age
    ? `${id}${nameLabel} ${state} ${model} ${cost} ${tokens} ${turns} ${age}`
    : `${id}${nameLabel} ${state} ${model} ${cost} ${tokens} ${turns}`;
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

/**
 * Format a work item lifecycle pipeline for display as a second line under a session.
 *
 * Examples:
 *   impl → PR #1135 open → CI ✓ → QA pending
 *   impl → PR #1134 merged ✓
 *   impl (no PR yet)
 */
export function formatLifecycleLine(wi: WorkItem): string {
  const parts: string[] = [wi.phase];

  if (wi.prNumber != null) {
    const prLabel = `PR #${wi.prNumber}`;
    if (wi.prState === "merged") {
      parts.push(`${prLabel} merged ${c.green}✓${c.reset}`);
    } else if (wi.prState === "closed") {
      parts.push(`${prLabel} ${c.red}closed${c.reset}`);
    } else {
      // open or draft
      parts.push(`${prLabel} ${wi.prState ?? "open"}`);

      // CI status (only relevant for open PRs)
      switch (wi.ciStatus) {
        case "passed":
          parts.push(`CI ${c.green}✓${c.reset}`);
          break;
        case "failed":
          parts.push(`CI ${c.red}✗${c.reset}`);
          break;
        case "running":
        case "pending":
          parts.push(`CI ${c.yellow}${wi.ciStatus}${c.reset}`);
          break;
        // "none" → omit
      }

      // Review status (only relevant for open PRs)
      switch (wi.reviewStatus) {
        case "approved":
          parts.push(`review ${c.green}✓${c.reset}`);
          break;
        case "changes_requested":
          parts.push(`review ${c.red}changes requested${c.reset}`);
          break;
        case "pending":
          parts.push(`review ${c.yellow}pending${c.reset}`);
          break;
        // "none" → omit
      }
    }
  } else {
    parts.push("(no PR yet)");
  }

  return parts.join(" → ");
}
