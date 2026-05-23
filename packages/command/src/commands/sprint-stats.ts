/**
 * mcx sprint-stats — aggregate token counts and costs from Claude session transcripts.
 *
 * Usage:
 *   mcx sprint-stats                       # all sessions in current project
 *   mcx sprint-stats --sprint <N>          # sessions within sprint N's time window
 *   mcx sprint-stats --since <tag-or-sha>  # sessions since a git tag/sha commit time
 *
 * Output: JSON to stdout.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";

// ── Types ──────────────────────────────────────────────────────────────────

interface TokenTotals {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

interface SessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  branch: string | null;
  models: Map<string, TokenTotals>;
}

interface TimeWindow {
  start: number;
  end: number;
  label: string;
}

/** Raw JSONL entry — only fields we care about. */
interface RawEntry {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

// ── Cost model ─────────────────────────────────────────────────────────────

interface CostRates {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

const MODEL_COSTS: Array<{ pattern: RegExp; rates: CostRates }> = [
  {
    pattern: /opus/i,
    rates: { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
  },
  {
    pattern: /sonnet/i,
    rates: { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  },
  {
    pattern: /haiku/i,
    rates: { input: 0.8, output: 4, cacheCreate: 1, cacheRead: 0.08 },
  },
];

const BLENDED_RATES: CostRates = { input: 5, output: 5, cacheCreate: 5, cacheRead: 5 };

function ratesForModel(model: string): CostRates {
  for (const { pattern, rates } of MODEL_COSTS) {
    if (pattern.test(model)) return rates;
  }
  return BLENDED_RATES;
}

function estimateCostForModel(totals: Omit<TokenTotals, "sessions" | "estimatedCostUsd">, model: string): number {
  const rates = ratesForModel(model);
  return (
    (totals.inputTokens * rates.input +
      totals.outputTokens * rates.output +
      totals.cacheCreationTokens * rates.cacheCreate +
      totals.cacheReadTokens * rates.cacheRead) /
    1_000_000
  );
}

// ── Sprint plan parsing ────────────────────────────────────────────────────

const TZ_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7,
};

/** Parse "2026-05-19 23:35 EST" → ms timestamp. Returns null on failure. */
function parseDateLabel(s: string): number | null {
  const m = s.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+([A-Z]{2,4}))?/);
  if (!m) return null;
  const [, date, time, tz] = m;
  const offsetHours = tz && TZ_OFFSETS[tz] !== undefined ? TZ_OFFSETS[tz] : 0;
  const iso = `${date}T${time}:00${offsetHours < 0 ? "-" : "+"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export interface SprintWindow {
  start: number;
  end: number;
}

/** Parse sprint plan file to extract the sprint's time window. */
export function parseSprintPlan(content: string, nowMs: number): SprintWindow | null {
  // Match: > Planned ... Started 2026-05-19 23:35 EST. [Ended 2026-05-20 01:22 EST.]
  const startMatch = content.match(/Started\s+([\d-]+\s+[\d:]+(?:\s+[A-Z]{2,4})?)/);
  const endMatch = content.match(/Ended\s+([\d-]+\s+[\d:]+(?:\s+[A-Z]{2,4})?)/);

  const start = startMatch ? parseDateLabel(startMatch[1]) : null;
  const end = endMatch ? parseDateLabel(endMatch[1]) : nowMs;

  if (start === null) return null;
  return { start, end: end ?? nowMs };
}

// ── Dependency interface ───────────────────────────────────────────────────

export interface SprintStatsDeps {
  listWorkItems: () => Promise<WorkItem[]>;
  homeDir: () => string;
  repoRoot: () => string;
  now: () => number;
  /** Read sprint plan file content, or null if missing. */
  readSprintPlan: (sprintN: number) => string | null;
  /** Get commit timestamp for tag/sha, or null on failure. */
  resolveGitTimestamp: (ref: string) => number | null;
}

const defaultDeps: SprintStatsDeps = {
  async listWorkItems() {
    const result = await ipcCall("listWorkItems", { includeArchived: true });
    return result.items;
  },
  homeDir: homedir,
  repoRoot: () => process.cwd(),
  now: () => Date.now(),
  readSprintPlan(sprintN) {
    const dirs = [process.cwd(), join(process.cwd(), ".claude")];
    for (const dir of dirs) {
      const p = join(dir, "sprints", `sprint-${sprintN}.md`);
      if (existsSync(p)) {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return null;
        }
      }
    }
    // Also look relative to git root
    const sprintsDir = join(process.cwd(), ".claude", "sprints");
    const p = join(sprintsDir, `sprint-${sprintN}.md`);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    }
    return null;
  },
  resolveGitTimestamp(ref) {
    try {
      const result = Bun.spawnSync(["git", "log", "-1", "--format=%cI", ref], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) return null;
      const iso = result.stdout.toString().trim();
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    } catch {
      return null;
    }
  },
};

// ── Session file scanning ──────────────────────────────────────────────────

/** List all .jsonl session files under ~/.claude/projects/. */
export function scanSessionFiles(projectsDir: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = join(projectsDir, entry);
    try {
      const sub = readdirSync(entryPath);
      for (const file of sub) {
        if (file.endsWith(".jsonl")) {
          files.push(join(entryPath, file));
        }
      }
    } catch {
      // Not a directory or unreadable — skip
    }
  }
  return files;
}

/** Parse a .jsonl file into relevant entries. */
export function readSessionEntries(filePath: string): RawEntry[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const entries: RawEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as RawEntry;
      entries.push(obj);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Aggregate token usage from a session's entries. Returns null if no usage data. */
export function aggregateSession(entries: RawEntry[]): SessionSummary | null {
  let sessionId: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let branch: string | null = null;
  const models = new Map<string, TokenTotals>();

  for (const entry of entries) {
    if (!entry.sessionId) continue;
    if (!sessionId) sessionId = entry.sessionId;

    if (entry.timestamp) {
      const ts = new Date(entry.timestamp).getTime();
      if (!Number.isNaN(ts)) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }
    }

    if (entry.gitBranch && !branch) {
      branch = entry.gitBranch;
    }

    if (entry.type === "assistant" && entry.message?.usage) {
      const model = entry.message.model ?? "<unknown>";
      const usage = entry.message.usage;
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;

      let totals = models.get(model);
      if (!totals) {
        totals = {
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
        };
        models.set(model, totals);
      }
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheCreationTokens += cacheCreate;
      totals.cacheReadTokens += cacheRead;
    }
  }

  if (!sessionId || firstTs === null || lastTs === null || models.size === 0) return null;

  // Compute cost per model
  for (const [model, totals] of models) {
    totals.estimatedCostUsd = estimateCostForModel(totals, model);
    totals.sessions = 1;
  }

  return { sessionId, firstTs, lastTs, branch, models };
}

// ── Zero-value helper ──────────────────────────────────────────────────────

function zeroTotals(): TokenTotals {
  return {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
  };
}

function addTotals(acc: TokenTotals, src: TokenTotals): void {
  acc.sessions += src.sessions;
  acc.inputTokens += src.inputTokens;
  acc.outputTokens += src.outputTokens;
  acc.cacheCreationTokens += src.cacheCreationTokens;
  acc.cacheReadTokens += src.cacheReadTokens;
  acc.estimatedCostUsd += src.estimatedCostUsd;
}

// ── Output serialization ───────────────────────────────────────────────────

function totalsToJson(t: TokenTotals): object {
  return {
    sessions: t.sessions,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    cacheReadTokens: t.cacheReadTokens,
    estimatedCostUsd: Math.round(t.estimatedCostUsd * 10000) / 10000,
  };
}

// ── Main command ───────────────────────────────────────────────────────────

export async function cmdSprintStats(args: string[], deps?: Partial<SprintStatsDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const nowMs = d.now();

  // Parse flags
  let window: TimeWindow | null = null;

  const sprintIdx = args.indexOf("--sprint");
  const sinceIdx = args.indexOf("--since");

  if (sprintIdx !== -1) {
    const raw = args[sprintIdx + 1];
    const sprintN = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isNaN(sprintN)) {
      process.stderr.write("sprint-stats: --sprint requires a sprint number\n");
      process.exitCode = 1;
      return;
    }
    const content = d.readSprintPlan(sprintN);
    if (!content) {
      process.stderr.write(`sprint-stats: sprint-${sprintN}.md not found\n`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseSprintPlan(content, nowMs);
    if (!parsed) {
      process.stderr.write(`sprint-stats: could not parse time window from sprint-${sprintN}.md\n`);
      process.exitCode = 1;
      return;
    }
    window = { start: parsed.start, end: parsed.end, label: `sprint-${sprintN}` };
  } else if (sinceIdx !== -1) {
    const ref = args[sinceIdx + 1];
    if (!ref) {
      process.stderr.write("sprint-stats: --since requires a tag or SHA\n");
      process.exitCode = 1;
      return;
    }
    const ts = d.resolveGitTimestamp(ref);
    if (ts === null) {
      process.stderr.write(`sprint-stats: could not resolve git ref '${ref}'\n`);
      process.exitCode = 1;
      return;
    }
    window = { start: ts, end: nowMs, label: `since:${ref}` };
  }

  // Get work items for phase grouping (best-effort)
  let workItems: WorkItem[] = [];
  try {
    workItems = await d.listWorkItems();
  } catch {
    // Daemon not running — skip phase grouping
  }

  // Build branch → phase map
  const branchPhase = new Map<string, string>();
  for (const item of workItems) {
    if (item.branch) branchPhase.set(item.branch, item.phase);
  }

  // Scan session files
  const projectsDir = join(d.homeDir(), ".claude", "projects");
  const files = scanSessionFiles(projectsDir);

  // Aggregate
  const modelTotals = new Map<string, TokenTotals>();
  const phaseTotals = new Map<string, TokenTotals>();
  const overall = zeroTotals();
  let sessionCount = 0;
  let totalDurationMs = 0;

  for (const filePath of files) {
    const entries = readSessionEntries(filePath);
    const session = aggregateSession(entries);
    if (!session) continue;

    // Time window filter
    if (window) {
      // Session overlaps with window if it starts before window end and ends after window start
      if (session.lastTs < window.start || session.firstTs > window.end) continue;
    }

    sessionCount++;
    totalDurationMs += session.lastTs - session.firstTs;

    // Determine phase
    const phase = session.branch ? (branchPhase.get(session.branch) ?? null) : null;

    for (const [model, totals] of session.models) {
      // Model totals
      let mt = modelTotals.get(model);
      if (!mt) {
        mt = zeroTotals();
        modelTotals.set(model, mt);
      }
      addTotals(mt, totals);

      // Phase totals
      if (phase) {
        let pt = phaseTotals.get(phase);
        if (!pt) {
          pt = zeroTotals();
          phaseTotals.set(phase, pt);
        }
        addTotals(pt, totals);
      }

      // Overall
      addTotals(overall, totals);
    }
  }

  overall.sessions = sessionCount;

  // Build output
  const modelsOut: Record<string, object> = {};
  for (const [model, totals] of [...modelTotals.entries()].sort(
    (a, b) => b[1].estimatedCostUsd - a[1].estimatedCostUsd,
  )) {
    modelsOut[model] = totalsToJson(totals);
  }

  const phasesOut: Record<string, object> = {};
  for (const [phase, totals] of [...phaseTotals.entries()].sort()) {
    phasesOut[phase] = totalsToJson(totals);
  }

  const out: Record<string, unknown> = {
    window: window
      ? {
          label: window.label,
          start: new Date(window.start).toISOString(),
          end: new Date(window.end).toISOString(),
        }
      : null,
    sessions: sessionCount,
    totalDurationMs,
    totals: totalsToJson(overall),
    models: modelsOut,
    ...(Object.keys(phasesOut).length > 0 ? { phases: phasesOut } : {}),
  };

  console.log(JSON.stringify(out, null, 2));
}
