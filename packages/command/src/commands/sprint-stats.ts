/**
 * mcx sprint-stats — aggregate token counts and costs from Claude session transcripts.
 *
 * Usage:
 *   mcx sprint-stats                          # sessions in current project (cwd-derived)
 *   mcx sprint-stats --sprint <N>             # sessions within sprint N's time window
 *   mcx sprint-stats --since <tag-or-sha>     # sessions since a git tag/sha commit time
 *   mcx sprint-stats --project <slug>         # override the auto-detected project slug
 *
 * Output: JSON to stdout.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@mcp-cli/core";
import { spawnCaptureSync } from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";
import { printError, printInfo } from "../output";

// ── Types ──────────────────────────────────────────────────────────────────

interface TokenTotals {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  ratesSource: "matched" | "fallback";
}

interface SessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  branch: string | null;
  models: Map<string, TokenTotals>;
}

export interface TimeWindow {
  start: number;
  end: number;
  label: string;
}

/** Raw JSONL entry — only fields we care about. */
interface RawEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: {
    id?: string;
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
    rates: { input: 5, output: 25, cacheCreate: 6.25, cacheRead: 0.5 },
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

function ratesForModel(model: string): { rates: CostRates; source: "matched" | "fallback" } {
  for (const { pattern, rates } of MODEL_COSTS) {
    if (pattern.test(model)) return { rates, source: "matched" };
  }
  return { rates: BLENDED_RATES, source: "fallback" };
}

function estimateCostForModel(
  totals: Pick<TokenTotals, "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens">,
  model: string,
): { cost: number; ratesSource: "matched" | "fallback" } {
  const { rates, source } = ratesForModel(model);
  const cost =
    (totals.inputTokens * rates.input +
      totals.outputTokens * rates.output +
      totals.cacheCreationTokens * rates.cacheCreate +
      totals.cacheReadTokens * rates.cacheRead) /
    1_000_000;
  return { cost, ratesSource: source };
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
function parseDateLabel(s: string, warnings?: string[]): number | null {
  const m = s.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+([A-Z]{2,4}))?/);
  if (!m) return null;
  const [, date, time, tz] = m;
  let offsetHours = 0;
  if (tz) {
    if (TZ_OFFSETS[tz] !== undefined) {
      offsetHours = TZ_OFFSETS[tz];
    } else {
      warnings?.push(`unrecognized timezone '${tz}', defaulting to UTC`);
    }
  }
  const iso = `${date}T${time}:00${offsetHours < 0 ? "-" : "+"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export interface SprintWindow {
  start: number;
  end: number;
  warnings: string[];
}

/** Parse sprint plan file to extract the sprint's time window. */
export function parseSprintPlan(content: string, nowMs: number): SprintWindow | null {
  const warnings: string[] = [];
  const startMatch = content.match(/Started\s+([\d-]+\s+[\d:]+(?:\s+[A-Z]{2,4})?)/);
  const endMatch = content.match(/Ended\s+([\d-]+\s+[\d:]+(?:\s+[A-Z]{2,4})?)/);

  const start = startMatch ? parseDateLabel(startMatch[1], warnings) : null;
  const end = endMatch ? parseDateLabel(endMatch[1], warnings) : nowMs;

  if (start === null) return null;
  return { start, end: end ?? nowMs, warnings };
}

// ── Project slug ──────────────────────────────────────────────────────────

export function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

// ── Dependency interface ───────────────────────────────────────────────────

export interface SprintStatsDeps {
  listWorkItems: () => Promise<WorkItem[]>;
  homeDir: () => string;
  repoRoot: () => string;
  now: () => number;
  readSprintPlan: (sprintN: number) => string | null;
  resolveGitTimestamp: (ref: string) => number | null;
  discoverWorktrees: () => string[];
}

function gitRoot(): string {
  try {
    const r = spawnCaptureSync("git", ["rev-parse", "--show-toplevel"]);
    if (r.ok) return r.stdout.trim();
  } catch {}
  return process.cwd();
}

const defaultDeps: SprintStatsDeps = {
  async listWorkItems() {
    const result = await ipcCall("listWorkItems", { includeArchived: true });
    return result.items;
  },
  homeDir: homedir,
  repoRoot: gitRoot,
  now: () => Date.now(),
  readSprintPlan(sprintN) {
    const root = gitRoot();
    const dirs = [root, join(root, ".claude")];
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
    return null;
  },
  resolveGitTimestamp(ref) {
    try {
      const result = spawnCaptureSync("git", ["log", "-1", "--format=%cI", ref], { cwd: process.cwd() });
      if (!result.ok) return null;
      const iso = result.stdout.trim();
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    } catch {
      return null;
    }
  },
  discoverWorktrees() {
    try {
      const result = spawnCaptureSync("git", ["worktree", "list", "--porcelain"]);
      if (!result.ok) return [];
      const paths: string[] = [];
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          paths.push(line.slice("worktree ".length));
        }
      }
      return paths;
    } catch {
      return [];
    }
  },
};

// ── Session file scanning ──────────────────────────────────────────────────

/** List all .jsonl session files in a specific project directory. */
export function scanSessionFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(projectDir, f));
  } catch {
    return [];
  }
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

/** Filter entries to those within the time window. Entries without timestamps are kept. */
export function filterEntriesToWindow(entries: RawEntry[], window: TimeWindow): RawEntry[] {
  return entries.filter((e) => {
    if (!e.timestamp) return true;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) return true;
    return ts >= window.start && ts <= window.end;
  });
}

/** Aggregate token usage from a session's entries. Returns null if no usage data. */
export function aggregateSession(entries: RawEntry[]): SessionSummary | null {
  // Dedup streaming snapshots: multiple JSONL rows for the same API response
  // share a message.id. Keep only the last (most complete usage) per id.
  const byMessageId = new Map<string, RawEntry>();
  const ungrouped: RawEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "assistant" && entry.message?.usage && entry.message.id) {
      byMessageId.set(entry.message.id, entry);
    } else {
      ungrouped.push(entry);
    }
  }
  const deduped = [...ungrouped, ...byMessageId.values()];

  let sessionId: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let branch: string | null = null;
  const models = new Map<string, TokenTotals>();

  for (const entry of deduped) {
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
          ratesSource: "matched",
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

  for (const [model, totals] of models) {
    const { cost, ratesSource } = estimateCostForModel(totals, model);
    totals.estimatedCostUsd = cost;
    totals.ratesSource = ratesSource;
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
    ratesSource: "matched",
  };
}

function addTotals(acc: TokenTotals, src: TokenTotals): void {
  acc.sessions += src.sessions;
  acc.inputTokens += src.inputTokens;
  acc.outputTokens += src.outputTokens;
  acc.cacheCreationTokens += src.cacheCreationTokens;
  acc.cacheReadTokens += src.cacheReadTokens;
  acc.estimatedCostUsd += src.estimatedCostUsd;
  if (src.ratesSource === "fallback") acc.ratesSource = "fallback";
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
    ratesSource: t.ratesSource,
  };
}

// ── Flag specs ────────────────────────────────────────────────────────────

const FLAG_SPECS = {
  sprint: { type: "number" as const },
  since: { type: "string" as const },
  project: { type: "string" as const },
};

// ── Main command ───────────────────────────────────────────────────────────

export async function cmdSprintStats(args: string[], deps?: Partial<SprintStatsDeps>): Promise<void> {
  const { flags, errors, help } = parseFlags(args, FLAG_SPECS);

  if (help) {
    console.log(`mcx sprint-stats — aggregate token counts and costs from Claude session transcripts.

Usage:
  mcx sprint-stats                          # sessions in current project + worktrees
  mcx sprint-stats --sprint <N>             # sessions within sprint N's time window
  mcx sprint-stats --since <tag-or-sha>     # sessions since a git tag/sha commit time
  mcx sprint-stats --project <slug>         # override the auto-detected project slug

Options:
  --sprint <N>     Filter to sessions within sprint N's time window
  --since <ref>    Filter to sessions since a git tag or commit SHA
  --project <slug> Override the auto-detected project slug (skips worktree discovery)
  --help, -h       Show this help

Output: JSON to stdout with token counts, cost estimates, and optional phase grouping.`);
    return;
  }

  if (errors.length > 0) {
    printError(`sprint-stats: ${errors[0]}`);
    process.exitCode = 1;
    return;
  }

  const d = { ...defaultDeps, ...deps };
  const nowMs = d.now();

  const sprintN = flags.sprint as number | undefined;
  const sinceRef = flags.since as string | undefined;
  const projectFilter = flags.project as string | undefined;

  // Mutual exclusivity
  if (sprintN !== undefined && sinceRef !== undefined) {
    printError("sprint-stats: --sprint and --since are mutually exclusive");
    process.exitCode = 1;
    return;
  }

  // Parse time window flags
  let window: TimeWindow | null = null;
  let sprintWarnings: string[] = [];

  if (sprintN !== undefined) {
    const content = d.readSprintPlan(sprintN);
    if (!content) {
      printError(`sprint-stats: sprint-${sprintN}.md not found`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseSprintPlan(content, nowMs);
    if (!parsed) {
      printError(`sprint-stats: could not parse time window from sprint-${sprintN}.md`);
      process.exitCode = 1;
      return;
    }
    sprintWarnings = parsed.warnings;
    window = { start: parsed.start, end: parsed.end, label: `sprint-${sprintN}` };
  } else if (sinceRef !== undefined) {
    const ts = d.resolveGitTimestamp(sinceRef);
    if (ts === null) {
      printError(`sprint-stats: could not resolve git ref '${sinceRef}'`);
      process.exitCode = 1;
      return;
    }
    window = { start: ts, end: nowMs, label: `since:${sinceRef}` };
  }

  // Emit TZ warnings from plan parsing
  for (const w of sprintWarnings) {
    printInfo(`sprint-stats: ${w}`);
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

  // Discover project directories to scan
  const projectsBase = join(d.homeDir(), ".claude", "projects");
  let files: string[];
  let slug: string;

  if (projectFilter) {
    slug = projectFilter;
    files = scanSessionFiles(join(projectsBase, slug));
  } else {
    slug = projectSlug(d.repoRoot());
    const slugs = new Set([slug]);
    for (const wt of d.discoverWorktrees()) {
      slugs.add(projectSlug(wt));
    }
    files = [];
    for (const s of slugs) {
      files.push(...scanSessionFiles(join(projectsBase, s)));
    }
  }

  // Aggregate
  const modelTotals = new Map<string, TokenTotals>();
  const phaseTotals = new Map<string, TokenTotals>();
  const overall = zeroTotals();
  let sessionCount = 0;
  let totalDurationMs = 0;

  for (const filePath of files) {
    let entries = readSessionEntries(filePath);

    // Entry-level window filtering: only aggregate entries within the window
    if (window) {
      entries = filterEntriesToWindow(entries, window);
    }

    const session = aggregateSession(entries);
    if (!session) continue;

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

      // Overall
      addTotals(overall, totals);
    }

    // Phase totals — counted once per session (not per model)
    if (phase) {
      let pt = phaseTotals.get(phase);
      if (!pt) {
        pt = zeroTotals();
        phaseTotals.set(phase, pt);
      }
      pt.sessions += 1;
      for (const [, totals] of session.models) {
        pt.inputTokens += totals.inputTokens;
        pt.outputTokens += totals.outputTokens;
        pt.cacheCreationTokens += totals.cacheCreationTokens;
        pt.cacheReadTokens += totals.cacheReadTokens;
        pt.estimatedCostUsd += totals.estimatedCostUsd;
        if (totals.ratesSource === "fallback") pt.ratesSource = "fallback";
      }
    }
  }

  overall.sessions = sessionCount;

  // Emit fallback rate warnings
  for (const [model, totals] of modelTotals) {
    if (totals.ratesSource === "fallback") {
      printInfo(`sprint-stats: unknown model '${model}', using fallback cost rates`);
    }
  }

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
    project: slug,
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
